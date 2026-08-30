/**
 * Git pull operations with conflict detection (Issue #912).
 *
 * Provides functions for syncing feature branches with default branches,
 * syncing milestone branches, and pulling with conflict handling.
 *
 * Migrated from worker/shared/git_operations.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand, runGitCommandChecked } from "./git_timeout.ts";
import { spawnGh } from "./gh_spawn.ts";
import {
  isRuleViolationPush,
  raiseMilestoneSyncPr,
} from "./milestone_sync_pr.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { buildBranchDeleteArgs } from "./git_branch_args.ts";
import {
  buildAddPathArgs,
  buildCheckoutStrategyArgs,
} from "./git_conflict_args.ts";
import { ensureDefaultBranchCurrent } from "./git_push.ts";
import {
  assertSafeGitRef,
  buildCheckoutArgs,
  buildCheckoutNewBranchArgs,
  buildFetchArgs,
  buildPushArgs,
  buildRebaseArgs,
} from "./git_ref_args.ts";
import { checkoutPrBranchAtRemoteHead } from "./pr_branch_checkout.ts";
import { requireDiskSpaceForGitOperation } from "./disk_space.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import { ensureHistoryDepth } from "./git_history.ts";

/**
 * Describe a failed `git checkout` with git's own stderr (Issue #49, #335).
 *
 * A checkout failure that only says which branch failed cannot be acted on:
 * Issue #335 saw the same branch log 65 identical warnings across days with
 * no diagnosis in any of them. The stderr *is* the diagnosis — a missing ref,
 * a dirty tree, a lock file — so it travels with the error.
 *
 * @param branchName - The branch that could not be checked out
 * @param result - The `runGitCommand` result for the failed checkout
 * @returns An error naming the branch and git's own failure
 */
function checkoutFailureError(
  branchName: string,
  result: Result<{ code: number; stderr: string }>,
): Error {
  const detail = (result.ok ? result.value.stderr : result.error.message)
    .trim().split("\n").slice(0, 6).join(" | ") ||
    (result.ok ? `exit ${result.value.code}` : "git reported no stderr");
  return new Error(`Failed to checkout branch '${branchName}': ${detail}`);
}

/**
 * Sync a feature branch with the latest default branch (Issue #230).
 *
 * If the rebase encounters conflicts:
 *   1. Check if the remote has commits for this branch (Issue #586)
 *   2. If yes, reset to the remote version to preserve prior work, then
 *      attempt a merge from the default branch
 *   3. If no remote branch exists, recreate from the default branch
 *
 * @param branchName - The feature branch to sync
 * @param defaultBranch - The default branch to sync with
 * @param options - Git command options
 * @returns Result indicating success or failure
 */
