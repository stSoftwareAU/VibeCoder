/**
 * Disk space command for the Vibe Coder worker.
 *
 * Checks disk space and performs self-healing cleanup when the disk is
 * nearly full. Callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Migrated from worker/shared/disk_space.sh (Issue #902).
 * Issue #95: Check disk space of WORK_DIR at startup.
 */

import type { Command, CommandResult, Result, WorkerConfig } from "../types.ts";
import {
  checkAndCleanupDiskSpace,
  DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD,
  DEFAULT_DISK_CLEANUP_THRESHOLD,
  type DiskCheckResult,
  parseCleanupThreshold,
  validateCleanupThreshold,
} from "../lib/disk_space.ts";

/**
 * Resolve a threshold CLI argument against the shared bound
 * ({@link validateCleanupThreshold}, Issue #1268).
 *
 * The refusal is named and loud rather than clamped: a threshold the
 * operator did not mean should stop the destructive cleanup, not quietly
 * become a different one.
 */
function resolveThresholdArg(
  flag: string,
  value: unknown,
  fallback: number,
): Result<number, string> {
  const parsed = parseCleanupThreshold(value, fallback);
  const problem = validateCleanupThreshold(flag, parsed);
  return problem === null
    ? { ok: true, value: parsed }
    : { ok: false, error: problem };
}

/**
 * Disk space command implementation.
 *
 * Args:
 *   --work-dir <string>          Directory to check (defaults to WORK_DIR env;
 *                                with neither, the check reports "no directory
 *                                specified" — deliberately no HOME-derived
 *                                fallback, Issues #118/#135)
 *   --threshold <number>         Aggressive disk usage threshold (default: 90,
 *                                must be 1–100, Issue #1268). At or above this,
 *                                the work directory is nuked if incremental
 *                                reclaim is insufficient.
 *   --gentle-threshold <number>  Gentle disk usage threshold (default: 80,
 *                                must be 1–100). At or above this but below
 *                                `--threshold`, only the incremental reclaim
 *                                pass runs — cloned repositories are preserved
 *                                (Issue #1499).
 *
 * A threshold outside 1–100 fails the command rather than running a cleanup
 * the operator did not ask for.
 */
export const diskSpaceCommand: Command = {
  name: "disk-space",
  description: "Check disk space and clean up work directory if needed",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<DiskCheckResult>> {
    // Resolve work directory: args > env. There is deliberately no
    // HOME-derived default (Issues #118, #135): `checkAndCleanupDiskSpace`
    // ensureDirs the directory it is handed, so the old fallback silently
    // CREATED a stray ~/auto-issue-work on the host whenever this command
    // ran without WORK_DIR. `config.workDir` is no fallback either — the
    // loader hardcodes it to the same HOME-derived string (lib/config.ts),
    // so consulting it here would be the identical bug in disguise. With
    // nothing given, the check reports "no directory specified" instead.
    const workDir = typeof args["work-dir"] === "string"
      ? args["work-dir"]
      : (Deno.env.get("WORK_DIR") || "");

    const threshold = resolveThresholdArg(
      "--threshold",
      args["threshold"],
      DEFAULT_DISK_CLEANUP_THRESHOLD,
    );
    if (!threshold.ok) return { success: false, message: threshold.error };

    const gentleThreshold = resolveThresholdArg(
      "--gentle-threshold",
      args["gentle-threshold"],
      DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD,
    );
    if (!gentleThreshold.ok) {
      return { success: false, message: gentleThreshold.error };
    }

    const result = await checkAndCleanupDiskSpace({
      workDir,
      threshold: threshold.value,
      gentleThreshold: gentleThreshold.value,
    });

    return {
      success: true,
      message: result.message,
      data: result,
    };
  },
};
