// Tests for hard-wrapped Test Plan prose in lib/test_plan_recount.ts (Issue #3356).
import { assertEquals } from "@std/assert";
import {
  findTestPlanMismatches,
  logicalBlocks,
  type TestDeclarationCounts,
} from "../lib/test_plan_recount.ts";

function counts(
  entries: Record<string, number>,
): Map<string, TestDeclarationCounts> {
  return new Map(
    Object.entries(entries).map(([k, v]) => [k, { total: v, runnable: v }]),
  );
}

const HEAD_2276 = counts({
  "tests/pr_merge_conflict_scan_test.ts": 80,
  "tests/conflict_abandon_restart_test.ts": 34,
});

function plan2276(claim: number): string {
  return "## Test Plan\n\n" +
    "- Unchanged and re-run: `tests/pr_merge_conflict_scan_test.ts`,\n" +
    "`tests/conflict_abandon_restart_test.ts` (" + claim +
    " passed together with the new\n" +
    "file). No test was removed or disabled.\n";
}

Deno.test("wrapped paragraph naming two files is read as one claim (2276 shape)", () => {
  assertEquals(
    findTestPlanMismatches({ summary: plan2276(114), headCounts: HEAD_2276 }),
    [],
  );
});

Deno.test("wrapped paragraph with a wrong count flags both files", () => {
  const found = findTestPlanMismatches({
    summary: plan2276(120),
    headCounts: HEAD_2276,
  });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.claimed, 120);
  assertEquals(found[0]!.actual, 114);
  assertEquals([...found[0]!.files].sort(), [
    "tests/conflict_abandon_restart_test.ts",
    "tests/pr_merge_conflict_scan_test.ts",
  ]);
});

const AUDIT_PATH =
  "worker/deno/tests/workflow_template_audit_conformance_test.ts";
// Real wrap: docs/archive/pr-summaries/pr-summary-1639.md:107-108 (count and "tests" on different lines).
const PLAN_1639 = "## Test Plan\n\n" +
  "Added `" + AUDIT_PATH + "` — 12\n" +
  "tests, all looping over the whole `WORKFLOW_SPECS` catalogue:\n";

// Real wrap: docs/archive/pr-summaries/pr-summary-1639.md:107-108.
Deno.test("a count split from its noun by the line break matches the head count (1639 shape)", () => {
  assertEquals(
    findTestPlanMismatches({
      summary: PLAN_1639,
      headCounts: counts({ [AUDIT_PATH]: 12 }),
    }),
    [],
  );
});

// Real wrap: docs/archive/pr-summaries/pr-summary-1639.md:107-108.
Deno.test("a count split from its noun by the line break is still compared (1639 shape)", () => {
  const found = findTestPlanMismatches({
    summary: PLAN_1639,
    headCounts: counts({ [AUDIT_PATH]: 11 }),
  });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.claimed, 12);
  assertEquals(found[0]!.actual, 11);
  assertEquals(found[0]!.files, [AUDIT_PATH]);
});

Deno.test("fenced shell continuation joins into one command (1021 shape)", () => {
  const summary = "## Test Plan\n\n```\n" +
    "deno test -A tests/run_bootstrap_test.ts tests/worker_log_cleanup_test.ts \\\n" +
    "           tests/worker_log_gzip_test.ts    50 passed, 0 failed\n```\n";
  assertEquals(
    findTestPlanMismatches({
      summary,
      headCounts: counts({
        "tests/run_bootstrap_test.ts": 20,
        "tests/worker_log_cleanup_test.ts": 20,
        "tests/worker_log_gzip_test.ts": 10,
      }),
    }),
    [],
  );
});

Deno.test("separate fenced commands are still compared separately", () => {
  const mk = (y: number) =>
    "## Test Plan\n\n```\n" +
    "deno test -A tests/x_test.ts   24 passed\n" +
    `deno test -A tests/y_test.ts   ${y} passed\n` + "```\n";
  const head = counts({ "tests/x_test.ts": 24, "tests/y_test.ts": 19 });
  assertEquals(
    findTestPlanMismatches({ summary: mk(19), headCounts: head }),
    [],
  );
  const found = findTestPlanMismatches({ summary: mk(18), headCounts: head });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.files, ["tests/y_test.ts"]);
});

Deno.test("table rows are never joined with the next row", () => {
  const summary = "## Test Plan\n\n" +
    "| `worker/deno/tests/a_test.ts` | 3 tests |\n" +
    "| `worker/deno/tests/b_test.ts` | 2 tests |\n";
  assertEquals(
    findTestPlanMismatches({
      summary,
      headCounts: counts({
        "worker/deno/tests/a_test.ts": 3,
        "worker/deno/tests/b_test.ts": 2,
      }),
    }),
    [],
  );
});

Deno.test("logicalBlocks keeps a heading and the following paragraph apart", () => {
  assertEquals(logicalBlocks("### Results\nFirst line\nsecond line"), [
    "### Results",
    "First line second line",
  ]);
});
