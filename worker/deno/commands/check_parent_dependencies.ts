/**
 * Check parent dependencies command (Issue #484).
 *
 * This command checks whether an issue is a parent with open child issues
 * that must be completed first. It uses the GitHub CLI to fetch issue data
 * and the issue_dependencies module for the dependency resolution logic.
 *
 * Usage from shell (via the Deno CLI (`deno run mod.ts <command>`)):
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
import { fetchNativeSubIssueNumbers } from "../lib/native_sub_issues.ts";

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
      // Issue #1218: query the native sub-issues endpoint, never the timeline.
      //
      // A `cross-referenced` timeline event is created by *anyone* who mentions
      // the issue — one `#123` in a comment body on a public repo is enough.
      // Treating those numbers as sub-issues handed an unauthenticated
      // commenter the child set, and `checkParentBlocked` deliberately skips
      // the `hasBackReference` confirmation for API-derived children
      // (lib/issue_dependencies.ts:355-361) because it trusts the endpoint to
      // be authoritative. A cross-reference sourced from another repository
      // also yields a number that does not resolve here, and an unresolvable
      // child is counted as open — so a single comment produced a durable
      // "blocked by open sub-issue(s)" verdict on an arbitrary issue.
      //
      // The pickup path already made this move (`lib/issue_finder_common.ts`,
      // Issue #2470); this is the unrepaired copy. The native endpoint returns
      // only genuine sub-issues, which only a user with write access can
      // create, and `[]` when there are none — so the body path keeps running
      // with its back-reference check.
      //
      // Delegated to the shared helper rather than re-spelt here: it already
      // validates the slug, asks for `per_page=100` (the REST default of 30
      // would silently truncate a large parent's child set, and a missing
      // child reads as "not blocked"), and de-duplicates.
      return await fetchNativeSubIssueNumbers(_repo, issueNumber, runGhFn);
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
