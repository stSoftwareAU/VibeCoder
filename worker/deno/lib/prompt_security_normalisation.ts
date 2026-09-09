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
 * Unicode format / line / paragraph separators. Invisible format
 * characters (Cf) are the zero-width interleave; Zl/Zp can hide a
 * visual line break inside a marker. Scanned one code point at a time
 * so the source file never carries a control-character regex.
 */
const FORMAT_OR_SEPARATOR_RE = /[\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * True when `code` is a C0/C1 control that is not document whitespace.
 *
 * TAB, LF and CR stay: they are Markdown/document structure. Every other
 * C0/C1 byte is stripped so it cannot split `BOUNDARY_`, `[TRUSTED]` or
 * `author=`.
 */
function isNonDocumentControl(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Strip characters that must not be able to split a prompt security marker.
 *
 * @param text Arbitrary prompt-bound or prompt-derived text.
 * @returns Text with invisible format and non-document control characters
 * removed, while preserving ordinary tabs and CR/LF line structure.
 */
export function stripPromptSecurityIgnorables(text: string): string {
  if (!text) return text;
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (isNonDocumentControl(code)) continue;
    if (FORMAT_OR_SEPARATOR_RE.test(char)) continue;
    out += char;
  }
  return out;
}
