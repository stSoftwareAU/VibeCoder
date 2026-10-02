/**
 * PR-summary docs-sweep gate (Issue #3073).
 *
 * The fleet's PR-summary contract already asked every PR for a one-line
 * **Docs sweep** entry, but nothing in the worker checked it, so the line was
 * entirely self-certified. Worse, a term-only grep sweep still missed the
 * manual that actually documents the changed surface on GRQ-AutoTrader#2231
 * and #2239 — a stale sentence survived because the grep found no renamed
 * term to chase, not because the manual was read — and #2227 raised a PR with
 * no Docs sweep line at all.
 *
 * This module is the deterministic gate for that line. It activates whenever
 * a PR's diff changes a file that is neither a test nor a documentation file,
 * and then requires the PR summary to carry a **Docs sweep** line that names
 * the manual **section** documenting the changed surface — not merely that a
 * grep was run. `section: none — <why no manual documents it>` is accepted as
 * the honest negative; a bare placeholder (`none`, `tbd`, `n/a`, …) is not.
 *
 * Modelled on `reproduction_status_gate.ts`: pure functions only, hardcoded
 * regexes (no `new RegExp()` built from input), and a bounded scan of the
 * summary — which is agent-authored and steered by an untrusted issue body,
 * so it is treated as untrusted text throughout.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isTestFilePath } from "./security_fix_gate.ts";

/** Cap on untrusted text scanned by the gate's regexes (defence in depth). */
const MAX_SCAN_CHARS = 200_000;

/** Documentation file extensions, matched case-insensitively. */
const DOC_EXTENSION_RE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;

/** A `docs/` path segment anywhere in the path (root `docs/…` or nested). */
const DOCS_SEGMENT_RE = /(^|\/)docs\//i;

/**
 * Whether a repo-relative path is exempt from the docs-sweep gate: a test
 * file, a documentation file, or empty (nothing to sweep).
 */
export function isDocsSweepExemptPath(path: string): boolean {
  const trimmed = (path ?? "").trim();
  if (trimmed === "") return true;
  if (isTestFilePath(trimmed)) return true;
  if (DOC_EXTENSION_RE.test(trimmed)) return true;
  if (DOCS_SEGMENT_RE.test(trimmed)) return true;
  return false;
}

/** The non-exempt (code-changing) paths out of a changed-files list. */
export function codeChangingFiles(changedFiles: readonly string[]): string[] {
  return changedFiles.filter((path) => !isDocsSweepExemptPath(path));
}

/** The `Docs sweep` line parsed out of a PR summary. */
export interface DocsSweepLine {
  /** Whether a `Docs sweep` line was found at all. */
  present: boolean;
  /** The text after the separator (e.g. `grep: ...; section: ...`). */
  body: string;
  /** The value of the `section:` (or `sections:`) field, `""` when absent. */
  section: string;
}

/** A list marker leading a line, stripped before matching. */
const LIST_MARKER_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;

/**
 * The `Docs sweep` prefix once markdown decoration is stripped: the words,
 * optional space, then a separator. The body is the slice after that
 * prefix, not a `.+` up to `$`, so a long space run before a lone CR
 * cannot make the match backtrack (Issue #3085 review).
 */
const DOCS_SWEEP_PREFIX_RE = /^docs\s+sweep\s*[:\-–—]/i;

/** Every line terminator, so a lone CR or Unicode separator cannot stay inside a line. */
const LINE_TERMINATOR_RE = /\r\n|[\n\r\u2028\u2029]/;

/** The `section:` / `sections:` field inside a Docs sweep line's body. */
const SECTION_FIELD_RE = /\bsections?\s*:\s*([^;]+)/i;

/** Trailing/leading backtick and whitespace trim for an extracted value. */
function trimDecoration(value: string): string {
  return value.trim().replace(/^`+|`+$/g, "").trim();
}

