/**
 * CI failure classifier (Issue #1690).
 *
 * Categorises a failing CI check into one of four buckets so downstream
 * code can route the failure intelligently instead of treating every
 * failure identically.
 *
 * The function is pure and side-effect free — no shell, no network,
 * no fs. Importing this module requires no Deno permissions.
 *
 * Routing precedence (when multiple categories' signals are present):
 *   1. infrastructure     (specific external-failure patterns are unambiguous —
 *                          e.g. ETIMEDOUT, ENOTFOUND, 5xx — and runtime "Error:"
 *                          prefixes from such failures should not be misread as
 *                          lint findings).
 *   2. code-fix-required  (lint/check tool name match or actionable code-fix
 *                          patterns — semgrep, eslint, ReDoS, type errors, etc.).
 *   3. timing             (often a downstream symptom of #1 or a slow test).
 *   4. unknown            (fallback — caller should attempt a code fix).
 */

/** Top-level routing categories. */
export type CiFailureCategory =
  | "code-fix-required"
  | "timing"
  | "infrastructure"
  | "unknown";

/** Result of classifying a CI failure. */
export interface CiFailureClassification {
  /** Routing category. */
  category: CiFailureCategory;
  /** Short human-readable explanation, e.g. "semgrep finding". */
  reason: string;
  /** Matched signals — check name plus log/annotation patterns. */
  signals: string[];
}

/** Annotation shape — a subset of the GitHub check annotation payload. */
export interface CiAnnotation {
  message?: string;
  title?: string;
  path?: string;
}

// -----------------------------------------------------------------------------
// Pattern tables — exhaustive, ordered for readability not precedence.
// -----------------------------------------------------------------------------

/** Substring matches against the lower-cased check name. */
const CODE_FIX_CHECK_NAMES: ReadonlyArray<string> = [
  "semgrep",
  "codeql",
  "eslint",
  "deno lint",
  "deno check",
  "deno fmt",
  "shellcheck",
  "markdownlint",
  "tsc",
  "type-check",
  "typecheck",
];

/** Substring matches against any annotation/log text (case-insensitive). */
const CODE_FIX_TEXT_PATTERNS: ReadonlyArray<string> = [
  "blocking code rules fired",
  "detect-non-literal-regexp",
  "redos",
  "syntaxerror",
  "type error",
  "ts2304",
  "ts2322",
  "ts2345",
  "assertionerror",
  "expected:",
  "assertion failed",
];

/** Code-fix patterns that need a regex (anchored or with word boundaries). */
const CODE_FIX_REGEX_PATTERNS: ReadonlyArray<RegExp> = [
  // "error:" / "warning:" but not embedded in "no error:" type prose —
  // require start-of-line or whitespace before to reduce false positives.
  /(^|\s)error:/i,
  /(^|\s)warning:/i,
];

const TIMING_TEXT_PATTERNS: ReadonlyArray<string> = [
  "timed out",
  "timeout",
  "exceeded the maximum execution time",
  "the job was cancelled",
  "operation was canceled",
  "test timed out",
  "step timed out",
  "deadline exceeded",
];

const INFRA_TEXT_PATTERNS: ReadonlyArray<string> = [
  "connect etimedout",
  "getaddrinfo enotfound",
  "getaddrinfo eai_again",
  "econnrefused",
  "econnreset",
  "429 too many requests",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway timeout",
  "runner lost connection",
  "the runner has received a shutdown signal",
  "lost communication with the server",
  "the self-hosted runner",
];

// -----------------------------------------------------------------------------
// Classification
// -----------------------------------------------------------------------------

/**
 * Classify a failing CI check into a routing category.
 *
 * @param checkName - GitHub check run name (e.g. "semgrep", "test").
 * @param annotations - Check annotations attached to the run.
 * @param logExcerpt - Optional excerpt of the job log.
 * @returns Classification with category, human-readable reason, and matched signals.
 */
export function classifyCiFailure(
  checkName: string,
  annotations: ReadonlyArray<CiAnnotation>,
  logExcerpt?: string,
): CiFailureClassification {
  const lowerName = checkName.toLowerCase();
  const haystack = buildHaystack(annotations, logExcerpt);

  // ---- Infrastructure signals (checked first — patterns are unambiguous) ----
  const matchedInfra = INFRA_TEXT_PATTERNS.filter((p) => haystack.includes(p));
  if (matchedInfra.length > 0) {
    return {
      category: "infrastructure",
      reason: `infrastructure failure: ${matchedInfra[0]}`,
      signals: [`check:${lowerName}`, ...matchedInfra.map((m) => `text:${m}`)],
    };
  }

  // ---- Code-fix-required signals ----
  const signals: string[] = [];

  const matchedCodeCheck = CODE_FIX_CHECK_NAMES.find((p) =>
    lowerName.includes(p)
  );
  if (matchedCodeCheck) {
    signals.push(`check:${lowerName}`);
  }

  const matchedCodeText = CODE_FIX_TEXT_PATTERNS.filter((p) =>
    haystack.includes(p)
  );
  for (const m of matchedCodeText) {
    signals.push(`text:${m}`);
  }

  const matchedCodeRegex = CODE_FIX_REGEX_PATTERNS.filter((re) =>
    re.test(haystack)
  );
  for (const re of matchedCodeRegex) {
    signals.push(`regex:${re.source}`);
  }

  const codeFixHit = matchedCodeCheck !== undefined ||
    matchedCodeText.length > 0 ||
    matchedCodeRegex.length > 0;

  if (codeFixHit) {
    return {
      category: "code-fix-required",
      reason: buildCodeFixReason(matchedCodeCheck, matchedCodeText),
      signals,
    };
  }

  // ---- Timing signals ----
  const matchedTiming = TIMING_TEXT_PATTERNS.filter((p) =>
    haystack.includes(p)
  );
  if (matchedTiming.length > 0) {
    return {
      category: "timing",
      reason: `timing failure: ${matchedTiming[0]}`,
      signals: [`check:${lowerName}`, ...matchedTiming.map((m) => `text:${m}`)],
    };
  }

  // ---- Fallback ----
  return {
    category: "unknown",
    reason: `no recognised pattern in check '${checkName}' or its annotations`,
    signals: [`check:${lowerName}`],
  };
}

/**
 * Concatenate all annotation text and the log excerpt into a single
 * lower-cased haystack for substring/regex matching.
 */
function buildHaystack(
  annotations: ReadonlyArray<CiAnnotation>,
  logExcerpt: string | undefined,
): string {
  const parts: string[] = [];
  for (const a of annotations) {
    if (a.message) parts.push(a.message);
    if (a.title) parts.push(a.title);
    if (a.path) parts.push(a.path);
  }
  if (logExcerpt) parts.push(logExcerpt);
  return parts.join("\n").toLowerCase();
}

/** Construct a short human-readable reason for a code-fix-required match. */
function buildCodeFixReason(
  matchedCheckName: string | undefined,
  matchedTextPatterns: ReadonlyArray<string>,
): string {
  if (matchedCheckName && matchedTextPatterns.length > 0) {
    return `${matchedCheckName} finding (${matchedTextPatterns[0]})`;
  }
  if (matchedCheckName) {
    return `${matchedCheckName} finding`;
  }
  if (matchedTextPatterns.length > 0) {
    return `code-fix pattern matched: ${matchedTextPatterns[0]}`;
  }
  return "code-fix pattern matched";
}
