/**
 * Fleet-level operational telemetry (Issue #855).
 *
 * Per-run telemetry already answered "what did this run do". Four fleet
 * questions had no recorded answer at all, and each needed ad-hoc
 * `grep`/`awk` over rotated logs to approximate:
 *
 *   1. How long was the fleet idle — and why?
 *   2. How long was it blocked waiting for model tokens / usage limits?
 *   3. How long was it blocked on GitHub rate limits?
 *   4. What is the success vs failure rate?
 *
 * This module accumulates those numbers across cycles and formats one
 * machine-readable summary line, so a trend can be plotted instead of
 * eyeballed:
 *
 *   fleet-summary: wall=92520s idle=39600s idle_pct=42.8 busy=52920s …
 *
 * Same lifecycle as `cycle_timings.ts` and `gh_call_metrics.ts`:
 * process-wide module state, driven by the main loop. Unlike those two it
 * is **not** reset per cycle — the whole point is accumulation. Durable
 * cross-run totals live in `fleet_telemetry_sidecar.ts`.
 *
 * Accounting model. The run's wall time is partitioned into three
 * non-overlapping spans, so `wall ≈ occupied + blocked + idle`:
 *
 *   - **occupied** — wall time during which **at least one** work stream
 *     held a claim. Deliberately not the sum of per-stream busy time: with
 *     an N-slot pool, summing concurrent streams overshoots the wall clock
 *     and would drive idle to zero on a half-idle pool.
 *   - **blocked** — wall time the loop spent paused between runs on a
 *     GitHub rate limit (`rate_limited`) or a model usage limit
 *     (`usage_blocked`).
 *   - **idle** — everything else (scanning, maintenance passes, the
 *     end-of-cycle sleep), attributed to the reason the cycle claimed
 *     nothing.
 *
 * Blocked spans are also idle reasons, so `idle_by_reason` sums to
 * `idle_seconds` exactly and nothing is double counted.
 *
 * `busy_by_stream` and `utilisation` are reported **per stream** and so do
 * overlap each other under concurrency — that is the point of a per-stream
 * number. Only `occupied` is used for the idle arithmetic.
 *
 * One deliberate overlap: a block that happens *inside* a run (the agent's
 * own rate-limit retry ladder sleeps in-process) is counted in
 * `usage_blocked_seconds` / `rate_limited_seconds`, because the issue asks
 * how long the fleet was blocked on tokens, but is **not** added to
 * `idle_by_reason` — the fleet was holding a claim, not idle. So the
 * blocked totals can exceed the blocked share of `idle_seconds`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { RepoCensusSkipReason } from "./idle_decision_census.ts";

/**
 * Why the fleet was idle. The census's own skip reasons are reused
 * verbatim (minus `scanned`, which describes a repo rather than a
 * verdict), plus the reasons the census expresses as per-repo counts
 * rather than as a skip reason, and the fleet-level reasons it cannot
 * express at all.
 */
export type FleetIdleReason =
  | Exclude<RepoCensusSkipReason, "scanned">
  /** The scan completed and unblocked priority work was still open. */
  | "nothing_claimable_backlog"
  /** The scan completed and there was simply nothing open to claim. */
  | "nothing_claimable_empty"
  /** Every candidate was held back by an open PR naming it. */
  | "pr_blocked"
  /** Every candidate was a `low-priority` issue a `work-on` suppressed. */
  | "low_priority_suppressed"
  /** Non-busy remainder of a cycle that did claim and serve work. */
  | "served"
  /** Paused on a GitHub rate limit. */
  | "rate_limited"
  /** Paused on a model usage/quota limit. */
  | "usage_blocked";

/** The kinds of block that stop the fleet claiming work. */
export type FleetBlockKind = "rate_limited" | "usage_blocked";

/** Terminal outcome of one claimed issue. */
export type FleetRunOutcome = "success" | "failure" | "skip";

