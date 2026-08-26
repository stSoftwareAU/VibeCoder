/**
 * Clone contention is not a PR branch-update failure (Issue #394).
 *
 * Lanes on one host share a repository's git state, so a lane can find a
 * branch it just resolved gone, a branch another lane has checked out, or
 * commits an issue slot has not pushed yet. All three used to be counted as
 * `failedCount`, logged as WARNINGs that read as "your branch is gone", and
 * fed into the per-branch failure streak — which escalates an issue after
 * three cycles for a PR that was never broken.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { prBranchConflictError } from "../lib/git_pull.ts";
import { LOCAL_AHEAD_OF_REMOTE_ERROR } from "../lib/git_branch_sync.ts";
import {
  executePrBranchUpdates,
  type PrBranchExecutionDeps,
  type PrBranchUpdateAction,
  resetPrConflictWarnings,
} from "../lib/pr_branch_update.ts";
import { loadPrBranchFailureStreaks } from "../lib/pr_branch_update_failure_streak.ts";
import type { Logger, Result } from "../types.ts";

interface CapturedLogs {
  info: string[];
  warn: string[];
}

function makeCapturingLogger(captured: CapturedLogs): Logger {
  const noop = () => {};
  return {
    info: (m: string) => {
      captured.info.push(m);
    },
    warn: (m: string) => {
      captured.warn.push(m);
    },
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

function makeAction(
  overrides?: Partial<PrBranchUpdateAction>,
): PrBranchUpdateAction {
  return {
    repo: "org/repo",
    prNumber: 392,
    branchName: "issue-373-prompts-coding-guidelines",
    baseBranch: "milestone/358-model-agnostic",
    behindBy: 2,
    reason: "behind",
    ...overrides,
  };
}

function makeExecDeps(
  overrides?: Partial<PrBranchExecutionDeps>,
): PrBranchExecutionDeps {
  return {
    workDir: "/tmp/work",
    logger: makeCapturingLogger({ info: [], warn: [] }),
    setupRepo: async () =>
      ({ ok: true, value: "/tmp/work/repo" }) as Result<string>,
    getDefaultBranch: async () => "main",
    performBranchUpdate: async () =>
      ({ ok: true, value: "Updated successfully" }) as Result<string>,
    ...overrides,
  };
}

/** The exact failure the worker logged for PR #392 (Issue #394). */
const PATHSPEC_ERROR = new Error(
  "Failed to checkout branch 'issue-373-prompts-coding-guidelines': " +
    "error: pathspec 'issue-373-prompts-coding-guidelines' did not match " +
    "any file(s) known to git",
);

/** The Issue #211 refusal that blocked PR #390 in the same pass. */
function aheadOfRemoteError(): Error {
  const err = new Error(
    "Local branch 'issue-366-fix' is ahead of the remote head by 2 " +
      "commit(s) — refusing to judge it against its base (Issue #211)",
  );
  err.name = LOCAL_AHEAD_OF_REMOTE_ERROR;
  return err;
}

Deno.test("executePrBranchUpdates - a branch that vanished from the clone is contention, not a failure", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  const result = await executePrBranchUpdates([makeAction()], makeExecDeps({
    logger: makeCapturingLogger(captured),
    performBranchUpdate: async () => ({ ok: false, error: PATHSPEC_ERROR }),
  }));

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.failedCount, 0);
  assertEquals(result.value.contendedCount, 1);
  assertEquals(result.value.details[0]!.status, "contended");
  // The operator is told the clone changed, not that the branch is gone.
  assertEquals(captured.warn.length, 0, captured.warn.join(" | "));
  const line = captured.info.find((m) => m.includes("deferred")) ?? "";
  assertStringIncludes(line, "PR #392");
  assertStringIncludes(line, "moved the clone under the operation");
  assertStringIncludes(line, "not at fault");
  assertStringIncludes(line, "retried next cycle");
});

Deno.test("executePrBranchUpdates - unpushed commits another lane left are contention, not a failure", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  const result = await executePrBranchUpdates(
    [makeAction({ prNumber: 390, branchName: "issue-366-fix" })],
    makeExecDeps({
      logger: makeCapturingLogger(captured),
      performBranchUpdate: async () => ({
        ok: false,
        error: aheadOfRemoteError(),
      }),
    }),
  );

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.failedCount, 0);
  assertEquals(result.value.contendedCount, 1);
  assertEquals(result.value.details[0]!.status, "contended");
  const deferred = captured.info.find((m) => m.includes("deferred")) ?? "";
  assertStringIncludes(deferred, "PR #390");
  assertStringIncludes(deferred, "origin has never seen");
});

