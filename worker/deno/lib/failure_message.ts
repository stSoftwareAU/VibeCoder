/**
 * Detailed failure message construction with diagnostic context.
 *
 * Issue #1188: Enhance failure messages to include elapsed time, clarity
 * status, output size, timeout details, and last output snippet.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  describeMemoryPressure,
  type MemoryPressureReading,
} from "./memory_pressure.ts";
import { redactedHead, type RedactedText } from "./redacted_text.ts";

/** Diagnostic context for enriching failure messages. */
export interface FailureDiagnosticContext {
  elapsedSeconds?: number;
  clarityStatus?: string;
  timedOut?: boolean;
  outputSize?: number;
  timeoutSeconds?: number;
  /**
   * The tail of the agent's own stdout, which this message embeds verbatim in a
   * world-readable issue comment (`label_failure.ts`).
   *
   * Typed {@link RedactedText} rather than `string` (Issue #1217): the tail is
   * produced by cutting attacker-influenceable output to a budget, and cutting
   * before redacting splits a credential so the sink's later pass matches
   * nothing. Only `redactedTail()` and its siblings can mint the brand, and they
   * redact the whole text first — so `claudeOutput.slice(-500)` no longer
   * compiles here, and the ordering is held by `deno check` rather than by every
   * call site remembering.
   */
  lastOutputSnippet?: RedactedText;
  baselineQualityPassed?: boolean;
  /**
   * The child's true exit status (Issue #4202): named in the diagnostics so
   * a SIGKILL (137), a self-exited 124 and a genuine watchdog timeout stay
   * distinguishable instead of all reading as "timed out".
   */
  rawExitCode?: number;
  /** Which watchdog fired, when this genuinely was a timeout (Issue #1825). */
  timeoutReason?: string;
  /**
   * Seconds the hard watchdog fired past its budget (Issue #4254) — a
   * starved VM delays timers, and the lateness is evidence, not noise.
   */
  watchdogLateSeconds?: number;
  /**
   * Seconds the runner waited after the kill before abandoning the wait
   * (Issue #4254). When present, the exit status was synthesised.
   */
  killIncompleteSeconds?: number;
  /**
   * The memory-pressure reading taken at a SIGKILL (Issue #4374) — the OOM
   * evidence the release comment and auto-filed issue carry.
   */
  memoryPressureAtKill?: MemoryPressureReading;
  /**
   * Bounded kill-time evidence (Issue #4382): top processes by RSS at the
   * kill and any kernel OOM lines — rendered as a collapsible block.
   */
  killDiagnostics?: string;
}

const MAX_SNIPPET_LENGTH = 500;
/** Cap on the kill-time process table carried in a message (Issue #4382). */
const MAX_KILL_DIAGNOSTICS_LENGTH = 2000;

/**
 * Format a failure message with diagnostic context.
 *
 * Takes a simple failure reason and enriches it with available diagnostic
 * information: elapsed time, timeout/output details, clarity status,
 * baseline quality context, and a truncated output snippet.
 */
export function formatDetailedFailureMessage(
  reason: string,
  context: FailureDiagnosticContext,
): string {
  const parts: string[] = [reason];
  const diagnostics: string[] = [];

  if (context.elapsedSeconds !== undefined) {
    diagnostics.push(`Elapsed: ${context.elapsedSeconds}s`);
  }

  if (context.timedOut) {
    if (context.outputSize === undefined || context.outputSize === 0) {
      diagnostics.push("Output: zero (no output captured before timeout)");
    } else {
      diagnostics.push(
        `Output: partial (${context.outputSize} characters captured before timeout)`,
      );
    }
    if (context.timeoutSeconds !== undefined) {
      diagnostics.push(`Timeout: ${context.timeoutSeconds}s`);
    }
    if (context.timeoutReason) {
      const late = context.watchdogLateSeconds;
      diagnostics.push(
        `Watchdog: ${context.timeoutReason}` +
          (late !== undefined && late > 0
            ? ` (fired ${late}s late — starved timers, Issue #4254)`
            : ""),
      );
    }
    if (context.killIncompleteSeconds !== undefined) {
      diagnostics.push(
        `Kill: did not complete within ${context.killIncompleteSeconds}s — ` +
          `wait abandoned, exit status synthesised (Issue #4254)`,
      );
    }
  }

  if (context.rawExitCode !== undefined) {
    const signalNote = context.rawExitCode === 137
      ? " (SIGKILL)"
      : context.rawExitCode === 143
      ? " (SIGTERM)"
      : "";
    diagnostics.push(`Raw exit code: ${context.rawExitCode}${signalNote}`);
  }

  if (context.memoryPressureAtKill) {
    diagnostics.push(
      `Memory pressure at kill: ${
        describeMemoryPressure(context.memoryPressureAtKill)
      }`,
    );
  }

  if (context.clarityStatus) {
    const display = formatClarityDisplay(context.clarityStatus);
    diagnostics.push(`Clarity: ${display}`);
  }

  if (context.baselineQualityPassed === false) {
    diagnostics.push(
      "Note: quality checks had pre-existing failures before this run",
    );
  }

  if (diagnostics.length > 0) {
    parts.push("");
    parts.push("### Diagnostics");
    for (const line of diagnostics) {
      parts.push(`- ${line}`);
    }
  }

  if (context.lastOutputSnippet && context.lastOutputSnippet.length > 0) {
    const snippet = context.lastOutputSnippet.length > MAX_SNIPPET_LENGTH
      ? `…${context.lastOutputSnippet.slice(-MAX_SNIPPET_LENGTH)}`
      : context.lastOutputSnippet;
    parts.push("");
    parts.push("<details>");
    parts.push("<summary>Last output from Claude (click to expand)</summary>");
    parts.push("");
    parts.push("```");
    parts.push(snippet);
    parts.push("```");
    parts.push("");
    parts.push("</details>");
  }

  if (context.killDiagnostics && context.killDiagnostics.length > 0) {
    parts.push("");
    parts.push("<details>");
    parts.push("<summary>Processes at the kill (click to expand)</summary>");
    parts.push("");
    parts.push("```");
    // The `ps` table carries every process's argv, so a token handed to a child
    // on its command line lands here. Redact the whole table before the cap
    // (Issue #1217): capping first would split the token into a fragment that
    // no signature rule matches at the sink.
    parts.push(
      redactedHead(context.killDiagnostics, MAX_KILL_DIAGNOSTICS_LENGTH),
    );
    parts.push("```");
    parts.push("");
    parts.push("</details>");
  }

  return parts.join("\n");
}

function formatClarityDisplay(status: string): string {
  switch (status) {
    case "assessed_clear":
      return "assessed as clear";
    case "skipped":
      return "skipped (simple task)";
    case "not_assessed":
      return "not assessed";
    default:
      return status;
  }
}
