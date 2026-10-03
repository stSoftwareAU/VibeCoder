/**
 * PR-summary branch-outcomes gate (Issue #3147).
 *
 * "Every outcome of a branch you add needs a test that reaches it" (rule
 * #3069) was prose only: nothing in the worker checked it. Fleet PRs shipped
 * a new branch with no test reaching it (GRQ-AutoTrader#2368,
 * VibeCoder#3132, #3065, #3068), review-fix rounds repeated the same gap on
 * their own rework, and #3132 went further — the PR summary named tests that
 * did not even exist in the branch.
 *
 * This module is the deterministic gate for that rule's artefact: a
 * `Branch outcomes:` list in the PR summary. It activates whenever a PR's
 * diff changes a file that is neither a test nor a documentation file (the
 * same trigger as `docs_sweep_gate.ts`), and then requires the list to be
 * present — either naming each outcome and the test that reaches it, or an
 * honest `none added` when the diff adds no branch — and requires every test
 * path the list names to actually exist at HEAD, so a fabricated citation
 * cannot pass.
 *
 * Modelled on `docs_sweep_gate.ts`: pure functions, hardcoded regexes (no
 * `new RegExp()` built from input), and a bounded scan of the PR summary —
 * agent-authored and steered by an untrusted issue body, so it is treated as
 * untrusted text throughout.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { codeChangingFiles } from "./docs_sweep_gate.ts";
import { isTestFilePath } from "./security_fix_gate.ts";
import type { Result } from "../types.ts";

/** Cap on untrusted text scanned by the gate's regexes (defence in depth). */
const MAX_SCAN_CHARS = 200_000;

/** Cap on one Branch-outcomes entry after continuation lines are joined. */
const MAX_ENTRY_CHARS = 4_000;

/** Cap on the number of entries parsed out of one list. */
const MAX_ENTRIES = 100;

/** Every line terminator, so a lone CR or Unicode separator cannot stay inside a line. */
const LINE_TERMINATOR_RE = /\r\n|[\n\r\u2028\u2029]/;

/** A list marker leading a line, stripped before matching. */
const LIST_MARKER_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;

/** A markdown heading. */
const HEADING_RE = /^\s{0,3}#{1,6}\s/;

/** The `Branch outcomes` prefix once markdown decoration is stripped. */
const BRANCH_OUTCOMES_PREFIX_RE = /^branch\s+outcomes\s*[:\-–—]/i;

/**
 * A markdown heading form of the header: `# Branch outcomes` (colon
 * optional). No trailing `\s*` before `$`: `stripDecoration` already trims
 * the line, and a second `\s*` adjacent to the optional `:?` let a long run
 * of spaces followed by a non-matching character backtrack quadratically
 * (PR #3160 review).
 */
const BRANCH_OUTCOMES_HEADING_RE = /^#{1,6}\s*branch\s+outcomes\s*:?$/i;

/**
 * Strip list marker and `*`/backtick decoration from a line.
 *
 * Underscore is deliberately NOT stripped here, unlike `docs_sweep_gate.ts`'s
 * decoration strip: a Branch-outcomes entry routinely cites a test path such
 * as `worker/deno/tests/foo_test.ts`, and stripping every underscore would
 * corrupt that path before `namedTestPaths` ever sees it.
 */
