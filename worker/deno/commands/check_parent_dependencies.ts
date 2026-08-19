/**
 * Check parent dependencies command (Issue #484).
 *
 * This command checks whether an issue is a parent with open child issues
 * that must be completed first. It uses the GitHub CLI to fetch issue data
 * and the issue_dependencies module for the dependency resolution logic.
 *
 * Usage from shell (via deno_bridge.sh):
 *   deno_run_command "check-parent-deps" --repo "owner/repo" --issue 123
 *
 * Output:
 *   JSON result with blocked status and details.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult } from "../types.ts";
import {
  checkParentBlocked,
  formatParentBlockedMessage,
  type IssueFetcher,
  type IssueState,
  normaliseIssueState,
} from "../lib/issue_dependencies.ts";
import { validateCheckParentDepsArgs } from "../lib/command_args.ts";

/**
 * Data returned by the check-parent-deps command.
 */
interface CheckParentDepsData {
  isBlocked: boolean;
  openChildren: number[];
  closedChildren: number[];
  totalChildren: number;
  message: string;
}

/**
 * Create an IssueFetcher that uses the GitHub CLI (gh).
 *
 * @param runGhFn - Function to run gh commands (injectable for testing)
 * @returns IssueFetcher implementation backed by gh CLI
 */
export function createGhIssueFetcher(
  runGhFn: (args: string[]) => Promise<string>,
): IssueFetcher {
  return {
    async getIssueState(
      _repo: string,
      issueNumber: number,
    ): Promise<IssueState> {
      const output = await runGhFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        _repo,
        "--json",
        "number,state,title",
      ]);
      const parsed = JSON.parse(output);
      return {
        number: parsed.number,
        // Issue #3218: a merged PR reports `MERGED` — resolve it to CLOSED.
        state: normaliseIssueState(parsed.state),
        title: parsed.title,
      };
    },

    async getSubIssues(_repo: string, issueNumber: number): Promise<number[]> {
      // GitHub's sub-issues are available via the GraphQL API or REST timeline
      // We use the REST API to list sub-issues via the timeline events
      try {
        const output = await runGhFn([
          "api",
          `repos/${_repo}/issues/${issueNumber}/timeline`,
          "--paginate",
          "--jq",
          '[.[] | select(.event == "cross-referenced") | .source.issue.number // empty] | unique',
        ]);
        const parsed = JSON.parse(output || "[]");
        if (Array.isArray(parsed)) {
          return parsed.filter((n): n is number => typeof n === "number");
        }
      } catch {
        // Timeline API may not be available; fall back to body parsing
      }
      return [];
    },

    async getIssueBody(_repo: string, issueNumber: number): Promise<string> {
      const output = await runGhFn([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        _repo,
        "--json",
        "body",
      ]);
      const parsed = JSON.parse(output);
      return parsed.body ?? "";
    },
  };
}

/**
 * The check-parent-deps command implementation.
 *
 * Checks if an issue is a parent issue with open children that must
 * be completed before the parent can be worked on.
 */
export const checkParentDepsCommand: Command = {
  name: "check-parent-deps",
  description: "Check if an issue is blocked by open sub-issues (Issue #484)",
  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<CheckParentDepsData>> {
    // Validate args using typed schema (Issue #630)
    const parsed = validateCheckParentDepsArgs(args);
    if (!parsed.ok) {
      return {
        success: false,
        message: parsed.error.message,
      };
    }

    const { repo, issue: issueNumber } = parsed.value;

    // Import dynamically to avoid circular dependency issues
    const { runGhCommand } = await import("../lib/github.ts");

    const fetcher = createGhIssueFetcher(runGhCommand);
    const result = await checkParentBlocked(fetcher, repo, issueNumber);

    if (!result.ok) {
      return {
        success: false,
        message: `Error checking parent dependencies: ${result.error.message}`,
      };
    }

    const message = formatParentBlockedMessage(issueNumber, result.value);

    return {
      success: true,
      message,
      data: {
        isBlocked: result.value.isBlocked,
        openChildren: result.value.openChildren,
        closedChildren: result.value.closedChildren,
        totalChildren: result.value.totalChildren,
        message,
      },
    };
  },
};
