/**
 * Milestone completion detection command.
 *
 * Scans configured repositories for milestones where all issues are closed,
 * then creates tracking issues and summary PRs to merge milestone branches
 * into the default branch.
 *
 * Issue #1106: Deno replacement for deleted worker/shared/milestone_completion.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { runGhCommand } from "../lib/github.ts";
import { checkAndHandleMilestoneCompletions } from "../lib/milestone_completion.ts";
import { getRepoConfig } from "../lib/repo_config.ts";

export const milestoneCompletionCommand: Command = {
  name: "check-milestone-completions",
  description:
    "Detect completed milestones and create summary PRs (Issue #425, #1106)",

  async execute(
    _args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      return {
        success: true,
        message: "No repositories configured",
        data: { summaryPrsCreated: 0 },
      };
    }

    const logs: string[] = [];
    const result = await checkAndHandleMilestoneCompletions({
      repos,
      ghCommandFn: runGhCommand,
      // Issue #3528: re-check the live `gh` login against the service-account
      // allowlist before any milestone write.
      serviceAccounts: config.serviceAccounts ?? [],
      // Issue #2458: the summary PR is armed at creation, so it honours the
      // same `skip_auto_merge` setting the Auto-Merge sweep honours.
      skipAutoMerge: (repo: string) =>
        getRepoConfig(config.repoConfig, repo, "skipAutoMerge") === "true",
      log: (msg: string) => logs.push(msg),
    });

    if (!result.ok) {
      return { success: false, message: result.error.message };
    }

    const { summaryPrsCreated } = result.value;
    return {
      success: true,
      message: summaryPrsCreated > 0
        ? `Created ${summaryPrsCreated} milestone summary PR(s)`
        : "No milestones require action",
      data: { summaryPrsCreated, logs },
    };
  },
};
