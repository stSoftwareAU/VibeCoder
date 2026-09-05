/**
 * How long a slot has been starved by an audit/census disagreement
 * (Issue #1051).
 *
 * Issue #3526 gave the idle-task filer a safety net: a *durable*
 * census/scan disagreement must not suppress the filer for ever, so once
 * the disagreement has run long enough exactly ONE filer attempt is forced
 * through and the count restarts. The net was sound and could never fire,
 * for two reasons that this module exists to remove.
 *
 * **It was per-run and in memory.** `run_core.ts` built the streak fresh in
 * `runCoreLoop`, and the worker restarts roughly hourly, so the count began
 * at zero every hour. Every other recurring-failure surface in this repo
 * persists its streak for exactly that reason —
 * `bump_script_failure_streak.ts`, `idle_inversion_streak.ts`,
 * `pr_branch_update_failure_streak.ts` — and the shape here follows theirs:
 * a small JSON file in the work directory, written atomically, read back
 * tolerantly.
 *
 * **It was pool-wide.** One counter was shared by every slot and cleared
 * whenever *the fleet* claimed anything, so in a two-slot pool `s2`'s claim
 * wiped out the starvation `s1` was accumulating. That is the same fault
 * `slot_idle_accounting.ts` (Issue #925) removed from the accounting half:
 * *"half the fleet was invisible."* Here the count is keyed by the
 * **observer** — the slot that looked for work and was refused, or
 * {@link IDLE_CYCLE_OBSERVER_ID} for the end-of-cycle gate — so a slot idle
 * through a long disagreement trips the bound regardless of what a sibling
 * did.
 *
 * # The bound is elapsed time, not cycles
 *
 * The old bound counted observations, and observations arrive on the
 * liveness-guard cadence — about nine minutes apart on the live fleet — so
 * "three observations" silently meant "about thirty-six minutes" and would
 * have meant something else the moment that cadence changed. The bound here
 * is {@link IDLE_DISAGREEMENT_BOUND_MS} of *uninterrupted* disagreement,
 * measured from the first observation of the current run, so it means the
 * same thing whatever the cadence is.
 *
 * # Two hosts converge, they do not double-count
 *
 * The key is the observer id alone, never the host. Two hosts sharing a work
 * volume therefore share one entry per slot and force one attempt per bound
 * *between them*, rather than each keeping a private counter and each filing
 * its own wrapper — which is the #2106 flooding the bound exists to avoid.
 * As with the other streak surfaces, {@link withStateLock} serialises the
 * read-modify-write in process; cross-process the last atomic write wins,
 * which for a monotonic "when did this run start" field costs at most one
 * restarted window.
 *
 * Best-effort throughout: a missing, corrupt or unwritable state file
 * degrades to an in-memory count and is reported, never thrown — a launcher
 * that dies parsing its own state file is worse than the bug it was tracking.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";

/**
 * Uninterrupted disagreement a slot tolerates before one filer attempt is
 * forced through.
 *
 * Twenty minutes. It has to be long enough that a transient disagreement —
 * one the next scan resolves by itself — never forces a wrapper, and the
 * longest such transient is the liveness-guard cadence of about nine
 * minutes, so the bound spans at least two independent observations. It has
 * to be short enough that a genuinely starved fleet self-corrects inside a
 * single hourly run rather than depending on the streak surviving a restart,
 * and short enough to matter against the ten days the fleet sat idle. It
 * caps forced attempts at three per hour per slot, well under the flooding
 * the #2106 budget guard was written for, and the idle-task filer's own
 * "one open `idle-task` per repo" rule bounds them again.
 */
export const IDLE_DISAGREEMENT_BOUND_MS = 20 * 60 * 1000;

/**
 * Gap after which a persisted run is treated as finished rather than
 * continuing.
 *
 * The streak means "this observer has been disagreeing without a break".
 * A host that was switched off for a day has not been disagreeing for a
 * day — it has not been looking. An hour spans a worker restart (roughly
 * hourly) and any pause inside a run with room to spare, and stops a stale
 * file from forcing a wrapper on the first observation after a long absence.
 */
export const IDLE_DISAGREEMENT_CONTINUITY_MS = 60 * 60 * 1000;

/** State file name, placed in the worker's work directory. */
export const IDLE_DISAGREEMENT_STATE_FILE = "idle_disagreement_streak.json";

/**
 * Observer id for the end-of-cycle gate, which asks the fleet-wide question
 * after every slot has drained. Slots use their own `s1`/`s2` ids.
 */
