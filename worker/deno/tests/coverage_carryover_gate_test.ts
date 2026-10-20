/**
 * Unit tests for the coverage carry-over gate (Issue #3795). Pure functions
 * only: diffs and lcov are built as literal fixtures.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCoverageCarryOverGateComment,
  DEFAULT_COVERAGE_CARRYOVER_BUDGET_SECONDS,
  evaluateCoverageCarryOverGate,
  mapBaseLineToHead,
  parseLcov,
  removedOrEditedTestFiles,
  removesRustTestLines,
} from "../lib/coverage_carryover_gate.ts";

/** A `--unified=0` section for a modified file, from its hunk lines. */
function section(path: string, ...lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...lines,
  ].join("\n") + "\n";
}

/** A `--unified=0` section for a deleted file whose old text is `oldLines`. */
function deletedSection(path: string, oldLines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    `@@ -1,${oldLines.length} +0,0 @@`,
    ...oldLines.map((l) => `-${l}`),
  ].join("\n") + "\n";
}

const HOSTILE_LENGTH = 200_000;

// ---------------------------------------------------------------------------
// removedOrEditedTestFiles and removesRustTestLines
// ---------------------------------------------------------------------------

Deno.test("removedOrEditedTestFiles - a deleted test file is listed", () => {
  assertEquals(
    removedOrEditedTestFiles(deletedSection("tests/a_test.ts", ["x"])),
    ["tests/a_test.ts"],
  );
});

Deno.test("removedOrEditedTestFiles - an edited test that removes a line is listed", () => {
  assertEquals(
    removedOrEditedTestFiles(
      section("tests/b_test.ts", "@@ -3 +3 @@", "-old", "+new"),
    ),
    ["tests/b_test.ts"],
  );
});

Deno.test("removedOrEditedTestFiles - a test with only additions is excluded", () => {
  assertEquals(
    removedOrEditedTestFiles(
      section("tests/c_test.ts", "@@ -2,0 +3,2 @@", "+x", "+y"),
    ),
    [],
  );
});

Deno.test("removedOrEditedTestFiles - a non-test file is excluded", () => {
  assertEquals(
    removedOrEditedTestFiles(section("lib/m.ts", "@@ -3 +3 @@", "-a", "+b")),
    [],
  );
});

Deno.test("removedOrEditedTestFiles - a .test.ts file counts, output sorted and de-duplicated", () => {
  const diff = section(
    "tests/z_test.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "@@ -9 +9 @@",
    "-c",
    "+d",
  ) + section("lib/x.test.ts", "@@ -1 +1 @@", "-a", "+b") +
    section("tests/b_test.ts", "@@ -1 +1 @@", "-a", "+b");
  assertEquals(removedOrEditedTestFiles(diff), [
    "lib/x.test.ts",
    "tests/b_test.ts",
    "tests/z_test.ts",
  ]);
});

Deno.test("removesRustTestLines - a removed line in a Rust file under tests/ counts", () => {
  assertEquals(
    removesRustTestLines(
      deletedSection("crates/x/tests/t.rs", ["fn a() {}"]),
    ),
    true,
  );
});

Deno.test("removesRustTestLines - additions only, or a Rust file outside tests/, do not count", () => {
  assertEquals(
    removesRustTestLines(
      section("tests/t.rs", "@@ -1,0 +2 @@", "+fn b() {}"),
    ),
    false,
  );
  assertEquals(
    removesRustTestLines(section("src/lib.rs", "@@ -1 +1 @@", "-a", "+b")),
    false,
  );
});

Deno.test("removedOrEditedTestFiles - a hostile long hunk-like line neither hangs nor matches", () => {
  const hostile = "@@ -" + "9".repeat(HOSTILE_LENGTH) + " +1 @@";
  const diff = section("tests/h_test.ts", hostile, "-a", "+b");
  // The header does not match, so no hunk is recorded and the file is not listed.
  assertEquals(removedOrEditedTestFiles(diff), []);
});

