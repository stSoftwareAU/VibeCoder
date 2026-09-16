/**
 * Tests for markdown_table.ts — the table primitives the plan gates share
 * (Issue #2172).
 *
 * The module exists so one hardened separator pattern serves every gate that
 * parses a table out of an attacker-writable comment body (Issue #1245), and
 * so a gate can **skip** a table whose headers are not its own rather than
 * parsing the neighbouring gate's table as its own. Both contracts are pinned
 * here directly rather than only through their callers.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  exceedsTableScanCap,
  findMarkdownTable,
  MAX_TABLE_SCAN_CHARS,
  splitTableRow,
} from "../lib/markdown_table.ts";

/** Header predicate: the table has a column matching each pattern. */
function hasColumns(...patterns: RegExp[]): (headers: string[]) => boolean {
  return (headers) => patterns.every((p) => headers.some((h) => p.test(h)));
}

// ---------------------------------------------------------------------------
// splitTableRow
// ---------------------------------------------------------------------------

Deno.test("splitTableRow - splits on pipes and trims every cell", () => {
  assertEquals(splitTableRow("|  a |  b  | c |"), ["a", "b", "c"]);
});

Deno.test("splitTableRow - keeps an escaped pipe inside its cell", () => {
  assertEquals(splitTableRow("| a \\| b | c |"), ["a | b", "c"]);
});

Deno.test("splitTableRow - a row without outer pipes still splits", () => {
  assertEquals(splitTableRow("a | b"), ["a", "b"]);
});

Deno.test("splitTableRow - an empty cell survives as an empty string", () => {
  assertEquals(splitTableRow("| a |  | c |"), ["a", "", "c"]);
});

// ---------------------------------------------------------------------------
// exceedsTableScanCap
// ---------------------------------------------------------------------------

Deno.test("exceedsTableScanCap - reports only blobs past the cap", () => {
  assertEquals(exceedsTableScanCap("x".repeat(MAX_TABLE_SCAN_CHARS)), false);
  assertEquals(exceedsTableScanCap("x".repeat(MAX_TABLE_SCAN_CHARS + 1)), true);
});

// ---------------------------------------------------------------------------
// findMarkdownTable
// ---------------------------------------------------------------------------

Deno.test("findMarkdownTable - returns the headers and the data rows", () => {
  const table = findMarkdownTable(
    `Some prose.

| Ask | Covered by |
| --- | --- |
| Do the thing | #7 |
| Do the other | #8 |

More prose.`,
    hasColumns(/ask/i),
  );
  assert(table !== null);
  assertEquals(table.headers, ["Ask", "Covered by"]);
  assertEquals(table.rows, [["Do the thing", "#7"], ["Do the other", "#8"]]);
});

Deno.test("findMarkdownTable - skips a non-matching table and keeps scanning", () => {
  // The contract the gates depend on: the coverage table sits above the
  // milestones table in the same comment, and each gate must reach its own.
  const table = findMarkdownTable(
    `| Ask | Covered by |
| --- | --- |
| Do the thing | #7 |

| Milestone | File area |
| --- | --- |
| infra | infra/ |
`,
    hasColumns(/milestone/i),
  );
  assert(table !== null);
  assertEquals(table.headers, ["Milestone", "File area"]);
  assertEquals(table.rows, [["infra", "infra/"]]);
});

Deno.test("findMarkdownTable - returns null when no table matches", () => {
  assertEquals(
    findMarkdownTable(
      "| Name | Value |\n| --- | --- |\n| a | b |\n",
      hasColumns(/milestone/i),
    ),
    null,
  );
  assertEquals(findMarkdownTable("no table at all", hasColumns(/ask/i)), null);
});

Deno.test("findMarkdownTable - a header row with no separator is not a table", () => {
  assertEquals(
    findMarkdownTable(
      "| Ask | Covered by |\n| Do the thing | #7 |\n",
      hasColumns(/ask/i),
    ),
    null,
  );
});

Deno.test("findMarkdownTable - a header-only table yields no rows, not null", () => {
  const table = findMarkdownTable(
    "| Ask | Covered by |\n| --- | --- |\n",
    hasColumns(/ask/i),
  );
  assert(table !== null);
  assertEquals(table.rows, []);
});

Deno.test("findMarkdownTable - the table ends at the first non-row line", () => {
  const table = findMarkdownTable(
    `| Ask | Covered by |
| --- | --- |
| Do the thing | #7 |

| Do the other | #8 |
`,
    hasColumns(/ask/i),
  );
  assert(table !== null);
  assertEquals(table.rows, [["Do the thing", "#7"]]);
});

Deno.test("findMarkdownTable - every alignment form still separates a table", () => {
  for (const separator of ["| --- | --- |", "|:---|---:|", "| :---: | - |"]) {
    const table = findMarkdownTable(
      `| Ask | Covered by |\n${separator}\n| Do the thing | #7 |\n`,
      hasColumns(/ask/i),
    );
    assert(table !== null, `separator not recognised: ${separator}`);
    assertEquals(table.rows.length, 1);
  }
});

Deno.test("findMarkdownTable - a blob past the scan cap is rejected, not scanned", () => {
  const table = "| Ask | Covered by |\n| --- | --- |\n| Do the thing | #7 |\n";
  const oversized = table + "filler line\n".repeat(
    Math.ceil(MAX_TABLE_SCAN_CHARS / 12),
  );
  assert(oversized.length > MAX_TABLE_SCAN_CHARS);
  assertEquals(findMarkdownTable(oversized, hasColumns(/ask/i)), null);
  // The same table under the cap is still found, so it is the cap that
  // rejected the blob and not the parser.
  assert(findMarkdownTable(table, hasColumns(/ask/i)) !== null);
});
