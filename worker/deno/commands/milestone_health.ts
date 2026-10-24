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
  milestoneHealthFailedRepos,
  type MilestoneHealthReport,
} from "../lib/milestone_health.ts";

/**
 * Build the command outcome for a report (Issue #4106).
 *
 * A repo whose milestones or issue lists could not be read makes the whole
 * command fail, so an unreadable repo is never mistaken for a healthy one. The
 * formatted report stays in `message` so the operator can see which repo failed
 * and why.
 */
export function buildMilestoneHealthCommandResult(
  report: MilestoneHealthReport,
): CommandResult<MilestoneHealthReport> {
  const formatted = formatMilestoneHealthReport(report);
  const failed = milestoneHealthFailedRepos(report);
  if (failed.length > 0) {
    return {
      success: false,
      message: `${failed.length} repo(s) failed milestone health: ${
        failed.join(", ")
      }\n\n${formatted}`,
      data: report,
    };
  }
  return {
    success: true,
    message: formatted,
    data: report,
  };
}

/** Test seams for `execute`; production passes nothing (Issue #4106). */
export interface MilestoneHealthCommandDeps {
  ghCommandFn?: (args: string[]) => Promise<string>;
  defaultBranchCachePath?: string;
}

export async function runMilestoneHealth(
  config: WorkerConfig,
  deps: MilestoneHealthCommandDeps = {},
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
    ghCommandFn: deps.ghCommandFn ?? runGhCommand,
    defaultBranchCachePath: deps.defaultBranchCachePath,
  });

  if (!result.ok) {
    return { success: false, message: result.error.message };
  }

  return buildMilestoneHealthCommandResult(result.value);
}

export const milestoneHealthCommand: Command = {
  name: "milestone-health",
  description:
    "Show milestone health diagnostics for all configured repositories (Issue #1239)",

  async execute(
    _args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<MilestoneHealthReport>> {
    return await runMilestoneHealth(config);
  },
};
