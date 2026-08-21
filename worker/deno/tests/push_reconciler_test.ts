/**
 * Push reconciliation tests (Issue #211).
 *
 * A sibling fleet host pushed to the PR branch two minutes before this host
 * finished its run. The worker must re-apply onto the moved head instead of
 * dropping the recovery error and asking a human to "check the branch status".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { reconcileRejectedPush } from "../lib/push_reconciler.ts";
import type { PushReconcilerGit } from "../lib/push_reconciler.ts";
import type { LogContext, Logger } from "../types.ts";

const REPO = "stSoftwareAU/NEAT-AI-core";
const PR = 557;
const BRANCH = "issue-556-fix";

interface CapturedLog {
  level: "info" | "warn" | "error";
  message: string;
  context?: LogContext;
}

function captureLogger(sink: CapturedLog[]): Logger {
  const noop = () => {};
  return {
    info: (message, context) => sink.push({ level: "info", message, context }),
    warn: (message, context) => sink.push({ level: "warn", message, context }),
    error: (message, context) =>
      sink.push({ level: "error", message, context }),
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** Git deps that fail everything unless a test overrides the step. */
function gitDeps(
  overrides: Partial<PushReconcilerGit> = {},
): PushReconcilerGit {
  return {
    recoverFromPushRejection: () =>
      Promise.resolve({
        ok: false,
        error: new Error(
          "push recovery step 'force-with-lease' failed: stale info",
        ),
      }),
    reapplyOntoRemoteHead: () =>
      Promise.resolve({
        ok: false,
        error: new Error("re-apply step 'rebase' failed: CONFLICT in app.ts"),
      }),
    commitAndPushPending: () =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 0,
          finalUnpushedCount: 4,
        },
      }),
    ...overrides,
  };
}

function run(git: PushReconcilerGit, logs: CapturedLog[]) {
  return reconcileRejectedPush({
    branchName: BRANCH,
    commitMessage: "Retry after recovery",
    options: { cwd: "/tmp/repo" },
    unpushedCount: 4,
    git,
    logger: captureLogger(logs),
    repo: REPO,
    prNumber: PR,
  });
}

// ---------------------------------------------------------------------------
// Recovery succeeds — no re-apply needed
// ---------------------------------------------------------------------------

Deno.test("reconcileRejectedPush - reports pushed when recovery clears the backlog", async () => {
  const logs: CapturedLog[] = [];
  let reapplyCalls = 0;
  const result = await run(
    gitDeps({
      recoverFromPushRejection: () =>
        Promise.resolve({
          ok: true,
          value: "Push succeeded after rebase recovery",
        }),
      commitAndPushPending: () =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 4,
            finalUnpushedCount: 0,
          },
        }),
      reapplyOntoRemoteHead: () => {
        reapplyCalls++;
        return Promise.resolve({
          ok: false,
          error: new Error("should not be called"),
        });
      },
    }),
    logs,
  );

  assertEquals(result.pushed, true);
  assertEquals(result.finalUnpushedCount, 0);
  assertEquals(reapplyCalls, 0);
  assert(logs.every((l) => l.level !== "error"));
});

// ---------------------------------------------------------------------------
// The incident: recovery fails, the head moved, re-apply lands the commits
// ---------------------------------------------------------------------------

Deno.test("reconcileRejectedPush - re-applies onto the moved head after a failed recovery", async () => {
  const logs: CapturedLog[] = [];
  let commitCalls = 0;
  const result = await run(
    gitDeps({
      reapplyOntoRemoteHead: () =>
        Promise.resolve({
          ok: true,
          value: {
            rebased: true,
            pushed: true,
            commitsReapplied: 4,
            detail: "re-applied 4 commit(s) onto the moved head",
          },
        }),
      commitAndPushPending: () => {
        commitCalls++;
        return Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 4,
            finalUnpushedCount: 0,
          },
        });
      },
    }),
    logs,
  );

  assertEquals(result.pushed, true);
  assertEquals(result.finalUnpushedCount, 0);
  assertEquals(commitCalls, 1, "the re-apply outcome is confirmed against git");
  // The dropped recovery error is now part of the trail (Issue #211 defect 1).
  assertStringIncludes(result.detail, "force-with-lease");
  assertStringIncludes(result.detail, "re-applied 4 commit(s)");
  assert(
    logs.every((l) => l.level !== "error"),
    "a reconciled push must not be logged as a failure",
  );
});

// ---------------------------------------------------------------------------
// Genuine conflict — fails loudly with the git stderr from every step
// ---------------------------------------------------------------------------

Deno.test("reconcileRejectedPush - fails loudly with each step's git stderr", async () => {
  const logs: CapturedLog[] = [];
  const result = await run(gitDeps(), logs);

  assertEquals(result.pushed, false);
  assertEquals(result.finalUnpushedCount, 4);
  assertStringIncludes(result.detail, "recovery failed");
  assertStringIncludes(result.detail, "stale info");
  assertStringIncludes(result.detail, "CONFLICT in app.ts");

  const errors = logs.filter((l) => l.level === "error");
  assertEquals(errors.length, 1);
  assertStringIncludes(
    String(errors[0]!.context?.detail),
    "CONFLICT in app.ts",
  );
});

// ---------------------------------------------------------------------------
// A re-apply that claims success but leaves commits behind is not success
// ---------------------------------------------------------------------------

Deno.test("reconcileRejectedPush - a re-apply that leaves commits unpushed is a failure", async () => {
  const logs: CapturedLog[] = [];
  const result = await run(
    gitDeps({
      reapplyOntoRemoteHead: () =>
        Promise.resolve({
          ok: true,
          value: {
            rebased: true,
            pushed: true,
            commitsReapplied: 4,
            detail: "re-applied 4 commit(s)",
          },
        }),
    }),
    logs,
  );

  assertEquals(result.pushed, false);
  assertEquals(result.finalUnpushedCount, 4);
  assertStringIncludes(result.detail, "still unpushed after re-apply");
  assertEquals(logs.filter((l) => l.level === "error").length, 1);
});
