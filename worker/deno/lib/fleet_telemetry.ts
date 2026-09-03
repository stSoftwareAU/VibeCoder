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
 * Accounting model. The timeline of a cycle is partitioned into:
 *
 *   - **busy** — wall time inside `processIssue`, recorded per work stream
 *     (`serial`, `slot-1`, …). Streams run concurrently, so summed busy can
 *     exceed the cycle's wall time.
 *   - **blocked** — wall time paused on a GitHub rate limit
 *     (`rate_limited`) or a model usage limit (`token_blocked`).
 *   - **idle** — everything else in the cycle (scanning, maintenance
 *     passes, the end-of-cycle sleep), attributed to the reason the cycle
 *     claimed nothing.
 *
 * The two blocked kinds are also idle reasons, so `idle_by_reason` sums to
 * `idle_seconds` exactly and nothing is double counted.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  AvailabilityVerdict,
  RepoCensusSkipReason,
} from "./idle_decision_census.ts";

/**
 * Why the fleet was idle. The census's own skip reasons are reused
 * verbatim (minus `scanned`, which describes a repo rather than a
 * verdict), plus the fleet-level reasons the census cannot express.
 */
export type FleetIdleReason =
  | Exclude<RepoCensusSkipReason, "scanned">
  /** The scan completed and monitored repos still hold open issues. */
  | "nothing_claimable_backlog"
  /** The scan completed and there was simply nothing open to claim. */
  | "nothing_claimable_empty"
  /** Non-busy remainder of a cycle that did claim and serve work. */
  | "served"
  /** Paused on a GitHub rate limit. */
  | "rate_limited"
  /** Paused on a model usage/quota limit. */
  | "token_blocked";

/** The kinds of block that stop the fleet claiming work. */
export type FleetBlockKind = "rate_limited" | "token_blocked";

/** Terminal outcome of one claimed issue. */
export type FleetRunOutcome = "success" | "failure" | "skip";

/** Additive totals — the fields that can be summed across runs. */
export interface FleetTelemetryTotals {
  /** Wall seconds observed. */
  wallSeconds: number;
  /** Seconds with no issue being worked. */
  idleSeconds: number;
  /** Idle seconds split by reason; sums to `idleSeconds`. */
  idleByReason: Record<string, number>;
  /** Seconds spent inside `processIssue`, summed over streams. */
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

/** Totals plus the derived rates. */
export interface FleetTelemetrySnapshot extends FleetTelemetryTotals {
  /**
   * Monotonic identifier for the current accumulation window. Bumped by
   * {@link resetFleetTelemetry} and {@link startFleetTelemetry} so the
   * sidecar can tell "another write in this run" from "a new run".
   */
  runToken: number;
  /** `successes / (successes + failures)`, or `null` before any run ends. */
  successRate: number | null;
  /** `busySeconds / wallSeconds` per stream. */
  utilisation: Record<string, number>;
}

/** One census row, reduced to what the fleet reason derivation needs. */
export interface CensusReasonInput {
  skipReason: RepoCensusSkipReason;
  availability: AvailabilityVerdict;
}

/** Failure class recorded when the caller could not name one. */
const UNKNOWN_FAILURE_CLASS = "unknown";

interface FleetState {
  runToken: number;
  runStartMs?: number;
  /** Wall position up to which idle time has been attributed. */
  closedThroughMs?: number;
  /** Busy milliseconds recorded since the last attribution. */
  busySinceCloseMs: number;
  /** Blocked milliseconds recorded since the last attribution. */
  blockedSinceCloseMs: number;
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
}

function emptyState(runToken: number): FleetState {
  return {
    runToken,
    busySinceCloseMs: 0,
    blockedSinceCloseMs: 0,
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
  state = emptyState(state.runToken + 1);
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

/** Record wall seconds spent working an issue on a named stream. */
export function recordBusySeconds(stream: string, seconds: number): void {
  const ms = Math.max(0, seconds) * 1000;
  addTo(state.busyMsByStream, stream, ms);
  state.busySinceCloseMs += ms;
}

/**
 * Record wall seconds the fleet spent blocked. Counts both as its own
 * idle reason and against the dedicated blocked totals, and bumps the
 * retry count for that kind.
 */
export function recordBlockedSeconds(
  kind: FleetBlockKind,
  seconds: number,
): void {
  const ms = Math.max(0, seconds) * 1000;
  addTo(state.idleMsByReason, kind, ms);
  state.blockedSinceCloseMs += ms;
  if (kind === "rate_limited") {
    state.rateLimitedMs += ms;
    state.rateLimitWaits += 1;
  } else {
    state.tokenBlockedMs += ms;
    state.tokenBlockedWaits += 1;
  }
}

/**
 * Attribute every unaccounted wall second since the last attribution to
 * `reason`, and advance the marker. Time already attributed to busy work
 * or to a block is excluded, and the remainder is floored at zero —
 * concurrent streams can report more busy seconds than the segment had
 * wall seconds.
 */
export function recordCycleIdle(
  reason: FleetIdleReason,
  nowMs: number = Date.now(),
): void {
  const start = state.closedThroughMs;
  if (start === undefined) return;
  const segmentMs = Math.max(0, nowMs - start);
  const idleMs = Math.max(
    0,
    segmentMs - state.busySinceCloseMs - state.blockedSinceCloseMs,
  );
  if (idleMs > 0) addTo(state.idleMsByReason, reason, idleMs);
  state.closedThroughMs = nowMs;
  state.busySinceCloseMs = 0;
  state.blockedSinceCloseMs = 0;
}

/** Record that an issue was claimed. */
export function recordClaim(): void {
  state.claims += 1;
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
  const busyByStream = secondsMap(state.busyMsByStream);
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
    `busy=${s.busySeconds}s`,
    `token_blocked=${s.tokenBlockedSeconds}s`,
    `token_blocked_waits=${s.tokenBlockedWaits}`,
    `rate_limited=${s.rateLimitedSeconds}s`,
    `rate_limit_waits=${s.rateLimitWaits}`,
    `claims=${s.claims}`,
    `successes=${s.successes}`,
    `failures=${s.failures}`,
    `skips=${s.skips}`,
    `success_rate=${s.successRate === null ? "n/a" : s.successRate.toFixed(2)}`,
    `idle_by_reason=${joinCounts(s.idleByReason, "s")}`,
    `failures_by_class=${joinCounts(s.failuresByClass, "")}`,
    `utilisation=${utilisation.length > 0 ? utilisation.join(",") : "none"}`,
  ].join(" ");
}

/**
 * Reduce a cycle's per-repo census rows to the single reason the fleet was
 * idle. The most frequent skip reason wins, ties breaking on first-seen
 * order so the attribution is deterministic. A fleet that was actually
 * scanned is split by whether any monitored repo still held open work —
 * "idle with a backlog" is a very different fault from "idle with nothing
 * to do".
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
  const backlog = entries.some(
    (entry) => entry.skipReason === "scanned" && entry.availability !== "empty",
  );
  return backlog ? "nothing_claimable_backlog" : "nothing_claimable_empty";
}