export const IDLE_CYCLE_OBSERVER_ID = "cycle";

/** One observer's uninterrupted disagreement run. */
export interface IdleDisagreementEntry {
  /** Epoch milliseconds the current uninterrupted run began. */
  sinceMs: number;
  /** Epoch milliseconds of the most recent observation. */
  lastSeenMs: number;
  /** Observations recorded in the current run — reported, never the bound. */
  observations: number;
}

/** Streak state keyed by observer id (`s1`, `s2`, `cycle`). */
export type IdleDisagreementState = Record<string, IdleDisagreementEntry>;

/** Resolve the streak file path for a work directory. */
export function idleDisagreementStatePath(workDir: string): string {
  return `${workDir}/${IDLE_DISAGREEMENT_STATE_FILE}`;
}

/** A finite, non-negative number, or `undefined` when it is neither. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Load the state; a missing, corrupt or older-shaped file reads as empty.
 *
 * Every field is validated independently, so a file written by an earlier
 * version — one carrying `{count, lastCycleId}` rather than timestamps —
 * is simply not recognised as an entry and its observer starts a fresh run.
 * Nothing here throws.
 */
export async function loadIdleDisagreementState(
  path: string,
): Promise<IdleDisagreementState> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const state: IdleDisagreementState = {};
    for (const [observerId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const raw = value as Record<string, unknown>;
      const sinceMs = finiteNumber(raw.sinceMs);
      if (sinceMs === undefined) continue;
      state[observerId] = {
        sinceMs,
        lastSeenMs: finiteNumber(raw.lastSeenMs) ?? sinceMs,
        observations: finiteNumber(raw.observations) ?? 0,
      };
    }
    return state;
  } catch {
    // Missing or corrupt — the streak simply restarts.
    return {};
  }
}

/** Persist the state atomically; a failed write is reported, never silent. */
export async function saveIdleDisagreementState(
  path: string,
  state: IdleDisagreementState,
  log: (message: string) => void = (m) => console.error(m),
): Promise<boolean> {
  const result = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(state, null, 2) + "\n",
  });
  if (!result.ok) {
    log(
      `[idle-disagreement] could not persist ${path}: ${result.error.message} ` +
        `— the streak will restart on the next run`,
    );
    return false;
  }
  return true;
}

/** What one recorded observation means for the filer. */
export interface IdleDisagreementDecision {
  /**
   * `within-bound` — keep suppressing the filer.
   * `bound-exceeded` — force exactly one filer attempt; the run has been
   * restarted from this observation, so the next forced attempt needs
   * another full bound.
   */
  action: "within-bound" | "bound-exceeded";
  /** Milliseconds of uninterrupted disagreement, up to this observation. */
  elapsedMs: number;
  /** Observations in the run this observation belongs to, including it. */
  observations: number;
  /** The bound in force, so the caller's log line can state it. */
  boundMs: number;
  /** Whether the run behind this decision survives a worker restart. */
  persisted: boolean;
}

/** Options for {@link createIdleDisagreementTracker}. */
export interface IdleDisagreementTrackerOptions {
  /**
   * The work directory. Absent means no state file: the streak is kept in
   * memory for the life of the tracker, which is the pre-#1051 behaviour and
   * the honest degradation for a caller that has no volume to write to.
   */
  workDir?: string;
  /** Bound override (tests). */
  boundMs?: number;
  /** Continuity-window override (tests). */
  continuityMs?: number;
  /** Sink for diagnostics. */
  log?: (message: string) => void;
}

/**
 * Counts uninterrupted audit/census disagreement per observer and says when
 * one filer attempt is owed.
 *
 * The clock is a parameter of {@link IdleDisagreementTracker.record}, so a
 * test drives elapsed time without a timer, exactly as `SlotIdleLedger`
 * does.
 */
export class IdleDisagreementTracker {
  private readonly statePath: string | undefined;
  private readonly boundMs: number;
  private readonly continuityMs: number;
  private readonly log: (message: string) => void;
  /** Used when there is no state file, and as the fallback when one fails. */
  private memory: IdleDisagreementState = {};

  constructor(options: IdleDisagreementTrackerOptions = {}) {
    const workDir = options.workDir?.trim();
    this.statePath = workDir ? idleDisagreementStatePath(workDir) : undefined;
    this.boundMs = options.boundMs ?? IDLE_DISAGREEMENT_BOUND_MS;
    this.continuityMs = options.continuityMs ??
      IDLE_DISAGREEMENT_CONTINUITY_MS;
    this.log = options.log ?? ((m: string) => console.error(m));
  }

