/**
 * Orphaned worktree cleanup command (Issue #1492).
 *
 * Invoked from `worker/run_core.sh` during the startup self-healing
 * phase. Iterates repositories under `--work-dir`, prunes stale git
 * worktree admin files, and removes orphaned worktree directories whose
 * branch no longer exists and which were last modified more than
 * `--max-age-hours` hours ago (default: 24).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  cleanupOrphanedWorktrees,
  DEFAULT_MAX_AGE_HOURS,
  type WorktreeCleanupResult,
} from "../lib/worktree_cleanup.ts";

export const worktreeCleanupCommand: Command = {
  name: "worktree-cleanup",
  description: "Prune orphaned git worktrees across WORK_DIR (Issue #1492)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<WorktreeCleanupResult>> {
    const workDir =
      typeof args["work-dir"] === "string" && args["work-dir"].length > 0
        ? args["work-dir"]
        : (config.workDir || Deno.env.get("WORK_DIR") || "");

    if (!workDir) {
      return {
        success: false,
        message:
          "worktree-cleanup: --work-dir is required (no config.workDir or WORK_DIR env var)",
      };
    }

    let maxAgeHours: number = DEFAULT_MAX_AGE_HOURS;
    const ageArg = args["max-age-hours"];
    if (typeof ageArg === "number") {
      maxAgeHours = ageArg;
    } else if (typeof ageArg === "string") {
      const parsed = parseInt(ageArg, 10);
      if (isNaN(parsed)) {
        return {
          success: false,
          message: `worktree-cleanup: invalid --max-age-hours "${ageArg}"`,
        };
      }
      maxAgeHours = parsed;
    }

    const result = await cleanupOrphanedWorktrees({ workDir, maxAgeHours });

    const removed = result.removedDirs.length;
    const message = removed === 0 && result.pruned === 0
      ? `Scanned ${result.reposScanned} repo(s) in ${workDir}; no orphaned worktrees found`
      : `Scanned ${result.reposScanned} repo(s) in ${workDir}; pruned ${result.pruned} admin entr(y/ies), removed ${removed} orphaned worktree(s)`;

    return {
      success: true,
      message,
      data: result,
    };
  },
};