export async function syncFeatureBranchWithDefault(
  branchName: string,
  defaultBranch: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  // Refuse an option-injecting ref before any git runs (Issue #12).
  try {
    assertSafeGitRef(branchName, "feature branch name");
    assertSafeGitRef(defaultBranch, "default branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  // Pre-check disk space before fetch/rebase (Issue #1174)
  if (options.cwd) {
    const spaceCheck = await requireDiskSpaceForGitOperation(
      options.cwd,
      `git fetch origin ${branchName}`,
      OPERATIONAL_DEFAULTS.minDiskSpaceMb,
    );
    if (!spaceCheck.ok) {
      return { ok: false, error: spaceCheck.error };
    }
  }

  // First, ensure the local default branch is current
  await ensureDefaultBranchCurrent(defaultBranch, options);

  // Check if we're already on the feature branch
  const currentBranchResult = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    options,
  );
  const currentBranch = currentBranchResult.ok
    ? currentBranchResult.value.stdout.trim()
    : "";

  if (currentBranch !== branchName) {
    const checkoutResult = await runGitCommand(
      buildCheckoutArgs(branchName),
      options,
    );
    if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
      // Surface git's own stderr (Issue #49): a dirty tree or a missing ref is
      // the whole diagnosis, and the old error discarded it.
      return {
        ok: false,
        error: checkoutFailureError(branchName, checkoutResult),
      };
    }
  }

  // Ensure enough history is present for range/rebase ops on a shallow clone (Issue #1502)
  await ensureHistoryDepth(["HEAD", defaultBranch], options);

  // Check if rebase is needed
  const behindResult = await runGitCommand(
    ["rev-list", "--count", `HEAD..${defaultBranch}`],
    options,
  );
  const behindCount = behindResult.ok && behindResult.value.code === 0
    ? parseInt(behindResult.value.stdout.trim(), 10) || 0
    : 0;

  if (behindCount === 0) {
    return {
      ok: true,
      value:
        `Feature branch '${branchName}' is already up to date with '${defaultBranch}'`,
    };
  }

  // Attempt rebase
  const rebaseResult = await runGitCommand(
    ["rebase", defaultBranch],
    options,
  );

  if (rebaseResult.ok && rebaseResult.value.code === 0) {
    return {
      ok: true,
      value:
        `Successfully synced '${branchName}' with '${defaultBranch}' (${behindCount} commit(s) integrated)`,
    };
  }

  // Rebase failed — likely merge conflicts
  await runGitCommand(["rebase", "--abort"], options);

  // Issue #586: Check if the remote has this branch with commits to preserve
  await runGitCommand(buildFetchArgs("origin", branchName), options);
  const showRefResult = await runGitCommand(
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    options,
  );

  if (showRefResult.ok && showRefResult.value.code === 0) {
    // Ensure enough history for the defaultBranch..origin/branch range (Issue #1502)
    await ensureHistoryDepth([defaultBranch, `origin/${branchName}`], options);

    const remoteCountResult = await runGitCommand(
      ["rev-list", "--count", `${defaultBranch}..origin/${branchName}`],
      options,
    );
    const remoteCommitCount =
      remoteCountResult.ok && remoteCountResult.value.code === 0
        ? parseInt(remoteCountResult.value.stdout.trim(), 10) || 0
        : 0;

    if (remoteCommitCount > 0) {
      // Preserve remote commits (Issue #586)
      await runGitCommand(["checkout", defaultBranch], options);
      await runGitCommand(buildBranchDeleteArgs(branchName, true), options);

      const restoreResult = await runGitCommand(
        buildCheckoutNewBranchArgs(branchName, `origin/${branchName}`),
        options,
      );

      if (!restoreResult.ok || restoreResult.value.code !== 0) {
        // Fall through to recreate
        await runGitCommand(
          buildCheckoutNewBranchArgs(branchName, defaultBranch),
          options,
        );
        return {
          ok: true,
          value:
            `SELF-HEALING: Branch '${branchName}' recreated from '${defaultBranch}' — prior feature commits were discarded`,
        };
      }

      // Ensure history depth for the merge (Issue #1502)
      await ensureHistoryDepth(["HEAD", defaultBranch], options);

      // Try to merge default branch into the preserved remote version
      const mergeResult = await runGitCommand(
        ["merge", defaultBranch, "--no-edit"],
        options,
      );

      if (mergeResult.ok && mergeResult.value.code === 0) {
        return {
          ok: true,
          value:
            `SELF-HEALING: Merged '${defaultBranch}' into preserved '${branchName}' — remote commits retained`,
        };
      }

      // Merge also conflicts — keep the remote version without the merge
      await runGitCommand(["merge", "--abort"], options);
      return {
        ok: true,
        value:
          `SELF-HEALING: Merge conflict with preserved '${branchName}' — keeping remote version without merge`,
      };
    }
  }

  // No remote branch or no remote commits — recreate from the default branch
  await runGitCommand(["checkout", defaultBranch], options);
  await runGitCommand(buildBranchDeleteArgs(branchName, true), options);
  await runGitCommand(buildCheckoutNewBranchArgs(branchName), options);

  return {
    ok: true,
    value:
      `SELF-HEALING: Branch '${branchName}' recreated from '${defaultBranch}' — prior feature commits were discarded`,
  };
}

/**
 * Push the synced milestone branch, falling back to a pull request when a
 * repository rule refuses the push (Issue #589).
 *
 * The gate that refuses the push is the same one that makes a PR into that
 * branch auto-mergeable (Issue #586), so the fallback lands the identical
 * merge unattended rather than failing the sync. A repository whose milestone
 * branches are ungated never reaches the fallback.
 *
 * @returns A note to append to the sync's outcome, empty on the ordinary path.
 */
