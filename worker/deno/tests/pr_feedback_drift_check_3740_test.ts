/**
 * Tests for Issues #3740 and #5223. Issue #3740 made a Test Plan figure that
 * `findUncheckedRunResults` cannot check a drift hit that drove the one
 * recovery turn. Issue #5223 retired that trigger: an unchecked figure is a
 * limit of the recount, not evidence the figure is false, so on its own it
 * launches no recovery turn. It still prevents a `clean` outcome, is logged
 * with the "could not check" warning and is listed in the residual as
 * unverified, so the outcome is `reported`. A real defect (a Test Plan
 * mismatch here) still runs the one recovery turn, whose prompt carries the
 * mismatch but never the unchecked figure.
 *
 * Real temporary git repos throughout, mirroring
 * `pr_feedback_drift_check_3341_test.ts` and `pr_feedback_drift_check_3143_test.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type DriftCheckDeps,
  type DriftResidual,
  formatDriftResidual,
  runPrFeedbackDriftCheck,
} from "../lib/pr_feedback_drift_check.ts";
import {
  type AgentCall,
  commitAll,
  git,
  initRepo,
  makeRunAgent,
  makeRunGh,
  makeRunGit,
  noopLogger,
  verdictBlock,
  writeFile,
} from "./support/drift_check_fixture.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";
// Test-repo scaffolding lives in tests/support/drift_check_fixture.ts.

// ---------------------------------------------------------------------------
// Fixtures. The Test Plan names no test file, so the red result has no sole
// changed test file to be compared with, and `findUncheckedRunResults`
// reports it (the same fixture Issue #3381 uses in the 3143 test).
// ---------------------------------------------------------------------------

const RULE_TS_V1 =
  `export function checkRule(entry: { subject?: string }): boolean {
  if (!entry.subject) return true;
  return entry.subject.length > 0;
}
`;

const RULE_TS_V2 =
  `export function checkRule(entry: { subject?: string }): boolean {
  // A comment added by the fix push.
  if (!entry.subject) return true;
  return entry.subject.length > 0;
}
`;

const RULE_TEST_TS = `import { assertEquals } from "@std/assert";
import { checkRule } from "../lib/rule.ts";

Deno.test("checkRule - accepts a subject", () => {
  assertEquals(checkRule({ subject: "x" }), true);
});
`;

/** The fix push changes the code and the test file, keeping one test. */
const RULE_TEST_TS_V2 = `// A comment added by the fix push.
${RULE_TEST_TS}`;

/**
 * Applies the fix push: `tests/rule_test.ts` is part of the change so the
 * Test Plan's `tests/rule_test.ts (1 test)` figure names a changed file.
 */
async function applyFixPush(dir: string) {
  await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_TS_V2);
}

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";

const RED_LINE = "- Red on base: 5 passed, 2 failed.";
const UNCHECKED_LINE = "Red on base: 5 passed, 2 failed.";

function summaryWith(testPlanLine: string): string {
  return `## Summary

Closes #7.

**Docs sweep** — grep: \`subject\`; section: none — no manual documents this flag; siblings: none — no existing set gained a member

## Test Plan

${testPlanLine}
`;
}

const SUMMARY_UNCHECKED = summaryWith(RED_LINE);
const SUMMARY_CHECKABLE = summaryWith(
  "- Added `tests/rule_test.ts` (1 test).",
);

const DEFAULT_INPUT = { repo: "org/repo", prNumber: 7 };

/**
 * Base repo: code + test + PR summary committed on a feature branch. The
 * caller then changes `lib/rule.ts` and rewrites the summary in the working
 * tree, the same way the 3143 test sets up its push.
 */
async function setupBaseline(
  summary: string,
): Promise<{ dir: string; beforeSha: string }> {
  const dir = await initRepo("drift_check_3740_");
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_TS);
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  await writeFile(dir, SUMMARY_PATH, summary);
  await commitAll(dir, "docs: add PR summary");
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, beforeSha: rev.stdout.trim() };
}

