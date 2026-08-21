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
  buildRebaseArgs,
} from "./git_ref_args.ts";
import { syncBranchToRemoteHead } from "./git_branch_sync.ts";
import { requireDiskSpaceForGitOperation } from "./disk_space.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import { ensureHistoryDepth } from "./git_history.ts";
import { checkoutPrBranchAtRemoteHead } from "./pr_branch_checkout.ts";

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
      const stderrTail = (checkoutResult.ok
        ? checkoutResult.value.stderr
        : checkoutResult.error.message)
        .trim().split("\n").slice(0, 6).join(" | ");
      return {
        ok: false,
        error: new Error(
          `Failed to checkout branch '${branchName}': ${
            stderrTail || "git reported no stderr"
          }`,
        ),
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
  let selfHealNote = "";
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
    // Push the synced milestone branch (Issue #605)
    await runGitCommand(["push", "origin", milestoneBranch], options);
    return {
      ok: true,
      value:
        `${selfHealNote}Successfully merged '${defaultBranch}' into '${milestoneBranch}' (${behindCount} commit(s) integrated)`,
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
    await runGitCommand(["push", "origin", milestoneBranch], options);
    return {
      ok: true,
      value:
        `${selfHealNote}Issue #605: Auto-resolved merge conflicts (favouring '${defaultBranch}' changes)`,
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

  await runGitCommand(["push", "origin", milestoneBranch], options);
  return {
    ok: true,
    value:
      `${selfHealNote}Issue #605: Resolved merge conflicts for '${milestoneBranch}' (accepted '${defaultBranch}' changes)`,
  };
}

/**
 * Bring the checked-out branch to origin's head before it is judged
 * (Issue #211).
 *
 * The branch-update pass runs `git checkout <branch>` in a long-lived
 * workdir, so it can pick up a **stale local copy** of the branch left by an
 * earlier pass. Merging the base into that old tree finds conflicts that do
 * not exist on the branch GitHub is actually merging — which is how a
 * mergeable PR ended up labelled `merge-conflict` (NEAT-AI-core #557).
 *
 * - Local behind or equal to origin → fast-forward to origin's head.
 * - Local ahead of origin (genuine unpushed work) → refuse, loudly. Those
 *   commits are never reset away, and "I hold unpushed work" is reported as
 *   itself rather than mislabelled a base-branch conflict.
 * - Branch absent from origin → nothing to sync; carry on.
 *
 * @param branchName - The PR head branch
 * @param options - Git command options
 * @returns Ok with a note on what happened, or a loud error
 */
async function alignBranchWithRemoteHead(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  const fetchResult = await runGitCommand(
    buildFetchArgs("origin", branchName),
    options,
  );
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    const stderr = fetchResult.ok
      ? fetchResult.value.stderr.trim()
      : fetchResult.error.message;
    if (/couldn't find remote ref|no such ref/i.test(stderr)) {
      return { ok: true, value: `Branch '${branchName}' is not on origin yet` };
    }
    return {
      ok: false,
      error: new Error(
        `Cannot align '${branchName}' with origin before evaluating it: ${
          stderr || "git reported no stderr"
        }`,
      ),
    };
  }

  const remoteHeadResult = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", "FETCH_HEAD"],
    options,
  );
  const remoteHead = remoteHeadResult.ok && remoteHeadResult.value.code === 0
    ? remoteHeadResult.value.stdout.trim()
    : "";
  if (!remoteHead) {
    return {
      ok: false,
      error: new Error(
        `Cannot align '${branchName}' with origin: FETCH_HEAD did not resolve`,
      ),
    };
  }

  const aheadResult = await runGitCommand(
    ["rev-list", "--count", "--end-of-options", `${remoteHead}..HEAD`],
    options,
  );
  const ahead = aheadResult.ok && aheadResult.value.code === 0
    ? parseInt(aheadResult.value.stdout.trim(), 10) || 0
    : 0;
  if (ahead > 0) {
    return {
      ok: false,
      error: new Error(
        `PR branch '${branchName}' holds ${ahead} unpushed commit(s) locally, ` +
          `so it cannot be evaluated against its base — origin's head is what ` +
          `GitHub merges (Issue #211). Push or discard the local commits first.`,
      ),
    };
  }

  const localHeadResult = await runGitCommand(["rev-parse", "HEAD"], options);
  const localHead = localHeadResult.ok && localHeadResult.value.code === 0
    ? localHeadResult.value.stdout.trim()
    : "";
  if (localHead === remoteHead) {
    return {
      ok: true,
      value: `Branch '${branchName}' already at origin's head`,
    };
  }

  // Nothing local-only to lose (ahead === 0), but never discard a dirty tree.
  const statusResult = await runGitCommand(["status", "--porcelain"], options);
  if (
    statusResult.ok && statusResult.value.code === 0 &&
    statusResult.value.stdout.trim().length > 0
  ) {
    return {
      ok: false,
      error: new Error(
        `PR branch '${branchName}' has uncommitted changes, so it cannot be ` +
          `brought to origin's head for evaluation (Issue #211)`,
      ),
    };
  }

  const resetResult = await runGitCommand(
    ["reset", "--hard", "--end-of-options", remoteHead],
    options,
  );
  if (!resetResult.ok || resetResult.value.code !== 0) {
    const stderr = resetResult.ok
      ? resetResult.value.stderr.trim()
      : resetResult.error.message;
    return {
      ok: false,
      error: new Error(
        `Failed to bring '${branchName}' to origin's head: ${
          stderr || "git reported no stderr"
        }`,
      ),
    };
  }

  return {
    ok: true,
    value: `Branch '${branchName}' fast-forwarded to origin's head`,
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

  // Check the feature branch out at its remote head (Issue #211). This pass
  // shares a long-lived clone, so a plain checkout lands on whatever the local
  // branch happens to hold — a stale branch from a run that failed to push
  // made the base look conflicted when the remote PR was mergeable, which
  // spuriously labelled it `merge-conflict`. The PR is what lives on origin.
  const aligned = await checkoutPrBranchAtRemoteHead(branchName, options);
  if (!aligned.ok) {
    return { ok: false, error: aligned.error };
  }

  // Issue #211: judge origin's head, not whatever this workdir happens to
  // hold. A stale local copy of the branch produces conflicts that do not
  // exist on the branch GitHub merges.
  const alignResult = await alignBranchWithRemoteHead(branchName, options);
  if (!alignResult.ok) {
    return { ok: false, error: alignResult.error };
  }

  // Judge the PR, not this clone (Issue #211). The checkout above takes
  // whatever local branch of that name the clone holds; a fleet sibling's push
  // — or commits an earlier run left behind — makes that branch something the
  // PR is not, and a conflict found on it labelled a mergeable PR
  // `merge-conflict`. Align with the remote head first, or refuse loudly.
  const sync = await syncBranchToRemoteHead(branchName, options);
  if (!sync.ok) {
    return { ok: false, error: sync.error };
  }

  // Ensure enough history for range detection on a shallow clone (Issue #1502)
  await ensureHistoryDepth(["HEAD", baseBranch], options);

  // Check if rebase is needed
  const behindResult = await runGitCommand(
    ["rev-list", "--count", `HEAD..${baseBranch}`],
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
    return await resolveConflictingPrBranch(branchName, baseBranch, options);
  }

  // Return early when not behind and no conflict reason provided.
  if (behindCount === 0) {
    return {
      ok: true,
      value:
        `PR branch '${branchName}' is already up to date with '${baseBranch}'`,
    };
  }

  // Attempt rebase (history already deepened above)
  const rebaseResult = await runGitCommand(
    buildRebaseArgs(baseBranch),
    options,
  );

  if (rebaseResult.ok && rebaseResult.value.code === 0) {
    return await forcePushFeatureBranch(branchName, options);
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
 * @param baseBranch - The base branch to merge from
 * @param options - Git command options
 * @returns Result indicating success or failure
 */
async function resolveConflictingPrBranch(
  branchName: string,
  baseBranch: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  // Ensure enough history for the merge on a shallow clone (Issue #1502)
  await ensureHistoryDepth(["HEAD", baseBranch], options);

  // Attempt 1: Clean merge
  const mergeResult = await runGitCommand(
    ["merge", baseBranch, "--no-edit"],
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

  const pushResult = await runGitCommand(
    ["push", "origin", branchName, "--force-with-lease"],
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
        error: new Error(`Failed to checkout branch '${branchName}'`),
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