/**
 * Per-host `issue`-phase counters (Issue #2347, part of #2320).
 *
 * The advisor/executor pilot compares one host against the control hosts, and
 * `successes` / `failures` / `successRate` carry no cost and no quality signal
 * — so the comparison had no per-host source short of reading every run-stats
 * comment on every issue the fleet touched. These five counters are the same
 * figures that comment renders, accumulated per host:
 *
 *   - the implementation runs this host completed,
 *   - what they cost (estimated USD, summed),
 *   - how many passed the quality gate on the **first** attempt — so the
 *     first-attempt pass rate is a division of two recorded numbers rather
 *     than a grep,
 *   - how long they took, reported beside the cost and gating nothing, and
 *   - how many of them had the executor split on, so a half-configured host
 *     is visible instead of silently averaging pilot and control runs.
 */
export interface IssuePhaseCounters {
  /** Completed `issue`-phase runs recorded on this host. */
  issuePhaseRuns: number;
  /** Summed estimated spend, in USD, across those runs. */
  issuePhaseUsd: number;
  /** Those runs whose quality gate passed on attempt 1. */
  issuePhaseFirstAttemptGatePasses: number;
  /** Summed duration, in seconds, across those runs. Gates nothing. */
  issuePhaseDurationSeconds: number;
  /** Those runs that had the advisor/executor split on. */
  issuePhaseSplitRuns: number;
}

/** One completed `issue`-phase run, as {@link recordIssuePhaseRun} takes it. */
export interface IssuePhaseRun {
  /** Estimated spend for the run, in USD. Absent contributes nothing. */
  usd?: number;
  /**
   * Which of the quality gate's bounded attempts passed. Only `1` counts
   * towards {@link IssuePhaseCounters.issuePhaseFirstAttemptGatePasses}, so
   * the recorded count can never diverge from the recorded attempt. Absent —
   * a run that never reached the gate, or never passed it — counts nothing.
   */
  gatePassedOnAttempt?: number;
  /** Run duration in seconds. Absent contributes nothing. */
  durationSeconds?: number;
  /** Whether the advisor/executor split was on for the run. */
  split?: boolean;
}

/** Additive totals — the fields that can be summed across runs. */
export interface FleetTelemetryTotals extends IssuePhaseCounters {
  /** Wall seconds observed. */
  wallSeconds: number;
  /** Seconds with no issue being worked. */
  idleSeconds: number;
  /** Idle seconds split by reason; sums to `idleSeconds`. */
  idleByReason: Record<string, number>;
  /**
   * Wall seconds with at least one stream holding a claim. This — not
   * {@link FleetTelemetryTotals.busySeconds} — is what idle is measured
   * against, so a half-idle pool is not reported as fully busy.
   */
  occupiedSeconds: number;
  /**
   * Seconds spent inside `processIssue`, summed over streams. Overlaps
   * itself under concurrency and can exceed `wallSeconds`.
   */
  busySeconds: number;
  /** Busy seconds per work stream. */
  busyByStream: Record<string, number>;
  /** Seconds paused on a model usage/quota limit. */
  tokenBlockedSeconds: number;
  /** Seconds paused on a GitHub rate limit. */
  rateLimitedSeconds: number;
  /** How many times a GitHub rate-limit backoff was served. */
  rateLimitWaits: number;
  /** How many times a model usage-limit pause was served. */
  tokenBlockedWaits: number;
  /** Issues claimed. */
  claims: number;
  /** Claimed issues whose run succeeded. */
  successes: number;
  /** Claimed issues whose run failed. */
  failures: number;
  /** Claims that never ran (issue unavailable, expected bounce). */
  skips: number;
  /** Failures by class — the failing phase, or `timeout`. */
  failuresByClass: Record<string, number>;
}

/**
 * Totals as a **prior** sidecar carries them (Issue #2347).
 *
 * A snapshot written before the issue-phase counters existed carries none of
 * them, so they are optional here and read as zero — an older file loads and
 * merges instead of poisoning every cumulative total with `NaN`.
 */
export type PriorFleetTelemetryTotals =
  & Omit<FleetTelemetryTotals, keyof IssuePhaseCounters>
  & Partial<IssuePhaseCounters>;

