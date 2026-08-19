/**
 * Milestone health diagnostics command.
 *
 * Outputs a summary of all active milestones across configured repositories,
 * showing per-issue status, branch drift, and blocked issue reasons.
 *
 * Issue #1239: Add milestone health diagnostics command.
 *
 * Usage:
 *   deno_run_command milestone-health
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { runGhCommand } from "../lib/github.ts";
import {
  formatMilestoneHealthReport,
  getMilestoneHealth,
  type MilestoneHealthReport,
} from "../lib/milestone_health.ts";

export const milestoneHealthCommand: Command = {
  name: "milestone-health",
  description:
    "Show milestone health diagnostics for all configured repositories (Issue #1239)",

  async execute(
    _args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<MilestoneHealthReport>> {
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      return {
        success: true,
        message: "No repositories configured",
        data: { repos: [] },
      };
    }

    const result = await getMilestoneHealth({
      repos,
      ghCommandFn: runGhCommand,
    });

    if (!result.ok) {
      return { success: false, message: result.error.message };
    }

    const report = result.value;
    const formatted = formatMilestoneHealthReport(report);

    return {
      success: true,
      message: formatted,
      data: report,
    };
  },
};