  /** Where the streak is persisted, or `undefined` when it is not. */
  get path(): string | undefined {
    return this.statePath;
  }

  /**
   * Record one observation of "this observer looked for work, was refused,
   * and the audit or the census disagrees".
   *
   * Never throws: a filesystem failure degrades to the in-memory count and
   * is logged, so the idle path is never derailed by its own bookkeeping.
   */
  async record(
    observerId: string,
    nowMs: number,
  ): Promise<IdleDisagreementDecision> {
    return await this.mutate(observerId, (state) => {
      const previous = state[observerId];
      const continuing = previous !== undefined &&
        // A run cannot have started in the future (a clock that went
        // backwards, or a file from another host), and a long gap means the
        // observer stopped looking rather than kept disagreeing.
        previous.sinceMs <= nowMs &&
        nowMs - previous.lastSeenMs <= this.continuityMs;
      const entry: IdleDisagreementEntry = continuing
        ? {
          sinceMs: previous.sinceMs,
          lastSeenMs: nowMs,
          observations: previous.observations + 1,
        }
        : { sinceMs: nowMs, lastSeenMs: nowMs, observations: 1 };

      const elapsedMs = nowMs - entry.sinceMs;
      if (elapsedMs > this.boundMs) {
        // The #2106 flooding guard: one forced attempt per bound. The run
        // restarts here, so the next one needs another full bound.
        state[observerId] = {
          sinceMs: nowMs,
          lastSeenMs: nowMs,
          observations: 0,
        };
        return {
          action: "bound-exceeded",
          elapsedMs,
          observations: entry.observations,
          boundMs: this.boundMs,
          persisted: this.statePath !== undefined,
        };
      }
      state[observerId] = entry;
      return {
        action: "within-bound",
        elapsedMs,
        observations: entry.observations,
        boundMs: this.boundMs,
        persisted: this.statePath !== undefined,
      };
    });
  }

  /**
   * This observer found work, so it is not starved: forget its run.
   *
   * Only the observer named here is cleared. A sibling slot's claim says
   * nothing about a slot that is still being refused — the whole of
   * Issue #1051's second half.
   */
  async clear(observerId: string): Promise<void> {
    await this.mutate(observerId, (state) => {
      delete state[observerId];
      return undefined;
    });
  }

  /** The run currently recorded for an observer, for tests and diagnostics. */
  async peek(observerId: string): Promise<IdleDisagreementEntry | undefined> {
    if (this.statePath === undefined) return this.memory[observerId];
    const state = await loadIdleDisagreementState(this.statePath);
    return state[observerId];
  }

  /** Load → apply → save under the state lock. Never throws. */
  private async mutate<T>(
    observerId: string,
    apply: (state: IdleDisagreementState) => T,
  ): Promise<T> {
    const path = this.statePath;
    if (path === undefined) return apply(this.memory);
    try {
      return await withStateLock(`idle-disagreement:${path}`, async () => {
        const state = await loadIdleDisagreementState(path);
        const result = apply(state);
        await saveIdleDisagreementState(path, state, this.log);
        // Mirror the persisted view so a later write failure still has the
        // most recent run to fall back on.
        this.memory = state;
        return result;
      });
    } catch (err) {
      this.log(
        `[idle-disagreement] ${observerId}: streak update failed: ${
          err instanceof Error ? err.message : String(err)
        } — counting in memory for this run`,
      );
      return apply(this.memory);
    }
  }
}

/** Build the run's tracker. See {@link IdleDisagreementTrackerOptions}. */
export function createIdleDisagreementTracker(
  options: IdleDisagreementTrackerOptions = {},
): IdleDisagreementTracker {
  return new IdleDisagreementTracker(options);
}

/**
 * The `streak=… elapsed=…s bound=…s` fragment every `[idle-hooks]` line
 * carries, so an operator can read from the log how close a named slot is to
 * its forced attempt. `streak=` keeps its old name because scrapers grep for
 * it; what it counts is now reported beside the bound that actually decides.
 */
export function formatIdleDisagreementFragment(
  observerId: string,
  decision: IdleDisagreementDecision,
): string {
  return `observer=${observerId} streak=${decision.observations} ` +
    `elapsed=${Math.round(decision.elapsedMs / 1000)}s ` +
    `bound=${Math.round(decision.boundMs / 1000)}s ` +
    `persisted=${decision.persisted}`;
}
