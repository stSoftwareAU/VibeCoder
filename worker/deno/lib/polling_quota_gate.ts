/**
 * Quota-aware polling gate (Issue #3628).
 *
 * The fleet burns its shared 5000-point hourly GitHub GraphQL quota within
 * ~25 minutes of each reset, then idles in the pre-flight pause for the rest
 * of the hour. The dominant consumer is per-repository polling — the issue
 * scan's issue-list searches and the idle-task filer's repo walk — much of it
 * for work the fleet would only pick up last anyway. This gate reserves the
 * tail of the window for priority work by deferring the cheapest-to-defer
 * polling once the quota is low:
 *
 * - **Park tier**: while `remaining < parkFloor`, repos with
 *   `nice >= parkNice` are skipped whole for that cycle (no PR fetches, no
 *   timeline batch, no candidate collectors). Their work resumes next cycle.
 * - **Idle tier**: while `remaining < idleFloor`, idle-task collection is
 *   deferred fleet-wide — the scan's idle-task collector and the idle-task
 *   filer's repo walk both stand down, because nothing raised below that
 *   floor could be claimed before the window resets.
 *
 * The reading comes from `probeGraphqlQuota()` — a free `{ rateLimit { … } }`
 * query — taken once per scan. Fail-open throughout: a null reading (the
 * probe failed, or no caller probed) defers nothing, so an unreadable quota
 * can never newly block work. A floor of zero disables its tier.
 *
 * Pure module: no I/O, no clock, deterministic. One log line per condition
 * per cycle is the caller's job, never per repository (Issue #3628).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** The quota facts the gate judges from (the free probe's limit/remaining). */
export interface PollingQuotaReading {
  limit: number;
  remaining: number;
}

/** The configured floors (from `quota_poll_*` config keys). */
export interface PollingQuotaThresholds {
  /** Below this many points remaining, park-tier repos are skipped whole. */
  parkFloor: number;
  /** Repos with `nice` at or above this value are the park tier. */
  parkNice: number;
  /** Below this many points remaining, the idle-task tier is deferred. */
  idleFloor: number;
}

/** Two orthogonal axes: parking is per-repo, idle deferral is fleet-wide. */
export interface PollingGateVerdict {
  /** Skip this repository whole for the cycle. */
  parkRepo: boolean;
  /** Defer idle-task collection fleet-wide for the cycle. */
  deferIdle: boolean;
}

/**
 * The gate's verdict for one repository.
 *
 * Boundaries are strict less-than: `remaining` exactly at a floor is not
 * gated. `idleFloor <= parkFloor` is a configuration invariant, so below the
 * idle floor every repo is below the park floor too — a park-tier repo
 * therefore gets both axes.
 */
export function pollingGateVerdict(
  nice: number,
  reading: PollingQuotaReading | null,
  thresholds: PollingQuotaThresholds,
): PollingGateVerdict {
  if (reading === null) {
    return { parkRepo: false, deferIdle: false };
  }
  const { parkFloor, parkNice, idleFloor } = thresholds;
  const parkRepo = reading.remaining < parkFloor && nice >= parkNice;
  const deferIdle = reading.remaining < idleFloor;
  return { parkRepo, deferIdle };
}

/** The one-line park-tier summary, emitted once per cycle by the caller. */
export function formatPollingGateParkLine(
  reading: PollingQuotaReading,
  parkedCount: number,
  thresholds: PollingQuotaThresholds,
): string {
  return (
    `polling-quota-gate: GraphQL quota remaining=${reading.remaining}/` +
    `${reading.limit} below park_floor=${thresholds.parkFloor} — parked ` +
    `${parkedCount} repo(s) with nice >= ${thresholds.parkNice} this cycle; ` +
    `they resume next cycle`
  );
}

/** The one-line idle-tier summary, emitted once per cycle by the caller. */
export function formatPollingGateIdleLine(
  reading: PollingQuotaReading,
  thresholds: PollingQuotaThresholds,
): string {
  return (
    `polling-quota-gate: GraphQL quota remaining=${reading.remaining}/` +
    `${reading.limit} below idle_floor=${thresholds.idleFloor} — idle-task ` +
    `collection deferred this cycle (scan and filer); it resumes next cycle`
  );
}
