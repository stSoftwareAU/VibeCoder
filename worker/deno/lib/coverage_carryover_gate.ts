/**
 * Coverage carry-over gate (Issue #3795).
 *
 * A PR that removes or edits an existing Deno test can silently drop the only
 * test that reaches a production line. This module holds the pure half of the
 * check: diff parsing, lcov parsing, the base-to-head line mapping, the verdict
 * and the feedback comment. All process and filesystem work lives in
 * `coverage_carryover_runner.ts`.
 *
 * The runner runs the base versions of the touched tests under line coverage
 * at the merge base, keeps the production lines they reached that are still
 * present and unchanged at head, and reports every carried line that no head
 * test reaches.
 *
 * Known limit: the head side counts only tests that import a module directly,
 * plus the head versions of the touched tests. A line reached only indirectly
 * (through another module) is therefore reported uncovered, and can be
 * exempted in the PR summary.
 *
 * Every pattern here is anchored and bounded (fixed-width digit runs, no
 * overlapping quantifiers), so a hostile diff or lcov line cannot cause
 * backtracking.
 *
 * Australian English spelling used throughout.
 */

import { isDenoTestFile, parseMutationExemptions } from "./mutation_gate.ts";

/** A production line, as a head path and head line number. */
export interface CarriedLine {
  file: string;
  line: number;
}

export type CoverageCarryOverResult =
  | { kind: "not_applicable"; reason: string }
  | {
    kind: "completed";
    changedTests: string[];
    carried: number;
    uncovered: CarriedLine[];
  }
  | {
    kind: "budget_exhausted";
    changedTests: string[];
    budgetSeconds: number;
  }
  | { kind: "error"; reason: string };

export interface CoverageCarryOverVerdict {
  blocked: boolean;
  reason: string;
  uncovered: CarriedLine[];
  exempted: CarriedLine[];
  note: string;
}

export const DEFAULT_COVERAGE_CARRYOVER_BUDGET_SECONDS = 600;

/** The feedback comment spells out at most this many uncovered lines. */
const MAX_LISTED_LINES = 40;

/** `@@ -os[,oc] +ns[,nc] @@`; an omitted count means one. */
const HUNK_HEADER =
  /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@/;
/** An lcov `DA:line,hits[,checksum]` record. */
const LCOV_DA = /^DA:(\d{1,9}),(\d{1,9})/;

export interface Hunk {
  /** First old line the hunk touches; for `oc === 0`, the line it follows. */
  os: number;
  /** Old line count. */
  oc: number;
  /** New line count. */
  nc: number;
}

