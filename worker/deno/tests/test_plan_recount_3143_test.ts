// Tests for lib/test_plan_recount.ts (Issue #3143).
import { assertEquals } from "@std/assert";
import {
  countTestDeclarations,
  describeTestPlanMismatch,
  extractTestPlanSection,
  findTestPlanMismatches,
  isCountableTestPath,
} from "../lib/test_plan_recount.ts";

Deno.test("countTestDeclarations counts Deno.test and it() variants", () => {
  const source = `
Deno.test("a", () => {});
Deno.test({ name: "b", fn: () => {} });
Deno.test.ignore("c", () => {});
it("d", () => {});
it.only("e", () => {});
`;
  assertEquals(countTestDeclarations(source), 5);
});

Deno.test("countTestDeclarations ignores declarations inside block comments", () => {
  const source = `
/*
Deno.test("hidden", () => {});
it("also hidden", () => {});
*/
Deno.test("visible", () => {});
`;
  assertEquals(countTestDeclarations(source), 1);
});

Deno.test("countTestDeclarations ignores declarations on // comment lines", () => {
  const source = `
// Deno.test("hidden", () => {});
// it("also hidden", () => {});
it("visible", () => {});
`;
  assertEquals(countTestDeclarations(source), 1);
});

Deno.test("countTestDeclarations does not match split(, submit(, or obj.it(", () => {
  const source = `
const parts = "a,b".split(",");
form.submit();
obj.it(1);
`;
  assertEquals(countTestDeclarations(source), 0);
});

Deno.test("isCountableTestPath accepts the supported JS/TS test suffixes", () => {
  assertEquals(isCountableTestPath("worker/deno/tests/foo_test.ts"), true);
  assertEquals(isCountableTestPath("src/a.test.tsx"), true);
  assertEquals(isCountableTestPath("x.spec.js"), true);
});

Deno.test("isCountableTestPath rejects non test paths", () => {
  assertEquals(isCountableTestPath("lib/foo.ts"), false);
  assertEquals(isCountableTestPath("tests/run.sh"), false);
  assertEquals(isCountableTestPath("docs/test.md"), false);
  assertEquals(isCountableTestPath(""), false);
});

Deno.test("extractTestPlanSection returns only the section", () => {
  const summary = `## Summary
Some stuff.

## Test Plan
- Added \`foo_test.ts\` (2 tests).

## Risks
None.
`;
  assertEquals(
    extractTestPlanSection(summary),
    "- Added `foo_test.ts` (2 tests).\n",
  );
});

Deno.test("extractTestPlanSection returns empty string when absent", () => {
  const summary = "## Summary\nNo test plan here.\n";
  assertEquals(extractTestPlanSection(summary), "");
});

Deno.test("extractTestPlanSection stops at the next heading of same or higher level", () => {
  const summary = `### Test Plan
line one
## Next Section
line two
`;
  assertEquals(extractTestPlanSection(summary), "line one");
});

Deno.test("findTestPlanMismatches flags a stale per-file count", () => {
  const summary = `## Test Plan
- Added \`worker/deno/tests/foo_test.ts\` (2 tests).
`;
  const headCounts = new Map([["worker/deno/tests/foo_test.ts", 4]]);
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0]?.claimed, 2);
  assertEquals(mismatches[0]?.actual, 4);
  assertEquals(mismatches[0]?.files, ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("findTestPlanMismatches finds no mismatch when the count matches", () => {
  const summary = `## Test Plan
- Added \`worker/deno/tests/foo_test.ts\` (2 tests).
`;
  const headCounts = new Map([["worker/deno/tests/foo_test.ts", 2]]);
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 0);
});

Deno.test("findTestPlanMismatches resolves a short path by suffix match", () => {
  const summary = `## Test Plan
- Added \`tests/foo_test.ts\` (2 tests).
`;
  const headCounts = new Map([["worker/deno/tests/foo_test.ts", 5]]);
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0]?.files, ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("findTestPlanMismatches flags a stale totals line across files", () => {
  const summary =
    "## Test Plan\n`deno test tests/a_test.ts tests/b_test.ts`: 8 passed, 0 failed.\n";
  const headCounts = new Map([
    ["tests/a_test.ts", 3],
    ["tests/b_test.ts", 4],
  ]);
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0]?.claimed, 8);
  assertEquals(mismatches[0]?.actual, 7);
});

Deno.test("findTestPlanMismatches finds no mismatch when the totals line is accurate", () => {
  const summary =
    "## Test Plan\n`deno test tests/a_test.ts tests/b_test.ts`: 8 passed, 0 failed.\n";
  const headCounts = new Map([
    ["tests/a_test.ts", 4],
    ["tests/b_test.ts", 4],
  ]);
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 0);
});

Deno.test("findTestPlanMismatches skips a line naming an unknown file", () => {
  const summary = `## Test Plan
- Added \`tests/unknown_test.ts\` (2 tests).
`;
  const headCounts = new Map([["tests/foo_test.ts", 4]]);
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("findTestPlanMismatches skips a --filter line", () => {
  const summary =
    "## Test Plan\n`deno test tests/foo_test.ts --filter bar`: 2 passed.\n";
  const headCounts = new Map([["tests/foo_test.ts", 4]]);
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("findTestPlanMismatches skips a line with two different numbers", () => {
  const summary =
    "## Test Plan\n`tests/foo_test.ts`: 2 tests, 3 passed previously.\n";
  const headCounts = new Map([["tests/foo_test.ts", 4]]);
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("findTestPlanMismatches skips a qualifier like '4 new tests'", () => {
  const summary = "## Test Plan\n`tests/foo_test.ts`: 4 new tests.\n";
  const headCounts = new Map([["tests/foo_test.ts", 9]]);
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("findTestPlanMismatches ignores a matching line outside the Test Plan section", () => {
  const summary = `## Summary
Added \`tests/foo_test.ts\` (2 tests).

## Test Plan
No test files touched.
`;
  const headCounts = new Map([["tests/foo_test.ts", 4]]);
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("describeTestPlanMismatch names the claimed and actual counts and the file", () => {
  const description = describeTestPlanMismatch({
    line: "- Added `foo_test.ts` (2 tests).",
    files: ["worker/deno/tests/foo_test.ts"],
    claimed: 2,
    actual: 4,
  });
  assertEquals(
    description,
    'the Test Plan line "- Added `foo_test.ts` (2 tests)." quotes 2 tests for worker/deno/tests/foo_test.ts, but the head has 4',
  );
});

Deno.test("describeTestPlanMismatch describes a multi-file mismatch", () => {
  const description = describeTestPlanMismatch({
    line: "`deno test a b`: 8 passed.",
    files: ["a", "b"],
    claimed: 8,
    actual: 7,
  });
  assertEquals(
    description,
    'the Test Plan line "`deno test a b`: 8 passed." quotes 8 for a, b, but those files have 7 at the head',
  );
});
