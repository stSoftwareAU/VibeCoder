/**
 * Escape a literal for use inside a `RegExp` source.
 *
 * One copy, so every caller escapes the backslash along with the other
 * metacharacters (CodeQL js/incomplete-sanitization): escaping only the
 * characters a literal happens to contain today breaks the pattern the day
 * the literal gains a backslash.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/**
 * Escape every `RegExp` metacharacter in `literal`.
 *
 * @param literal - Text to match verbatim
 * @returns The text, safe to embed in a `RegExp` source
 */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
