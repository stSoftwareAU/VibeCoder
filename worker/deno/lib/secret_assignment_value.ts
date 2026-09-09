/**
 * Value-side classification for the `secret-assignment` redaction rule
 * (Issue #1727).
 *
 * That rule's separator — `["']?\s*[=:]\s*` — spans line breaks, so a prose
 * line ending in a credential-ish label adopted the *next* non-blank line as
 * the assignment's value. A PR body reading
 *
 * ```text
 * How a spawn or a mid-run switch now picks a credential:
 *
 * ```mermaid
 * ```
 *
 * had its fence published as `***REDACTED***`, and the Mermaid diagram
 * `CODING-STANDARDS.md` requires stopped rendering. The prose variant was as
 * bad: `credential:` followed by a sentence masked the sentence's first word.
 *
 * The label side of the rule is deliberately blunt and stays that way — it
 * catches real secrets. Only the value is judged here, on two axes:
 *
 *  - **Markdown structure is never a credential**, wherever it appears. A
 *    fence, an inline-code span, a heading, a list marker, a table pipe or an
 *    image is excluded outright; no credential starts with those bytes, so the
 *    exclusion costs no coverage.
 *  - **A value on a later line than its label needs credential shape.** An
 *    inline `secret_scanning: enabled` or `PASSWORD=12345` is genuine
 *    assignment syntax and is masked exactly as before; a value the separator
 *    reached across a line break is prose until it looks otherwise.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Markdown structure that can open a matched value.
 *
 * Every alternative is anchored and has no nested quantifier, so the test is
 * linear in the value length (the Issue #3942 linearity rule). Some markers
 * (`#`, `>`, `|`, a spaced list bullet) cannot reach this predicate today
 * because the rule already requires an alphanumeric inside the value's first
 * run of non-space characters — they are listed so the intent survives a
 * future loosening of that lookahead.
 */
const MARKDOWN_VALUE_START =
  /^(?:`|~{3,}|#|>|\||!?\[|[-*+](?:\s|$)|\d+[.)](?:\s|$))/;

/** A value wrapped in matching quotes: explicit assignment syntax, not prose. */
const QUOTED_VALUE = /^(?:"[^"]*"|'[^']*')$/;

/**
 * A single word with no digit, symbol or internal capital — the shape of an
 * English sentence's first word, and of no credential worth masking.
 */
const PLAIN_WORD = /^[A-Za-z][a-z]*$/;

/**
 * Shortest cross-line value still treated as a credential. Eight characters
 * is the floor the issue asks for: shorter than any credential a generator
 * emits, and long enough to exclude the short words prose opens with.
 */
const MIN_CROSS_LINE_LENGTH = 8;

/**
 * Report whether a matched assignment value is credential-shaped.
 *
 * @param value - The value the `secret-assignment` rule captured.
 * @param sameLine - True when the separator did not cross a line break, i.e.
 *   the label and the value sit on one line. Inline assignments keep the
 *   rule's original blunt behaviour; only a value reached across a line break
 *   has to earn the mask.
 * @returns True when the value should be replaced with the placeholder.
 */
export function isCredentialShapedValue(
  value: string,
  sameLine: boolean,
): boolean {
  if (MARKDOWN_VALUE_START.test(value)) return false;
  if (sameLine) return true;
  if (QUOTED_VALUE.test(value)) return true;
  // Emphasis markers belong to the rendering, not to the value inside them.
  const scalar = value.replace(/^[*_]+/, "").replace(/[*_]+$/, "");
  return scalar.length >= MIN_CROSS_LINE_LENGTH && !PLAIN_WORD.test(scalar);
}
