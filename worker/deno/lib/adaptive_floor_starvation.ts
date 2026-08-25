/**
 * Bounding the adaptive claim floor's deferral (Issue #375).
 *
 * The adaptive floor (`claim_runway_evidence.ts`, Issue #245) refuses an issue
 * that is known to be a long job — preserved WIP, a prior `execute` timeout, a
 * long-job size label — unless the cycle has {@link LONG_JOB_BUDGET_SHARE} of
 * the host's best execute budget still to run. Its module doc states the
 * invariant that makes it safe: *the requirement must stay satisfiable*.
 *
 * On a host whose cycle length equals its `claude_timeout` (the Issue #47
 * exception host: 3600 s cycle, 3600 s budget) that invariant does not hold.
 * The requirement is 0.75 × 3600 = 2700 s of **remaining** runway, but a claim
 * gate is only reached after the cycle has paid for startup, the maintenance
 * passes and the scan — around twenty minutes on the observed host. The best
 * runway ever offered to a claim gate there was 2430 s, so the floor could
 * never be met:
 *
 * ```
 * 06:03  VibeCoder#355 … 2360s of runway left, below the 2700s adaptive floor
 * 07:05  VibeCoder#355 … below the 2700s adaptive floor
 * 08:05  VibeCoder#355 … below the 2700s adaptive floor
 * 09:09  VibeCoder#355 … 1631s of runway left, below the 2700s adaptive floor
 * 10:06  VibeCoder#355 … 2360s of runway left, below the 2700s adaptive floor
 * ```
 *
 * Every cycle, for ever, worded as "leaving it for the next cycle" — a
 * permanent strand that reads as a passing deferral, the same failure shape as
 * Issue #319. Meanwhile the idle-decision census kept counting the issue as
 * claimable, so `[idle-census] ALERT inversion` fired cycle after cycle and
 * Issue #321 escalated it. The census was right; the scan was wrong.
 *
 * This module gives the deferral a memory so it is **bounded**. It counts the
 * consecutive cycles the adaptive floor deferred one issue, and at
 * {@link ADAPTIVE_FLOOR_STARVATION_LIMIT} the caller stops deferring and claims
 * the issue on whatever runway is left. That is the regime Issue #47 already
 * documents for this class of host: the execute is deadline-bound and WIP
 * preservation carries the progress into the next cycle. A bounded
 * deadline-bound run beats work nobody ever does.
 *
 * **Cycles, not scans.** A slot re-scans every 30 s, so a per-scan count would
 * exhaust the limit inside one cycle and defeat the floor entirely. Each entry
 * records the cycle that last incremented it and ignores repeats, exactly as
 * `idle_inversion_streak.ts` does.
 *
 * Best-effort throughout: never throws, so a claim decision is never derailed
 * by its own bookkeeping. Every failure is logged rather than swallowed, and a
 * state file that cannot be read simply restarts the count — which defers, the
 * conservative direction.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";

/**
 * Consecutive cycles the adaptive floor may defer one issue before it yields.
 *
 * Three matches the escalation threshold the inversion detector uses
 * (`IDLE_INVERSION_THRESHOLD`): two deferrals are an ordinary run of unlucky
 * cycles, a third is the floor refusing work it will never accept.
 */
export const ADAPTIVE_FLOOR_STARVATION_LIMIT = 3;

/** State file name, placed in the worker's work directory. */
export const ADAPTIVE_FLOOR_STATE_FILE = "adaptive_floor_deferrals.json";

/**
 * How long an untouched entry is kept. An issue the floor stops deferring —
 * claimed, closed, or its evidence gone — leaves its entry behind, so entries
 * expire rather than accumulating for the life of the host.
 */
export const ADAPTIVE_FLOOR_ENTRY_TTL_SECONDS = 7 * 24 * 60 * 60;

/** One issue's deferral streak. */
export interface AdaptiveFloorEntry {
  /** Consecutive cycles the adaptive floor deferred this issue. */
  count: number;
  /** Cycle that last incremented `count` — repeats within it are ignored. */
  lastCycleId: string;
  /** Epoch seconds of that increment, for expiry. */
  updatedAt: number;
}

/** Deferral streaks keyed by `owner/repo#number`. */
export type AdaptiveFloorDeferrals = Record<string, AdaptiveFloorEntry>;

