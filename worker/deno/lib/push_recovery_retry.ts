/**
 * Shared "recover, then retry the push" step for the PR processors
 * (Issue #211).
 *
 * The CI-fix, PR-feedback and spelling processors each ran the same block
 * after a final-mile push left commits behind: call
 * `recoverFromPushRejection`, retry `commitAndPushPending`, and — when the
 * branch was still not pushed — log a bare `"Push failed after recovery
 * attempt"`. The one thing that line never carried was *why*:
 * `recoveryResult.error` names whether the rebase conflicted, automatic
 * conflict resolution failed, or `--force-with-lease` was refused, and it was
 * discarded at all three call sites. An operator reading the log (NEAT-AI-core
 * #557) saw a failure with no cause and a human got "please check the branch
 * status" with nothing to check.
 *
 * This helper performs the two steps and returns the failing step together
 * with git's own message, so each caller logs a cause instead of a symptom.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { PreFlightGateSpec } from "./git_push.ts";
import type { GitDeps } from "./issue_worker_wiring.ts";

/** Git operations this helper needs — a subset of {@link GitDeps}. */
export type PushRecoveryGitDeps = Pick<
  GitDeps,
  "recoverFromPushRejection" | "commitAndPushPending"
>;

/** Inputs for {@link recoverAndRetryPush}. */
export interface PushRecoveryRetryParams {
  /** The branch whose push was left incomplete. */
  branchName: string;
  /** Working directory for git commands (the target repo checkout). */
  cwd: string | undefined;
  /** Commit message for the retry's automated commit. */
  commitMessage: string;
  /** Commits still unpushed when the recovery was triggered. */
  unpushedBefore: number;
  /** The repo's pre-flight gate, re-applied to the retry commit. */
  preFlight?: PreFlightGateSpec;
  /** Injected git operations. */
  git: PushRecoveryGitDeps;
}

/** Which step of the recovery failed (Issue #211). */
export type PushRecoveryStep = "rebase-recovery" | "retry-push";

/** Outcome of {@link recoverAndRetryPush}. */
export interface PushRecoveryRetryResult {
  /** Commits still unpushed after the attempt — 0 means the branch is clean. */
  unpushed: number;
  /** The step that failed; absent when the branch was pushed. */
  failedStep?: PushRecoveryStep;
  /** git's own reason for the failure; absent when the branch was pushed. */
  detail?: string;
}

/**
 * Rebase onto the remote head and retry the push, reporting the failing step.
 *
 * Never swallows a failure: when the branch is still not pushed the result
 * always carries both `failedStep` and a `detail` naming git's reason.
 */
export async function recoverAndRetryPush(
  params: PushRecoveryRetryParams,
): Promise<PushRecoveryRetryResult> {
  const { branchName, cwd, commitMessage, unpushedBefore, preFlight, git } =
    params;

  const recovery = await git.recoverFromPushRejection(branchName, { cwd });
  if (!recovery.ok) {
    return {
      unpushed: unpushedBefore,
      failedStep: "rebase-recovery",
      detail: recovery.error.message,
    };
  }

  const retry = await git.commitAndPushPending(
    branchName,
    commitMessage,
    { cwd },
    false,
    preFlight,
  );
  if (!retry.ok) {
    return {
      unpushed: unpushedBefore,
      failedStep: "retry-push",
      detail: retry.error.message,
    };
  }

  const remaining = retry.value.finalUnpushedCount;
  if (remaining === 0) return { unpushed: 0 };

  return {
    unpushed: remaining,
    failedStep: "retry-push",
    detail:
      `${remaining} commit(s) still unpushed after '${recovery.value}' — the ` +
      `retry push did not reach origin/${branchName}`,
  };
}
