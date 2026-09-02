/**
 * Honest timeout messages for the re-armable hard deadline (Issue #4298,
 * part of #4290).
 *
 * Once a run can outlive its configured budget (#4296), every operator-facing
 * signal that hard-codes the configured timeout starts lying: the kill log,
 * the failure comment posted back to the issue, and the zero-output
 * diagnosis all claimed "timed out after 3600 seconds" for a run that had
 * been extended to three hours.
 *
 * This module is the shared, pure vocabulary for saying what actually
 * happened: how many extensions were granted, how many seconds they added,
 * where the final deadline landed, how long the run really took, and why the
 * last extension was refused. No I/O, no clock — the caller supplies the
 * numbers, so every message is exhaustively unit-testable.
 *
 * The legacy wording is preserved byte-for-byte when no telemetry is present
 * (the feature disabled, or any non-issue phase), so a run without extensions
 * reads exactly as it did before #4290.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** What the re-armable deadline did to a single run (Issue #4298). */
export interface ExtensionTelemetry {
  /** Extensions granted on this run. Zero when the first check refused. */
  granted: number;
  /** Seconds the grants added beyond {@link baseTimeoutSeconds}. */
  extendedSeconds: number;
  /** The configured budget the run started with. */
  baseTimeoutSeconds: number;
  /** Seconds from run start to the deadline finally armed. */
  finalDeadlineSeconds: number;
  /** Seconds the run actually ran for, start to kill (or to completion). */
  elapsedSeconds: number;
  /**
   * Why the last extension was refused — the policy's own reason string
   * (stale tool activity / tree unchanged / probe unknown / disabled).
   * Absent on a run that was never refused (it completed, or the silence
   * watchdog killed it).
   */
  refusalReason?: string;
}

/** Build the telemetry from the runner's clock and counters. */
export function buildExtensionTelemetry(args: {
  baseTimeoutSeconds: number;
  startMs: number;
  deadlineMs: number;
  nowMs: number;
  granted: number;
  refusalReason?: string;
}): ExtensionTelemetry {
  const finalDeadlineSeconds = Math.max(
    0,
    Math.round((args.deadlineMs - args.startMs) / 1000),
  );
  return {
    granted: args.granted,
    extendedSeconds: Math.max(
      0,
      finalDeadlineSeconds - args.baseTimeoutSeconds,
    ),
    baseTimeoutSeconds: args.baseTimeoutSeconds,
    finalDeadlineSeconds,
    elapsedSeconds: Math.max(0, Math.round((args.nowMs - args.startMs) / 1000)),
    ...(args.refusalReason ? { refusalReason: args.refusalReason } : {}),
  };
}

/**
 * Compact one-line history of what the deadline did — the shared phrase every
 * operator-facing surface embeds.
 *
 * Example: `base budget 3600s extended 4× by 2040s (final deadline 5640s);
 * last extension refused: working tree unchanged despite tool activity 31s
 * ago`.
 *
 * A run granted nothing names the deadline it died on anyway (Issue #768):
 * the kill log must state the deadline actually armed, not leave a reader to
 * infer it from the base budget.
 */
export function formatExtensionHistory(telemetry: ExtensionTelemetry): string {
  const {
    granted,
    extendedSeconds,
    baseTimeoutSeconds,
    finalDeadlineSeconds,
    refusalReason,
  } = telemetry;
  const history = granted > 0
    ? `base budget ${baseTimeoutSeconds}s extended ${granted}× by ` +
      `${extendedSeconds}s (final deadline ${finalDeadlineSeconds}s)`
    : `base budget ${baseTimeoutSeconds}s, no extension granted ` +
      `(deadline unchanged at ${finalDeadlineSeconds}s)`;
  return refusalReason
    ? `${history}; last extension refused: ${refusalReason}`
    : history;
}

/**
 * The operator-facing sentence for a timeout comment (Issue #768).
 *
 * Where {@link formatExtensionHistory} is the compact phrase the kill log
 * embeds, this spells the same run out for a human reading the issue: the
 * base timeout, the deadline actually armed at the kill, the elapsed
 * seconds, how many extensions were granted, and why the last check was
 * refused.
 *
 * Zero grants is itself a finding, so it reads differently from a run that
 * was extended and still ran out — and a run whose checks were never refused
 * says so rather than falling silent, which would be indistinguishable from
 * a message that simply lost the reason.
 */
export function formatTimeoutExtensionSummary(
  telemetry: ExtensionTelemetry,
): string {
  const {
    granted,
    extendedSeconds,
    baseTimeoutSeconds,
    finalDeadlineSeconds,
    elapsedSeconds,
    refusalReason,
  } = telemetry;
  const grants = granted > 0
    ? `${granted} extension${granted === 1 ? "" : "s"} granted ` +
      `(+${extendedSeconds}s)`
    : "no extensions granted";
  // An em dash after "no extensions granted" — the refusal is the finding
  // there; a semicolon after a grant count, where it is a closing detail.
  const joiner = granted > 0 ? "; " : " — ";
  const refusal = refusalReason
    ? `last check refused because ${refusalReason}`
    : "no extension check was refused";
  return `Progress extension: base timeout ${baseTimeoutSeconds}s, ` +
    `deadline armed at kill ${finalDeadlineSeconds}s, ` +
    `elapsed ${elapsedSeconds}s, ${grants}${joiner}${refusal}`;
}

/**
 * The watchdog kill log line.
 *
 * Without telemetry this is byte-identical to the pre-#4290 line, which is
 * what every non-issue caller (PR feedback, CI fix, planning, grill-me,
 * health checks) still gets.
 *
 * @param args.pid - The process tree being killed.
 * @param args.budgetSeconds - The deadline that expired, seconds from start.
 * @param args.extensions - Telemetry, when the feature was active.
 */
export function buildTimeoutKillMessage(args: {
  pid: number;
  budgetSeconds: number;
  extensions?: ExtensionTelemetry;
}): string {
  if (!args.extensions) {
    return `Claude timed out after ${args.budgetSeconds}s — killing process ` +
      `tree (PID ${args.pid})`;
  }
  return `Claude timed out after ${args.extensions.elapsedSeconds}s: ` +
    `${formatExtensionHistory(args.extensions)} — killing process tree ` +
    `(PID ${args.pid})`;
}

/**
 * The `failureReason` clause of the failure comment posted back to the issue.
 *
 * Without telemetry the wording is byte-identical to the pre-#4290 text, so a
 * run with the feature off reads exactly as it always did.
 *
 * @param claudeTimeoutSeconds - The configured budget.
 * @param extensions - Telemetry, when the feature was active.
 */
export function buildTimeoutFailureReason(
  claudeTimeoutSeconds: number,
  extensions?: ExtensionTelemetry,
): string {
  if (!extensions) {
    return `timed out after ${claudeTimeoutSeconds} seconds (${
      Math.floor(claudeTimeoutSeconds / 60)
    } minutes)`;
  }
  const { elapsedSeconds } = extensions;
  return `timed out after ${elapsedSeconds} seconds (${
    Math.floor(elapsedSeconds / 60)
  } minutes) — ${formatExtensionHistory(extensions)}`;
}
