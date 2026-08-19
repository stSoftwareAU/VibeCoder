/**
 * Worker log cleanup command.
 *
 * Issue #1902: hybrid age-based retention for `worker-PID.log` files,
 * replacing the count-based policy that destroyed overnight diagnostics
 * during restart storms. Callable from shell via deno_bridge.sh.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  cleanupWorkerLogs,
  type WorkerLogCleanupResult,
} from "../lib/worker_log_cleanup.ts";

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Args:
 *   --log-dir <string>                  Directory containing logs (default: $HOME/logs)
 *   --header-only-max-bytes <number>    Size threshold for stubs (default: 200)
 *   --header-only-min-age-minutes <num> Min age before stub deletion (default: 60)
 *   --max-age-days <number>             Max age before any log is deleted (default: 3)
 *   --hard-cap-count <number>           Hard ceiling on file count (default: 200)
 */
export const workerLogCleanupCommand: Command = {
  name: "worker-log-cleanup",
  description:
    "Apply hybrid age/size retention to worker-PID.log files (Issue #1902)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<WorkerLogCleanupResult>> {
    const logDir = typeof args["log-dir"] === "string"
      ? args["log-dir"]
      : `${Deno.env.get("HOME") ?? "/tmp"}/logs`;

    const result = await cleanupWorkerLogs(logDir, {
      headerOnlyMaxBytes: asNumber(args["header-only-max-bytes"]),
      headerOnlyMinAgeMinutes: asNumber(args["header-only-min-age-minutes"]),
      maxAgeDays: asNumber(args["max-age-days"]),
      hardCapCount: asNumber(args["hard-cap-count"]),
    });

    return { success: true, message: result.message, data: result };
  },
};
