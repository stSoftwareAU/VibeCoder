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
/** The base excerpt is byte-capped, so it needs no tighter line bound. */
const MAX_BASE_LINES = 20000;
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
/**
 * Lines that are never evidence: the runner's closing line, shared tool output,
 * an assertion library's own header and remote library stack frames (they are
 * the same for every failed assertion), and Jest's `Test suite failed to run`
 * (it names no suite; the `FAIL <file>` line does).
 */
const GENERIC_LINE =
  /process completed with exit code|^assertion `left (?:==|!=) right` failed$|error: test failed, to rerun pass|npm error command failed|(?:npm error )?lifecycle script .* failed|\.\.\. ok(?:\s|$)|npm error (?:path|command)\s|^throw new assertionerror\(|^at .+ \(https?:\/\/|^(?:error: )?assertionerror(?: \[err_assertion\])?: (?:values are not equal\.?|expected values to be strictly equal:?|the expression evaluated to a falsy value:?)$|^[●✖✕✗×] test suite failed to run/;
/**
 * A passing test result, in any runner format: TAP `ok <n>`, Go `--- PASS`,
 * Jest `PASS`, pytest `::name PASSED`, and the `✓`, `✔` and `√` marks of the
 * node:test, Mocha, Jest and Bats spec reporters. Its name can hold a failure
 * word without describing a failure.
 */
const PASSING_LINE = /^(?:[✓✔√]|ok\s|--- pass:|pass\s|\S+::\S+ passed\b)/;
/**
 * A failing-test name: Jest `●`, node:test `✖`, Jest `✕`, Bats `✗`, TAP
 * `not ok`, Mocha `<n>)`, Vitest `FAIL file > name`, Jest `FAIL file.test.js`,
 * pytest `FAILED id::name`, Go `--- FAIL:`, Deno/cargo `name ... FAILED` and
 * Deno's `name => path:line:col` in its ERRORS and FAILURES sections. A base
 * log must hold the whole line, not a longer test name that starts with it.
 */
const TEST_NAME =
  /^(?:[●✖✕✗×]\s+\S|not ok\s+<n>\s+\S|<n>\)\s+\S|fail\s+\S+\s>\s|fail\s+\S+\.(?:test|spec)\.\S+$|--- fail:|(?:failed|error)\s+\S+::\S|.* \.\.\. failed(?: \(<dur>\))?$|.+ => \S+:<l>:<l>$)/;
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
 * Normalise runner durations, sequence numbers, Deno source positions and
 * test-run counts that the shared fingerprint normaliser does not cover.
 */
function normaliseComparison(text: string): string {
  return normaliseLogExcerpt(
    text.replace(/\b\d+m\d+(?:\.\d+)?s\b|\b\d+(?:\.\d+)?\s*[µμ]s\b/gi, "<dur>")
      .replace(/^(.* => \S+?):\d+:\d+$/, "$1:<l>:<l>")
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
 * True when the line is only a test-run tally, whatever its count nouns:
 * `1 failed, 42 passed, 3 warnings in <dur>`, `Deprecations: 3` and Deno's
 * `FAILED | <n> passed | <n> failed (<dur>)`. Every word must be a tally word,
 * a noun directly after a count (`3 warnings`) or a label before `:` and a
 * count (`Deprecations: 3`), so `error: expected 3 got 4` is not a tally. It
 * also covers minitest's generic `1) Failure:` header, which names no test.
 */
function isTallyLine(normalised: string): boolean {
  const tokens = normalised.match(/<n>|<dur>|[a-z]+|\d+|[^\sa-z\d]/g);
  if (tokens === null) return false;
  const isCount = (token: string | undefined) =>
    token !== undefined && (token === "<n>" || token === "<dur>" ||
      /^\d+$/.test(token));
  const isLabelMark = (token: string | undefined) =>
    token === ":" || token === "=";
  let hasCount = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (!/^[a-z]+$/.test(token) && !isCount(token)) continue; // punctuation
    if (isCount(token)) {
      hasCount = true;
    } else if (TALLY_WORDS.has(token)) continue;
    else if (isCount(tokens[i - 1])) continue; // `3 warnings`
    else if (isLabelMark(tokens[i + 1]) && isCount(tokens[i + 2])) continue; // `Deprecations: 3`
    else return false;
  }
  return hasCount;
}

/** An Actions timestamp at the start of a raw log line. */
const LEADING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s?/;
/** Deno's captured-output block, including the pre-test and post-test forms. */
const DENO_OUTPUT_START = /^-{3,}\s*(?:pre-test |post-test )?output\s*-{3,}$/i;
const DENO_OUTPUT_END =
  /^-{3,}\s*(?:pre-test |post-test )?output end\s*-{3,}$/i;
/** Jest's `console.error` header, indented; its block is the deeper lines. */
const JEST_CONSOLE = /^console\.(?:log|info|warn|error|debug)$/;
const JEST_CONSOLE_SECTION = /^● Console$/;
/** Vitest's `stdout | file > test` header; its block runs to the next blank line. */
const VITEST_OUTPUT = /^(?:stdout|stderr) \| /;
/** The marker `summariseActionsLog` leaves where it dropped lines. */
const OMISSION_MARKER = /^\[\.\.\. .* \.\.\.\]$/;
/** Mocha's numbered failure header, whose test name sits on a deeper line. */
const NUMBERED_FAILURE = /^\d+\)\s+\S/;
/** How many deeper lines a Mocha failure header may join to reach its test name. */
const MOCHA_NAME_LINES = 3;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The lines of a log text, ready for comparison: ANSI and timestamps removed,
 * each line capped, the output that tests print left out (Deno `output`
 * blocks, Jest `console.*` blocks and Vitest `stdout |` blocks, which can hold
 * a failure word without being a failure), and a Mocha `1) Parser` header
 * joined to the `parses header:` line that names its test.
 */
function preparedLines(text: string, limit: number): string[] {
  const lines = stripAnsi(text).split("\n").slice(0, limit).map((line) =>
    line.slice(0, MAX_LINE_CHARS).replace(LEADING_TIMESTAMP, "").trimEnd()
  );
  const kept: string[] = [];
  let denoBlock = false;
  let blockIndent = -1; // indent of the Jest header whose block is being skipped
  let untilBlank = false; // a Vitest block ends at the next blank line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (denoBlock) {
      if (DENO_OUTPUT_END.test(trimmed) || OMISSION_MARKER.test(trimmed)) {
        denoBlock = false;
      }
      continue;
    }
    if (untilBlank) {
      if (trimmed !== "") continue;
      untilBlank = false;
    } else if (blockIndent >= 0) {
      if (trimmed === "" || indentOf(line) > blockIndent) continue;
      blockIndent = -1;
    }
    if (DENO_OUTPUT_START.test(trimmed)) {
      denoBlock = true;
      continue;
    }
    if (JEST_CONSOLE_SECTION.test(trimmed) || JEST_CONSOLE.test(trimmed)) {
      blockIndent = indentOf(line);
      continue;
    }
    if (VITEST_OUTPUT.test(trimmed)) {
      untilBlank = true;
      continue;
    }
    if (NUMBERED_FAILURE.test(trimmed) && !trimmed.endsWith(":")) {
      let joined = trimmed;
      let j = i + 1;
      while (
        j < lines.length && j <= i + MOCHA_NAME_LINES &&
        !joined.endsWith(":") && lines[j]?.trim() !== "" &&
        indentOf(lines[j] as string) > indentOf(line) &&
        !(lines[j] as string).trim().startsWith("at ")
      ) {
        joined += " " + (lines[j] as string).trim();
        j++;
      }
      if (joined.endsWith(":")) {
        kept.push(joined);
        i = j - 1;
        continue;
      }
    }
    kept.push(line);
  }
  return kept;
}

