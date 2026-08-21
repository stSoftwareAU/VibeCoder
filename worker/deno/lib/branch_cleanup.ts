/**
 * Stale branch cleanup after PR merge (Issue #468, #912).
 *
 * Provides three cleanup mechanisms:
 * 1. cleanupMergedPrBranches — Delete branches for merged PRs (runs each loop)
 * 2. cleanupOrphanedLocalBranches — Remove local branches with gone remotes (startup)
 * 3. cleanupStaleRemoteBranches — Delete remote branches for merged/closed PRs (once per session)
 *
 * Every remote deletion goes through `assessRemoteBranchDeletion`
 * (Issue #3931), which refuses protected branches, branches an open PR uses as
 * head (Issue #386) or base, and any branch whose state could not be read.
 *
 * Migrated from worker/shared/branch_cleanup.sh.
 *
 * Uses Australian English throughout (colour, behaviour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { buildBranchDeleteArgs } from "./git_branch_args.ts";
import { assessRemoteBranchDeletion } from "./remote_branch_delete.ts";
import type { IssueCache } from "./issue_cache.ts";
import { fetchMergedPRsByUser, fetchPRsByBranch } from "./issue_query.ts";
import {
  loadSweepWatermarks,
  saveSweepWatermarks,
} from "./merged_sweep_watermark.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";
import { runGhOrThrow } from "./gh_spawn.ts";

/** Result of a cleanup operation. */
export interface CleanupResult {
  deletedCount: number;
  skippedCount: number;
  /**
   * Branches whose remote ref had already gone (Issue #4255) — skipped by
   * the cheap REST probe before any GraphQL assessment ran. Only the
   * merged-PR sweep populates this.
   */
  skippedMissingCount?: number;
  /**
   * Branches that reached the two-call open-PR safety assessment — the
   * GraphQL spend the #4255 fixes exist to minimise. Only the merged-PR
   * sweep populates this.
   */
  assessedCount?: number;
}

/** Options for gh command injection (testing). */
export interface CleanupOptions {
  /** Injected gh command function (for testing). */
  ghCommandFn?: (args: string[]) => Promise<string>;
  /**
   * Optional issue cache (Issue #1787). When provided, branch-cleanup
   * helpers route their `gh pr list` calls through `fetchAllOpenPRs` /
   * `fetchMergedPRsByUser` so repeated reads in one iteration share a
   * single network round-trip.
   */
  cache?: IssueCache;
  /**
   * Path of the per-repo sweep watermark file (Issue #4255). When set,
   * merged PRs at or below the persisted watermark are skipped entirely
   * and the watermark advances after each sweep. Unset (tests, ad hoc
   * callers): every PR in the window is considered, as before.
   */
  watermarkPath?: string;
}

/** Default gh command runner — routed through the shared chokepoint. */
export async function defaultGhCommand(args: string[]): Promise<string> {
  return await runGhOrThrow(args);
}

/**
 * Check if an open PR exists for a branch (Issue #386).
 *
 * Issue #1796: When `cache` is provided, route through `fetchPRsByBranch`
 * so per-branch checks share an iteration-scoped cache keyed by
 * (branch, state).
 *
 * @param repo - Repository in "owner/repo" format
 * @param branchName - Branch to check
 * @param ghFn - Injected gh command function
 * @param cache - Optional issue cache (Issue #1787)
 * @returns The PR number if an open PR exists, or null
 */
export async function findOpenPrNumber(
  repo: string,
  branchName: string,
  ghFn: (args: string[]) => Promise<string>,
  cache?: IssueCache,
): Promise<string | null> {
  if (cache) {
    const prs = await fetchPRsByBranch(repo, branchName, "open", cache, ghFn);
    return prs.length > 0 && prs[0] ? String(prs[0].number) : null;
  }

  try {
    const output = await ghFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--head",
      branchName,
      "--json",
      "number",
      "--jq",
      ".[0].number",
    ]);
    const prNumber = output.trim();
    return prNumber || null;
  } catch {
    return null;
  }
}

