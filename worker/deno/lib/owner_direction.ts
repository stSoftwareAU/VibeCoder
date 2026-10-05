/**
 * Owner direction posted on a sub-issue's milestone parent, or on a PR's
 * linked issue, after the work began (Issue #3205).
 *
 * An owner who changes a design usually does it on the milestone parent — the
 * issue the milestone is named for — and not on every sub-issue. A run that
 * reads only its own issue keeps building the retired design, and only the
 * review catches it. This module puts that direction in front of the run:
 *
 * - **Issue runs on a milestone sub-issue** get the parent's comments.
 * - **Review-fix runs** get the linked issue's comments and its parent's; a
 *   milestone PR's run gets its tracking issue's.
 *
 * Only **trusted authors** count as owner direction — the same lists, and the
 * same `classifyCommentAuthor`, every other prompt route trusts by. Selection
 * and budget are delegated to `selectImplementationComments`, so worker
 * bookkeeping is dropped and the newest direction is the one certain to
 * survive. A failed fetch yields an empty issue, which yields no section: the
 * direction is context, never a precondition of the run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  fetchIssueData,
  type IssueComment,
  type IssueData,
} from "./issue_data.ts";
import { classifyCommentAuthor } from "./comment_trust_filter.ts";
import { selectImplementationComments } from "./implementation_comments.ts";
import { capFormattedComments } from "./comment_rate_limiter.ts";
import { normaliseLogin } from "./identity_guard.ts";
import { trackingIssueFromMilestoneTitle } from "./milestone_sync_streak.ts";
import { issueNumberFromBranch } from "./issue_branch_candidates.ts";

/**
 * How much owner direction one issue contributes to a prompt.
 *
 * Below the implementation-comment budget: this rides beside the run's own
 * issue thread, and the newest few owner comments are what carry a redirect.
 */
export const OWNER_DIRECTION_LIMITS = {
  maxComments: 10,
  maxTotalChars: 6_000,
} as const;

/** Trust lists, worker login and budget overrides. */
export interface OwnerDirectionOptions {
  allowedAuthors: readonly string[];
  authorisedCommenters: readonly string[];
  /** The worker's own login — never owner direction, even when listed. */
  workerLogin?: string;
  maxComments?: number;
  maxTotalChars?: number;
}

/** One issue's owner direction. */
export interface OwnerDirection {
  issueNumber: number;
  /** Trusted-author comments, newest first. */
  comments: IssueComment[];
}

/** Fetches one issue — {@link fetchIssueData} in production. */
export type FetchIssue = (
  repo: string,
  issueNumber: number,
) => Promise<IssueData>;

/**
 * The milestone parent of an issue: the issue its milestone title leads with,
 * or null when the title names none or names the issue itself.
 */
export function milestoneParentOf(
  issueNumber: number,
  milestoneTitle: string | undefined,
): number | null {
  if (!milestoneTitle) return null;
  const parent = trackingIssueFromMilestoneTitle(milestoneTitle);
  return parent === issueNumber ? null : parent;
}

/**
 * The tracking issue a milestone branch names. `createMilestoneBranchName`
 * turns `#2285 Policy…` into `milestone/2285-policy…`, so the leading number
 * is the parent.
 */
export function trackingIssueFromMilestoneBranch(
  branchName: string,
): number | null {
  const match = /^milestone\/(\d+)(?:-|$)/.exec(branchName.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Choose an issue's owner-direction comments: trusted authors only, never the
 * worker, newest first, within budget.
 */
export function selectOwnerDirection(
  comments: readonly IssueComment[],
  options: OwnerDirectionOptions,
): IssueComment[] {
  const workerKey = options.workerLogin
    ? normaliseLogin(options.workerLogin)
    : "";
  const trust = {
    allowedAuthors: [...options.allowedAuthors],
    authorisedCommenters: [...options.authorisedCommenters],
  };
  const owned = comments.filter((c) =>
    normaliseLogin(c.author) !== workerKey &&
    classifyCommentAuthor(c.author, trust) === "TRUSTED"
  );
  const { selected } = selectImplementationComments(owned, {
    maxComments: options.maxComments ?? OWNER_DIRECTION_LIMITS.maxComments,
    maxTotalChars: options.maxTotalChars ??
      OWNER_DIRECTION_LIMITS.maxTotalChars,
  });
  return selected.reverse();
}

/**
 * Render owner direction as plain records naming the issue, author and date.
 * Empty when no issue kept a comment, so the caller renders no section.
 */
export function formatOwnerDirection(
  directions: readonly OwnerDirection[],
): string {
  const records = directions.flatMap((d) =>
    d.comments.map((c) =>
      `On #${d.issueNumber}, ${c.author}${
        c.createdAt ? ` at ${c.createdAt}` : ""
      } wrote:\n${c.body.trim()}`
    )
  );
  if (records.length === 0) return "";
  return capFormattedComments(
    records.join("\n---\n"),
    OWNER_DIRECTION_LIMITS.maxTotalChars * Math.max(1, directions.length),
  );
}

async function directionOf(
  repo: string,
  issueNumber: number,
  options: OwnerDirectionOptions,
  fetchIssue: FetchIssue,
): Promise<{ direction: OwnerDirection; data: IssueData }> {
  const data = await fetchIssue(repo, issueNumber);
  return {
    data,
    direction: {
      issueNumber,
      comments: selectOwnerDirection(data.comments, options),
    },
  };
}

/**
 * The milestone parent's owner direction for an issue run, formatted — or ""
 * when the issue has no milestone parent or the parent has no trusted comment.
 */
export async function fetchMilestoneParentDirection(
  request: OwnerDirectionOptions & {
    repo: string;
    issueNumber: number;
    milestoneTitle?: string;
  },
  fetchIssue: FetchIssue = fetchIssueData,
): Promise<string> {
  const parent = milestoneParentOf(request.issueNumber, request.milestoneTitle);
  if (parent === null) return "";
  const { direction } = await directionOf(
    request.repo,
    parent,
    request,
    fetchIssue,
  );
  return formatOwnerDirection([direction]);
}

/**
 * The owner direction a review-fix run must check its branch against: the
 * linked issue's and its milestone parent's for an `issue-<n>` branch, the
 * tracking issue's for a `milestone/<n>-…` branch, nothing otherwise.
 */
export async function fetchPrOwnerDirection(
  request: OwnerDirectionOptions & { repo: string; branchName: string },
  fetchIssue: FetchIssue = fetchIssueData,
): Promise<string> {
  const { repo, branchName } = request;
  const linked = issueNumberFromBranch(branchName);
  if (linked !== null) {
    const own = await directionOf(repo, linked, request, fetchIssue);
    const parent = milestoneParentOf(linked, own.data.milestoneTitle);
    const directions = [own.direction];
    if (parent !== null) {
      directions.push(
        (await directionOf(repo, parent, request, fetchIssue)).direction,
      );
    }
    return formatOwnerDirection(directions);
  }
  const tracking = trackingIssueFromMilestoneBranch(branchName);
  if (tracking === null) return "";
  const { direction } = await directionOf(repo, tracking, request, fetchIssue);
  return formatOwnerDirection([direction]);
}
