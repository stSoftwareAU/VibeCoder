/**
 * Approved default-branch merges (Issue #1082).
 *
 * The blast-radius guard in `direct_merge.ts` refuses every default-branch
 * direct merge, asking for "branch protection or a human review" instead
 * (Issue #2416). On a base with **no required checks** there is no protection
 * to defer to and GitHub's `--auto` is unusable (Issue #4375), so the fleet
 * had no way to land such a PR at all: `NEAT-AI-Ockham#116` was green,
 * approved and mergeable, and the same refusal was logged roughly forty times
 * over four hours while six `work-on` issues stayed blocked behind it.
 *
 * This module supplies the missing half of the guard's own sentence — the
 * review, asked for explicitly. A fleet account approving a sibling account's
 * PR is not review, which is why the fleet logins are a required field rather
 * than an optional one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { runGhCommand } from "./github.ts";

/** Injectable gh command runner. */
type GhCommandFn = (args: string[]) => Promise<string>;

/** One review on a PR, reduced to the fields the policy needs. */
export interface PrReview {
  /** Login of the reviewer. */
  author: string;
  /** Review state as GitHub reports it (`APPROVED`, `CHANGES_REQUESTED`, …). */
  state: string;
  /**
   * ISO timestamp the review was submitted. "Latest per reviewer" is decided
   * on this, never on array order: GitHub documents no ordering, and reading
   * a withdrawn approval as the current verdict would authorise a merge the
   * reviewer had already revoked. A review with no usable timestamp sorts
   * oldest, so it can never displace one that has a timestamp.
   */
  submittedAt?: string;
}

/**
 * Policy that lets the gated direct merge land a PR onto an **unprotected**
 * default branch (Issue #1082).
 *
 * Without it the fleet cannot land such a PR at all: `--auto` is skipped
 * because a base with no required checks would merge immediately whatever CI
 * says (Issue #4375), and the blast-radius guard (Issue #2416) refuses every
 * default-branch direct merge. `NEAT-AI-Ockham#116` sat green and approved
 * through ~40 refusals over four hours until a human merged it, and the six
 * `work-on` issues behind it stayed blocked the whole time.
 *
 * The guard's requirement — "branch protection or a human review" — is met by
 * demanding the review explicitly: an approving review from a login **outside**
 * the fleet. A fleet account approving a sibling account's PR is not review,
 * so those approvals are discounted, which is why the fleet logins are a
 * required field rather than an optional one.
 */
export interface ApprovedDefaultBranchPolicy {
  /** Fleet logins whose approvals do not count as review. */
  fleetAuthors: readonly string[];
  /** Review lookup seam — defaults to {@link fetchPrReviews}; tests inject. */
  fetchReviewsFn?: (
    repo: string,
    prNumber: number,
    ghCommandFn: GhCommandFn,
  ) => Promise<PrReview[]>;
}

/** Fetch the PR's reviews via `gh pr view --json reviews`. */
export async function fetchPrReviews(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn = runGhCommand,
): Promise<PrReview[]> {
  const raw = await ghCommandFn([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "reviews",
    "--jq",
    ".reviews",
    // `reviews` carries `submittedAt`, which decides the latest verdict.
  ]);
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) return [];

  const reviews: PrReview[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const author = typeof obj.author === "object" && obj.author !== null
      ? (obj.author as Record<string, unknown>).login
      : undefined;
    const state = obj.state;
    if (typeof author !== "string" || typeof state !== "string") continue;
    reviews.push(
      typeof obj.submittedAt === "string" && obj.submittedAt
        ? { author, state, submittedAt: obj.submittedAt }
        : { author, state },
    );
  }
  return reviews;
}

/**
 * Whether the reviews carry an approval from outside the fleet.
 *
 * Only the **latest** review per reviewer counts — decided by `submittedAt`,
 * not by array order — so an approval later withdrawn (`CHANGES_REQUESTED`,
 * `DISMISSED`) does not authorise a merge. `COMMENTED` reviews are ignored
 * entirely: GitHub does not let them clear or replace a verdict either.
 */
export function hasNonFleetApproval(
  reviews: readonly PrReview[],
  fleetAuthors: readonly string[],
): boolean {
  const fleet = new Set(
    fleetAuthors
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.length > 0),
  );

  const latestByReviewer = new Map<string, { state: string; at: number }>();
  for (const review of reviews) {
    const login = review.author.trim().toLowerCase();
    if (!login || fleet.has(login)) continue;
    const state = review.state.trim().toUpperCase();
    if (state === "COMMENTED" || state === "PENDING") continue;

    const parsed = review.submittedAt ? Date.parse(review.submittedAt) : NaN;
    // A missing or unparseable timestamp sorts oldest, so it never displaces
    // a verdict GitHub did date.
    const at = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    const current = latestByReviewer.get(login);
    if (current === undefined || at >= current.at) {
      latestByReviewer.set(login, { state, at });
    }
  }

  return [...latestByReviewer.values()].some((v) => v.state === "APPROVED");
}
