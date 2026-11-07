/**
 * Whether a comment body has any visible text once HTML comments are removed
 * (Issue #4673).
 *
 * The review-fleet-prs skill posts a claim whose whole body is one hidden
 * `<!-- vibe-review-claim … -->` marker. That carries nothing to act on, so
 * the feedback scan must not spend a model run on it.
 *
 * Every complete `<!-- … -->` span is removed in one left-to-right pass built
 * on `indexOf`, so the work stays linear on untrusted text. An unclosed `<!--`
 * is not hidden: its text counts as visible, so the scan fails towards the
 * old behaviour of acting.
 *
 * @param body - The comment body as posted
 * @returns True when non-whitespace text remains outside complete HTML comments
 */
export function hasVisibleText(body: string): boolean {
  const open = "<!--";
  const close = "-->";
  let visible = "";
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(open, cursor);
    if (start < 0) {
      visible += body.slice(cursor);
      break;
    }
    const end = body.indexOf(close, start + open.length);
    if (end < 0) {
      // Unclosed opener: the rest of the body, opener included, is visible.
      visible += body.slice(cursor);
      break;
    }
    visible += body.slice(cursor, start);
    cursor = end + close.length;
  }
  return visible.trim() !== "";
}