/** Totals plus the derived rates. */
export interface FleetTelemetrySnapshot extends FleetTelemetryTotals {
  /**
   * Monotonic identifier for the current accumulation window. Bumped by
   * {@link resetFleetTelemetry} and {@link startFleetTelemetry} so the
   * sidecar can tell "another write in this run" from "a new run".
   */
  runToken: number;
  /**
   * Post-run callback invocations that did not exit 0 this run (Issue #2297).
   *
   * Deliberately on the snapshot rather than {@link FleetTelemetryTotals}: it
   * describes this host's hook deployment right now, not work the fleet did,
   * and the durable sidecar accumulates the latter across runs.
   */
  hookFailures: number;
  /** `successes / (successes + failures)`, or `null` before any run ends. */
  successRate: number | null;
  /** `busySeconds / wallSeconds` per stream. */
  utilisation: Record<string, number>;
}

/**
 * One census row, reduced to what the fleet reason derivation needs. The
 * per-repo deferral counts are optional so a caller with only a skip
 * reason still works; `RepoCensusEntry` satisfies this shape as-is.
 */
export interface CensusReasonInput {
  skipReason: RepoCensusSkipReason;
  /** The repo holds ≥1 unblocked `top-priority`/`work-on`/`low-priority`. */
  inversionSignal?: boolean;
  dependencyBlocked?: number;
  prBlocked?: number;
  streamOccupied?: number;
  runLocalHold?: number;
  lowPrioritySuppressed?: number;
}

/** Failure class recorded when the caller could not name one. */
const UNKNOWN_FAILURE_CLASS = "unknown";

interface FleetState {
  runToken: number;
  runStartMs?: number;
  /** Wall position up to which idle time has been attributed. */
  closedThroughMs?: number;
  /** Streams currently holding a claim. Occupancy is "this is > 0". */
  activeStreams: number;
  /** When the fleet last went from unoccupied to occupied. */
  occupiedStartMs?: number;
  /** Occupied milliseconds since the last attribution. */
  occupiedSinceCloseMs: number;
  /** Total occupied milliseconds this run. */
  occupiedMs: number;
  /** Fleet-level blocked milliseconds since the last attribution. */
  blockedSinceCloseMs: number;
  /** When each active stream began its current run. */
  streamStartMs: Map<string, number>;
  idleMsByReason: Map<string, number>;
  busyMsByStream: Map<string, number>;
  tokenBlockedMs: number;
  rateLimitedMs: number;
  rateLimitWaits: number;
  tokenBlockedWaits: number;
  claims: number;
  successes: number;
  failures: number;
  skips: number;
  failuresByClass: Map<string, number>;
  hookFailures: number;
  /** Issue #2347 — the per-host `issue`-phase pilot counters. */
  issuePhase: IssuePhaseCounters;
}

/** Zeroed {@link IssuePhaseCounters} — the start of every window. */
function zeroIssuePhaseCounters(): IssuePhaseCounters {
  return {
    issuePhaseRuns: 0,
    issuePhaseUsd: 0,
    issuePhaseFirstAttemptGatePasses: 0,
    issuePhaseDurationSeconds: 0,
    issuePhaseSplitRuns: 0,
  };
}

function emptyState(runToken: number): FleetState {
  return {
    runToken,
    activeStreams: 0,
    occupiedSinceCloseMs: 0,
    occupiedMs: 0,
    blockedSinceCloseMs: 0,
    streamStartMs: new Map(),
    idleMsByReason: new Map(),
    busyMsByStream: new Map(),
    tokenBlockedMs: 0,
    rateLimitedMs: 0,
    rateLimitWaits: 0,
    tokenBlockedWaits: 0,
    claims: 0,
    successes: 0,
    failures: 0,
    skips: 0,
    failuresByClass: new Map(),
    hookFailures: 0,
    issuePhase: zeroIssuePhaseCounters(),
  };
}

let state: FleetState = emptyState(0);

/** Clear every accumulator and open a new accumulation window. */
export function resetFleetTelemetry(): void {
  state = emptyState(state.runToken + 1);
}

