/**
 * GitHub user status command for the Vibe Coder worker.
 *
 * Provides GitHub profile status management callable from shell via the Deno
 * CLI (`deno run mod.ts <command>`). Supports sub-operations:
 *   - set-status: Update the GitHub user status
 *   - clear-status: Clear the GitHub user status
 *   - check-available: Check if status updates are enabled and available
 *
 * Migrated from worker/shared/github_status.sh (Issue #905, Issue #409).
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  checkGhStatusAvailable,
  clearGhUserStatus,
  setGhUserStatus,
  type StatusUpdateResult,
} from "../lib/github_status.ts";

/** Combined result type for the github-status command. */
type GitHubStatusData = StatusUpdateResult | { available: boolean };

/**
 * GitHub status command implementation.
 *
 * Args:
 *   --operation <string>   Operation: set-status, clear-status, check-available
 *   --state <string>       Status state: working, idle, success, failure
 *   --repo <string>        Repository (e.g., "owner/repo")
 *   --number <string>      Issue/PR number
 *   --title <string>       Issue/PR title
 */
export const githubStatusCommand: Command = {
  name: "github-status",
  description: "GitHub user status management",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<GitHubStatusData>> {
    const operation = String(args["operation"] ?? "set-status");
    const updateGhUserStatus = Deno.env.get("UPDATE_GH_USER_STATUS") === "true";

    switch (operation) {
      case "set-status": {
        const state = String(args["state"] ?? "idle");
        const repo = args["repo"] ? String(args["repo"]) : undefined;
        const number = args["number"] ? String(args["number"]) : undefined;
        const title = args["title"] ? String(args["title"]) : undefined;

        const result = await setGhUserStatus(state, {
          updateGhUserStatus,
          repo,
          number,
          title,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        return {
          success: true,
          message: result.value.message,
          data: result.value,
        };
      }

      case "clear-status": {
        const result = await clearGhUserStatus(updateGhUserStatus);

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        return {
          success: true,
          message: result.value.message,
          data: result.value,
        };
      }

      case "check-available": {
        const available = await checkGhStatusAvailable(updateGhUserStatus);
        return {
          success: true,
          message: available ? "AVAILABLE" : "NOT_AVAILABLE",
          data: { available },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown github-status operation: ${operation}`,
        };
    }
  },
};
