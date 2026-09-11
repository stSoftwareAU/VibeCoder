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

import type { Logger, Result } from "../types.ts";
import { runGitCommand, runGitCommandChecked } from "./git_timeout.ts";
import { cleanWorkingTree } from "./ignored_path_clean.ts";
import { spawnGh } from "./gh_spawn.ts";
import {
  isRuleViolationPush,
  raiseMilestoneSyncPr,
} from "./milestone_sync_pr.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { buildBranchDeleteArgs } from "./git_branch_args.ts";
import { ensureDefaultBranchCurrent } from "./git_push.ts";
import {
  assertSafeGitRef,
  assertSafeRefComponent,
  buildCheckoutArgs,
  buildCheckoutNewBranchArgs,
  buildFetchArgs,
  buildPushArgs,
  buildRebaseArgs,
} from "./git_ref_args.ts";
import { checkoutPrBranchAtRemoteHead } from "./pr_branch_checkout.ts";
import {
  assertAdoptedMergeIsSafe,
  describeGitFailure,
  type GitRunResult,
  readMergeCommitState,
} from "./milestone_merge_state.ts";
import { requireDiskSpaceForGitOperation } from "./disk_space.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import { ensureHistoryDepth } from "./git_history.ts";
import type { MilestoneSyncOutcome } from "./milestone_sync_conflict.ts";
import {
  analyseConflictedFile,
  buildResolutionCommitMessage,
  describeDecisionRung,
  MilestoneConflictEscalation,
  planConflictResolution,
} from "./milestone_conflict_triage.ts";
import {
  climbConflictLadder,
  hasConflictMarkers,
  listUnmergedPaths,
  type MilestoneConflictAgentFn,
} from "./milestone_conflict_ladder.ts";
import {
  applyConflictPlan,
  readConflictedSides,
  readMergeBase,
  readTestEvidence,
  unionMergeConflictedFile,
} from "./milestone_conflict_git.ts";
import { verifyResolvedTree } from "./milestone_resolution_gate.ts";
import {
  checkMergedTree,
  mergeGateFailureError,
  type MergeGateFn,
} from "./milestone_merge_gate.ts";

/**
 * Describe a failed `git checkout` with git's own output (Issues #49, #335).
 *
 * A checkout failure that only says which branch failed cannot be acted on:
 * Issue #335 saw the same branch log 65 identical warnings across days with
 * no diagnosis in any of them. Git's output *is* the diagnosis — a missing
 * ref, a dirty tree, a lock file — so it travels with the error, stdout
 * included (Issue #1964).
 *
 * @param branchName - The branch that could not be checked out
 * @param result - The `runGitCommand` result for the failed checkout
 * @returns An error naming the branch and git's own failure
 */
