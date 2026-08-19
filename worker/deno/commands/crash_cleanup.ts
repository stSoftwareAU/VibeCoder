/**
 * Crash cleanup command for the Vibe Coder worker.
 *
 * Clears in-progress issue state (heartbeat file and GitHub assignment)
 * when the worker exits unexpectedly.
 * Callable from shell via deno_bridge.sh.
 *
 * Sub-operations (--operation):
 *   - cleanup: Clean up in-progress issue (clear heartbeat, unassign)
 *   - clear-heartbeat: Clear heartbeat file only
 *
 * Migrated from worker/shared/crash_cleanup.sh (Issue #909).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  cleanupInProgressIssue,
  clearHeartbeat,
} from "../lib/crash_cleanup.ts";

export const crashCleanupCommand: Command = {
  name: "crash-cleanup",
  description: "Clean up in-progress issue state on unexpected exit",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "cleanup");

    switch (operation) {
      case "cleanup": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const githubUser = String(args["github-user"] ?? "");
        const workDir = String(args["work-dir"] ?? "");

        const result = await cleanupInProgressIssue({
          repo,
          issueNumber,
          githubUser,
          workDir,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        const { heartbeatCleared, unassigned } = result.value;
        return {
          success: true,
          message: heartbeatCleared || unassigned ? "CLEANED" : "NOOP",
          data: { heartbeatCleared, unassigned },
        };
      }

      case "clear-heartbeat": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        const workDir = String(args["work-dir"] ?? "");

        if (!repo || !issueNumber || !workDir) {
          return { success: false, message: "Missing required arguments" };
        }

        const result = await clearHeartbeat(workDir, repo, issueNumber);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        return { success: true, message: "OK" };
      }

      default:
        return {
          success: false,
          message: `Unknown crash-cleanup operation: ${operation}`,
        };
    }
  },
};

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}
