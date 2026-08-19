/**
 * find-issues-by-label command (Issue #910).
 *
 * Replaces find_refinement_issues(), find_planning_issues(), and
 * find_question_issues() from issue_finder.sh.
 *
 * Output: one line per eligible issue "repo|number|url|milestoneTitle|title"
 * Exit code: 0 if found, 1 if not
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  findIssuesByLabel,
  findPlanningIssuesWithFallback,
} from "../lib/issue_finder.ts";
import { IssueCache } from "../lib/issue_cache.ts";

/**
 * Result data for the find-issues-by-label command.
 */
interface FindIssuesByLabelData {
  count: number;
  label: string;
}

export const findIssuesByLabelCommand: Command = {
  name: "find-issues-by-label",
  description:
    "Find issues with a specific label across configured repositories",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<FindIssuesByLabelData>> {
    const label = args["label"] as string | undefined;
    const githubUser = args["github-user"] as string | undefined;
    const filterFailed = args["filter-failed"] === true ||
      args["filter-failed"] === "true";
    const withCommentFallback = args["with-comment-fallback"] === true ||
      args["with-comment-fallback"] === "true";

    if (!label) {
      return {
        success: false,
        message: "Required argument 'label' is missing",
      };
    }

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

    // Issue #977: Use comment-based fallback for planning issues
    const result = withCommentFallback
      ? await findPlanningIssuesWithFallback(config, { githubUser, cache })
      : await findIssuesByLabel(config, label, filterFailed, {
        githubUser,
        cache,
      });

    if (!result.found) {
      return {
        success: false,
        message: "",
      };
    }

    const count = result.output.split("\n").filter((l) => l !== "").length;

    return {
      success: true,
      message: result.output,
      data: { count, label },
    };
  },
};