Deno.test("executePrBranchUpdates - contention never counts towards the escalation streak (Issue #335)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "pr_branch_contention_" });
  const statePath = `${tmpDir}/streaks.json`;
  try {
    const ghCalls: string[][] = [];
    for (let cycle = 1; cycle <= 4; cycle++) {
      const result = await executePrBranchUpdates([makeAction()], makeExecDeps({
        getPrState: async () => "OPEN",
        performBranchUpdate: async () => ({ ok: false, error: PATHSPEC_ERROR }),
        failureStreak: {
          statePath,
          cycleId: `cycle-${cycle}`,
          ghFn: async (args: string[]) => {
            ghCalls.push(args);
            return "https://github.com/org/repo/issues/999";
          },
          threshold: 3,
        },
      }));
      assertEquals(result.ok, true);
      if (result.ok) assertEquals(result.value.contendedCount, 1);
    }

    // Four contended cycles must not escalate anything.
    assertEquals(ghCalls.length, 0, JSON.stringify(ghCalls));
    const streaks = await loadPrBranchFailureStreaks(statePath);
    assertEquals(Object.keys(streaks).length, 0, JSON.stringify(streaks));
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("executePrBranchUpdates - a repository setup lost to another lane is contention", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  const result = await executePrBranchUpdates([makeAction()], makeExecDeps({
    logger: makeCapturingLogger(captured),
    setupRepo: async () => ({
      ok: false,
      error: new Error(
        "fatal: Unable to create '/work/repo/.git/index.lock': File exists.",
      ),
    }),
  }));

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.failedCount, 0);
  assertEquals(result.value.contendedCount, 1);
  assertEquals(result.value.details[0]!.status, "contended");
  const deferredSetup = captured.info.find((m) => m.includes("deferred")) ?? "";
  assertStringIncludes(deferredSetup, "PR #392");
  assertStringIncludes(deferredSetup, "git lock");
});

Deno.test("executePrBranchUpdates - a genuine push failure is still a loud failure", async () => {
  const captured: CapturedLogs = { info: [], warn: [] };
  const result = await executePrBranchUpdates([makeAction()], makeExecDeps({
    logger: makeCapturingLogger(captured),
    performBranchUpdate: async () => ({
      ok: false,
      error: new Error(
        "Failed to push updated branch 'issue-373-prompts-coding-guidelines': " +
          "! [remote rejected] (protected branch hook declined)",
      ),
    }),
  }));

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.failedCount, 1);
  assertEquals(result.value.contendedCount, 0);
  assertEquals(result.value.details[0]!.status, "failed");
  assertEquals(captured.warn.length >= 1, true);
});

Deno.test("executePrBranchUpdates - a real merge conflict is still a conflict, not contention", async () => {
  resetPrConflictWarnings();
  const result = await executePrBranchUpdates([makeAction()], makeExecDeps({
    performBranchUpdate: async () => ({
      ok: false,
      error: prBranchConflictError(
        "issue-373-prompts-coding-guidelines",
        "milestone/358-model-agnostic",
        "rebase",
      ),
    }),
  }));

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.conflictCount, 1);
  assertEquals(result.value.contendedCount, 0);
  assertEquals(result.value.details[0]!.status, "conflict");
});

Deno.test("executePrBranchUpdates - the distributed lock is released when the clone is contended", async () => {
  const released: number[] = [];
  const result = await executePrBranchUpdates([makeAction()], makeExecDeps({
    workerId: "worker-a",
    acquireLock: async () => ({
      ok: true,
      value: { acquired: true, lockCommentId: 77 },
    }),
    releaseLock: async (options: { lockCommentId: number }) => {
      released.push(options.lockCommentId);
      return { ok: true, value: undefined };
    },
    setupRepo: async () => ({
      ok: false,
      error: new Error("fatal: Unable to create '.git/index.lock': File exists."),
    }),
  }));

  assertEquals(result.ok, true);
  assertEquals(released, [77]);
});
