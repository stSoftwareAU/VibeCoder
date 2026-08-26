/**
 * Deadline-aware Claude timeout for **idle-task scans** (Issues #4254, #186).
 *
 * The rule: bound a run to the time left until the cycle deadline (plus the
 * kill grace) when a deadline is known, floored at
 * {@link EXECUTE_TIMEOUT_FLOOR_SECONDS}. With no deadline the configured
 * timeout stands unchanged.
 *
 * ## Issue work no longer uses this (Issue #420, parent #397)
 *
 * The execute phase applied the same rule to an issue claim, so a claim taken
 * 16 minutes before the hour was given a 16-minute budget, killed mid-task,
 * and — under the #4297 "deadline-bound runs are never extended" rule —
 * refused an extension even while demonstrably progressing (GRQ#4398). The
 * cycle deadline now stops *new* claims only (`slotShouldStop` in the scan
 * loop); a claim already in flight keeps `claudeTimeout` in full, and the
 * deadline drain waits for it. The regime split retired with the truncation
 * it qualified.
 *
 * The single remaining caller is `idle_task_claude_budget.ts` (Issue #186):
 * an idle-task **scan** holds no work-in-progress and is discretionary, so
 * there is nothing to preserve and no reason to let it outlive the cycle.
 * That justification is its own — do not delete this module as dead code on
 * the strength of the execute phase having stopped calling it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Never bound the timeout below this many seconds. A scan started a moment
 * before the deadline still gets a short-but-usable run rather than zero;
 * the outer loop will not start another claim after this one anyway.
 */
export const EXECUTE_TIMEOUT_FLOOR_SECONDS = 60;

/** Outcome of {@link resolveExecuteTimeoutSeconds}. */
export interface ExecuteTimeout {
  /** The timeout to pass to the runner. */
  timeoutSeconds: number;
  /** True when the cycle deadline, not `claudeTimeout`, is the binding bound. */
  deadlineBound: boolean;
}

/**
 * Resolve the effective timeout for a run the cycle deadline may bound.
 *
 * `min(configured, secondsUntilDeadline + killGrace)`, floored at
 * {@link EXECUTE_TIMEOUT_FLOOR_SECONDS}. With no deadline the configured
 * timeout stands unchanged.
 *
 * @param configuredTimeoutSeconds - the budget the caller asked for.
 * @param killAfterSeconds - grace before SIGKILL; the deadline may be
 *   overrun by this much so a genuine kill can complete.
 * @param cycleDeadlineEpochMs - epoch-ms cycle deadline, or undefined.
 * @param nowMs - current epoch-ms (injected for testing).
 */
export function resolveExecuteTimeoutSeconds(
  configuredTimeoutSeconds: number,
  killAfterSeconds: number,
  cycleDeadlineEpochMs: number | undefined,
  nowMs: number,
): ExecuteTimeout {
  if (cycleDeadlineEpochMs === undefined) {
    return { timeoutSeconds: configuredTimeoutSeconds, deadlineBound: false };
  }

  const secondsUntilDeadline = Math.floor(
    (cycleDeadlineEpochMs + killAfterSeconds * 1000 - nowMs) / 1000,
  );
  const bounded = Math.max(
    EXECUTE_TIMEOUT_FLOOR_SECONDS,
    Math.min(configuredTimeoutSeconds, secondsUntilDeadline),
  );
  return {
    timeoutSeconds: bounded,
    deadlineBound: bounded < configuredTimeoutSeconds,
  };
}
