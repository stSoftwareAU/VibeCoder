/**
 * Reconcile a rejected push instead of handing the branch to a human (Issue #211).
 *
 * Every Claude-driven PR pass ends the same way: commit whatever is pending and
 * push it. When a sibling fleet host pushed to the same branch minutes earlier,
 * that push is rejected. The old behaviour ran `recoverFromPushRejection`,
 * discarded its error, logged a bare "Push failed after recovery attempt", and
 * asked a human to "check the branch status".
 *
 * This module is the single reconciliation path all those passes share:
 *
 *   1. `recoverFromPushRejection` — pull/rebase and retry.
 *   2. `reapplyOntoRemoteHead` — rebase our commits onto the head the sibling
 *      pushed and push them (Issue #211's core fix).
 *   3. Confirm with an idempotent `commitAndPushPending` so the final unpushed
 *      count comes from git, not from what a step claimed.
 *
 * Every step's failure — including git's own stderr — is accumulated into
 * `detail` and logged. A caller only tells a human to look at the branch when
 * both recovery and re-apply genuinely failed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import type {
  CommitAndPushPendingResult,
  PreFlightGateSpec,
} from "./git_push.ts";
import type { ReapplyOutcome } from "./git_reapply.ts";

/** The git operations the reconciler needs — injectable for tests. */
export interface PushReconcilerGit {
  recoverFromPushRejection: (
    branchName: string,
    options: GitCommandOptions,
  ) => Promise<Result<string>>;
  reapplyOntoRemoteHead: (
    branchName: string,
    options: GitCommandOptions,
  ) => Promise<Result<ReapplyOutcome>>;
  commitAndPushPending: (
    branchName: string,
    commitMessage: string,
    options: GitCommandOptions,
    allowDefaultBranch?: boolean,
    preFlight?: PreFlightGateSpec,
  ) => Promise<Result<CommitAndPushPendingResult>>;
}

/** Input for {@link reconcileRejectedPush}. */
export interface ReconcileRejectedPushInput {
  /** PR head branch whose commits could not be pushed. */
  branchName: string;
  /** Commit message for any retry commit. */
  commitMessage: string;
  /** Git command options (cwd, env, timeout). */
  options: GitCommandOptions;
  /** Repo pre-flight gate, applied to every retry commit. */
  preFlight?: PreFlightGateSpec;
  /** Unpushed commit count observed by the caller. */
  unpushedCount: number;
  git: PushReconcilerGit;
  logger: Logger;
  /** Log context — the repo and PR being reconciled. */
  repo: string;
  prNumber: number;
}

/** Outcome of a reconciliation attempt. */
export interface ReconcileRejectedPushResult {
  /** Whether the branch ended in sync with origin. */
  pushed: boolean;
  /** Commits still unpushed after reconciliation (0 when `pushed`). */
  finalUnpushedCount: number;
  /** Ordered trail of the steps attempted, with each failure's git stderr. */
  detail: string;
}

/**
 * Reconcile unpushed commits after a rejected push (Issue #211).
 *
 * @param input - Branch, retry commit details and injected git operations
 * @returns Whether the branch is in sync, plus the step-by-step detail
 */
export async function reconcileRejectedPush(
  input: ReconcileRejectedPushInput,
): Promise<ReconcileRejectedPushResult> {
  const {
    branchName,
    commitMessage,
    options,
    preFlight,
    unpushedCount,
    git,
    logger,
    repo,
    prNumber,
  } = input;

  const steps: string[] = [];
  let finalUnpushedCount = unpushedCount;

  const finish = (pushed: boolean): ReconcileRejectedPushResult => {
    const detail = steps.join("; ");
    if (pushed) {
      logger.info("Rejected push reconciled", {
        repo,
        prNumber,
        branchName,
        detail,
      });
    } else {
      // Fail loud: the operator must see which step failed and git's own words.
      logger.error("Push failed after recovery and re-apply", {
        repo,
        prNumber,
        branchName,
        unpushed: finalUnpushedCount,
        detail,
      });
    }
    return { pushed, finalUnpushedCount, detail };
  };

  // Step 1 — standard push-rejection recovery.
  const recovery = await git.recoverFromPushRejection(branchName, options);
  if (recovery.ok) {
    steps.push(`recovery: ${recovery.value}`);
    const retry = await git.commitAndPushPending(
      branchName,
      commitMessage,
      options,
      false,
      preFlight,
    );
    if (retry.ok) {
      finalUnpushedCount = retry.value.finalUnpushedCount;
      if (finalUnpushedCount === 0) {
        return finish(true);
      }
      steps.push(
        `retry push left ${finalUnpushedCount} commit(s) unpushed`,
      );
    } else {
      steps.push(`retry commit/push failed: ${retry.error.message}`);
    }
  } else {
    steps.push(`recovery failed: ${recovery.error.message}`);
  }

  // Step 2 — the head moved under us: re-apply our commits onto it.
  const reapply = await git.reapplyOntoRemoteHead(branchName, options);
  if (!reapply.ok) {
    steps.push(`re-apply failed: ${reapply.error.message}`);
    return finish(false);
  }
  steps.push(`re-apply: ${reapply.value.detail}`);

  // Step 3 — confirm against git rather than trusting the step's own claim.
  const confirm = await git.commitAndPushPending(
    branchName,
    commitMessage,
    options,
    false,
    preFlight,
  );
  if (!confirm.ok) {
    steps.push(`post-re-apply commit/push failed: ${confirm.error.message}`);
    return finish(false);
  }
  finalUnpushedCount = confirm.value.finalUnpushedCount;
  if (finalUnpushedCount > 0) {
    steps.push(
      `${finalUnpushedCount} commit(s) still unpushed after re-apply`,
    );
    return finish(false);
  }

  return finish(true);
}
