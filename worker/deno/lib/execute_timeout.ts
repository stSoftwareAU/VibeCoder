/**
 * Deadline-aware execute-phase timeout (Issue #4254, proposal 1).
 *
 * `runIssueScanLoop` checks the cycle deadline only *between* claims — an
 * in-flight execute is bounded solely by `claudeTimeout` (a flat 3600 s). A
 * claim taken late in the cycle therefore runs a full hour past the planned
 * shutdown; one stuck run stretched a 3 h 46 m cycle to 11 h 30 m. This
 * bounds the execute timeout to the time left until the deadline (plus the
 * kill grace) when a deadline is known.
 *
 * ## The rule: a deadline-bound run is never extended (Issue #4297)
 *
 * The progress-extension deadline (#4290) re-arms the watchdog while the run
 * demonstrably progresses. Left unqualified that would undo #4254: a claim
 * deliberately given *less* than the full budget — because the cycle is
 * nearly over — would stretch the cycle again on the strength of looking
 * busy, which is exactly the symptom #4254 fixed.
 *
 * So the two mechanisms are mutually exclusive, decided once at run start:
 *
 *   - `deadlineBound === true` — the cycle deadline is the binding bound.
 *     The deadline is a real external commitment (the launcher restarts the
 *     worker on it), so progress extensions are **not** offered and the run
 *     dies at the bounded timeout exactly as #4254 shipped it.
 *   - `deadlineBound === false` — the configured `claudeTimeout` binds
 *     (no cycle deadline, or plenty of time left). Progress extensions apply
 *     per #4295/#4296.
 *
 * {@link resolveExtensionRegime} is that decision, and the execute phase logs
 * the regime it named at run start so an operator can see which one a given
 * run is in without reading the config.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Never bound the timeout below this many seconds. A claim taken a moment
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
 * Resolve the effective execute timeout.
 *
 * `min(claudeTimeout, secondsUntilDeadline + killGrace)`, floored at
 * {@link EXECUTE_TIMEOUT_FLOOR_SECONDS}. With no deadline the configured
 * timeout stands unchanged.
 *
 * @param configuredTimeoutSeconds - `config.claudeTimeout`.
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

/** Which timeout regime a run is in (Issue #4297). */
export type ExtensionRegimeName = "deadline-bound" | "extension-eligible";

/** Outcome of {@link resolveExtensionRegime}. */
export interface ExtensionRegime {
  /** The regime's operator-facing name, as logged at run start. */
  regime: ExtensionRegimeName;
  /** True when progress extensions (#4290) may be offered to this run. */
  extensionsAllowed: boolean;
  /** One sentence naming why, for the run-start log line. */
  reason: string;
}

/**
 * Decide whether this run may be offered progress extensions.
 *
 * See the module doc for the rule: a run whose timeout was bound by the
 * cycle deadline is never extended; a run on the configured budget is.
 *
 * Pure — the caller logs the reason and, when extensions are not allowed,
 * simply does not build the extension option, so the runner keeps the
 * one-shot kill it has always had.
 *
 * @param timeout - The resolved timeout from
 *   {@link resolveExecuteTimeoutSeconds}.
 * @param configuredTimeoutSeconds - `config.claudeTimeout`, for the message.
 * @returns The regime, whether extensions apply, and why.
 */
export function resolveExtensionRegime(
  timeout: ExecuteTimeout,
  configuredTimeoutSeconds: number,
): ExtensionRegime {
  if (timeout.deadlineBound) {
    return {
      regime: "deadline-bound",
      extensionsAllowed: false,
      reason:
        `the cycle deadline bounds this run to ${timeout.timeoutSeconds}s ` +
        `(configured ${configuredTimeoutSeconds}s), so progress extensions ` +
        `are not offered — the deadline is an external commitment ` +
        `(Issue #4254)`,
    };
  }
  return {
    regime: "extension-eligible",
    extensionsAllowed: true,
    reason:
      `the configured budget of ${timeout.timeoutSeconds}s binds this run, ` +
      `so progress extensions apply if enabled (Issue #4290)`,
  };
}
