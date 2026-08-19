/**
 * fetch-issue-data command (Issue #910).
 *
 * Replaces fetch_issue_data(), extract_issue_body(), extract_issue_labels(),
 * extract_issue_comments(), and extract_issue_state() from issue_data.sh.
 *
 * Fetches consolidated issue data in a single API call and returns
 * structured output for shell consumption.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult } from "../types.ts";
import { fetchIssueData, formatCommentsLegacy } from "../lib/issue_data.ts";
import type { IssueData } from "../lib/issue_data.ts";

/**
 * Result data for the fetch-issue-data command.
 */
interface FetchIssueDataResult {
  body: string;
  labels: string;
  comments: string;
  state: string;
}

export const fetchIssueDataCommand: Command = {
  name: "fetch-issue-data",
  description: "Fetch consolidated issue data (body, labels, comments, state)",

  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<FetchIssueDataResult>> {
    const repo = args["repo"] as string | undefined;
    const issueNumber = args["issue"] as number | undefined;

    if (!repo) {
      return {
        success: false,
        message: "Required argument 'repo' is missing",
      };
    }

    if (issueNumber === undefined || issueNumber === null) {
      return {
        success: false,
        message: "Required argument 'issue' is missing",
      };
    }

    const data: IssueData = await fetchIssueData(repo, Number(issueNumber));

    if (!data.body && !data.state && data.labels.length === 0) {
      return {
        success: false,
        message: "Failed to fetch issue data",
      };
    }

    const result: FetchIssueDataResult = {
      body: data.body,
      labels: data.labels.join(", "),
      comments: formatCommentsLegacy(data.comments),
      state: data.state,
    };

    // Output as JSON for shell parsing
    return {
      success: true,
      message: JSON.stringify(result),
      data: result,
    };
  },
};