// ---------------------------------------------------------------------------
// mapBaseLineToHead
// ---------------------------------------------------------------------------

Deno.test("mapBaseLineToHead - a file the diff does not touch maps to itself", () => {
  const diff = section("lib/other.ts", "@@ -1 +1 @@", "-a", "+b");
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 7), {
    file: "lib/m.ts",
    line: 7,
  });
});

Deno.test("mapBaseLineToHead - a pure insertion (oc = 0) shifts only lines after it", () => {
  // Two lines inserted after old line 2.
  const diff = section("lib/m.ts", "@@ -2,0 +3,2 @@", "+x", "+y");
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 1), {
    file: "lib/m.ts",
    line: 1,
  });
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 2), {
    file: "lib/m.ts",
    line: 2,
  });
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 3), {
    file: "lib/m.ts",
    line: 5,
  });
});

Deno.test("mapBaseLineToHead - a replacement maps the changed range to null and shifts later lines", () => {
  // Old line 2 is replaced by three lines.
  const diff = section(
    "lib/m.ts",
    "@@ -2 +2,3 @@",
    "-a",
    "+b",
    "+c",
    "+d",
  );
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 1), {
    file: "lib/m.ts",
    line: 1,
  });
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 2), null);
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 3), {
    file: "lib/m.ts",
    line: 5,
  });
});

Deno.test("mapBaseLineToHead - a line inside a removed range maps to null", () => {
  // Old lines 4 and 5 become one line.
  const diff = section("lib/m.ts", "@@ -4,2 +4,1 @@", "-a", "-b", "+c");
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 4), null);
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 5), null);
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 6), {
    file: "lib/m.ts",
    line: 5,
  });
});

Deno.test("mapBaseLineToHead - a pure deletion shifts later lines back", () => {
  const diff = section("lib/m.ts", "@@ -3,2 +2,0 @@", "-a", "-b");
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 2), {
    file: "lib/m.ts",
    line: 2,
  });
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 5), {
    file: "lib/m.ts",
    line: 3,
  });
});

Deno.test("mapBaseLineToHead - a deleted file maps every line to null", () => {
  const diff = deletedSection("lib/m.ts", ["a", "b", "c"]);
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 1), null);
});

Deno.test("mapBaseLineToHead - an omitted hunk count means one", () => {
  // `-5` is one old line; `+5` is one new line.
  const single = section("lib/m.ts", "@@ -5 +5 @@", "-a", "+b");
  assertEquals(mapBaseLineToHead(single, "lib/m.ts", 5), null);
  assertEquals(mapBaseLineToHead(single, "lib/m.ts", 6), {
    file: "lib/m.ts",
    line: 6,
  });
  // `-5` is one old line replaced by two (`+5,2`).
  const grown = section("lib/m.ts", "@@ -5 +5,2 @@", "-a", "+b", "+c");
  assertEquals(mapBaseLineToHead(grown, "lib/m.ts", 5), null);
  assertEquals(mapBaseLineToHead(grown, "lib/m.ts", 6), {
    file: "lib/m.ts",
    line: 7,
  });
});

Deno.test("mapBaseLineToHead - shifts accumulate across hunks", () => {
  const diff = section(
    "lib/m.ts",
    "@@ -2,0 +3,1 @@",
    "+x",
    "@@ -10,0 +12,2 @@",
    "+y",
    "+z",
  );
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 5), {
    file: "lib/m.ts",
    line: 6,
  });
  // Line 11 is after both insertions: +1 from the first, +2 from the second.
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 11), {
    file: "lib/m.ts",
    line: 14,
  });
});

