/**
 * Cleanup stale temp files command for the Vibe Coder worker.
 *
 * Removes stale temporary files and directories older than a configurable
 * age, callable from shell via deno_bridge.sh.
 *
 * Migrated from worker/shared/temp_utils.sh (Issue #901).
 * Issue #337: Periodic stale temp file cleanup.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type CleanupStaleTempData,
  cleanupStaleTempFiles,
} from "../lib/temp_utils.ts";

/**
 * Cleanup stale temp files command implementation.
 *
 * Args:
 *   --directory <string>       Directory to scan (required)
 *   --max-age-minutes <number> Maximum age in minutes (default: 1440 = 24 hours)
 */
export const cleanupStaleTempFilesCommand: Command = {
  name: "cleanup-stale-temp-files",
  description:
    "Remove stale temp files older than a configurable age (Issue #337)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<CleanupStaleTempData>> {
    const directory = args["directory"];
    if (typeof directory !== "string" || directory.length === 0) {
      return {
        success: false,
        message: "cleanup-stale-temp-files: --directory is required",
      };
    }

    let maxAgeMinutes: number | undefined;
    const maxAgeArg = args["max-age-minutes"];
    if (typeof maxAgeArg === "number") {
      maxAgeMinutes = maxAgeArg;
    } else if (typeof maxAgeArg === "string") {
      maxAgeMinutes = parseInt(maxAgeArg, 10);
      if (isNaN(maxAgeMinutes)) {
        return {
          success: false,
          message:
            `cleanup-stale-temp-files: invalid --max-age-minutes "${maxAgeArg}"`,
        };
      }
    }

    const result = await cleanupStaleTempFiles({
      directory,
      maxAgeMinutes,
    });

    if (!result.ok) {
      return { success: false, message: result.error.message };
    }

    const { removedCount, maxAgeMinutes: age } = result.value;
    const message = removedCount > 0
      ? `Cleaned up ${removedCount} stale temp file(s) older than ${age} minutes in ${directory}`
      : `No stale temp files found in ${directory}`;

    return {
      success: true,
      message,
      data: result.value,
    };
  },
};
