/**
 * Context-aware failure diagnosis for issue failure comments (Issue #398, #909).
 *
 * Replaces generic "Why this might be happening" with category-specific advice
 * based on the actual failure message content.
 *
 * Migrated from worker/shared/failure_diagnosis.sh (Issue #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertNever } from "./assert_never.ts";

/** Failure category string — returned by detectFailureCategory(). */
export type FailureCategory =
  | "timeout"
  | "rate_limit"
  | "zero_output"
  /** SIGKILLed without a watchdog firing — possible VM OOM (Issue #4202). */
  | "killed"
  | "quality_check"
  | "push_failure"
  | "no_changes"
  | "evidence_missing"
  | "internal_error"
  | "missing_tools"
  | "unknown";

/** Clarity status — whether the issue was assessed for clarity before failure. */
export type ClarityStatus = "assessed_clear" | "skipped" | "not_assessed";

/** User-facing display name for a failure category (kebab-case). */
export type CategoryDisplay =
  | "timeout"
  | "rate-limit"
  | "no-output"
  | "killed"
  | "quality-failure"
  | "missing-tools"
  | "infrastructure-error"
  | "task-not-understood"
  | "unknown";

/** Parsed diagnostic context for zero-output failures (Issue #533). */
export interface DiagnosticContext {
  healthCheck?: string;
  clarity?: string;
  elapsedSeconds?: string;
  noOutputTimeout?: string;
  claudeTimeout?: string;
  retryCount?: string;
  maxRetries?: string;
  /**
   * Extension history from the re-armable hard deadline (Issue #4298). Present
   * only when the feature was active for the run; without it the diagnosis
   * reads exactly as it did before #4290.
   */
  extensionsGranted?: string;
  extendedSeconds?: string;
  finalDeadlineSeconds?: string;
  extensionRefused?: string;
}

/**
 * Analyse a failure message and return a category.
 *
 * Examines the failure message text for known patterns and returns a category
 * string that can be used to select appropriate diagnosis messaging.
 *
 * Order matters: more specific patterns are checked before general ones.
 */
export function detectFailureCategory(failureMessage: string): FailureCategory {
  if (!failureMessage) return "unknown";

  // SIGKILL first (Issue #4202): a killed run's message must never be read as
  // a timeout — that mislabelling is precisely what this category exists to
  // end. The signal name is the discriminator because it only appears when
  // the runner classified a genuine kill.
  if (failureMessage.includes("SIGKILL")) {
    return "killed";
  }

  // Timeout with zero output is zero_output, not timeout
  if (
    failureMessage.includes("timed out") || failureMessage.includes("timeout")
  ) {
    if (
      failureMessage.includes("zero output") ||
      failureMessage.includes("No output captured")
    ) {
      return "zero_output";
    }
    return "timeout";
  }

  // Case-insensitive, and the subscription usage window counts too (Issue
  // #4315): "Rate limit …" / "Claude usage limit reached" escaping here
  // landed in `unknown`, which is not infrastructure — the issue was then
  // blamed and labelled failed for an account-level cap.
  const lowered = failureMessage.toLowerCase();
  if (
    lowered.includes("rate limit") ||
    lowered.includes("rate-limited") ||
    lowered.includes("usage limit")
  ) {
    return "rate_limit";
  }

  if (
    failureMessage.includes("zero output") ||
    failureMessage.includes("No output captured")
  ) {
    return "zero_output";
  }

  if (
    failureMessage.includes("not available in the worker environment") ||
    failureMessage.includes("not installed or not in PATH") ||
    failureMessage.includes("command not found")
  ) {
    return "missing_tools";
  }

  if (
    failureMessage.includes("quality.sh") ||
    failureMessage.includes("quality checks") ||
    failureMessage.includes("Quality checks")
  ) {
    return "quality_check";
  }

  if (
    failureMessage.includes("Git push failed") ||
    failureMessage.includes("git push failed")
  ) {
    return "push_failure";
  }

  if (
    failureMessage.includes("screenshot evidence") ||
    failureMessage.includes("Screenshot")
  ) {
    return "evidence_missing";
  }

  if (failureMessage.includes("without making any changes")) {
    return "no_changes";
  }

  // Internal/CLI errors: check for error patterns, stack traces
  if (
    failureMessage.includes("Error:") ||
    failureMessage.includes("at Object.") ||
    failureMessage.includes("at Module.") ||
    failureMessage.includes("ENOENT") ||
    failureMessage.includes("SIGABRT")
  ) {
    return "internal_error";
  }

  return "unknown";
}

