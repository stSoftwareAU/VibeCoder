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
 * When every credential is spent the gate says so and the runner returns at
 * once **without spawning**: an invocation against a closed window is a
 * request spent to be refused. The refusal is terminal for that call and the
 * dispatch loop moves to the next priority — the host keeps working on
 * everything that does not need the agent, which a `usage` signal would have
 * stopped.
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
  /** Fewer than two pool candidates: nothing was consulted, spawn as before. */
  | { readonly outcome: "no-pool" }
  /** A credential was chosen and applied to the run environment. */
  | { readonly outcome: "selected"; readonly label: string }
  /**
   * Every candidate is spent. `resetEpochMs` is the soonest five-hour reset
   * among them, when any candidate reported one.
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
      if (await pool.poolSize() < 2) return { outcome: "no-pool" };
      const token = await pool.selectEligible();
      if (token === null) {
        // The pool's own candidate log line is the record of why; this line
        // says what the refusal means for the spawn.
        return {
          outcome: "none-eligible",
          resetEpochMs: pool.soonestFiveHourReset(),
        };
      }
      // Already on it: nothing to switch, and no line saying we did.
      if (token.label === await pool.activeLabel()) {
        return { outcome: "selected", label: token.label };
      }
      pool.applySelection(token, setEnv);
      return { outcome: "selected", label: token.label };
    },

    async recordUsageLimit(windows, providerId) {
      if (!ours(providerId)) return;
      if (await pool.poolSize() < 2) return;
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