/** Warn-capturing logger for the log-field assertions. */
function capturingLogger(
  warnings: { message: string; fields?: unknown }[],
): DriftCheckDeps["logger"] {
  return {
    ...noopLogger(),
    warn: (message: string, fields?: unknown) => {
      warnings.push({ message, fields });
    },
  };
}

// ---------------------------------------------------------------------------
// 1. An unchecked-only figure launches no recovery turn and is reported as
// unverified (Issue #5223).
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - an unchecked-only Test Plan figure launches no recovery turn and is reported unverified (Issue #5223)", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_CHECKABLE);
  try {
    await applyFixPush(dir);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_UNCHECKED);

    await assertRejects(() => Deno.lstat(prResponseMessagePath(dir)));

    const warnings: { message: string; fields?: unknown }[] = [];
    const infos: string[] = [];
    const logger: DriftCheckDeps["logger"] = {
      ...capturingLogger(warnings),
      info: (message: string) => {
        infos.push(message);
      },
    };
    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      { runGit: makeRunGit(dir), runGh: makeRunGh(), runAgent, logger },
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertEquals(outcome.recoveryRan, false);
      assertEquals(outcome.residual.testPlanUnchecked?.length, 1);
      assert(
        outcome.residual.testPlanUnchecked?.[0]?.includes(UNCHECKED_LINE),
      );
      assertEquals(outcome.residual.mismatches, []);
    }

    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assertStringIncludes(
      message,
      "Test Plan figures the drift check could not verify:",
    );
    assertStringIncludes(message, UNCHECKED_LINE);
    assertStringIncludes(message, "could not check it fully");

    assert(
      warnings.some((w) =>
        w.message.includes("Test Plan recount could not check 1 figure(s)")
      ),
    );
    const seen = [...warnings.map((w) => w.message), ...infos];
    assert(
      !seen.some((m) =>
        m.includes(
          "Drift check found hits \u2014 running one recovery turn (Issue #3143)",
        )
      ),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 2. A real Test Plan mismatch beside an unchecked figure still runs the
// recovery turn; its prompt carries the mismatch but not the unchecked figure.
// ---------------------------------------------------------------------------

const UNCHECKED_PLAN_TEXT = "Added 5 tests to `tests/rule_test.ts`.";
const MISMATCH_AND_UNCHECKED_PLAN = [
  "- Added `tests/rule_test.ts` (3 tests).",
  "- Added 5 tests to `tests/rule_test.ts`.",
].join("\n");
const FIXED_MISMATCH_AND_UNCHECKED_PLAN = [
  "- Added `tests/rule_test.ts` (1 test).",
  "- Added 5 tests to `tests/rule_test.ts`.",
].join("\n");

Deno.test("runPrFeedbackDriftCheck - a Test Plan mismatch beside an unchecked figure still runs the recovery turn, whose prompt omits the unchecked figure (Issue #5223)", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_CHECKABLE);
  try {
    await applyFixPush(dir);
    await writeFile(
      dir,
      SUMMARY_PATH,
      summaryWith(MISMATCH_AND_UNCHECKED_PLAN),
    );

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        () => {
          // The recovery turn fixes only the mismatch (3 -> 1).
          Deno.writeTextFileSync(
            `${dir}/${SUMMARY_PATH}`,
            summaryWith(FIXED_MISMATCH_AND_UNCHECKED_PLAN),
          );
          return { ok: true, output: "fixed the count" };
        },
      ],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 2);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(calls[1]!.readOnly, false);
    const prompt = calls[1]!.prompt;
    assertStringIncludes(prompt, "Test Plan mismatches:");
    assert(!prompt.includes("could not check"));
    assert(!prompt.includes("re-run the tests"));
    assert(!prompt.includes(UNCHECKED_PLAN_TEXT));

    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertEquals(outcome.recoveryRan, true);
      assertEquals(outcome.residual.mismatches, []);
      assertEquals(outcome.residual.testPlanUnchecked?.length, 1);
      assert(
        outcome.residual.testPlanUnchecked?.[0]?.includes(UNCHECKED_PLAN_TEXT),
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 4. The residual formatter renders the unchecked figures under their own
// heading, flattens them to one line each, and does not claim a found hit.
// ---------------------------------------------------------------------------

Deno.test("formatDriftResidual - renders unchecked Test Plan figures under their own heading, flattened, without a found-hit intro (Issue #3740)", () => {
  const residual: DriftResidual = {
    findings: [],
    mismatches: [],
    docsSweepProblems: [],
    testPlanUnchecked: [
      `docs/x.md: the block names a test file the PR did not change — "Red on base:\n5 passed, 2 failed."`,
    ],
  };

  const text = formatDriftResidual(residual);

  assertStringIncludes(
    text,
    'Test Plan figures the drift check could not verify:\n- docs/x.md: the block names a test file the PR did not change — "Red on base: 5 passed, 2 failed."',
  );
  assert(!text.includes("found text this push leaves out of step"));
});

// ---------------------------------------------------------------------------
// 5. The residual warning carries the unchecked-figure count.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - the residual warning reports the unchecked Test Plan figure count (Issue #3740)", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_CHECKABLE);
  try {
    await applyFixPush(dir);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_UNCHECKED);

    const warnings: { message: string; fields?: unknown }[] = [];
    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        { ok: true, output: "did nothing" },
      ],
      [],
    );

    await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: capturingLogger(warnings),
      },
    );

    const residualWarn = warnings.find((w) =>
      w.message === "Drift check reported residual drift after recovery"
    );
    assert(residualWarn !== undefined);
    assertEquals(
      (residualWarn!.fields as Record<string, unknown>).testPlanUnchecked,
      1,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 6. A Test Plan with no unchecked figure stays clean: no recovery turn and
// no residual, so the new hit does not fire on every summary.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - a Test Plan with no unchecked figure stays clean with no recovery turn (Issue #3740)", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_CHECKABLE);
  try {
    await applyFixPush(dir);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 1);
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 7. A Rust-only fix push names a red Rust test file, and no countable test
// file changed, so the file-less red result is out of scope: the check stays
// clean with one read-only call and no recovery turn (Issue #4537).
// ---------------------------------------------------------------------------

const RUST_TEST_RS = `#[test]
fn rule_rejects_missing_subject() {
    assert!(true);
}
`;

const RUST_RED_LINE =
  "- Red on base: 5 passed, 2 failed (`tests/rule_regression.rs`, 7 tests at head).";
const SUMMARY_RUST_RED = summaryWith(RUST_RED_LINE);

/** The Rust-only fix push: the code and a Rust test file, no countable test file. */
async function applyRustFixPush(dir: string) {
  await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
  await writeFile(dir, "tests/rule_regression.rs", RUST_TEST_RS);
}

Deno.test("runPrFeedbackDriftCheck - a red result naming only a Rust test file in a PR with no countable test file stays clean with one read-only call (Issue #4537)", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_CHECKABLE);
  try {
    await applyRustFixPush(dir);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_RUST_RED);

    const warnings: { message: string; fields?: unknown }[] = [];
    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: capturingLogger(warnings),
      },
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(outcome.status, "clean");
    assertEquals(
      warnings.filter((w) =>
        w.message.startsWith("Test Plan recount could not check")
      ).length,
      0,
    );
    await assertRejects(() => Deno.lstat(prResponseMessagePath(dir)));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - the same Rust-named red result with a changed countable test file is still unchecked but launches no recovery turn (Issues #4537, #5223)", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_CHECKABLE);
  try {
    await applyRustFixPush(dir);
    // A changed countable test file, not named in the plan, gives the recount
    // a file to count, so the file-less red result is unchecked again.
    await writeFile(dir, "tests/rule_test.ts", RULE_TEST_TS_V2);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_RUST_RED);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [{ ok: true, output: verdictBlock([]) }],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertEquals(outcome.recoveryRan, false);
      assertEquals(outcome.residual.testPlanUnchecked?.length, 1);
      assert(
        outcome.residual.testPlanUnchecked?.[0]?.includes(
          "Red on base: 5 passed, 2 failed",
        ),
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
