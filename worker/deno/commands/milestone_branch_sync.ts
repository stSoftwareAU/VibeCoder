/**
 * Milestone branch sync command (Issue #1238).
 *
 * Periodically merges the default branch into active milestone branches
 * to reduce drift and avoid merge conflicts on the final summary PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { runGhCommand } from "../lib/github.ts";
import {
  type MilestoneBranchSyncDeps,
  syncMilestoneBranches,
} from "../lib/milestone_branch_sync.ts";
import { selfHealMilestoneBranches } from "../lib/milestone_branch_self_heal.ts";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import { ensureMilestoneBranchExists } from "../lib/git_branch.ts";
import { ensureDefaultBranchCurrent } from "../lib/git_push.ts";
import { getRepoDefaultBranch } from "../lib/shell_helpers.ts";

export const milestoneBranchSyncCommand: Command = {
  name: "sync-milestone-branches",
  description:
    "Sync active milestone branches with the default branch (Issue #1238)",

  async execute(
    _args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      return {
        success: true,
        message: "No repositories configured",
        data: { synced: 0, skipped: 0, failed: 0 },
      };
    }

    if (!config.syncMilestoneBranches) {
      return {
        success: true,
        message: "Milestone branch sync disabled via configuration",
        data: { synced: 0, skipped: 0, failed: 0 },
      };
    }

    const logs: string[] = [];
    const workDir = config.workDir || Deno.env.get("HOME") || ".";
    // Issue #1519: skip repos that have not been cloned locally — the
    // sync is a local-git operation and running git against a missing
    // working directory is reported as a sync failure otherwise.
    const localCloneExistsFn = async (repo: string): Promise<boolean> => {
      const path = `${workDir}/${repo.split("/")[1]}/.git`;
      try {
        const info = await Deno.stat(path);
        return info.isDirectory || info.isFile;
      } catch {
        return false;
      }
    };

    // Issue #3912: repair first — a milestone that gained open children after
    // its branch was merged and deleted has no branch left to sync.
    const selfHeal = await selfHealMilestoneBranches({
      repos,
      ghCommandFn: runGhCommand,
      defaultBranchFn: getRepoDefaultBranch,
      ensureBranchFn: async (repo, milestoneBranch, defaultBranch) =>
        await ensureMilestoneBranchExists(
          milestoneBranch,
          defaultBranch,
          { cwd: `${workDir}/${repo.split("/")[1]}` },
          ensureDefaultBranchCurrent,
        ),
      localCloneExistsFn,
      log: (msg: string) => logs.push(msg),
    });

    const deps: MilestoneBranchSyncDeps = {
      repos,
      ghCommandFn: runGhCommand,
      syncBranchFn: async (repo, milestoneBranch, defaultBranch) => {
        // Use the existing git_pull.ts sync function
        return await syncMilestoneBranchWithDefault(
          milestoneBranch,
          defaultBranch,
          { cwd: `${workDir}/${repo.split("/")[1]}` },
        );
      },
      localCloneExistsFn,
      log: (msg: string) => logs.push(msg),
      cooldownSeconds: config.milestoneSyncCooldownSeconds ?? 3600,
      lastSyncTimes: new Map(),
    };

    const result = await syncMilestoneBranches(deps);

    if (!result.ok) {
      return { success: false, message: result.error.message };
    }

    const { synced, skipped, failed } = result.value;
    const healed = selfHeal.ok
      ? selfHeal.value
      : { branchesRecreated: 0, prsRetargeted: 0, failures: 0 };
    return {
      success: true,
      message: synced > 0
        ? `Synced ${synced} milestone branch(es), ${skipped} skipped, ${failed} failed`
        : "No milestone branches required syncing",
      data: { synced, skipped, failed, selfHeal: healed, logs },
    };
  },
};
