/**
 * Stuck issue detector command for the Vibe Coder worker.
 *
 * Detects stale heartbeats and recovers stuck issues from crashed workers.
 * Callable from shell via deno_bridge.sh.
 *
 * Sub-operations (--operation):
 *   - record-heartbeat: Write/update heartbeat for an issue
 *   - clear-heartbeat: Remove heartbeat after completion
 *   - is-issue-stuck: Check if heartbeat is stale
 *   - detect-and-recover: Full recovery scan (heartbeats + GitHub)
 *   - detect-closed-pr: Scan for assigned issues with closed PRs
 *
 * Migrated from worker/shared/stuck_issue_detector.sh (Issue #909).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  clearHeartbeat,
  detectAndRecoverStuckIssues,
  detectAssignedWithClosedPr,
  type HeartbeatMarkerOptions,
  isIssueStuck,
  recordHeartbeat,
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "../lib/stuck_issue_detector.ts";
import { getMachineId } from "../lib/machine_id.ts";

async function buildConfig(
  args: Record<string, unknown>,
  config: WorkerConfig,
): Promise<StuckIssueConfig> {
  const repos = args["repos"]
    ? (Array.isArray(args["repos"])
      ? args["repos"].map(String)
      : String(args["repos"]).split(","))
    : config.repos ?? [];
  const workDir = String(args["work-dir"] ?? config.workDir ?? "");
  const machineId = workDir ? await getMachineId(workDir) : undefined;

  return {
    workDir,
    stuckIssueTimeout: toNumber(
      args["stuck-issue-timeout"],
      STUCK_ISSUE_DEFAULTS.stuckIssueTimeout,
    ),
    assignedNoHeartbeatTimeout: toNumber(
      args["assigned-no-heartbeat-timeout"],
      STUCK_ISSUE_DEFAULTS.assignedNoHeartbeatTimeout,
    ),
    staleAssignmentTimeout: toNumber(
      args["stale-assignment-timeout"],
      STUCK_ISSUE_DEFAULTS.staleAssignmentTimeout,
    ),
    repos,
    machineId,
  };
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

export const stuckIssueDetectorCommand: Command = {
  name: "stuck-issue-detector",
  description: "Detect stale heartbeats and recover stuck issues",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "detect-and-recover");
    const stuckConfig = await buildConfig(args, config);
    const repo = String(args["repo"] ?? "");
    const issueNumber = toNumber(args["issue-number"], 0);
    const markerOptions: HeartbeatMarkerOptions | undefined =
      stuckConfig.machineId ? { machineId: stuckConfig.machineId } : undefined;

    switch (operation) {
      case "record-heartbeat": {
        if (!repo || !issueNumber) {
          return {
            success: false,
            message: "Missing --repo or --issue-number",
          };
        }
        const result = await recordHeartbeat(
          stuckConfig.workDir,
          repo,
          issueNumber,
          undefined,
          markerOptions,
        );
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "clear-heartbeat": {
        if (!repo || !issueNumber) {
          return {
            success: false,
            message: "Missing --repo or --issue-number",
          };
        }
        const result = await clearHeartbeat(
          stuckConfig.workDir,
          repo,
          issueNumber,
          markerOptions,
        );
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "is-issue-stuck": {
        if (!repo || !issueNumber) {
          return {
            success: false,
            message: "Missing --repo or --issue-number",
          };
        }
        const stuck = await isIssueStuck(
          stuckConfig.workDir,
          repo,
          issueNumber,
          stuckConfig.stuckIssueTimeout,
        );
        return {
          success: true,
          message: stuck ? "STUCK" : "NOT_STUCK",
          data: { stuck },
        };
      }

      case "detect-and-recover": {
        const githubUser = String(args["github-user"] ?? "");
        if (!githubUser) {
          return { success: false, message: "Missing --github-user" };
        }
        const result = await detectAndRecoverStuckIssues(
          stuckConfig,
          githubUser,
        );
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        const { stuckRecovered, noHeartbeatRecovered, staleRecovered } =
          result.value;
        const total = stuckRecovered + noHeartbeatRecovered + staleRecovered;
        return {
          success: true,
          message: String(total),
          data: result.value,
        };
      }

      case "detect-closed-pr": {
        const githubUser = String(args["github-user"] ?? "");
        if (!githubUser) {
          return { success: false, message: "Missing --github-user" };
        }
        const recovered = await detectAssignedWithClosedPr(
          stuckConfig,
          githubUser,
        );
        return {
          success: true,
          message: String(recovered),
          data: { recovered },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown stuck-issue-detector operation: ${operation}`,
        };
    }
  },
};
