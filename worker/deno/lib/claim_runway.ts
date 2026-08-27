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
 *   budget and may extend past it while genuinely progressing. Nothing is
 *   truncated, so neither premise survives: #47's rule is retired outright
 *   (there are no deadline-bound executes left for it to make rare), and
 *   #4304's floor is re-based on the boundary that actually kills a run — the
 *   **supervisor hard cap** (`VIBE_RUN_MAX_SECONDS`, resolved by
 *   `run_hard_cap.ts`, Issue #421).
 *
 * The rule this module resolves, post-#397:
 *
 * - The floor is measured against the runway left **to the hard-cap ceiling**,
 *   not to the cycle deadline. A claim is refused only when the supervisor
 *   will step in before the run could finish setup — which is what #4304
 *   always meant, now stated against the deadline that still bites.
 * - With **no hard cap published** (`VIBE_RUN_MAX_SECONDS` unset or `0`, a CLI
 *   run, a test) nothing bounds the run, so no claim can be doomed for want of
 *   runway and the floor is inert. That is never silent: the caller logs
 *   {@link ClaimRunwayFloor.inertReason} once per cycle.
 * - The cycle deadline itself is unchanged and is **not** this module's
 *   business: the scan loop and the slot pool still refuse every claim once
 *   `now >= endTime` (Issue #397's soft gate).
 *
 * Pure and side-effect free; the scan loop and the slot pool both resolve the
 * floor once per cycle and apply it at every claim gate.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

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
  /** Epoch-ms past which no run of this worker survives. */
  ceilingMs: number;
  /** Seconds between the run's start and {@link ceilingMs}. */
  windowSeconds: number;
}

/** Outcome of {@link resolveClaimRunwayFloor}. */
export interface ClaimRunwayFloor {
  /** Seconds of hard-cap runway a new claim must have. 0 disables the floor. */
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
 * Seconds of runway left to the hard-cap ceiling, or undefined when this run
 * is uncapped.
 *
 * @param floor - The resolved floor.
 * @param nowMs - Current epoch-ms.
 */
export function hardCapRunwaySeconds(
  floor: ClaimRunwayFloor,
  nowMs: number,
): number | undefined {
  if (!floor.hardCap) return undefined;
  return Math.max(0, Math.round((floor.hardCap.ceilingMs - nowMs) / 1000));
}

/**
 * True when a claim taken now would have less hard-cap runway than the floor.
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
  return nowMs + floor.floorSeconds * 1000 >= floor.hardCap.ceilingMs;
}
