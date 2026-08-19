/**
 * Milestone progress notifications (Issue #1236).
 *
 * When a milestone issue is closed after its PR merges, this module posts
 * a progress comment on the closed issue showing how many issues are
 * complete and which ones remain.
 *
 * This gives users visibility into milestone progress without needing
 * to navigate to GitHub's milestone page.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { IssueCache } from "./issue_cache.ts";
import {
  fetchClosedIssuesByMilestone,
  fetchOpenIssuesByMilestone,
} from "./issue_query.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function signature for running gh CLI commands. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** A milestone issue with number and title. */
export interface MilestoneIssue {
  number: number;
  title: string;
}

/** Progress information for a milestone. */
export interface MilestoneProgressInfo {
  /** The milestone title. */
  milestoneTitle: string;
  /** Number of closed issues in the milestone. */
  closedCount: number;
  /** Total number of issues (closed + open) in the milestone. */
  totalCount: number;
  /** Open issues still remaining in the milestone. */
  remainingIssues: MilestoneIssue[];
}

// ---------------------------------------------------------------------------
// getMilestoneProgress
// ---------------------------------------------------------------------------

/**
 * Query the milestone for closed and open issue counts.
 *
 * Issue #1786: routes through `fetchClosedIssuesByMilestone` and
 * `fetchOpenIssuesByMilestone` so duplicate calls within an iteration
 * resolve from `IssueCache` instead of issuing two `gh issue list`
 * calls per blocked-PR check.
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneTitle - The milestone title
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param cache - Optional IssueCache for read-through (Issue #1786)
 * @returns Result with milestone progress information
 */
export async function getMilestoneProgress(
  repo: string,
  milestoneTitle: string,
  ghCommandFn: GhCommandFn,
  cache?: IssueCache,
): Promise<Result<MilestoneProgressInfo>> {
  try {
    const closedIssues = await fetchClosedIssuesByMilestone(
      repo,
      milestoneTitle,
      cache,
      ghCommandFn,
    );
    const openIssues = await fetchOpenIssuesByMilestone(
      repo,
      milestoneTitle,
      cache,
      ghCommandFn,
    );

    return {
      ok: true,
      value: {
        milestoneTitle,
        closedCount: closedIssues.length,
        totalCount: closedIssues.length + openIssues.length,
        remainingIssues: openIssues,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to query milestone progress for '${milestoneTitle}' in ${repo}: ${message}`,
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// buildMilestoneProgressComment
// ---------------------------------------------------------------------------

/**
 * Build a progress comment body for a milestone issue.
 *
 * @param info - Milestone progress information
 * @returns Markdown comment body
 */
export function buildMilestoneProgressComment(
  info: MilestoneProgressInfo,
): string {
  const { milestoneTitle, closedCount, totalCount, remainingIssues } = info;

  const header = `## Milestone progress: ${milestoneTitle}\n\n` +
    `**${closedCount} of ${totalCount}** issues complete`;

  if (remainingIssues.length === 0) {
    return (
      header +
      ` \u2014 all issues in milestone '${milestoneTitle}' are now complete! ` +
      `A summary PR will be created shortly.`
    );
  }

  const remaining = remainingIssues
    .map((issue) => `- #${issue.number}: ${issue.title}`)
    .join("\n");

  return (
    header +
    `\n\n### Remaining issues\n${remaining}`
  );
}

// ---------------------------------------------------------------------------
// postMilestoneProgressComment
// ---------------------------------------------------------------------------

/**
 * Post a milestone progress comment on a just-closed issue.
 *
 * Queries the milestone for progress, builds a comment, and posts it
 * on the specified issue. Failures are logged but do not propagate
 * \u2014 progress comments are best-effort.
 *
 * @param repo - Repository in "owner/repo" format
 * @param issueNumber - The issue number to comment on
 * @param milestoneTitle - The milestone title
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param log - Logging function
 * @returns Result with true if comment was posted, false otherwise
 */
export async function postMilestoneProgressComment(
  repo: string,
  issueNumber: number,
  milestoneTitle: string,
  ghCommandFn: GhCommandFn,
  log: (message: string) => void,
): Promise<Result<boolean>> {
  const progressResult = await getMilestoneProgress(
    repo,
    milestoneTitle,
    ghCommandFn,
  );

  if (!progressResult.ok) {
    log(
      `WARNING: Could not query milestone progress for '${milestoneTitle}' in ${repo}: ${progressResult.error.message}`,
    );
    return { ok: true, value: false };
  }

  const info = progressResult.value;
  log(
    `Milestone '${milestoneTitle}' progress: ${info.closedCount} of ${info.totalCount} issues complete (Issue #1236)`,
  );

  const commentBody = buildMilestoneProgressComment(info);

  try {
    await ghCommandFn([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      commentBody,
    ]);
    log(
      `Posted milestone progress comment on #${issueNumber} in ${repo}`,
    );
    return { ok: true, value: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `WARNING: Failed to post milestone progress comment on #${issueNumber} in ${repo}: ${message}`,
    );
    return { ok: true, value: false };
  }
}