function checkoutFailureError(
  branchName: string,
  result: GitRunResult,
): Error {
  return new Error(
    `Failed to checkout branch '${branchName}': ${
      describeGitFailure(result, { lines: 6, from: "head" })
    }`,
  );
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
    assertSafeRefComponent(defaultBranch, "default branch name");
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
    buildRebaseArgs(defaultBranch),
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
      await runGitCommand(buildCheckoutArgs(defaultBranch), options);
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
  await runGitCommand(buildCheckoutArgs(defaultBranch), options);
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
 * A push that fails for anything other than a repository rule is a **failed
 * sync** (Issue #1964): it used to return an empty note, so the branch was
 * logged as synced, counted as synced and recorded against the tip it never
 * reached — which is the cadence guard then skipping it every cycle.
 *
 * @returns A note to append to the sync's outcome, empty on the ordinary path.
 */
async function pushSyncedMilestoneBranch(
  milestoneBranch: string,
  defaultBranch: string,
  options: GitCommandOptions,
  repo?: string,
): Promise<Result<string>> {
  const push = await runGitCommand(
    ["push", "origin", milestoneBranch],
    options,
  );
  if (push.ok && push.value.code === 0) return { ok: true, value: "" };

  // Git's own account of the refusal, stdout included (Issue #1964).
  const stderr = push.ok ? push.value.stderr : push.error.message;
  if (!isRuleViolationPush(stderr)) {
    return {
      ok: false,
      error: new Error(
        `Failed to push '${milestoneBranch}' to origin, so the merge is ` +
          `local only (Issue #1964): ${describeGitFailure(push)}`,
      ),
    };
  }

  if (!repo) {
    return {
      ok: true,
      value: `PUSH REFUSED by a repository rule and no repository was named, ` +
        `so no sync PR could be raised (Issue #589) — `,
    };
  }

  const raised = await raiseMilestoneSyncPr(
    repo,
    milestoneBranch,
    defaultBranch,
    {
      git: async (args) => {
        const result = await runGitCommand(args, options);
        return result.ok
          ? {
            code: result.value.code,
            stderr: result.value.stderr,
            stdout: result.value.stdout,
          }
          : { code: 1, stderr: result.error.message, stdout: "" };
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
    return {
      ok: true,
      value: `PUSH REFUSED by a repository rule and the sync PR could not be ` +
        `raised: ${raised.error.message} (Issue #589) — `,
    };
  }
  return {
    ok: true,
    value: raised.value.opened
      ? `RAISED a sync PR from '${raised.value.branch}' — the branch is ` +
        `gated, so the push became a pull request (Issue #589) — `
      : `UPDATED the open sync PR from '${raised.value.branch}' (Issue #589) — `,
  };
}

/**
 * Type-check the merged tree, then push it — or refuse (Issue #974).
 *
 * Git reporting no conflict says only that both sides were internally
 * consistent; three merges that passed that bar deleted live wiring and were
 * pushed unchecked, because `milestone/*` has no required checks to catch the
 * result downstream. So the merge commit is judged before it is published: it
 * is pushed when the repository's own type check passes, and reset away with
 * a typed refusal when it does not.
 *
 * @param preMergeSha - Where the branch stood before the merge, so a rejected
 *   merge can be undone exactly
 * @returns The note to append to the sync outcome, or the gate's refusal
 */
async function gateThenPushMilestoneBranch(
  milestoneBranch: string,
  defaultBranch: string,
  options: GitCommandOptions,
  repo: string | undefined,
  mergeGate: MergeGateFn,
  preMergeSha: string,
): Promise<Result<string>> {
  const outcome = await mergeGate(options.cwd ?? ".");

  if (outcome.status === "failed") {
    // The caller refuses to merge at all without a pre-merge SHA, so there is
    // always one to roll back to here.
    let resetNote = "";
    const reset = await runGitCommand(
      ["reset", "--hard", preMergeSha],
      options,
    );
    if (!reset.ok || reset.value.code !== 0) {
      // stdout counts as much as stderr here (Issue #1964).
      resetNote = ` — and the local merge could NOT be reset to ` +
        `${preMergeSha}: ${describeGitFailure(reset)}`;
    }
    return {
      ok: false,
      error: mergeGateFailureError(milestoneBranch, defaultBranch, {
        ...outcome,
        detail: `${outcome.detail}${resetNote}`,
      }),
    };
  }

  const pushNote = await pushSyncedMilestoneBranch(
    milestoneBranch,
    defaultBranch,
    options,
    repo,
  );
  // A push that did not happen is not a sync (Issue #1964).
  if (!pushNote.ok) return pushNote;
  // Say when nothing verified the tree, rather than let an unchecked push
  // read exactly like a checked one.
  const gateNote = outcome.status === "skipped"
    ? `UNGATED: ${outcome.detail} (Issue #974) — `
    : "";
  return { ok: true, value: `${gateNote}${pushNote.value}` };
}

/** Resolve a ref to its commit SHA; empty string when it cannot be read. */
async function readRef(
  ref: string,
  options: GitCommandOptions,
): Promise<string> {
  const result = await runGitCommand(["rev-parse", ref], options);
  return result.ok && result.value.code === 0 ? result.value.stdout.trim() : "";
}

/**
 * Sync a milestone branch with the default branch (Issue #422, #605).
 *
 * Uses merge (not rebase) to preserve milestone commit history. The merge is
 * type-checked before it is pushed (Issue #974) — see
 * {@link gateThenPushMilestoneBranch}.
 *
 * A merge that conflicts is triaged rather than resolved towards the default
 * branch on sight (Issue #1559). Where an automatic rule can decide the
 * conflict — the same fix landed twice, or one side keeps every line of the
 * other — the decision is applied, recorded on the merge commit, verified
 * against the repository's own check, manifest check and unit suite, and only
 * then pushed.
 *
 * What the triage cannot decide climbs the rest of the ladder the PR pass
 * climbs (Issue #1777): the deterministic dependency rules, then the
 * resolution agent, each over the paths still left. Only a file every rung
 * leaves undecided aborts the merge, and the refusal then carries both sides
 * prepared for a human, naming the rung that failed. Either way the conflict
 * travels back with the outcome (Issue #1558): the files that collided, the
 * commit each side stood at, and the rung that settled each file.
 *
 * @param milestoneBranch - The milestone branch name
 * @param defaultBranch - The default branch to sync from
 * @param options - Git command options
 * @returns Result carrying the summary, and the conflict when there was one
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
  /**
   * The gate the merged tree must pass before it is pushed (Issue #974).
   * Defaults to the repository's own type check; tests inject a verdict.
   */
  mergeGate: MergeGateFn = checkMergedTree,
  /**
   * The gate a merge whose conflicts the worker resolved itself must pass
   * (Issue #1559). Stricter than the type check above, because choosing a
   * side compiles perfectly and still drops the other side's behaviour — so
   * the repository's own check, manifest check and unit suite all run.
   *
   * A caller that injected its own `mergeGate` gets that gate here too: a
   * sync whose verification is stubbed stays stubbed on both paths.
   */
  resolutionGate: MergeGateFn = mergeGate === checkMergedTree
    ? verifyResolvedTree
    : mergeGate,
  /**
   * The resolution agent, the ladder's last rung before a human
   * (Issue #1777). Injected so a test needs no model, and so a caller that
   * cannot run one simply stops after the dependency rules rather than
   * pretending the conflict was decided.
   */
  agentFn?: MilestoneConflictAgentFn,
  /** Logger for the ladder's diagnostics; absent logs nothing. */
  logger?: Logger,
): Promise<Result<MilestoneSyncOutcome>> {
  // Refuse an option-injecting ref before any git runs (Issue #12). The
  // default branch used to be repo-derived (setupRepo read it from
  // `.vibe_default_branch` inside the clone, Issue #1269; it now lives in
  // `.git/vibe/default_branch`, Issue #1652) and reaches
  // `git merge <defaultBranch>` below as a bare positional, which the ref-argv
  // gate does not cover — so it is checked here, as the feature-branch sync
  // already does.
  try {
    assertSafeGitRef(milestoneBranch, "milestone branch name");
    assertSafeRefComponent(defaultBranch, "default branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

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
      // Ignored executable paths go with it (Issue #1443). A failure is
      // named in the note this function returns, so the sync's own record
      // carries it rather than it being dropped here.
      const cleaned = await cleanWorkingTree(options);
      if (!cleaned.ok) {
        console.error(`[sync] ${cleaned.error.message}`);
      }
      dirtyNote = `SELF-HEALING: discarded ${files.length} uncommitted ` +
        `change(s) in the shared clone before checkout (${
          // Porcelain v1 is a two-character status field, then the path.
          files.slice(0, 3).map((line) => line.slice(2).trim()).join(", ")}${
          files.length > 3 ? `, +${files.length - 3} more` : ""
        })${cleaned.ok ? "" : " — WARNING: " + cleaned.error.message} — `;
    }

    const checkoutResult = await runGitCommand(
      ["checkout", milestoneBranch],
      options,
    );
    if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
      // Surface git's own output (Issue #49): "error: Your local changes to
      // the following files would be overwritten by checkout: …" — usually a
      // dirty tree a timed-out claim left on this shared clone — is the whole
      // diagnosis, and the old error discarded it. stdout counts too
      // (Issue #1964), so a stdout-only refusal is never logged as silence.
      return {
        ok: false,
        error: new Error(
          `Failed to checkout milestone branch '${milestoneBranch}': ${
            describeGitFailure(checkoutResult, { lines: 6, from: "head" })
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
      value: {
        message:
          `${selfHealNote}Milestone branch '${milestoneBranch}' is already up to date with '${defaultBranch}'`,
      },
    };
  }

  // Where the branch stands before any merge, so the gate can undo one
  // exactly when the merged tree does not compile (Issue #974). Read it
  // BEFORE merging: without it a refused merge cannot be rolled back, so the
  // honest move is to refuse to start rather than to discover it afterwards.
  const preMergeShaResult = await runGitCommand(["rev-parse", "HEAD"], options);
  const preMergeSha = preMergeShaResult.ok &&
      preMergeShaResult.value.code === 0
    ? preMergeShaResult.value.stdout.trim()
    : "";
  if (!preMergeSha) {
    return {
      ok: false,
      error: new Error(
        `Refusing to merge '${defaultBranch}' into '${milestoneBranch}': ` +
          `its pre-merge HEAD could not be read, so a merge the gate rejects ` +
          `could not be rolled back (Issue #974): ${
            describeGitFailure(preMergeShaResult)
          }`,
      ),
    };
  }

  // Merge default into milestone (preserve commit history)
  const mergeResult = await runGitCommand(
    ["merge", defaultBranch, "--no-edit"],
    options,
  );

  if (mergeResult.ok && mergeResult.value.code === 0) {
    // Push the synced milestone branch (Issue #605), or raise a PR for it
    // where a repository rule refuses the push (Issue #589) — but only once
    // the merged tree has passed the repo's own gate (Issue #974).
    const gated = await gateThenPushMilestoneBranch(
      milestoneBranch,
      defaultBranch,
      options,
      repo,
      mergeGate,
      preMergeSha,
    );
    if (!gated.ok) return gated;
    return {
      ok: true,
      value: {
        message:
          `${selfHealNote}${gated.value}Successfully merged '${defaultBranch}' into '${milestoneBranch}' (${behindCount} commit(s) integrated)`,
      },
    };
  }

  // Merge conflict. Both sides are read straight out of the conflicted index
  // — once the merge is aborted git no longer holds them, and a conflict
  // nobody can describe is a conflict nobody reconciles (Issues #1558,
  // #1559).
  // A listing git could not produce reads as "no conflicted files", which the
  // branch below reports as the non-conflict failure it is, quoting git's own
  // merge stderr — so the failure is diagnosed there rather than swallowed.
  const listed = await listUnmergedPaths(options);
  const conflictedFiles = listed.ok ? listed.value : [];
  const defaultSha = await readRef(defaultBranch, options);

  if (conflictedFiles.length === 0) {
    await runGitCommand(["merge", "--abort"], options);
    // Honest failure (Issue #4260): a merge that fails with ZERO conflicted
    // files failed for a non-conflict reason (unrelated histories, shallow
    // history, dirty tree, vanished remote…). This used to return ok:true and
    // be logged as "Synced …" — FLEET milestone/4064 sat 5 commits behind
    // Develop for days while every cycle said 0 failed. Surface git's own
    // output — stdout as well as stderr (Issue #1964) — so the real reason is
    // in the log.
    return {
      ok: false,
      error: new Error(
        `Merge of '${defaultBranch}' into '${milestoneBranch}' failed ` +
          `with no conflicted files — a non-conflict failure ` +
          `(Issue #4260): ${describeGitFailure(mergeResult)}`,
      ),
    };
  }

  const mergeBase = await readMergeBase(preMergeSha, defaultBranch, options);
  const readSides = await readConflictedSides(
    conflictedFiles,
    mergeBase,
    defaultBranch,
    defaultSha || defaultBranch,
    preMergeSha,
    options,
  );
  if (!readSides.ok) {
    await runGitCommand(["merge", "--abort"], options);
    return readSides;
  }
  const sides = readSides.value;
  const plan = planConflictResolution(
    sides,
    await readTestEvidence(
      mergeBase,
      defaultSha || defaultBranch,
      preMergeSha,
      options,
    ),
  );

  // A conflicted test file whose sides do not contain one another is merged
  // as a union — both sides' hunks kept — rather than escalated on sight
  // (Issue #1559). A union that would lose a case, or that git could not
  // produce, becomes an escalation for that file instead.
  const decided = new Map(plan.decisions.map((d) => [d.path, d]));
  for (const file of sides) {
    const decision = decided.get(file.path);
    if (decision?.action !== "union") continue;
    // An append-only ledger reads the default branch's entry first (Issue
    // #1768); a test-file union keeps the branch's own cases first as before.
    const failure = await unionMergeConflictedFile(
      file,
      options,
      decision.case === "both-inserted" ? "default-first" : "milestone-first",
    );
    if (failure) {
      decision.action = "escalate";
      decision.reason = `${decision.reason} — and ${failure}`;
    }
  }
  // The ladder (Issue #1777): what the triage could not decide goes to the
  // deterministic dependency rules, and what those defer goes to the
  // resolution agent — the same two rungs the PR pass climbs, over the same
  // clone. Only a file every rung leaves undecided reaches a human.
  const triaged = plan.decisions.filter((d) => d.action !== "escalate");
  // Take the triage's sides NOW, before the ladder climbs (Issue #2006). The
  // agent rung stages the whole working tree once the agent is done — a
  // resolution that extracts a helper leaves a new file the merge commit
  // must carry — and `git add -A` does not stop at the paths the agent was
  // asked about. A triaged path still unmerged at that point was staged
  // with git's marker-laden working copy and its merge stages were gone, so
  // its side could no longer be taken and the whole resolution — eleven
  // minutes of agent work included — was refused as "the merge stages of
  // conflicted file 'Cargo.lock' could not be read". With the sides already
  // staged the agent sees them as decided, and staging the tree changes
  // nothing about them.
  const sidesTaken = await applyConflictPlan(
    {
      ...plan,
      resolved: triaged,
      escalations: plan.decisions.filter((d) => d.action === "escalate"),
    },
    sides,
    defaultBranch,
    milestoneBranch,
    options,
  );
  if (!sidesTaken.ok) {
    await runGitCommand(["merge", "--abort"], options);
    return sidesTaken;
  }
  const ladder = await climbConflictLadder({
    escalations: plan.decisions.filter((d) => d.action === "escalate"),
    options,
    milestoneBranch,
    defaultBranch,
    agentFn,
    logger,
  });
  const resolved = [...triaged, ...ladder.resolved];
  const escalations = ladder.escalations;
  /** Every settled file by path, carrying the rung that settled it. */
  const settled = new Map(resolved.map((d) => [d.path, d]));

  // Case 3 (Issue #1559): no automatic rule can choose between the two sides,
  // so nothing is pushed and the branch is left exactly as it was. The
  // analysis travels with the refusal — both sides' exports, both sides' test
  // names and the difference between them — because that preparation is most
  // of the hour the reader would otherwise spend.
  if (escalations.length > 0) {
    await runGitCommand(["merge", "--abort"], options);
    const escalated = new Map(escalations.map((d) => [d.path, d]));
    const analyses = sides
      .filter((side) => escalated.has(side.path))
      .map((side) =>
        analyseConflictedFile(side, escalated.get(side.path)!.reason)
      );
    return {
      ok: false,
      error: new MilestoneConflictEscalation(
        `Refusing to resolve the merge of '${defaultBranch}' into ` +
          `'${milestoneBranch}': ${escalations.length} of ` +
          `${conflictedFiles.length} conflicted file(s) need a human — ` +
          `every rung of the ladder left them undecided (Issues #1559, ` +
          `#1777) — ${
            escalations.map((d) => `${d.path}: ${d.reason}`).join("; ")
          }`,
        analyses,
        resolved,
        defaultSha,
        undefined,
        preMergeSha,
      ),
    };
  }

  // Who writes the merge commit is read from git, not assumed (Issue #1964).
  // The agent rung works in this very clone, and an agent that committed the
  // merge itself leaves nothing for `git commit -m …`: git exits 1 saying
  // "nothing to commit, working tree clean" on stdout, and the sync used to
  // read that as a failure, abort and throw a good resolution away every
  // cycle until a human took the branch. Read BEFORE the plan is applied,
  // because taking a side needs the conflicted index the commit cleared.
  const mergeState = await readMergeCommitState({
    preMergeSha,
    defaultSha,
    options,
  });

  /**
   * Refuse the resolution, optionally putting the branch back where it stood.
   *
   * A state nobody could read restores nothing: discarding work on a check
   * that did not run is the one direction that cannot be undone.
   */
  const refuseResolution = async (
    detail: string,
    restore: boolean,
  ): Promise<Result<MilestoneSyncOutcome>> => {
    let note = "";
    if (restore) {
      const reset = await runGitCommand(
        ["reset", "--hard", preMergeSha],
        options,
      );
      note = reset.ok && reset.value.code === 0
        ? ` — the branch was reset to ${preMergeSha}`
        : ` — and the branch could NOT be reset to ${preMergeSha}: ${
          describeGitFailure(reset)
        }`;
    }
    return {
      ok: false,
      error: new Error(
        `Refusing to commit the resolution of '${defaultBranch}' into ` +
          `'${milestoneBranch}' (Issue #1964): ${detail}${note}`,
      ),
    };
  };

  if (mergeState.kind === "unknown") {
    return await refuseResolution(mergeState.detail, false);
  }
  if (mergeState.kind === "no-merge") {
    return await refuseResolution(mergeState.detail, true);
  }
  if (mergeState.kind === "already-committed") {
    // Every side the triage chose was staged before any rung ran (Issue
    // #2006), so a rung that committed the merge committed those sides too;
    // the adopted commit is judged on its safety alone.
    // The index gate saw nothing to inspect, so the commit's own changes are
    // held to it here rather than adopted unchecked (Issue #1758).
    const safe = await assertAdoptedMergeIsSafe({ preMergeSha, options });
    if (!safe.ok) {
      return await refuseResolution(
        `the merge commit was written by another rung and ${safe.error.message}`,
        true,
      );
    }
  }

  // The triage's sides were taken before the ladder climbed (Issue #2006);
  // what remains is to prove no rung left anything unmerged.

  // The tree must be fully resolved — by the triage, the rules, the agent or
  // all three (Issue #1777). A path still unmerged, or a file still carrying
  // conflict markers, is a half-resolution: it compiles nowhere and must
  // never be committed as a merge. Both guards run over every conflicted
  // path, so a rung that reported success while leaving a mess is caught
  // here rather than pushed.
  const unresolved = await listUnmergedPaths(options);
  if (!unresolved.ok) {
    await runGitCommand(["merge", "--abort"], options);
    return {
      ok: false,
      error: new Error(
        `Refusing to commit the resolution of '${defaultBranch}' into ` +
          `'${milestoneBranch}': ${unresolved.error.message} (Issue #1777)`,
      ),
    };
  }
  if (unresolved.value.length > 0) {
    await runGitCommand(["merge", "--abort"], options);
    return {
      ok: false,
      error: new Error(
        `Refusing to commit the resolution of '${defaultBranch}' into ` +
          `'${milestoneBranch}': ${unresolved.value.length} path(s) are ` +
          `still ` +
          `unmerged (Issue #1777): ${unresolved.value.join(", ")}`,
      ),
    };
  }
  const markers = await hasConflictMarkers(conflictedFiles, options);
  if (!markers.ok) {
    await runGitCommand(["merge", "--abort"], options);
    return {
      ok: false,
      error: new Error(
        `Refusing to commit the resolution of '${defaultBranch}' into ` +
          `'${milestoneBranch}': ${markers.error.message} (Issue #1777)`,
      ),
    };
  }
  if (markers.value) {
    await runGitCommand(["merge", "--abort"], options);
    return {
      ok: false,
      error: new Error(
        `Refusing to commit the resolution of '${defaultBranch}' into ` +
          `'${milestoneBranch}': the working tree still contains conflict ` +
          `markers (Issue #1777)`,
      ),
    };
  }

  const resolutionMessage = buildResolutionCommitMessage({
    defaultBranch,
    milestoneBranch,
    plan: { ...plan, resolved, escalations },
  });

  // An already-committed merge keeps its commit and takes the sync's message,
  // so the record of which rung settled each file is the same either way.
  const alreadyCommitted = mergeState.kind === "already-committed";
  const commitResult = alreadyCommitted
    ? await runGitCommand(
      ["commit", "--amend", "-m", resolutionMessage],
      options,
    )
    : await runGitCommand(["commit", "-m", resolutionMessage], options);
  if (!commitResult.ok || commitResult.value.code !== 0) {
    // Honest failure (Issue #4260), with git's stdout as well as its stderr
    // (Issue #1964) — `git commit` explains itself on stdout. Either way the
    // branch goes back where it stood: an un-reworded merge left behind would
    // be pushed next cycle with no record of which rung settled what.
    if (alreadyCommitted) {
      return await refuseResolution(
        `its commit could not be re-worded: ${
          describeGitFailure(commitResult)
        }`,
        true,
      );
    }
    await runGitCommand(["merge", "--abort"], options);
    return {
      ok: false,
      error: new Error(
        `Failed to commit the conflict resolution for '${milestoneBranch}' ` +
          `(Issues #4260, #1964): ${describeGitFailure(commitResult)}`,
      ),
    };
  }

  // A resolution the worker chose is verified the way a human's would be
  // (Issue #1559): the repository's own check, its manifest check and its
  // unit suite. A tree that defines none of them verified nothing, so
  // `skipped` refuses the push rather than reading as a pass.
  const gatedResolved = await gateThenPushMilestoneBranch(
    milestoneBranch,
    defaultBranch,
    options,
    repo,
    async (repoDir) => {
      const outcome = await resolutionGate(repoDir);
      return outcome.status === "skipped"
        ? {
          ...outcome,
          status: "failed" as const,
          detail: `${outcome.detail} — an automatic conflict resolution that ` +
            `cannot be verified is not a resolution (Issue #1559)`,
        }
        : outcome;
    },
    preMergeSha,
  );
  if (!gatedResolved.ok) {
    // The resolution was made and the verification refused it. The reader
    // gets both halves (Issue #1559) — what the gate said, and the two sides
    // that produced it — rather than the wall of compiler output that made
    // #1542 nearly useless for deciding anything. The branch was already
    // reset by the gate, so nothing was pushed.
    return {
      ok: false,
      error: new MilestoneConflictEscalation(
        gatedResolved.error.message,
        // The rung that actually settled each file, not the triage's
        // pre-ladder verdict on it: a file the rules or the agent decided
        // would otherwise be presented as one nothing could decide.
        sides.map((side) =>
          analyseConflictedFile(
            side,
            settled.get(side.path)?.reason ?? "resolved automatically",
          )
        ),
        resolved,
        defaultSha,
        gatedResolved.error.message,
        preMergeSha,
      ),
    };
  }

  // Each file names the rung that settled it (Issue #1777), so the log line
  // says which of triage, rules or agent did the work.
  const summary = resolved
    .map((d) =>
      `${d.path} (${
        describeDecisionRung(d, {
          ours: milestoneBranch,
          theirs: defaultBranch,
        })
      })`
    )
    .join(", ");
  return {
    ok: true,
    value: {
      message:
        `${selfHealNote}${gatedResolved.value}Issues #1559, #1777: resolved ${resolved.length} conflict(s) automatically — ${summary}`,
      conflict: {
        files: conflictedFiles,
        milestoneSha: preMergeSha,
        defaultSha,
        resolution: "auto",
        decisions: resolved,
      },
    },
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
