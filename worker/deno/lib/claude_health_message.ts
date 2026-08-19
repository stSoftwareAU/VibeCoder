/**
 * Build accurate, evidence-based messages for failed Claude CLI health checks
 * (Issue #1980).
 *
 * Replaces the historical catch-all "Claude CLI is likely rate-limited or
 * unresponsive" message — which fired for every non-zero exit, empty stdout,
 * transient CLI bug, or unrecognised auth output — with messages that
 * include the real exit code and a short reason derived from the captured
 * stderr/stdout.
 *
 * Rate limiting is only claimed when stderr or stdout actually contains
 * rate-limit evidence (429, "rate limit", "credit", "quota", etc.). Auth
 * errors are detected via `isClaudeAuthError`. All other failures are
 * reported with the real exit code and a stderr preview.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { detectRateLimit, detectUsageLimit } from "./claude_executor.ts";
import { isClaudeAuthError } from "./claude_auth.ts";

/** Max stderr length included in messages and log output. */
export const STDERR_PREVIEW_MAX = 500;

/** Max stdout preview length included in log output. */
export const STDOUT_PREVIEW_MAX = 200;

/** Categorisation of a failed health-check probe. */
export type HealthFailureCategory =
  | "auth"
  | "rate-limit"
  | "usage-limit"
  | "empty-stdout"
  | "stderr"
  | "exit-code";

/** Summary of a failed health-check probe, suitable for logging + return. */
export interface HealthFailureSummary {
  category: HealthFailureCategory;
  /** Final human-readable message. Includes exit code and a short reason. */
  message: string;
  /** Truncated stderr preview (≤ STDERR_PREVIEW_MAX chars). */
  stderrPreview: string;
  /** Truncated stdout preview (≤ STDOUT_PREVIEW_MAX chars). */
  stdoutPreview: string;
}

/** Truncate a string to `max` chars, appending an ellipsis when cut. */
function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + "…";
}

/** Collapse internal whitespace to a single space for one-line summaries. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Build an accurate failure summary from the health-check probe result
 * (Issue #1980).
 *
 * Order of evidence checks (first match wins):
 *
 * 1. **Auth error** — `isClaudeAuthError` matches stderr or stdout.
 * 2. **Rate limit** — `detectRateLimit` returns a *primary* match on stderr
 *    or stdout. Secondary-only matches (e.g. the word "retry" appearing on
 *    its own) do not qualify, so the worker does not mis-attribute generic
 *    failures to rate limiting.
 * 3. **Empty stdout** — exit 0 but no usable output, or non-zero exit with
 *    blank stderr. Reported as the actual exit code plus "empty stdout".
 * 4. **Stderr present** — non-zero exit with stderr content. Reported as
 *    the exit code plus the stderr one-liner.
 * 5. **Fallback** — exit code only.
 */
export function summariseHealthFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
): HealthFailureSummary {
  const stderrPreview = truncate(stderr, STDERR_PREVIEW_MAX);
  const stdoutPreview = truncate(stdout, STDOUT_PREVIEW_MAX);

  // 1. Auth — preserve the existing specific branch.
  if (isClaudeAuthError(stderr) || isClaudeAuthError(stdout)) {
    return {
      category: "auth",
      message: "Claude CLI login required",
      stderrPreview,
      stdoutPreview,
    };
  }

  // 2a. Subscription usage limit (Issue #4315) — before the rate-limit
  // check: its wording ("hit your limit") only matches the rate-limit
  // regex as a weak secondary hint, and the response is different (pause
  // until reset, never re-probe every cycle).
  if (detectUsageLimit(stderr) || detectUsageLimit(stdout)) {
    const evidence = detectUsageLimit(stderr)
      ? oneLine(stderrPreview)
      : oneLine(stdoutPreview);
    return {
      category: "usage-limit",
      message:
        `Claude usage limit reached — subscription window (exit ${exitCode}): ${evidence}`,
      stderrPreview,
      stdoutPreview,
    };
  }

  // 2. Rate limit — only when there is real evidence (primary match).
  const stderrRate = detectRateLimit(stderr);
  const stdoutRate = detectRateLimit(stdout);
  if (stderrRate.isPrimary || stdoutRate.isPrimary) {
    const evidence = stderrRate.isPrimary
      ? oneLine(stderrPreview)
      : oneLine(stdoutPreview);
    return {
      category: "rate-limit",
      message: `Claude CLI rate-limited (exit ${exitCode}): ${evidence}`,
      stderrPreview,
      stdoutPreview,
    };
  }

  // 3. Empty stdout — exit 0 with nothing usable, or non-zero with blank
  // stderr and no stdout to report on.
  if (stdout.trim().length === 0 && stderr.trim().length === 0) {
    return {
      category: "empty-stdout",
      message:
        `Claude CLI exited ${exitCode} with empty stdout and empty stderr`,
      stderrPreview,
      stdoutPreview,
    };
  }

  if (stdout.trim().length === 0 && stderr.trim().length > 0) {
    return {
      category: "stderr",
      message: `Claude CLI exited ${exitCode} with empty stdout: ${
        oneLine(stderrPreview)
      }`,
      stderrPreview,
      stdoutPreview,
    };
  }

  // 4. Stderr present — surface it.
  if (stderr.trim().length > 0) {
    return {
      category: "stderr",
      message: `Claude CLI exited ${exitCode}: ${oneLine(stderrPreview)}`,
      stderrPreview,
      stdoutPreview,
    };
  }

  // 5. Fallback — exit code with stdout preview.
  return {
    category: "exit-code",
    message: `Claude CLI exited ${exitCode} with unrecognised output: ${
      oneLine(stdoutPreview)
    }`,
    stderrPreview,
    stdoutPreview,
  };
}