/** Every valid {@link FailureCategory} value — the source of truth for {@link normaliseFailureCategory}. */
const VALID_FAILURE_CATEGORIES: ReadonlySet<string> = new Set<FailureCategory>([
  "killed",
  "timeout",
  "rate_limit",
  "zero_output",
  "quality_check",
  "push_failure",
  "no_changes",
  "evidence_missing",
  "internal_error",
  "missing_tools",
  "unknown",
]);

/**
 * Normalise an arbitrary string into a known {@link FailureCategory}.
 *
 * Callers that receive an un-validated category string (e.g. a CLI argument)
 * must pass it through here before handing it to the now-exhaustive
 * {@link getFailureDiagnosis} / {@link getFailureDiagnosisOneliner}. Any value
 * outside the union maps to `"unknown"`, preserving the previous graceful
 * fallback rather than throwing (Issue #2794).
 */
export function normaliseFailureCategory(value: string): FailureCategory {
  return VALID_FAILURE_CATEGORIES.has(value)
    ? value as FailureCategory
    : "unknown";
}

/**
 * Check if a failure category is an infrastructure/transient issue.
 *
 * Infrastructure failures are caused by environment/tooling problems, NOT by
 * the issue being too hard or unclear. These should be retried more aggressively
 * rather than permanently failing the issue.
 *
 * Issue #387 — Self-healing for transient infrastructure failures.
 */
export function isInfrastructureFailure(category: FailureCategory): boolean {
  switch (category) {
    case "zero_output":
    case "rate_limit":
    case "internal_error":
    case "push_failure":
    case "missing_tools":
    // A kill (SIGKILL, typically the VM's OOM killer under transient memory
    // pressure) is an environment failure, not a property of the issue —
    // one bounded retry is allowed (Issue #4202).
    case "killed":
      return true;
    default:
      return false;
  }
}

/**
 * Map internal category to user-facing display name.
 *
 * Converts internal category identifiers (e.g. zero_output) to human-readable
 * display names (e.g. no-output) for use in failure comment category tags.
 */
export function getFailureCategoryDisplay(
  category: FailureCategory,
): CategoryDisplay {
  switch (category) {
    case "timeout":
      return "timeout";
    case "rate_limit":
      return "rate-limit";
    case "zero_output":
      return "no-output";
    case "killed":
      return "killed";
    case "quality_check":
      return "quality-failure";
    case "missing_tools":
      return "missing-tools";
    case "push_failure":
    case "evidence_missing":
    case "internal_error":
      return "infrastructure-error";
    case "no_changes":
      return "task-not-understood";
    case "unknown":
      return "unknown";
    default:
      return assertNever(category);
  }
}

/**
 * Check if clarity was assessed or skipped (i.e. not "not_assessed").
 *
 * Returns true if clarity was assessed as CLEAR or skipped (meaning the
 * "may need more detail" suggestion is inappropriate).
 */
function clarityWasAssessed(clarityStatus: ClarityStatus): boolean {
  return clarityStatus === "assessed_clear" || clarityStatus === "skipped";
}

/**
 * Parse semicolon-separated key=value diagnostic context string.
 *
 * Issue #533 — Embed diagnostic context in zero-output failure comments.
 */
export function parseDiagnosticContext(contextStr: string): DiagnosticContext {
  const result: DiagnosticContext = {};
  if (!contextStr) return result;

  for (const pair of contextStr.split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const key = pair.substring(0, eqIdx);
    const value = pair.substring(eqIdx + 1);
    switch (key) {
      case "health_check":
        result.healthCheck = value;
        break;
      case "clarity":
        result.clarity = value;
        break;
      case "elapsed_seconds":
        result.elapsedSeconds = value;
        break;
      case "no_output_timeout":
        result.noOutputTimeout = value;
        break;
      case "claude_timeout":
        result.claudeTimeout = value;
        break;
      case "retry_count":
        result.retryCount = value;
        break;
      case "max_retries":
        result.maxRetries = value;
        break;
      // Extension history (Issue #4298).
      case "extensions_granted":
        result.extensionsGranted = value;
        break;
      case "extended_seconds":
        result.extendedSeconds = value;
        break;
      case "final_deadline_seconds":
        result.finalDeadlineSeconds = value;
        break;
      case "extension_refused":
        result.extensionRefused = value;
        break;
    }
  }
  return result;
}

/**
 * Format diagnostic context for zero-output failures.
 *
 * Returns human-readable diagnostic lines for inclusion in failure comments.
 *
 * Issue #533 — Embed diagnostic context in zero-output failure comments.
 */
/**
 * Render the re-armable deadline's history for the diagnosis (Issue #4298).
 *
 * Returns `""` when the run carried no extension telemetry, so a run with the
 * feature disabled produces the pre-#4290 wording byte for byte.
 */
