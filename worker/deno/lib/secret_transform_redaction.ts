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
 */

/** Reports whether `text` contains a secret matching a signature rule. */
export type SecretScanner = (text: string) => boolean;

/**
 * Shortest candidate worth decoding. The shortest credential any rule
 * recognises is ~20 characters, and every encoding of it is longer, so a
 * shorter run cannot hide one — while the bound keeps ordinary words out of
 * the decode path.
 */
export const CANDIDATE_MIN_LENGTH = 16;

/**
 * How many transforms deep the scan unwinds. Depth 2 covers the chained
 * spellings that a depth-1 scan would miss (`base64 | rev`, `base64 |
 * base64`) at a fixed, bounded cost.
 */
export const MAX_TRANSFORM_DEPTH = 2;

/** Shortest decode worth re-scanning; below this no credential fits. */
const MIN_DECODED_LENGTH = 12;

/**
 * A run of characters that could be an encoded secret, optionally continued
 * on following lines so a wrapped `base64` blob — or a credential split
 * across two `echo` calls — is decoded as one value. Only whole runs are
 * joined, and each segment is a single unbroken charset run, so wrapped prose
 * (which contains spaces and punctuation) never joins into a candidate.
 *
 * The two quantified classes cannot match `\r` or `\n`, so the outer
 * repetition has no ambiguity to backtrack over: the pattern is linear.
 */
const CANDIDATE_PATTERN = /[A-Za-z0-9+/=_-]{4,}(?:\r?\n[A-Za-z0-9+/=_-]{4,})*/g;

/**
 * Mask every run of `text` that hides a secret under a reversible transform.
 *
 * @param text - Text that has already been through the signature rules.
 * @param containsSecret - Signature scan applied to each decoded candidate.
 * @param placeholder - Replacement substituted for a run that hides a secret.
 * @returns The text with transformed secrets masked. Runs that decode to
 *   nothing secret — and every character outside a candidate run — are
 *   returned byte-for-byte unchanged.
 */
export function redactTransformedSecrets(
  text: string,
  containsSecret: SecretScanner,
  placeholder: string,
): string {
  if (!text) return text;
  return text.replace(CANDIDATE_PATTERN, (match) => {
    const joined = match.replace(/\r?\n/g, "");
    if (joined.length < CANDIDATE_MIN_LENGTH) return match;
    return hidesSecret(joined, containsSecret, MAX_TRANSFORM_DEPTH)
      ? placeholder
      : match;
  });
}

/**
 * Does `value` contain a secret, either directly or under at most `depth`
 * reversible transforms?
 */
function hidesSecret(
  value: string,
  containsSecret: SecretScanner,
  depth: number,
): boolean {
  if (containsSecret(value)) return true;
  if (depth <= 0) return false;
  for (const decoded of reversibleDecodings(value)) {
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
 */
export function reversibleDecodings(value: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([value]);
  const candidates = [
    reverseText(value),
    decodeBase64(value),
    decodeBase64Url(value),
    decodeHex(value),
  ];
  for (const decoded of candidates) {
    if (decoded === null || decoded.length < MIN_DECODED_LENGTH) continue;
    if (seen.has(decoded)) continue;
    seen.add(decoded);
    out.push(decoded);
  }
  return out;
}

/** Reverse `value` the way `rev` does. Candidates are ASCII by construction. */
function reverseText(value: string): string {
  return value.split("").reverse().join("");
}

/** Decode standard base64, or null when `value` is not standard base64. */
function decodeBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  return decodeBase64Body(value);
}

/** Decode url-safe base64, or null when `value` is not url-safe base64. */
function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  return decodeBase64Body(value.replaceAll("-", "+").replaceAll("_", "/"));
}

/**
 * Decode a standard-alphabet base64 body, re-padding it first so an unpadded
 * blob (the shape a shell pipeline often produces) still decodes.
 */
function decodeBase64Body(value: string): string | null {
  const body = value.replace(/=+$/, "");
  // A length of 4n+1 encodes no whole byte: not base64, whatever it looks like.
  if (body.length < 16 || body.length % 4 === 1) return null;
  try {
    return atob(body.padEnd(Math.ceil(body.length / 4) * 4, "="));
  } catch {
    return null;
  }
}

/** Decode `xxd -p`-style hex, or null when `value` is not hex. */
function decodeHex(value: string): string | null {
  if (value.length % 2 !== 0 || value.length < MIN_DECODED_LENGTH * 2) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  const bytes: string[] = [];
  for (let i = 0; i < value.length; i += 2) {
    bytes.push(String.fromCharCode(parseInt(value.substring(i, i + 2), 16)));
  }
  return bytes.join("");
}
