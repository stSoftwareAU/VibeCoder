/**
 * Log rotation command for the Vibe Coder worker.
 *
 * Performs size-based rotation on unbounded log files to prevent disk
 * exhaustion on long-running unattended machines. Callable from shell
 * via deno_bridge.sh.
 *
 * Migrated from worker/shared/log_rotation.sh (Issue #902).
 * Issue #469: Size-based log rotation for unbounded log files.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  DEFAULT_LOG_MAX_ROTATIONS,
  DEFAULT_LOG_MAX_SIZE_MB,
  rotateAllLogs,
  type RotateAllResult,
} from "../lib/log_rotation.ts";

/**
 * Log rotation command implementation.
 *
 * Args:
 *   --log-dir <string>       Directory containing log files (default: ~/logs)
 *   --max-size-mb <number>   Maximum size in MB before rotation (default: 10)
 *   --max-rotations <number> Number of rotated copies to keep (default: 3)
 */
export const logRotationCommand: Command = {
  name: "log-rotation",
  description: "Rotate unbounded log files that exceed size threshold",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<RotateAllResult>> {
    const logDir = typeof args["log-dir"] === "string"
      ? args["log-dir"]
      : `${Deno.env.get("HOME") ?? "/tmp"}/logs`;

    const maxSizeMb = typeof args["max-size-mb"] === "number"
      ? args["max-size-mb"]
      : (typeof args["max-size-mb"] === "string"
        ? parseFloat(args["max-size-mb"])
        : DEFAULT_LOG_MAX_SIZE_MB);

    const maxRotations = typeof args["max-rotations"] === "number"
      ? args["max-rotations"]
      : (typeof args["max-rotations"] === "string"
        ? parseInt(args["max-rotations"], 10)
        : DEFAULT_LOG_MAX_ROTATIONS);

    const result = await rotateAllLogs(logDir, { maxSizeMb, maxRotations });

    return {
      success: true,
      message: result.message,
      data: result,
    };
  },
};
