/**
 * The quota gate every agent spawn passes through (Issue #1669, parent
 * #1653).
 *
 * A subscription usage limit used to end the host's work: the runner wrote
 * the durable `usage` rate-limit signal, `run_core` drained its slot pool,
 * and the host idled until the window reopened — even when another
 * subscription in the pool had quota to spend. This module is the seam that
 * ends that. It sits between `claude_runner.ts` and #1668's credential pool
 * and answers exactly two questions:
 *
 * - {@link ClaudeSpawnGate.beforeSpawn} — which credential should the next
 *   child run under, and is there one at all? A switch is applied to the run
 *   environment **before** the child environment is built, so the spawn that
 *   follows carries the chosen token.
 * - {@link ClaudeSpawnGate.recordUsageLimit} — the spawn just refused with a
 *   usage limit; mark that credential's windows spent so the next selection
 *   does not choose it again. No probe: the API has already said so.
 *
 * ## What it costs a host with one token
 *
 * Nothing that changes behaviour. Fewer than two pool candidates is answered
 * `"no-pool"` — no ranking, no probe, no log line — and the caller takes the
 * path it took before this module existed. The one cost is a single
 * credential-directory read per process, cached with the pool's discovery.
 *
 * ## Why a refusal, not a pause
 *
 * When every credential is **known** to be spent the gate says so and the
 * runner returns at once **without spawning**: an invocation against a closed
 * window is a request spent to be refused. The refusal is terminal for that
 * call and the dispatch loop moves to the next priority — no durable signal
 * is written, so the slot pools of every worker on the volume keep running,
 * which a `usage` signal would have stopped.
 *
 * Budgets that could not be *measured* are deliberately not a refusal: an
 * unreachable budget endpoint must not stop a host that may have quota, so
 * an unmeasured pool takes the ungated path.
 *
 * One thing the gate cannot promise: the run environment is shared by every
 * slot on the host, so between one slot's selection and its spawn another
 * slot may switch the variable. A switch therefore holds for spawns that
 * start after it, and a concurrent spawn can carry a sibling's choice —
 * which is a credential the pool ranked, never an unmeasured one.
 *
 * Tokens are identified by **label** (`provider`, `provider-2`) throughout;
 * no token value is an input to anything logged here.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type {
  ClaudeCredentialPool,
  ClaudeExhaustedWindow,
} from "./claude_credential_pool.ts";

/** What the gate decided about the spawn that is about to happen. */
export type ClaudeSpawnGateVerdict =
  /**
   * Nothing was consulted — fewer than two pool candidates, another
   * vendor's spawn, or a pool whose figures could not be measured. Spawn on
   * the credential the run already carries, exactly as before.
   */
  | { readonly outcome: "no-pool" }
  /**
   * A credential was chosen. `switched` is true only when it was a
   * *different* one from the credential the run was already carrying —
   * "chose the same token again" is not a recovery, and a caller that
   * treats it as one loops.
   */
  | {
    readonly outcome: "selected";
    readonly label: string;
    readonly switched: boolean;
  }
  /**
   * Every candidate is **known** to be spent. `resetEpochMs` is the soonest
   * five-hour reset among them, when any candidate reported one.
   */
  | { readonly outcome: "none-eligible"; readonly resetEpochMs: number | null };

/** The quota gate a spawn passes through. */
export interface ClaudeSpawnGate {
  /**
   * Choose and apply the credential for the next spawn.
   *
   * @param providerId - The provider this spawn will run; another vendor's
   *   spawn is answered `"no-pool"` and gated on nothing. Omitted, the
   *   pool's own provider is assumed.
   * @returns The verdict; `"none-eligible"` means the caller must not spawn.
   */
  beforeSpawn(providerId?: string): Promise<ClaudeSpawnGateVerdict>;

