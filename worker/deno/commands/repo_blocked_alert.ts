/**
 * Repo blocked alert command for the Vibe Coder worker.
 *
 * Tracks and alerts when open PRs block all issues in a repository.
 * Callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Sub-operations (--operation):
 *   - record-blocked: Record that a repo's issues are all blocked
 *   - clear-blocked: Clear blocking state for a repo
 *   - check-alert: Check if alert threshold is reached and post alert
 *
 * Migrated from worker/shared/repo_blocked_alert.sh (Issue #909).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  checkRepoBlockedAlert,
  clearRepoBlocked,
  DEFAULT_REPO_BLOCKED_ALERT_HOURS,
  recordRepoBlocked,
  type RepoBlockedAlertConfig,
} from "../lib/repo_blocked_alert.ts";

function buildConfig(
  args: Record<string, unknown>,
  config: WorkerConfig,
): RepoBlockedAlertConfig {
  return {
    workDir: String(args["work-dir"] ?? config.workDir ?? "."),
    alertHours: toNumber(args["alert-hours"], DEFAULT_REPO_BLOCKED_ALERT_HOURS),
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

export const repoBlockedAlertCommand: Command = {
  name: "repo-blocked-alert",
  description: "Alert when open PRs block all issues in a repository",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "check-alert");
    const alertConfig = buildConfig(args, config);
    const repo = String(args["repo"] ?? "");

    switch (operation) {
      case "record-blocked": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const issueCount = toNumber(args["issue-count"], 0);
        const prsJson = String(args["prs-json"] ?? "[]");

        const result = await recordRepoBlocked(
          alertConfig,
          repo,
          issueCount,
          prsJson,
        );
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "clear-blocked": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const result = await clearRepoBlocked(alertConfig, repo);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "check-alert": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const issueCount = toNumber(args["issue-count"], 0);
        const prsJson = String(args["prs-json"] ?? "[]");

        const result = await checkRepoBlockedAlert(
          alertConfig,
          repo,
          issueCount,
          prsJson,
        );
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: result.value ? "ALERTED" : "NO_ALERT",
          data: { alerted: result.value },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown repo-blocked-alert operation: ${operation}`,
        };
    }
  },
};
