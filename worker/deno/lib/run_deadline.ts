/**
 * The live deadline of an in-flight run, as the drain path sees it
 * (Issue #4297, part of #4290).
 *
 * A progress-extended run may outlive the hour the slot pool (#4177) and the
 * shutdown drain (#4182) were written against. Shutdown must treat such a run
 * as **in-flight** — drained, not truncated, and its slot released exactly
 * once — so the deadline it is actually running to has to be visible outside
 * the runner.
 *
 * This module is that shared vocabulary and nothing else: the runner reports
 * a state, the slot context carries the reporter, and the in-flight registry
 * stores it. No I/O, no clock.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** The deadline a run is currently working to. */
export interface RunDeadlineState {
  /** Epoch-ms of the deadline armed right now. */
  deadlineMs: number;
  /** Extensions granted so far on this run; 0 for an unextended run. */
  extensionsGranted: number;
}

/**
 * Sink for {@link RunDeadlineState} updates.
 *
 * Called at run start with the initial deadline and again after every grant.
 * Implementations must be cheap and must not throw — the caller is the
 * watchdog path.
 */
export type RunDeadlineReporter = (state: RunDeadlineState) => void;

/**
 * Render a run's deadline for an operator-facing log line.
 *
 * @param state - The reported deadline, or undefined when none was reported
 *   (a phase that never runs the agent, or the CLI single-issue path).
 * @param nowMs - Current epoch-ms.
 * @returns e.g. `extended 2×, deadline in 870s`, or "" when unknown.
 */
export function describeRunDeadline(
  state: RunDeadlineState | undefined,
  nowMs: number,
): string {
  if (state === undefined) return "";
  const remaining = Math.round((state.deadlineMs - nowMs) / 1000);
  const extended = state.extensionsGranted > 0
    ? `extended ${state.extensionsGranted}×, `
    : "";
  return `${extended}deadline in ${remaining}s`;
}