/**
 * Mark the start of a run's accumulation window. Idempotent per run — a
 * second call restarts the wall clock.
 */
export function startFleetTelemetry(nowMs: number = Date.now()): void {
  resetFleetTelemetry();
  state.runStartMs = nowMs;
  state.closedThroughMs = nowMs;
}

/**
 * Mark the start of a cycle. Deliberately does **not** move the
 * attribution marker: a cycle that returns early (a failed health check, a
 * rate-limit pause) never reaches {@link recordCycleIdle}, and its wall
 * time is real idle time. Leaving the marker where it is folds that time
 * into the next attributed segment instead of dropping it.
 */
export function startFleetCycle(nowMs: number = Date.now()): void {
  if (state.runStartMs === undefined) state.runStartMs = nowMs;
  if (state.closedThroughMs === undefined) state.closedThroughMs = nowMs;
}

function addTo(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

/**
 * A work stream has taken a claim. The fleet counts as occupied while at
 * least one stream is open, so concurrent slots cannot subtract more wall
 * time than the clock actually held.
 */
export function beginBusy(stream: string, nowMs: number = Date.now()): void {
  if (state.streamStartMs.has(stream)) return;
  state.streamStartMs.set(stream, nowMs);
  state.activeStreams += 1;
  if (state.activeStreams === 1) state.occupiedStartMs = nowMs;
}

/** A work stream has released its claim. */
export function endBusy(stream: string, nowMs: number = Date.now()): void {
  const startedAt = state.streamStartMs.get(stream);
  if (startedAt === undefined) return;
  state.streamStartMs.delete(stream);
  addTo(state.busyMsByStream, stream, Math.max(0, nowMs - startedAt));
  state.activeStreams -= 1;
  if (state.activeStreams > 0) return;
  const occupiedFrom = state.occupiedStartMs;
  if (occupiedFrom !== undefined) {
    const ms = Math.max(0, nowMs - occupiedFrom);
    state.occupiedSinceCloseMs += ms;
    state.occupiedMs += ms;
  }
  state.occupiedStartMs = undefined;
}

/** Add to the blocked totals for `kind`, counting one wait. */
function addBlockedTotals(kind: FleetBlockKind, ms: number): void {
  if (kind === "rate_limited") {
    state.rateLimitedMs += ms;
    state.rateLimitWaits += 1;
  } else {
    state.tokenBlockedMs += ms;
    state.tokenBlockedWaits += 1;
  }
}

/**
 * Record wall seconds the loop spent blocked **between** runs. Counts as
 * its own idle reason as well as against the blocked totals, so
 * `idle_by_reason` still sums to `idle_seconds`. A zero-length wait is
 * ignored rather than reported as a wait that did not happen.
 */
export function recordBlockedSeconds(
  kind: FleetBlockKind,
  seconds: number,
): void {
  const ms = Math.max(0, seconds) * 1000;
  if (ms === 0) return;
  addTo(state.idleMsByReason, kind, ms);
  state.blockedSinceCloseMs += ms;
  addBlockedTotals(kind, ms);
}

/**
 * Record wall seconds a claimed run spent blocked **inside** itself — the
 * agent's own rate-limit retry ladder sleeps in-process, and without this
 * an hour of waiting reads as an hour of work. Counted in the blocked
 * totals (the number the issue asks for) but deliberately NOT as an idle
 * reason: the fleet was holding a claim, not idle.
 */
export function recordInRunBlockedSeconds(
  kind: FleetBlockKind,
  seconds: number,
): void {
  const ms = Math.max(0, seconds) * 1000;
  if (ms === 0) return;
  addBlockedTotals(kind, ms);
}

/**
 * Attribute every unaccounted wall second since the last attribution to
 * `reason`, and advance the marker. Occupied and blocked spans are
 * excluded. A stream still holding a claim contributes its elapsed time
 * to this segment without closing, so a run that spans several cycles is
 * not counted as idle.
 */
export function recordCycleIdle(
  reason: FleetIdleReason,
  nowMs: number = Date.now(),
): void {
  const start = state.closedThroughMs;
  if (start === undefined) return;
  const segmentMs = Math.max(0, nowMs - start);
  // Occupancy still open at the boundary: bank it and re-open at `nowMs`.
  const occupiedFrom = state.occupiedStartMs;
  if (occupiedFrom !== undefined) {
    const openMs = Math.max(0, nowMs - occupiedFrom);
    state.occupiedSinceCloseMs += openMs;
    state.occupiedMs += openMs;
    state.occupiedStartMs = nowMs;
  }
  const idleMs = Math.max(
    0,
    segmentMs - state.occupiedSinceCloseMs - state.blockedSinceCloseMs,
  );
  if (idleMs > 0) addTo(state.idleMsByReason, reason, idleMs);
  state.closedThroughMs = nowMs;
  state.occupiedSinceCloseMs = 0;
  state.blockedSinceCloseMs = 0;
}

/** Record that an issue was claimed. */
export function recordClaim(): void {
  state.claims += 1;
}

/**
 * Record post-run callback invocations that did not exit 0 (Issue #2297).
 *
 * `claims=3 successes=2 failures=0` read as a healthy run on GRQ-25 while
 * every heartbeat the host published was being lost — the hook failed on each
 * of those runs and the summary had nowhere to say so.
 *
 * @param count - Failing invocations to add; defaults to one
 */
export function recordHookFailure(count = 1): void {
  if (!Number.isFinite(count) || count <= 0) return;
  state.hookFailures += Math.floor(count);
}

/**
 * Record the terminal outcome of a claimed issue. `failureClass` is the
 * failing phase (`setup`, `execute`, `quality_gate`, …) or `timeout`.
 */
export function recordOutcome(
  outcome: FleetRunOutcome,
  failureClass?: string,
): void {
  if (outcome === "success") {
    state.successes += 1;
    return;
  }
  if (outcome === "skip") {
    state.skips += 1;
    return;
  }
  state.failures += 1;
  const cls = failureClass?.trim();
  addTo(
    state.failuresByClass,
    cls && cls.length > 0 ? cls : UNKNOWN_FAILURE_CLASS,
    1,
  );
}

/**
 * A recorded figure, or 0 when the caller had none to give.
 *
 * Negative and non-finite values contribute nothing rather than propagating a
 * `NaN` through every subsequent total — one unparseable duration would
 * otherwise make the whole host's telemetry unreadable, which is the opposite
 * of surfacing it.
 */
function contribution(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Record one completed `issue`-phase run (Issue #2347, part of #2320).
 *
 * Called once per run from the completion path that posts the run-stats
 * comment, with the same figures that comment renders — so a pilot host's
 * spend, first-attempt gate pass rate and duration are comparable with the
 * control hosts' straight off the fleet summary.
 *
 * @param run - The run's cost, gate attempt, duration and split state
 */
export function recordIssuePhaseRun(run: IssuePhaseRun): void {
  const counters = state.issuePhase;
  counters.issuePhaseRuns += 1;
  counters.issuePhaseUsd += contribution(run.usd);
  counters.issuePhaseDurationSeconds += contribution(run.durationSeconds);
  if (run.gatePassedOnAttempt === 1) {
    counters.issuePhaseFirstAttemptGatePasses += 1;
  }
  if (run.split === true) counters.issuePhaseSplitRuns += 1;
}

function secondsFrom(ms: number): number {
  return Math.round(ms / 1000);
}

function secondsMap(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].map(([key, ms]) => [key, secondsFrom(ms)]),
  );
}

/** Snapshot of every accumulator plus the derived rates. */
export function getFleetTelemetry(
  nowMs: number = Date.now(),
): FleetTelemetrySnapshot {
  const wallSeconds = state.runStartMs === undefined
    ? 0
    : Math.max(0, secondsFrom(nowMs - state.runStartMs));
  const idleByReason = secondsMap(state.idleMsByReason);
  // Streams still holding a claim count towards this snapshot without
  // closing, so a mid-run reading is not reported as an idle fleet.
  const openStreamMs = new Map(state.busyMsByStream);
  for (const [stream, startedAt] of state.streamStartMs) {
    addTo(openStreamMs, stream, Math.max(0, nowMs - startedAt));
  }
  const busyByStream = secondsMap(openStreamMs);
  const occupiedMs = state.occupiedMs +
    (state.occupiedStartMs === undefined
      ? 0
      : Math.max(0, nowMs - state.occupiedStartMs));
  const idleSeconds = Object.values(idleByReason).reduce((a, b) => a + b, 0);
  const busySeconds = Object.values(busyByStream).reduce((a, b) => a + b, 0);
  const completed = state.successes + state.failures;
  const utilisation: Record<string, number> = {};
  for (const [stream, seconds] of Object.entries(busyByStream)) {
    utilisation[stream] = wallSeconds > 0 ? seconds / wallSeconds : 0;
  }
  return {
    runToken: state.runToken,
    wallSeconds,
    idleSeconds,
    idleByReason,
    occupiedSeconds: secondsFrom(occupiedMs),
    busySeconds,
    busyByStream,
    tokenBlockedSeconds: secondsFrom(state.tokenBlockedMs),
    rateLimitedSeconds: secondsFrom(state.rateLimitedMs),
    rateLimitWaits: state.rateLimitWaits,
    tokenBlockedWaits: state.tokenBlockedWaits,
    claims: state.claims,
    successes: state.successes,
    failures: state.failures,
    skips: state.skips,
    failuresByClass: Object.fromEntries(state.failuresByClass),
    hookFailures: state.hookFailures,
    // Issue #2347 — spread copies the counters, so a later record cannot
    // mutate a snapshot a caller already holds (the sidecar serialises one).
    ...state.issuePhase,
    successRate: completed > 0 ? state.successes / completed : null,
    utilisation,
  };
}

function joinCounts(
  counts: Record<string, number>,
  suffix: string,
): string {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => `${key}=${value}${suffix}`);
  return parts.length > 0 ? parts.join(",") : "none";
}

