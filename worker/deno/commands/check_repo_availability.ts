/**
 * Check repo availability command.
 *
 * Determines whether a repository has available work streams by checking
 * milestone-aware assignment status. A repo is only "fully busy" when
 * every work stream (each milestone plus non-milestone) has assigned work.
 *
 * Design principle: A PR targeting the default branch must not block
 * issues in milestones. Milestones are independent work streams.
 *
 * Usage from shell (via deno_bridge.sh):
 *   deno_run_command "check-repo-availability" --repo "owner/repo" --github-user "username"
 *
 * Output:
 *   AVAILABLE: ... or BUSY: ... (shell parses the prefix)
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  checkRepoAvailability,
  formatAvailabilityMessage,
  type RepoAvailabilityResult,
  type RepoIssueInfo,
} from "../lib/repo_availability.ts";
import { validateCheckRepoAvailabilityArgs } from "../lib/command_args.ts";
import { getRepoNice } from "../lib/repo_config.ts";

/**
 * Data returned by the check-repo-availability command.
 */
interface CheckRepoAvailabilityData extends RepoAvailabilityResult {
  repo: string;
  githubUser: string;
  /**
   * Resolved per-repo `nice` rotation tier (Issue #2777). Lower = worked
   * sooner (Unix-`nice` semantics); `0` is the neutral default for a repo
   * with no configured `nice`. Surfaced for operator debugging.
   */
  nice: number;
}

/**
 * Parse gh CLI issue list JSON into RepoIssueInfo[].
 *
 * Expects the output of:
 *   gh issue list --repo <repo> --state open --json number,milestone,assignees
 *
 * @param json - Raw JSON string from gh CLI
 * @returns Parsed issue info array
 */
export function parseGhIssueListForAvailability(
  json: string,
): RepoIssueInfo[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected JSON array from gh issue list");
  }

  return parsed.map((item: Record<string, unknown>) => ({
    number: typeof item.number === "number" ? item.number : 0,
    milestone:
      (item.milestone as Record<string, unknown> | null)?.title as string ?? "",
    assignees: Array.isArray(item.assignees)
      ? (item.assignees as Record<string, unknown>[]).map(
        (a) => (a.login as string) ?? "",
      )
      : [],
  }));
}

/**
 * Assemble the command result (message + data) from already-fetched issues.
 *
 * Pure: no GitHub I/O. Resolves the repo's `nice` rotation tier (Issue #2777)
 * via `getRepoNice`, runs the milestone-aware availability check, and surfaces
 * the resolved `nice` in both the human-readable message (as a ` [nice N]`
 * suffix, after the AVAILABLE:/BUSY: prefix) and the structured `data`.
 *
 * @param issues - Parsed open issues for the repo
 * @param repo - Repository in "owner/repo" format
 * @param githubUser - GitHub username to check assignments against
 * @param repoConfig - Per-repo configuration map from the worker config
 * @returns The success message and structured availability data
 */
export function buildAvailabilityResult(
  issues: RepoIssueInfo[],
  repo: string,
  githubUser: string,
  repoConfig: WorkerConfig["repoConfig"],
): { message: string; data: CheckRepoAvailabilityData } {
  const result = checkRepoAvailability(issues, githubUser);
  const nice = getRepoNice(repoConfig, repo);
  const message = formatAvailabilityMessage(repo, result, nice);
  return {
    message,
    data: { ...result, repo, githubUser, nice },
  };
}

/**
 * The check-repo-availability command implementation.
 *
 * Checks whether a repository has available work streams using
 * milestone-aware assignment analysis.
 */
export const checkRepoAvailabilityCommand: Command = {
  name: "check-repo-availability",
  description:
    "Check if a repo has available work streams (milestone-aware busy check)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<CheckRepoAvailabilityData>> {
    const parsed = validateCheckRepoAvailabilityArgs(args);
    if (!parsed.ok) {
      return {
        success: false,
        message: parsed.error.message,
      };
    }

    const { repo, githubUser } = parsed.value;

    const { runGhCommand } = await import("../lib/github.ts");

    let issuesJson: string;
    try {
      issuesJson = await runGhCommand([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        "number,milestone,assignees",
        "--limit",
        "200",
      ]);
    } catch (error) {
      return {
        success: false,
        message: `Failed to fetch issues from ${repo}: ${
          (error as Error).message
        }`,
      };
    }

    let issues: RepoIssueInfo[];
    try {
      issues = parseGhIssueListForAvailability(issuesJson);
    } catch (error) {
      return {
        success: false,
        message: `Failed to parse issue data from ${repo}: ${
          (error as Error).message
        }`,
      };
    }

    const { message, data } = buildAvailabilityResult(
      issues,
      repo,
      githubUser,
      config.repoConfig,
    );

    return { success: true, message, data };
  },
};
