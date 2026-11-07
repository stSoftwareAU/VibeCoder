/**
 * Compare a pull request's CI failure with the failure of the same check on
 * its base branch (Issue #4680).
 *
 * The base-branch deferral accepts a `Depends on` claim only when the base run
 * is red for the same check. Conclusion alone is not enough: a base run that
 * is red for an unrelated reason must not defer the pull request. This module
 * reads the base run's log and compares all usable pull request failure lines.
 *
 * Every verdict is conservative: when either side cannot be read or compared
 * the result is `unreadable`, never `same` or `different`.
 *
 * Uses Australian English throughout (behaviour, normalise, unreadable).
 */

import { normaliseLogExcerpt } from "./auto_fix_attempt_tracker.ts";
import {
  type ActionsLogOutcome,
  fetchGithubActionsLogExcerpt,
  stripAnsi,
} from "./github_actions_log_fetcher.ts";

/** Verdict on whether the base run failed for the same reason as the PR. */
export type BaseFailureComparison =
  | { state: "same"; matched: string } // all comparable PR failure lines appear in the base log
  | { state: "different" } // at least one comparable PR failure line is absent
  | { state: "unreadable"; reason: string }; // either side could not be read/compared (never a verdict)

/** Lines read from a failure text, and their length; bounds keep hostile input cheap. */
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 500;
/** Shortest normalised line worth comparing. */
const MIN_SIGNATURE_CHARS = 20;

/** `- **path:line**: message`, as formatCiAnnotations renders an annotation. */
const ANNOTATION_PREFIX = /^-\s*\*\*[^*\n]*\*\*:\s*/;
/** GitHub Actions workflow-command markers that precede the message. */
const COMMAND_MARKER = /^##\[(?:error|warning|group|endgroup)\]/;
/**
 * A command echo: a `##[group]`, `##[endgroup]` or `##[command]` line, which
 * prints the command being run (`Run cargo test --no-fail-fast`), not a result.
 */
const COMMAND_ECHO =
  /^(?:\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?z?\s+)?(?:##\[(?:group|endgroup|command)\]|\[command\])/i;
/** A command-line flag, such as `--no-fail-fast` or `--fail`; not a failure. */
const FLAG_TOKEN = /(?:^|\s)--?[a-z][\w-]*/g;
/** The runner's closing line, shared by every failed job; not evidence. */
const GENERIC_LINE =
  /process completed with exit code|^(?:<ts>\s*)?(?:##\[error\]\s*)?assertion `left (?:==|!=) right` failed\s*$|error: test failed, to rerun pass|npm error command failed|(?:npm error )?lifecycle script .* failed|\.\.\. ok(?:\s|$)|^(?:<ts>\s*)?(?:(?:ok|failed)\s*\|\s*\d+ passed(?:\s*\(\d+ steps?\))?\s*\||test result:|tests:|test suites:|tests\s+\d+\s+(?:failed|passed)\s*\||=+\s*\d+\s+(?:failed|passed)\b|fail\s+\S+\.(?:test|spec)\.[^\s]+\s*$|npm error (?:path|command)\s)/;
/** The worker's own boilerplate from formatCiAnnotations; not evidence. */
const BOILERPLATE =
  /no specific annotations were available|following ci failure details were detected|\d+ further annotation\(s\) omitted|^## pr failure action output$|^the following excerpts were fetched by the configured ci log providers/;
const FAILURE_WORD =
  /\b(?:error|fail(?:ed|ure|ing|s)?|panic(?:ked)?|exception|fatal|assert\w*|cannot|denied)\b/;

/** Normalise runner durations that the shared fingerprint normaliser does not cover. */
function normaliseComparison(text: string): string {
  return normaliseLogExcerpt(
    text.replace(/\b\d+m\d+(?:\.\d+)?s\b|\b\d+(?:\.\d+)?\s*[µμ]s\b/gi, "<dur>"),
  );
}

/**
 * Failure lines of a CI failure text, normalised and de-duplicated in
 * first-seen order. A line qualifies when it is long enough, is not the
 * generic runner summary or a command echo, and is a failing-test name or
 * carries a failure word outside any command-line flag.
 */
export function failureSignatureLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const raw of stripAnsi(text).split("\n").slice(0, MAX_LINES)) {
    let line = raw.slice(0, MAX_LINE_CHARS).trim();

    if (COMMAND_ECHO.test(line)) continue;

    const prefix = ANNOTATION_PREFIX.exec(line);
    if (prefix) {
      line = line.slice(prefix[0].length);
    }
    line = line.replace(COMMAND_MARKER, "");

    const normalised = normaliseComparison(line);
    const testName = /^(?:<ts>\s*)?(?:●\s+\S|✖\s+\S|not ok\s+\d+\s+\S)/.test(
      normalised,
    );
    if (!testName && normalised.length < MIN_SIGNATURE_CHARS) continue;
    if (GENERIC_LINE.test(normalised)) continue;
    if (BOILERPLATE.test(normalised)) continue;
    if (
      !testName &&
      !FAILURE_WORD.test(normalised.replace(FLAG_TOKEN, " "))
    ) continue;
    if (seen.has(normalised)) continue;

    seen.add(normalised);
    lines.push(normalised);
  }

  return lines;
}

/**
 * Compare the pull request's failure with the base run's log for the same
 * check. The base log is fetched through `actionsLogFn` (the real Actions log
 * fetcher by default), so a test can answer without touching the network.
 */
export async function compareBaseFailure(options: {
  repo: string;
  checkName: string;
  baseCheckRunId: number;
  failureText: string;
  ghFn: (args: string[]) => Promise<string>;
  actionsLogFn?: typeof fetchGithubActionsLogExcerpt;
}): Promise<BaseFailureComparison> {
  const { repo, checkName, baseCheckRunId, failureText, ghFn } = options;

  const prLines = failureSignatureLines(failureText);
  const firstLine = prLines[0];
  if (firstLine === undefined) {
    return {
      state: "unreadable",
      reason:
        "the pull request's failure carried no line that could be compared",
    };
  }

  const fetchLog = options.actionsLogFn ?? fetchGithubActionsLogExcerpt;
  let outcome: ActionsLogOutcome;
  try {
    outcome = await fetchLog({
      repo,
      checkRunId: String(baseCheckRunId),
      checkName,
      ghFn,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "unreadable",
      reason: `the base run's log could not be read: ${message}`,
    };
  }

  if (outcome.kind !== "excerpt") {
    const cause = outcome.kind === "error" ? outcome.error : outcome.reason;
    return {
      state: "unreadable",
      reason: `the base run's log was not readable: ${cause}`,
    };
  }

  const baseText = normaliseComparison(stripAnsi(outcome.excerpt));
  if (baseText.length === 0) {
    return {
      state: "unreadable",
      reason: "the base run's log was empty",
    };
  }
  if (!prLines.every((line) => baseText.includes(line))) {
    return { state: "different" };
  }
  return { state: "same", matched: firstLine };
}
