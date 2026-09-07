/**
 * Structure-preserving redaction for JSON payloads (Issue #1261).
 *
 * `issue_cache.ts` persists whole GitHub issue and PR objects, so a token
 * pasted into an issue body was written to the work volume verbatim and read
 * back into a later prompt. Running {@link redactSecrets} over the
 * *serialised* JSON is not an option: the `secret-assignment` rule matches
 * `"access_token":"…"` across the structural quotes and would leave the file
 * unparseable, turning every later read into a silent miss.
 *
 * Redacting each string **value** instead keeps the document valid by
 * construction: only the contents of a string change, never the syntax
 * around it. Object keys are left alone — they are GitHub's field names, and
 * masking one would break every consumer that looks the field up.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { redactSecrets } from "./secret_redaction.ts";

/**
 * Deepest nesting redacted. Real GitHub payloads are a handful of levels
 * deep; the cap bounds the recursion so a cyclic or pathologically nested
 * value cannot exhaust the stack.
 */
export const MAX_REDACTION_DEPTH = 64;

/**
 * Return a copy of `value` with every string redacted.
 *
 * @param value - Any JSON-serialisable value.
 * @param depth - Current nesting level; callers leave it at the default.
 * @returns The redacted copy. Anything nested deeper than
 *   {@link MAX_REDACTION_DEPTH} is dropped (replaced with `null`) rather
 *   than persisted unredacted.
 */
export function redactJsonStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (depth >= MAX_REDACTION_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonStrings(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactJsonStrings(item, depth + 1);
    }
    return out;
  }
  return value;
}
