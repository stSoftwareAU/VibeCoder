/**
 * Removed-test-assertion gate for PR summaries (Issue #3131).
 *
 * The fleet's PR-summary contract already told the agent (#3061) to list
 * every assertion a diff removes from an *existing* test in the PR
 * summary's Test Plan, together with the issue requirement that makes the
 * old assertion untrue. That rule was prose only — nothing in the worker
 * checked it. GRQ-AutoTrader#2370 raised a PR with no `## Test Plan`
 * section at all and silently dropped a still-true per-day `BBB` row
 * assertion, and that PR reached milestone PR GRQ-AutoTrader#2376
 * unnoticed.
 *
 * This module is the deterministic gate for that rule. It applies whenever
 * the branch's changed-files list contains a test file (or could not be
 * read at all, which fails closed), and in that case requires the PR
 * summary to carry a `## Test Plan` heading. On top of that, every
 * assertion a diff removes from a test file — unless it was simply moved
 * (reformatted or relocated, i.e. re-added verbatim elsewhere in the same
 * diff) rather than deleted — must be named in that Test Plan.
 *
 * Modelled on `docs_sweep_gate.ts`: pure functions only, hardcoded regexes
 * (never `new RegExp()` built from input), and bounded scans throughout —
 * the diff and the PR summary are both agent-authored / untrusted text, so
 * both are treated as untrusted here. Every scan is linear-time by
 * construction: no nested unbounded quantifiers, and paren-depth counting
 * is a manual character loop rather than a regex.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isTestFilePath } from "./security_fix_gate.ts";
import { codeFenceFor, scrubUntrustedText } from "./prompt_delimiter.ts";

/**
 * Cap on the diff text scanned (defence in depth; untrusted input). Exported
 * so a caller that reads the patch itself (`completion_phase.ts`) can detect
 * a patch at or past the cap and treat it as unreadable, rather than letting
 * this module silently scan only the first `MAX_DIFF_CHARS` of it.
 */
export const MAX_DIFF_CHARS = 2_000_000;

/** Cap on a single diff line scanned for an assertion match. */
const MAX_LINE_CHARS = 4_000;

/** Cap on a removed assertion's canonical form. */
const MAX_CANONICAL_CHARS = 2_000;

/** Cap on how many lines a single removed statement can span. */
const MAX_STATEMENT_LINES = 12;

/** Cap on a removed assertion's display text. */
const MAX_DISPLAY_CHARS = 300;

/** Cap on the PR summary text scanned for the Test Plan section. */
const MAX_SUMMARY_SCAN_CHARS = 200_000;

/**
 * `git diff` args for the test-file patch this gate reads (single source of
 * truth). `--diff-filter=AMRD` includes deletions: a deleted test file (or
 * one renamed and rewritten below git's rename-similarity threshold, which
 * git reports as a delete plus an add) must still surface its removed
 * assertions, not just the heading rule.
 *
 * `testFiles`, when given and non-empty, scopes the diff to those paths via
 * a `--` pathspec — the caller passes the changed-files list's test files so
 * this never has to read the whole branch diff just to find the test-file
 * hunks within it. The paths are attacker-controlled (the branch under
 * review), so they are placed after a literal `--` and never shell-expanded
 * (this runs through `runGitCommand`'s argv, not a shell).
 */
export function removedAssertionDiffArgs(
  base: string,
  testFiles?: readonly string[],
): string[] {
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=0",
    "--find-renames",
    "--diff-filter=AMRD",
    `${base}...HEAD`,
  ];
  if (testFiles && testFiles.length > 0) {
    args.push("--", ...testFiles);
  }
  return args;
}

/** A removed assertion statement found in an existing test file's diff. */
export interface RemovedAssertion {
  /** Repo-relative path of the test file (the new path for a rename). */
  file: string;
  /** Display form: statement lines trimmed, joined with single spaces, capped. */
  text: string;
  /** Canonical form used for matching (see {@link canonicalise}). */
  canonical: string;
}