/** Resolve the state file path for a work directory. */
export function adaptiveFloorStatePath(workDir: string): string {
  return `${workDir}/${ADAPTIVE_FLOOR_STATE_FILE}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Load the streaks, dropping malformed and expired entries. A missing or
 * unreadable file reads as empty, which restarts the count and therefore
 * defers — the safe direction.
 */
export async function loadAdaptiveFloorDeferrals(
  path: string,
  now: number = nowSeconds(),
): Promise<AdaptiveFloorDeferrals> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const deferrals: AdaptiveFloorDeferrals = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as Partial<AdaptiveFloorEntry> | null;
      if (
        !entry || typeof entry !== "object" ||
        typeof entry.count !== "number" || !Number.isFinite(entry.count)
      ) {
        continue;
      }
      const updatedAt = typeof entry.updatedAt === "number" &&
          Number.isFinite(entry.updatedAt)
        ? Math.floor(entry.updatedAt)
        : 0;
      if (now - updatedAt >= ADAPTIVE_FLOOR_ENTRY_TTL_SECONDS) continue;
      deferrals[key] = {
        count: Math.max(0, Math.floor(entry.count)),
        lastCycleId: typeof entry.lastCycleId === "string"
          ? entry.lastCycleId
          : "",
        updatedAt,
      };
    }
    return deferrals;
  } catch {
    // Missing or corrupt — the streak simply restarts.
    return {};
  }
}

/** Persist the streaks atomically; a failed write is reported, never silent. */
export async function saveAdaptiveFloorDeferrals(
  path: string,
  deferrals: AdaptiveFloorDeferrals,
  log: (message: string) => void = (m) => console.error(m),
): Promise<boolean> {
  const result = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(deferrals, null, 2) + "\n",
  });
  if (!result.ok) {
    log(
      `[adaptive-floor] could not persist ${path}: ${result.error.message} — ` +
        `the deferral streak will restart on the next cycle`,
    );
    return false;
  }
  return true;
}

/** Options for {@link recordAdaptiveFloorDeferral}. */
export interface RecordAdaptiveFloorDeferralOptions {
  statePath: string;
  /** `owner/repo#number` — use `issueClaimKey` from `claim_runway_evidence`. */
  key: string;
  /** Identifies this cycle — repeats within it do not increment. */
  cycleId: string;
  /** Sink for diagnostics. */
  log?: (message: string) => void;
}

/**
 * Record that the adaptive floor deferred `key` this cycle, and return the
 * number of consecutive cycles it has now been deferred.
 *
 * Never throws: on a filesystem failure the count is reported as it stands (or
 * 1 when nothing could be read), which keeps deferring rather than claiming on
 * unknown state.
 */
export async function recordAdaptiveFloorDeferral(
  opts: RecordAdaptiveFloorDeferralOptions,
): Promise<number> {
  const log = opts.log ?? ((message: string) => console.error(message));
  try {
    return await withStateLock(
      `adaptive-floor:${opts.statePath}`,
      async () => {
        const deferrals = await loadAdaptiveFloorDeferrals(opts.statePath);
        const entry = deferrals[opts.key] ??
          { count: 0, lastCycleId: "", updatedAt: 0 };
        // Cycles, not scans: a slot re-scans every 30 s within one cycle.
        if (entry.lastCycleId === opts.cycleId) return entry.count;
        entry.count++;
        entry.lastCycleId = opts.cycleId;
        entry.updatedAt = nowSeconds();
        deferrals[opts.key] = entry;
        await saveAdaptiveFloorDeferrals(opts.statePath, deferrals, log);
        return entry.count;
      },
    );
  } catch (err) {
    log(
      `[adaptive-floor] ${opts.key}: could not record the deferral: ${
        err instanceof Error ? err.message : String(err)
      } — treating it as the first deferred cycle`,
    );
    return 1;
  }
}

/**
 * Clear an issue's streak — the floor no longer defers it, so the next
 * starvation run starts from zero. A no-op when nothing is tracked. Never
 * throws.
 */
export async function clearAdaptiveFloorDeferral(
  statePath: string,
  key: string,
  log: (message: string) => void = (m) => console.error(m),
): Promise<void> {
  try {
    await withStateLock(`adaptive-floor:${statePath}`, async () => {
      const deferrals = await loadAdaptiveFloorDeferrals(statePath);
      if (!(key in deferrals)) return;
      delete deferrals[key];
      await saveAdaptiveFloorDeferrals(statePath, deferrals, log);
    });
  } catch (err) {
    log(
      `[adaptive-floor] ${key}: could not clear the deferral streak: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * The line logged when the floor yields to a starved issue. Greppable in the
 * same `ALERT` shape the idle-census and idle-detect alerts already use, and —
 * unlike those — it names an action the worker has just taken.
 */
export function formatAdaptiveFloorStarvation(options: {
  key: string;
  consecutiveCycles: number;
  limit: number;
  remainingRunwaySeconds: number;
  requiredRunwaySeconds: number;
}): string {
  return `[adaptive-floor] ALERT starvation issue=${options.key} ` +
    `deferred_cycles=${options.consecutiveCycles} limit=${options.limit} ` +
    `runway=${options.remainingRunwaySeconds}s ` +
    `required=${options.requiredRunwaySeconds}s — the floor can never be met ` +
    `on this host, so the claim proceeds deadline-bound and WIP preservation ` +
    `carries the progress (Issue #375).`;
}
