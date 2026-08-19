/**
 * Milestone-tracking-issue title predicate (Issue #2753).
 *
 * Extracted from `milestone_completion.ts` (Issue #3909) so the open-children
 * gate can reuse it without an import cycle. `milestone_completion.ts`
 * re-exports it, so existing importers are unaffected.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/**
 * Regex matching a milestone-tracking issue title regardless of the inner
 * milestone title or the trailing default-branch name (Issue #2753).
 *
 * The canonical title is `Merge milestone '<title>' to <defaultBranch>`.
 * Matching only the fixed shape — not the exact `<title>`/`<defaultBranch>`
 * text — makes the idempotent lookup robust to the two field-bypass causes:
 *   1. the default branch resolving differently between runs (e.g. one run
 *      sees "Develop", another "main"), and
 *   2. the milestone being renamed after the tracker was filed.
 */
const MILESTONE_TRACKING_TITLE_RE = /^Merge milestone '.+' to .+$/;

/**
 * Return true when `title` has the milestone-tracking-issue shape
 * `Merge milestone '<title>' to <branch>` (Issue #2753). Leading/trailing
 * whitespace is tolerated so titles that drifted on whitespace still match.
 */
export function isMilestoneTrackingTitle(title: string): boolean {
  return MILESTONE_TRACKING_TITLE_RE.test(title.trim());
}