/**
 * One machine-readable summary line. Emitted per cycle and once at the end
 * of a run, so the numbers can be trended straight out of the log.
 */
export function formatFleetSummary(nowMs: number = Date.now()): string {
  const s = getFleetTelemetry(nowMs);
  const idlePct = s.wallSeconds > 0
    ? ((s.idleSeconds / s.wallSeconds) * 100).toFixed(1)
    : "0.0";
  const utilisation = Object.entries(s.utilisation)
    .sort((a, b) => b[1] - a[1])
    .map(([stream, ratio]) => `${stream}=${ratio.toFixed(2)}`);
  return [
    "fleet-summary:",
    `wall=${s.wallSeconds}s`,
    `idle=${s.idleSeconds}s`,
    `idle_pct=${idlePct}`,
    `occupied=${s.occupiedSeconds}s`,
    `busy=${s.busySeconds}s`,
    // `usage_blocked`, not `token_blocked` (both here and as the block-kind
    // identifier that keys `idle_by_reason` / `blocked_by_reason`): the
    // secret redactor masks the value of any `key=value` whose key contains
    // TOKEN, so this line went out with `***REDACTED***` where the one metric
    // that answers "is a subscription being drained?" should be. The rule is
    // right to be blunt — `PASSWORD=12345` must stay masked — so the metric
    // is renamed rather than the rule loosened. `usage` is the vocabulary the
    // signal kind already uses (`signalKind === "usage"`).
    //
    // The persisted sidecar fields keep their `tokenBlocked*` names: they are
    // JSON state that accumulates across runs, and renaming them would orphan
    // every prior file's accumulated value.
    `usage_blocked=${s.tokenBlockedSeconds}s`,
    `usage_blocked_waits=${s.tokenBlockedWaits}`,
    `rate_limited=${s.rateLimitedSeconds}s`,
    `rate_limit_waits=${s.rateLimitWaits}`,
    `claims=${s.claims}`,
    `successes=${s.successes}`,
    `failures=${s.failures}`,
    `skips=${s.skips}`,
    // Issue #2297: a run whose every heartbeat hook failed no longer reads as
    // a clean `successes=2 failures=0`.
    `hook_failures=${s.hookFailures}`,
    `success_rate=${s.successRate === null ? "n/a" : s.successRate.toFixed(2)}`,
    // Issue #2347: the pilot's per-host `issue`-phase counters. `issue_usd`
    // carries four decimals because a cheap run's spend is cents, and
    // `issue_duration` is reported beside the cost with no threshold of its
    // own — it describes the runs, it does not gate them. None of these keys
    // trips the secret redactor's `key=value` rule (see `usage_blocked`
    // above); `fleet_telemetry_redaction_test.ts` is what holds that.
    `issue_runs=${s.issuePhaseRuns}`,
    `issue_split_runs=${s.issuePhaseSplitRuns}`,
    `issue_usd=${s.issuePhaseUsd.toFixed(4)}`,
    `issue_gate_first_attempt_passes=${s.issuePhaseFirstAttemptGatePasses}`,
    `issue_duration=${s.issuePhaseDurationSeconds}s`,
    `idle_by_reason=${joinCounts(s.idleByReason, "s")}`,
    `failures_by_class=${joinCounts(s.failuresByClass, "")}`,
    `utilisation=${utilisation.length > 0 ? utilisation.join(",") : "none"}`,
  ].join(" ");
}