async function pushSyncedMilestoneBranch(
  milestoneBranch: string,
  defaultBranch: string,
  options: GitCommandOptions,
  repo?: string,
): Promise<string> {
  const push = await runGitCommand(
    ["push", "origin", milestoneBranch],
    options,
  );
  if (push.ok && push.value.code === 0) return "";

  const stderr = push.ok ? push.value.stderr : push.error.message;
  if (!isRuleViolationPush(stderr)) return "";

  if (!repo) {
    return `PUSH REFUSED by a repository rule and no repository was named, ` +
      `so no sync PR could be raised (Issue #589) — `;
  }

  const raised = await raiseMilestoneSyncPr(
    repo,
    milestoneBranch,
    defaultBranch,
    {
      git: async (args) => {
        const result = await runGitCommand(args, options);
        return result.ok
          ? { code: result.value.code, stderr: result.value.stderr }
          : { code: 1, stderr: result.error.message };
      },
      gh: async (args) => {
        const result = await spawnGh(args);
        if (!result.success) {
          throw new Error(result.stderr.trim() || `gh exited ${result.code}`);
        }
        return result.stdout;
      },
    },
  );
  if (!raised.ok) {
    return `PUSH REFUSED by a repository rule and the sync PR could not be ` +
      `raised: ${raised.error.message} (Issue #589) — `;
  }
  return raised.value.opened
    ? `RAISED a sync PR from '${raised.value.branch}' — the branch is gated, ` +
      `so the push became a pull request (Issue #589) — `
    : `UPDATED the open sync PR from '${raised.value.branch}' (Issue #589) — `;
}

/**
 * Sync a milestone branch with the default branch (Issue #422, #605).
 *
 * Uses merge (not rebase) to preserve milestone commit history.
 *
 * @param milestoneBranch - The milestone branch name
 * @param defaultBranch - The default branch to sync from
 * @param options - Git command options
 * @returns Result indicating success or failure
 */
