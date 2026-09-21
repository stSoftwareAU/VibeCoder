/**
 * Pace the end-of-cycle sleep by the GraphQL budget left in the window
 * (Issue #2447).
 *
 * The end-of-cycle sleep used to be a fixed `sleepInterval` no matter how much
 * of the hour's GraphQL quota was left. The only guard against burning the
 * budget was the pre-flight threshold in `github_rate_limit_preflight.ts`,
 * which fires only once the quota is already gone. This module stretches the
 * sleep proportionally when the account-wide spend of the last cycle exceeds
 * what the remaining window can afford, so the hour's quota lasts the hour.
 *
 * Pure by design: every input is a number and every output is derived from
 * them, so the pacing decision is trivially testable and carries no I/O.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Fraction of the window's points kept in reserve for issue work. */
export const BUDGET_RESERVE_FRACTION = 0.2;

/** Hard ceiling on the paced sleep, so pacing never parks the worker for an hour. */
export const MAX_PACED_SLEEP_SECONDS = 300;

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
  /**
   * The points the window can afford to spend per remaining cycle. Exposed so
   * the wiring's `budget-pacing:` log line can name it without recomputing
   * the formula.
   */
  affordablePerCycle: number;
}

/**
 * Decide the end-of-cycle sleep from the budget left in the window.
 *
 * The affordable spend per cycle is
 * `(remaining − limit·reserve) / cyclesLeftInWindow`, where
 * `cyclesLeftInWindow` is the number of cycles that still fit before the
 * window reopens, floored at 1. When the last cycle spent no more than that,
 * the base sleep stands. Otherwise the sleep is stretched by the overspend
 * ratio so the projected spend fits, capped at {@link MAX_PACED_SLEEP_SECONDS}.
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
  const inReserve = remaining <= reserve;
  const base = Math.max(0, baseSleepSeconds);

  // How many cycles still fit before the window reopens. Floored at 1 so a
  // window about to reset (or a stale/negative `reset − now`) cannot divide by
  // a fraction of a cycle and blow the affordable spend up.
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

  // Overspend — or no spendable budget left outside the reserve. Stretch the
  // sleep by the overspend ratio so the projected spend fits, capped at the
  // pacing ceiling and never below the base.
  const ratio = affordablePerCycle > 0
    ? spentLastCycle / affordablePerCycle
    : Number.POSITIVE_INFINITY;
  const stretched = base * ratio;
  const sleepSeconds = Math.min(
    MAX_PACED_SLEEP_SECONDS,
    Math.max(base, stretched),
  );
  const reason = affordablePerCycle <= 0
    ? "remaining budget is at or below the reserve"
    : "last cycle's spend exceeds the affordable spend per cycle";

  return { sleepSeconds, reason, inReserve, affordablePerCycle };
}
