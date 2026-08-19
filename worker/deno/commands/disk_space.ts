/**
 * Disk space command for the Vibe Coder worker.
 *
 * Checks disk space and performs self-healing cleanup when the disk is
 * nearly full. Callable from shell via deno_bridge.sh.
 *
 * Migrated from worker/shared/disk_space.sh (Issue #902).
 * Issue #95: Check disk space of WORK_DIR at startup.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  checkAndCleanupDiskSpace,
  DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD,
  DEFAULT_DISK_CLEANUP_THRESHOLD,
  type DiskCheckResult,
} from "../lib/disk_space.ts";

/**
 * Parse a numeric CLI argument. Returns the fallback when the value is
 * missing or cannot be parsed as a number.
 */
function parseNumericArg(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Disk space command implementation.
 *
 * Args:
 *   --work-dir <string>          Directory to check (defaults to config workDir or WORK_DIR env)
 *   --threshold <number>         Aggressive disk usage threshold (default: 90).
 *                                At or above this, the work directory is nuked
 *                                if incremental reclaim is insufficient.
 *   --gentle-threshold <number>  Gentle disk usage threshold (default: 80).
 *                                At or above this but below `--threshold`, only
 *                                the incremental reclaim pass runs — cloned
 *                                repositories are preserved (Issue #1499).
 */
export const diskSpaceCommand: Command = {
  name: "disk-space",
  description: "Check disk space and clean up work directory if needed",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<DiskCheckResult>> {
    // Resolve work directory: args > config > env > default
    const workDir = typeof args["work-dir"] === "string"
      ? args["work-dir"]
      : (config.workDir || Deno.env.get("WORK_DIR") ||
        `${Deno.env.get("HOME") ?? "/tmp"}/auto-issue-work`);

    const threshold = parseNumericArg(
      args["threshold"],
      DEFAULT_DISK_CLEANUP_THRESHOLD,
    );
    const gentleThreshold = parseNumericArg(
      args["gentle-threshold"],
      DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD,
    );

    const result = await checkAndCleanupDiskSpace({
      workDir,
      threshold,
      gentleThreshold,
    });

    return {
      success: true,
      message: result.message,
      data: result,
    };
  },
};