/**
 * Delete feature branches after their PRs are merged (Issue #468).
 *
 * Scans configured repositories for PRs authored by the given user that have been
 * merged. For each merged PR, deletes the head branch both remotely and locally
 * if no open PR exists on that branch.
 *
 * @param repos - List of repositories in "owner/repo" format
 * @param githubUser - The GitHub username whose merged PRs to check
 * @param cleanupOptions - Options with injected dependencies
 * @param gitOptions - Git command options
 * @returns Result with cleanup counts
 */
export async function cleanupMergedPrBranches(
  repos: string[],
  githubUser: string,
  cleanupOptions: CleanupOptions = {},
  gitOptions: GitCommandOptions = {},
): Promise<Result<CleanupResult>> {
  const ghFn = cleanupOptions.ghCommandFn ?? defaultGhCommand;
  let deletedCount = 0;
  let skippedCount = 0;
  let skippedMissingCount = 0;
  let assessedCount = 0;

  if (repos.length === 0) {
    return {
      ok: true,
      value: {
        deletedCount: 0,
        skippedCount: 0,
        skippedMissingCount: 0,
        assessedCount: 0,
      },
    };
  }

  // Sweep watermarks (Issue #4255): PRs at or below a repo's watermark
  // were handled on an earlier cycle and are skipped without any network
  // traffic. The watermark only advances past PRs whose branch was
  // deleted or already gone — an unsafe skip or failed delete holds it
  // back so that branch is reconsidered next cycle.
  const watermarkPath = cleanupOptions.watermarkPath;
  const watermarks = watermarkPath
    ? await loadSweepWatermarks(watermarkPath)
    : {};
  let watermarksDirty = false;

  for (const repo of repos) {
    // List merged PRs authored by this user, extracting head branch names.
    // Issue #1787: route through `fetchMergedPRsByUser` so this scan
    // shares the iteration-scoped `prs_merged_${user}` cache.
    // Highest merged-PR number carrying each candidate branch.
    const candidates = new Map<string, number>();
    let windowMax = 0;
    try {
      const merged = await fetchMergedPRsByUser(
        repo,
        githubUser,
        cleanupOptions.cache,
        30,
        ghFn,
      );
      const mark = watermarks[repo] ?? 0;
      for (const pr of merged) {
        if (pr.number > windowMax) windowMax = pr.number;
        if (pr.number <= mark || !pr.headRefName) continue;
        const prev = candidates.get(pr.headRefName) ?? 0;
        if (pr.number > prev) candidates.set(pr.headRefName, pr.number);
      }
    } catch {
      continue;
    }

    // Lowest PR number whose branch still needs attention next cycle.
    let holdBack = Infinity;
    const mergedDeletedNames: string[] = [];

    for (const [branchName, prNumber] of candidates) {
      // Cheap check first (Issue #4255): almost every branch in the
      // window was deleted the first time it was seen, so probe the ref
      // (one REST call, 404 = already gone) before spending the
      // two-GraphQL-call open-PR assessment on it.
      try {
        await ghFn(["api", `repos/${repo}/git/ref/heads/${branchName}`]);
      } catch {
        skippedMissingCount++;
        continue;
      }

      // Single safety chokepoint (Issue #3931): refuses protected branches
      // (Issue #422, #3913), branches an open PR still uses as its head
      // (Issue #386), branches an open PR is *based* on — deleting one makes
      // GitHub close that PR — and any branch whose state could not be read.
      assessedCount++;
      const assessment = await assessRemoteBranchDeletion(
        repo,
        branchName,
        ghFn,
      );
      if (!assessment.safe) {
        skippedCount++;
        holdBack = Math.min(holdBack, prNumber);
        await emitSelfHealEventAuto({
          module: "branch_cleanup",
          action: "merged_branch_delete",
          reason: `${repo} branch ${branchName} not deleted: ` +
            assessment.reason,
          result: "skipped",
        });
        continue;
      }

      // Delete remote branch via GitHub API (Issue #517)
      let apiDeleted = false;
      try {
        await ghFn([
          "api",
          "-X",
          "DELETE",
          `repos/${repo}/git/refs/heads/${branchName}`,
        ]);
        deletedCount++;
        apiDeleted = true;
      } catch {
        // Log failure but continue
        holdBack = Math.min(holdBack, prNumber);
      }

      // Delete local branch (safe delete — won't delete unmerged)
      await runGitCommand(buildBranchDeleteArgs(branchName), gitOptions);

      // Successes aggregate into one per-repo summary event below
      // (Issue #4306); failures stay per-item — they are the signal.
      if (apiDeleted) {
        mergedDeletedNames.push(branchName);
      } else {
        await emitSelfHealEventAuto({
          module: "branch_cleanup",
          action: "merged_branch_delete",
          reason: `${repo} branch ${branchName} (PR merged)`,
          result: "failed",
        });
      }
    }

    if (mergedDeletedNames.length > 0) {
      await emitSelfHealEventAuto({
        module: "branch_cleanup",
        action: "merged_branch_delete",
        reason: `${repo}: deleted ${mergedDeletedNames.length} merged-PR ` +
          `branch(es): ${summariseBranches(mergedDeletedNames)}`,
        result: "ok",
      });
    }

    if (watermarkPath && windowMax > 0) {
      const advanced = Math.max(
        watermarks[repo] ?? 0,
        Math.min(windowMax, holdBack - 1),
      );
      if (advanced !== (watermarks[repo] ?? 0)) {
        watermarks[repo] = advanced;
        watermarksDirty = true;
      }
    }
  }

  if (watermarkPath && watermarksDirty) {
    try {
      await saveSweepWatermarks(watermarkPath, watermarks);
    } catch {
      // Persistence is an optimisation — never fail the cleanup over it.
    }
  }

  return {
    ok: true,
    value: { deletedCount, skippedCount, skippedMissingCount, assessedCount },
  };
}