/** A line starting a new file's diff header. */
const DIFF_HEADER_RE = /^diff --git /;

/** The `--- <old path>` header line, only matched while in header mode. */
const OLD_PATH_HEADER_RE = /^--- (.*)$/;

/** The `+++ <new path>` header line, only matched while in header mode. */
const NEW_PATH_HEADER_RE = /^\+\+\+ (.*)$/;

/** A hunk header, e.g. `@@ -1,2 +1,2 @@`. */
const HUNK_RE = /^@@/;

/** The "no trailing newline" marker, ignored as neither header nor content. */
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/**
 * An assertion-opening statement across this fleet's ecosystems: `assert(`,
 * `assertEquals(`, `assert_eq!(`, `assert!(`, `self.assertEqual(`,
 * `assert.equal(`, Jest `expect(`, Python bare `assert x`, and bats
 * `assert_success`. Excludes `debug_assert!` (no `\b` before `assert` after
 * `debug_`) and Rust `.expect("msg")` (the negative lookbehind on `expect`).
 */
const ASSERTION_START_RE =
  /\bassert(?:\w*!?|\.\w+)\s*\(|(?<![.\w])expect\s*\(|^\s*assert(?:_\w+)?(?:\s|$)/;

/** Whether a trimmed line is a comment, so it cannot open an assertion. */
function isCommentLine(trimmed: string): boolean {
  if (
    trimmed.startsWith("//") || trimmed.startsWith("/*") ||
    trimmed.startsWith("*")
  ) {
    return true;
  }
  return trimmed.startsWith("#") && trimmed[1] !== "[";
}

/** Strip a surrounding quote pair, then an `a/`/`b/` prefix, from a diff path. */
function parseDiffPath(raw: string): string {
  let path = raw.trim();
  if (path === "/dev/null") return path;
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  if (path.startsWith("a/") || path.startsWith("b/")) {
    path = path.slice(2);
  }
  return path;
}

/** Running paren depth contributed by a single line, counted with a char loop. */
function parenDelta(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth;
}

/**
 * Canonical form of a statement: whitespace removed, a comma deleted when it
 * directly precedes `)`, `]` or `}`, and trailing `;`/`,` stripped by a
 * manual loop (never a backtracking regex). Capped at
 * {@link MAX_CANONICAL_CHARS}.
 */
function canonicalise(statement: string): string {
  let result = statement.replace(/\s+/g, "");
  result = result.replace(/,(?=[)\]}])/g, "");
  let end = result.length;
  while (end > 0 && (result[end - 1] === ";" || result[end - 1] === ",")) {
    end--;
  }
  result = result.slice(0, end);
  return result.length > MAX_CANONICAL_CHARS
    ? result.slice(0, MAX_CANONICAL_CHARS)
    : result;
}

/** A removed or added content block: consecutive `-`/`+` lines in one hunk. */
interface DiffBlock {
  file: string;
  lines: string[];
}

/**
 * Parse a unified diff into the removed and added content blocks of its
 * test files. Header lines (`--- `/`+++ `) are only read while in header
 * mode, so a hunk line like `-- comment` (rendered `--- comment`) is never
 * mistaken for a file header.
 */
