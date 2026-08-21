/**
 * Tests for recoverAndRetryPush — the shared recover-and-retry step
 * (Issue #211).
 *
 * The defect: every failure path logged a bare "Push failed after recovery
 * attempt" and discarded `recoverFromPushRejection`'s error, which is the
 * only place the failing step and git's stderr are recorded.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type PushRecoveryGitDeps,
  recoverAndRetryPush,
} from "../lib/push_recovery_retry.ts";
import type { Logger } from "../types.ts";

interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  context: Record<string, unknown>;
}

function makeCapturingLogger(lines: LogLine[]): Logger {
  const noop = () => {};
  const capture =
    (level: LogLine["level"]) =>
    (message: string, context?: Record<string, unknown>) => {
      lines.push({ level, message, context: context ?? {} });
    };
  return {
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

function makeGitDeps(
  overrides: Partial<PushRecoveryGitDeps>,
): PushRecoveryGitDeps {
  return {
    recoverFromPushRejection: () =>
      Promise.resolve({ ok: true, value: "Push succeeded after rebase" }),
    commitAndPushPending: () =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 1,
          finalUnpushedCount: 0,
        },
      }),
    ...overrides,
  };
}

function baseRequest(git: PushRecoveryGitDeps, logger: Logger) {
  return {
    branchName: "issue-556-fix",
    workDir: "/tmp/work",
    retryCommitMessage: "Retry after rebase recovery",
    unpushedCount: 4,
    git,
    logger,
    logContext: { repo: "org/repo", prNumber: 557 },
  };
}

Deno.test("recoverAndRetryPush - rebase onto the moved head then push reports success", async () => {
  const lines: LogLine[] = [];
  const outcome = await recoverAndRetryPush(
    baseRequest(makeGitDeps({}), makeCapturingLogger(lines)),
  );

  assertEquals(outcome.pushed, true);
  assertEquals(outcome.unpushedCount, 0);
  assertEquals(outcome.failureDetail, "");
  assertEquals(
    lines.some((l) => l.level === "error"),
    false,
    "a successful recovery must log no error",
  );
});

Deno.test("recoverAndRetryPush - a failed recovery logs the step and git stderr (Issue #211)", async () => {
  const lines: LogLine[] = [];
  const git = makeGitDeps({
    recoverFromPushRejection: () =>
      Promise.resolve({
        ok: false,
        error: new Error(
          "Push recovery failed at step 'force-with-lease': stale info",
        ),
      }),
  });

  const outcome = await recoverAndRetryPush(
    baseRequest(git, makeCapturingLogger(lines)),
  );

  assertEquals(outcome.pushed, false);
  assertEquals(outcome.unpushedCount, 4);
  assert(
    outcome.failureDetail.includes("force-with-lease"),
    `failureDetail must name the step, got: ${outcome.failureDetail}`,
  );
  assert(
    outcome.failureDetail.includes("stale info"),
    `failureDetail must carry git's stderr, got: ${outcome.failureDetail}`,
  );

  const errorLine = lines.find((l) => l.level === "error");
  assert(errorLine, "the failure must be logged at error level");
  assertEquals(
    String(errorLine.context.reason).includes("stale info"),
    true,
    "the logged context must carry git's stderr, not just 'push failed'",
  );
});

Deno.test("recoverAndRetryPush - a retry that still leaves commits reports the residual count", async () => {
  const lines: LogLine[] = [];
  const git = makeGitDeps({
    commitAndPushPending: () =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 0,
          finalUnpushedCount: 2,
        },
      }),
  });

  const outcome = await recoverAndRetryPush(
    baseRequest(git, makeCapturingLogger(lines)),
  );

  assertEquals(outcome.pushed, false);
  assertEquals(outcome.unpushedCount, 2);
  assert(
    outcome.failureDetail.includes("2 commit(s) still unpushed"),
    `failureDetail must state the residual count, got: ${outcome.failureDetail}`,
  );
});

Deno.test("recoverAndRetryPush - a failed retry commit-and-push reports its error", async () => {
  const lines: LogLine[] = [];
  const git = makeGitDeps({
    commitAndPushPending: () =>
      Promise.resolve({
        ok: false,
        error: new Error("pre-flight gate blocked the commit"),
      }),
  });

  const outcome = await recoverAndRetryPush(
    baseRequest(git, makeCapturingLogger(lines)),
  );

  assertEquals(outcome.pushed, false);
  assert(
    outcome.failureDetail.includes("pre-flight gate blocked the commit"),
    `failureDetail must carry the retry error, got: ${outcome.failureDetail}`,
  );
  assert(lines.some((l) => l.level === "error"));
});
