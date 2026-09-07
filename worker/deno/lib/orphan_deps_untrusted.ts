/**
 * Code-level untrusted-text boundary for the orphan-deps scan's sanctioned
 * network fetch (Issue #1549).
 *
 * `orphan_deps_metadata.ts` is the narrow gate that decides **where** the
 * scan's one network exception may read from. This module is the companion
 * gate for **what comes back**: a registry `deprecated` message, a source
 * repository's description, a published EOL note are all authored by the
 * package's publisher — the very party a hostile or compromised dependency
 * puts in control. That text is quoted into a filed GitHub issue and read
 * back by a later `work-on` run, so it needs the same structural fence every
 * other untrusted-text path in this codebase already gets from
 * `prompt_delimiter.ts` (Issue #1343), rather than prompt wording alone.
 *
 * Two shapes, matching the two ways fetched text is rendered:
 *
 *   - {@link fenceFetchedMetadata} — a whole fetched document: scrubbed of
 *     delimiter/marker patterns and wrapped in a per-fetch CSPRNG boundary
 *     an attacker cannot guess, so a forged `---END UNTRUSTED …` inside the
 *     document cannot close the fence around it.
 *   - {@link scrubMetadataValue} — a single fetched field interpolated into
 *     one line of a body (a repository URL, a publish date): scrubbed and
 *     collapsed onto one line, so it can neither break out of its line nor
 *     plant a `<!-- finding-id: … -->` dedup key.
 *
 * Both cap their output: an oversized document is truncated with a visible
 * marker rather than quoted whole, so the cap is never a silent one.
 *
 * Pure — no I/O. Australian English spelling used throughout (behaviour,
 * organisation, authorised).
 */

import {
  fenceUntrustedIssueText,
  scrubUntrustedText,
} from "./prompt_delimiter.ts";

/** Longest excerpt quoted from a single fetched document. */
export const MAX_FENCED_METADATA_CHARS = 2000;

/** Longest single-line value rendered from one fetched metadata field. */
export const MAX_METADATA_VALUE_CHARS = 200;

/**
 * Truncate `text` to `max` characters, marking the cut so a reader (and a
 * reviewer) sees that the quote is partial. Never a silent cap.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated after ${max} characters]`;
}

/**
 * Fence a fetched metadata document as untrusted data.
 *
 * The text is truncated first, then scrubbed and wrapped by
 * {@link fenceUntrustedIssueText} — so a marker split by the truncation is
 * still neutralised by the scrub that follows it.
 *
 * @param text - The fetched document text
 * @param label - Markdown line introducing the block
 * @param boundaryId - Optional pinned boundary id (tests only); production
 *                     omits it and a fresh CSPRNG nonce is minted per fetch
 * @returns The fenced block as a single string
 */
export function fenceFetchedMetadata(
  text: string,
  label: string,
  boundaryId?: string,
): string {
  const bounded = truncate(text, MAX_FENCED_METADATA_CHARS);
  return fenceUntrustedIssueText(bounded, label, boundaryId).join("\n");
}

/**
 * Render one fetched metadata field safe for interpolation into a body line.
 *
 * Scrubs delimiter and HTML-comment patterns, collapses every line
 * terminator and other control/format character to a space so the value
 * cannot break the line it sits on (or open a Markdown heading below it),
 * and caps the length visibly.
 *
 * @param value - The fetched field value
 * @returns A single-line value safe to interpolate
 */
export function scrubMetadataValue(value: string): string {
  const scrubbed = scrubUntrustedText(value)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim();
  return truncate(scrubbed, MAX_METADATA_VALUE_CHARS);
}
