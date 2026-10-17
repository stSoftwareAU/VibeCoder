// Tests for hard-wrapped Test Plan prose in lib/test_plan_recount.ts (Issue #3356).
import { assertEquals } from "@std/assert";
import {
  findTestPlanMismatches,
  findUncheckedRunResults,
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

const GH = "tests/gh_wrapper_test.ts";
const BRIDGE = "tests/deno_bridge_migration_test.ts";
// Real wrap: docs/archive/pr-summaries/pr-summary-1233.md:111-113 (a count per file).
function plan1233(bridge: number): string {
  return "## Test Plan\n\n" +
    "Existing coverage re-run green: `" + GH + "` (25 tests) and\n" +
    "`" + BRIDGE + "` (" + bridge + " tests), plus the full `./quality.sh`\n" +
    "gate.\n";
}

Deno.test("a wrapped sentence with a count per file checks each file (1233 shape)", () => {
  assertEquals(
    findTestPlanMismatches({
      summary: plan1233(25),
      headCounts: counts({ [GH]: 25, [BRIDGE]: 25 }),
    }),
    [],
  );
  const found = findTestPlanMismatches({
    summary: plan1233(25),
    headCounts: counts({ [GH]: 25, [BRIDGE]: 24 }),
  });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.files, [BRIDGE]);
  assertEquals(found[0]!.claimed, 25);
  assertEquals(found[0]!.actual, 24);
});

const GUARD = "worker/deno/tests/git_guard_cli_test.ts";
const FIELD = "worker/deno/tests/guard_field_encoding_test.ts";
// Real wrap: docs/archive/pr-summaries/pr-summary-1284.md:147-148 (differing counts).
const PLAN_1284 = "## Test Plan\n\n" +
  "New — `" + GUARD + "` (8 tests) and\n" +
  "`" + FIELD + "` (4 tests): the guard's verdict.\n";

Deno.test("a stale per-file count in a wrapped sentence is flagged, not passed (1284 shape)", () => {
  assertEquals(
    findTestPlanMismatches({
      summary: PLAN_1284,
      headCounts: counts({ [GUARD]: 8, [FIELD]: 4 }),
    }),
    [],
  );
  const found = findTestPlanMismatches({
    summary: PLAN_1284,
    headCounts: counts({ [GUARD]: 9, [FIELD]: 4 }),
  });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.files, [GUARD]);
  assertEquals(found[0]!.claimed, 8);
  assertEquals(found[0]!.actual, 9);
});

Deno.test("several counts that do not follow their files are reported as unchecked", () => {
  const summary = "## Test Plan\n\n" +
    "`" + GUARD + "` has 8 tests, was 6 tests,\n" +
    "and `" + FIELD + "` is new.\n";
  const headCounts = counts({ [GUARD]: 9, [FIELD]: 4 });
  assertEquals(findTestPlanMismatches({ summary, headCounts }), []);
  const found = findUncheckedRunResults({ summary, headCounts });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.line.includes("was 6 tests"), true);
});

Deno.test("a test file named after the last count is reported as unchecked", () => {
  const summary = "## Test Plan\n\n" +
    "`" + GUARD + "` (9 tests) and `" + FIELD + "` (4 tests),\n" +
    "plus `tests/other_test.ts`.\n";
  const headCounts = counts({
    [GUARD]: 9,
    [FIELD]: 4,
    "tests/other_test.ts": 2,
  });
  assertEquals(findTestPlanMismatches({ summary, headCounts }), []);
  assertEquals(findUncheckedRunResults({ summary, headCounts }).length, 1);
});

Deno.test("different counts for one test file are reported as unchecked", () => {
  const summary = "## Test Plan\n\n`" + GUARD +
    "` has 9 tests (was 8 tests).\n";
  const headCounts = counts({ [GUARD]: 9 });
  assertEquals(findTestPlanMismatches({ summary, headCounts }), []);
  const found = findUncheckedRunResults({ summary, headCounts });
  assertEquals(found.length, 1);
  assertEquals(found[0]!.reason, "several different counts for one test file");
});

