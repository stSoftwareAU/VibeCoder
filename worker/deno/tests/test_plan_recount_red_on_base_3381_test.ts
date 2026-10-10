// Tests for paired run results in lib/test_plan_recount.ts (Issue #3381).

import { assert, assertEquals } from "@std/assert";
import {
  describeTestPlanMismatch,
  findTestPlanMismatches,
  type TestDeclarationCounts,
} from "../lib/test_plan_recount.ts";
import { assertLinearGrowth } from "./support/growth.ts";

const GATE_TEST = "worker/deno/tests/branch_outcomes_gate_test.ts";
const FOO_TEST = "worker/deno/tests/foo_test.ts";

function counts(
  entries: Record<string, number>,
): Map<string, TestDeclarationCounts> {
  return new Map(
    Object.entries(entries).map(([k, n]) => [k, { total: n, runnable: n }]),
  );
}

// Real stale Test Plan from VibeCoder PR #3372 at head 79ac8590. The head
// file has 80 runnable tests, so "77 passed, 2 failed" (79) is stale.
const STALE_3340 = `## Test Plan

All tests are in \`worker/deno/tests/branch_outcomes_gate_test.ts\`.

**Red on base.** I swapped in the base copy of
\`worker/deno/lib/branch_outcomes_gate.ts\` (commit \`8958b3c3\`) and ran the
suite. Result: 77 passed, 2 failed. The two failures:

- \`validateBranchOutcomes - a prose mention separated by a blank line still does not hide the real header's inline citation\`
- \`parseBranchOutcomes - a later Branch outcomes header is parsed on its own, so its region is scanned\`

**Changed assertion.**

- Removed from \`worker/deno/tests/branch_outcomes_gate_test.ts\`: \`assertEquals(namedTestPaths(record), []);\` — it is replaced by \`assertEquals(namedTestPaths(record), ["worker/deno/tests/unrelated_test.ts"]);\`.

### PR #3372 review round — heading-form headers

**Red on base (this round).** I swapped in this round's pre-fix copy of
\`worker/deno/lib/branch_outcomes_gate.ts\` (HEAD before this round, commit
\`9a3e30f8\`) and ran the suite: 78 passed, 2 failed.
`;

const HEAD_80 = counts({ [GATE_TEST]: 80 });

Deno.test("paired run result - the stale PR #3372 plan is flagged once", () => {
  const found = findTestPlanMismatches({
    summary: STALE_3340,
    headCounts: HEAD_80,
  });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.claimed, 79);
  assertEquals(found[0]!.actual, 80);
  assertEquals(found[0]!.run, { passed: 77, failed: 2 });
  assertEquals(found[0]!.files, [GATE_TEST]);
});

Deno.test("paired run result - a correct red-on-base total is not flagged", () => {
  const fixed = STALE_3340.replace(
    "77 passed, 2 failed",
    "76 passed, 4 failed",
  );
  assertEquals(
    findTestPlanMismatches({ summary: fixed, headCounts: HEAD_80 }),
    [],
  );
});

Deno.test("paired run result - two changed test files leave a file-less red block alone", () => {
  const summary = `## Test Plan

Changed \`tests/a_test.ts\` and \`tests/b_test.ts\`.

Red on base: 1 passed, 2 failed.
`;
  const headCounts = counts({
    "worker/deno/tests/a_test.ts": 40,
    "worker/deno/tests/b_test.ts": 40,
  });
  assertEquals(findTestPlanMismatches({ summary, headCounts }), []);
});

Deno.test("paired run result - a block naming the test file is compared by passed + failed", () => {
  const headCounts = counts({ [FOO_TEST]: 80 });
  const ok =
    `## Test Plan\n\n\`tests/foo_test.ts\` against base: 76 passed, 4 failed.\n`;
  assertEquals(findTestPlanMismatches({ summary: ok, headCounts }), []);
  const stale =
    `## Test Plan\n\n\`tests/foo_test.ts\` against base: 77 passed, 2 failed.\n`;
  const found = findTestPlanMismatches({ summary: stale, headCounts });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.claimed, 79);
});

const VARIANTS = [
  "4 failed, 76 passed",
  "76 passed and 4 failed",
  "FAILED | 76 passed | 4 failed (1s)",
  "76 passed,\n  4 failed",
];

