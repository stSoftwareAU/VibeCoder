/**
 * Opaque, stable pseudonyms for private fleet repositories (Issues #4780, #5354).
 *
 * A private fleet repository must not be named on a public VibeCoder issue, but
 * the issue still needs a title that is stable, so the dedup search finds the
 * one open issue, and distinct per repository. A truncated SHA-256 digest gives
 * both without revealing the name.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * The first 12 hex digits of SHA-256 over the UTF-8 bytes of `text`.
 *
 * The same text always gives the same digest, and different texts almost
 * always give different digests (48 bits), so callers can key a title on it.
 */
export async function privateRepoDigest(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return hex.slice(0, 12);
}