Deno.test("mapBaseLineToHead - a removed line that starts with -- is counted as a removal, not a header", () => {
  // The removed text is `-- not a header`, so the diff line is `--- not a header`.
  const diff = section(
    "lib/m.ts",
    "@@ -2,2 +2 @@",
    "--- not a header",
    "-second",
    "+replaced",
  );
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 1), {
    file: "lib/m.ts",
    line: 1,
  });
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 2), null);
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 4), {
    file: "lib/m.ts",
    line: 3,
  });
});

Deno.test("mapBaseLineToHead - a binary section maps its lines to null", () => {
  const diff = [
    "diff --git a/lib/b.bin b/lib/b.bin",
    "Binary files a/lib/b.bin and b/lib/b.bin differ",
    "",
  ].join("\n");
  assertEquals(mapBaseLineToHead(diff, "lib/b.bin", 1), null);
});

Deno.test("mapBaseLineToHead - a 'no newline at end of file' marker inside a hunk is skipped", () => {
  const diff = section(
    "lib/m.ts",
    "@@ -2 +2 @@",
    "-a",
    "\\ No newline at end of file",
    "+b",
  );
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 3), {
    file: "lib/m.ts",
    line: 3,
  });
});

Deno.test("mapBaseLineToHead - a hostile long hunk-like line neither hangs nor matches", () => {
  const hostile = "@@ -" + "1".repeat(HOSTILE_LENGTH) + " +1 @@";
  const diff = section("lib/m.ts", hostile, "-a", "+b");
  // No hunk is recorded, so the line maps to itself.
  assertEquals(mapBaseLineToHead(diff, "lib/m.ts", 1), {
    file: "lib/m.ts",
    line: 1,
  });
});

// ---------------------------------------------------------------------------
// parseLcov
// ---------------------------------------------------------------------------

Deno.test("parseLcov - DA records keyed by SF path, checksums ignored", () => {
  const lcov = [
    "TN:",
    "SF:/abs/lib/m.ts",
    "FN:1,f",
    "DA:1,1",
    "DA:2,0",
    "DA:3,5,abc123",
    "LF:3",
    "end_of_record",
    "SF:/abs/tests/m_test.ts",
    "DA:1,1",
    "end_of_record",
    "",
  ].join("\n");
  const out = parseLcov(lcov);
  assertEquals(
    [...(out.get("/abs/lib/m.ts") ?? new Map()).entries()],
    [[1, 1], [2, 0], [3, 5]],
  );
  assertEquals(
    [...(out.get("/abs/tests/m_test.ts") ?? new Map()).entries()],
    [[1, 1]],
  );
  assertEquals(out.size, 2);
});

Deno.test("parseLcov - a file in two records has its hit counts summed", () => {
  const lcov =
    "SF:/a.ts\nDA:1,2\nend_of_record\nSF:/a.ts\nDA:1,3\nend_of_record\n";
  assertEquals([...(parseLcov(lcov).get("/a.ts") ?? new Map()).entries()], [
    [1, 5],
  ]);
});

Deno.test("parseLcov - DA lines outside a record are ignored", () => {
  assertEquals(parseLcov("DA:1,1\n").size, 0);
});

Deno.test("parseLcov - a hostile long DA line is ignored and does not hang", () => {
  const lcov = "SF:/x.ts\nDA:" + "1".repeat(HOSTILE_LENGTH) +
    ",1\nend_of_record";
  const out = parseLcov(lcov);
  assertEquals(out.get("/x.ts")?.size, 0);
});

// ---------------------------------------------------------------------------
// evaluateCoverageCarryOverGate
// ---------------------------------------------------------------------------

const NO_SUMMARY = "";

Deno.test("evaluateCoverageCarryOverGate - not applicable is not blocked", () => {
  const v = evaluateCoverageCarryOverGate(
    { kind: "not_applicable", reason: "no Deno tests" },
    NO_SUMMARY,
  );
  assertEquals(v.blocked, false);
  assertEquals(
    v.note,
    "coverage carry-over check not applicable: no Deno tests",
  );
});

