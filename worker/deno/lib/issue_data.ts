/**
 * Issue data fetching and extraction (Issue #910).
 *
 * Replaces worker/shared/issue_data.sh with type-safe TypeScript.
 * Consolidates issue data fetching to reduce duplicate GitHub API calls.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { runGhCommand } from "./github.ts";

/**
 * Comment on a GitHub issue.
 */
export interface IssueComment {
  /** Comment author login */
  author: string;
  /** Comment body text */
  body: string;
}

/**
 * Consolidated issue data from a single API call.
 */
export interface IssueData {
  /**
   * Issue author login (Issue #3312).
   *
   * Used to trust-classify the issue body/title exactly as comment authors
   * are classified. Optional so historical constructors remain valid;
   * defaults to an empty string (treated as untrusted).
   */
  author?: string;
  /**
   * Issue title as observed by this fetch (Issue #3878).
   *
   * The pickup-time content-integrity gate hashes the title alongside the
   * body. It used to be handed the title captured at scan time, so a
   * title-only edit made after approval always verified as unchanged. Keep
   * `title` in the `--json` field list below or that hole reopens.
   */
  title: string;
  /** Issue body/description text */
  body: string;
  /** Label names */
  labels: string[];
  /** Comments on the issue */
  comments: IssueComment[];
  /** Issue state (e.g. "OPEN", "CLOSED") */
  state: string;
  /** Milestone title, if assigned (Issue #1300) */
  milestoneTitle: string;
  /** Milestone number (API ID), if assigned (Issue #1322) */
  milestoneNumber?: number;
}

/**
 * Raw JSON shape from
 * `gh issue view --json author,title,body,labels,comments,state,milestone`.
 */
interface GhIssueViewJson {
  author?: { login?: string } | null;
  title?: string;
  body?: string;
  labels?: Array<{ name: string }>;
  comments?: Array<{ author: { login: string }; body: string }>;
  state?: string;
  milestone?: { title: string; number?: number } | null;
}

/**
 * Fetch consolidated issue data in a single API call.
 *
 * Replaces multiple separate gh issue view calls with one request
 * containing body, labels, comments, and state fields.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number to fetch
 * @param ghCommandFn - Optional gh command function for testing
 * @returns Parsed issue data, or empty data on failure
 */
export async function fetchIssueData(
  repo: string,
  issueNumber: number,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<IssueData> {
  const emptyData: IssueData = {
    author: "",
    title: "",
    body: "",
    labels: [],
    comments: [],
    state: "",
    milestoneTitle: "",
    milestoneNumber: undefined,
  };

  if (!repo || !issueNumber) {
    return emptyData;
  }

  try {
    const output = await ghCommandFn([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repo,
      "--json",
      "author,title,body,labels,comments,state,milestone",
    ]);

    return parseIssueDataJson(output);
  } catch (err) {
    console.warn(
      `[issue-data] Failed to fetch issue data for ${repo}#${issueNumber}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return emptyData;
  }
}

/**
 * Parse raw JSON from gh issue view into structured IssueData.
 *
 * @param jsonStr - Raw JSON string
 * @returns Parsed IssueData
 */
export function parseIssueDataJson(jsonStr: string): IssueData {
  const emptyData: IssueData = {
    author: "",
    title: "",
    body: "",
    labels: [],
    comments: [],
    state: "",
    milestoneTitle: "",
    milestoneNumber: undefined,
  };

  if (!jsonStr || jsonStr.trim() === "" || jsonStr.trim() === "{}") {
    return emptyData;
  }

  try {
    const json = JSON.parse(jsonStr) as GhIssueViewJson;
    return {
      author: json.author?.login ?? "",
      title: json.title ?? "",
      body: json.body ?? "",
      labels: (json.labels ?? []).map((l) => l.name),
      comments: (json.comments ?? []).map((c) => ({
        author: c.author.login,
        body: c.body,
      })),
      state: json.state ?? "",
      milestoneTitle: json.milestone?.title ?? "",
      milestoneNumber: json.milestone?.number,
    };
  } catch (err) {
    console.warn(
      `[issue-data] Failed to parse issue data JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return emptyData;
  }
}

/**
 * Format comments in the legacy format used by issue_worker.sh.
 *
 * Formats comments as "[author]: body" separated by "---" dividers.
 *
 * @param comments - Array of issue comments
 * @returns Formatted comment string
 */
export function formatCommentsLegacy(comments: IssueComment[]): string {
  if (comments.length === 0) return "";
  return comments
    .map((c) => `[${c.author}]: ${c.body}`)
    .join("\n\n---\n\n");
}
