/**
 * The machine-readable marker on the PR comment that holds a PR for a pre-PR
 * verifier finding (Issue #3697). The PR-feedback pass reads it back to tell a
 * verifier hold from a standing Standards violation hold, so it can release
 * the `standing-violation` label once the findings are fixed.
 *
 * The worker writes the marker as the first line of the comment, and the
 * parser accepts it only at index 0 of the body, so verifier or agent-authored
 * text later in the body can never forge it. `releasable` is true only when
 * the hold was applied for the verifier finding alone (no standing Standards
 * violation also held the PR), so releasing the label after a fix cannot lift
 * a standing-violation hold this marker does not own.
 */

const MARKER_RE =
  /^<!-- vibe-pre-pr-verifier-held releasable="(true|false)" -->/;

/** The marker line the held-PR comment opens with (Issue #3697). */
export function prePrVerifierHeldMarkerLine(releasable: boolean): string {
  return `<!-- vibe-pre-pr-verifier-held releasable="${releasable}" -->`;
}

/**
 * Reads the held-PR marker from a comment body, or `null` when the body does
 * not start with one. Only a marker at index 0 counts (no trimming).
 */
export function parsePrePrVerifierHeldMarker(
  body: string,
): { releasable: boolean } | null {
  const match = MARKER_RE.exec(body);
  if (match === null) return null;
  return { releasable: match[1] === "true" };
}
