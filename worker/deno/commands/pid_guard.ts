/**
 * PID guard command for the Vibe Coder worker.
 *
 * Provides PID file management and process guard functionality callable
 * from shell via the Deno CLI (`deno run mod.ts <command>`). Supports sub-operations:
 *   - check-pid: Check if a PID is running
 *   - check-pid-file: Check PID file and determine if safe to proceed
 *   - terminate-descendants: Terminate descendant processes
 *
 * Migrated from worker/shared/pid_guard.sh (Issue #903).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  checkPidFile,
  isRunning,
  type PidGuardResult,
  terminateDescendants,
  type TerminationResult,
} from "../lib/pid_guard.ts";

/** Combined result type for the pid-guard command. */
type PidGuardData = PidGuardResult | TerminationResult | { running: boolean };

/**
 * PID guard command implementation.
 *
 * Args:
 *   --operation <string>   Operation: check-pid, check-pid-file, terminate-descendants
 *   --pid <number>         PID to check or whose descendants to terminate
 *   --pid-file <string>    Path to PID file (for check-pid-file)
 *   --max-wait <number>    Max wait seconds before SIGKILL (default: 5)
 */
export const pidGuardCommand: Command = {
  name: "pid-guard",
  description: "PID file management and process guard",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<PidGuardData>> {
    const operation = String(args["operation"] ?? "check-pid-file");

    switch (operation) {
      case "check-pid": {
        const pid = typeof args["pid"] === "number"
          ? args["pid"]
          : parseInt(String(args["pid"] ?? "0"), 10);

        if (isNaN(pid) || pid <= 0) {
          return {
            success: false,
            message: "Invalid PID: must be a positive integer",
          };
        }

        const running = await isRunning(pid);
        return {
          success: true,
          message: running ? "RUNNING" : "NOT_RUNNING",
          data: { running },
        };
      }

      case "check-pid-file": {
        const pidFile = String(args["pid-file"] ?? "");
        if (!pidFile) {
          return {
            success: false,
            message: "No PID file path specified",
          };
        }

        const result = await checkPidFile(pidFile);
        return {
          success: true,
          message: result.canProceed ? "CAN_PROCEED" : "BLOCKED",
          data: result,
        };
      }

      case "terminate-descendants": {
        const pid = typeof args["pid"] === "number"
          ? args["pid"]
          : parseInt(String(args["pid"] ?? "0"), 10);

        if (isNaN(pid) || pid <= 0) {
          return {
            success: false,
            message: "Invalid PID: must be a positive integer",
          };
        }

        const maxWait = typeof args["max-wait"] === "number"
          ? args["max-wait"]
          : 5;

        const result = await terminateDescendants(pid, maxWait);
        return {
          success: true,
          message: result.message,
          data: result,
        };
      }

      default:
        return {
          success: false,
          message: `Unknown pid-guard operation: ${operation}`,
        };
    }
  },
};
