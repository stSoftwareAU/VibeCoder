/**
 * Issue #4967 / PR #5054 review: the one place that holds how many governing
 * issues the fleet reviewer reads for a pull request and how many `Part of #N`
 * child lines a milestone roll-up body carries. Both sides import it so the
 * roll-up never links more issues than the reviewer reads (the reviewer drops
 * the rest silently, and a quote held only in a dropped child is then reported
 * as "not found").
 */

/**
 * The most candidate issues the reviewer reads per pull request (closing
 * references, the worker's own issue and anchored `Part of` lines). It bounds
 * the per-PR `gh` reads. Sized for a milestone roll-up: the repository's largest
 * milestone has 40 issues, so 62 children plus the tracking issue and the parent
 * leaves headroom.
 */
export const MAX_GOVERNING_ISSUES = 64;

/** The tracking issue (`Closes #N`) and the parent (`Part of #<title #N>`). */
export const MILESTONE_PROVENANCE_RESERVED_ISSUES = 2;

/**
 * The most `Part of #N` child lines a roll-up body carries: what is left of
 * {@link MAX_GOVERNING_ISSUES} after the tracking issue and the parent.
 */
export const MILESTONE_PROVENANCE_MAX_CHILDREN = MAX_GOVERNING_ISSUES -
  MILESTONE_PROVENANCE_RESERVED_ISSUES;
