/**
 * Pre-filled drafts for the mechanical completion summary gates (Issue #4234,
 * point 4).
 *
 * A recovery turn asked to write the Docs sweep line, the Branch outcomes
 * facts file and the removed-assertion Test Plan entries from memory tends to
 * invent the boilerplate. This module drafts that boilerplate from the diff,
 * so the turn confirms or corrects it instead. The formats follow what the
 * gates accept: `docs_sweep_gate.ts` (the Docs sweep line),
 * `branch_outcomes_gate.ts` and CODING-STANDARDS.md "Branch outcomes facts
 * file" (the facts JSON), and `removed_assertion_gate.ts` (the Test Plan
 * entries).
 *
 * No verdict is invented. Every part the diff cannot show is left as an
 * explicit `<…>` instruction, so the agent must complete it, and the header
 * tells the agent to confirm each line. A branch line is a scan candidate, not
 * a covered outcome: `flipWentRed` is for what the agent actually observed.
 *
 * Pure apart from the injected docs lookup: this module does no I/O. The
 * caller fences the whole block as untrusted, so only what the Markdown needs
 * is neutralised (backticks in removed-assertion text and file paths).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isTestFilePath } from "./security_fix_gate.ts";
import { codeChangingFiles, isDocsSweepExemptPath } from "./docs_sweep_gate.ts";

/** Cap on the total drafted text, including the truncation marker. */
const MAX_OUTPUT_CHARS = 6_000;

/** Explicit marker appended when the draft is clipped to {@link MAX_OUTPUT_CHARS}. */
const TRUNCATED_LINE = "\n(truncated)";

/** Heading the whole draft, so the agent knows it is not a verdict. */
const DRAFT_HEADER =
  "PRE-FILLED DRAFT — confirm or correct each line against the diff; do not copy blindly";

/** Cap on grep terms drafted for the Docs sweep line. */
const MAX_DOCS_TERMS = 8;

/** Shortest identifier drafted as a grep term. */
const MIN_TERM_CHARS = 4;

/** Branch candidate lines listed per file. */
const BRANCH_CAP_PER_FILE = 12;

/** Branch candidate lines listed across the whole diff. */
const BRANCH_CAP_TOTAL = 40;

/** Cap on a diff line scanned by a regex (defence in depth; untrusted text). */
const MAX_SCAN_LINE_CHARS = 4_000;

/** Cap on a branch candidate's source text shown in the draft. */
const MAX_BRANCH_TEXT_CHARS = 160;

/** Cap on a removed assertion's text shown in the draft. */
const MAX_REMOVED_TEXT_CHARS = 200;

/** Cap on a test name quoted in the draft. */
const MAX_TEST_NAME_CHARS = 200;

/** Inputs for {@link buildSummaryPrefill}. */
export interface SummaryPrefillInput {
  issueNumber: number;
  changedFiles: readonly string[];
  /** `git diff --unified=0 <base>...HEAD`, or null when it could not be read. */
  unifiedDiff: string | null;
  /** Removed assertions the removed-assertion gate found unaccounted for (RemovedAssertion[] shape: file,text). */
  removedUnaccounted: readonly { file: string; text: string }[];
  /** Which drafts to produce. */
  want: {
    docsSweep: boolean;
    branchOutcomes: boolean;
    removedAssertions: boolean;
  };
  /**
   * Doc paths (README/docs excluding docs/archive) whose text mentions `term`
   * as a whole word; injected so this module does no I/O.
   */
  docsMentioning: (term: string) => Promise<readonly string[]>;
}

/** One added line of a diff, with its new-side line number. */
interface AddedLine {
  line: number;
  text: string;
}

/** One file's added and removed lines out of a `--unified=0` diff. */
interface DiffFile {
  path: string;
  added: AddedLine[];
  removed: string[];
}

/** A hunk header, e.g. `@@ -12,3 +12,0 @@`. Counts default to 1 when omitted. */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Identifier definitions on a changed line: an exported declaration, a
 * `function NAME`, or a `const NAME =`. Hardcoded, never built from input.
 */
const IDENTIFIER_DEFINITION_RES: readonly RegExp[] = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /\bfunction\*?\s+([A-Za-z_$][\w$]*)/g,
  /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g,
];