function parseTestFileBlocks(
  diffText: string,
): { removedBlocks: DiffBlock[]; addedBlocks: DiffBlock[] } {
  const text = (diffText ?? "").slice(0, MAX_DIFF_CHARS);
  const lines = text.split(/\r\n|\n/);

  const removedBlocks: DiffBlock[] = [];
  const addedBlocks: DiffBlock[] = [];

  let oldPath: string | null = null;
  let newPath: string | null = null;
  let isTestFile = false;
  let inHeader = false;
  let inHunk = false;

  let removedBlock: string[] = [];
  let addedBlock: string[] = [];

  const currentFile = () =>
    newPath !== null && newPath !== "/dev/null" ? newPath : (oldPath ?? "");

  const flushRemoved = () => {
    if (removedBlock.length > 0 && isTestFile) {
      removedBlocks.push({ file: currentFile(), lines: removedBlock });
    }
    removedBlock = [];
  };
  const flushAdded = () => {
    if (addedBlock.length > 0 && isTestFile) {
      addedBlocks.push({ file: currentFile(), lines: addedBlock });
    }
    addedBlock = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.length > MAX_LINE_CHARS
      ? rawLine.slice(0, MAX_LINE_CHARS)
      : rawLine;

    if (DIFF_HEADER_RE.test(line)) {
      flushRemoved();
      flushAdded();
      oldPath = null;
      newPath = null;
      isTestFile = false;
      inHeader = true;
      inHunk = false;
      continue;
    }

    if (inHeader) {
      const oldMatch = line.match(OLD_PATH_HEADER_RE);
      if (oldMatch) {
        oldPath = parseDiffPath(oldMatch[1] ?? "");
        continue;
      }
      const newMatch = line.match(NEW_PATH_HEADER_RE);
      if (newMatch) {
        newPath = parseDiffPath(newMatch[1] ?? "");
        isTestFile = (newPath !== "/dev/null" && isTestFilePath(newPath)) ||
          (oldPath !== null && oldPath !== "/dev/null" &&
            isTestFilePath(oldPath));
        continue;
      }
      if (HUNK_RE.test(line)) {
        inHeader = false;
        inHunk = true;
        flushRemoved();
        flushAdded();
      }
      continue;
    }

    if (HUNK_RE.test(line)) {
      flushRemoved();
      flushAdded();
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith(NO_NEWLINE_MARKER)) {
      continue;
    }

    if (line.startsWith("-")) {
      flushAdded();
      removedBlock.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      flushRemoved();
      addedBlock.push(line.slice(1));
      continue;
    }

    flushRemoved();
    flushAdded();
  }
  flushRemoved();
  flushAdded();

  return { removedBlocks, addedBlocks };
}

/** Removed assertion statements found within a single removed block. */
function extractAssertionsFromBlock(block: DiffBlock): RemovedAssertion[] {
  const results: RemovedAssertion[] = [];
  const blockLines = block.lines;
  let i = 0;
  while (i < blockLines.length) {
    const raw = blockLines[i]!;
    const trimmed = raw.trim();
    if (!isCommentLine(trimmed) && ASSERTION_START_RE.test(raw)) {
      const statementLines: string[] = [raw];
      let depth = parenDelta(raw);
      let j = i + 1;
      while (
        depth > 0 && j < blockLines.length &&
        statementLines.length < MAX_STATEMENT_LINES
      ) {
        const next = blockLines[j]!;
        statementLines.push(next);
        depth += parenDelta(next);
        j++;
      }
      const joined = statementLines.map((line) => line.trim()).join(" ");
      let display = joined;
      if (display.length > MAX_DISPLAY_CHARS) {
        display = display.slice(0, MAX_DISPLAY_CHARS) + "…";
      }
      results.push({
        file: block.file,
        text: display,
        canonical: canonicalise(joined),
      });
      i = j;
      continue;
    }
    i++;
  }
  return results;
}

/**
 * Removed assertion statements from existing test files in a unified diff,
 * excluding ones moved verbatim (reformatted or relocated, not deleted).
 */