function formatExtensionHistory(ctx: DiagnosticContext): string {
  if (ctx.extensionsGranted === undefined) return "";
  const granted = Number(ctx.extensionsGranted);
  const history = Number.isFinite(granted) && granted > 0
    ? `, extended ${granted}× by ${ctx.extendedSeconds ?? "?"}s to a final ` +
      `deadline of ${ctx.finalDeadlineSeconds ?? "?"}s`
    : ", no extension granted";
  return ctx.extensionRefused
    ? `${history}; last extension refused: ${ctx.extensionRefused}`
    : history;
}

export function formatZeroOutputDiagnostics(diagnosticContext: string): string {
  if (!diagnosticContext) return "";

  const ctx = parseDiagnosticContext(diagnosticContext);
  const lines: string[] = [];

  // Format health check and clarity status line
  const parts: string[] = [];
  if (ctx.healthCheck) {
    const healthDisplay = ctx.healthCheck === "passed"
      ? "passed \u2713"
      : ctx.healthCheck;
    parts.push(`Health check: ${healthDisplay}`);
  }
  if (ctx.clarity) {
    let clarityDisplay: string;
    switch (ctx.clarity) {
      case "assessed_clear":
        clarityDisplay = "CLEAR \u2713";
        break;
      case "skipped":
        clarityDisplay = "skipped (simple task)";
        break;
      default:
        clarityDisplay = ctx.clarity;
    }
    parts.push(`Clarity assessment: ${clarityDisplay}`);
  }
  if (parts.length > 0) {
    lines.push(`- ${parts.join(" | ")}`);
  }

  // Format runtime line
  if (ctx.elapsedSeconds) {
    let timeoutInfo = "";
    if (ctx.noOutputTimeout && ctx.claudeTimeout) {
      // Explain the deadline the run actually died on (Issue #4298): quoting
      // the configured `claudeTimeout` alone is a lie once the re-armable
      // deadline (#4290) has moved it.
      timeoutInfo = ` (no-output timeout: ${ctx.noOutputTimeout}s, hard ` +
        `timeout: ${ctx.claudeTimeout}s${formatExtensionHistory(ctx)})`;
    }
    lines.push(
      `- Claude ran for ${ctx.elapsedSeconds}s with zero output before being terminated${timeoutInfo}`,
    );
  }

  // Format retry count line
  if (ctx.retryCount && ctx.maxRetries) {
    lines.push(
      `- This has happened ${ctx.retryCount}/${ctx.maxRetries} times \u2014 likely a transient environment issue`,
    );
  }

  return lines.join("\n");
}

/**
 * Return category-specific diagnosis text.
 *
 * Given a failure category (from detectFailureCategory), returns a
 * human-readable diagnosis explaining why the failure likely occurred.
 *
 * When clarityStatus indicates the issue was already assessed as CLEAR or
 * skipped (simple issue), suggestions about needing "more detail" are omitted
 * because the clarity pipeline already validated the description (Issue #400).
 *
 * For zero_output failures, if diagnosticContext is provided, it is formatted
 * into actionable diagnostic lines instead of generic advice (Issue #533).
 */
