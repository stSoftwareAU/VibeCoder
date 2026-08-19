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
 * This module provides the two detection signals the fix relies on:
 *   1. `hasAnalysisOnlyMarker` — an up-front body marker declaring the
 *      issue analysis-only / no-PR.
 *   2. `hasPriorAnalysisHandoff` — a loop guard that detects a prior
 *      hand-off comment on the issue, so a repeat no-progress run is
 *      escalated via the `failed-once` → `failed` ladder rather than
 *      handed off again forever.
 *
 * The clean hand-off itself (apply `needs-human` + post an explanation)
 * lives in `phases/handle_no_changes_phase.ts`; this module only holds
 * the pure, GitHub-free detection logic so it is trivially unit-tested.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { GitHubComment } from "../types.ts";

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

/** Marker prefix embedded in the hand-off comment posted by the worker. */
export const ANALYSIS_ONLY_HANDOFF_MARKER_PREFIX =
  "<!-- vibe-analysis-only-handoff:";

/**
 * Build the hidden hand-off marker for a given issue. Embedded in the
 * analysis hand-off comment so a later run can detect that this issue
 * has already been handed off once (the loop guard).
 */
export function buildAnalysisHandoffMarker(issueNumber: number): string {
  return `${ANALYSIS_ONLY_HANDOFF_MARKER_PREFIX}${issueNumber} -->`;
}

/**
 * Loop guard — return true when a prior analysis-only hand-off comment
 * for `issueNumber` is present in `comments`. Used as the fallback
 * beneath the clean hand-off: if the issue is back here with no progress
 * after a previous hand-off, the worker escalates via the failure ladder
 * instead of handing off again.
 */
export function hasPriorAnalysisHandoff(
  comments: readonly GitHubComment[],
  issueNumber: number,
): boolean {
  const marker = buildAnalysisHandoffMarker(issueNumber);
  return comments.some((c) => c.body.includes(marker));
}