/** Strip list marker and `*`, `_`, backtick decoration from a line. */
function stripDecoration(line: string): string {
  return line
    .replace(LIST_MARKER_RE, "")
    .replace(/[*_`]/g, "")
    .trim();
}

/**
 * Parse the first `Docs sweep` line out of a PR summary. First match wins.
 */
export function parseDocsSweepLine(prSummaryContent: string): DocsSweepLine {
  const lines = (prSummaryContent ?? "")
    .slice(0, MAX_SCAN_CHARS)
    .split(LINE_TERMINATOR_RE);

  for (const raw of lines) {
    const stripped = stripDecoration(raw);
    const prefix = stripped.match(DOCS_SWEEP_PREFIX_RE);
    if (!prefix) continue;
    const body = stripped.slice(prefix[0].length).trim();
    if (body === "") continue;
    // The section value is read from the line's (decoration-stripped) body,
    // trimmed of surrounding backtick/whitespace decoration left after the
    // global strip, so `section: \`docs/x.md#y\`` reads as `docs/x.md#y`.
    const sectionMatch = body.match(SECTION_FIELD_RE);
    const section = sectionMatch ? trimDecoration(sectionMatch[1]!) : "";
    return { present: true, body, section };
  }

  return { present: false, body: "", section: "" };
}

/** Bare placeholder values for `section:` that name no manual (Issue #3073). */
const SECTION_PLACEHOLDER_VALUES = new Set([
  "none",
  "n/a",
  "na",
  "tbd",
  "todo",
  "-",
  "—",
  "?",
]);

/**
 * Cap on the value scanned by `isBarePlaceholder`'s trailing-decoration
 * regex. Every real placeholder in `SECTION_PLACEHOLDER_VALUES` is a single
 * short word, so a value longer than this can never equal one after
 * trimming — capping first bounds the regex to a fixed-size input instead of
 * letting it run (quadratically, via backtracking on an unanchored trailing
 * run of `.`/`!`/whitespace) over up to `MAX_SCAN_CHARS` of agent-written,
 * issue-steered text (Issue #3085 review; CODING-STANDARDS "Guard
 * super-linearity by behaviour first").
 */
const MAX_PLACEHOLDER_SCAN_CHARS = 64;

/**
 * Whether a `section:` value is a bare placeholder rather than an honest
 * negative — `none` alone names nothing, but `none — no manual documents
 * this flag` explains the gap and is accepted.
 */
function isBarePlaceholder(section: string): boolean {
  const normalised = section
    .trim()
    .slice(0, MAX_PLACEHOLDER_SCAN_CHARS)
    .replace(/[.!\s]+$/g, "")
    .toLowerCase();
  return SECTION_PLACEHOLDER_VALUES.has(normalised);
}

/** Verdict of the docs-sweep gate. */
export interface DocsSweepGateResult {
  /** True when the diff changes a non-test, non-doc file. */
  applicable: boolean;
  /** True when the gate passes (always true when not applicable). */
  valid: boolean;
  /** False when the changed-files list could not be read at all. */
  changedFilesKnown: boolean;
  /** The code-changing files found (empty when the list is unknown). */
  codeFiles: string[];
  /** The parsed `Docs sweep` line. */
  line: DocsSweepLine;
  /** One line per rule broken — empty when the gate passes. */
  problems: string[];
}

/** Up to how many code files are named in a "no Docs sweep line" problem. */
const MAX_NAMED_CODE_FILES = 5;

/** Render the changed code files for a problem message. */
function describeCodeFiles(codeFiles: readonly string[]): string {
  const named = codeFiles.slice(0, MAX_NAMED_CODE_FILES).join(", ");
  const extra = codeFiles.length - MAX_NAMED_CODE_FILES;
  return extra > 0 ? `${named} and ${extra} more` : named;
}

/**
 * Verify that a PR summary records a docs sweep naming the manual section
 * that documents the changed surface.
 *
 * Rules, all deterministic:
 *   1. `changedFiles === null` (the diff could not be read) → the gate
 *      APPLIES. Absence of evidence is not treated as a docs-free diff.
 *   2. A known changed-files list with no code-changing file → not
 *      applicable, valid.
 *   3. Applicable with no `Docs sweep` line → blocked.
 *   4. A line present but naming no `section:` → blocked.
 *   5. A `section:` that is a bare placeholder (`none`, `tbd`, …) → blocked;
 *      an explained negative (`none — <why>`) is accepted.
 *
 * @param opts.changedFiles - The branch's changed files, or `null` when the
 *   diff could not be collected.
 * @param opts.prSummaryContent - The PR summary content (or assembled body).
 */
export function validateDocsSweep(opts: {
  changedFiles: readonly string[] | null;
  prSummaryContent: string;
}): DocsSweepGateResult {
  const line = parseDocsSweepLine(opts.prSummaryContent ?? "");

  if (opts.changedFiles === null) {
    return evaluateApplicable(line, [], false);
  }

  const codeFiles = codeChangingFiles(opts.changedFiles);
  if (codeFiles.length === 0) {
    return {
      applicable: false,
      valid: true,
      changedFilesKnown: true,
      codeFiles: [],
      line,
      problems: [],
    };
  }

  return evaluateApplicable(line, codeFiles, true);
}

/** Shared rule evaluation for the `changedFiles === null` and known cases. */
function evaluateApplicable(
  line: DocsSweepLine,
  codeFiles: string[],
  changedFilesKnown: boolean,
): DocsSweepGateResult {
  const problems: string[] = [];

  if (!line.present) {
    const diffDescription = changedFilesKnown
      ? `code files (${describeCodeFiles(codeFiles)})`
      : "the changed files could not be read, so the line is required";
    problems.push(
      `the PR summary carries no \`Docs sweep\` line, but the diff changes ${diffDescription}`,
    );
  } else if (line.section === "") {
    problems.push(
      "the `Docs sweep` line names no `section:` — the manual section that documents the surface this change touches",
    );
  } else if (isBarePlaceholder(line.section)) {
    problems.push(
      "the `Docs sweep` line's `section:` is a bare placeholder — say which manual documents the surface, or write `section: none — <why no manual documents it>`",
    );
  }

  return {
    applicable: true,
    valid: problems.length === 0,
    changedFilesKnown,
    codeFiles,
    line,
    problems,
  };
}

/**
 * Build the issue comment posted when the docs-sweep gate blocks PR creation.
 *
 * Names every rule broken and restates the required shape plus the sweep
 * procedure, so the next attempt can fix the summary without re-deriving it.
 */
export function buildDocsSweepGateComment(
  result: DocsSweepGateResult,
): string {
  const problems = result.problems.map((problem) => `- ${problem}`).join("\n");
  return [
    "⚠️ **Docs sweep missing.** This diff changes code, so the PR summary " +
    "must record the docs sweep before the PR is raised:",
    "",
    problems,
    "",
    "Procedure:",
    "",
    "1. Grep `README.md`, `docs/` (excluding `docs/archive/`) and every " +
    "`*/README.md` for each removed or changed name, and for the removed " +
    "user-visible wording.",
    "2. ALSO find the manual section that documents the changed surface by " +
    "grepping for the surface's own name — the card or page title for a UI " +
    "component, the route for an endpoint, the report or command name for a " +
    "query or read path — even when no name changed.",
    "3. Read that section through and fix every sentence the change makes " +
    "false. Clear a grep hit only after reading the sentence it is in, " +
    "never by the file's topic.",
    "4. Fixing a stale doc found this way is part of this fix — it is a " +
    "docs change, not a code change — and is committed along with the " +
    "summary.",
    "",
    "Add a `Docs sweep` line to " +
    "`docs/archive/pr-summaries/pr-summary-<issue>.md` in this shape:",
    "",
    "```markdown",
    '**Docs sweep** — grep: `ProposalStore::list`, "one session at a ' +
    'time"; section: `docs/reporting-api.md#decisions-report`; updated: ' +
    "`docs/reporting-api.md`",
    "**Docs sweep** — grep: `retryLimit`; section: " +
    "`docs/workflows/retries.md#retry-limit`; no hits",
    "```",
    "",
    "`section: none — <reason>` is the honest answer when no manual " +
    "documents the surface — a bare `none` is not accepted.",
  ].join("\n");
}