Deno.test("evaluateCoverageCarryOverGate - error blocks, naming the skip setting", () => {
  const v = evaluateCoverageCarryOverGate(
    { kind: "error", reason: "boom" },
    NO_SUMMARY,
  );
  assertEquals(v.blocked, true);
  assertEquals(
    v.reason,
    "coverage carry-over check failed to run (boom); fix the error or set skip_coverage_carryover_check for this repo",
  );
});

Deno.test("evaluateCoverageCarryOverGate - budget exhaustion is not blocked and not passed", () => {
  const v = evaluateCoverageCarryOverGate(
    {
      kind: "budget_exhausted",
      changedTests: ["tests/a_test.ts"],
      budgetSeconds: DEFAULT_COVERAGE_CARRYOVER_BUDGET_SECONDS,
    },
    NO_SUMMARY,
  );
  assertEquals(v.blocked, false);
  assertEquals(
    v.note,
    "coverage carry-over budget exhausted (600 s) — lines the edited or removed tests reached were not checked, not passed",
  );
});

Deno.test("evaluateCoverageCarryOverGate - all carried lines covered passes", () => {
  const v = evaluateCoverageCarryOverGate(
    { kind: "completed", changedTests: [], carried: 3, uncovered: [] },
    NO_SUMMARY,
  );
  assertEquals(v.blocked, false);
  assertEquals(v.reason, "");
  assertEquals(v.note, "3 of 3 carried-over lines still covered");
});

Deno.test("evaluateCoverageCarryOverGate - an uncovered line blocks with the count reason", () => {
  const v = evaluateCoverageCarryOverGate(
    {
      kind: "completed",
      changedTests: [],
      carried: 3,
      uncovered: [{ file: "lib/m.ts", line: 6 }],
    },
    NO_SUMMARY,
  );
  assertEquals(v.blocked, true);
  assertEquals(
    v.reason,
    "1 line(s) the edited or removed tests reached are no longer reached by any test",
  );
  assertEquals(v.uncovered, [{ file: "lib/m.ts", line: 6 }]);
  assertEquals(v.exempted, []);
  assertEquals(v.note, "2 of 3 carried-over lines still covered");
});

Deno.test("evaluateCoverageCarryOverGate - an exemption for the same path:line is exempted, not blocking", () => {
  const v = evaluateCoverageCarryOverGate(
    {
      kind: "completed",
      changedTests: [],
      carried: 2,
      uncovered: [{ file: "lib/m.ts", line: 6 }],
    },
    "`lib/m.ts:6` exempt (untestable): only reachable from the CLI",
  );
  assertEquals(v.blocked, false);
  assertEquals(v.uncovered, []);
  assertEquals(v.exempted, [{ file: "lib/m.ts", line: 6 }]);
});

Deno.test("evaluateCoverageCarryOverGate - an exemption for another line or file does not match", () => {
  const uncovered = [{ file: "lib/m.ts", line: 6 }];
  const otherLine = evaluateCoverageCarryOverGate(
    { kind: "completed", changedTests: [], carried: 2, uncovered },
    "`lib/m.ts:7` exempt (untestable): reason",
  );
  assertEquals(otherLine.blocked, true);
  assertEquals(otherLine.exempted, []);
  const otherFile = evaluateCoverageCarryOverGate(
    { kind: "completed", changedTests: [], carried: 2, uncovered },
    "`lib/other.ts:6` exempt (untestable): reason",
  );
  assertEquals(otherFile.blocked, true);
  assertEquals(otherFile.exempted, []);
});

Deno.test("evaluateCoverageCarryOverGate - an exemption with no reason does not match", () => {
  const v = evaluateCoverageCarryOverGate(
    {
      kind: "completed",
      changedTests: [],
      carried: 1,
      uncovered: [{ file: "lib/m.ts", line: 6 }],
    },
    "`lib/m.ts:6` exempt (untestable):",
  );
  assertEquals(v.blocked, true);
  assertEquals(v.exempted, []);
});

