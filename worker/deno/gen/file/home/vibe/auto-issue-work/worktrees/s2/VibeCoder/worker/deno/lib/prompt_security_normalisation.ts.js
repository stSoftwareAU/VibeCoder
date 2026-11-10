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
 */ /**
 * Unicode format / line / paragraph separators. Invisible format
 * characters (Cf) are the zero-width interleave; Zl/Zp can hide a
 * visual line break inside a marker. Scanned one code point at a time
 * so the source file never carries a control-character regex.
 */ const FORMAT_OR_SEPARATOR_RE = /[\p{Cf}\p{Zl}\p{Zp}]/u;
/**
 * True when `code` is a C0/C1 control that is not document whitespace.
 *
 * TAB, LF and CR stay: they are Markdown/document structure. Every other
 * C0/C1 byte is stripped so it cannot split `BOUNDARY_`, `[TRUSTED]` or
 * `author=`.
 */ function isNonDocumentControl(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code <= 0x1f || code >= 0x7f && code <= 0x9f;
}
/**
 * Strip characters that must not be able to split a prompt security marker.
 *
 * @param text Arbitrary prompt-bound or prompt-derived text.
 * @returns Text with invisible format and non-document control characters
 * removed, while preserving ordinary tabs and CR/LF line structure.
 */ export function stripPromptSecurityIgnorables(text) {
  if (!text) return text;
  let out = "";
  for (const char of text){
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (isNonDocumentControl(code)) continue;
    if (FORMAT_OR_SEPARATOR_RE.test(char)) continue;
    out += char;
  }
  return out;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcm9tcHRfc2VjdXJpdHlfbm9ybWFsaXNhdGlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE5vcm1hbGlzYXRpb24gc2hhcmVkIGJ5IHByb21wdC1ib3VuZGFyeSBhbmQgcHJvbXB0LWxlYWsgZGVmZW5jZXMgKElzc3VlICMxNjQ5KS5cbiAqXG4gKiBJbnZpc2libGUgVW5pY29kZSBmb3JtYXQgY2hhcmFjdGVycyBhbmQgbm9uLXRleHQgY29udHJvbHMgY2FuIGJlIGluc2VydGVkXG4gKiBiZXR3ZWVuIHRoZSBBU0NJSSBjaGFyYWN0ZXJzIG9mIGEgdHJ1c3QgbWFya2VyIChgQk9VTkRBUllfYCwgYFtUUlVTVEVEXWAsXG4gKiBgYXV0aG9yPWApIHNvIGxpdGVyYWwgc2VjdXJpdHkgcmVnZXhlcyBuZXZlciBzZWUgdGhlIG1hcmtlciB0aGV5IGFyZSBtZWFudFxuICogdG8gbmV1dHJhbGlzZS4gUmVtb3ZlIHRob3NlIGNoYXJhY3RlcnMgYmVmb3JlIHNlY3VyaXR5IG1hdGNoaW5nLlxuICpcbiAqIEhvcml6b250YWwgdGFiIGFuZCBDUi9MRiBhcmUgZGVsaWJlcmF0ZWx5IHByZXNlcnZlZDogdGhleSBhcmUgZG9jdW1lbnRcbiAqIHN0cnVjdHVyZSB1c2VkIHRocm91Z2hvdXQgcHJvbXB0IGJvZGllcy4gVW5pY29kZSBsaW5lL3BhcmFncmFwaCBzZXBhcmF0b3JzXG4gKiBhcmUgcmVtb3ZlZCBiZWNhdXNlIHRoZXkgY2FuIGhpZGUgaW5zaWRlIGEgbWFya2VyIHdoaWxlIHJlbWFpbmluZyB2aXN1YWxseVxuICogbGluZS1saWtlLiBUaGUgb3BlcmF0aW9uIGlzIGxpbmVhciBhbmQgcHVyZS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG5vcm1hbGlzYXRpb24sIGV0Yy4pLlxuICovXG5cbi8qKlxuICogVW5pY29kZSBmb3JtYXQgLyBsaW5lIC8gcGFyYWdyYXBoIHNlcGFyYXRvcnMuIEludmlzaWJsZSBmb3JtYXRcbiAqIGNoYXJhY3RlcnMgKENmKSBhcmUgdGhlIHplcm8td2lkdGggaW50ZXJsZWF2ZTsgWmwvWnAgY2FuIGhpZGUgYVxuICogdmlzdWFsIGxpbmUgYnJlYWsgaW5zaWRlIGEgbWFya2VyLiBTY2FubmVkIG9uZSBjb2RlIHBvaW50IGF0IGEgdGltZVxuICogc28gdGhlIHNvdXJjZSBmaWxlIG5ldmVyIGNhcnJpZXMgYSBjb250cm9sLWNoYXJhY3RlciByZWdleC5cbiAqL1xuY29uc3QgRk9STUFUX09SX1NFUEFSQVRPUl9SRSA9IC9bXFxwe0NmfVxccHtabH1cXHB7WnB9XS91O1xuXG4vKipcbiAqIFRydWUgd2hlbiBgY29kZWAgaXMgYSBDMC9DMSBjb250cm9sIHRoYXQgaXMgbm90IGRvY3VtZW50IHdoaXRlc3BhY2UuXG4gKlxuICogVEFCLCBMRiBhbmQgQ1Igc3RheTogdGhleSBhcmUgTWFya2Rvd24vZG9jdW1lbnQgc3RydWN0dXJlLiBFdmVyeSBvdGhlclxuICogQzAvQzEgYnl0ZSBpcyBzdHJpcHBlZCBzbyBpdCBjYW5ub3Qgc3BsaXQgYEJPVU5EQVJZX2AsIGBbVFJVU1RFRF1gIG9yXG4gKiBgYXV0aG9yPWAuXG4gKi9cbmZ1bmN0aW9uIGlzTm9uRG9jdW1lbnRDb250cm9sKGNvZGU6IG51bWJlcik6IGJvb2xlYW4ge1xuICBpZiAoY29kZSA9PT0gMHgwOSB8fCBjb2RlID09PSAweDBhIHx8IGNvZGUgPT09IDB4MGQpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGNvZGUgPD0gMHgxZiB8fCAoY29kZSA+PSAweDdmICYmIGNvZGUgPD0gMHg5Zik7XG59XG5cbi8qKlxuICogU3RyaXAgY2hhcmFjdGVycyB0aGF0IG11c3Qgbm90IGJlIGFibGUgdG8gc3BsaXQgYSBwcm9tcHQgc2VjdXJpdHkgbWFya2VyLlxuICpcbiAqIEBwYXJhbSB0ZXh0IEFyYml0cmFyeSBwcm9tcHQtYm91bmQgb3IgcHJvbXB0LWRlcml2ZWQgdGV4dC5cbiAqIEByZXR1cm5zIFRleHQgd2l0aCBpbnZpc2libGUgZm9ybWF0IGFuZCBub24tZG9jdW1lbnQgY29udHJvbCBjaGFyYWN0ZXJzXG4gKiByZW1vdmVkLCB3aGlsZSBwcmVzZXJ2aW5nIG9yZGluYXJ5IHRhYnMgYW5kIENSL0xGIGxpbmUgc3RydWN0dXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RyaXBQcm9tcHRTZWN1cml0eUlnbm9yYWJsZXModGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCF0ZXh0KSByZXR1cm4gdGV4dDtcbiAgbGV0IG91dCA9IFwiXCI7XG4gIGZvciAoY29uc3QgY2hhciBvZiB0ZXh0KSB7XG4gICAgY29uc3QgY29kZSA9IGNoYXIuY29kZVBvaW50QXQoMCk7XG4gICAgaWYgKGNvZGUgPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgaWYgKGlzTm9uRG9jdW1lbnRDb250cm9sKGNvZGUpKSBjb250aW51ZTtcbiAgICBpZiAoRk9STUFUX09SX1NFUEFSQVRPUl9SRS50ZXN0KGNoYXIpKSBjb250aW51ZTtcbiAgICBvdXQgKz0gY2hhcjtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBRUQ7Ozs7O0NBS0MsR0FDRCxNQUFNLHlCQUF5QjtBQUUvQjs7Ozs7O0NBTUMsR0FDRCxTQUFTLHFCQUFxQixJQUFZO0VBQ3hDLElBQUksU0FBUyxRQUFRLFNBQVMsUUFBUSxTQUFTLE1BQU0sT0FBTztFQUM1RCxPQUFPLFFBQVEsUUFBUyxRQUFRLFFBQVEsUUFBUTtBQUNsRDtBQUVBOzs7Ozs7Q0FNQyxHQUNELE9BQU8sU0FBUyw4QkFBOEIsSUFBWTtFQUN4RCxJQUFJLENBQUMsTUFBTSxPQUFPO0VBQ2xCLElBQUksTUFBTTtFQUNWLEtBQUssTUFBTSxRQUFRLEtBQU07SUFDdkIsTUFBTSxPQUFPLEtBQUssV0FBVyxDQUFDO0lBQzlCLElBQUksU0FBUyxXQUFXO0lBQ3hCLElBQUkscUJBQXFCLE9BQU87SUFDaEMsSUFBSSx1QkFBdUIsSUFBSSxDQUFDLE9BQU87SUFDdkMsT0FBTztFQUNUO0VBQ0EsT0FBTztBQUNUIn0=
// denoCacheMetadata=314355307506010110,17382553207523440556