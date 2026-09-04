/**
 * Shared "the push left commits behind — recover and retry" step (Issue #211).
 *
 * The CI-fix, PR-feedback and spelling processors each carried their own copy
 * of this block, and every copy threw away the reason: `recoverFromPushRejection`
 * returns an error naming the step that failed and git's stderr, and all three
 * logged a bare "Push failed after recovery attempt". The one incident this
 * fixes (NEAT-AI-core #557) left an operator with no way to tell a rebase
 * conflict from a refused lease.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import type {
  CommitAndPushPendingResult,
  PreFlightGateSpec,
} from "./git_push.ts";

/** The two git operations this step drives (injectable for testing). */
export interface PushRecoveryGitDeps {
  recoverFromPushRejection: (
    branchName: string,
    options?: GitCommandOptions,
  ) => Promise<Result<string>>;
  commitAndPushPending: (
    branchName: string,
    commitMessage: string,
    options?: GitCommandOptions,
    allowDefaultBranch?: boolean,
    preFlight?: PreFlightGateSpec,
    runId?: string,
  ) => Promise<Result<CommitAndPushPendingResult>>;
}

/** Inputs for {@link recoverAndRetryPush}. */
export interface PushRecoveryRequest {
  /** The branch whose push left commits behind. */
  branchName: string;
  /** Working directory of the repo clone (undefined = the process cwd). */
  workDir: string | undefined;
  /** Commit message for the retry's automated commit. */
  retryCommitMessage: string;
  /** Commits still unpushed when the step was entered (always > 0). */
  unpushedCount: number;
  /** Repo pre-flight gate, passed straight through to the retry. */
  preFlight?: PreFlightGateSpec;
  git: PushRecoveryGitDeps;
  logger: Logger;
  /** Extra log context (repo, prNumber…) merged into every line. */
  logContext?: Record<string, unknown>;
}

/** Outcome of {@link recoverAndRetryPush}. */
export interface PushRecoveryOutcome {
  /** True only when the branch is now fully on origin. */
  pushed: boolean;
  /** Commits still unpushed (0 when {@link pushed}). */
  unpushedCount: number;
  /**
   * Why the branch is still not pushed — the failing step and git's own
   * words. Empty string when {@link pushed}. Callers put this in the log
   * and in any message they post, so a human never sees a bare
   * "push failed" again.
   */
  failureDetail: string;
}

/**
 * Rebase onto the current remote head and push again (Issue #211).
 *
 * `recoverFromPushRejection` fetches, rebases our commits onto whatever the
 * remote head is now — including a head a sibling fleet host moved while the
 * agent was running — and pushes. When that lands, the retry commit-and-push
 * confirms the branch is clean. Every failure path returns the step that
 * failed plus git's stderr instead of discarding it.
 *
 * @param request - See {@link PushRecoveryRequest}
 * @returns Whether the branch is now pushed, and why not when it is not
 */
export async function recoverAndRetryPush(
  request: PushRecoveryRequest,
): Promise<PushRecoveryOutcome> {
  const {
    branchName,
    workDir,
    retryCommitMessage,
    unpushedCount,
    preFlight,
    git,
    logger,
    logContext = {},
  } = request;

  logger.warn("Local commits remain after push, attempting recovery", {
    ...logContext,
    branchName,
    unpushed: unpushedCount,
  });

  const recovery = await git.recoverFromPushRejection(branchName, {
    cwd: workDir,
  });

  if (!recovery.ok) {
    const failureDetail = recovery.error.message;
    logger.error("Push recovery failed", {
      ...logContext,
      branchName,
      unpushed: unpushedCount,
      reason: failureDetail,
    });
    return { pushed: false, unpushedCount, failureDetail };
  }

  logger.info("Push recovery rebased onto the current remote head", {
    ...logContext,
    branchName,
    outcome: recovery.value,
  });

  const retry = await git.commitAndPushPending(
    branchName,
    retryCommitMessage,
    { cwd: workDir },
    false,
    preFlight,
  );

  if (!retry.ok) {
    const failureDetail =
      `retry commit-and-push after recovery failed: ${retry.error.message}`;
    logger.error("Push retry after recovery failed", {
      ...logContext,
      branchName,
      reason: retry.error.message,
    });
    return { pushed: false, unpushedCount, failureDetail };
  }

  if (retry.value.finalUnpushedCount > 0) {
    const failureDetail =
      `${retry.value.finalUnpushedCount} commit(s) still unpushed after ` +
      `recovery and retry (${recovery.value})`;
    logger.error("Push retry left commits unpushed", {
      ...logContext,
      branchName,
      unpushed: retry.value.finalUnpushedCount,
      reason: failureDetail,
    });
    return {
      pushed: false,
      unpushedCount: retry.value.finalUnpushedCount,
      failureDetail,
    };
  }

  logger.info("Push succeeded after recovery", {
    ...logContext,
    branchName,
  });
  return { pushed: true, unpushedCount: 0, failureDetail: "" };
}
