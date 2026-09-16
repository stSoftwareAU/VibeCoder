/**
 * Markdown table primitives shared by the deterministic plan gates
 * (Issue #2172).
 *
 * Two gates now read a table a model published on the planning parent — the
 * plan-coverage gate (`plan_coverage_gate.ts`, Issue #520) and the milestone
 * groups gate (`plan_milestone_groups.ts`, Issue #2172) — and both must locate
 * their table by its **header signature** rather than by the heading above it,
 * so a reworded heading cannot hide the table and the adjacent table is never
 * mistaken for it.
 *
 * The row and separator patterns live here rather than in either gate because
 * they carry hard-won bounds analysis (Issue #1245): two shapes of
 * `SEPARATOR_RE` have been quadratic on attacker-writable comment bodies. One
 * copy means one place to keep linear, and `plan_coverage_gate_bounds_1245_test.ts`
 * keeps guarding it through its caller.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Characters of one candidate scanned for a table (Issue #1245).
 *
 * Every comment on a planning parent is attacker-influenceable — a comment
 * body is writable by any account on a public repository — and the gates
 * re-read them on every planning close. A published gate table is a few
 * hundred characters, so a bounded scan loses nothing real and keeps an
 * oversized body cheap to reject. Callers **reject** rather than truncate:
 * half a table is not a table.
 */
export const MAX_TABLE_SCAN_CHARS = 64 * 1024;

/**
 * Is this candidate too large to scan for a table?
 *
 * The single expression of the cap, so a pure extractor and the gate that
 * reports the skip cannot drift apart (Issue #1245).
 */
export function exceedsTableScanCap(markdown: string): boolean {
  return markdown.length > MAX_TABLE_SCAN_CHARS;
}

// A table row line: starts with an optional indent then a pipe.
const ROW_RE = /^\s{0,3}\|/;

/**
 * A separator row, e.g. `| --- | :--- | ---: |`.
 *
 * Read as: a leading pipe, one cell, then any number of `|`-prefixed cells,
 * then an optional closing pipe. A cell is a single `-+` run with optional
 * alignment colons and surrounding whitespace.
 *
 * **No two quantifiers here can consume the same character** — every
 * whitespace run is bounded by a literal `|`, a `-`, a `:` or the anchor, so
 * a failing match backtracks linearly rather than exploring splits. Two
 * shapes have been quadratic on this line (Issue #1245): the original
 * `[\s:|-]*-[\s:|-]*` (adjacent classes both containing `-`, 5.4 s on 40 000
 * dashes), and a `\s*\|?\s*$` tail (adjacent whitespace runs either side of
 * an optional pipe, 4.2 s on 64 000 spaces). The closing pipe therefore
 * carries its own trailing whitespace — `(?:\|\s*)?$`, never `\|?\s*$`.
 */
const SEPARATOR_RE = /^\s{0,3}\|\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*(?:\|\s*)?$/;

/** Split one markdown table row into trimmed cells, honouring `\|` escapes. */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

/** One located markdown table: its header cells and its data rows. */
export interface MarkdownTable {
  /** Trimmed header cells, in published order. */
  headers: string[];
  /** Data rows, each split into trimmed cells. */
  rows: string[][];
}

/**
 * Find the first table in `markdown` whose header cells satisfy `matches`.
 *
 * Tables whose headers do not match are **skipped, not returned** — that is
 * what lets one gate ignore the other gate's adjacent table, and any unrelated
 * table, without depending on the heading above it.
 *
 * A blob longer than {@link MAX_TABLE_SCAN_CHARS} is rejected rather than
 * scanned: the candidates are attacker-influenceable and a genuine gate table
 * is never that large.
 *
 * @returns The matching table (its `rows` possibly empty for a header-only
 *   table), or `null` when no table matches or the blob exceeds the cap.
 */
export function findMarkdownTable(
  markdown: string,
  matches: (headers: string[]) => boolean,
): MarkdownTable | null {
  if (exceedsTableScanCap(markdown)) return null;
  const lines = markdown.split(/\r?\n/);

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (!ROW_RE.test(line) || SEPARATOR_RE.test(line)) continue;
    if (!SEPARATOR_RE.test(lines[i + 1]!)) continue;

    const headers = splitTableRow(line);
    if (!matches(headers)) continue;

    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const rowLine = lines[j]!;
      if (!ROW_RE.test(rowLine)) break;
      if (SEPARATOR_RE.test(rowLine)) continue;
      rows.push(splitTableRow(rowLine));
    }
    return { headers, rows };
  }

  return null;
}