export function findRemovedAssertions(diffText: string): RemovedAssertion[] {
  const { removedBlocks, addedBlocks } = parseTestFileBlocks(diffText);

  // Moved assertions are matched by canonical *equality* against assertions
  // actually re-extracted from the added blocks — never by substring
  // containment against the whole added block's text. Containment let a
  // comment prefix (`// assertEquals(a, b);`) or a loosened condition
  // (`assert total == 5 or total == 6`) "contain" the removed assertion's
  // canonical text, so a commented-out or loosened assertion was wrongly
  // treated as moved rather than removed.
  const addedCanonicals = new Set<string>();
  for (const block of addedBlocks) {
    for (const assertion of extractAssertionsFromBlock(block)) {
      addedCanonicals.add(assertion.canonical);
    }
  }

  const candidates: RemovedAssertion[] = [];
  for (const block of removedBlocks) {
    candidates.push(...extractAssertionsFromBlock(block));
  }

  const seen = new Set<string>();
  const result: RemovedAssertion[] = [];
  for (const candidate of candidates) {
    if (
      candidate.canonical !== "" && addedCanonicals.has(candidate.canonical)
    ) {
      continue;
    }
    const key = `${candidate.file}\u0000${candidate.canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

/** The `## Test Plan` section of a PR summary. */
export interface TestPlanSection {
  /** Whether a Test Plan heading was found at all. */
  present: boolean;
  /** The body text up to (not including) the next heading of equal or higher rank. */
  body: string;
}

/** A `# Test Plan` style heading, any level, case-insensitive. */
const TEST_PLAN_HEADING_RE = /^\s{0,3}(#{1,6})\s*test\s+plan\b/i;

/** Any markdown heading, used to find where a Test Plan body ends. */
const HEADING_LINE_RE = /^\s{0,3}(#{1,6})\s/;

/** A fenced code block delimiter line. */
const FENCE_LINE_RE = /^\s{0,3}(```|~~~)/;

/**
 * The first `## Test Plan` section of a PR summary. Heading-looking lines
 * inside a fenced code block are ignored when looking for the section's end.
 */
export function findTestPlanSection(prSummaryContent: string): TestPlanSection {
  const text = (prSummaryContent ?? "").slice(0, MAX_SUMMARY_SCAN_CHARS);
  const lines = text.split(/\r\n|\n/);

  let headingIndex = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(TEST_PLAN_HEADING_RE);
    if (match) {
      headingIndex = i;
      headingLevel = match[1]!.length;
      break;
    }
  }

  if (headingIndex === -1) {
    return { present: false, body: "" };
  }

  const bodyLines: string[] = [];
  let inFence = false;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
      bodyLines.push(line);
      continue;
    }
    if (!inFence) {
      const headingMatch = line.match(HEADING_LINE_RE);
      if (headingMatch && headingMatch[1]!.length <= headingLevel) {
        break;
      }
    }
    bodyLines.push(line);
  }

  return { present: true, body: bodyLines.join("\n") };
}

/** A backslash-escaped markdown character, e.g. `\|` or `\*`. */
const MARKDOWN_ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!|>~])/g;

/** Canonical form of a Test Plan body, with markdown escapes undone first. */
function canonicaliseTestPlanBody(body: string): string {
  const unescaped = body.replace(MARKDOWN_ESCAPE_RE, "$1");
  return canonicalise(unescaped);
}

/** Verdict of the removed-assertion gate. */
export interface RemovedAssertionGateResult {
  /** True when the changed files include a test file, or could not be read. */
  applicable: boolean;
  /** True when the gate passes (always true when not applicable). */
  valid: boolean;
  /** False when the changed-files list could not be read at all. */
  changedFilesKnown: boolean;
  /** False when the test-file diff could not be read / was not provided. */
  testDiffKnown: boolean;
  /** Changed files that are test files (empty when the list is unknown). */
  testFiles: string[];
  /** Every removed (not-moved) assertion found. */
  removed: RemovedAssertion[];
  /** Those removed assertions the Test Plan does not name. */
  unaccounted: RemovedAssertion[];
  /** The parsed Test Plan section. */
  testPlan: TestPlanSection;
  /** One line per rule broken — empty when the gate passes. */
  problems: string[];
}

/** Up to how many test files are named in a "no Test Plan" problem. */
const MAX_NAMED_TEST_FILES = 5;

/** Render the changed test files for a problem message. */
function describeTestFiles(testFiles: readonly string[]): string {
  const named = testFiles.slice(0, MAX_NAMED_TEST_FILES).join(", ");
  const extra = testFiles.length - MAX_NAMED_TEST_FILES;
  return extra > 0 ? `${named} and ${extra} more` : named;
}

