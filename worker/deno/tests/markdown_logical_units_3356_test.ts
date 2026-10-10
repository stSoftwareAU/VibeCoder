/**
 * Tests for `markdownLogicalUnits` / `splitMarkdownLines` (Issue #3356).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  markdownLogicalUnits,
  splitMarkdownLines,
} from "../lib/markdown_code_spans.ts";
import { assertLinearGrowth } from "./support/growth.ts";

function units(text: string) {
  return markdownLogicalUnits(splitMarkdownLines(text));
}

function shape(text: string) {
  return units(text).map((u) => [u.kind, u.lines]);
}

Deno.test("a hard-wrapped paragraph is one unit joined with single spaces", () => {
  const text =
    "Unchanged and re-run: `tests/pr_merge_conflict_scan_test.ts`,\n" +
    "`tests/conflict_abandon_restart_test.ts` (114 passed together with the new\n" +
    "file). No test was removed or disabled.";
  const result = units(text);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.kind, "paragraph");
  assertEquals(result[0]!.lines, [0, 1, 2]);
  assertEquals(
    result[0]!.text,
    "Unchanged and re-run: `tests/pr_merge_conflict_scan_test.ts`, " +
      "`tests/conflict_abandon_restart_test.ts` (114 passed together with the new " +
      "file). No test was removed or disabled.",
  );
});

Deno.test("a list item joins an indented continuation line", () => {
  assertEquals(shape("- first part\n  second part"), [["list-item", [0, 1]]]);
});

Deno.test("a list item joins a lazy unindented continuation line", () => {
  const result = units("- first part\nsecond part");
  assertEquals(result.length, 1);
  assertEquals(result[0]!.kind, "list-item");
  assertEquals(result[0]!.text, "- first part second part");
});

Deno.test("a new list item and a nested item each start a new unit", () => {
  assertEquals(shape("- a\n- b\n  - c\n    d"), [
    ["list-item", [0]],
    ["list-item", [1]],
    ["list-item", [2, 3]],
  ]);
});

Deno.test("a heading between paragraphs is its own unit and they do not merge", () => {
  assertEquals(shape("one\ntwo\n# Title\nthree"), [
    ["paragraph", [0, 1]],
    ["heading", [2]],
    ["paragraph", [3]],
  ]);
});

Deno.test("a blank line splits paragraphs and belongs to no unit", () => {
  assertEquals(shape("one\n\ntwo"), [["paragraph", [0]], ["paragraph", [2]]]);
});

Deno.test("each table row is its own unit and a following line does not join it", () => {
  assertEquals(shape("| a | b |\n| - | - |\ntrailing text"), [
    ["table-row", [0]],
    ["table-row", [1]],
    ["paragraph", [2]],
  ]);
});

Deno.test("a thematic break is its own unit and is checked before list items", () => {
  assertEquals(shape("text\n---\nmore\n***"), [
    ["paragraph", [0]],
    ["break", [1]],
    ["paragraph", [2]],
    ["break", [3]],
  ]);
});

Deno.test("each non-blank fenced line is its own code unit and prose does not join it", () => {
  assertEquals(
    shape("before\nwrapped\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nafter"),
    [
      ["paragraph", [0, 1]],
      ["code", [2]],
      ["code", [3]],
      ["code", [5]],
      ["code", [6]],
      ["paragraph", [7]],
    ],
  );
});

Deno.test("an unclosed fence makes every remaining line a code unit", () => {
  assertEquals(shape("intro\n```\nx\ny\nz"), [
    ["paragraph", [0]],
    ["code", [1]],
    ["code", [2]],
    ["code", [3]],
    ["code", [4]],
  ]);
});

Deno.test("an HTML comment spanning two lines is one html unit apart from prose", () => {
  const result = units("prose before\n<!-- note\nmore -->\nprose after");
  assertEquals(result.map((u) => [u.kind, u.lines]), [
    ["paragraph", [0]],
    ["html", [1, 2]],
    ["paragraph", [3]],
  ]);
  assertEquals(result[1]!.text, "<!-- note more -->");
});

Deno.test("a quote-depth change splits and same-depth quoted lines join", () => {
  assertEquals(shape("plain\n> quoted one\n> quoted two\n> > nested\nplain"), [
    ["paragraph", [0]],
    ["paragraph", [1, 2]],
    ["paragraph", [3]],
    ["paragraph", [4]],
  ]);
});

Deno.test("splitMarkdownLines splits on every terminator and indexes line up", () => {
  const text = "a\r\nb\rc\nd e f";
  const lines = splitMarkdownLines(text);
  assertEquals(lines, ["a", "b", "c", "d", "e", "f"]);
  const result = markdownLogicalUnits(lines);
  assertEquals(result.length, 1);
  assertEquals(result[0]!.lines, [0, 1, 2, 3, 4, 5]);
  assertEquals(result[0]!.text, "a b c d e f");
});

Deno.test("markdownLogicalUnits scales linearly on wrapped lines and long marker runs", () => {
  const build = (chars: number): string => {
    const parts: string[] = [];
    let size = 0;
    let n = 0;
    while (size < chars) {
      const chunk = [
        "wrapped prose line " + n,
        "`".repeat(50),
        "-".repeat(50) + "x",
        ">".repeat(50),
        "  - item " + "-".repeat(40),
      ].join("\n");
      parts.push(chunk);
      size += chunk.length + 1;
      n++;
    }
    return parts.join("\n");
  };
  assertLinearGrowth(
    "markdownLogicalUnits on wrapped lines plus long marker runs",
    build,
    (input) => markdownLogicalUnits(splitMarkdownLines(input)).length,
    { baseChars: 50_000, sizeFactor: 8 },
  );
});
