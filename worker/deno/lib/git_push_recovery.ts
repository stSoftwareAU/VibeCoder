/**
 * Push rejection recovery (Issue #186, #211, #2808).
 *
 * When a push is rejected because the remote contains work not present locally
 * (e.g., automated reformatting from CI, or a sibling fleet host's commit),
 * this module recovers by:
 *   1. Fetching the branch straight into its remote-tracking ref
 *   2. Merging `origin/<branch>` into the local branch
 *   3. Retrying a plain push
 *
 * It never rebases and never forces (Issue #2808): a force push — even a
 * leased one — can rewrite a PR under review. A conflicting merge is aborted
 * and a rejected retry is reported; both fail loud, naming the step.
 *
 * Migrated from worker/shared/git_operations.sh (recover_from_push_rejection).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assertSafeGitRef,
  buildFetchTrackingRefArgs,
  buildPushArgs,
} from "./git_ref_args.ts";
import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { redactedLineTail } from "./redacted_text.ts";
import { redactSecrets } from "./secret_redaction.ts";
import {
  isWorkflowScopePushRefusal,
  workflowScopePushRefusalMessage,
} from "./workflow_scope.ts";

/**
 * Name the recovery step that failed and carry git's own words with it
 * (Issue #211).
 *
 * Callers used to log a bare "Push failed after recovery attempt" — which
 * step gave up and what git said were both discarded. Every failure Result
 * from this module is built here so the step and the git stderr always reach
 * the log.
 */
function recoveryError(step: string, detail: string): Error {
  const trimmed = detail.trim();
  return new Error(
    `Push recovery step '${step}' failed: ${
      trimmed || "git reported no output"
    }`,
  );
}

/**
 * The last few stderr lines of a git result, whichever way it failed.
 *
 * Redacted in full before the cut (Issue #1257): a push failure quotes the
 * remote URL, which carries the run's token when the remote was written with
 * credentials embedded, and this detail reaches the log and the failure
 * comment. Exported so the ordering is tested behaviourally.
 */
export function gitFailureDetail(
  result: Result<{ code: number; stdout: string; stderr: string }>,
): string {
  if (!result.ok) return redactSecrets(result.error.message);
  const text = result.value.stderr.trim() || result.value.stdout.trim();
  return redactedLineTail(text, GIT_DETAIL_TAIL_LINES).split("\n").join(" | ");
}

/** Stderr lines kept in a recovery failure detail. */
const GIT_DETAIL_TAIL_LINES = 5;

/** Paths git lists as unmerged after a conflicting merge, or [] when unreadable. */
async function unmergedPaths(options: GitCommandOptions): Promise<string[]> {
  const result = await runGitCommand(
    ["diff", "--name-only", "--diff-filter=U"],
    options,
  );
  if (!result.ok || result.value.code !== 0) return [];
  return result.value.stdout.split("\n").map((p) => p.trim()).filter(Boolean);
}

/**
 * Merge `origin/<branch>` into the checked-out branch (Issue #2808).
 *
 * A failed merge is aborted when git started one, so the branch is left as it
 * was; the failure names the `merge` step, the conflicted paths and git's
 * stderr. A failed abort fails loud as its own step — a half-merged tree is
 * never reported as a clean refusal.
 */
async function mergeRemoteBranch(
  branchName: string,
  options: GitCommandOptions,
): Promise<Result<void>> {
  const trackingRef = `refs/remotes/origin/${branchName}`;
  const mergeResult = await runGitCommand(
    ["merge", "--no-edit", "--end-of-options", trackingRef],
    options,
  );
  if (mergeResult.ok && mergeResult.value.code === 0) {
    return { ok: true, value: undefined };
  }

  const detail = gitFailureDetail(mergeResult);
  const conflicts = await unmergedPaths(options);
  const merging = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    options,
  );
  if (merging.ok && merging.value.code === 0) {
    const aborted = await runGitCommand(["merge", "--abort"], options);
    if (!aborted.ok || aborted.value.code !== 0) {
      return {
        ok: false,
        error: recoveryError(
          "merge --abort",
          `${gitFailureDetail(aborted)} (merge first failed with: ${
            detail || "no output"
          })`,
        ),
      };
    }
  }

  const conflictNote = conflicts.length > 0
    ? ` (conflicted: ${conflicts.join(", ")})`
    : "";
  return {
    ok: false,
    error: recoveryError(
      "merge",
      `merging 'origin/${branchName}' into '${branchName}' failed${conflictNote}: ${
        detail || "no output"
      }`,
    ),
  };
}

/**
 * Recover from a push rejection by fetching, merging and retrying a plain
 * push (Issue #186, #2808).
 *
 * @param branchName - The branch to recover
 * @param options - Git command options (cwd, etc.)
 * @param pushFailureDetail - Why the push failed, when the caller knows.
 *   A refusal for want of the `workflow` scope stops here (Issue #1952):
 *   no fetch, no merge and no retry can supply a scope the token lacks,
 *   and five attempts against it only delay the one actionable diagnosis.
 * @returns Success only once the retried push is confirmed by git
 */
export async function recoverFromPushRejection(
  branchName: string,
  options: GitCommandOptions = {},
  pushFailureDetail?: string,
): Promise<Result<string>> {
  if (pushFailureDetail && isWorkflowScopePushRefusal(pushFailureDetail)) {
    return {
      ok: false,
      error: new Error(workflowScopePushRefusalMessage(pushFailureDetail)),
    };
  }

  // Refuse an empty, option-injecting or refspec-splitting ref before any git
  // runs (Issue #12). The fetch builder validates it as a ref component.
  let fetchArgs: string[];
  let pushArgs: string[];
  try {
    assertSafeGitRef(branchName, "PR head branch name");
    fetchArgs = buildFetchTrackingRefArgs("origin", branchName);
    pushArgs = buildPushArgs("origin", branchName);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // An explicit refspec creates the tracking ref even in a single-branch clone.
  const fetchResult = await runGitCommand(fetchArgs, options);
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    return {
      ok: false,
      error: recoveryError("fetch", gitFailureDetail(fetchResult)),
    };
  }

  const merged = await mergeRemoteBranch(branchName, options);
  if (!merged.ok) return merged;

  // A plain push through the sanctioned builder (Issue #275) — never forced.
  const retryResult = await runGitCommand(pushArgs, options);
  if (!retryResult.ok || retryResult.value.code !== 0) {
    return {
      ok: false,
      error: recoveryError("retry-push", gitFailureDetail(retryResult)),
    };
  }

  return { ok: true, value: "Push succeeded after merge recovery" };
}
