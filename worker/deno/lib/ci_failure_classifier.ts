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
 *   2. history-rewrite-required
 *                         (secret scanners judge the COMMIT RANGE, not the
 *                          working tree — see below. Ranked above code-fix
 *                          because a gitleaks log carries "error:"-shaped text
 *                          that would otherwise route it to a fix that cannot
 *                          work).
 *   3. code-fix-required  (lint/check tool name match or actionable code-fix
 *                          patterns — semgrep, eslint, ReDoS, type errors, etc.).
 *   4. timing             (often a downstream symptom of #1 or a slow test).
 *   5. unknown            (fallback — caller should attempt a code fix).
 */

/** Top-level routing categories. */
export type CiFailureCategory =
  | "code-fix-required"
  /**
   * The verdict is a property of the branch's commit range, not its working
   * tree, so no follow-up commit can clear it (Issue #630).
   *
   * Secret scanners run with `fetch-depth: 0` and scan every commit in the
   * branch. Correcting the file and committing the correction leaves the
   * original commit — and the secret in its diff — exactly where it was, so
   * the check fails again, identically, naming a commit that has already been
   * superseded. A fix loop that does not know this retries forever and ends
   * at `needs-human`, which is itself a workflow failure.
   *
   * The fix is to correct the content AND rebuild the branch so the finding
   * exists in no commit.
   */
  | "history-rewrite-required"
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

/**
 * Check names whose verdict covers the commit range (Issue #630).
 *
 * Matched as substrings of the lower-cased check name, so "gitleaks",
 * "Full-history secrets sweep (gitleaks + trufflehog)" and a repo's own
 * "secret-scan / pr" all land here.
 */
const HISTORY_REWRITE_CHECK_NAMES: ReadonlyArray<string> = [
  "gitleaks",
  "trufflehog",
  "secrets sweep",
  "secret scan",
  "secret-scan",
  "detect-secrets",
  "ggshield",
];

/**
 * Text that identifies a range-scoped secret finding even when the check is
 * named something this table has never seen — a repository is free to call
 * its scanner "security". The fingerprint line is the strongest signal: its
 * `<sha>:<file>:<rule>:<line>` shape names the commit the finding lives in,
 * which is precisely what makes it unfixable by a further commit.
 */
const HISTORY_REWRITE_TEXT_PATTERNS: ReadonlyArray<string> = [
  "leaks found",
  "secrets detected",
  "verified secret",
];

/** Fingerprint lines: `Fingerprint: <40-hex>:<path>:<rule>:<line>`. */
const HISTORY_REWRITE_REGEX_PATTERNS: ReadonlyArray<RegExp> = [
  /fingerprint:\s*[0-9a-f]{40}:/i,
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

  // ---- History-rewrite signals (Issue #630) ----
  // Deliberately ahead of code-fix: a gitleaks log contains "error:"-shaped
  // text, and routing it to a code fix produces a loop that cannot terminate.
  const matchedHistoryCheck = HISTORY_REWRITE_CHECK_NAMES.find((p) =>
    lowerName.includes(p)
  );
  const matchedHistoryText = HISTORY_REWRITE_TEXT_PATTERNS.filter((p) =>
    haystack.includes(p)
  );
  const matchedHistoryRegex = HISTORY_REWRITE_REGEX_PATTERNS.filter((re) =>
    re.test(haystack)
  );
  if (
    matchedHistoryCheck !== undefined || matchedHistoryText.length > 0 ||
    matchedHistoryRegex.length > 0
  ) {
    return {
      category: "history-rewrite-required",
      reason: matchedHistoryCheck !== undefined
        ? `secret scan '${matchedHistoryCheck}' judges the commit range, not the working tree`
        : `secret finding in the commit range: ${
          matchedHistoryText[0] ?? "commit fingerprint"
        }`,
      signals: [
        `check:${lowerName}`,
        ...matchedHistoryText.map((m) => `text:${m}`),
        ...matchedHistoryRegex.map((re) => `regex:${re.source}`),
      ],
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