/** The runner's closing line for a failed step, as it appears in a job log. */
const STEP_FAILED_LINE = /^##\[error\]process completed with exit code/i;
/** The line that opens or closes a step's command echo. */
const STEP_BOUNDARY = /^##\[(?:group|endgroup)\]/i;
/** How many lines before the step's closing line the fallback reads. */
const MAX_STEP_LINES = 200;

/**
 * The output of the failing step: the lines between the step's command echo
 * and its `##[error]Process completed with exit code` line. Empty when the log
 * has no such line.
 */
function failingStepLines(lines: string[]): string[] {
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (STEP_FAILED_LINE.test((lines[i] as string).trim())) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  let start = end;
  while (start > 0 && end - start < MAX_STEP_LINES) {
    const previous = (lines[start - 1] as string).trim();
    if (STEP_BOUNDARY.test(previous) || OMISSION_MARKER.test(previous)) break;
    start--;
  }
  return lines.slice(start, end);
}

/** A standalone number in a line with no failure word, as in `42┆ new RegExp(x)`. */
const LOOSE_NUMBER = /\b\d+\b/g;
/** Explicit file loci and rule identifiers are evidence; step banners are not. */
const FORMAT_LOCUS = /^from\s+\S+:$/;
const DISTINCTIVE_LINE =
  /^(?:from\s+\S+:|❯❱\s+\S+|(?:[\w.-]+\/)+[\w.-]+\.[a-z\d]+(?::\d+)?$|(?:sc\d{4}|md\d{3})\b|semgrep: blocking code rules fired - \S+|lint: [\w-]+$)/i;
