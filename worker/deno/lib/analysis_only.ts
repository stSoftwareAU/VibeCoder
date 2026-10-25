/**
 * Analysis-only / no-PR issue detection and loop-guard helpers (Issue #2849).
 *
 * Some `work-on` issues have no PR deliverable: their outcome is a
 * recommendation, a coverage matrix, or "populate the issue" analysis
 * posted as a comment, with no code/prompt change. Because the standard
 * pipeline treats a raised PR as its completion signal, a no-PR outcome
 * read as "not done" and the issue was re-picked-up and re-run
 * indefinitely (the loop seen in VibeCoder#2834).
 *
 * This module holds the detection signal: `hasAnalysisOnlyMarker`, an
 * up-front body marker declaring the issue analysis-only / no-PR. A marked
 * issue whose run produced its analysis is closed as completed with that
 * analysis (Issue #4298) in `phases/handle_no_changes_phase.ts`; it is
 * never handed to a human. The hand-off comment marker and its loop guard
 * went with the hand-off.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/**
 * Up-front body markers a human can drop into an issue to declare it
 * analysis-only / no-PR. Matched case-insensitively, ignoring inner
 * whitespace. Both spellings are accepted as equivalent conveniences.
 */
const ANALYSIS_ONLY_BODY_PATTERN = /<!--\s*(?:analysis-only|no-pr)\s*-->/i;

/**
 * Return true when the issue body declares itself analysis-only / no-PR
 * via the lightweight HTML-comment marker `<!-- analysis-only -->`
 * (or its `<!-- no-pr -->` alias).
 */
export function hasAnalysisOnlyMarker(issueBody: string): boolean {
  if (!issueBody) return false;
  return ANALYSIS_ONLY_BODY_PATTERN.test(issueBody);
}