/**
 * The census's per-repo deferral counts, in the order they are consulted
 * when the fleet was scanned but claimed nothing. Ties break on this
 * order, so the attribution is deterministic.
 */
const DEFERRAL_REASONS: ReadonlyArray<
  [keyof CensusReasonInput, FleetIdleReason]
> = [
  ["dependencyBlocked", "dependency_blocked"],
  ["streamOccupied", "stream_occupied"],
  ["prBlocked", "pr_blocked"],
  ["runLocalHold", "cooldown_local"],
  ["lowPrioritySuppressed", "low_priority_suppressed"],
];

/**
 * Reduce a cycle's per-repo census rows to the single reason the fleet was
 * idle. The most frequent skip reason wins, ties breaking on first-seen
 * order.
 *
 * The census only ever sets a skip reason for the claim gates
 * (`host_disk_low`, `work_volume_fault`, `cycle_deadline`) — every other
 * repo reads `scanned`, so stopping there would leave the reasons the
 * issue actually names (dependency-blocked, PR-blocked, stream-occupied)
 * permanently unreachable. A scanned fleet is therefore split further:
 *
 *   - unblocked priority work is still open → `nothing_claimable_backlog`,
 *     the idle-vs-work-on inversion, and the fault worth alerting on;
 *   - otherwise the dominant per-repo deferral count names the reason;
 *   - otherwise there was genuinely nothing to claim →
 *     `nothing_claimable_empty`.
 */
