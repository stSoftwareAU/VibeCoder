/**
 * find-issues command (Issue #910).
 *
 * Replaces find_oldest_issue() from issue_finder.sh.
 * Finds the oldest eligible issue across all configured repositories.
 *
 * Output: pipe-delimited string "repo|number|url|milestoneTitle|title"
 * Exit code: 0 if found, 1 if not
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { findOldestIssue } from "../lib/issue_finder.ts";
import { IssueCache } from "../lib/issue_cache.ts";

/**
 * Result data for the find-issues command.
 */
interface FindIssuesData {
  repo: string;
  issueNumber: number;
  url: string;
  milestone: string;
  title: string;
}

export const findIssuesCommand: Command = {
  name: "find-issues",
  description: "Find the oldest eligible issue across configured repositories",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<FindIssuesData>> {
    const githubUser = args["github-user"] as string | undefined;
    if (!githubUser) {
      return {
        success: false,
        message: "Required argument 'github-user' is missing",
      };
    }

    const cacheTtl = Number(
      Deno.env.get("ISSUE_CACHE_TTL") ?? "600",
    );
    const cache = new IssueCache(undefined, cacheTtl);

    const result = await findOldestIssue(config, {
      githubUser,
      cache,
    });

    if (!result.found) {
      return {
        success: false,
        message: "",
      };
    }

    // Parse the pipe-delimited output for data field
    const parts = result.output.split("|");
    const data: FindIssuesData = {
      repo: parts[0] ?? "",
      issueNumber: parseInt(parts[1] ?? "0", 10),
      url: parts[2] ?? "",
      milestone: parts[3] ?? "",
      title: parts.slice(4).join("|"),
    };

    return {
      success: true,
      message: result.output,
      data,
    };
  },
};
