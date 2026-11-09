/**
 * Branch cleanup command for the Vibe Coder worker (Issue #912).
 *
 * Callable from shell via the Deno CLI (`deno run mod.ts <command>`). Replaces worker/shared/branch_cleanup.sh.
 *
 * Sub-operations (--operation):
 *   - cleanup-merged: Delete branches for merged PRs
 *   - cleanup-orphaned: Remove local branches with gone remotes
 *   - cleanup-stale: Delete remote branches for merged/closed PRs
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  cleanupMergedPrBranches,
  cleanupOrphanedLocalBranches,
  cleanupStaleRemoteBranches,
  defaultGhCommand,
} from "../lib/branch_cleanup.ts";
import {
  assessRemoteBranchDeletion,
  renderDeletionDecision,
} from "../lib/remote_branch_delete.ts";
import { IssueCache } from "../lib/issue_cache.ts";

/**
 * The `cleanup-stale` operation (Issue #468, #4822).
 *
 * Passes the durable on-volume scan cache (Issue #4303) so the worker's merged
 * PRs are read once per repo in one batched query, not one query per remote
 * `issue-*` branch. `ghCommandFn` is a test seam; production passes nothing
 * and the default `gh` runs.
 */
export async function executeCleanupStale(
  args: Record<string, unknown>,
  config: WorkerConfig,
  ghCommandFn?: (args: string[]) => Promise<string>,
): Promise<CommandResult> {
  const githubUser = String(args["github-user"] ?? "");
  if (!githubUser) {
    return {
      success: false,
      message: "Missing required argument: --github-user",
    };
  }

  const repos = config.repos ?? [];
  const result = await cleanupStaleRemoteBranches(repos, githubUser, {
    cache: new IssueCache(
      config.workDir ? `${config.workDir}/.gh-scan-cache` : undefined,
    ),
    ghCommandFn,
  });

  if (!result.ok) {
    return { success: false, message: result.error.message };
  }

  const { deletedCount, skippedCount } = result.value;
  return {
    success: true,
    message: deletedCount > 0 || skippedCount > 0
      ? `Stale remote branch cleanup complete: ${deletedCount} deleted, ${skippedCount} skipped`
      : "No stale remote branches to clean up",
    data: { deletedCount, skippedCount },
  };
}

export const branchCleanupCommand: Command = {
  name: "branch-cleanup",
  description: "Stale branch cleanup after PR merge (Issue #468, #912)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");

    switch (operation) {
      case "cleanup-merged": {
        const githubUser = String(args["github-user"] ?? "");
        if (!githubUser) {
          return {
            success: false,
            message: "Missing required argument: --github-user",
          };
        }

        const repos = config.repos ?? [];
        const result = await cleanupMergedPrBranches(repos, githubUser);

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        const { deletedCount, skippedCount } = result.value;
        return {
          success: true,
          message: deletedCount > 0 || skippedCount > 0
            ? `Merged branch cleanup complete: ${deletedCount} deleted, ${skippedCount} skipped`
            : "No merged branches to clean up",
          data: { deletedCount, skippedCount },
        };
      }

      case "cleanup-orphaned": {
        const defaultBranch = String(args["default-branch"] ?? "");
        if (!defaultBranch) {
          return {
            success: false,
            message: "Missing required argument: --default-branch",
          };
        }

        const cwd = args["cwd"] ? String(args["cwd"]) : undefined;
        const result = await cleanupOrphanedLocalBranches(
          defaultBranch,
          cwd ? { cwd } : {},
        );

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        const { deletedCount, skippedReason } = result.value;
        // Never "no orphaned branches" for a sweep that never ran: on the
        // read-only checkout (Issue #514) the skip is named, so the
        // housekeeping log says why instead of implying a clean pass.
        if (skippedReason) {
          return {
            success: true,
            message: `Orphaned branch cleanup skipped: ${skippedReason}`,
            data: { deletedCount, skippedReason },
          };
        }
        return {
          success: true,
          message: deletedCount > 0
            ? `Orphaned branch cleanup complete: ${deletedCount} deleted`
            : "No orphaned branches to clean up",
          data: { deletedCount },
        };
      }

      case "cleanup-stale":
        return executeCleanupStale(args, config);

      case "check-branch-has-open-pr": {
        const repo = String(args["repo"] ?? "");
        const branchName = String(args["branch-name"] ?? "");
        if (!repo || !branchName) {
          return {
            success: false,
            message: "Missing required arguments: --repo and --branch-name",
          };
        }

        // Issue #3931: the caller may delete only on an exact
        // `SAFE_TO_DELETE`. Every other verdict — including a check that
        // could not be completed — leaves the branch alone.
        const assessment = await assessRemoteBranchDeletion(
          repo,
          branchName,
          defaultGhCommand,
        );
        const decision = renderDeletionDecision(assessment);

        return {
          success: decision.success,
          message: decision.message,
          data: {
            safeToDelete: assessment.safe,
            refusal: assessment.refusal ?? null,
            blockingPr: assessment.blockingPr ?? null,
            reason: assessment.reason,
          },
        };
      }

      default:
        return {
          success: false,
          message:
            `Unknown branch cleanup operation: '${operation}'. Use --operation with one of: cleanup-merged, cleanup-orphaned, cleanup-stale, check-branch-has-open-pr`,
        };
    }
  },
};