/**
 * Remove local branches whose remote tracking branch is gone (Issue #468).
 *
 * After git fetch --prune, scans local branches for those whose upstream remote
 * branch no longer exists.
 *
 * @param defaultBranch - The default branch name — never deleted
 * @param options - Git command options
 * @returns Result with count of deleted branches
 */
/** Compress a branch list for a one-line summary event (Issue #4306). */
function summariseBranches(names: string[]): string {
  const MAX_NAMED = 5;
  const shown = names.slice(0, MAX_NAMED).join(", ");
  return names.length > MAX_NAMED
    ? `${shown}, +${names.length - MAX_NAMED} more`
    : shown;
}

/**
 * A gone-upstream branch whose tip is older than this is force-deleted
 * (Issue #228). Squash merges leave the local branch "unmerged" from git's
 * point of view, so `branch -d` refused it every cycle and the clones
 * accumulated 50+ dead branches. A week with no upstream and no new
 * commits is abandoned work by any measure; younger unmerged branches are
 * left for the next pass in case the remote deletion was a mistake.
 */
export const ORPHANED_BRANCH_FORCE_DELETE_AGE_DAYS = 7;

export async function cleanupOrphanedLocalBranches(
  defaultBranch: string,
  options: GitCommandOptions = {},
  policy: { forceDeleteAgeDays?: number; nowFn?: () => number } = {},
): Promise<Result<CleanupResult>> {
  let deletedCount = 0;
  let skippedCount = 0;
  const forceAgeSeconds = (policy.forceDeleteAgeDays ??
    ORPHANED_BRANCH_FORCE_DELETE_AGE_DAYS) * 86400;
  const now = (policy.nowFn ?? (() => Math.floor(Date.now() / 1000)))();

  // Prune remote tracking references first
  await runGitCommand(["fetch", "--prune"], options);

  // Find local branches whose remote tracking branch is gone
  const branchResult = await runGitCommand(["branch", "-vv"], options);
  if (!branchResult.ok || branchResult.value.code !== 0) {
    return { ok: true, value: { deletedCount: 0, skippedCount: 0 } };
  }

  const lines = branchResult.value.stdout.split("\n");
  const deletedNames: string[] = [];
  for (const line of lines) {
    if (!line || !line.includes(": gone]")) continue;

    // Extract the branch name. `git branch -vv` prefixes the current
    // branch with `*` and a branch checked out in a linked worktree with
    // `+` (Issue #4306) — the old `[* ]` class left the `+` in place, so
    // the "branch" became a literal `+` and a phantom
    // `orphaned_local_delete` event fired every cycle.
    const branchName = line.replace(/^[*+ ]+/, "").split(/\s+/)[0];
    if (!branchName) continue;

    // Never delete the default branch
    if (branchName === defaultBranch) continue;

    // Count and report only real deletions (Issue #4306): the delete can
    // fail — branch checked out in a worktree, or unmerged — and the old
    // unconditional "ok" event both hid the failure and inflated the
    // count.
    const deleteResult = await runGitCommand(
      buildBranchDeleteArgs(branchName),
      options,
    );
    if (deleteResult.ok && deleteResult.value.code === 0) {
      deletedCount++;
      deletedNames.push(branchName);
      continue;
    }
    // `-d` refused — an unmerged tip, which is what a squash-merged branch
    // looks like locally (Issue #228). Force it only once the tip is old
    // enough to be abandoned by any measure.
    const tipResult = await runGitCommand(
      ["log", "-1", "--format=%ct", branchName, "--"],
      options,
    );
    const tipEpoch = tipResult.ok && tipResult.value.code === 0
      ? Number(tipResult.value.stdout.trim())
      : NaN;
    if (!Number.isFinite(tipEpoch) || now - tipEpoch < forceAgeSeconds) {
      skippedCount++;
      continue;
    }
    const forced = await runGitCommand(
      buildBranchDeleteArgs(branchName, true),
      options,
    );
    if (!forced.ok || forced.value.code !== 0) {
      skippedCount++;
      continue;
    }
    deletedCount++;
    deletedNames.push(
      `${branchName} (forced, tip ${
        Math.floor((now - tipEpoch) / 86400)
      }d old)`,
    );
  }

  // One summary event per invocation, not one per branch (Issue #4306):
  // the per-branch form produced ~20k routine journal lines in ten days,
  // drowning the escalations the journal exists to surface.
  if (deletedNames.length > 0) {
    await emitSelfHealEventAuto({
      module: "branch_cleanup",
      action: "orphaned_local_delete",
      reason: `deleted ${deletedNames.length} local branch(es) with gone ` +
        `remotes: ${summariseBranches(deletedNames)}`,
      result: "ok",
    });
  }

  return { ok: true, value: { deletedCount, skippedCount } };
}