Deno.test("evaluateCoverageCarryOverGate - exempt and unexempt lines are split, only the unexempt blocks", () => {
  const v = evaluateCoverageCarryOverGate(
    {
      kind: "completed",
      changedTests: [],
      carried: 4,
      uncovered: [
        { file: "lib/m.ts", line: 6 },
        { file: "lib/m.ts", line: 9 },
      ],
    },
    "`lib/m.ts:6` exempt (untestable): CLI-only",
  );
  assertEquals(v.blocked, true);
  assertEquals(v.exempted, [{ file: "lib/m.ts", line: 6 }]);
  assertEquals(v.uncovered, [{ file: "lib/m.ts", line: 9 }]);
  assertEquals(
    v.reason,
    "1 line(s) the edited or removed tests reached are no longer reached by any test",
  );
});

// ---------------------------------------------------------------------------
// buildCoverageCarryOverGateComment
// ---------------------------------------------------------------------------

Deno.test("buildCoverageCarryOverGateComment - heading, reason, list and remedy", () => {
  const comment = buildCoverageCarryOverGateComment({
    blocked: true,
    reason:
      "1 line(s) the edited or removed tests reached are no longer reached by any test",
    uncovered: [{ file: "lib/m.ts", line: 6 }],
    exempted: [],
    note: "",
  });
  assertStringIncludes(
    comment,
    "## Coverage carry-over: lines the edited or removed tests reached are untested",
  );
  assertStringIncludes(
    comment,
    "1 line(s) the edited or removed tests reached are no longer reached by any test.",
  );
  assertStringIncludes(comment, "- `lib/m.ts:6`");
  assertStringIncludes(
    comment,
    "record `file:line` exempt (untestable): <reason> in the PR summary.",
  );
});

Deno.test("buildCoverageCarryOverGateComment - caps the list at 40 and says how many more", () => {
  const uncovered = Array.from({ length: 45 }, (_, i) => ({
    file: "lib/m.ts",
    line: i + 1,
  }));
  const comment = buildCoverageCarryOverGateComment({
    blocked: true,
    reason:
      "45 line(s) the edited or removed tests reached are no longer reached by any test",
    uncovered,
    exempted: [],
    note: "",
  });
  const bullets = comment.split("\n").filter((l) => l.startsWith("- `"));
  assertEquals(bullets.length, 40);
  assertStringIncludes(comment, "… and 5 more");
  assert(!comment.includes("`lib/m.ts:41`"));
});

Deno.test("buildCoverageCarryOverGateComment - file names are sanitised", () => {
  const comment = buildCoverageCarryOverGateComment({
    blocked: true,
    reason:
      "1 line(s) the edited or removed tests reached are no longer reached by any test",
    uncovered: [{ file: "lib/`weird`\nname.ts", line: 3 }],
    exempted: [],
    note: "",
  });
  assertStringIncludes(comment, "- `lib/weird name.ts:3`");
});

Deno.test("buildCoverageCarryOverGateComment - no uncovered lines means no list", () => {
  const comment = buildCoverageCarryOverGateComment({
    blocked: false,
    reason: "",
    uncovered: [],
    exempted: [],
    note: "3 of 3 carried-over lines still covered",
  });
  assert(!comment.includes("- `"));
});

Deno.test("DEFAULT_COVERAGE_CARRYOVER_BUDGET_SECONDS - is ten minutes", () => {
  assertEquals(DEFAULT_COVERAGE_CARRYOVER_BUDGET_SECONDS, 600);
});

// ---------------------------------------------------------------------------
// Parser edge cases: path prefixes, header fallbacks, line endings
// ---------------------------------------------------------------------------

Deno.test("removedOrEditedTestFiles - the tab git appends to a path with spaces is stripped", () => {
  const diff = [
    "diff --git a/my dir/x_test.ts b/my dir/x_test.ts",
    "--- a/my dir/x_test.ts\t",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-a",
    "",
  ].join("\n");
  assertEquals(removedOrEditedTestFiles(diff), ["my dir/x_test.ts"]);
});