/** One file's entry in a `--unified=0 --no-renames` diff. */
export interface FileDiff {
  /** Base path, or null when the file is new. */
  base: string | null;
  /** Head path, or null when the file is deleted. */
  head: string | null;
  /** True for a `Binary files ... differ` section: its lines cannot be mapped. */
  binary: boolean;
  hunks: Hunk[];
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

function blankEntry(): FileDiff {
  return { base: null, head: null, binary: false, hunks: [] };
}

/** The `diff --git a/X b/X` header; with `--no-renames` both paths agree. */
function headerEntry(line: string): FileDiff {
  const rest = line.slice("diff --git ".length);
  const split = rest.indexOf(" b/");
  const entry = blankEntry();
  if (split >= 0 && rest.startsWith("a/")) {
    entry.base = rest.slice(2, split);
    entry.head = rest.slice(split + 3);
  }
  return entry;
}

/** A `---` or `+++` path: null for `/dev/null`, else the path without its prefix. */
function sidePath(raw: string, prefix: string): string | null {
  let p = raw;
  const tab = p.indexOf("\t");
  if (tab >= 0) p = p.slice(0, tab);
  if (p === "/dev/null") return null;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Parse `git diff --unified=0 --no-renames` output into base path -> file
 * entry. Entries for files absent at base (`--- /dev/null`) are left out, as no
 * base line can name them. Hunk counts are honoured, so an added or removed
 * line whose content begins with `++` or `--` is not read as a header.
 */
export function parseFileHunks(diff: string): Map<string, FileDiff> {
  const entries: FileDiff[] = [];
  const cursor: { entry: FileDiff | null } = { entry: null };
  const open = (): FileDiff => {
    if (cursor.entry === null) {
      cursor.entry = blankEntry();
      entries.push(cursor.entry);
    }
    return cursor.entry;
  };
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (oldRemaining > 0 || newRemaining > 0) {
      const c = line.charAt(0);
      if (c === "+") {
        newRemaining--;
        continue;
      }
      if (c === "-") {
        oldRemaining--;
        continue;
      }
      if (c === " " || line === "") {
        oldRemaining--;
        newRemaining--;
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file"
      // Anything else ends the hunk early; fall through to header handling.
      oldRemaining = 0;
      newRemaining = 0;
    }
    if (line.startsWith("diff --git ")) {
      cursor.entry = headerEntry(line);
      entries.push(cursor.entry);
      continue;
    }
    if (line.startsWith("--- ")) {
      open().base = sidePath(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      open().head = sidePath(line.slice(4), "b/");
      continue;
    }
    const m = HUNK_HEADER.exec(line);
    if (m !== null) {
      const oc = m[2] === undefined ? 1 : Number(m[2]);
      const nc = m[4] === undefined ? 1 : Number(m[4]);
      open().hunks.push({ os: Number(m[1]), oc, nc });
      oldRemaining = oc;
      newRemaining = nc;
      continue;
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      open().binary = true;
    }
  }
  const out = new Map<string, FileDiff>();
  for (const entry of entries) {
    if (entry.base !== null) out.set(entry.base, entry);
  }
  return out;
}

/** `tests/` or any `.../tests/` directory, for a `.rs` file. */
function isRustTestPath(path: string): boolean {
  return path.endsWith(".rs") &&
    (path.startsWith("tests/") || path.includes("/tests/"));
}

/** Does the entry delete the file or remove at least one line of it? */
function removesLines(entry: FileDiff): boolean {
  return entry.head === null || entry.hunks.some((h) => h.oc > 0);
}

/**
 * Base paths of Deno test files (isDenoTestFile) the diff deletes or removes at
 * least one line from. Pure additions to a test file do not count. Sorted, de-
 * duplicated.
 */
export function removedOrEditedTestFiles(diff: string): string[] {
  const out = new Set<string>();
  for (const [base, entry] of parseFileHunks(diff)) {
    if (isDenoTestFile(base) && removesLines(entry)) out.add(base);
  }
  return [...out].sort();
}

/** Does the diff delete or remove lines from a Rust file under a `tests/` directory? */
export function removesRustTestLines(diff: string): boolean {
  for (const [base, entry] of parseFileHunks(diff)) {
    if (isRustTestPath(base) && removesLines(entry)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Coverage and line mapping
// ---------------------------------------------------------------------------

/**
 * lcov text -> Map<SF path, Map<line, hit count>> from the DA records. A file
 * that appears in more than one record has its hit counts summed.
 */
export function parseLcov(lcov: string): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  let file: Map<number, number> | null = null;
  for (const raw of lcov.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("SF:")) {
      const path = line.slice(3);
      file = out.get(path) ?? new Map<number, number>();
      out.set(path, file);
    } else if (line === "end_of_record") {
      file = null;
    } else if (file !== null && line.startsWith("DA:")) {
      const m = LCOV_DA.exec(line);
      if (m === null) continue;
      const n = Number(m[1]);
      file.set(n, (file.get(n) ?? 0) + Number(m[2]));
    }
  }
  return out;
}

/**
 * Map a base line through the parsed diff to its head position. Null when the
 * file is deleted at head, is binary, or the line falls in a removed or changed
 * range. A file the diff does not touch maps to itself.
 */
export function mapLine(
  parsed: Map<string, FileDiff>,
  file: string,
  line: number,
): CarriedLine | null {
  const entry = parsed.get(file);
  if (entry === undefined) return { file, line };
  if (entry.head === null || entry.binary) return null;
  let shift = 0;
  for (const h of entry.hunks) {
    // An insertion (oc === 0) follows old line os, so it moves only later lines.
    const end = h.oc === 0 ? h.os : h.os + h.oc - 1;
    if (h.oc > 0 && line >= h.os && line <= end) return null;
    if (line > end) shift += h.nc - h.oc;
  }
  return { file: entry.head, line: line + shift };
}

/**
 * Map a base (file, line) through `diff` to head. See {@link mapLine}. Parses
 * the diff on every call; use {@link parseFileHunks} with {@link mapLine} when
 * mapping many lines.
 */
export function mapBaseLineToHead(
  diff: string,
  file: string,
  line: number,
): CarriedLine | null {
  return mapLine(parseFileHunks(diff), file, line);
}

// ---------------------------------------------------------------------------
// Verdict and comment
// ---------------------------------------------------------------------------

/** Verdict for a coverage carry-over result, honouring PR-summary exemptions. */
export function evaluateCoverageCarryOverGate(
  result: CoverageCarryOverResult,
  prSummary: string,
): CoverageCarryOverVerdict {
  if (result.kind === "not_applicable") {
    return {
      blocked: false,
      reason: "",
      uncovered: [],
      exempted: [],
      note: `coverage carry-over check not applicable: ${result.reason}`,
    };
  }
  if (result.kind === "error") {
    return {
      blocked: true,
      reason:
        `coverage carry-over check failed to run (${result.reason}); fix the error or set skip_coverage_carryover_check for this repo`,
      uncovered: [],
      exempted: [],
      note: "",
    };
  }
  if (result.kind === "budget_exhausted") {
    return {
      blocked: false,
      reason: "",
      uncovered: [],
      exempted: [],
      note:
        `coverage carry-over budget exhausted (${result.budgetSeconds} s) — lines the edited or removed tests reached were not checked, not passed`,
    };
  }
  const exemptions = parseMutationExemptions(prSummary);
  const uncovered: CarriedLine[] = [];
  const exempted: CarriedLine[] = [];
  for (const u of result.uncovered) {
    const isExempt = exemptions.some((e) =>
      e.file === u.file && e.line === u.line
    );
    (isExempt ? exempted : uncovered).push(u);
  }
  const note = `${
    result.carried - result.uncovered.length
  } of ${result.carried} carried-over lines still covered`;
  if (uncovered.length > 0) {
    return {
      blocked: true,
      reason:
        `${uncovered.length} line(s) the edited or removed tests reached are no longer reached by any test`,
      uncovered,
      exempted,
      note,
    };
  }
  return { blocked: false, reason: "", uncovered, exempted, note };
}

/** Drops backticks and folds line breaks, so text cannot break the markdown. */
function mdSafe(s: string): string {
  return s.replaceAll("`", "").replace(/[\r\n]+/g, " ");
}

/** Markdown feedback for the agent when the gate blocks. */
export function buildCoverageCarryOverGateComment(
  verdict: CoverageCarryOverVerdict,
): string {
  const out: string[] = [
    "## Coverage carry-over: lines the edited or removed tests reached are untested",
    "",
  ];
  out.push(verdict.reason ? mdSafe(verdict.reason) + "." : "");
  out.push("");
  if (verdict.uncovered.length > 0) {
    out.push(
      "The base versions of the edited or removed tests reached these lines, and no head test reaches them:",
      "",
    );
    for (const u of verdict.uncovered.slice(0, MAX_LISTED_LINES)) {
      out.push(`- \`${mdSafe(u.file)}:${u.line}\``);
    }
    const more = verdict.uncovered.length - MAX_LISTED_LINES;
    if (more > 0) out.push(`… and ${more} more`);
    out.push(
      "",
      "Add a test that reaches each line, remove the line if it is now dead code, or record " +
        "`file:line` exempt (untestable): <reason> in the PR summary.",
    );
  }
  return out.join("\n").trimEnd() + "\n";
}
