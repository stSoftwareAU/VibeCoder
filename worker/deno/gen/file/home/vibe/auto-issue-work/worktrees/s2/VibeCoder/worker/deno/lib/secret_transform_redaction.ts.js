/**
 * Decode-then-rescan redaction for transformed secrets (Issue #188).
 *
 * Every rule in `secret_redaction.ts` anchors on the *original* bytes of a
 * credential — the `ghp_` / `sk-ant-` / `AIzaSy` prefixes, a PEM marker, a
 * `Bearer ` scheme, a `KEY=value` shape. A credential piped through
 * `base64`, `xxd` or `rev`, or printed in two halves by two `echo` calls,
 * carries none of those bytes, so it matched no rule and was republished
 * verbatim — including through `gh_body_redaction.ts`, which guards the
 * worker's public GitHub sinks.
 *
 * This module closes that gap by *undoing* the cheap reversible transforms
 * before the signature rules get their say: each candidate run of
 * encoding-charset characters is decoded (base64, url-safe base64, hex),
 * reversed, and re-scanned; a run that hides a secret under up to
 * {@link MAX_TRANSFORM_DEPTH} such transforms is masked whole.
 *
 * ```mermaid
 * flowchart LR
 *     T["text"] --> R["signature rules<br/>(secret_redaction.ts)"]
 *     R --> C["candidate runs<br/>[A-Za-z0-9+/=_-] (line-joined)"]
 *     C --> D["decode: base64 · base64url · hex · reverse"]
 *     D -->|"hit"| M["***REDACTED***"]
 *     D -->|"no hit"| K["left byte-for-byte alone"]
 * ```
 *
 * Design notes:
 *  - **No entropy heuristic.** A "high-entropy string" backstop would mask
 *    commit SHAs, UUIDs, patch blobs and base64 images in every log line and
 *    PR body. Decoding is deterministic: a run is masked only when a decode
 *    of it matches a real credential signature, so benign blobs stay
 *    readable.
 *  - **Linear in the input** (the Issue #3942 standard). Candidate runs are
 *    disjoint, every decode is a single linear pass, and the transform fan-out
 *    is a fixed constant (four transforms, depth two). No input cap is
 *    applied: SECURITY.md's redact-before-truncate standard requires the whole
 *    text to be scanned.
 *  - **No silent skips.** A run is only left alone when a decode genuinely
 *    produced no secret; malformed base64/hex means "not that encoding", not
 *    "assume clean".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /** Reports whether `text` contains a secret matching a signature rule. */ /**
 * Shortest candidate worth decoding. The shortest credential any rule
 * recognises is ~20 characters, and every encoding of it is longer, so a
 * shorter run cannot hide one — while the bound keeps ordinary words out of
 * the decode path.
 */ export const CANDIDATE_MIN_LENGTH = 16;
/**
 * How many transforms deep the scan unwinds. Depth 2 covers the chained
 * spellings that a depth-1 scan would miss (`base64 | rev`, `base64 |
 * base64`) at a fixed, bounded cost.
 */ export const MAX_TRANSFORM_DEPTH = 2;
/** Shortest decode worth re-scanning; below this no credential fits. */ const MIN_DECODED_LENGTH = 12;
/**
 * A run of characters that could be an encoded secret, optionally continued
 * on following lines so a wrapped `base64` blob — or a credential split
 * across two `echo` calls — is decoded as one value. Only whole runs are
 * joined, and each segment is a single unbroken charset run, so wrapped prose
 * (which contains spaces and punctuation) never joins into a candidate.
 *
 * The two quantified classes cannot match `\r` or `\n`, so the outer
 * repetition has no ambiguity to backtrack over: the pattern is linear.
 */ const CANDIDATE_PATTERN = /[A-Za-z0-9+/=_-]{4,}(?:\r?\n[A-Za-z0-9+/=_-]{4,})*/g;