export function deriveIdleReason(
  entries: readonly CensusReasonInput[],
): FleetIdleReason {
  const first = entries[0];
  if (first === undefined) return "unknown";
  const counts = new Map<RepoCensusSkipReason, number>();
  for (const entry of entries) {
    counts.set(entry.skipReason, (counts.get(entry.skipReason) ?? 0) + 1);
  }
  let winner: RepoCensusSkipReason = first.skipReason;
  let best = counts.get(winner) ?? 0;
  for (const entry of entries) {
    const count = counts.get(entry.skipReason) ?? 0;
    if (count > best) {
      winner = entry.skipReason;
      best = count;
    }
  }
  if (winner !== "scanned") return winner;

  const scanned = entries.filter((entry) => entry.skipReason === "scanned");
  if (scanned.some((entry) => entry.inversionSignal === true)) {
    return "nothing_claimable_backlog";
  }
  let dominant: FleetIdleReason | undefined;
  let dominantCount = 0;
  for (const [field, reason] of DEFERRAL_REASONS) {
    const total = scanned.reduce(
      (sum, entry) =>
        sum + (typeof entry[field] === "number" ? entry[field] : 0),
      0,
    );
    if (total > dominantCount) {
      dominant = reason;
      dominantCount = total;
    }
  }
  return dominant ?? "nothing_claimable_empty";
}