export function getFailureDiagnosis(
  category: FailureCategory,
  clarityStatus: ClarityStatus = "not_assessed",
  diagnosticContext: string = "",
): string {
  switch (category) {
    case "timeout":
      return `- Claude ran out of time before completing the task
- The task may need to be broken into smaller pieces
- Consider simplifying the issue scope or splitting it into sub-issues`;

    case "rate_limit":
      return `- Claude was rate-limited during processing
- This is a transient infrastructure issue, not related to issue complexity
- The issue will be retried automatically on the next scan`;

    case "killed":
      return `- The agent process was killed (SIGKILL) without any worker watchdog firing
- The most common cause is the VM's out-of-memory killer under memory pressure — a SIGKILLed process prints nothing, so no memory evidence appears in the output
- This is an infrastructure failure, not related to the issue content; the worker retries once automatically
- If it recurs, raise the container VM memory (VIBE_CONTAINER_MEMORY) or reduce concurrent load on the host`;

    case "zero_output": {
      const baseLine =
        "- Claude produced no output, which typically indicates a startup failure or environment issue\n- This is not related to the issue complexity or description quality";
      const diagLines = formatZeroOutputDiagnostics(diagnosticContext);
      if (diagLines) {
        return `${baseLine}\n${diagLines}`;
      }
      return `${baseLine}\n- This is a transient infrastructure issue \u2014 the worker will retry automatically`;
    }

    case "quality_check":
      return `- Changes were made but failed the quality gate (\`./quality.sh\`)
- One or more tests, lint checks, or type checks did not pass
- Review the failure details above for specific quality check output`;

    case "missing_tools":
      return `- The quality gate (\`./quality.sh\`) requires tools that are not installed on the worker machine
- This is an **environment issue** \u2014 Claude cannot install system-level tools
- A developer must either install the missing tools on the worker, or update \`quality.sh\` to gracefully skip checks when tools are unavailable
- Retrying will produce the same result until the environment is fixed`;

    case "push_failure":
      return `- Git push failed due to a permissions, network, or branch protection issue
- This is not related to the issue content or complexity
- Check repository access permissions and network connectivity`;

    case "no_changes":
      if (clarityWasAssessed(clarityStatus)) {
        return `- Claude completed but made no changes to the codebase
- The issue was assessed as clear, so this is likely a tooling or comprehension issue rather than a description problem
- Consider breaking the task into smaller pieces or adding specific file paths and acceptance criteria`;
      }
      return `- Claude completed but made no changes to the codebase
- The issue description may need more detail about what changes are expected
- Consider adding specific file paths, expected behaviour, or acceptance criteria`;

    case "evidence_missing":
      return `- The PR was blocked because screenshot evidence is required for UI changes
- This is a process requirement, not related to issue complexity
- The issue will be retried with explicit screenshot instructions`;

    case "internal_error":
      return `- An internal error occurred in the worker tooling or Claude CLI
- This is not related to the issue complexity or description quality
- This is a transient infrastructure issue \u2014 the worker will retry automatically`;

    case "unknown":
      if (clarityWasAssessed(clarityStatus)) {
        return `- The failure cause could not be automatically determined
- The issue was assessed as clear, so the description is unlikely to be the problem
- Review the failure details above for more context`;
      }
      return `- The failure cause could not be automatically determined
- Review the failure details above for more context
- Consider simplifying the issue or adding more detail to the description`;

    default:
      // Exhaustiveness guard: a new FailureCategory must get its own arm
      // rather than silently mapping to the "unknown" path (Issue #2794).
      // Callers passing un-validated input must normalise via
      // normaliseFailureCategory() first.
      return assertNever(category);
  }
}

/**
 * Return a brief one-line cause summary.
 *
 * Used by mark_issue_as_failed_once() to add a brief indication of the
 * likely cause without the full multi-line diagnosis.
 */
export function getFailureDiagnosisOneliner(
  category: FailureCategory,
  clarityStatus: ClarityStatus = "not_assessed",
): string {
  switch (category) {
    case "timeout":
      return "Likely cause: Claude ran out of time.";
    case "rate_limit":
      return "Likely cause: Claude was rate-limited (transient infrastructure issue).";
    case "zero_output":
      return "Likely cause: Claude produced no output (startup or environment issue).";
    case "killed":
      return "Likely cause: the agent was killed (SIGKILL) — possibly the VM's out-of-memory killer.";
    case "quality_check":
      return "Likely cause: changes failed quality checks.";
    case "missing_tools":
      return "Likely cause: required tools (e.g., npm, node) not installed on worker machine.";
    case "push_failure":
      return "Likely cause: git push failed (permissions or network issue).";
    case "no_changes":
      if (clarityWasAssessed(clarityStatus)) {
        return "Likely cause: Claude could not determine what changes to make (issue was assessed as clear).";
      }
      return "Likely cause: Claude could not determine what changes to make.";
    case "evidence_missing":
      return "Likely cause: screenshot evidence required but not provided.";
    case "internal_error":
      return "Likely cause: internal tooling or CLI error (not related to issue complexity).";
    case "unknown":
      return "Likely cause: could not be automatically determined \u2014 see details above.";
    default:
      // Exhaustiveness guard (Issue #2794): a new FailureCategory must be
      // handled explicitly. Callers passing un-validated input must
      // normalise via normaliseFailureCategory() first.
      return assertNever(category);
  }
}

/**
 * Extract the most relevant error lines from failure output.
 *
 * Scans the input text for lines matching common error patterns and returns
 * up to 10 key lines for prominent display in failure comments.
 *
 * Issue #733 — Surface error details prominently in failure comments.
 */
export function extractKeyErrorLines(text: string): string {
  if (!text) return "";

  const errorPattern =
    /(^|\s)(Error:|error:|fatal:|FAIL\s|FAILED|not ok \d)|\d+ tests? failed|error TS\d+/;

  const lines = text.split("\n");
  const matches: string[] = [];

  for (const line of lines) {
    if (matches.length >= 10) break;
    if (errorPattern.test(line)) {
      matches.push(line);
    }
  }

  return matches.join("\n");
}
