/**
 * Identity of the milestone's own tracking issue (Issue #1246).
 *
 * The worker files one tracking issue per completed milestone — `Merge
 * milestone '<title>' to <branch>` — and every milestone decision has to tell
 * that issue apart from the milestone's genuine children. Two of those
 * decisions act destructively on the answer: a child classified as "our
 * tracker" is subtracted from the open-children count, and a zero count
 * finalises the milestone, merges the summary PR and deletes the milestone
 * branch; and a child classified as "our tracker" on the premature/duplicate
 * paths is closed with `gh issue close`.
 *
 * The title alone cannot carry that weight. A title is text the issue's own
 * author chooses and may change at any time, so it is a *claim*, never
 * evidence — the same defect class `marker_dedup_author_manifest.ts` records
 * for body tags and comment prefixes, applied to a title. This module is the
 * one place that answers "is this the fleet's tracker?", and it answers it
 * from what GitHub authenticates:
 *
 *   1. the title shape — a cheap pre-filter, so the author lookup is only
 *      paid for on candidates, never the decision on its own;
 *   2. the `<!-- milestone-tracking-issue … -->` body marker the worker
 *      itself writes ({@link MILESTONE_TRACKING_MARKER}, Issue #1134); and
 *   3. a fleet author — `isFleetAuthor` against the fleet identity, reached
 *      through `alert_dedup_authors.ts`'s {@link selectFleetAuthoredComments}
 *      so there is no second definition of "the fleet" in the worker.
 *
 * **Fail direction: an unverifiable candidate is not a tracker.** It therefore
 * still counts as an open child — the milestone stays open — and it is never
 * closed. A milestone that waits an extra pass is recoverable; a deleted
 * milestone branch and somebody else's closed issue are not. That is the same
 * "fail towards the action that cannot cause harm" rule `alert_dedup_authors`
 * states, and it is why an unresolved fleet author set (no configuration, an
 * unreadable config) yields *no* trackers rather than all of them.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  type AlertDedupAuthorOptions,
  selectFleetAuthoredComments,
} from "./alert_dedup_authors.ts";
import { MILESTONE_TRACKING_MARKER } from "./issue_filter.ts";

/**
 * Regex matching a milestone-tracking-issue title regardless of the inner
 * milestone title or the trailing default-branch name (Issue #2753).
 *
 * The canonical title is `Merge milestone '<title>' to <defaultBranch>`.
 * Matching only the fixed shape — not the exact `<title>`/`<defaultBranch>`
 * text — makes the idempotent lookup robust to the two field-bypass causes:
 *   1. the default branch resolving differently between runs (e.g. one run
 *      sees "Develop", another "main"), and
 *   2. the milestone being renamed after the tracker was filed.
 *
 * Issue #1246: this is a **pre-filter only**. Every decision that acts on
 * "this is the fleet's tracker" must go through
 * {@link partitionMilestoneTrackers}, which adds the body marker and the
 * author check on top of it.
 */
const MILESTONE_TRACKING_TITLE_RE = /^Merge milestone '.+' to .+$/;

/**
 * Return true when `title` has the milestone-tracking-issue shape
 * `Merge milestone '<title>' to <branch>` (Issue #2753). Leading/trailing
 * whitespace is tolerated so titles that drifted on whitespace still match.
 *
 * A title match is a *candidate*, not a tracker (Issue #1246) — see the
 * module comment.
 */
export function isMilestoneTrackingTitle(title: string): boolean {
  return MILESTONE_TRACKING_TITLE_RE.test(title.trim());
}

/**
 * The HTML comment marker `createMilestoneTrackingIssue` writes into every
 * tracking-issue body (Issue #1134), re-exported here because it is the second
 * of the three identity checks (Issue #1246). `issue_filter.ts` remains its
 * home — a second copy of the string is a second thing to drift.
 */
export { MILESTONE_TRACKING_MARKER };

/**
 * The stable, ASCII-only head of {@link MILESTONE_TRACKING_MARKER}.
 *
 * Bodies filed by older worker versions differ in the trailing prose (and in
 * whether the dash survived a copy/paste), so identity is matched on the
 * marker's name rather than the whole sentence. Derived from the canonical
 * marker so the two cannot drift apart.
 */
