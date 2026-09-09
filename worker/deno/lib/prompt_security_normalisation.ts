/**
 * Normalisation shared by prompt-boundary and prompt-leak defences (Issue #1649).
 *
 * Invisible Unicode format characters and non-text controls can be inserted
 * between the ASCII characters of a trust marker (`BOUNDARY_`, `[TRUSTED]`,
 * `author=`) so literal security regexes never see the marker they are meant
 * to neutralise. Remove those characters before security matching.
 *
 * Horizontal tab and CR/LF are deliberately preserved: they are document
 * structure used throughout prompt bodies. Unicode line/paragraph separators
 * are removed because they can hide inside a marker while remaining visually
 * line-like. The operation is linear and pure.
 *
 * Uses Australian English throughout (behaviour, normalisation, etc.).
 */

/**
 * Strip characters that must not be able to split a prompt security marker.
 *
 * @param text Arbitrary prompt-bound or prompt-derived text.
 * @returns Text with invisible format and non-document control characters
 * removed, while preserving ordinary tabs and CR/LF line structure.
 */
export function stripPromptSecurityIgnorables(text: string): string {
  if (!text) return text;
  return text.replace(
    /[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/gu,
    "",
  );
}