/** A line holding a branch construct: `if (`, `else`, a ternary, `&&`, `||`, `case`, `catch`, `throw`, `return`. */
const BRANCH_CONSTRUCT_RE =
  /\bif\s*\(|\belse\b|\s\?\s|&&|\|\||\bcase\s|\bcatch\b|\bthrow\s|\breturn\b/;

/** A test declaration on an added line: `Deno.test("…"`, `it("…"`, `test("…"`. */
const TEST_NAME_RE = /(?:^|[^\w.$])(?:Deno\.test|it|test)\(\s*(["'])(.+?)\1/;

/** Strip a diff path's trailing tab, then an `a/` or `b/` prefix. */
function diffPath(raw: string): string {
  let path = raw.replace(/\t.*$/, "").trim();
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  return path;
}

/**
 * Parse a `--unified=0` diff into its files. Hunk bodies are consumed by their
 * counts, so an added line that starts `++ ` or a removed line that starts
 * `-- ` is never read as a header. A deleted file is named by its old path.
 */
function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldPath: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-") && oldLeft > 0) {
        oldLeft--;
        current?.removed.push(line.slice(1));
        continue;
      }
      if (line.startsWith("+") && newLeft > 0) {
        newLeft--;
        current?.added.push({ line: newLine, text: line.slice(1) });
        newLine++;
        continue;
      }
      if (line.startsWith(" ") && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        newLine++;
        continue;
      }
      if (line.startsWith("\\")) continue;
      // A malformed hunk: stop consuming its counts and read headers again.
      oldLeft = 0;
      newLeft = 0;
    }

    if (line.startsWith("diff --git ")) {
      current = null;
      oldPath = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = diffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = diffPath(line.slice(4));
      const path = newPath === "/dev/null" ? oldPath : newPath;
      if (path !== null && path !== "" && path !== "/dev/null") {
        current = { path, added: [], removed: [] };
        files.push(current);
      } else {
        current = null;
      }
      continue;
    }
    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk) {
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      newLine = Number(hunk[3]);
    }
  }

  return files;
}

/**
 * Identifiers the diff introduces or removes in non-test, non-doc code,
 * deduplicated in order of appearance, at least {@link MIN_TERM_CHARS} long,
 * and capped at {@link MAX_DOCS_TERMS}.
 */
