/**
 * Issue filtering and sorting logic (Issue #910).
 *
 * Replaces worker/shared/issue_filter.sh with type-safe TypeScript.
 * Handles assignee-based filtering, milestone occupancy checks,
 * label exclusion, reopened issue detection, and author-based filtering.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { runGhCommand } from "./github.ts";
import type { TimelineCache } from "./timeline_cache.ts";
import { invalidateTimelineCache } from "./timeline_cache.ts";
import { fetchTimelineWithCache } from "./issue_query.ts";

/**
 * Minimal issue representation for filtering operations.
 */
export interface FilterableIssue {
  number: number;
  title: string;
  url: string;
  author: string;
  assignees: string[];
  labels: string[];
  createdAt: string;
  milestone: string;
  /** Issue body text — used for milestone tracking issue detection. */
  body?: string;
  /**
   * ISO timestamp of the last issue update. Optional because legacy
   * cached entries may pre-date the field (Issue #1784 — wired so the
   * stale-workflow scan can read from the shared `issues_all` cache).
   */
  updatedAt?: string;
}

/**
 * Label configuration for filtering.
 *
 * Any issue carrying one of these labels is excluded from discovery — see
 * `filterAndSort`. Notable skip reasons:
 * - `needsHumanLabel` ("needs-human"): the worker has handed the issue back
 *   to a human (Issue #1470, #2031). Discovery must not re-pick these
 *   issues, otherwise the worker loops on tasks it cannot progress
 *   autonomously. Issue #2031 retired the separate `needs-clarification`
 *   label and consolidated the handoff signal onto `needs-human`.
 */
export interface FilterLabels {
  failedLabel: string;
  needsRevisionLabel: string;
  refineIssueLabel: string;
  planningLabel: string;
  questionLabel: string;
  /** Label for worker-to-human escalation (Issue #1470, #2031) */
  needsHumanLabel: string;
}

/**
 * Diagnostic information about filtering results.
 */
export interface FilterDiagnostics {
  total: number;
  assignedToOthers: number;
  withFailedLabel: number;
  withNeedsHumanLabel: number;
}

/**
 * HTML comment marker embedded in milestone tracking issue bodies.
 * Used as the primary detection mechanism to prevent the worker from
 * processing tracking issues as regular work items (Issue #1134).
 */
export const MILESTONE_TRACKING_MARKER =
  "<!-- milestone-tracking-issue — do not process as regular work -->";

/**
 * Fallback title pattern for pre-existing milestone tracking issues
 * that were created before the body marker was introduced (Issue #1134).
 */
const MILESTONE_TRACKING_TITLE_PATTERN = /^Merge milestone '.+' to .+$/;

/**
 * Detect whether an issue is a milestone tracking issue.
 *
 * Uses two checks (defence in depth):
 * 1. Primary: body contains the HTML marker comment.
 * 2. Fallback: title matches the tracking issue title pattern
 *    (for pre-existing issues without the marker).
 *
 * @param issue - Issue to check
 * @returns True if the issue is a milestone tracking issue
 */
export function isMilestoneTrackingIssue(issue: FilterableIssue): boolean {
  // Primary check — body marker
  if (issue.body?.includes("<!-- milestone-tracking-issue")) {
    return true;
  }

  // Fallback — title pattern for backfill (pre-existing tracking issues)
  if (MILESTONE_TRACKING_TITLE_PATTERN.test(issue.title)) {
    return true;
  }

  return false;
}

/**
 * Filter issues to exclude those with any assignees.
 *
 * Only keeps unassigned issues. In multi-worker setups where workers
 * share the same GitHub username, an assigned issue means another worker
 * is actively working on it.
 *
 * @param issues - Array of issues to filter
 * @returns Only unassigned issues
 */
export function filterByAssignee(issues: FilterableIssue[]): FilterableIssue[] {
  return issues.filter((issue) => issue.assignees.length === 0);
}