const FORMAT_SUMMARY = /^error: found \d+ not formatted files? in \d+ files?$/;

function loosen(line: string): string {
  return line.replace(LOOSE_NUMBER, "<n>");
}

/**
 * The comparable form of each line that passes the filters. `needsWord` asks
 * for a failure word, test name or formatter locus; the fallback requires a
 * distinctive rule or file locus.
 */
function comparableLines(lines: string[], needsWord: boolean): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const trimmed of lines) {
    if (COMMAND_ECHO.test(trimmed.trim())) continue;

    const normalised = canonicalLine(trimmed);
    if (normalised.length === 0) continue;
    if (PASSING_LINE.test(normalised)) continue;
    if (GENERIC_LINE.test(normalised)) continue;
    if (BOILERPLATE.test(normalised)) continue;
    if (isTallyLine(normalised)) continue;
    if (FORMAT_SUMMARY.test(normalised)) continue;

    if (needsWord) {
      if (!TEST_NAME.test(normalised) && !FORMAT_LOCUS.test(normalised)) {
        if (normalised.length < MIN_SIGNATURE_CHARS) continue;
        if (!FAILURE_WORD.test(normalised.replace(FLAG_TOKEN, " "))) continue;
      }
    } else {
      if (!DISTINCTIVE_LINE.test(normalised)) continue;
    }
    if (seen.has(normalised)) continue;

    seen.add(normalised);
    result.push(normalised);
  }

  return result;
}

/** A pull request's comparable lines, and how they are to be matched. */
interface FailureSignature {
  lines: string[];
  /** Step-output lines, matched with their standalone numbers ignored. */
  loose: boolean;
}

function failureSignature(text: string): FailureSignature {
  const prepared = preparedLines(text, MAX_LINES);
  const lines = comparableLines(prepared, true);
  // These runner headers identify a test failure but not which test failed.
  // An assertion or exception alone cannot establish the same test on base.
  const testFailureHeader = prepared.some((line) =>
    /^(?:errors|failures|[●] test suite failed to run)$/i.test(line.trim())
  );
  if (testFailureHeader && !lines.some((line) => TEST_NAME.test(line))) {
    return { lines: [], loose: false };
  }
  if (lines.length > 0) return { lines, loose: false };
  // A check whose output holds no failure word (semgrep, shellcheck, cspell)
  // is read from the failing step's own output instead.
  return {
    lines: comparableLines(failingStepLines(prepared), false).map(loosen),
    loose: true,
  };
}

/**
 * Failure lines of a CI failure text, normalised and de-duplicated in
 * first-seen order. Test output (Deno `output` blocks, Jest `console.*`),
 * passing test results, test-run tallies, command echoes and generic runner
 * output never qualify. A line qualifies when it is long enough and is a
 * failing-test name or carries a failure word outside any command-line flag.
 * When no line does, distinctive rule and file loci in the failing step's
 * output qualify, with standalone numbers normalised.
 */
export function failureSignatureLines(text: string): string[] {
  return failureSignature(text).lines;
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

  const signature = failureSignature(failureText);
  const prLines = signature.lines;
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

  const baseLines = preparedLines(outcome.excerpt, MAX_BASE_LINES)
    .map(canonicalLine).filter((line) => line.length > 0)
    .map((line) => signature.loose ? loosen(line) : line);
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
