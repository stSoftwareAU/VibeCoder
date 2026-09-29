/**
 * The PR-raise sync point (Issues #2788, #2809).
 *
 * Before a PR is raised, the branch it targets is made current first, then the
 * feature branch catches up with that target — both by merge and plain push,
 * never a rebase or a force-push:
 *
 * 1. A milestone branch is merged up to the default branch
 *    (`presyncMilestoneBranchForIssueRun`), so the feature branch does not
 *    catch up with a stale milestone and go behind again moments later.
 * 2. The feature branch merges `origin/<base>` in ({@link mergeOntoBase}),
 *    through `ensureBranchCurrent`.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import {
  type BranchCurrencyOutcome,
  ensureBranchCurrent,
  type GitRunner,
} from "./branch_currency.ts";
import { assertSafeGitRef } from "./git_ref_args.ts";
import type { MilestonePresyncResult } from "./milestone_presync.ts";

/** Run one git command and report whether it exited 0. */
async function gitSucceeds(
  runGit: GitRunner,
  args: string[],
  cwd?: string,
): Promise<boolean> {
  const result = await runGit(args, cwd === undefined ? undefined : { cwd });
  return result.ok && result.value.code === 0;
}

/**
 * Merge `baseRef` into `branch` — the `ensureBranchCurrent` seam at PR raise.
 *
 * Only adds commits, so the push that follows is a plain fast-forward. Refuses
 * on a dirty tree (a merge could fold uncommitted work into its commit) and
 * aborts a conflicting merge so the branch is left exactly as it was, for the
 * one agent pass and then the conflict ladder.
 */
export async function mergeOntoBase(
  options: {
    branch: string;
    baseRef: string;
    runGit: GitRunner;
    cwd?: string;
  },
): Promise<Result<void>> {
  const { branch, baseRef, runGit, cwd } = options;
  assertSafeGitRef(branch, "PR-raise merge branch");
  assertSafeGitRef(baseRef, "PR-raise merge base");
  const gitOptions = cwd === undefined ? undefined : { cwd };

  const status = await runGit(["status", "--porcelain"], gitOptions);
  if (!status.ok || status.value.code !== 0) {
    return { ok: false, error: new Error("git status could not be read") };
  }
  if (status.value.stdout.trim() !== "") {
    return {
      ok: false,
      error: new Error(
        "the working tree carries uncommitted changes, so the base cannot " +
          "be merged in without folding them into the merge",
      ),
    };
  }

  if (
    !await gitSucceeds(runGit, ["checkout", "--end-of-options", branch], cwd)
  ) {
    return {
      ok: false,
      error: new Error(`could not check out '${branch}' to merge into it`),
    };
  }

  const merged = await runGit(
    ["merge", "--no-edit", "--end-of-options", baseRef],
    gitOptions,
  );
  if (merged.ok && merged.value.code === 0) {
    return { ok: true, value: undefined };
  }

  // Abort only a merge git actually started, and fail loud when the abort
  // itself fails: a half-merged tree is not "left exactly as it was".
  const merging = await gitSucceeds(
    runGit,
    ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    cwd,
  );
  if (merging && !await gitSucceeds(runGit, ["merge", "--abort"], cwd)) {
    return {
      ok: false,
      error: new Error(
        `merging '${baseRef}' into '${branch}' failed and 'git merge --abort' ` +
          `failed too — the working tree needs a human`,
      ),
    };
  }
  const why = merged.ok
    ? (merged.value.stderr || merged.value.stdout).trim().split("\n")[0]
    : merged.error.message;
  return {
    ok: false,
    error: new Error(`merging '${baseRef}' into '${branch}' failed: ${why}`),
  };
}

/** Injection points for {@link syncBranchesForPrRaise}. */
export interface PrRaiseSyncOptions {
  branch: string;
  /** The PR's base: the milestone branch, or the default branch. */
  baseBranch: string;
  /** Set when the base is a milestone branch that must be synced first. */
  milestoneBranch?: string;
  runGit: GitRunner;
  /** The feature branch's checkout. */
  cwd: string;
  /** The shared clone the milestone sync resets and checks out. */
  sharedClonePath: string;
  /** Merge the milestone branch up to the default branch and push it. */
  syncMilestone: () => Promise<MilestonePresyncResult>;
  log: (message: string) => void;
  warn: (message: string) => void;
}

/** What the PR-raise sync did. */
export type PrRaiseSyncOutcome =
  | {
    kind: "ok";
    /** The milestone sync's verdict; absent when there was none to run. */
    milestone?: MilestonePresyncResult | { status: "skipped"; detail: string };
    currency: BranchCurrencyOutcome;
  }
  /** The feature branch could not be checked out again; the PR must not go. */
  | { kind: "refused"; detail: string };

/**
 * Sync the milestone branch with the default branch, then the feature branch
 * with its base — in that order (Issue #2809).
 *
 * The milestone sync is never fatal: a deferred or failed sync is logged and
 * the feature branch still catches up with the milestone as it stands. When
 * the feature branch lives in the shared clone itself (no lane), the sync
 * would reset that clone, so a dirty tree skips it, and the feature branch is
 * checked out again afterwards — failing loud if it cannot be.
 */
export async function syncBranchesForPrRaise(
  options: PrRaiseSyncOptions,
): Promise<PrRaiseSyncOutcome> {
  const { branch, baseBranch, milestoneBranch, runGit, cwd, log, warn } =
    options;
  let milestone:
    | MilestonePresyncResult
    | { status: "skipped"; detail: string }
    | undefined;

  if (milestoneBranch !== undefined) {
    const shared = options.sharedClonePath === cwd;
    const status = shared
      ? await runGit(["status", "--porcelain"], { cwd })
      : undefined;
    const dirty = status !== undefined &&
      (!status.ok || status.value.code !== 0 ||
        status.value.stdout.trim() !== "");
    if (dirty) {
      milestone = {
        status: "skipped",
        detail: `'${milestoneBranch}' was not synced with the default branch ` +
          `before the PR: the shared clone carries uncommitted work the sync ` +
          `would reset`,
      };
      warn(milestone.detail);
    } else {
      try {
        milestone = await options.syncMilestone();
        const line = `PR-raise milestone sync of '${milestoneBranch}': ` +
          `${milestone.status} — ${milestone.detail}`;
        if (milestone.status === "deferred") warn(line);
        else log(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        milestone = {
          status: "deferred",
          detail: `the milestone sync threw: ${message}`,
        };
        warn(
          `PR-raise milestone sync of '${milestoneBranch}' failed: ${message}`,
        );
      }
      if (
        shared &&
        !await gitSucceeds(
          runGit,
          ["checkout", "--end-of-options", branch],
          cwd,
        )
      ) {
        return {
          kind: "refused",
          detail: `could not check out '${branch}' again after syncing ` +
            `'${milestoneBranch}' in the shared clone`,
        };
      }
    }
  }

  const currency = await ensureBranchCurrent({
    branch,
    baseBranch,
    runGit,
    cwd,
    rebase: mergeOntoBase,
    log,
  });
  return {
    kind: "ok",
    ...(milestone !== undefined ? { milestone } : {}),
    currency,
  };
}