export async function syncMilestoneBranchWithDefault(
  milestoneBranch: string,
  defaultBranch: string,
  options: GitCommandOptions = {},
  /**
   * `owner/repo`, needed only to raise a sync PR when a repository rule
   * refuses the push (Issue #589). Absent keeps the previous behaviour and
   * says so in the outcome rather than failing silently.
   */
  repo?: string,
): Promise<Result<string>> {
  // Pre-check disk space before pull/merge (Issue #1174)
  if (options.cwd) {
    const spaceCheck = await requireDiskSpaceForGitOperation(
      options.cwd,
      `git pull origin ${milestoneBranch}`,
      OPERATIONAL_DEFAULTS.minDiskSpaceMb,
    );
    if (!spaceCheck.ok) {
      return { ok: false, error: spaceCheck.error };
    }
  }

  // Ensure the local default branch is current
  await ensureDefaultBranchCurrent(defaultBranch, options);

  // What the sync discarded on its way in, reported with its outcome
  // (Issue #568). Empty on the ordinary path.
  let dirtyNote = "";

  // Check out the milestone branch
  const currentBranchResult = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    options,
  );
  const currentBranch = currentBranchResult.ok
    ? currentBranchResult.value.stdout.trim()
    : "";

  if (currentBranch !== milestoneBranch) {
    // Issue #1517: shallow clones (`--depth=1 --no-single-branch`) only carry
    // remote-tracking refs for branches present at clone time. Fetch the
    // milestone branch first so DWIM checkout can create a local tracking
    // branch from `origin/<milestoneBranch>` when the branch was created
    // remotely after the clone.
    await runGitCommand(["fetch", "origin", milestoneBranch], options);

    // Issue #568: the shared `${WORK_DIR}/<repo>` clone is scratch, not a
    // workspace anyone's work survives in — a timed-out claim or an
    // abandoned pass routinely leaves it dirty, and `git checkout` then
    // refuses ("Your local changes to the following files would be
    // overwritten"). The sync recorded `sync_failed` and moved on, so the
    // milestone branch drifted behind the default line until a human noticed
    // — which is exactly the drift that produces the conflicting child PRs
    // the merge-conflict lane then spends agent time on.
    //
    // Discarding here is safe BECAUSE the clone is shared scratch: every
    // caller re-derives what it needs, and the repository lease (Issue #213)
    // is what stops an issue slot's real work being in this tree at the same
    // time. What is discarded is named, so a surprise is diagnosable rather
    // than silent.
    const dirty = await runGitCommand(["status", "--porcelain"], options);
    if (dirty.ok && dirty.value.code === 0 && dirty.value.stdout.trim()) {
      const files = dirty.value.stdout.trim().split("\n");
      await runGitCommand(["reset", "--hard"], options);
      await runGitCommand(["clean", "-fd"], options);
      dirtyNote = `SELF-HEALING: discarded ${files.length} uncommitted ` +
        `change(s) in the shared clone before checkout (${
          // Porcelain v1 is a two-character status field, then the path.
          files.slice(0, 3).map((line) => line.slice(2).trim()).join(", ")}${
          files.length > 3 ? `, +${files.length - 3} more` : ""
        }) — `;
    }

    const checkoutResult = await runGitCommand(
      ["checkout", milestoneBranch],
      options,
    );
    if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
      // Surface git's own stderr (Issue #49): "error: Your local changes to the
      // following files would be overwritten by checkout: …" — usually a dirty
      // tree a timed-out claim left on this shared clone — is the whole
      // diagnosis, and the old error discarded it. Same shape as the #4260
      // merge-failure surfacing below.
      const stderrTail = (checkoutResult.ok
        ? checkoutResult.value.stderr
        : checkoutResult.error.message)
        .trim().split("\n").slice(0, 6).join(" | ");
      return {
        ok: false,
        error: new Error(
          `Failed to checkout milestone branch '${milestoneBranch}': ${
            stderrTail || "git reported no stderr"
          }`,
        ),
      };
    }
  }

  // Take the remote milestone branch without ever manufacturing a local merge
  // commit (Issue #4002). A plain `git pull` merges whenever local and remote
  // have diverged; a repository rule forbidding merge commits then rejects the
  // push, and the branch stays unpushable until a human intervenes. The remote
  // is authoritative for a milestone branch, so fast-forward where possible and
  // reset to the remote ref otherwise.
  let selfHealNote = dirtyNote;
  await runGitCommand(["fetch", "origin", milestoneBranch], options);
  const remoteRefResult = await runGitCommand(
    [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${milestoneBranch}`,
    ],
    options,
  );

  if (remoteRefResult.ok && remoteRefResult.value.code === 0) {
    const fastForwardResult = await runGitCommand(
      ["merge", "--ff-only", `origin/${milestoneBranch}`],
      options,
    );

    if (!fastForwardResult.ok || fastForwardResult.value.code !== 0) {
      const resetResult = await runGitCommandChecked(
        ["reset", "--hard", `origin/${milestoneBranch}`],
        options,
      );
      if (!resetResult.ok) {
        return {
          ok: false,
          error: new Error(
            `Failed to reset diverged milestone branch '${milestoneBranch}' to 'origin/${milestoneBranch}': ${resetResult.error.message}`,
          ),
        };
      }
      selfHealNote =
        `SELF-HEALING: reset '${milestoneBranch}' to 'origin/${milestoneBranch}' ` +
        `(diverged local commits discarded) — `;
    }
  }

  // Ensure enough history for range/merge ops on a shallow clone (Issue #1502)
  await ensureHistoryDepth(["HEAD", defaultBranch], options);

  // Check if merge is needed
  const behindResult = await runGitCommand(
    ["rev-list", "--count", `HEAD..${defaultBranch}`],
    options,
  );
  const behindCount = behindResult.ok && behindResult.value.code === 0
    ? parseInt(behindResult.value.stdout.trim(), 10) || 0
    : 0;

  if (behindCount === 0) {
    return {
      ok: true,
      value:
        `${selfHealNote}Milestone branch '${milestoneBranch}' is already up to date with '${defaultBranch}'`,
    };
  }

  // Merge default into milestone (preserve commit history)
  const mergeResult = await runGitCommand(
    ["merge", defaultBranch, "--no-edit"],
    options,
  );

  if (mergeResult.ok && mergeResult.value.code === 0) {
    // Push the synced milestone branch (Issue #605), or raise a PR for it
    // where a repository rule refuses the push (Issue #589).
    const cleanPushNote = await pushSyncedMilestoneBranch(
      milestoneBranch,
      defaultBranch,
      options,
      repo,
    );
    return {
      ok: true,
      value:
        `${selfHealNote}${cleanPushNote}Successfully merged '${defaultBranch}' into '${milestoneBranch}' (${behindCount} commit(s) integrated)`,
    };
  }

  // Merge conflict — abort and retry with auto-resolution (Issue #605)
  await runGitCommand(["merge", "--abort"], options);

  // Retry merge favouring default branch changes for conflicted files
  const retryResult = await runGitCommand(
    ["merge", defaultBranch, "--no-edit", "-X", "theirs"],
    options,
  );

  if (retryResult.ok && retryResult.value.code === 0) {
    const pushNote = await pushSyncedMilestoneBranch(
      milestoneBranch,
      defaultBranch,
      options,
      repo,
    );
    return {
      ok: true,
      value:
        `${selfHealNote}${pushNote}Issue #605: Auto-resolved merge conflicts (favouring '${defaultBranch}' changes)`,
    };
  }

  // -X theirs failed — resolve manually
  await runGitCommand(["merge", "--abort"], options);

  // Final attempt: merge and force-accept default branch version for all conflicts
  const finalMergeResult = await runGitCommand(
    ["merge", defaultBranch, "--no-edit"],
    options,
  );

  if (!finalMergeResult.ok || finalMergeResult.value.code !== 0) {
    // Get conflicted files and resolve each
    const conflictedResult = await runGitCommand(
      ["diff", "--name-only", "--diff-filter=U"],
      options,
    );

    const conflictedFiles = conflictedResult.ok
      ? conflictedResult.value.stdout.trim().split("\n").filter(Boolean)
      : [];

    if (conflictedFiles.length === 0) {
      await runGitCommand(["merge", "--abort"], options);
      // Honest failure (Issue #4260): `-X theirs` already resolves any
      // content conflict, so a merge that fails with ZERO conflicted files
      // failed for a non-conflict reason (unrelated histories, shallow
      // history, dirty tree, vanished remote…). This used to return
      // ok:true and be logged as "Synced …" — FLEET milestone/4064 sat 5
      // commits behind Develop for days while every cycle said 0 failed.
      // Surface git's own stderr so the real reason is in the log.
      const stderrTail = (finalMergeResult.ok
        ? finalMergeResult.value.stderr
        : finalMergeResult.error.message)
        .trim().split("\n").slice(-3).join(" | ");
      return {
        ok: false,
        error: new Error(
          `Merge of '${defaultBranch}' into '${milestoneBranch}' failed ` +
            `with no conflicted files — a non-conflict failure ` +
            `(Issue #4260): ${stderrTail || "git reported no stderr"}`,
        ),
      };
    }

    for (const file of conflictedFiles) {
      await runGitCommand(buildCheckoutStrategyArgs("theirs", file), options);
      await runGitCommand(buildAddPathArgs(file), options);
    }

    const commitResult = await runGitCommand(["commit", "--no-edit"], options);
    if (!commitResult.ok || commitResult.value.code !== 0) {
      await runGitCommand(["merge", "--abort"], options);
      // Honest failure (Issue #4260) — same reasoning as above.
      const stderrTail = (commitResult.ok
        ? commitResult.value.stderr
        : commitResult.error.message)
        .trim().split("\n").slice(-3).join(" | ");
      return {
        ok: false,
        error: new Error(
          `Failed to commit conflict resolution for '${milestoneBranch}' ` +
            `(Issue #4260): ${stderrTail || "git reported no stderr"}`,
        ),
      };
    }
  }

  const resolvedPushNote = await pushSyncedMilestoneBranch(
    milestoneBranch,
    defaultBranch,
    options,
    repo,
  );
  return {
    ok: true,
    value:
      `${selfHealNote}${resolvedPushNote}Issue #605: Resolved merge conflicts for '${milestoneBranch}' (accepted '${defaultBranch}' changes)`,
  };
}

