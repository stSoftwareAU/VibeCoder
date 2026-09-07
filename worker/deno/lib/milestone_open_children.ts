/**
 * Authoritative open-children lookup for a milestone (Issue #3908).
 *
 * Milestone completeness used to be decided solely from a locally filtered,
 * cached projection of `gh issue list` (`fetchOpenIssuesByMilestone` →
 * `fetchAllIssues`). Every layer of that projection — cache freshness, the
 * `--limit` window, the exact-string milestone-title match, and the JSON
 * projection — is a way for the open count to silently read zero. Milestone 53
 * was declared complete with 12 open children on 7 Aug 2026, which merged a
 * summary PR and destroyed the milestone branch.
 *
 * GitHub already publishes the authoritative number on the milestone object
 * itself, so this module reads it fresh — no cache, at the moment of the
 * decision — and returns it alongside the fresh child list needed to exclude
 * the milestone's own tracking issue(s) and to name the children in logs.
 *
 * Issue #1246: which children are "the milestone's own tracking issue(s)" is
 * decided by `milestone_tracker_identity.ts`, from the tracking-issue body
 * marker and a fleet author — never from the title alone, which is text the
 * issue's own author sets. A candidate that cannot be verified stays an open
 * child, so the veto this module exists to provide is never relaxed on an
 * unauthenticated claim.
 *
 * Deliberate scope decision: `open_issues` counts open **pull requests**
 * assigned to the milestone as well as open issues, and the fresh child list
 * is read from the `/issues` endpoint, which likewise includes PRs. An open
 * child PR therefore vetoes finalisation — that is intended (#3906): merging
 * the summary PR deletes the milestone branch and auto-closes any in-flight
 * child PR still targeting it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  isMilestoneTrackingTitle,
  type MilestoneTrackerVerification,
  partitionMilestoneTrackers,
} from "./milestone_tracker_identity.ts";

/** Function signature for running gh CLI commands. */
type GhCommandFn = (args: string[]) => Promise<string>;

/**
 * Re-exported from `milestone_tracker_identity.ts` (Issue #1246), which owns
 * every part of "is this the fleet's tracker?" now that the title is only the
 * pre-filter. Import path preserved for existing callers.
 */
export { isMilestoneTrackingTitle };

/** An open child of a milestone — an issue or a pull request. */
export interface OpenMilestoneChild {
  number: number;
  title: string;
  /** True when the child is a pull request rather than an issue. */
  isPullRequest: boolean;
  /**
   * Issue body, carried so a tracking-shaped child can be checked for the
   * tracking-issue marker rather than trusted on its title (Issue #1246).
   */
  body: string;
  /** Login of the account that opened the child (Issue #1246). */
  author: string;
}

/** GitHub's own view of a milestone's open children, fetched fresh. */
export interface AuthoritativeOpenChildren {
  /**
   * `open_issues` straight off the milestone object — open issues *and* open
   * PRs, including the milestone's own tracking issue(s).
   */
  rawOpenIssues: number;
  /** Open tracking-shaped children, excluded from {@link openCount}. */
  trackers: OpenMilestoneChild[];
  /** Open non-tracking children (issues and PRs), ascending by number. */
  children: OpenMilestoneChild[];
  /**
   * Authoritative count of open non-tracking children. Non-zero is a hard
   * veto on milestone finalisation.
   */
  openCount: number;
  /**
   * False when the fresh child list could not be read. `openCount` then falls
   * back to the unadjusted {@link rawOpenIssues} (the conservative reading —
   * tracking issues cannot be excluded without their titles) and the caller
   * must log the degradation rather than treat it as a clean result.
   */
  childListAvailable: boolean;
  /** Why the child list was unavailable; undefined when it was read. */
  childListError?: string;
}

/** Read `open_issues` off a milestone API payload, or throw. */
function parseMilestoneOpenIssues(raw: string): number {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a milestone object");
  }
  const value = (parsed as { open_issues?: unknown }).open_issues;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("milestone payload has no usable 'open_issues' field");
  }
  return Math.trunc(value);
}