function stripDecoration(line: string): string {
  return line
    .replace(LIST_MARKER_RE, "")
    .replace(/[*`]/g, "")
    .trim();
}

/** Leading-space indent of a raw (undecorated) line. */
function leadingIndent(raw: string): number {
  const match = raw.match(/^\s*/);
  return match ? match[0].length : 0;
}

/** The `Branch outcomes` list parsed out of a PR summary. */
export interface BranchOutcomesRecord {
  /** Whether a `Branch outcomes` header was found at all. */
  present: boolean;
  /** Whether the header's inline body begins with the word `none`. */
  noneDeclared: boolean;
  /** The inline body after the header's separator (`""` for a heading form). */
  body: string;
  /** Parsed list entries (empty when `noneDeclared`, a heading, or no list follows). */
  entries: string[];
}

/** Whether a (decoration-stripped) body starts with the word `none`. */
function startsWithNone(body: string): boolean {
  return /^none\b/i.test(body.trim());
}

/**
 * Parse every `Branch outcomes` header in a PR summary. The first mention
 * does not decide alone: a later header's list is still collected, and the
 * lines an inline header wraps onto stay part of its body so a path on the
 * next line is still checked.
 */
export function parseBranchOutcomes(
  prSummaryContent: string,
): BranchOutcomesRecord {
  const raw = (prSummaryContent ?? "").slice(0, MAX_SCAN_CHARS);
  const lines = raw.split(LINE_TERMINATOR_RE);
  const entries: string[] = [];
  const bodyParts: string[] = [];
  let present = false;
  let onlyNone = true;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const stripped = stripDecoration(rawLine);
    const inlineMatch = stripped.match(BRANCH_OUTCOMES_PREFIX_RE);
    const heading = BRANCH_OUTCOMES_HEADING_RE.test(stripped);
    if (!inlineMatch && !heading) continue;

    present = true;
    const body = inlineMatch
      ? stripped.slice(inlineMatch[0].length).trim()
      : "";
    if (startsWithNone(body)) {
      if (body) bodyParts.push(body);
      continue;
    }

    onlyNone = false;
    if (body) bodyParts.push(body);
    const headerIndent = inlineMatch && LIST_MARKER_RE.test(rawLine)
      ? leadingIndent(rawLine)
      : -1;
    const collected = collectEntries(lines, i + 1, headerIndent);
    for (const entry of collected.entries) {
      if (entries.length >= MAX_ENTRIES) break;
      entries.push(entry);
    }
    if (collected.bodyExtra) bodyParts.push(collected.bodyExtra);
    i = collected.nextIndex - 1;
  }

  return {
    present,
    noneDeclared: present && onlyNone,
    body: bodyParts.join(" "),
    entries,
  };
}

/** Entries and wrapped body text that follow one `Branch outcomes` header. */
function collectEntries(
  lines: string[],
  startIndex: number,
  headerIndent: number,
): { entries: string[]; bodyExtra: string; nextIndex: number } {
  const entries: string[] = [];
  const wrap: string[] = [];
  let sawBlank = false;
  let wrapping = true;
  let j = startIndex;

  for (; j < lines.length; j++) {
    const line = lines[j]!;

    if (line.trim() === "") {
      sawBlank = true;
      wrapping = false;
      continue;
    }
    if (HEADING_RE.test(line)) break;

    const indent = leadingIndent(line);
    if (LIST_MARKER_RE.test(line)) {
      if (indent <= headerIndent) break;
      wrapping = false;
      if (entries.length >= MAX_ENTRIES) break;
      entries.push(capEntry(stripDecoration(line)));
      sawBlank = false;
      continue;
    }

    // A continuation of the previous entry, indented past the header.
    if (!sawBlank && entries.length > 0 && indent > headerIndent) {
      const lastIndex = entries.length - 1;
      entries[lastIndex] = capEntry(
        `${entries[lastIndex]} ${stripDecoration(line)}`.trim(),
      );
      continue;
    }

    // Lines an inline header wraps onto, before the first list item.
    if (entries.length === 0 && wrapping) {
      wrap.push(stripDecoration(line));
      continue;
    }

    if (entries.length === 0) continue;
    break;
  }

  return { entries, bodyExtra: wrap.join(" ").trim(), nextIndex: j };
}

/** Cap one entry's length. */
function capEntry(entry: string): string {
  return entry.length > MAX_ENTRY_CHARS
    ? entry.slice(0, MAX_ENTRY_CHARS)
    : entry;
}

/** URLs, excluded from token scanning so a link is never mistaken for a path. */
const URL_RE = /https?:\/\/\S+/g;

/** Characters (besides whitespace) that split a line into candidate tokens. */
const TOKEN_SPLIT_RE = /[\s`()[\],;"'<>|]+/;

/** A token shaped like a repo-relative path with an extension. */
const PATH_SHAPE_RE = /^[A-Za-z0-9_.\-\/]+\.[A-Za-z0-9]+$/;

/** Cap on a single token's length before it is considered a candidate path. */
const MAX_TOKEN_CHARS = 300;

/** Cap on the number of named test paths returned. */
const MAX_NAMED_TEST_PATHS = 50;

/**
 * Extract one candidate path token from a raw token: cut at the first `:`
 * (handles `path:42` and `path::name`), strip a leading `./` and trailing
 * `.`/`!` punctuation.
 */
function normaliseToken(token: string): string {
  const cut = token.split(":")[0] ?? "";
  let value = cut;
  if (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/[.!]+$/, "");
  return value;
}

/**
 * The test file paths named across a branch-outcomes record's entries (and
 * its inline body, when not `none added`).
 *
 * Only paths shaped like, and recognised as, a test file are returned — a
 * branch-location citation such as `worker/deno/lib/foo.ts:42` is not a test
 * file and is therefore not existence-checked here, and a Rust inline test
 * named only as `module::tests::name` (no test-file path at all) is simply
 * never checked by this gate.
 */
export function namedTestPaths(record: BranchOutcomesRecord): string[] {
  const texts = [...record.entries];
  if (!record.noneDeclared && record.body) texts.push(record.body);

  const found: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    const withoutUrls = text.replace(URL_RE, " ");
    for (const rawToken of withoutUrls.split(TOKEN_SPLIT_RE)) {
      if (!rawToken) continue;
      if (rawToken.length > MAX_TOKEN_CHARS) continue;
      const token = normaliseToken(rawToken);
      if (!token || token.startsWith("/")) continue;
      if (!PATH_SHAPE_RE.test(token)) continue;
      if (!isTestFilePath(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      found.push(token);
      if (found.length >= MAX_NAMED_TEST_PATHS) return found;
    }
  }

  return found;
}

/** Bare placeholder values the inline body is checked against. */
const PLACEHOLDER_VALUES = new Set([
  "tbd",
  "todo",
  "n/a",
  "na",
  "-",
  "—",
  "?",
]);

/** Cap on the value scanned by `isBarePlaceholder`'s trailing-decoration regex. */
const MAX_PLACEHOLDER_SCAN_CHARS = 64;

/**
 * Whether an inline body is a bare placeholder rather than a real entry or
 * an honest `none added`.
 */
function isBarePlaceholder(body: string): boolean {
  const normalised = body
    .trim()
    .slice(0, MAX_PLACEHOLDER_SCAN_CHARS)
    .replace(/[.!\s]+$/g, "")
    .toLowerCase();
  return PLACEHOLDER_VALUES.has(normalised);
}

/** Verdict of the branch-outcomes gate. */
export interface BranchOutcomesGateResult {
  /** True when the diff changes a non-test, non-doc file. */
  applicable: boolean;
  /** True when the gate passes (always true when not applicable). */
  valid: boolean;
  /** False when the changed-files list could not be read at all. */
  changedFilesKnown: boolean;
  /** The code-changing files found (empty when the list is unknown). */
  codeFiles: string[];
  /** The parsed `Branch outcomes` record. */
  record: BranchOutcomesRecord;
  /** Test paths named in the list. */
  namedTests: string[];
  /** Of `namedTests`, those not found at HEAD. */
  missingTests: string[];
  /** One line per rule broken — empty when the gate passes. */
  problems: string[];
}

/** Up to how many code files are named in a "no list" problem. */
const MAX_NAMED_CODE_FILES = 5;

/** Render the changed code files for a problem message. */
function describeCodeFiles(codeFiles: readonly string[]): string {
  const named = codeFiles.slice(0, MAX_NAMED_CODE_FILES).join(", ");
  const extra = codeFiles.length - MAX_NAMED_CODE_FILES;
  return extra > 0 ? `${named} and ${extra} more` : named;
}

/** Input to {@link validateBranchOutcomes}. */
export interface ValidateBranchOutcomesInput {
  /** The branch's changed files, or `null` when the diff could not be read. */
  changedFiles: readonly string[] | null;
  /** The PR summary content (or assembled body). */
  prSummaryContent: string;
  /**
   * Test file paths that exist at HEAD, or `null` when they could not be
   * confirmed. Only consulted when the list names at least one test path.
   */
  testsAtHead: ReadonlySet<string> | null;
}

/**
 * Verify that a PR summary records the outcomes a new branch adds, and that
 * every test it names actually exists at HEAD.
 *
 * Rules, all deterministic:
 *   1. `changedFiles === null` (the diff could not be read) → the gate
 *      APPLIES. Absence of evidence is not treated as a branch-free diff.
 *   2. A known changed-files list with no code-changing file → not
 *      applicable, valid.
 *   3. Applicable with no `Branch outcomes` list → blocked.
 *   4. Present and `none added` → valid.
 *   5. Present, not none, zero entries and an empty inline body → blocked
 *      (lists no outcomes).
 *   6. Present, not none, zero entries and a bare placeholder inline body →
 *      blocked.
 *   7. The list names at least one test path but `testsAtHead === null` →
 *      blocked (fail closed).
 *   8. A named test path absent from `testsAtHead` → blocked, named in
 *      `missingTests`.
 */
export function validateBranchOutcomes(
  input: ValidateBranchOutcomesInput,
): BranchOutcomesGateResult {
  const record = parseBranchOutcomes(input.prSummaryContent ?? "");

  if (input.changedFiles === null) {
    return evaluateApplicable(record, [], false, input.testsAtHead);
  }

  const codeFiles = codeChangingFiles(input.changedFiles);
  if (codeFiles.length === 0) {
    return {
      applicable: false,
      valid: true,
      changedFilesKnown: true,
      codeFiles: [],
      record,
      namedTests: [],
      missingTests: [],
      problems: [],
    };
  }

  return evaluateApplicable(record, codeFiles, true, input.testsAtHead);
}

/** Shared rule evaluation for the `changedFiles === null` and known cases. */
function evaluateApplicable(
  record: BranchOutcomesRecord,
  codeFiles: string[],
  changedFilesKnown: boolean,
  testsAtHead: ReadonlySet<string> | null,
): BranchOutcomesGateResult {
  const problems: string[] = [];
  const namedTests = namedTestPaths(record);
  const missingTests: string[] = [];

  if (!record.present) {
    const diffDescription = changedFilesKnown
      ? `code files (${describeCodeFiles(codeFiles)})`
      : "the changed files could not be read, so the list is required";
    problems.push(
      `the PR summary carries no \`Branch outcomes:\` list, but the diff changes ${diffDescription}`,
    );
  } else if (record.entries.length === 0 && record.body.trim() === "") {
    problems.push(
      "the `Branch outcomes:` list names no outcomes — list each outcome the diff adds, or write `Branch outcomes: none added`",
    );
  } else if (record.entries.length === 0 && isBarePlaceholder(record.body)) {
    problems.push(
      "the `Branch outcomes:` list's value is a bare placeholder — list each outcome and the test that reaches it, or write `Branch outcomes: none added`",
    );
  } else if (namedTests.length > 0 && testsAtHead === null) {
    problems.push(
      "the list names a test but the worker could not confirm the named tests exist at the head, so the list is unverifiable",
    );
  } else if (testsAtHead !== null) {
    for (const path of namedTests) {
      if (!testsAtHead.has(path)) missingTests.push(path);
    }
    if (missingTests.length > 0) {
      problems.push(
        `the \`Branch outcomes:\` list names a test that does not exist at ` +
          `the head: ${
            missingTests.join(", ")
          } — test paths are checked relative to the repository root ` +
          `(e.g. \`worker/deno/tests/foo_test.ts\`, not \`tests/foo_test.ts\`), ` +
          `not to the directory a test command runs from`,
      );
    }
  }

  return {
    applicable: true,
    valid: problems.length === 0,
    changedFilesKnown,
    codeFiles,
    record,
    namedTests,
    missingTests,
    problems,
  };
}

/**
 * Build the issue comment posted when the branch-outcomes gate blocks PR
 * creation. Names every rule broken and restates the required shape plus the
 * procedure, so the next attempt can fix the summary without re-deriving it.
 */
export function buildBranchOutcomesGateComment(
  result: BranchOutcomesGateResult,
): string {
  const problems = result.problems.map((problem) => `- ${problem}`).join("\n");
  return [
    "⚠️ **Branch outcomes not recorded.** This diff changes code, so the PR " +
    "summary must record every outcome the new branches add before the PR " +
    "is raised:",
    "",
    problems,
    "",
    "Procedure:",
    "",
    "1. For every new condition, match arm, exit-code check, or " +
    "trait/interface default this diff's branches add, list its outcomes — " +
    "success, absent/empty, error, fail-closed default, and so on.",
    "2. Name the test that reaches each outcome.",
    "3. Flip the outcome on purpose (break the guard, invert the condition) " +
    "and confirm the named test actually goes red. A test that stays green " +
    "either way does not reach the outcome.",
    "4. A review-fix commit must re-enumerate EVERY branch its own rework " +
    "adds and refresh the list to the current head — not only the branches " +
    "a review finding named.",
    "5. Every test path named in the list must exist at the head, named " +
    "relative to the **repository root** (e.g. `worker/deno/tests/foo_test.ts`, " +
    "not `tests/foo_test.ts`, even when the test command itself runs from a " +
    "subdirectory such as `worker/deno`) — a fabricated, stale, or " +
    "wrongly-relative citation blocks the PR.",
    "",
    "Add a `Branch outcomes` list to " +
    "`docs/archive/pr-summaries/pr-summary-<issue>.md` in this shape:",
    "",
    "```markdown",
    "**Branch outcomes:**",
    "- `worker/deno/lib/foo.ts:42` — error (unreadable file) — " +
    "`worker/deno/tests/foo_test.ts::rejects an unreadable file` — flipped " +
    "to success, test went red",
    "- `worker/deno/lib/foo.ts:48` — absent (no entries) — " +
    "`worker/deno/tests/foo_test.ts::returns empty for no entries` — " +
    "flipped to error, test went red",
    "```",
    "",
    "`**Branch outcomes:** none added` is the honest answer for a diff that " +
    "adds no branch.",
  ].join("\n");
}

/**
 * Look up which of the named test paths exist at `HEAD`, via
 * `git --literal-pathspecs ls-tree -r --name-only HEAD -- <paths...>`.
 *
 * `runGit` is invoked with the repository root as its working directory, so
 * every path in `paths` is resolved relative to the repository root — a
 * citation such as `tests/foo_test.ts` for a test actually at
 * `worker/deno/tests/foo_test.ts` reads as missing (Issue #3160), even though
 * `git ls-files tests/foo_test.ts` run from `worker/deno` would find it.
 *
 * Paths come from untrusted PR-summary text but are passed as argv entries
 * after `--`, never interpolated into a shell, and `--literal-pathspecs`
 * stops git treating any of them as a glob. Returns an empty set without
 * calling git when `paths` is empty (nothing to confirm), and returns `null`
 * (fail closed) on any error or non-zero exit.
 */
export async function lookupTestsAtHead(
  paths: readonly string[],
  runGit: (
    args: string[],
  ) => Promise<Result<{ code: number; stdout: string; stderr: string }>>,
): Promise<ReadonlySet<string> | null> {
  if (paths.length === 0) return new Set();

  const result = await runGit([
    "--literal-pathspecs",
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    ...paths,
  ]);

  if (!result.ok || result.value.code !== 0) return null;

  return new Set(
    result.value.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}
