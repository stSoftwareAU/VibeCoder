/**
 * Pace the end-of-cycle sleep by the GraphQL budget left in the window
 * (Issue #2447). When the account-wide spend of the last cycle exceeds what
 * the remaining window can afford per cycle, stretch the sleep proportionally
 * (capped) so the hour's quota lasts the hour. Pure: numbers in, a decision
 * out, no I/O. Australian English throughout.
 */

/** Fraction of the window's points kept in reserve for issue work. */
export const BUDGET_RESERVE_FRACTION = 0.2;

/** Hard ceiling on the paced sleep, so pacing never parks the worker for an hour. */
export const MAX_PACED_SLEEP_SECONDS = 300;

/**
 * Whether a quota reading leaves the window at or below its reserve.
 *
 * The single source of truth for "in reserve": {@link computePacedSleepSeconds}
 * reports it in its decision, and the cycle loop asks it directly of the
 * reading it just took (Issue #2449) — including the run's first reading,
 * which has no previous reading to diff a spend against.
 */
export function isInReserve(limit: number, remaining: number): boolean {
  return remaining <= limit * BUDGET_RESERVE_FRACTION;
}

/** Inputs to the pacing decision. */
export interface PacedSleepInput {
  /** Points per window (5,000 for a user token). */
  limit: number;
  /** Points left in the current window. */
  remaining: number;
  /** Unix seconds when the window reopens. */
  reset: number;
  /** The current time, in Unix seconds. */
  nowSeconds: number;
  /** Points the account spent over the last cycle. */
  spentLastCycle: number;
  /** Wall-clock duration of the last cycle, in seconds. */
  cycleSeconds: number;
  /** The un-paced end-of-cycle sleep, in seconds. */
  baseSleepSeconds: number;
}

/** The pacing decision. */
export interface PacedSleepResult {
  /** The sleep to use, never less than `baseSleepSeconds`. */
  sleepSeconds: number;
  /** Why the sleep was (or was not) stretched, for the per-cycle log line. */
  reason: string;
  /** Whether the remaining budget is at or below the reserve. */
  inReserve: boolean;
  /** Affordable spend per remaining cycle, named by the `budget-pacing:` log. */
  affordablePerCycle: number;
}

/**
 * Decide the end-of-cycle sleep from the budget left in the window.
 *
 * Affordable spend per cycle is `(remaining − limit·reserve) /
 * cyclesLeftInWindow`, where `cyclesLeftInWindow = max(1, (reset − now) /
 * (cycleSeconds + baseSleepSeconds))`. Spend at or below that keeps the base
 * sleep; otherwise the sleep is stretched by the overspend ratio, capped at
 * {@link MAX_PACED_SLEEP_SECONDS} and never below the base.
 */
export function computePacedSleepSeconds(
  input: PacedSleepInput,
): PacedSleepResult {
  const {
    limit,
    remaining,
    reset,
    nowSeconds,
    spentLastCycle,
    cycleSeconds,
    baseSleepSeconds,
  } = input;

  const reserve = limit * BUDGET_RESERVE_FRACTION;
  const inReserve = isInReserve(limit, remaining);
  const base = Math.max(0, baseSleepSeconds);

  // Floored at 1 so a window about to reset (or a stale/negative reset) cannot
  // divide by a fraction of a cycle and inflate the affordable spend.
  const secondsToReset = reset - nowSeconds;
  const cyclesLeftInWindow = Math.max(
    1,
    secondsToReset / (cycleSeconds + base),
  );

  const affordablePerCycle = (remaining - reserve) / cyclesLeftInWindow;

  if (spentLastCycle <= affordablePerCycle && affordablePerCycle > 0) {
    return {
      sleepSeconds: base,
      reason: "spend fits the remaining budget",
      inReserve,
      affordablePerCycle,
    };
  }

  // Overspend — or nothing spendable left outside the reserve — so stretch the
  // sleep by the overspend ratio, capped and never below the base. With
  // nothing affordable there is no finite ratio, so the stretch goes straight
  // to the cap; taking that branch explicitly also keeps a zero base out of
  // `0 × Infinity`, which is `NaN` and would reach `deps.sleep()` as one.
  const stretched = affordablePerCycle > 0
    ? base * (spentLastCycle / affordablePerCycle)
    : MAX_PACED_SLEEP_SECONDS;
  const sleepSeconds = Math.min(
    MAX_PACED_SLEEP_SECONDS,
    Math.max(base, stretched),
  );
  const reason = affordablePerCycle <= 0
    ? "remaining budget is at or below the reserve"
    : "last cycle's spend exceeds the affordable spend per cycle";

  return { sleepSeconds, reason, inReserve, affordablePerCycle };
}
