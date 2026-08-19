/**
 * Milestone-aware repo availability check.
 *
 * Determines whether a repository has available work streams by checking
 * which milestones (and non-milestone issues) have assigned work.
 *
 * Design principle: A PR targeting the default branch must not block
 * issues in milestones. Milestones are independent work streams. A repo
 * is only "fully busy" when every work stream has assigned work.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Minimal issue data needed for the availability check.
 */
export interface RepoIssueInfo {
  /** GitHub issue number. */
  number: number;
  /** Milestone title, or "" if the issue has no milestone. */
  milestone: string;
  /** Login names of assigned users. */
  assignees: string[];
}

/**
 * Result of a repo availability check.
 */
export interface RepoAvailabilityResult {
  /** True if at least one work stream has no assigned issue. */
  hasAvailableWork: boolean;
  /** Work streams with no assigned work (milestone titles; "" = non-milestone). */
  availableStreams: string[];
  /** Work streams that are occupied (have an assigned issue for the queried user). */
  occupiedStreams: string[];
  /** Total number of distinct work streams in the repo. */
  totalStreams: number;
}

/**
 * Check whether a repository has available work streams.
 *
 * A work stream is either a specific milestone or the non-milestone stream
 * (issues without a milestone). A repo has available work if at least one
 * work stream contains issues but none are assigned to the queried user.
 *
 * When there are zero issues the repo is considered available (nothing
 * blocking), matching the existing behaviour where `is_repo_busy` returns
 * "not busy" when no issues are assigned.
 *
 * @param allIssues - All open issues in the repo with milestone and assignee data
 * @param githubUser - The GitHub username to check assignments against
 * @returns Availability result with per-stream breakdown
 */
export function checkRepoAvailability(
  allIssues: RepoIssueInfo[],
  githubUser: string,
): RepoAvailabilityResult {
  if (allIssues.length === 0) {
    return {
      hasAvailableWork: true,
      availableStreams: [],
      occupiedStreams: [],
      totalStreams: 0,
    };
  }

  // Group issues by work stream (milestone title; "" for non-milestone)
  const streams = new Map<string, RepoIssueInfo[]>();
  for (const issue of allIssues) {
    const stream = issue.milestone;
    const existing = streams.get(stream);
    if (existing) {
      existing.push(issue);
    } else {
      streams.set(stream, [issue]);
    }
  }

  const lowerUser = githubUser.toLowerCase();
  const availableStreams: string[] = [];
  const occupiedStreams: string[] = [];

  for (const [stream, issues] of streams) {
    // A stream has available work if there are any unassigned issues in it,
    // even if other issues in the same stream are assigned to this worker.
    const hasUnassigned = issues.some((issue) =>
      !issue.assignees.some((a) => a.toLowerCase() === lowerUser)
    );
    if (hasUnassigned) {
      availableStreams.push(stream);
    } else {
      occupiedStreams.push(stream);
    }
  }

  return {
    hasAvailableWork: availableStreams.length > 0,
    availableStreams,
    occupiedStreams,
    totalStreams: streams.size,
  };
}

/**
 * Format a human-readable message for the availability result.
 *
 * Prefixed with AVAILABLE: or BUSY: for shell parsing — the prefix is always
 * the first token so shell consumers can split on it unchanged.
 *
 * When `nice` is supplied it is appended as a ` [nice N]` suffix so an operator
 * can see which rotation tier the repo resolves to (Issue #2777). Lower `nice`
 * is worked sooner (Unix-`nice` semantics). The suffix is added after the
 * stream summary and never touches the leading prefix.
 *
 * @param repo - Repository name for the message
 * @param result - The availability check result
 * @param nice - Optional resolved per-repo `nice` tier to surface for debugging
 * @returns Formatted message string
 */
export function formatAvailabilityMessage(
  repo: string,
  result: RepoAvailabilityResult,
  nice?: number,
): string {
  const niceSuffix = typeof nice === "number" ? ` [nice ${nice}]` : "";

  if (result.totalStreams === 0) {
    return `AVAILABLE: ${repo} has no open issues${niceSuffix}`;
  }

  const streamLabel = (s: string) => s === "" ? "non-milestone" : s;

  if (result.hasAvailableWork) {
    const names = result.availableStreams.map(streamLabel).join(", ");
    return `AVAILABLE: ${repo} has work in ${result.availableStreams.length} stream(s): ${names}${niceSuffix}`;
  }

  const names = result.occupiedStreams.map(streamLabel).join(", ");
  return `BUSY: ${repo} — all ${result.totalStreams} stream(s) occupied: ${names}${niceSuffix}`;
}
