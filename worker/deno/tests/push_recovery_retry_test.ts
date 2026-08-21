/**
 * Tests for recoverAndRetryPush — the shared recovery step for the PR
 * processors (Issue #211).
 *
 * A rejected push must report the step that failed and git's own reason, so
 * the log names a cause instead of the bare "Push failed after recovery
 * attempt" the fleet has been emitting.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PushRecoveryGitDeps,
  recoverAndRetryPush,
} from "../lib/push_recovery_retry.ts";
import type { CommitAndPushPendingResult } from "../lib/git_push.ts";

function gitDeps(overrides: {
  recovery?: { ok: true; value: string } | { ok: false; error: Error };
  retry?:
    | { ok: true; value: CommitAndPushPendingResult }
    | { ok: false; error: Error };
}): PushRecoveryGitDeps {
  return {
    recoverFromPushRejection: () =>
      Promise.resolve(
        overrides.recovery ?? { ok: true as const, value: "recovered" },
      ),
    commitAndPushPending: () =>
      Promise.resolve(
        overrides.retry ?? {
          ok: true as const,
          value: {
            committedNewChanges: false,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        },
      ),
  } as unknown as PushRecoveryGitDeps;
}

const BASE = {
  branchName: "issue-556-fix",
  cwd: "/tmp/repo",
  commitMessage: "Retry after rebase recovery",
  unpushedBefore: 4,
};

Deno.test("recoverAndRetryPush - reports a clean push with nothing unpushed", async () => {
  const result = await recoverAndRetryPush({ ...BASE, git: gitDeps({}) });
  assertEquals(result.unpushed, 0);
  assertEquals(result.failedStep, undefined);
  assertEquals(result.detail, undefined);
});

Deno.test("recoverAndRetryPush - surfaces the rebase failure reason (Issue #211)", async () => {
  const result = await recoverAndRetryPush({
    ...BASE,
    git: gitDeps({
      recovery: {
        ok: false,
        error: new Error(
          "--force-with-lease push also failed: stale info, refusing to update ref",
        ),
      },
    }),
  });

  assertEquals(result.unpushed, 4);
  assertEquals(result.failedStep, "rebase-recovery");
  assert(result.detail, "the recovery failure must carry git's reason");
  assertStringIncludes(result.detail, "stale info");
});

Deno.test("recoverAndRetryPush - surfaces a retry push that could not commit (Issue #211)", async () => {
  const result = await recoverAndRetryPush({
    ...BASE,
    git: gitDeps({
      retry: { ok: false, error: new Error("pre-flight gate blocked: quality.sh exit 1") },
    }),
  });

  assertEquals(result.unpushed, 4);
  assertEquals(result.failedStep, "retry-push");
  assert(result.detail);
  assertStringIncludes(result.detail, "quality.sh exit 1");
});

Deno.test("recoverAndRetryPush - reports commits that survive the retry rather than claiming success (Issue #211)", async () => {
  const result = await recoverAndRetryPush({
    ...BASE,
    git: gitDeps({
      retry: {
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 0,
          finalUnpushedCount: 2,
        },
      },
    }),
  });

  assertEquals(result.unpushed, 2);
  assertEquals(result.failedStep, "retry-push");
  assert(result.detail);
  assertStringIncludes(result.detail, "2 commit(s) still unpushed");
  assertStringIncludes(result.detail, "issue-556-fix");
});