/** Up to how many unaccounted assertions are named in a problem message. */
const MAX_NAMED_UNACCOUNTED = 5;

/** Render unaccounted assertions for a problem message. */
function describeUnaccounted(unaccounted: readonly RemovedAssertion[]): string {
  const named = unaccounted
    .slice(0, MAX_NAMED_UNACCOUNTED)
    .map((assertion) => `${assertion.file}: ${assertion.text}`)
    .join("; ");
  const extra = unaccounted.length - MAX_NAMED_UNACCOUNTED;
  return extra > 0 ? `${named}; and ${extra} more` : named;
}

/** Shared rule evaluation once the gate is known to be applicable. */
function evaluateApplicable(
  testPlan: TestPlanSection,
  testFiles: string[],
  changedFilesKnown: boolean,
  testDiff: string | null,
): RemovedAssertionGateResult {
  const problems: string[] = [];

  if (!testPlan.present) {
    const diffDescription = changedFilesKnown
      ? `test files (${describeTestFiles(testFiles)})`
      : "the changed files could not be read, so the section is required";
    problems.push(
      `the PR summary has no \`## Test Plan\` section, but the diff touches ${diffDescription}`,
    );
  }

  let removed: RemovedAssertion[] = [];
  let unaccounted: RemovedAssertion[] = [];
  const testDiffKnown = testDiff !== null;

  if (testDiffKnown) {
    removed = findRemovedAssertions(testDiff!);
    // Matched against both the unescaped-markdown canonical and the raw
    // (un-unescaped) canonical of the Test Plan body. A removed assertion's
    // canonical form keeps its own backslashes verbatim (it is code, not
    // markdown), so `\.` inside a copied-verbatim regex or escaped string
    // must still match once the markdown-escape pass turns the Test Plan's
    // own `\.` into `.` — checking the raw body too is what lets the
    // verbatim copy the prompt asks for actually match.
    const planCanonical = canonicaliseTestPlanBody(testPlan.body);
    const planCanonicalRaw = canonicalise(testPlan.body);
    unaccounted = removed.filter(
      (assertion) =>
        !planCanonical.includes(assertion.canonical) &&
        !planCanonicalRaw.includes(assertion.canonical),
    );
    if (unaccounted.length > 0) {
      problems.push(
        `${unaccounted.length} assertion(s) removed from existing tests are not named in the Test Plan: ${
          describeUnaccounted(unaccounted)
        }`,
      );
      // SIMPLE-ON-PURPOSE: this gate checks only that each removed assertion
      // is named somewhere in the Test Plan, not that the stated issue
      // requirement really makes it untrue — upgrade to check the
      // requirement itself when a reviewed false entry reaches a milestone
      // (the Standards reviewer judges whether the stated reason is sound).
    }
  }

  return {
    applicable: true,
    valid: problems.length === 0,
    changedFilesKnown,
    testDiffKnown,
    testFiles,
    removed,
    unaccounted,
    testPlan,
    problems,
  };
}

/**
 * Verify that a PR summary's Test Plan accounts for every assertion the
 * diff removes from an existing test file.
 *
 * Rules, all deterministic:
 *   1. `changedFiles === null` (the diff could not be read) → the gate
 *      APPLIES (fail closed).
 *   2. A known changed-files list with no test file → not applicable, valid.
 *   3. Applicable with no `## Test Plan` section → blocked.
 *   4. When the test diff is known, every removed (not-moved) assertion must
 *      be named (as its canonical form) somewhere in the Test Plan body, or
 *      the PR is blocked.
 *   5. `testDiff === null` → no assertion-naming problem is raised (the
 *      caller logs the gap); rule 3 still applies.
 *
 * @param opts.changedFiles - The branch's changed files, or `null` when the
 *   diff could not be collected.
 * @param opts.testDiff - Output of `removedAssertionDiffArgs`, or `null`
 *   when it could not be read / was not collected.
 * @param opts.prSummaryContent - The PR summary content (or assembled body).
 */