/** Error name for a PR branch left untouched because its changes conflict (Issue #4373). */
export const PR_BRANCH_CONFLICT_ERROR = "PrBranchConflict";

/**
 * A PR branch whose changes collide with its base (Issue #4373). The worker
 * never resolves such a conflict by picking a side — that either discards
 * the PR's work (upstream wins) or reverts base-branch work (PR wins),
 * silently, under a commit that still carries the PR's message; observed
 * live when #4372 lost its whole claude_runner.ts change to a maintenance
 * rebase. The branch is left exactly as it was for a real merge (the
 * PR-feedback agent or a human).
 */
export function prBranchConflictError(
  branchName: string,
  baseBranch: string,
  how: string,
): Error {
  const err = new Error(
    `PR branch '${branchName}' conflicts with '${baseBranch}' (${how}) — left untouched: the worker does not resolve conflicts by picking a side (Issue #4373); resolve with a real merge`,
  );
  err.name = PR_BRANCH_CONFLICT_ERROR;
  return err;
}

/** Whether an error is the left-untouched conflict outcome (Issue #4373). */
export function isPrBranchConflictError(err: unknown): boolean {
  return err instanceof Error && err.name === PR_BRANCH_CONFLICT_ERROR;
}

/**
 * The ref a PR should be judged and rebased against (Issue #394).
 *
 * `refs/remotes/origin/<base>` when the clone has it — the base as published,
 * which is what GitHub compared the PR with — falling back to the local
 * branch name when there is no tracking ref (a base that exists only locally,
 * as in several unit fixtures).
 *
 * The local base ref cannot be relied on here: it is shared with every other
 * lane on the host, and git refuses to move a branch another worktree has
 * checked out, so `ensureDefaultBranchCurrent` can legitimately leave it
 * behind the remote.
 *
 * @param baseBranch - The PR's base branch name
 * @param options - Git command options (cwd selects the clone or worktree)
 * @returns The ref to use for comparison, rebase and merge
 */
