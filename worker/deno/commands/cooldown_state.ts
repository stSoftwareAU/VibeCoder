/**
 * Cooldown state command for the Vibe Coder worker.
 *
 * Manages issue retry cooldowns so the worker skips recently-failed issues
 * and processes other work first. Callable from shell via deno_bridge.sh.
 *
 * Sub-operations:
 *   - record-cooldown: Record that an issue failed (skip for cooldown period)
 *   - is-in-cooldown: Check if an issue is still in cooldown
 *   - clean-expired: Remove expired cooldown entries
 *
 * Migrated from worker/shared/cooldown_state.sh (Issue #908).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  cleanExpiredCooldowns,
  COOLDOWN_DEFAULTS,
  type CooldownConfig,
  isIssueInCooldown,
  recordIssueCooldown,
} from "../lib/cooldown_state.ts";

/** Build config from command args, falling back to defaults. */
function buildConfig(
  args: Record<string, unknown>,
  config: WorkerConfig,
): CooldownConfig {
  return {
    workDir: String(args["work-dir"] ?? config.workDir ?? ""),
    issueRetryCooldown: toNumber(
      args["issue-retry-cooldown"],
      COOLDOWN_DEFAULTS.issueRetryCooldown,
    ),
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

export const cooldownStateCommand: Command = {
  name: "cooldown-state",
  description: "Issue retry cooldown management",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "is-in-cooldown");
    const cdConfig = buildConfig(args, config);

    switch (operation) {
      case "record-cooldown": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        if (!repo || issueNumber <= 0) {
          return {
            success: false,
            message: "Missing --repo and/or --issue-number arguments",
          };
        }
        const result = await recordIssueCooldown(cdConfig, repo, issueNumber);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: "RECORDED",
          data: { entriesCount: result.value.state.entries.length },
        };
      }

      case "is-in-cooldown": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = toNumber(args["issue-number"], 0);
        if (!repo || issueNumber <= 0) {
          return {
            success: false,
            message: "Missing --repo and/or --issue-number arguments",
          };
        }
        const inCooldown = await isIssueInCooldown(cdConfig, repo, issueNumber);
        return {
          success: true,
          message: inCooldown ? "IN_COOLDOWN" : "NOT_IN_COOLDOWN",
          data: { inCooldown },
        };
      }

      case "clean-expired": {
        const result = await cleanExpiredCooldowns(cdConfig);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: String(result.value.entries.length),
          data: { remainingEntries: result.value.entries.length },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown cooldown-state operation: ${operation}`,
        };
    }
  },
};