/**
 * Check if a milestone already has an assigned issue.
 *
 * Prevents multiple workers from working on different issues in the same
 * repo/milestone simultaneously.
 *
 * Fleet-aware (Issue #3099): a work stream is "occupied" when an issue in the
 * same milestone/branch is assigned to ANY fleet account — the current worker
 * OR any other fleet login in `allowedAuthors`. In a multi-account fleet
 * (e.g. `VibeCoderBot`, `stsvcbot`) another host's assignment is otherwise
 * invisible, so a second host would not consider the work stream occupied and
 * would start the same issue — the root cause of duplicate PRs (#3095). The
 * underlying issue data already carries every assignee, so widening the match
 * set requires no extra GitHub calls.
 *
 * Human assignments must NOT block any work stream — only fleet logins count
 * as occupying, preserving the original "don't wait on humans" intent.
 *
 * @param allIssues - All open issues in the repo
 * @param milestoneTitle - Milestone to check (empty string for non-milestone)
 * @param workerUser - The current host's GitHub login
 * @param allowedAuthors - The fleet-account set (every fleet login). The
 *   current worker is always counted even if omitted here.
 * @returns True if the milestone has a fleet-assigned issue (occupied)
 */
export function isMilestoneOccupied(
  allIssues: FilterableIssue[],
  milestoneTitle: string,
  workerUser: string,
  allowedAuthors: string[] = [],
): boolean {
  // Case-insensitive fleet set, matching the lowercase convention used by
  // `filterByAllowedAuthors`. The current worker is always included so a
  // misconfigured `allowedAuthors` never drops the host's own assignments.
  const fleetAccounts = new Set(
    [workerUser, ...allowedAuthors].map((a) => a.toLowerCase()),
  );
  return allIssues.some((issue) => {
    if (issue.milestone !== milestoneTitle) return false;
    return issue.assignees.some((a) => fleetAccounts.has(a.toLowerCase()));
  });
}

/**
 * Filter and sort issues by excluding blocking labels.
 *
 * Filters out:
 * - Issues with assignees (in multi-worker setups)
 * - Issues with any blocking label (failed, needs-clarification, etc.)
 *
 * Sorts by createdAt ascending (oldest first).
 *
 * @param issues - Issues to filter
 * @param labels - Label configuration for exclusion
 * @returns Filtered and sorted issues
 */