function changedIdentifiers(files: readonly DiffFile[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (text: string) => {
    const scanned = text.slice(0, MAX_SCAN_LINE_CHARS);
    for (const re of IDENTIFIER_DEFINITION_RES) {
      for (const match of scanned.matchAll(re)) {
        const name = match[1]!;
        if (name.length < MIN_TERM_CHARS || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
      }
    }
  };
  for (const file of files) {
    if (isDocsSweepExemptPath(file.path)) continue;
    for (const added of file.added) visit(added.text);
    for (const removed of file.removed) visit(removed);
  }
  return names.slice(0, MAX_DOCS_TERMS);
}

/** A branch-construct line added to non-test, non-doc code. */
interface BranchCandidate {
  path: string;
  line: number;
  text: string;
}

/**
 * The added lines holding a branch construct, capped per file and in total.
 * `overflow` is true when a matching line was left out by a cap.
 */
function branchCandidates(files: readonly DiffFile[]): {
  candidates: BranchCandidate[];
  overflow: boolean;
} {
  const candidates: BranchCandidate[] = [];
  let overflow = false;
  for (const file of files) {
    if (isDocsSweepExemptPath(file.path)) continue;
    let perFile = 0;
    for (const added of file.added) {
      if (!BRANCH_CONSTRUCT_RE.test(added.text.slice(0, MAX_SCAN_LINE_CHARS))) {
        continue;
      }
      if (
        perFile >= BRANCH_CAP_PER_FILE || candidates.length >= BRANCH_CAP_TOTAL
      ) {
        overflow = true;
        break;
      }
      candidates.push({
        path: file.path,
        line: added.line,
        text: added.text.trim().slice(0, MAX_BRANCH_TEXT_CHARS),
      });
      perFile++;
    }
  }
  return { candidates, overflow };
}

/** Test names declared on lines added to changed test files, in order. */
function candidateTestNames(files: readonly DiffFile[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!isTestFilePath(file.path)) continue;
    for (const added of file.added) {
      const match = TEST_NAME_RE.exec(added.text.slice(0, MAX_SCAN_LINE_CHARS));
      if (!match) continue;
      const name = match[2]!.slice(0, MAX_TEST_NAME_CHARS);
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Remove the backticks a draft would otherwise break its own code spans on. */
function neutraliseBackticks(text: string): string {
  return text.replace(/`/g, "'");
}

/** The Docs sweep sub-block, or undefined when it is not requested or not applicable. */
async function docsSweepBlock(
  input: SummaryPrefillInput,
  files: readonly DiffFile[],
): Promise<string | undefined> {
  if (!input.want.docsSweep) return undefined;
  if (codeChangingFiles(input.changedFiles).length === 0) return undefined;

  const terms = changedIdentifiers(files);
  const hits: { term: string; docs: readonly string[] }[] = [];
  for (const term of terms) {
    hits.push({ term, docs: await input.docsMentioning(term) });
  }
  const firstDoc = hits.find((hit) => hit.docs.length > 0)?.docs[0];

  const grep = terms.length > 0
    ? terms.map((term) => `\`${term}\``).join(", ")
    : "<quote each removed or changed name in backticks>";
  const section = firstDoc !== undefined
    ? `\`${firstDoc}#<anchor — read that section and name its heading>\``
    : "none — <why no manual documents it>";
  const hitSummary = hits.length > 0
    ? hits.map((hit) => `\`${hit.term}\` in ${hit.docs.length} doc(s)`).join(
      ", ",
    )
    : "<no grep term was found in the diff>";

  const line = `**Docs sweep** — grep: ${grep}; section: ${section}; ` +
    "siblings: none — <why no existing set gained a member>; " +
    `updated: <leave for the agent>; hits: ${hitSummary}`;

  const docsLines = hits.length > 0
    ? [
      "Candidate docs to read (read each section; a grep hit is not a verdict):",
      ...hits.map((hit) =>
        hit.docs.length > 0
          ? `- \`${hit.term}\`: ${hit.docs.join(", ")}`
          : `- \`${hit.term}\`: no doc mentions it`
      ),
    ]
    : [
      "Candidate docs to read: none, because the diff names no term. Name the changed surface yourself and grep for it.",
    ];

  return ["#### Docs sweep", line, "", ...docsLines].join("\n");
}

/** The Branch outcomes sub-block, or undefined when it is not requested or the diff is unreadable. */
function branchOutcomesBlock(
  input: SummaryPrefillInput,
  files: readonly DiffFile[],
): string | undefined {
  if (!input.want.branchOutcomes || input.unifiedDiff === null) {
    return undefined;
  }

  const { candidates, overflow } = branchCandidates(files);
  const testFiles = [...new Set(input.changedFiles.filter(isTestFilePath))];
  const testFile = testFiles.length === 1
    ? testFiles[0]!
    : "<changed test file>";
  const testNames = candidateTestNames(files);

  const entries = candidates.map((candidate) => ({
    path: candidate.path,
    line: candidate.line,
    outcome: "<what this branch does>",
    test: testFile,
    testName: "<test name>",
    flipWentRed: "<what you observed when you flipped it>",
  }));
  const facts = {
    version: 1,
    branchOutcomes: { noneAdded: entries.length === 0, entries },
  };

  const candidateLines = candidates.length > 0
    ? candidates.map((c) => `- ${c.path}:${c.line}: ${c.text}`)
    : [
      "- none: this scan found no branch construct in non-test code. Confirm the diff adds no branch before writing `noneAdded: true`.",
    ];
  if (overflow) {
    candidateLines.push(
      `- (more branch lines exist; the list is capped at ${BRANCH_CAP_PER_FILE} per file and ${BRANCH_CAP_TOTAL} in total)`,
    );
  }

  const nameLines = testNames.length > 0
    ? testNames.map((name) => `- "${name}"`)
    : ["- none found in the changed test files: name the test you added."];

  return [
    "#### Branch outcomes",
    "Candidate branch lines the diff adds to non-test code (new-side line numbers; a scan, not a verdict):",
    ...candidateLines,
    "",
    "Candidate test names in the changed test files (use the one that goes red for each outcome):",
    ...nameLines,
    "",
    "Facts skeleton. Replace every `<…>`. `flipWentRed` must be what you actually observed when you flipped that branch, never a prediction.",
    "",
    "```json",
    JSON.stringify(facts),
    "```",
  ].join("\n");
}

/** The removed-assertion sub-block, or undefined when it is not requested or nothing is unaccounted. */
function removedAssertionsBlock(
  input: SummaryPrefillInput,
): string | undefined {
  if (!input.want.removedAssertions) return undefined;
  if (input.removedUnaccounted.length === 0) return undefined;

  const entries = input.removedUnaccounted.flatMap((assertion) => [
    `- Removed from \`${neutraliseBackticks(assertion.file)}\`: ${
      neutraliseBackticks(assertion.text.slice(0, MAX_REMOVED_TEXT_CHARS))
        .replace(/[\r\n]+/g, " ")
    }`,
    '  - Required by: "<quote of at least 5 words from the issue title or body>"',
    "  - Moved to: <destination path, or delete this line>",
    "  - Replaced by: <assertion on an added line in the same file, or delete this line>",
    "  Choose exactly one of Required by / Moved to / Replaced by, and delete the other two.",
  ]);

  return [
    "#### Removed assertions",
    "Each removed assertion below needs exactly one of the three lines, confirmed against the issue or the diff:",
    ...entries,
  ].join("\n");
}

/**
 * Build the pre-filled drafts a recovery turn confirms or corrects.
 *
 * Returns `""` when no draft was requested or applicable. Otherwise returns
 * Markdown headed {@link DRAFT_HEADER}, with one sub-block per requested draft,
 * clipped to {@link MAX_OUTPUT_CHARS} with an explicit `(truncated)` line.
 *
 * @throws RangeError when `issueNumber` is not a positive integer.
 */
export async function buildSummaryPrefill(
  input: SummaryPrefillInput,
): Promise<string> {
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new RangeError(
      `issueNumber must be a positive integer, got ${input.issueNumber}`,
    );
  }

  const files = input.unifiedDiff === null
    ? []
    : parseDiffFiles(input.unifiedDiff);

  const blocks: string[] = [];
  const docs = await docsSweepBlock(input, files);
  if (docs !== undefined) blocks.push(docs);
  const branch = branchOutcomesBlock(input, files);
  if (branch !== undefined) blocks.push(branch);
  const removed = removedAssertionsBlock(input);
  if (removed !== undefined) blocks.push(removed);

  if (blocks.length === 0) return "";

  const text = [DRAFT_HEADER, ...blocks].join("\n\n");
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS - TRUNCATED_LINE.length) +
    TRUNCATED_LINE;
}
