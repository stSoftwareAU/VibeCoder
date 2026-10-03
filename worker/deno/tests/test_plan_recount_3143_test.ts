// Tests for lib/test_plan_recount.ts (Issue #3143).
import { assertEquals } from "@std/assert";
import {
  countTestDeclarations,
  countTestDeclarationsDetailed,
  describeTestPlanMismatch,
  extractTestPlanSection,
  findTestPlanMismatches,
  isCountableTestPath,
  type TestDeclarationCounts,
} from "../lib/test_plan_recount.ts";

/** Build a headCounts map from plain numbers, when ignore/skip don't matter. */
function counts(
  entries: Record<string, number>,
): Map<string, TestDeclarationCounts> {
  return new Map(
    Object.entries(entries).map(([k, v]) => [k, { total: v, runnable: v }]),
  );
}

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

// Regression tests for Issue #3143 review: a file quoting declaration-shaped
// text inside a string, template literal or assertion message must not be
// overcounted — the two defects this PR's own test files hit at the head.

Deno.test("countTestDeclarations ignores a Deno.test( fixture embedded in a template literal", () => {
  const source = "" +
    "const fixture = `\n" +
    'Deno.test("hidden", () => {});\n' +
    'it("also hidden", () => {});\n' +
    "`;\n" +
    'Deno.test("visible", () => {});\n';
  assertEquals(countTestDeclarations(source), 1);
});

Deno.test("countTestDeclarations ignores an assertion message containing 'it ('", () => {
  const source = `
Deno.test("retries once", () => {
  assertEquals(label, "retry it (once)");
});
`;
  assertEquals(countTestDeclarations(source), 1);
});

Deno.test("countTestDeclarationsDetailed excludes Deno.test.ignore from runnable but counts it in total", () => {
  const source = `
Deno.test("a", () => {});
Deno.test.ignore("b", () => {});
`;
  assertEquals(countTestDeclarationsDetailed(source), {
    total: 2,
    runnable: 1,
  });
});

Deno.test("countTestDeclarationsDetailed excludes it.skip from runnable but counts it in total", () => {
  const source = `
it("a", () => {});
it.skip("b", () => {});
it.only("c", () => {});
`;
  assertEquals(countTestDeclarationsDetailed(source), {
    total: 3,
    runnable: 2,
  });
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
  const headCounts = counts({ "worker/deno/tests/foo_test.ts": 4 });
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
  const headCounts = counts({ "worker/deno/tests/foo_test.ts": 2 });
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 0);
});

Deno.test("findTestPlanMismatches resolves a short path by suffix match", () => {
  const summary = `## Test Plan
- Added \`tests/foo_test.ts\` (2 tests).
`;
  const headCounts = counts({ "worker/deno/tests/foo_test.ts": 5 });
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0]?.files, ["worker/deno/tests/foo_test.ts"]);
});

Deno.test("findTestPlanMismatches flags a stale totals line across files", () => {
  const summary =
    "## Test Plan\n`deno test tests/a_test.ts tests/b_test.ts`: 8 passed, 0 failed.\n";
  const headCounts = counts({ "tests/a_test.ts": 3, "tests/b_test.ts": 4 });
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0]?.claimed, 8);
  assertEquals(mismatches[0]?.actual, 7);
});

Deno.test("findTestPlanMismatches finds no mismatch when the totals line is accurate", () => {
  const summary =
    "## Test Plan\n`deno test tests/a_test.ts tests/b_test.ts`: 8 passed, 0 failed.\n";
  const headCounts = counts({ "tests/a_test.ts": 4, "tests/b_test.ts": 4 });
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 0);
});

Deno.test("findTestPlanMismatches skips a line naming an unknown file", () => {
  const summary = `## Test Plan
- Added \`tests/unknown_test.ts\` (2 tests).
`;
  const headCounts = counts({ "tests/foo_test.ts": 4 });
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("findTestPlanMismatches skips a --filter line", () => {
  const summary =
    "## Test Plan\n`deno test tests/foo_test.ts --filter bar`: 2 passed.\n";
  const headCounts = counts({ "tests/foo_test.ts": 4 });
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("findTestPlanMismatches skips a line with two different numbers", () => {
  const summary =
    "## Test Plan\n`tests/foo_test.ts`: 2 tests, 3 passed previously.\n";
  const headCounts = counts({ "tests/foo_test.ts": 4 });
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("findTestPlanMismatches skips a qualifier like '4 new tests'", () => {
  const summary = "## Test Plan\n`tests/foo_test.ts`: 4 new tests.\n";
  const headCounts = counts({ "tests/foo_test.ts": 9 });
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("findTestPlanMismatches ignores a matching line outside the Test Plan section", () => {
  const summary = `## Summary
Added \`tests/foo_test.ts\` (2 tests).

## Test Plan
No test files touched.
`;
  const headCounts = counts({ "tests/foo_test.ts": 4 });
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

// A "passed" claim is what `deno test` actually ran — `.ignore`/`.skip`
// excluded — while a "tests" claim is every declaration (Issue #3143 review).

Deno.test("findTestPlanMismatches treats a 'passed' claim as runnable declarations, excluding an ignored test", () => {
  const summary = "## Test Plan\n`tests/foo_test.ts`: 2 passed.\n";
  const headCounts = new Map([["tests/foo_test.ts", {
    total: 3,
    runnable: 2,
  }]]);
  assertEquals(findTestPlanMismatches({ summary, headCounts }).length, 0);
});

Deno.test("findTestPlanMismatches flags a 'passed' claim that counts an ignored test", () => {
  const summary = "## Test Plan\n`tests/foo_test.ts`: 3 passed.\n";
  const headCounts = new Map([["tests/foo_test.ts", {
    total: 3,
    runnable: 2,
  }]]);
  const mismatches = findTestPlanMismatches({ summary, headCounts });
  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0]?.actual, 2);
});

Deno.test("findTestPlanMismatches treats a 'tests' claim as every declaration, including an ignored test", () => {
  const summary = "## Test Plan\n`tests/foo_test.ts`: 3 tests.\n";
  const headCounts = new Map([["tests/foo_test.ts", {
    total: 3,
    runnable: 2,
  }]]);
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

// Pins the recount of this very file (Issue #3143 review): before the fix,
// `deno test` ran 21 tests here while the counter returned 29 — this file's
// own `Deno.test(` fixtures embedded in template literals were counted as
// real declarations. If the counter regresses the same way again, this test
// goes red, independent of the real `deno test` run.
Deno.test("countTestDeclarations recount of this file matches its own real Deno.test count", async () => {
  const source = await Deno.readTextFile(
    new URL(import.meta.url),
  );
  assertEquals(countTestDeclarations(source), 29);
});