  /**
   * Mark the credential the last spawn ran under as spent on these windows.
   *
   * A no-op on a host with no pool and on another vendor's spawn, so a
   * single-token host records nothing and logs nothing.
   *
   * @param windows - The windows the refusal named, with their resets.
   * @param providerId - The provider that hit the limit; another vendor's
   *   refusal records nothing here.
   */
  recordUsageLimit(
    windows: readonly ClaudeExhaustedWindow[],
    providerId?: string,
  ): Promise<void>;
}

/** Injection points; production passes the run's `setEnv` and a log sink. */
export interface ClaudeSpawnGateOptions {
  /**
   * Establishes a variable in the run environment. Defaults to
   * `Deno.env.set`, which is what the child environment is copied from.
   */
  setEnv?: (name: string, value: string) => void;
  /** Where the gate's own lines go; defaults to discarding them. */
  log?: (message: string) => void;
}

/** Prefix shared by every line this module logs itself. */
const LOG_PREFIX = "[SECURITY] claude spawn gate";

/**
 * Build the gate over a credential pool.
 *
 * @param pool - The process-wide pool (Issue #1668).
 * @param options - Environment writer and log sink.
 * @returns The gate.
 */
export function createClaudeSpawnGate(
  pool: ClaudeCredentialPool,
  options: ClaudeSpawnGateOptions = {},
): ClaudeSpawnGate {
  const setEnv = options.setEnv ?? ((name: string, value: string) => {
    Deno.env.set(name, value);
  });
  const log = options.log ?? (() => {});

  return {
    async beforeSpawn(providerId) {
      if (!ours(providerId)) return { outcome: "no-pool" };
      const token = await pool.selectEligible();
      if (token !== null) {
        // Already on it: nothing to switch, and no line saying we did.
        if (token.label === await pool.activeLabel()) {
          return { outcome: "selected", label: token.label, switched: false };
        }
        pool.applySelection(token, setEnv);
        return { outcome: "selected", label: token.label, switched: true };
      }
      // No winner. Which of the three reasons decides whether a spawn is
      // refused, and only one of them does: a pool KNOWN to be spent.
      // Figures we could not measure are not evidence of exhaustion, and
      // refusing on them would stop a host from working because a budget
      // endpoint was unreachable.
      const status = await pool.poolStatus();
      if (status.candidates < 2 || status.spent < status.candidates) {
        return { outcome: "no-pool" };
      }
      // The pool's own candidate log line is the record of why.
      return {
        outcome: "none-eligible",
        resetEpochMs: status.soonestFiveHourReset,
      };
    },

    async recordUsageLimit(windows, providerId) {
      if (!ours(providerId)) return;
      if ((await pool.poolStatus()).candidates < 2) return;
      const label = await pool.activeLabel();
      if (label === null) {
        // Which credential hit the limit is not knowable — the run
        // environment carries no value this pool's candidates hold — and
        // guessing would strand a token that still has quota. Say so rather
        // than record an exhaustion against the wrong label.
        log(
          `${LOG_PREFIX}: a usage limit was reported by a credential this ` +
            `pool does not recognise — nothing recorded as spent`,
        );
        return;
      }
      pool.recordExhaustion(label, windows);
    },
  };

  /** Whether a spawn naming this provider is one this pool speaks for. */
  function ours(providerId?: string): boolean {
    return providerId === undefined || providerId === pool.providerId();
  }
}

/**
 * The gate every `claude_runner.ts` spawn consults when its caller named
 * none.
 *
 * A module-level default rather than a threaded parameter because the runner
 * is called from a dozen phases that share one process and one environment,
 * and the pool it gates is process-wide for the same reason. Left unset —
 * every test, and any embedding that never built a pool — the runner behaves
 * exactly as it did before this module existed.
 */
let installed: ClaudeSpawnGate | null = null;

/**
 * Install the process-wide gate. Called once, from
 * `createDefaultRunWorkerDeps`.
 *
 * @param gate - The gate, or null to remove it (tests).
 */
export function setDefaultClaudeSpawnGate(gate: ClaudeSpawnGate | null): void {
  installed = gate;
}

/** The process-wide gate, or null when none was installed. */
export function defaultClaudeSpawnGate(): ClaudeSpawnGate | null {
  return installed;
}