export function filterAndSort(
  issues: FilterableIssue[],
  labels: FilterLabels,
): FilterableIssue[] {
  const blockingLabels = new Set([
    labels.failedLabel,
    labels.needsRevisionLabel,
    labels.refineIssueLabel,
    labels.planningLabel,
    labels.questionLabel,
    // Issue #1470, #2031: needs-human — worker explicitly handed back to a
    // human; never re-pick during discovery. Issue #2031 retired the
    // standalone `needs-clarification` label and folded the clarification
    // handoff onto `needs-human`.
    labels.needsHumanLabel,
  ]);

  return issues
    .filter((issue) => {
      if (issue.assignees.length > 0) return false;
      if (issue.labels.some((l) => blockingLabels.has(l))) return false;
      // Issue #1134: skip milestone tracking issues
      if (isMilestoneTrackingIssue(issue)) return false;
      return true;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Filter issues to only include those by allowed authors.
 *
 * @param issues - Issues to filter
 * @param allowedAuthors - Authorised GitHub usernames
 * @returns Issues from allowed authors only
 */
export function filterByAllowedAuthors(
  issues: FilterableIssue[],
  allowedAuthors: string[],
): FilterableIssue[] {
  const authorSet = new Set(allowedAuthors.map((a) => a.toLowerCase()));
  return issues.filter((issue) => authorSet.has(issue.author.toLowerCase()));
}

/**
 * Generate filter diagnostics for logging.
 *
 * @param issues - Issues to diagnose
 * @param failedLabel - Label for permanently failed issues
 * @param needsHumanLabel - Label for issues handed back to a human (Issue #2031)
 * @returns Diagnostic counts
 */
export function getFilterDiagnostics(
  issues: FilterableIssue[],
  failedLabel: string,
  needsHumanLabel: string,
): FilterDiagnostics {
  return {
    total: issues.length,
    assignedToOthers: issues.filter((i) => i.assignees.length > 0).length,
    withFailedLabel:
      issues.filter((i) => i.labels.includes(failedLabel)).length,
    withNeedsHumanLabel:
      issues.filter((i) => i.labels.includes(needsHumanLabel)).length,
  };
}

/**
 * Timeline event from GitHub API.
 */
interface TimelineEvent {
  event: string;
  label?: { name: string };
  created_at: string;
}

/**
 * Check if an issue was reopened after a specific label was applied.
 *
 * @param timeline - Timeline events from GitHub API
 * @param labelName - Label to check
 * @returns True if reopened after the label was applied
 */
export function wasReopenedAfterLabel(
  timeline: TimelineEvent[],
  labelName: string,
): boolean {
  const lastLabeled = timeline
    .filter((e) => e.event === "labeled" && e.label?.name === labelName)
    .map((e) => e.created_at)
    .pop() ?? "";

  const lastReopened = timeline
    .filter((e) => e.event === "reopened")
    .map((e) => e.created_at)
    .pop() ?? "";

  return lastReopened !== "" && lastLabeled !== "" &&
    lastReopened > lastLabeled;
}

/**
 * Find stale blocking labels on a reopened issue.
 *
 * Issue #2031: `needs-clarification` was retired — the stale-label
 * cleanup no longer touches it. Only the failure labels remain in the
 * reopened-issue stale set.
 *
 * @param issueLabels - Current labels on the issue
 * @param timeline - Timeline events from GitHub API
 * @param failedLabel - Label for permanently failed issues
 * @param failedOnceLabel - Label for first-failure issues
 * @returns Array of stale label names that should be removed
 */
export function getStaleLabelsForReopenedIssue(
  issueLabels: string[],
  timeline: TimelineEvent[],
  failedLabel: string,
  failedOnceLabel: string,
): string[] {
  const checkLabels = [failedLabel, failedOnceLabel];
  return checkLabels.filter((label) =>
    issueLabels.includes(label) && wasReopenedAfterLabel(timeline, label)
  );
}

/**
 * Clean stale labels from reopened issues.
 *
 * For each issue with a blocking label, checks the GitHub timeline API
 * to see if the issue was reopened after the label was applied. If so,
 * removes the stale labels.
 *
 * Issue #1785: Routes timeline reads through `TimelineCache` so the
 * cold-call-per-iteration pattern (one `gh api .../timeline` call per
 * blocked issue per iteration) collapses to one read every TTL window.
 * Worker-initiated label removal invalidates the cached entry so the
 * next iteration sees fresh data.
 *
 * Issue #2031: `needs-clarification` retired — only the failure labels
 * are subject to reopened-issue stale cleanup.
 *
 * @param issues - Issues to check
 * @param repo - Repository in "owner/repo" format
 * @param failedLabel - Label for permanently failed issues
 * @param failedOnceLabel - Label for first-failure issues
 * @param ghCommandFn - Optional gh command function for testing
 * @param cache - Optional timeline cache for read-through
 * @returns Updated issues with stale labels removed
 */
export async function cleanStaleLabels(
  issues: FilterableIssue[],
  repo: string,
  failedLabel: string,
  failedOnceLabel: string,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
  cache?: TimelineCache,
): Promise<FilterableIssue[]> {
  const blockingLabels = new Set([failedLabel, failedOnceLabel]);
  const result = [...issues];

  for (let i = 0; i < result.length; i++) {
    const issue = result[i]!;
    const hasBlocking = issue.labels.some((l) => blockingLabels.has(l));
    if (!hasBlocking) continue;

    const timeline = await fetchTimelineWithCache(
      repo,
      issue.number,
      ghCommandFn,
      cache,
    );
    if (timeline === null) continue;

    const staleLabels = getStaleLabelsForReopenedIssue(
      issue.labels,
      timeline as TimelineEvent[],
      failedLabel,
      failedOnceLabel,
    );

    let mutated = false;
    for (const label of staleLabels) {
      try {
        await ghCommandFn([
          "issue",
          "edit",
          String(issue.number),
          "--repo",
          repo,
          "--remove-label",
          label,
        ]);
        mutated = true;
      } catch {
        // Non-fatal — continue
      }
    }

    // Worker-initiated label change must invalidate the cached
    // timeline so the next read sees the fresh state.
    if (mutated) {
      await invalidateTimelineCache(repo, issue.number, cache);
    }

    if (staleLabels.length > 0) {
      const staleSet = new Set(staleLabels);
      result[i] = {
        ...issue,
        labels: issue.labels.filter((l) => !staleSet.has(l)),
      };
    }
  }

  return result;
}