/** Read the open-child list off an issues API payload, or throw. */
function parseOpenChildren(raw: string): OpenMilestoneChild[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("expected an array of issues");
  }
  return parsed
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object"
    )
    .filter((entry) => typeof entry.number === "number")
    .map((entry) => ({
      number: entry.number as number,
      title: typeof entry.title === "string" ? entry.title : "",
      isPullRequest: entry.pull_request !== undefined &&
        entry.pull_request !== null,
      body: typeof entry.body === "string" ? entry.body : "",
      // REST names the issue's opener `user`, not `author` (Issue #1246).
      author: typeof (entry.user as { login?: unknown } | undefined)?.login ===
          "string"
        ? (entry.user as { login: string }).login
        : "",
    }))
    .sort((a, b) => a.number - b.number);
}

/**
 * Fetch GitHub's authoritative count of a milestone's open children
 * (Issue #3908).
 *
 * Two uncached calls, both made at the moment of the completeness decision —
 * a counter read minutes earlier is not evidence about now:
 *   1. `repos/<repo>/milestones/<number>` for the authoritative `open_issues`;
 *   2. `repos/<repo>/issues?milestone=<number>&state=open` for the child list,
 *      used to exclude the milestone's own tracking issue(s) (Issue #3214) and
 *      to name the children in the disagreement warning.
 *
 * `openCount` is the larger of "authoritative count minus trackers" and "fresh
 * non-tracking children seen" — whichever source reports work still open wins,
 * because the cost of a false "complete" (a merged summary PR and a deleted
 * milestone branch) dwarfs the cost of a delayed one.
 *
 * Fails loud: a failed or malformed milestone fetch returns an error rather
 * than a zero count, so the caller vetoes finalisation instead of reading the
 * failure as "nothing open".
 *
 * @param repo - Repository in "owner/repo" format
 * @param milestoneNumber - The milestone's GitHub number
 * @param ghCommandFn - Function to execute gh CLI commands
 * @param verification - Fleet-identity inputs for the tracker check (#1246)
 */
export async function fetchAuthoritativeOpenChildren(
  repo: string,
  milestoneNumber: number,
  ghCommandFn: GhCommandFn,
  verification: MilestoneTrackerVerification = {},
): Promise<Result<AuthoritativeOpenChildren>> {
  let rawOpenIssues: number;
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/milestones/${milestoneNumber}`,
    ]);
    rawOpenIssues = parseMilestoneOpenIssues(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(
        `Failed to read the authoritative open-children count for milestone ` +
          `#${milestoneNumber} in ${repo}: ${message}`,
      ),
    };
  }

  let allChildren: OpenMilestoneChild[] = [];
  let childListAvailable = true;
  let childListError: string | undefined;
  try {
    const raw = await ghCommandFn([
      "api",
      `repos/${repo}/issues?milestone=${milestoneNumber}&state=open&per_page=100`,
    ]);
    allChildren = parseOpenChildren(raw);
  } catch (err) {
    childListAvailable = false;
    childListError = err instanceof Error ? err.message : String(err);
  }

  // Issue #1246: a tracking-shaped *title* is only a candidate. Subtracting a
  // child from the open count is what finalises the milestone — which merges
  // the summary PR and deletes the milestone branch — so the exclusion is made
  // on the tracking-issue body marker plus a fleet author, never on the title
  // anybody can set. An unverifiable candidate stays an open child.
  const { trackers, others: children } = await partitionMilestoneTrackers(
    allChildren,
    `authoritative open children of milestone #${milestoneNumber} in ${repo}`,
    verification,
  );
  const openCount = childListAvailable
    ? Math.max(rawOpenIssues - trackers.length, children.length)
    : rawOpenIssues;

  return {
    ok: true,
    value: {
      rawOpenIssues,
      trackers,
      children,
      openCount: Math.max(0, openCount),
      childListAvailable,
      ...(childListError !== undefined ? { childListError } : {}),
    },
  };
}

/** Format child numbers as `#1, #2` for logs; `none` when empty. */
export function formatChildNumbers(
  children: readonly { number: number }[],
): string {
  if (children.length === 0) return "none";
  return children.map((child) => `#${child.number}`).join(", ");
}
