/**
 * Anchored `Part of #N` provenance lines for milestone roll-up bodies (Issue
 * #4967, Issue #5058).
 *
 * The fleet reviewer's governing-issue read (`resolveGoverningIssues` in
 * `.claude/skills/review-fleet-prs/scripts/test_change_policy.ts`) links an
 * issue from an anchored `Part of #N` line. The full rollup
 * (`buildMilestoneSummaryBody` in `milestone_completion.ts`, Issue #4967) and
 * the partial rollup (`buildPartialRollupBody` in
 * `milestone_partial_rollup.ts`, Issue #5058) both render these lines through
 * {@link milestoneProvenanceLines}, so the two bodies cannot drift apart.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { MILESTONE_PROVENANCE_MAX_CHILDREN } from "./governing_issue_limits.ts";
import { trackingIssueFromMilestoneTitle } from "./milestone_sync_streak.ts";

/**
 * The `Part of #N` lines for a roll-up body: the parent first, then the
 * children.
 *
 * - The parent is the leading `#N` of `milestoneTitle` (for example `#42
 *   Retry policy`); a title with none gives no parent line.
 * - The children are `claimedNumbers`, ascending and deduplicated, capped at
 *   {@link MILESTONE_PROVENANCE_MAX_CHILDREN} (the cap does not count the
 *   parent).
 * - Only safe positive integers are linked. The tracking issue, when given,
 *   and the parent are never repeated as children.
 *
 * Each line is anchored (`Part of #N`, nothing else on the line), so it never
 * carries a closing keyword.
 */
export function milestoneProvenanceLines(
  milestoneTitle: string,
  claimedNumbers: readonly number[],
  trackingIssueNumber?: number,
): string[] {
  const parentNumber = trackingIssueFromMilestoneTitle(milestoneTitle);
  const isLinkable = (n: number): boolean =>
    Number.isSafeInteger(n) && n > 0 && n !== trackingIssueNumber;
  const parentLine = parentNumber === null
    ? []
    : [parentNumber].filter(isLinkable);
  const childNumbers = [...new Set(claimedNumbers)]
    .filter((n) => isLinkable(n) && n !== parentNumber)
    .sort((a, b) => a - b)
    .slice(0, MILESTONE_PROVENANCE_MAX_CHILDREN);
  return [...parentLine, ...childNumbers].map((n) => `Part of #${n}`);
}