for (const variant of VARIANTS) {
  const plan = (text: string) =>
    `## Test Plan\n\n- \`tests/foo_test.ts\` against base: ${text}\n`;
  Deno.test(`paired run result - variant "${variant.replace(/\n/g, "\\n")}"`, () => {
    const headCounts = counts({ [FOO_TEST]: 80 });
    assertEquals(
      findTestPlanMismatches({ summary: plan(variant), headCounts }),
      [],
    );
    const wrong = variant.replace("76", "75");
    assertEquals(
      findTestPlanMismatches({ summary: plan(wrong), headCounts }).length,
      1,
    );
  });
}

Deno.test("paired run result - ignored figure is outside the total", () => {
  const headCounts = new Map([[FOO_TEST, { total: 81, runnable: 80 }]]);
  const plan = (text: string) =>
    `## Test Plan\n\n\`tests/foo_test.ts\`: ${text}\n`;
  assertEquals(
    findTestPlanMismatches({
      summary: plan("ok | 76 passed | 4 failed | 1 ignored (5ms)"),
      headCounts,
    }),
    [],
  );
  assertEquals(
    findTestPlanMismatches({
      summary: plan("ok | 77 passed | 4 failed | 1 ignored (5ms)"),
      headCounts,
    }).length,
    1,
  );
});

Deno.test("paired run result - look-alikes do not fire", () => {
  const headCounts = counts({ [FOO_TEST]: 80 });
  const plans = [
    "## Test Plan\n\nChanged `tests/foo_test.ts`.\n\n`./quality.sh`: 4000 passed, 0 failed.\n",
    "## Test Plan\n\nChanged `tests/foo_test.ts`.\n\n`deno test --filter x`: 2 passed, 1 failed.\n",
  ];
  for (const summary of plans) {
    assertEquals(findTestPlanMismatches({ summary, headCounts }), []);
  }
  const unresolved =
    "## Test Plan\n\nChanged `tests/other_test.ts`.\n\nRed on base: 1 passed, 2 failed.\n";
  assertEquals(
    findTestPlanMismatches({ summary: unresolved, headCounts }),
    [],
  );
});

Deno.test("paired run result - an unresolved test token does not hide ambiguity from the sole-file fallback", () => {
  // The unresolved token is ignored, so foo_test.ts stays the sole changed
  // file and the stale red run is still flagged.
  const headCounts = counts({ [FOO_TEST]: 80 });
  const summary =
    "## Test Plan\n\nChanged `tests/foo_test.ts`; asserts `x/other_test.ts`.\n\nRed on base: 77 passed, 2 failed.\n";
  assertEquals(
    findTestPlanMismatches({ summary, headCounts }).length,
    1,
  );
});

Deno.test("paired run result - two files with different totals are skipped", () => {
  const headCounts = counts({
    "worker/deno/tests/a_test.ts": 10,
    "worker/deno/tests/b_test.ts": 20,
  });
  const summary =
    "## Test Plan\n\n`a_test.ts` 5 passed, 1 failed; `b_test.ts` 3 passed, 0 failed.\n";
  assertEquals(findTestPlanMismatches({ summary, headCounts }), []);
});

Deno.test("paired run result - a stale base run beside a fresh head run is flagged", () => {
  const headCounts = counts({ [FOO_TEST]: 5 });
  const summary =
    "## Test Plan\n\n`tests/foo_test.ts` red on base: 0 passed, 3 failed; at head: 5 passed, 0 failed.\n";
  const found = findTestPlanMismatches({ summary, headCounts });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.claimed, 3);
});

Deno.test("single claim - a passed figure keeps its old behaviour and has no run field", () => {
  const headCounts = counts({ [FOO_TEST]: 4 });
  const summary = "## Test Plan\n\n`tests/foo_test.ts`: 3 passed.\n";
  const found = findTestPlanMismatches({ summary, headCounts });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.claimed, 3);
  assertEquals("run" in found[0]!, false);
});

Deno.test("describeTestPlanMismatch - a run names total, passed, failed, file and actual", () => {
  const text = describeTestPlanMismatch({
    line: "x",
    files: [FOO_TEST],
    claimed: 79,
    actual: 80,
    run: { passed: 77, failed: 2 },
  });
  for (const part of ["79", "77 passed", "2 failed", FOO_TEST, "80"]) {
    assert(text.includes(part), `${part} missing from: ${text}`);
  }
});

Deno.test("paired run result - hostile separators scale linearly", () => {
  const headCounts = counts({ [FOO_TEST]: 80 });
  assertLinearGrowth(
    "paired run-result scan",
    (chars) => `## Test Plan\n\n${"1 passed" + ", | ".repeat(chars) + "x\n"}`,
    (input) => findTestPlanMismatches({ summary: input, headCounts }),
    { baseChars: 5_000 },
  );
});