Deno.test("wrapped unchanged-file references are reported unchecked (1690 shape)", () => {
  const summary = "## Test Plan\n\n" +
    "All in `worker/deno/tests/planning_milestone_test.ts` (24 tests, all passing),\n" +
    "plus `tests/planning_processor_test.ts` and `tests/native_sub_issues_test.ts`\n" +
    "re-run unchanged.\n";
  const opts = {
    summary,
    headCounts: counts({ "worker/deno/tests/planning_milestone_test.ts": 25 }),
  };
  assertEquals(findTestPlanMismatches(opts), []);
  const found = findUncheckedRunResults(opts);
  assertEquals(found.length, 1);
  assertEquals(
    found[0]!.reason,
    "the block names a test file the PR did not change",
  );
});

Deno.test("wrapped test counts mixed with red-run prose are reported unchecked (373 shape)", () => {
  const summary = "## Test Plan\n\n" +
    "New `worker/deno/tests/coding_guidelines_v42_test.ts` (12 tests), written\n" +
    "before the template and confirmed failing against v41 (10 failed / 2 passed)\n";
  const opts = {
    summary,
    headCounts: counts({
      "worker/deno/tests/coding_guidelines_v42_test.ts": 13,
    }),
  };
  assertEquals(findTestPlanMismatches(opts), []);
  const found = findUncheckedRunResults(opts);
  assertEquals(found.length, 1);
  assertEquals(found[0]!.reason, "the block mixes tests and passed counts");
});

// "Extended" governs every figure in its sentence, so both figures stay unchecked rather than compared (#3740).
Deno.test("wrapped partial additions are reported unchecked instead of silently skipped", () => {
  const opts = {
    summary:
      "## Test Plan\n\nExtended `tests/a_test.ts` with 3 tests,\nplus `tests/b_test.ts` (4 tests).\n",
    headCounts: counts({ "tests/a_test.ts": 10, "tests/b_test.ts": 5 }),
  };
  assertEquals(findTestPlanMismatches(opts), []);
  const found = findUncheckedRunResults(opts);
  assertEquals(found.length, 2);
  for (const entry of found) {
    assertEquals(
      entry.reason,
      "the block describes partial test additions, not whole-file counts",
    );
    assertEquals(entry.line.includes("tests/a_test.ts"), true);
    assertEquals(entry.line.includes("tests/b_test.ts"), true);
  }
});

Deno.test("a per-file breakdown is not counted again in the next run (3315 shape)", () => {
  const summary = "## Test Plan\n\n" +
    "`deno test -A tests/pr_body_sync_test.ts tests/missing_criterion_close_guard_3177_test.ts` — 40 passed " +
    "(30 in `pr_body_sync_test.ts`). `deno test -A tests/pr_feedback_processor_test.ts` — 41 passed.\n";
  for (const feedback of [41, 42]) {
    const opts = {
      summary,
      headCounts: counts({
        "tests/pr_body_sync_test.ts": 30,
        "tests/missing_criterion_close_guard_3177_test.ts": 10,
        "tests/pr_feedback_processor_test.ts": feedback,
      }),
    };
    assertEquals(findUncheckedRunResults(opts), []);
    const found = findTestPlanMismatches(opts);
    if (feedback === 41) assertEquals(found, []);
    else {
      assertEquals(found.length, 1);
      assertEquals(found[0]!.files, ["tests/pr_feedback_processor_test.ts"]);
      assertEquals(found[0]!.claimed, 41);
      assertEquals(found[0]!.actual, 42);
    }
  }
});

Deno.test("a later claim naming only an already matched file is reported unchecked", () => {
  const opts = {
    summary:
      "## Test Plan\n\n`tests/a_test.ts` and `tests/b_test.ts` — 40 passed; `tests/a_test.ts` — 30 passed.\n",
    headCounts: counts({ "tests/a_test.ts": 30, "tests/b_test.ts": 10 }),
  };
  assertEquals(findTestPlanMismatches(opts), []);
  assertEquals(findUncheckedRunResults(opts).length, 1);
});