Deno.test("removedOrEditedTestFiles - ---/+++ lines before any diff header open an entry that is still read", () => {
  const diff = [
    "--- a/tests/x_test.ts",
    "+++ b/tests/x_test.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  assertEquals(removedOrEditedTestFiles(diff), ["tests/x_test.ts"]);
});

Deno.test("removedOrEditedTestFiles - a path with no a/ prefix (diff.noprefix) is read as is", () => {
  const diff = [
    "diff --git tests/x_test.ts tests/x_test.ts",
    "--- tests/x_test.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-a",
    "",
  ].join("\n");
  assertEquals(removedOrEditedTestFiles(diff), ["tests/x_test.ts"]);
});

Deno.test("mapBaseLineToHead - a diff --git header that is not a/ b/ shaped names no base file", () => {
  // Sliced as a/ b/ paths, this header would name lib/b.bin.
  const diff = [
    "diff --git x/lib/b.bin b/lib/b.bin",
    "Binary files x/lib/b.bin and b/lib/b.bin differ",
    "",
  ].join("\n");
  assertEquals(mapBaseLineToHead(diff, "lib/b.bin", 1), {
    file: "lib/b.bin",
    line: 1,
  });
});

Deno.test("mapBaseLineToHead - an unexpected line ends a hunk early, so the next --- line is a header", () => {
  // The first hunk claims three old lines but only one is removed before a
  // non-diff line; the `--- a/lib/n.ts` after it must start a new file entry.
  const diff = [
    "diff --git a/lib/m.ts b/lib/m.ts",
    "--- a/lib/m.ts",
    "+++ b/lib/m.ts",
    "@@ -1,3 +1 @@",
    "-a",
    "not a diff line",
    "--- a/lib/n.ts",
    "+++ b/lib/n.ts",
    "@@ -4 +4 @@",
    "-b",
    "+c",
    "",
  ].join("\n");
  assertEquals(mapBaseLineToHead(diff, "lib/n.ts", 4), null);
});

Deno.test("removedOrEditedTestFiles - a new test file is not edited and maps nothing from base", () => {
  const diff = [
    "diff --git a/tests/new_test.ts b/tests/new_test.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/tests/new_test.ts",
    "@@ -0,0 +1,2 @@",
    "+a",
    "+b",
    "",
  ].join("\n");
  assertEquals(removedOrEditedTestFiles(diff), []);
  assertEquals(mapBaseLineToHead(diff, "tests/new_test.ts", 1), {
    file: "tests/new_test.ts",
    line: 1,
  });
});

Deno.test("removedOrEditedTestFiles and mapBaseLineToHead - CRLF diff parses the same as LF", () => {
  const lf = section("lib/m.ts", "@@ -2 +2 @@", "-a", "+b") +
    section("tests/c_test.ts", "@@ -1 +1 @@", "-a", "+b");
  const crlf = lf.replaceAll("\n", "\r\n");
  assertEquals(removedOrEditedTestFiles(crlf), removedOrEditedTestFiles(lf));
  assertEquals(removedOrEditedTestFiles(crlf), ["tests/c_test.ts"]);
  assertEquals(mapBaseLineToHead(crlf, "lib/m.ts", 2), null);
  assertEquals(mapBaseLineToHead(crlf, "lib/m.ts", 3), {
    file: "lib/m.ts",
    line: 3,
  });
});

Deno.test("parseLcov - CRLF line endings parse the same as LF", () => {
  const lcov = "SF:/a.ts\r\nDA:1,2\r\nDA:2,0\r\nend_of_record\r\n";
  assertEquals(
    [...(parseLcov(lcov).get("/a.ts") ?? new Map()).entries()],
    [[1, 2], [2, 0]],
  );
});
