/**
 * Claim-runway floor resolution (Issue #47).
 *
 * The #4304 floor refuses a claim with less than a fixed runway (default
 * {@link DEFAULT_MIN_CLAIM_RUNWAY_SECONDS}) left in the cycle. Observed live (VibeCoder#5, then three kills in
 * one day on Mac-Ultra-M2): a claim can clear that floor and still receive a
 * deadline-bound execute budget well under the configured `claudeTimeout`,
 * because the floor does not know what a full execute costs. The run is then
 * killed at the cycle deadline and — before WIP preservation — everything it
 * produced was discarded. A bounded budget should be a documented exception,
 * not the default tail of every cycle.
 *
 * The rule this module resolves:
 *
 * - When the cycle is long enough to ever offer a full execute budget
 *   (`cycleSeconds > fullExecuteBudgetSeconds`), the claim floor is raised to
 *   that budget: a new implementation claim is refused once the remaining
 *   runway could no longer fit a full `claudeTimeout` execute. The tail of
 *   the cycle goes to cheap maintenance instead (as #4304 intended).
 * - When the whole cycle is shorter than the budget (for example a 3600 s
 *   cycle with a 3600 s `claudeTimeout`), raising the floor would refuse
 *   every claim the host could ever make. The existing floor stands, and the
 *   caller logs {@link ClaimRunwayFloor.exceptionReason} once so the
 *   deadline-bound regime is a *documented* exception on that host.
 *
 * Pure and side-effect free; the scan loop and the slot pool both call it
 * once per cycle and apply the resolved floor at every claim gate.
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

/** Outcome of {@link resolveClaimRunwayFloor}. */
export interface ClaimRunwayFloor {
  /** Seconds of runway a new claim must have. 0 disables the floor. */
  floorSeconds: number;
  /**
   * True when the floor is the full execute budget — a refusal under this
   * floor means "the remaining runway cannot fit a full execute", not the
   * plain #4304 wording.
   */
  fullBudgetGate: boolean;
  /**
   * Set when the cycle can never offer the full budget: one sentence for the
   * caller to log so the host's permanent deadline-bound regime is visible
   * in the worker log rather than silent.
   */
  exceptionReason?: string;
}

/**
 * Resolve the effective claim-runway floor for this cycle.
 *
 * @param options.minClaimRunwaySeconds - The configured #4304 floor
 *   (`MIN_CLAIM_RUNWAY_SECONDS`, default {@link DEFAULT_MIN_CLAIM_RUNWAY_SECONDS};
 *   0 disables).
 * @param options.fullExecuteBudgetSeconds - `config.claudeTimeout`. Optional:
 *   absent (or non-positive) keeps the plain #4304 floor. Production passes
 *   it only when `CLAIM_REQUIRE_FULL_EXECUTE_BUDGET=1` (VibeCoder#170).
 * @param options.cycleSeconds - `config.runDurationSeconds` — the cycle
 *   length the deadline is derived from.
 */
export function resolveClaimRunwayFloor(options: {
  minClaimRunwaySeconds: number;
  fullExecuteBudgetSeconds?: number;
  cycleSeconds: number;
}): ClaimRunwayFloor {
  const { minClaimRunwaySeconds, fullExecuteBudgetSeconds, cycleSeconds } =
    options;
  if (
    fullExecuteBudgetSeconds === undefined || fullExecuteBudgetSeconds <= 0
  ) {
    return { floorSeconds: minClaimRunwaySeconds, fullBudgetGate: false };
  }
  if (cycleSeconds > fullExecuteBudgetSeconds) {
    return {
      floorSeconds: Math.max(minClaimRunwaySeconds, fullExecuteBudgetSeconds),
      fullBudgetGate: true,
    };
  }
  return {
    floorSeconds: minClaimRunwaySeconds,
    fullBudgetGate: false,
    exceptionReason:
      `this cycle (${cycleSeconds}s) can never offer the configured ` +
      `${fullExecuteBudgetSeconds}s execute budget, so every execute here ` +
      `is deadline-bound by design — keeping the ` +
      `${minClaimRunwaySeconds}s claim floor; rely on WIP preservation to ` +
      `carry progress across cycles (Issue #47)`,
  };
}
