/**
 * Why a push still failed after the recovery attempt (Issue #211).
 *
 * The processors logged a bare `"Push failed after recovery attempt"` and
 * dropped `recoveryResult.error` on the floor — the one value that names
 * whether the rebase conflicted, auto-resolution failed, or
 * `--force-with-lease` was refused. An operator reading the log saw a failure
 * with no cause, and the same silence rode into the PR comment.
 *
 * Every branch of the recovery produces a sentence here, so the reason is
 * always in the log alongside git's own stderr.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { CommitAndPushPendingResult } from "./git_push.ts";

/** Inputs to {@link pushRecoveryDetail}. */
export interface PushRecoveryOutcome {
  /** What `recoverFromPushRejection` returned. */
  recovery: Result<string>;
  /** What the post-recovery `commitAndPushPending` returned, if it ran. */
  retry?: Result<CommitAndPushPendingResult>;
  /** Commits still unpushed after everything above. */
  unpushed: number;
}

/**
 * Describe, in one line, why commits are still unpushed.
 *
 * @param outcome - The recovery and retry Results plus the remaining count
 * @returns A human-readable reason naming the step that failed
 */
export function pushRecoveryDetail(outcome: PushRecoveryOutcome): string {
  const { recovery, retry, unpushed } = outcome;

  if (!recovery.ok) {
    return `rebase recovery failed: ${recovery.error.message}`;
  }

  if (retry === undefined) {
    return `rebase recovery reported "${recovery.value}" but the retry push ` +
      `was not attempted; ${unpushed} commit(s) remain unpushed`;
  }

  if (!retry.ok) {
    return `rebase recovery reported "${recovery.value}" but the retry ` +
      `commit-and-push failed: ${retry.error.message}`;
  }

  return `rebase recovery reported "${recovery.value}" and the retry push ` +
    `left ${retry.value.finalUnpushedCount} commit(s) unpushed ` +
    `(measured against ${retry.value.unpushedMeasuredAgainst})`;
}
