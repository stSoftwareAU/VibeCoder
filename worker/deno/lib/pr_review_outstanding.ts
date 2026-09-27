/**
 * Which `CHANGES_REQUESTED` reviews on a PR are still outstanding
 * (Issue #2697).
 *
 * The scan used to treat "the head moved since the review" as "the feedback
 * was addressed", so a branch update (Priority 1.6) or the auto-merge sweep's
 * update request (1.65) — both of which run before PR Feedback — silently
 * dropped every change request that arrived between two feedback passes.
 * A moved head proves nothing: a rebase or a merge-from-base leaves the
 * patch unchanged, and a human push is never fleet work (Issue #211).
 *
 * The rule here is the reviewer's own: a reviewer's **latest** review decides.
 * A `CHANGES_REQUESTED` review is outstanding until it is dismissed (the
 * worker's own processed marker for `pr_review`) or the same reviewer
 * submits a newer review. One entry per reviewer, so a re-review never
 * queues a duplicate; the `PR_COMMENT_CLAIM` marker keeps the claim
 * idempotent.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** One PR review as the `--jq` projection {@link PR_REVIEWS_JQ} shapes it. */
export interface PrReview {
  /** Reviewer login. */
  login: string;
  /** GitHub's review id — the `commentId` a `pr_review` is claimed under. */
  id: number;
  /** Review body; `""` when the reviewer left none. */
  body: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  state: string;
  /** ISO 8601 submission time; `null` for a `PENDING` draft. */
  submitted_at?: string | null;
  /** The commit the review was left on — informational only. */
  commit_id?: string | null;
}

/** A `CHANGES_REQUESTED` review the scan will not act on, and why. */
export interface SkippedReview {
  review: PrReview;
  reason: string;
}

/** What {@link selectOutstandingReviews} decided. */
export interface OutstandingReviewSelection {
  /** Latest review per reviewer whose state is `CHANGES_REQUESTED`. */
  outstanding: PrReview[];
  /** Every other `CHANGES_REQUESTED` review, with the reason it is skipped. */
  skipped: SkippedReview[];
}

/**
 * The `--jq` projection the scan requests: every submitted review, whatever
 * its state, so a later review can supersede an earlier change request.
 * Reviews by a deleted account (`user: null`) are dropped — they have no
 * login to authorise.
 */
export const PR_REVIEWS_JQ = "[.[] | select(.user != null) | " +
  '{login: .user.login, id: .id, body: (.body // ""), state: .state, ' +
  "submitted_at: .submitted_at, commit_id: .commit_id}]";

/** Is this row shaped like a {@link PrReview}? */
function isPrReview(row: unknown): row is PrReview {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.login === "string" && typeof r.id === "number" &&
    typeof r.body === "string" && typeof r.state === "string";
}

/**
 * Flatten what `gh api --paginate --jq '[…]'` prints for the review list.
 *
 * `--paginate` applies the filter per page, so the payload is one JSON array
 * per line. A malformed line or row throws: an unreadable review list must
 * surface as a failure, never pass as "no reviews".
 *
 * @param payload - Raw stdout from the paginated review read
 * @returns Every review across every page, in page order
 */
export function parsePrReviewPages(payload: string): PrReview[] {
  const reviews: PrReview[] = [];
  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const page: unknown = JSON.parse(trimmed);
    if (!Array.isArray(page)) {
      throw new Error("review page is not a JSON array");
    }
    for (const row of page) {
      if (!isPrReview(row)) {
        throw new Error(`malformed review row: ${JSON.stringify(row)}`);
      }
      reviews.push(row);
    }
  }
  return reviews;
}

/**
 * Does this review change what its reviewer is asking for?
 *
 * A `PENDING` review is an unsubmitted draft. An empty-bodied `COMMENTED`
 * review is the container GitHub creates for an inline reply — the reply is
 * scanned as a review comment in its own right, and it does not withdraw the
 * change request.
 */
function countsAsReview(review: PrReview): boolean {
  if (review.state === "PENDING") return false;
  if (review.state === "COMMENTED" && review.body.trim() === "") return false;
  return true;
}

/** Submission time in ms, or null when absent or unreadable. */
function submittedMs(review: PrReview): number | null {
  if (!review.submitted_at) return null;
  const ms = Date.parse(review.submitted_at);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Pick each reviewer's latest review and keep those still requesting changes.
 *
 * Reviewers are grouped case-insensitively (GitHub logins are). The latest is
 * the one with the greatest `submitted_at`; on a tie or a missing timestamp
 * the later position wins, which is GitHub's chronological list order. A
 * dismissed change request carries state `DISMISSED`, so it is never
 * outstanding.
 *
 * @param reviews - Every review on the PR, in the order GitHub listed them
 * @returns The outstanding reviews, plus each skipped change request and why
 */
export function selectOutstandingReviews(
  reviews: readonly PrReview[],
): OutstandingReviewSelection {
  const latestByReviewer = new Map<string, PrReview>();
  for (const review of reviews) {
    if (!countsAsReview(review)) continue;
    const key = review.login.toLowerCase();
    const current = latestByReviewer.get(key);
    if (!current) {
      latestByReviewer.set(key, review);
      continue;
    }
    const currentMs = submittedMs(current);
    const reviewMs = submittedMs(review);
    const isOlder = currentMs !== null && reviewMs !== null &&
      reviewMs < currentMs;
    if (!isOlder) latestByReviewer.set(key, review);
  }

  const outstanding: PrReview[] = [];
  const skipped: SkippedReview[] = [];
  for (const review of reviews) {
    if (review.state !== "CHANGES_REQUESTED") continue;
    const latest = latestByReviewer.get(review.login.toLowerCase());
    if (latest === review) {
      outstanding.push(review);
    } else if (latest) {
      skipped.push({
        review,
        reason: `superseded by ${review.login}'s later ${latest.state} ` +
          `review ${latest.id}`,
      });
    }
  }
  return { outstanding, skipped };
}