/**
 * Mask every run of `text` that hides a secret under a reversible transform.
 *
 * @param text - Text that has already been through the signature rules.
 * @param containsSecret - Signature scan applied to each decoded candidate.
 * @param placeholder - Replacement substituted for a run that hides a secret.
 * @returns The text with transformed secrets masked. Runs that decode to
 *   nothing secret — and every character outside a candidate run — are
 *   returned byte-for-byte unchanged.
 */ export function redactTransformedSecrets(text, containsSecret, placeholder) {
  if (!text) return text;
  return text.replace(CANDIDATE_PATTERN, (match)=>{
    const joined = match.replace(/\r?\n/g, "");
    if (joined.length < CANDIDATE_MIN_LENGTH) return match;
    return hidesSecret(joined, containsSecret, MAX_TRANSFORM_DEPTH) ? placeholder : match;
  });
}
/**
 * Does `value` contain a secret, either directly or under at most `depth`
 * reversible transforms?
 */ function hidesSecret(value, containsSecret, depth) {
  if (containsSecret(value)) return true;
  if (depth <= 0) return false;
  for (const decoded of reversibleDecodings(value)){
    if (hidesSecret(decoded, containsSecret, depth - 1)) return true;
  }
  return false;
}
/**
 * Every distinct decoding of `value` this pass knows how to undo: `rev`,
 * base64, url-safe base64 and hex. Encodings that do not apply return
 * nothing — a value that is not valid base64 simply was not base64.
 *
 * @param value - A candidate run with any line breaks already removed.
 * @returns The decodings, deduplicated and excluding `value` itself.
 */ export function reversibleDecodings(value) {
  const out = [];
  const seen = new Set([
    value
  ]);
  const candidates = [
    reverseText(value),
    decodeBase64(value),
    decodeBase64Url(value),
    decodeHex(value)
  ];
  for (const decoded of candidates){
    if (decoded === null || decoded.length < MIN_DECODED_LENGTH) continue;
    if (seen.has(decoded)) continue;
    seen.add(decoded);
    out.push(decoded);
  }
  return out;
}
/** Reverse `value` the way `rev` does. Candidates are ASCII by construction. */ function reverseText(value) {
  return value.split("").reverse().join("");
}
/** Decode standard base64, or null when `value` is not standard base64. */ function decodeBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  return decodeBase64Body(value);
}
/** Decode url-safe base64, or null when `value` is not url-safe base64. */ function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  return decodeBase64Body(value.replaceAll("-", "+").replaceAll("_", "/"));
}
/**
 * Decode a standard-alphabet base64 body, re-padding it first so an unpadded
 * blob (the shape a shell pipeline often produces) still decodes.
 */ function decodeBase64Body(value) {
  const body = value.replace(/=+$/, "");
  // A length of 4n+1 encodes no whole byte: not base64, whatever it looks like.
  if (body.length < 16 || body.length % 4 === 1) return null;
  try {
    return atob(body.padEnd(Math.ceil(body.length / 4) * 4, "="));
  } catch  {
    return null;
  }
}
/** Decode `xxd -p`-style hex, or null when `value` is not hex. */ function decodeHex(value) {
  if (value.length % 2 !== 0 || value.length < MIN_DECODED_LENGTH * 2) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  const bytes = [];
  for(let i = 0; i < value.length; i += 2){
    bytes.push(String.fromCharCode(parseInt(value.substring(i, i + 2), 16)));
  }
  return bytes.join("");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zZWNyZXRfdHJhbnNmb3JtX3JlZGFjdGlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERlY29kZS10aGVuLXJlc2NhbiByZWRhY3Rpb24gZm9yIHRyYW5zZm9ybWVkIHNlY3JldHMgKElzc3VlICMxODgpLlxuICpcbiAqIEV2ZXJ5IHJ1bGUgaW4gYHNlY3JldF9yZWRhY3Rpb24udHNgIGFuY2hvcnMgb24gdGhlICpvcmlnaW5hbCogYnl0ZXMgb2YgYVxuICogY3JlZGVudGlhbCDigJQgdGhlIGBnaHBfYCAvIGBzay1hbnQtYCAvIGBBSXphU3lgIHByZWZpeGVzLCBhIFBFTSBtYXJrZXIsIGFcbiAqIGBCZWFyZXIgYCBzY2hlbWUsIGEgYEtFWT12YWx1ZWAgc2hhcGUuIEEgY3JlZGVudGlhbCBwaXBlZCB0aHJvdWdoXG4gKiBgYmFzZTY0YCwgYHh4ZGAgb3IgYHJldmAsIG9yIHByaW50ZWQgaW4gdHdvIGhhbHZlcyBieSB0d28gYGVjaG9gIGNhbGxzLFxuICogY2FycmllcyBub25lIG9mIHRob3NlIGJ5dGVzLCBzbyBpdCBtYXRjaGVkIG5vIHJ1bGUgYW5kIHdhcyByZXB1Ymxpc2hlZFxuICogdmVyYmF0aW0g4oCUIGluY2x1ZGluZyB0aHJvdWdoIGBnaF9ib2R5X3JlZGFjdGlvbi50c2AsIHdoaWNoIGd1YXJkcyB0aGVcbiAqIHdvcmtlcidzIHB1YmxpYyBHaXRIdWIgc2lua3MuXG4gKlxuICogVGhpcyBtb2R1bGUgY2xvc2VzIHRoYXQgZ2FwIGJ5ICp1bmRvaW5nKiB0aGUgY2hlYXAgcmV2ZXJzaWJsZSB0cmFuc2Zvcm1zXG4gKiBiZWZvcmUgdGhlIHNpZ25hdHVyZSBydWxlcyBnZXQgdGhlaXIgc2F5OiBlYWNoIGNhbmRpZGF0ZSBydW4gb2ZcbiAqIGVuY29kaW5nLWNoYXJzZXQgY2hhcmFjdGVycyBpcyBkZWNvZGVkIChiYXNlNjQsIHVybC1zYWZlIGJhc2U2NCwgaGV4KSxcbiAqIHJldmVyc2VkLCBhbmQgcmUtc2Nhbm5lZDsgYSBydW4gdGhhdCBoaWRlcyBhIHNlY3JldCB1bmRlciB1cCB0b1xuICoge0BsaW5rIE1BWF9UUkFOU0ZPUk1fREVQVEh9IHN1Y2ggdHJhbnNmb3JtcyBpcyBtYXNrZWQgd2hvbGUuXG4gKlxuICogYGBgbWVybWFpZFxuICogZmxvd2NoYXJ0IExSXG4gKiAgICAgVFtcInRleHRcIl0gLS0+IFJbXCJzaWduYXR1cmUgcnVsZXM8YnIvPihzZWNyZXRfcmVkYWN0aW9uLnRzKVwiXVxuICogICAgIFIgLS0+IENbXCJjYW5kaWRhdGUgcnVuczxici8+W0EtWmEtejAtOSsvPV8tXSAobGluZS1qb2luZWQpXCJdXG4gKiAgICAgQyAtLT4gRFtcImRlY29kZTogYmFzZTY0IMK3IGJhc2U2NHVybCDCtyBoZXggwrcgcmV2ZXJzZVwiXVxuICogICAgIEQgLS0+fFwiaGl0XCJ8IE1bXCIqKipSRURBQ1RFRCoqKlwiXVxuICogICAgIEQgLS0+fFwibm8gaGl0XCJ8IEtbXCJsZWZ0IGJ5dGUtZm9yLWJ5dGUgYWxvbmVcIl1cbiAqIGBgYFxuICpcbiAqIERlc2lnbiBub3RlczpcbiAqICAtICoqTm8gZW50cm9weSBoZXVyaXN0aWMuKiogQSBcImhpZ2gtZW50cm9weSBzdHJpbmdcIiBiYWNrc3RvcCB3b3VsZCBtYXNrXG4gKiAgICBjb21taXQgU0hBcywgVVVJRHMsIHBhdGNoIGJsb2JzIGFuZCBiYXNlNjQgaW1hZ2VzIGluIGV2ZXJ5IGxvZyBsaW5lIGFuZFxuICogICAgUFIgYm9keS4gRGVjb2RpbmcgaXMgZGV0ZXJtaW5pc3RpYzogYSBydW4gaXMgbWFza2VkIG9ubHkgd2hlbiBhIGRlY29kZVxuICogICAgb2YgaXQgbWF0Y2hlcyBhIHJlYWwgY3JlZGVudGlhbCBzaWduYXR1cmUsIHNvIGJlbmlnbiBibG9icyBzdGF5XG4gKiAgICByZWFkYWJsZS5cbiAqICAtICoqTGluZWFyIGluIHRoZSBpbnB1dCoqICh0aGUgSXNzdWUgIzM5NDIgc3RhbmRhcmQpLiBDYW5kaWRhdGUgcnVucyBhcmVcbiAqICAgIGRpc2pvaW50LCBldmVyeSBkZWNvZGUgaXMgYSBzaW5nbGUgbGluZWFyIHBhc3MsIGFuZCB0aGUgdHJhbnNmb3JtIGZhbi1vdXRcbiAqICAgIGlzIGEgZml4ZWQgY29uc3RhbnQgKGZvdXIgdHJhbnNmb3JtcywgZGVwdGggdHdvKS4gTm8gaW5wdXQgY2FwIGlzXG4gKiAgICBhcHBsaWVkOiBTRUNVUklUWS5tZCdzIHJlZGFjdC1iZWZvcmUtdHJ1bmNhdGUgc3RhbmRhcmQgcmVxdWlyZXMgdGhlIHdob2xlXG4gKiAgICB0ZXh0IHRvIGJlIHNjYW5uZWQuXG4gKiAgLSAqKk5vIHNpbGVudCBza2lwcy4qKiBBIHJ1biBpcyBvbmx5IGxlZnQgYWxvbmUgd2hlbiBhIGRlY29kZSBnZW51aW5lbHlcbiAqICAgIHByb2R1Y2VkIG5vIHNlY3JldDsgbWFsZm9ybWVkIGJhc2U2NC9oZXggbWVhbnMgXCJub3QgdGhhdCBlbmNvZGluZ1wiLCBub3RcbiAqICAgIFwiYXNzdW1lIGNsZWFuXCIuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuLyoqIFJlcG9ydHMgd2hldGhlciBgdGV4dGAgY29udGFpbnMgYSBzZWNyZXQgbWF0Y2hpbmcgYSBzaWduYXR1cmUgcnVsZS4gKi9cbmV4cG9ydCB0eXBlIFNlY3JldFNjYW5uZXIgPSAodGV4dDogc3RyaW5nKSA9PiBib29sZWFuO1xuXG4vKipcbiAqIFNob3J0ZXN0IGNhbmRpZGF0ZSB3b3J0aCBkZWNvZGluZy4gVGhlIHNob3J0ZXN0IGNyZWRlbnRpYWwgYW55IHJ1bGVcbiAqIHJlY29nbmlzZXMgaXMgfjIwIGNoYXJhY3RlcnMsIGFuZCBldmVyeSBlbmNvZGluZyBvZiBpdCBpcyBsb25nZXIsIHNvIGFcbiAqIHNob3J0ZXIgcnVuIGNhbm5vdCBoaWRlIG9uZSDigJQgd2hpbGUgdGhlIGJvdW5kIGtlZXBzIG9yZGluYXJ5IHdvcmRzIG91dCBvZlxuICogdGhlIGRlY29kZSBwYXRoLlxuICovXG5leHBvcnQgY29uc3QgQ0FORElEQVRFX01JTl9MRU5HVEggPSAxNjtcblxuLyoqXG4gKiBIb3cgbWFueSB0cmFuc2Zvcm1zIGRlZXAgdGhlIHNjYW4gdW53aW5kcy4gRGVwdGggMiBjb3ZlcnMgdGhlIGNoYWluZWRcbiAqIHNwZWxsaW5ncyB0aGF0IGEgZGVwdGgtMSBzY2FuIHdvdWxkIG1pc3MgKGBiYXNlNjQgfCByZXZgLCBgYmFzZTY0IHxcbiAqIGJhc2U2NGApIGF0IGEgZml4ZWQsIGJvdW5kZWQgY29zdC5cbiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9UUkFOU0ZPUk1fREVQVEggPSAyO1xuXG4vKiogU2hvcnRlc3QgZGVjb2RlIHdvcnRoIHJlLXNjYW5uaW5nOyBiZWxvdyB0aGlzIG5vIGNyZWRlbnRpYWwgZml0cy4gKi9cbmNvbnN0IE1JTl9ERUNPREVEX0xFTkdUSCA9IDEyO1xuXG4vKipcbiAqIEEgcnVuIG9mIGNoYXJhY3RlcnMgdGhhdCBjb3VsZCBiZSBhbiBlbmNvZGVkIHNlY3JldCwgb3B0aW9uYWxseSBjb250aW51ZWRcbiAqIG9uIGZvbGxvd2luZyBsaW5lcyBzbyBhIHdyYXBwZWQgYGJhc2U2NGAgYmxvYiDigJQgb3IgYSBjcmVkZW50aWFsIHNwbGl0XG4gKiBhY3Jvc3MgdHdvIGBlY2hvYCBjYWxscyDigJQgaXMgZGVjb2RlZCBhcyBvbmUgdmFsdWUuIE9ubHkgd2hvbGUgcnVucyBhcmVcbiAqIGpvaW5lZCwgYW5kIGVhY2ggc2VnbWVudCBpcyBhIHNpbmdsZSB1bmJyb2tlbiBjaGFyc2V0IHJ1biwgc28gd3JhcHBlZCBwcm9zZVxuICogKHdoaWNoIGNvbnRhaW5zIHNwYWNlcyBhbmQgcHVuY3R1YXRpb24pIG5ldmVyIGpvaW5zIGludG8gYSBjYW5kaWRhdGUuXG4gKlxuICogVGhlIHR3byBxdWFudGlmaWVkIGNsYXNzZXMgY2Fubm90IG1hdGNoIGBcXHJgIG9yIGBcXG5gLCBzbyB0aGUgb3V0ZXJcbiAqIHJlcGV0aXRpb24gaGFzIG5vIGFtYmlndWl0eSB0byBiYWNrdHJhY2sgb3ZlcjogdGhlIHBhdHRlcm4gaXMgbGluZWFyLlxuICovXG5jb25zdCBDQU5ESURBVEVfUEFUVEVSTiA9IC9bQS1aYS16MC05Ky89Xy1dezQsfSg/Olxccj9cXG5bQS1aYS16MC05Ky89Xy1dezQsfSkqL2c7XG5cbi8qKlxuICogTWFzayBldmVyeSBydW4gb2YgYHRleHRgIHRoYXQgaGlkZXMgYSBzZWNyZXQgdW5kZXIgYSByZXZlcnNpYmxlIHRyYW5zZm9ybS5cbiAqXG4gKiBAcGFyYW0gdGV4dCAtIFRleHQgdGhhdCBoYXMgYWxyZWFkeSBiZWVuIHRocm91Z2ggdGhlIHNpZ25hdHVyZSBydWxlcy5cbiAqIEBwYXJhbSBjb250YWluc1NlY3JldCAtIFNpZ25hdHVyZSBzY2FuIGFwcGxpZWQgdG8gZWFjaCBkZWNvZGVkIGNhbmRpZGF0ZS5cbiAqIEBwYXJhbSBwbGFjZWhvbGRlciAtIFJlcGxhY2VtZW50IHN1YnN0aXR1dGVkIGZvciBhIHJ1biB0aGF0IGhpZGVzIGEgc2VjcmV0LlxuICogQHJldHVybnMgVGhlIHRleHQgd2l0aCB0cmFuc2Zvcm1lZCBzZWNyZXRzIG1hc2tlZC4gUnVucyB0aGF0IGRlY29kZSB0b1xuICogICBub3RoaW5nIHNlY3JldCDigJQgYW5kIGV2ZXJ5IGNoYXJhY3RlciBvdXRzaWRlIGEgY2FuZGlkYXRlIHJ1biDigJQgYXJlXG4gKiAgIHJldHVybmVkIGJ5dGUtZm9yLWJ5dGUgdW5jaGFuZ2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVkYWN0VHJhbnNmb3JtZWRTZWNyZXRzKFxuICB0ZXh0OiBzdHJpbmcsXG4gIGNvbnRhaW5zU2VjcmV0OiBTZWNyZXRTY2FubmVyLFxuICBwbGFjZWhvbGRlcjogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgaWYgKCF0ZXh0KSByZXR1cm4gdGV4dDtcbiAgcmV0dXJuIHRleHQucmVwbGFjZShDQU5ESURBVEVfUEFUVEVSTiwgKG1hdGNoKSA9PiB7XG4gICAgY29uc3Qgam9pbmVkID0gbWF0Y2gucmVwbGFjZSgvXFxyP1xcbi9nLCBcIlwiKTtcbiAgICBpZiAoam9pbmVkLmxlbmd0aCA8IENBTkRJREFURV9NSU5fTEVOR1RIKSByZXR1cm4gbWF0Y2g7XG4gICAgcmV0dXJuIGhpZGVzU2VjcmV0KGpvaW5lZCwgY29udGFpbnNTZWNyZXQsIE1BWF9UUkFOU0ZPUk1fREVQVEgpXG4gICAgICA/IHBsYWNlaG9sZGVyXG4gICAgICA6IG1hdGNoO1xuICB9KTtcbn1cblxuLyoqXG4gKiBEb2VzIGB2YWx1ZWAgY29udGFpbiBhIHNlY3JldCwgZWl0aGVyIGRpcmVjdGx5IG9yIHVuZGVyIGF0IG1vc3QgYGRlcHRoYFxuICogcmV2ZXJzaWJsZSB0cmFuc2Zvcm1zP1xuICovXG5mdW5jdGlvbiBoaWRlc1NlY3JldChcbiAgdmFsdWU6IHN0cmluZyxcbiAgY29udGFpbnNTZWNyZXQ6IFNlY3JldFNjYW5uZXIsXG4gIGRlcHRoOiBudW1iZXIsXG4pOiBib29sZWFuIHtcbiAgaWYgKGNvbnRhaW5zU2VjcmV0KHZhbHVlKSkgcmV0dXJuIHRydWU7XG4gIGlmIChkZXB0aCA8PSAwKSByZXR1cm4gZmFsc2U7XG4gIGZvciAoY29uc3QgZGVjb2RlZCBvZiByZXZlcnNpYmxlRGVjb2RpbmdzKHZhbHVlKSkge1xuICAgIGlmIChoaWRlc1NlY3JldChkZWNvZGVkLCBjb250YWluc1NlY3JldCwgZGVwdGggLSAxKSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIEV2ZXJ5IGRpc3RpbmN0IGRlY29kaW5nIG9mIGB2YWx1ZWAgdGhpcyBwYXNzIGtub3dzIGhvdyB0byB1bmRvOiBgcmV2YCxcbiAqIGJhc2U2NCwgdXJsLXNhZmUgYmFzZTY0IGFuZCBoZXguIEVuY29kaW5ncyB0aGF0IGRvIG5vdCBhcHBseSByZXR1cm5cbiAqIG5vdGhpbmcg4oCUIGEgdmFsdWUgdGhhdCBpcyBub3QgdmFsaWQgYmFzZTY0IHNpbXBseSB3YXMgbm90IGJhc2U2NC5cbiAqXG4gKiBAcGFyYW0gdmFsdWUgLSBBIGNhbmRpZGF0ZSBydW4gd2l0aCBhbnkgbGluZSBicmVha3MgYWxyZWFkeSByZW1vdmVkLlxuICogQHJldHVybnMgVGhlIGRlY29kaW5ncywgZGVkdXBsaWNhdGVkIGFuZCBleGNsdWRpbmcgYHZhbHVlYCBpdHNlbGYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXZlcnNpYmxlRGVjb2RpbmdzKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPihbdmFsdWVdKTtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IFtcbiAgICByZXZlcnNlVGV4dCh2YWx1ZSksXG4gICAgZGVjb2RlQmFzZTY0KHZhbHVlKSxcbiAgICBkZWNvZGVCYXNlNjRVcmwodmFsdWUpLFxuICAgIGRlY29kZUhleCh2YWx1ZSksXG4gIF07XG4gIGZvciAoY29uc3QgZGVjb2RlZCBvZiBjYW5kaWRhdGVzKSB7XG4gICAgaWYgKGRlY29kZWQgPT09IG51bGwgfHwgZGVjb2RlZC5sZW5ndGggPCBNSU5fREVDT0RFRF9MRU5HVEgpIGNvbnRpbnVlO1xuICAgIGlmIChzZWVuLmhhcyhkZWNvZGVkKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQoZGVjb2RlZCk7XG4gICAgb3V0LnB1c2goZGVjb2RlZCk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFJldmVyc2UgYHZhbHVlYCB0aGUgd2F5IGByZXZgIGRvZXMuIENhbmRpZGF0ZXMgYXJlIEFTQ0lJIGJ5IGNvbnN0cnVjdGlvbi4gKi9cbmZ1bmN0aW9uIHJldmVyc2VUZXh0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUuc3BsaXQoXCJcIikucmV2ZXJzZSgpLmpvaW4oXCJcIik7XG59XG5cbi8qKiBEZWNvZGUgc3RhbmRhcmQgYmFzZTY0LCBvciBudWxsIHdoZW4gYHZhbHVlYCBpcyBub3Qgc3RhbmRhcmQgYmFzZTY0LiAqL1xuZnVuY3Rpb24gZGVjb2RlQmFzZTY0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCEvXltBLVphLXowLTkrL10rPXswLDJ9JC8udGVzdCh2YWx1ZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gZGVjb2RlQmFzZTY0Qm9keSh2YWx1ZSk7XG59XG5cbi8qKiBEZWNvZGUgdXJsLXNhZmUgYmFzZTY0LCBvciBudWxsIHdoZW4gYHZhbHVlYCBpcyBub3QgdXJsLXNhZmUgYmFzZTY0LiAqL1xuZnVuY3Rpb24gZGVjb2RlQmFzZTY0VXJsKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCEvXltBLVphLXowLTlfLV0rPXswLDJ9JC8udGVzdCh2YWx1ZSkpIHJldHVybiBudWxsO1xuICByZXR1cm4gZGVjb2RlQmFzZTY0Qm9keSh2YWx1ZS5yZXBsYWNlQWxsKFwiLVwiLCBcIitcIikucmVwbGFjZUFsbChcIl9cIiwgXCIvXCIpKTtcbn1cblxuLyoqXG4gKiBEZWNvZGUgYSBzdGFuZGFyZC1hbHBoYWJldCBiYXNlNjQgYm9keSwgcmUtcGFkZGluZyBpdCBmaXJzdCBzbyBhbiB1bnBhZGRlZFxuICogYmxvYiAodGhlIHNoYXBlIGEgc2hlbGwgcGlwZWxpbmUgb2Z0ZW4gcHJvZHVjZXMpIHN0aWxsIGRlY29kZXMuXG4gKi9cbmZ1bmN0aW9uIGRlY29kZUJhc2U2NEJvZHkodmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBib2R5ID0gdmFsdWUucmVwbGFjZSgvPSskLywgXCJcIik7XG4gIC8vIEEgbGVuZ3RoIG9mIDRuKzEgZW5jb2RlcyBubyB3aG9sZSBieXRlOiBub3QgYmFzZTY0LCB3aGF0ZXZlciBpdCBsb29rcyBsaWtlLlxuICBpZiAoYm9keS5sZW5ndGggPCAxNiB8fCBib2R5Lmxlbmd0aCAlIDQgPT09IDEpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIHJldHVybiBhdG9iKGJvZHkucGFkRW5kKE1hdGguY2VpbChib2R5Lmxlbmd0aCAvIDQpICogNCwgXCI9XCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqIERlY29kZSBgeHhkIC1wYC1zdHlsZSBoZXgsIG9yIG51bGwgd2hlbiBgdmFsdWVgIGlzIG5vdCBoZXguICovXG5mdW5jdGlvbiBkZWNvZGVIZXgodmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAodmFsdWUubGVuZ3RoICUgMiAhPT0gMCB8fCB2YWx1ZS5sZW5ndGggPCBNSU5fREVDT0RFRF9MRU5HVEggKiAyKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKCEvXlswLTlhLWZBLUZdKyQvLnRlc3QodmFsdWUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgYnl0ZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdmFsdWUubGVuZ3RoOyBpICs9IDIpIHtcbiAgICBieXRlcy5wdXNoKFN0cmluZy5mcm9tQ2hhckNvZGUocGFyc2VJbnQodmFsdWUuc3Vic3RyaW5nKGksIGkgKyAyKSwgMTYpKSk7XG4gIH1cbiAgcmV0dXJuIGJ5dGVzLmpvaW4oXCJcIik7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTBDQyxHQUVELHdFQUF3RSxHQUd4RTs7Ozs7Q0FLQyxHQUNELE9BQU8sTUFBTSx1QkFBdUIsR0FBRztBQUV2Qzs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLHNCQUFzQixFQUFFO0FBRXJDLHNFQUFzRSxHQUN0RSxNQUFNLHFCQUFxQjtBQUUzQjs7Ozs7Ozs7O0NBU0MsR0FDRCxNQUFNLG9CQUFvQjtBQUUxQjs7Ozs7Ozs7O0NBU0MsR0FDRCxPQUFPLFNBQVMseUJBQ2QsSUFBWSxFQUNaLGNBQTZCLEVBQzdCLFdBQW1CO0VBRW5CLElBQUksQ0FBQyxNQUFNLE9B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
// denoCacheMetadata=9078336923685795410,8888358030606171219