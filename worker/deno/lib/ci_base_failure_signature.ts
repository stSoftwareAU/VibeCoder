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
/**
 * A command echo: a `##[group]`, `##[endgroup]` or `##[command]` line, which
 * prints the command being run (`Run cargo test --no-fail-fast`), not a result.
 */
const COMMAND_ECHO =
  /^(?:\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?z?\s+)?(?:##\[(?:group|endgroup|command)\]|\[command\])/i;
/** A command-line flag, such as `--no-fail-fast` or `--fail`; not a failure. */
const FLAG_TOKEN = /(?:^|\s)--?[a-z][\w-]*/g;
/** Lines that are never evidence: the runner's closing line and shared tool output. */
const GENERIC_LINE =
  /process completed with exit code|^assertion `left (?:==|!=) right` failed$|error: test failed, to rerun pass|npm error command failed|(?:npm error )?lifecycle script .* failed|\.\.\. ok(?:\s|$)|^fail\s+\S+\.(?:test|spec)\.[^\s]+$|npm error (?:path|command)\s/;
/**
 * A passing test result, in any runner format: TAP `ok <n>`, Go `--- PASS`,
 * Jest `PASS`, pytest `::name PASSED`, and the `✓`, `✔` and `√` marks of the
 * node:test, Mocha, Jest and Bats spec reporters. Its name can hold a failure
 * word without describing a failure.
 */
const PASSING_LINE = /^(?:[✓✔√]|ok\s|--- pass:|pass\s|\S+::\S+ passed\b)/;
/**
 * A failing-test name: Jest `●`, node:test `✖`, Jest `✕`, Bats `✗`, TAP
 * `not ok`, Mocha `<n>)`, Vitest `FAIL file > name`, pytest `FAILED id::name`,
 * Go `--- FAIL:` and Deno/cargo `name ... FAILED`. A base log must hold the
 * whole line, not a longer test name that starts with it.
 */
const TEST_NAME =
  /^(?:[●✖✕✗×]\s+\S|not ok\s+<n>\s+\S|<n>\)\s+\S|fail\s+\S+\s>\s|--- fail:|(?:failed|error)\s+\S+::\S|.* \.\.\. failed(?: \(<dur>\))?$)/;
/** Words a test-run tally line is made of; the counts beside them vary run to run. */
const TALLY_WORDS = new Set(
  (
    "passed passing failed failing failure failures error errors skipped skips skip pending " +
    "examples example tests test runs run ran assertions assertion total duration time elapsed " +
    "files file suites suite steps step result ignored measured filtered out finished in of ok " +
    "snapshots snapshot obsolete todo n dur"
  ).split(" "),
);
const TALLY_NOUN =
  "passed|failed|failures?|errors?|skipped|skips?|examples?|tests?|runs?|assertions?|pending|total|ignored|passing|failing";
/** `42 passed` and `Failures: 1`: the count, not the noun, changes between runs. */
const COUNT_BEFORE_NOUN = new RegExp(
  `\\b\\d+(?=\\s*(?:${TALLY_NOUN})\\b)`,
  "g",
);
const COUNT_AFTER_NOUN = new RegExp(
  `\\b(${TALLY_NOUN})(\\s*[:=]\\s*)\\d+\\b`,
  "g",
);
/** The worker's own boilerplate from formatCiAnnotations; not evidence. */
const BOILERPLATE =
  /no specific annotations were available|following ci failure details were detected|\d+ further annotation\(s\) omitted|^## pr failure action output$|^the following excerpts were fetched by the configured ci log providers/;
const FAILURE_WORD =
  /\b(?:error|fail(?:ed|ure|ing|s)?|panic(?:ked)?|exception|fatal|assert\w*|cannot|denied)\b/;
/** A leading timestamp and workflow-command marker, once normalised. */
const LEADING_MARKERS =
  /^(?:<ts>\s*)?(?:##\[(?:error|warning|group|endgroup)\]\s*)?/;

/**
 * Normalise runner durations, sequence numbers and test-run counts that the
 * shared fingerprint normaliser does not cover.
 */
function normaliseComparison(text: string): string {
  return normaliseLogExcerpt(
    text.replace(/\b\d+m\d+(?:\.\d+)?s\b|\b\d+(?:\.\d+)?\s*[µμ]s\b/gi, "<dur>")
      .replace(
        /^(\s*(?:\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?z?\s+)?)(not ok\s+)\d+(?=\s)/gim,
        "$1$2<n>",
      )
      .replace(
        /^(\s*(?:\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?z?\s+)?)\d+\)(?=\s+\S)/gim,
        "$1<n>)",
      ),
  )
    // Counts run after the shared normaliser, which owns `build #41`-style ids.
    .replace(COUNT_BEFORE_NOUN, "<n>")
    .replace(COUNT_AFTER_NOUN, "$1$2<n>");
}

/**
 * One log line in comparison form: annotation prefix, timestamp and workflow
 * marker removed, then normalised. The pull request's lines and the base log's
 * lines both go through here, so they compare on equal terms.
 */
function canonicalLine(raw: string): string {
  let line = raw.trim();
  const prefix = ANNOTATION_PREFIX.exec(line);
  if (prefix) line = line.slice(prefix[0].length);
  return normaliseComparison(line).replace(LEADING_MARKERS, "").trim();
}

/**
 * True when the line is only a test-run tally, such as `1 failed, 42 passed in
 * <dur>`. This also covers minitest's generic `1) Failure:` header, which names
 * no test.
 */
function isTallyLine(normalised: string): boolean {
  const tokens = normalised.match(/[a-z]+|\d+/g);
  if (tokens === null) return false;
  let hasCount = false;
  for (const token of tokens) {
    if (/^\d+$/.test(token) || token === "n" || token === "dur") {
      hasCount = true;
    } else if (!TALLY_WORDS.has(token)) return false;
  }
  return hasCount;
}

/**
 * Failure lines of a CI failure text, normalised and de-duplicated in
 * first-seen order. A line qualifies when it is long enough, is not a passing
 * test result, a test-run tally, the generic runner output or a command echo,
 * and is a failing-test name or carries a failure word outside any
 * command-line flag.
 */
export function failureSignatureLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const raw of stripAnsi(text).split("\n").slice(0, MAX_LINES)) {
    const trimmed = raw.slice(0, MAX_LINE_CHARS).trim();
    if (COMMAND_ECHO.test(trimmed)) continue;

    const normalised = canonicalLine(trimmed);
    if (normalised.length === 0) continue;
    if (PASSING_LINE.test(normalised)) continue;
    if (GENERIC_LINE.test(normalised)) continue;
    if (BOILERPLATE.test(normalised)) continue;
    if (isTallyLine(normalised)) continue;

    if (!TEST_NAME.test(normalised)) {
      if (normalised.length < MIN_SIGNATURE_CHARS) continue;
      if (!FAILURE_WORD.test(normalised.replace(FLAG_TOKEN, " "))) continue;
    }
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

  const baseLines = stripAnsi(outcome.excerpt).split("\n").map(canonicalLine)
    .filter((line) => line.length > 0);
  if (baseLines.length === 0) {
    return {
      state: "unreadable",
      reason: "the base run's log was empty",
    };
  }
  // A test name must be a whole base line; other lines may sit inside one.
  const baseSet = new Set(baseLines);
  const baseText = baseLines.join("\n");
  const found = (line: string) =>
    TEST_NAME.test(line) ? baseSet.has(line) : baseText.includes(line);
  if (!prLines.every(found)) {
    return { state: "different" };
  }
  return { state: "same", matched: firstLine };
}