async function resolvePublishedBaseRef(
  baseBranch: string,
  options: GitCommandOptions,
): Promise<string> {
  const trackingRef = `refs/remotes/origin/${baseBranch}`;
  const resolved = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", trackingRef],
    options,
  );
  return resolved.ok && resolved.value.code === 0 ? trackingRef : baseBranch;
}

/**
 * Update a PR branch to be current with its base branch (Issue #379, #498).
 *
 * Rebases the feature branch onto the base branch and force-pushes.
 *
 * Issue #1313: When reason is "conflicting", always uses merge-based
 * resolution regardless of behindCount. GitHub's merge analysis may detect
 * conflicts whether the branch is behind or has diverged (behind_by > 0 or
 * == 0). The merge-based path uses -X theirs to accept base branch changes
 * for conflicted files, ensuring the PR can be resolved automatically.
 *
 * @param branchName - The feature branch to update
 * @param baseBranch - The base branch to sync with
 * @param options - Git command options
 * @param reason - Why the branch needs updating ("behind" or "conflicting")
 * @returns Result indicating success or failure
 */
export async function updatePrBranch(
  branchName: string,
  baseBranch: string,
  options: GitCommandOptions = {},
  reason?: "behind" | "conflicting",
): Promise<Result<string>> {
  // Refuse an option-injecting ref before any git runs (Issue #12).
  try {
    assertSafeGitRef(branchName, "PR head branch name");
    assertSafeGitRef(baseBranch, "PR base branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  // Ensure the local base branch is current
  await ensureDefaultBranchCurrent(baseBranch, options);

  // Issue #394: the base ref this update is judged against is the *published*
  // one wherever it exists. `ensureDefaultBranchCurrent` cannot move a local
  // base branch that another lane's worktree has checked out — git refuses,
  // correctly — so trusting the local ref would rebase onto a base that is
  // already behind and leave the PR reported as behind for ever.
  const baseRef = await resolvePublishedBaseRef(baseBranch, options);

  // Issue #211 / #394: position the branch at its remote head in one
  // mutating command. The old shape read `HEAD`, ran a bare
  // `git checkout <branch>`, and then fast-forwarded — three commands with
  // two windows in which a lane sharing this clone could delete or move the
  // branch, which is exactly how an open PR whose branch sits healthily on
  // origin was reported as `pathspec … did not match any file(s) known to
  // git` (PR #392). `checkoutPrBranchAtRemoteHead` fetches the tracking ref
  // explicitly and uses `checkout -B`, so a missing, stale or corrupt local
  // ref is overwritten rather than read — and it still refuses loudly, with
  // the typed ahead-of-remote error, when the local branch carries commits
  // origin has never seen: those are somebody's unpushed work and this pass
  // force-pushes whatever it produces.
  const alignResult = await checkoutPrBranchAtRemoteHead(branchName, options);
  if (!alignResult.ok) {
    return { ok: false, error: alignResult.error };
  }
  const alignNote = alignResult.value === "reset-to-remote"
    ? `positioned '${branchName}' on its remote head. `
    : "";

  // Ensure enough history for range detection on a shallow clone (Issue #1502)
  await ensureHistoryDepth(["HEAD", baseRef], options);

  // Check if rebase is needed
  const behindResult = await runGitCommand(
    ["rev-list", "--count", `HEAD..${baseRef}`],
    options,
  );
  const behindCount = behindResult.ok && behindResult.value.code === 0
    ? parseInt(behindResult.value.stdout.trim(), 10) || 0
    : 0;

  // Issue #1313: When reason is "conflicting", always use merge-based
  // resolution regardless of behindCount. GitHub's merge analysis has
  // detected conflicts — rebase will fail for divergent branches.
  // Use merge (with -X theirs fallback) to accept base branch changes.
  if (reason === "conflicting") {
    const conflicting = await resolveConflictingPrBranch(
      branchName,
      baseBranch,
      baseRef,
      options,
    );
    return conflicting.ok
      ? { ok: true, value: `${alignNote}${conflicting.value}` }
      : conflicting;
  }

  // Return early when not behind and no conflict reason provided.
  if (behindCount === 0) {
    return {
      ok: true,
      value: `${alignNote}PR branch '${branchName}' is already up to date ` +
        `with '${baseBranch}'`,
    };
  }

  // Attempt rebase (history already deepened above)
  const rebaseResult = await runGitCommand(
    buildRebaseArgs(baseRef),
    options,
  );

  if (rebaseResult.ok && rebaseResult.value.code === 0) {
    const pushed = await forcePushFeatureBranch(branchName, options);
    return pushed.ok
      ? { ok: true, value: `${alignNote}${pushed.value}` }
      : pushed;
  }

  // Rebase conflicted (Issue #4373): abort and leave the branch exactly as
  // it was. The old path resolved by `checkout --ours` (= upstream) per
  // conflicted file and force-pushed, which silently threw away the PR's
  // own changes to that file. Issue #386 still holds: never recreate the
  // branch — that destroys all PR commits.
  await runGitCommand(["rebase", "--abort"], options);
  return {
    ok: false,
    error: prBranchConflictError(branchName, baseBranch, "rebase"),
  };
}

/**
 * Resolve a PR branch that has merge conflicts but is not behind (Issue #1313).
 *
 * When GitHub reports a PR as CONFLICTING but behind_by is 0, the branches
 * have diverged in a way that standard rebase cannot detect locally. This
 * function merges the base branch into the feature branch, accepting base
 * branch changes for any conflicted files, then force-pushes.
 *
 * Strategy:
 * 1. Try a clean merge first (no conflicts → done)
 * 2. If merge conflicts, abort and retry with -X theirs (favour base branch)
 * 3. If that fails, manually resolve each conflicted file with checkout --theirs
 *
 * @param branchName - The feature branch
 * @param baseBranch - The base branch's name, for the operator-facing verdict
 * @param baseRef - The ref actually merged from — the published base wherever
 *   it exists (Issue #394)
 * @param options - Git command options
 * @returns Result indicating success or failure
 */
async function resolveConflictingPrBranch(
  branchName: string,
  baseBranch: string,
  baseRef: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  // Ensure enough history for the merge on a shallow clone (Issue #1502)
  await ensureHistoryDepth(["HEAD", baseRef], options);

  // Attempt 1: Clean merge
  const mergeResult = await runGitCommand(
    ["merge", baseRef, "--no-edit"],
    options,
  );

  if (mergeResult.ok && mergeResult.value.code === 0) {
    return await fetchAndForcePush(branchName, options);
  }

  // The merge conflicted (Issue #4373): abort and leave the branch exactly
  // as it was. The old path retried with `-X theirs` and then
  // `checkout --theirs` per file — both discard the PR's conflicting hunks
  // (or whole files) and force-push a commit that still carries the PR's
  // message. A conflict here needs a real merge, not a side-pick.
  await runGitCommand(["merge", "--abort"], options);
  return {
    ok: false,
    error: prBranchConflictError(branchName, baseBranch, "merge"),
  };
}

/**
 * Fetch a branch from origin then force-push it (Issue #1313).
 *
 * Fetching before force-pushing ensures the remote-tracking ref
 * (`refs/remotes/origin/<branch>`) is current. This makes
 * `--force-with-lease` accurate: if another user pushed since our last
 * fetch, the updated tracking ref will cause `--force-with-lease` to
 * correctly reject our push (protecting their work). If nobody pushed,
 * the fetch is a no-op and the push proceeds normally.
 *
 * @param branchName - The branch to fetch and then force-push
 * @param options - Git command options
 * @returns Result indicating success or failure
 */
async function fetchAndForcePush(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  // Fetch to refresh the remote-tracking ref before the lease check
  await runGitCommand(buildFetchArgs("origin", branchName), options);
  return await forcePushFeatureBranch(branchName, options);
}

/**
 * Force-push a feature branch (safe — uses --force-with-lease).
 *
 * @param branchName - The branch to push
 * @param options - Git command options
 * @returns Result indicating success
 */
async function forcePushFeatureBranch(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const { isProtectedBranch } = await import("./git_branch.ts");

  if (isProtectedBranch(branchName)) {
    return {
      ok: false,
      error: new Error(`Cannot force-push to protected branch '${branchName}'`),
    };
  }

  // Issue #275: through the sanctioned builder, so the branch name is
  // validated and sits behind `--end-of-options`, and the lease flag stays
  // ahead of the separator where git still reads it as a flag.
  const pushResult = await runGitCommand(
    buildPushArgs("origin", branchName, { forceWithLease: true }),
    options,
  );

  if (!pushResult.ok || pushResult.value.code !== 0) {
    const errorMsg = pushResult.ok
      ? pushResult.value.stderr
      : pushResult.error.message;
    return {
      ok: false,
      error: new Error(
        `Failed to push updated branch '${branchName}': ${errorMsg}`,
      ),
    };
  }

  return {
    ok: true,
    value: `Successfully pushed updated PR branch '${branchName}'`,
  };
}

/**
 * Ensure a PR is mergeable by rebasing if behind (Issue #482).
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - The PR number
 * @param branchName - The feature branch to check
 * @param baseBranch - The base branch the PR targets
 * @param options - Git command options
 * @returns Result indicating success
 */
export async function ensurePrMergeable(
  _repo: string,
  _prNumber: number,
  branchName: string,
  baseBranch: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  // Fetch the latest base branch
  const fetchResult = await runGitCommandChecked(
    ["fetch", "origin", baseBranch],
    options,
  );

  if (!fetchResult.ok) {
    return {
      ok: true,
      value: "Could not fetch base branch — skipping mergeability check",
    };
  }

  // Update local base branch ref
  const currentBranchResult = await runGitCommand(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    options,
  );
  const currentBranch = currentBranchResult.ok
    ? currentBranchResult.value.stdout.trim()
    : "";

  if (currentBranch === baseBranch) {
    await runGitCommand(["reset", "--hard", `origin/${baseBranch}`], options);
  } else {
    await runGitCommand(
      ["branch", "-f", baseBranch, `origin/${baseBranch}`],
      options,
    );
  }

  // Ensure we are on the feature branch
  if (currentBranch !== branchName) {
    const checkoutResult = await runGitCommand(
      buildCheckoutArgs(branchName),
      options,
    );
    if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
      return {
        ok: false,
        error: checkoutFailureError(branchName, checkoutResult),
      };
    }
  }

  // Ensure enough history for the range/rebase on a shallow clone (Issue #1502)
  await ensureHistoryDepth(["HEAD", baseBranch], options);

  // Check if behind
  const behindResult = await runGitCommand(
    ["rev-list", "--count", `HEAD..${baseBranch}`],
    options,
  );
  const behindCount = behindResult.ok && behindResult.value.code === 0
    ? parseInt(behindResult.value.stdout.trim(), 10) || 0
    : 0;

  if (behindCount === 0) {
    return {
      ok: true,
      value:
        `PR branch '${branchName}' is up to date with '${baseBranch}' — no conflicts`,
    };
  }

  // Attempt rebase
  const rebaseResult = await runGitCommand(
    buildRebaseArgs(baseBranch),
    options,
  );

  if (rebaseResult.ok && rebaseResult.value.code === 0) {
    return await forcePushFeatureBranch(branchName, options);
  }

  // Rebase failed — attempt conflict resolution
  const { resolveRebaseConflicts } = await import(
    "./git_conflict_resolution.ts"
  );
  const conflictResult = await resolveRebaseConflicts(options);

  if (conflictResult.ok) {
    return await forcePushFeatureBranch(branchName, options);
  }

  // Issue #386: Do NOT recreate the branch
  await runGitCommand(["rebase", "--abort"], options);
  return {
    ok: false,
    error: new Error(
      `Could not resolve merge conflicts for PR branch '${branchName}' — may require manual conflict resolution`,
    ),
  };
}
