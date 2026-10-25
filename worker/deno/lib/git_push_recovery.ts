/**
 * Push rejection recovery (Issue #186, #211, #2808).
 *
 * When a push is rejected because the remote contains work not present locally
 * (e.g., automated reformatting from CI, or a sibling fleet host's commit),
 * this module recovers by:
 *   1. Fetching the branch straight into its remote-tracking ref
 *   2. Merging `origin/<branch>` into the local branch
 *   3. Retrying a plain push
 *   4. Confirming it landed: re-fetching and checking HEAD is on the remote
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

/**
 * Options for a push or a push-recovery merge (Issue #4165).
 *
 * `expectedAncestor` is the head the pass started from. When it is set, a
 * checkout that does not extend it is not this pass's work and must not be
 * pushed or merged onto.
 */
export interface PushLineageOptions extends GitCommandOptions {
  expectedAncestor?: string;
}

/** Whether HEAD still extends the commit a pass started from. */
export type HeadExtension =
  | { status: "extends" }
  | { status: "unrelated"; message: string }
  | { status: "unknown"; message: string };

function nothingPushed(beforeSha: string, head: string): string {
  return `the checkout moved off the PR head during the run; nothing pushed (started at ${beforeSha}, HEAD is ${head})`;
}

/**
 * Decide whether `beforeSha` is an ancestor of HEAD (Issue #4165).
 *
 * Exit 1 from `git merge-base --is-ancestor` is a definite unrelated history.
 * Any other failure is unknown: the push path refuses it, and the
 * "HEAD moved" log keeps its previous reading, because a missing repository
 * is not proof the branch was reset.
 */
export async function classifyHeadExtension(
  beforeSha: string,
  options: GitCommandOptions = {},
): Promise<HeadExtension> {
  try {
    assertSafeGitRef(beforeSha, "starting head");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "unknown", message: nothingPushed(beforeSha, detail) };
  }

  const head = await runGitCommand(
    ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
    options,
  );
  const headSha = head.ok && head.value.code === 0
    ? head.value.stdout.trim()
    : "";
  if (!headSha) {
    const detail = head.ok
      ? head.value.stderr.trim() || `git exited ${head.value.code}`
      : head.error.message;
    return {
      status: "unknown",
      message: nothingPushed(beforeSha, `unreadable (${detail})`),
    };
  }

  const ancestor = await runGitCommand(
    ["merge-base", "--is-ancestor", "--end-of-options", beforeSha, "HEAD"],
    options,
  );
  if (ancestor.ok && ancestor.value.code === 0) {
    return { status: "extends" };
  }
  if (ancestor.ok && ancestor.value.code === 1) {
    return { status: "unrelated", message: nothingPushed(beforeSha, headSha) };
  }
  const detail = ancestor.ok
    ? ancestor.value.stderr.trim() || `git exited ${ancestor.value.code}`
    : ancestor.error.message;
  return {
    status: "unknown",
    message: nothingPushed(
      beforeSha,
      `${headSha} (check failed: ${detail})`,
    ),
  };
}

/** Ok when no ancestor was required or HEAD extends it; otherwise a loud refusal. */
export async function refuseUnlessHeadExtends(
  options: PushLineageOptions,
): Promise<Result<void>> {
  if (!options.expectedAncestor) return { ok: true, value: undefined };
  const lineage = await classifyHeadExtension(
    options.expectedAncestor,
    options,
  );
  if (lineage.status === "extends") return { ok: true, value: undefined };
  return { ok: false, error: new Error(lineage.message) };
}
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
  options: PushLineageOptions,
): Promise<Result<void>> {
  // Issue #4165: never merge a rejected push of unrelated history into the
  // remote head. A merge would publish the other branch as this PR's work.
  const lineage = await refuseUnlessHeadExtends(options);
  if (!lineage.ok) return lineage;

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
  options: PushLineageOptions = {},
  pushFailureDetail?: string,
  beforePush?: () => Promise<Result<void>>,
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

  // Issue #4165: refuse before fetching or merging when this checkout is not
  // the pass's own history. Merging origin into an unrelated HEAD is what
  // published another branch onto the PR.
  const lineage = await refuseUnlessHeadExtends(options);
  if (!lineage.ok) return lineage;

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

  if (beforePush) {
    const verified = await beforePush();
    if (!verified.ok) return verified;
  }

  // A plain push through the sanctioned builder (Issue #275) — never forced.
  const retryResult = await runGitCommand(pushArgs, options);
  if (!retryResult.ok || retryResult.value.code !== 0) {
    return {
      ok: false,
      error: recoveryError("retry-push", gitFailureDetail(retryResult)),
    };
  }

  // Confirm the push landed by re-reading the remote head. This also moves the
  // tracking ref the first fetch created — a single-branch clone's push never
  // updates it — so the unpushed count is not measured against a stale ref.
  const confirmFetch = await runGitCommand(fetchArgs, options);
  if (!confirmFetch.ok || confirmFetch.value.code !== 0) {
    return {
      ok: false,
      error: recoveryError("confirm-push", gitFailureDetail(confirmFetch)),
    };
  }
  const landed = await runGitCommand(
    [
      "merge-base",
      "--is-ancestor",
      "HEAD",
      `refs/remotes/origin/${branchName}`,
    ],
    options,
  );
  if (!landed.ok || landed.value.code !== 0) {
    return {
      ok: false,
      error: recoveryError(
        "confirm-push",
        `HEAD is not on origin/${branchName} after the push: ${
          gitFailureDetail(landed) || "not an ancestor"
        }`,
      ),
    };
  }

  return { ok: true, value: "Push succeeded after merge recovery" };
}
