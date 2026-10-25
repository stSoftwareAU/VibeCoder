/**
 * Claim-runway floor resolution (Issues #4304/#425, parent #397).
 *
 * A claim gate exists to refuse a claim that **cannot fit** — one whose run
 * will be killed before it can plausibly produce anything. What bounds a run
 * decides what "fit" means, and Issue #420 moved that boundary:
 *
 * - **Before #420** an execute budget was truncated to the runway left in the
 *   *cycle*, so a claim taken late in the hour really was doomed on arrival.
 *   Two floors were built on that: #4304's fixed minimum, and #47's rule
 *   raising the floor to the whole execute budget so a deadline-bound execute
 *   stayed "a documented exception rather than the default tail of every
 *   cycle".
 * - **After #420** a claim taken at minute 59 keeps its full `claude_timeout`
 *   budget. The two-hour finish (Issue #4242) leaves that claim at least 61
 *   minutes, so the budget still fits (Issue #4245). #47's rule is retired
 *   outright, and #4304's floor is re-based on the boundary that actually
 *   ends the run: the **finish deadline** when a timeline is set and the
 *   finish arrives before the supervisor ceiling, otherwise the supervisor
 *   hard cap (`VIBE_RUN_MAX_SECONDS`, Issue #421).
 *
 * The rule this module resolves, post-#397:
 *
 * - The floor is measured against the runway left **to the finish deadline**
 *   when {@link ClaimHardCap.finishMs} is set, and otherwise to the hard-cap
 *   ceiling. It is never measured to the cycle deadline. A claim is refused
 *   only when that instant arrives before the run could finish setup.
 * - With **no finish deadline and no hard cap** nothing bounds the run, so no
 *   claim can be doomed for want of runway and the floor is inert. That is
 *   never silent: the caller logs {@link ClaimRunwayFloor.inertReason} once
 *   per cycle.
 * - The cycle deadline itself is unchanged and is **not** this module's
 *   business: the scan loop and the slot pool still refuse every claim once
 *   `now >= endTime` (Issue #397's soft gate).
 *
 * Pure and side-effect free; the scan loop and the slot pool both resolve the
 * floor once per cycle and apply it at every claim gate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  DEFAULT_RUN_TARGET_SECONDS,
  finishDeadlineBounds,
  getRunTimeline,
} from "./run_timeline.ts";

/**
 * Default `MIN_CLAIM_RUNWAY_SECONDS` (VibeCoder#170): five minutes — enough
 * to rule out a claim that cannot even finish setup, small enough that a run
 * keeps claiming until its last minutes. Lowered from 1800 s, which with a
 * 3600 s cycle refused every second claim and capped a host at one
 * implementation per hour.
 */
export const DEFAULT_MIN_CLAIM_RUNWAY_SECONDS = 300;

/**
 * The supervisor hard cap as the claim gate sees it (Issue #425).
 *
 * Derived from `run_hard_cap.ts`: `ceilingMs` is the absolute epoch-ms past
 * which the worker kills its own run (the supervisor's deadline less the kill
 * grace and the WIP commit-and-push reserve), and `windowSeconds` is the whole
 * span from the run's start to that ceiling — the largest execute this host
 * can ever offer.
 */
export interface ClaimHardCap {
  /**
   * Epoch-ms past which an extension grant must not move a deadline: the
   * finish less the kill grace and the WIP reserve when a timeline is set,
   * otherwise the supervisor ceiling.
   */
  ceilingMs: number;
  /**
   * The finish deadline itself, when a timeline is set (Issue #4245).
   *
   * The claim floor measures runway to this instant. Absent, the floor
   * measures to {@link ceilingMs} — the supervisor hard cap.
   */
  finishMs?: number;
  /** Seconds between the run's start and the instant the floor measures to. */
  windowSeconds: number;
}

/**
 * Point a claim cap at the finish deadline when a timeline is published.
 *
 * Called at claim time, after `runCoreLoop` has published the timeline.
 * A snapshot taken before that publication is unchanged. The extension
 * ceiling is the nearer of the supervisor ceiling and the finish less the
 * reserve. The floor reads {@link ClaimHardCap.finishMs} when the finish
 * is the sooner end of the run. A supervisor ceiling that arrives before
 * the finish still ends the run, so `finishMs` is left unset and the floor
 * keeps measuring to that ceiling.
 *
 * @param base - The supervisor cap, when this run has one.
 * @param killAfterSeconds - The worker's SIGTERM-to-SIGKILL grace.
 * @returns The cap the floor should read, or undefined when nothing bounds it.
 */
