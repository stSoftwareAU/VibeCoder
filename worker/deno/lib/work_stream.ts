/**
 * Work streams — the unit the fleet works one issue at a time in (Issue
 * #1091).
 *
 * The operator's rule is **one issue in flight per work stream**, and a work
 * stream is `(repository, milestone)`: milestone work lands on
 * `milestone/<title>`, everything else on the default branch. A repository
 * holds many streams, and they are worked in parallel by design — that is
 * what `isMilestoneOccupied` (`issue_filter.ts`) has always enforced.
 *
 * Issue #4176 keyed the host-local slot exclusion by **repository** instead,
 * because at the time every slot checked out into the one clone
 * `${WORK_DIR}/<repo>`. Measured on `vibe-coder-37405:50` on 2026-09-05, that
 * collapsed eight parallel streams into one: `s1` held `VibeCoder#1082`, so
 * `s2`'s scan considered 5 issues instead of 29 and idled for 14 minutes with
 * the whole backlog claimable. Since Issue #923 a slot works in its own lane
 * worktree (`lane_worktree.ts`) and Issue #1322 scoped the Claude session
 * store per work stream, so the repository is no longer the unit of
 * exclusion; the stream is.
 *
 * This module holds the two things that keying by stream needs: the stream's
 * identity, and the adapter that makes a host's live claims visible to the
 * *existing* occupancy check rather than to a second, parallel one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * The stream an issue with no milestone belongs to — the default branch.
 *
 * Spelled as the empty string because that is what `isMilestoneOccupied`,
 * `checkRepoAvailability` and `FilterableIssue.milestone` already use for
 * "no milestone"; a second spelling would be a second notion.
 */
export const DEFAULT_BRANCH_STREAM = "";

/** A work stream: one milestone (or the default branch) of one repository. */
export interface WorkStream {
  /** `owner/name`. */
  repo: string;
  /** Milestone title, or {@link DEFAULT_BRANCH_STREAM} for no milestone. */
  milestone: string;
}

/**
 * An issue a slot on this host holds, and the stream that hold occupies.
 *
 * Produced by `InFlightRepoRegistry.heldIssues()` — the registry is the
 * source of truth for what a slot holds, so the stream identity lives on the
 * hold rather than being re-derived by each reader.
 */
export interface InFlightClaim extends WorkStream {
  issueNumber: number;
}

/**
 * Stable key for a work stream, for use in a `Map`/`Set`.
 *
 * `owner/name@milestone`, with the empty milestone rendered as
 * `owner/name@` — a repository slug contains no `@`, so splitting on the
 * first one recovers both halves. Readable on purpose: this key reaches log
 * lines and test failure messages, and an opaque separator would make a
 * mismatched stream unreadable exactly where it matters.
 *
 * @param repo - `owner/name`
 * @param milestone - Milestone title, or the default-branch stream
 * @returns The stream key
 */
export function workStreamKey(repo: string, milestone: string): string {
  return `${repo}@${milestone}`;
}

/**
 * Render a work stream for a human reading a log line.
 *
 * @param stream - The stream
 * @returns `owner/name (milestone "X")`, or `owner/name (default branch)`
 */
export function describeWorkStream(stream: WorkStream): string {
  return stream.milestone === DEFAULT_BRANCH_STREAM
    ? `${stream.repo} (default branch)`
    : `${stream.repo} (milestone "${stream.milestone}")`;
}

/** The minimum an issue must carry to be overlaid with a live claim. */
export interface ClaimableIssueShape {
  number: number;
  assignees: string[];
}

/**
 * Show a repository's fetched issues the claims this host already holds.
 *
 * The claim path assigns an issue on GitHub before working it, so a held
 * stream is normally occupied by the issue data itself. Within one cycle it
 * need not be: the scan reads through the iteration-scoped `IssueCache`, and
 * a sibling slot can claim between the cache being filled and this slot
 * scanning. Overlaying the host's live claims onto that list closes the
 * window **without inventing a second notion of "occupied"** — the same
 * `isMilestoneOccupied` call, over the same issue list, simply sees the
 * assignment the cache had not caught up with.
 *
 * Only the assignee list is touched, and only for an issue the host actually
 * holds. Entries are copied rather than mutated, so a cached list shared with
 * another reader is never rewritten underneath it.
 *
 * The registry's `tryAcquire` remains the hard guarantee that two slots never
 * hold one stream (an issue beyond the fetch limit is invisible to any
 * overlay); this is what stops the scan *offering* work it would then refuse.
 *
 * @param repo - The repository the issues belong to
 * @param issues - The repository's fetched open issues
 * @param claims - Every claim held on this host, any repository
 * @param workerUser - This host's GitHub login — the assignee to overlay
 * @returns The issue list with held issues marked assigned to `workerUser`
 */
export function applyInFlightClaims<T extends ClaimableIssueShape>(
  repo: string,
  issues: T[],
  claims: readonly InFlightClaim[],
  workerUser: string,
): T[] {
  const held = new Set(
    claims.filter((c) => c.repo === repo).map((c) => c.issueNumber),
  );
  if (held.size === 0) return issues;
  const login = workerUser.toLowerCase();
  return issues.map((issue) => {
    if (!held.has(issue.number)) return issue;
    if (issue.assignees.some((a) => a.toLowerCase() === login)) return issue;
    return { ...issue, assignees: [...issue.assignees, workerUser] };
  });
}
