/**
 * Shared CI log tail truncation (extracted for Issue #3581).
 *
 * Both the PR CI-fix flow (`pr_failure_actions.ts`) and the issue-mode
 * CI-failure flow (`ci_failure_issue.ts`) render a bounded slice of a
 * build's console log into a Claude prompt. The tail is the useful part
 * — failures surface at the end — so truncation always preserves it.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

/**
 * Truncate `text` so its UTF-8 byte length does not exceed `maxBytes`,
 * preserving the **tail**. When truncation occurs a single-line marker is
 * prepended so the reader knows content was dropped.
 */
export function truncateLogTail(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;

  const marker = `[...truncated ${
    bytes.length - maxBytes
  } bytes — showing tail...]\n`;
  const markerBytes = encoder.encode(marker);
  const budget = Math.max(0, maxBytes - markerBytes.length);
  // Slice at a UTF-8 boundary by decoding with `fatal: false`.
  const tail = bytes.subarray(bytes.length - budget);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(tail);
  return marker + decoded;
}