const MARKER_PROSE_START = MILESTONE_TRACKING_MARKER.indexOf(" —");
export const MILESTONE_TRACKING_MARKER_PREFIX = MARKER_PROSE_START > 0
  ? MILESTONE_TRACKING_MARKER.slice(0, MARKER_PROSE_START)
  : MILESTONE_TRACKING_MARKER;

/** Return true when `body` carries the milestone-tracking-issue marker. */
export function hasMilestoneTrackingMarker(
  body: string | null | undefined,
): boolean {
  return (body ?? "").includes(MILESTONE_TRACKING_MARKER_PREFIX);
}

/**
 * A milestone child being classified.
 *
 * `author` is a bare login — the shape `alert_dedup_authors.ts`'s comment
 * selector already takes — so the fleet check is the existing primitive
 * rather than a fifth copy of it. `body` and `author` are optional because a
 * row read without them simply cannot be verified, which this module treats
 * as "not a tracker".
 */
export interface MilestoneTrackerCandidate {
  number: number;
  title: string;
  /** Issue body as GitHub returned it. */
  body?: string | null;
  /** Login of the account that opened the issue. */
  author?: string | null;
}

/** The split of a milestone's children into verified trackers and the rest. */
export interface MilestoneTrackerPartition<T> {
  /** Children proven to be the fleet's own tracking issues. */
  trackers: T[];
  /**
   * Everything else, in input order — genuine children *and* unverifiable
   * tracking-shaped candidates. These count as open children and are never
   * closed.
   */
  others: T[];
}

/** Author-verification inputs and logging for a tracker classification. */
export interface MilestoneTrackerVerification {
  /**
   * Fleet logins, env and config loader. Omitted means "read the configured
   * fleet identity", which is what every production caller does; a test
   * states the fleet instead of writing a config file.
   */
  authorOptions?: AlertDedupAuthorOptions;
  /** Sink for the discard and unresolved-set warnings. */
  log?: (message: string) => void;
  /**
   * What the caller does with an unverifiable candidate, in its own words,
   * completing "so …". Defaults to the shape every current caller wants.
   */
  unverifiedOutcome?: string;
}

/** Default consequence sentence — true at every call site so far. */
const DEFAULT_UNVERIFIED_OUTCOME =
  "the candidate is treated as an ordinary open child: it keeps the " +
  "milestone open and is never closed. A milestone that finalises a pass " +
  "late is recoverable; a deleted milestone branch is not";

/**
 * Split a milestone's open children into the fleet's own tracking issues and
 * everything else (Issue #1246).
 *
 * A child is a tracker only when all three hold: the title has the tracking
 * shape, the body carries {@link MILESTONE_TRACKING_MARKER}, and a fleet
 * account opened it. Anything short of that lands in `others`, so it counts
 * as an open child and is never closed — see the module comment for why that
 * is the harmless direction.
 *
 * @param candidates - The milestone's children, in the caller's order
 * @param context - Identifies the decision site in the log line
 * @param verification - Author-verification inputs and log sink
 * @returns The verified trackers and everything else
 */
export async function partitionMilestoneTrackers<
  T extends MilestoneTrackerCandidate,
>(
  candidates: readonly T[],
  context: string,
  verification: MilestoneTrackerVerification = {},
): Promise<MilestoneTrackerPartition<T>> {
  const log = verification.log ?? (() => {});
  const shaped = candidates.filter((c) => isMilestoneTrackingTitle(c.title));
  if (shaped.length === 0) {
    return { trackers: [], others: [...candidates] };
  }

  const markered = shaped.filter((c) => hasMilestoneTrackingMarker(c.body));
  const missingMarker = shaped.length - markered.length;
  if (missingMarker > 0) {
    log(
      `[milestone-tracker] ${context}: ignored ${missingMarker} ` +
        `tracking-shaped child/children with no tracking-issue body marker ` +
        `— a title is not evidence the fleet filed the issue (Issue #1246).`,
    );
  }

  const verified = await selectFleetAuthoredComments(
    markered,
    `milestone tracker (${context})`,
    verification.authorOptions ?? {},
    log,
    verification.unverifiedOutcome ?? DEFAULT_UNVERIFIED_OUTCOME,
  );

  const trackerNumbers = new Set(verified.map((c) => c.number));
  return {
    trackers: candidates.filter((c) => trackerNumbers.has(c.number)),
    others: candidates.filter((c) => !trackerNumbers.has(c.number)),
  };
}