export function anchorClaimCapToFinish(
  base: ClaimHardCap | undefined,
  killAfterSeconds: number,
): ClaimHardCap | undefined {
  const bounds = finishDeadlineBounds(killAfterSeconds);
  if (!bounds) return base;
  const timeline = getRunTimeline();
  const startedMs = timeline
    ? timeline.targetMs - DEFAULT_RUN_TARGET_SECONDS * 1000
    : undefined;
  const supervisorFirst = base !== undefined &&
    base.ceilingMs < bounds.finishMs;
  const finishWindow = startedMs === undefined
    ? (base?.windowSeconds ?? 0)
    : Math.max(0, Math.round((bounds.finishMs - startedMs) / 1000));
  return {
    ceilingMs: base
      ? Math.min(base.ceilingMs, bounds.ceilingMs)
      : bounds.ceilingMs,
    ...(supervisorFirst ? {} : { finishMs: bounds.finishMs }),
    windowSeconds: supervisorFirst ? base.windowSeconds : finishWindow,
  };
}

/** The instant {@link belowClaimRunwayFloor} measures runway to. */
function claimRunwayDeadlineMs(hardCap: ClaimHardCap): number {
  return hardCap.finishMs ?? hardCap.ceilingMs;
}

/**
 * The words for the instant {@link hardCapRunwaySeconds} measured.
 *
 * A timeline names the finish deadline. With no timeline the floor still
 * measures to the supervisor hard cap.
 */
export function claimRunwayBoundPhrase(floor: ClaimRunwayFloor): string {
  return floor.hardCap?.finishMs !== undefined
    ? "the finish deadline"
    : "the supervisor hard cap";
}

/** Outcome of {@link resolveClaimRunwayFloor}. */
export interface ClaimRunwayFloor {
  /** Seconds of runway a new claim must have. 0 disables the floor. */
  floorSeconds: number;
  /** The cap the floor is measured against; absent means the run is uncapped. */
  hardCap?: ClaimHardCap;
  /**
   * Set when the floor can refuse nothing — the configured floor is `0`, or
   * this run has no hard cap to measure against. One sentence for the caller
   * to log once per cycle, so an inert gate is visible rather than silent
   * (Issue #219).
   */
  inertReason?: string;
}

/**
 * Resolve the effective claim-runway floor for this cycle.
 *
 * @param options.minClaimRunwaySeconds - The configured floor
 *   (`min_claim_runway_seconds`, default
 *   {@link DEFAULT_MIN_CLAIM_RUNWAY_SECONDS}; `0` disables).
 * @param options.hardCap - The supervisor cap this run is bounded by.
 *   Optional: absent (an uncapped run) leaves the floor inert, because
 *   nothing will kill the claim for want of runway.
 */
export function resolveClaimRunwayFloor(options: {
  minClaimRunwaySeconds: number;
  hardCap?: ClaimHardCap;
}): ClaimRunwayFloor {
  const floorSeconds = Math.max(0, options.minClaimRunwaySeconds);
  if (floorSeconds <= 0) {
    return {
      floorSeconds: 0,
      ...(options.hardCap ? { hardCap: options.hardCap } : {}),
      inertReason:
        `min_claim_runway_seconds is 0, so no claim is refused for want of ` +
        `runway; the cycle deadline alone stops new claims (Issue #397)`,
    };
  }
  if (!options.hardCap) {
    return {
      floorSeconds,
      inertReason:
        `this run has no supervisor hard cap (VIBE_RUN_MAX_SECONDS unset or ` +
        `0), so nothing truncates a claim's execute and the ${floorSeconds}s ` +
        `claim floor can refuse nothing; the cycle deadline alone stops new ` +
        `claims (Issue #425)`,
    };
  }
  return { floorSeconds, hardCap: options.hardCap };
}

/**
 * Seconds of runway left to the finish deadline when one is set, otherwise
 * to the hard-cap ceiling. Undefined when this run is uncapped.
 *
 * @param floor - The resolved floor.
 * @param nowMs - Current epoch-ms.
 */
export function hardCapRunwaySeconds(
  floor: ClaimRunwayFloor,
  nowMs: number,
): number | undefined {
  if (!floor.hardCap) return undefined;
  return Math.max(
    0,
    Math.round((claimRunwayDeadlineMs(floor.hardCap) - nowMs) / 1000),
  );
}

/**
 * True when a claim taken now would have less runway to the finish deadline
 * (or the hard-cap ceiling, when no timeline is set) than the floor.
 *
 * Always false on an uncapped run and on a disabled floor — both are inert by
 * construction, and {@link ClaimRunwayFloor.inertReason} says so.
 *
 * @param floor - The resolved floor.
 * @param nowMs - Current epoch-ms.
 */
export function belowClaimRunwayFloor(
  floor: ClaimRunwayFloor,
  nowMs: number,
): boolean {
  if (floor.floorSeconds <= 0 || !floor.hardCap) return false;
  return nowMs + floor.floorSeconds * 1000 >=
    claimRunwayDeadlineMs(floor.hardCap);
}
