/**
 * Stale work directory cleanup command (Issue #1493).
 *
 * Scans `--work-dir` for stale or partial repository clones and removes
 * them. Invoked from `worker/run_core.sh` during the startup phase so
 * unattended workers reclaim disk without waiting for the disk-pressure
 * cleanup to fire at 90% usage.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  DEFAULT_STALE_WORKDIR_DAYS,
  scanAndCleanupStaleWorkDirs,
  type StaleWorkDirResult,
} from "../lib/stale_workdir.ts";

/**
 * Args:
 *   --work-dir <string>   Directory holding repository clones.
 *                         Defaults to config.workDir or WORK_DIR env var.
 *   --max-age-days <num>  Age threshold in days (default: 7, or
 *                         config.staleWorkDirDays when set).
 */
export const staleWorkDirCommand: Command = {
  name: "stale-workdir",
  description:
    "Detect and remove stale or partial repository work directories (Issue #1493)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<StaleWorkDirResult>> {
    const workDir =
      typeof args["work-dir"] === "string" && args["work-dir"].length > 0
        ? args["work-dir"]
        : (config.workDir || Deno.env.get("WORK_DIR") || "");

    if (!workDir) {
      return {
        success: false,
        message:
          "stale-workdir: --work-dir is required (no config.workDir or WORK_DIR env var)",
      };
    }

    const configDays =
      typeof (config as unknown as { staleWorkDirDays?: number })
          .staleWorkDirDays === "number"
        ? (config as unknown as { staleWorkDirDays: number }).staleWorkDirDays
        : undefined;

    let maxAgeDays: number = configDays ?? DEFAULT_STALE_WORKDIR_DAYS;
    const ageArg = args["max-age-days"];
    if (typeof ageArg === "number") {
      maxAgeDays = ageArg;
    } else if (typeof ageArg === "string") {
      const parsed = parseInt(ageArg, 10);
      if (isNaN(parsed)) {
        return {
          success: false,
          message: `stale-workdir: invalid --max-age-days "${ageArg}"`,
        };
      }
      maxAgeDays = parsed;
    }

    const result = await scanAndCleanupStaleWorkDirs({ workDir, maxAgeDays });

    const removed = result.removedStale.length + result.removedPartial.length;
    const message = removed === 0
      ? `Scanned ${result.scanned} repo(s) in ${workDir}; no stale or partial directories found`
      : `Scanned ${result.scanned} repo(s) in ${workDir}; removed ${result.removedStale.length} stale and ${result.removedPartial.length} partial`;

    return {
      success: true,
      message,
      data: result,
    };
  },
};
