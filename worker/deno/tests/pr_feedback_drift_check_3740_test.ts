/**
 * Tests for Issue #3740: a Test Plan figure that `findUncheckedRunResults`
 * cannot check is a drift hit, not only a log line. It drives the one
 * recovery turn (fenced into the recovery prompt), is re-checked after
 * recovery against the fresh summaries, and is reported in the residual if it
 * survives.
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
  type DriftFinding,
  type DriftResidual,
  formatDriftResidual,
  runPrFeedbackDriftCheck,
} from "../lib/pr_feedback_drift_check.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";

// ---------------------------------------------------------------------------
// Test-repo scaffolding (copied from pr_feedback_drift_check_3341_test.ts;
// these helpers are file-local there).
// ---------------------------------------------------------------------------

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(dir: string, args: string[]): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function writeFile(dir: string, path: string, content: string) {
  const full = `${dir}/${path}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, content);
}

async function commitAll(dir: string, message: string) {
  assertEquals((await git(dir, ["add", "."])).code, 0);
  assertEquals((await git(dir, ["commit", "-m", message])).code, 0);
}

async function initRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "drift_check_3740_" });
  assertEquals((await git(dir, ["init", "-b", "main"])).code, 0);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

/** Fake `runGit` that shells out to real git in `dir`. */
function makeRunGit(dir: string): DriftCheckDeps["runGit"] {
  return async (args: string[]) => await git(dir, args);
}

/** Fake `runGh` that always answers the `baseRefName` read with `main`. */
function makeRunGh(): DriftCheckDeps["runGh"] {
  return async () => "main\n";
}

/** Fake `runMutationCheck` for tests not about the mutation gate (Issue #3750). */
const notMutationChecked: DriftCheckDeps["runMutationCheck"] = async () => ({
  kind: "not_applicable",
  reason: "not under test",
});

type AgentResponse =
  | { ok: true; output: string }
  | { ok: false; error: Error };
type AgentCall = { prompt: string; readOnly: boolean };

function makeRunAgent(
  responses: readonly (AgentResponse | ((call: AgentCall) => AgentResponse))[],
  calls: AgentCall[],
): DriftCheckDeps["runAgent"] {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const resp = responses[i++];
    if (!resp) {
      throw new Error(`runAgent called more times (${i}) than expected`);
    }
    return typeof resp === "function" ? resp(req) : resp;
  };
}

function noopLogger(): DriftCheckDeps["logger"] {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

const DRIFT_OPEN = "<!-- vibe-drift-verdict -->";
const DRIFT_CLOSE = "<!-- /vibe-drift-verdict -->";

function verdictBlock(findings: DriftFinding[]): string {
  return [
    DRIFT_OPEN,
    "```json",
    JSON.stringify({ findings }, null, 2),
    "```",
    DRIFT_CLOSE,
  ].join("\n");
}

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
  const dir = await initRepo();
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
// 1. An unchecked figure is a drift hit: it runs the recovery turn, and the
// recovery prompt fences the figure into the untrusted-block list.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - an unchecked Test Plan figure runs the recovery turn with the figure fenced into it (Issue #3740)", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_CHECKABLE);
  try {
    await applyFixPush(dir);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_UNCHECKED);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        { ok: true, output: "did nothing" },
      ],
      calls,
    );

    await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runMutationCheck: notMutationChecked,
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 2);
    assertEquals(calls[0]!.readOnly, true);
    assertEquals(calls[1]!.readOnly, false);
    const prompt = calls[1]!.prompt;
    assertStringIncludes(
      prompt,
      "Test Plan figures the recount could not check:",
    );
    assertStringIncludes(prompt, UNCHECKED_LINE);
    assertStringIncludes(
      prompt,
      "the Test Plan figures the recount could not check",
    );
    assertStringIncludes(
      prompt,
      "re-run the tests it names on the head and restate the figure",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 2. The recovery turn leaves the figure in place, so it survives into the
// residual and the reply message.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - an unchecked Test Plan figure that survives recovery is reported in the residual and the reply (Issue #3740)", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_CHECKABLE);
  try {
    await applyFixPush(dir);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_UNCHECKED);

    await assertRejects(() => Deno.lstat(prResponseMessagePath(dir)));

    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        { ok: true, output: "did nothing" },
      ],
      [],
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runMutationCheck: notMutationChecked,
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assertEquals(outcome.recoveryRan, true);
      assertEquals(outcome.residual.testPlanUnchecked?.length, 1);
      assert(
        outcome.residual.testPlanUnchecked?.[0]?.includes(UNCHECKED_LINE),
      );
    }

    const message = await Deno.readTextFile(prResponseMessagePath(dir));
    assertStringIncludes(
      message,
      "Test Plan figures the drift check could not verify:",
    );
    assertStringIncludes(message, UNCHECKED_LINE);
    // With no other hit, the reply says the check could not check it fully.
    assertStringIncludes(message, "could not check it fully");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 3. The recovery turn restates the figure in a checkable form (here by
// removing it), and the post-recovery recompute clears it: recovered, with no
// residual.
// ---------------------------------------------------------------------------

Deno.test("runPrFeedbackDriftCheck - an unchecked Test Plan figure the recovery turn removes is recovered, not reported (Issue #3740)", async () => {
  const { dir, beforeSha } = await setupBaseline(SUMMARY_CHECKABLE);
  try {
    await applyFixPush(dir);
    await writeFile(dir, SUMMARY_PATH, SUMMARY_UNCHECKED);

    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        () => {
          // The recovery turn rewrites the Test Plan so no figure is left
          // uncheckable, as the restate step allows.
          Deno.writeTextFileSync(`${dir}/${SUMMARY_PATH}`, SUMMARY_CHECKABLE);
          return { ok: true, output: "restated" };
        },
      ],
      calls,
    );

    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runMutationCheck: notMutationChecked,
        runAgent,
        logger: noopLogger(),
      },
    );

    assertEquals(calls.length, 2);
    assertEquals(outcome.status, "recovered");
    await assertRejects(() => Deno.lstat(prResponseMessagePath(dir)));
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
        runMutationCheck: notMutationChecked,
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
        runMutationCheck: notMutationChecked,
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