/**
 * Delete remote branches for merged/closed PRs (Issue #468).
 *
 * Scans remote branches matching the worker's naming pattern (issue-*) and checks
 * whether the corresponding PR is merged or closed.
 *
 * @param repos - List of repositories in "owner/repo" format
 * @param githubUser - The GitHub username whose branches to check
 * @param cleanupOptions - Options with injected dependencies
 * @returns Result with cleanup counts
 */
export async function cleanupStaleRemoteBranches(
  repos: string[],
  githubUser: string,
  cleanupOptions: CleanupOptions = {},
): Promise<Result<CleanupResult>> {
  const ghFn = cleanupOptions.ghCommandFn ?? defaultGhCommand;
  let deletedCount = 0;
  let skippedCount = 0;

  if (repos.length === 0) {
    return { ok: true, value: { deletedCount: 0, skippedCount: 0 } };
  }

  for (const repo of repos) {
    // List remote branches matching issue-* pattern
    let remoteBranches: string[];
    try {
      const output = await ghFn([
        "api",
        `repos/${repo}/branches`,
        "--paginate",
        "--jq",
        '.[].name | select(startswith("issue-"))',
      ]);
      remoteBranches = output.trim().split("\n").filter((b) =>
        b && !b.startsWith("Warning:")
      );
    } catch {
      continue;
    }

    // Issue #1787: prefetch merged PRs by the worker once per repo so
    // the per-branch lookup below collapses into local list filtering.
    // The original `--head branch` query did not filter by author, but
    // worker-named `issue-*` branches are produced and merged by the
    // worker in normal flow, so the worker-author cache covers the
    // realistic cases. Falls back to the per-branch query when the
    // cache is absent or the branch is missing from the worker's
    // merged-PR list (preserving the old behaviour for human-merged
    // edge cases).
    let mergedByBranch: Map<string, number> | null = null;
    if (cleanupOptions.cache) {
      try {
        const merged = await fetchMergedPRsByUser(
          repo,
          githubUser,
          cleanupOptions.cache,
          50,
          ghFn,
        );
        mergedByBranch = new Map(
          merged.map((pr) => [pr.headRefName, pr.number]),
        );
      } catch {
        mergedByBranch = null;
      }
    }

    const staleDeletedNames: string[] = [];
    for (const branchName of remoteBranches) {
      if (!branchName) continue;

      // Same chokepoint as the merged-PR scan (Issue #3931): an `issue-*`
      // branch can still be the base of a stacked child PR, and deleting it
      // would make GitHub close that PR.
      const assessment = await assessRemoteBranchDeletion(
        repo,
        branchName,
        ghFn,
      );
      if (!assessment.safe) {
        skippedCount++;
        await emitSelfHealEventAuto({
          module: "branch_cleanup",
          action: "stale_remote_delete",
          reason: `${repo} branch ${branchName} not deleted: ` +
            assessment.reason,
          result: "skipped",
        });
        continue;
      }

      // Check if there is a merged PR for this branch
      let mergedPr: string | null = null;
      const cachedNum = mergedByBranch?.get(branchName);
      if (cachedNum !== undefined) {
        mergedPr = String(cachedNum);
      } else if (cleanupOptions.cache) {
        // Issue #1796: per-branch lookup routes through `fetchPRsByBranch`
        // so even the human-merged edge case shares the iteration cache.
        const merged = await fetchPRsByBranch(
          repo,
          branchName,
          "merged",
          cleanupOptions.cache,
          ghFn,
        );
        mergedPr = merged.length > 0 && merged[0]
          ? String(merged[0].number)
          : null;
      } else {
        try {
          const output = await ghFn([
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "merged",
            "--head",
            branchName,
            "--json",
            "number",
            "--jq",
            ".[0].number",
          ]);
          mergedPr = output.trim() || null;
        } catch {
          continue;
        }
      }

      if (mergedPr) {
        let apiDeleted = false;
        try {
          await ghFn([
            "api",
            "-X",
            "DELETE",
            `repos/${repo}/git/refs/heads/${branchName}`,
          ]);
          deletedCount++;
          apiDeleted = true;
        } catch {
          // Log failure but continue
        }
        // Successes aggregate into one per-repo summary (Issue #4306);
        // failures stay per-item.
        if (apiDeleted) {
          staleDeletedNames.push(branchName);
        } else {
          await emitSelfHealEventAuto({
            module: "branch_cleanup",
            action: "stale_remote_delete",
            reason: `${repo} branch ${branchName} (merged PR #${mergedPr})`,
            result: "failed",
          });
        }
      }
    }

    if (staleDeletedNames.length > 0) {
      await emitSelfHealEventAuto({
        module: "branch_cleanup",
        action: "stale_remote_delete",
        reason: `${repo}: deleted ${staleDeletedNames.length} stale remote ` +
          `branch(es): ${summariseBranches(staleDeletedNames)}`,
        result: "ok",
      });
    }
  }

  return { ok: true, value: { deletedCount, skippedCount } };
}