export function validateRemovedAssertions(opts: {
  changedFiles: readonly string[] | null;
  testDiff: string | null;
  prSummaryContent: string;
}): RemovedAssertionGateResult {
  const testPlan = findTestPlanSection(opts.prSummaryContent ?? "");

  if (opts.changedFiles === null) {
    return evaluateApplicable(testPlan, [], false, opts.testDiff);
  }

  const testFiles = opts.changedFiles.filter((path) => isTestFilePath(path));
  if (testFiles.length === 0) {
    return {
      applicable: false,
      valid: true,
      changedFilesKnown: true,
      testDiffKnown: opts.testDiff !== null,
      testFiles: [],
      removed: [],
      unaccounted: [],
      testPlan,
      problems: [],
    };
  }

  return evaluateApplicable(testPlan, testFiles, true, opts.testDiff);
}

/** Cap on how many unaccounted assertions are listed in the gate comment. */
const MAX_LISTED_UNACCOUNTED = 30;

/**
 * Build the issue comment posted when the removed-assertion gate blocks PR
 * creation.
 *
 * Names every rule broken, lists the unaccounted assertions grouped by file
 * inside a fence sized so the untrusted assertion text cannot break out of
 * it, and restates the required Test Plan shape.
 */
export function buildRemovedAssertionGateComment(
  result: RemovedAssertionGateResult,
): string {
  const problems = result.problems.map((problem) => `- ${problem}`).join(
    "\n",
  );

  const lines: string[] = [
    "⚠️ **Removed test assertions not accounted for.** This diff edits an " +
    "existing test, so the PR summary must carry a `## Test Plan` that " +
    "names every assertion removed from an existing test — with the issue " +
    "requirement that makes it untrue — or says where it moved:",
    "",
    problems,
  ];

  if (result.unaccounted.length > 0) {
    const grouped = new Map<string, RemovedAssertion[]>();
    for (const assertion of result.unaccounted) {
      const list = grouped.get(assertion.file) ?? [];
      list.push(assertion);
      grouped.set(assertion.file, list);
    }

    let rendered = "";
    let listed = 0;
    for (const [file, assertions] of grouped) {
      if (listed >= MAX_LISTED_UNACCOUNTED) break;
      rendered += `${file}:\n`;
      for (const assertion of assertions) {
        if (listed >= MAX_LISTED_UNACCOUNTED) break;
        rendered += `  ${assertion.text}\n`;
        listed++;
      }
    }
    const extra = result.unaccounted.length - listed;
    if (extra > 0) {
      rendered += `…and ${extra} more\n`;
    }

    const body = scrubUntrustedText(rendered.trimEnd());
    const fence = codeFenceFor(body);
    lines.push(
      "",
      "Removed assertions not named in the Test Plan:",
      "",
      `${fence}text`,
      body,
      fence,
    );
  }

  lines.push(
    "",
    "Procedure:",
    "",
    "1. Restore any removed assertion that no issue requirement makes " +
      "untrue — the diff must not quietly drop test coverage that is still " +
      "correct.",
    "2. Where an assertion genuinely moved, move it to a test that still " +
      "covers the behaviour rather than deleting it outright.",
    "3. Add each remaining removed assertion to the Test Plan in " +
      "`docs/archive/pr-summaries/pr-summary-<issue>.md`, copied as it " +
      "appears in the diff (whitespace differences are ignored), in this " +
      "shape:",
    "",
    "```markdown",
    "## Test Plan",
    "",
    "- Removed from `crates/api/tests/decisions.rs`: " +
      '`assert_eq!(record.score.to_string(), "-0.5")` — #2253 changes the ' +
      "score to a rating, so the old value is untrue",
    "- Moved `assertEquals(result.code, 0)` to " +
      "`worker/deno/tests/foo_test.ts::exits cleanly`",
    "```",
  );

  return lines.join("\n");
}
