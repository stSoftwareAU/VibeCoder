/**
 * Fence-tolerant unwrapping of a model's JSON reply (Issue #4115).
 *
 * Models often wrap JSON in a markdown code fence even when told to reply with
 * JSON only, so a bare `JSON.parse` on the reply rejects a valid payload. One
 * helper keeps every caller's fence handling identical. Plain string scanning
 * is used rather than a regex so hostile input cannot trigger backtracking.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

const FENCE = "```";
const MIN_FENCED_LENGTH = 6;

/**
 * Strip one markdown code fence around a model's JSON reply.
 *
 * By default only a reply that is entirely one fence is unwrapped; any other
 * text is returned unchanged so `JSON.parse` still rejects surrounding prose.
 * With `allowSurroundingProse`, the first fenced block is taken from anywhere
 * in the text, and the trimmed input is returned when no fenced block is found.
 *
 * @param text - Raw model reply
 * @param opts - `allowSurroundingProse` to take the first fenced block
 * @returns The text inside the fence (a leading `json` tag removed and trimmed),
 *   or the input unchanged in default mode when it is not a single fence
 */
export function unwrapJsonFence(
  text: string,
  opts?: { allowSurroundingProse?: boolean },
): string {
  if (opts?.allowSurroundingProse) return unwrapFirstFence(text);
  const trimmed = text.trim();
  if (
    trimmed.length < MIN_FENCED_LENGTH ||
    !trimmed.startsWith(FENCE) ||
    !trimmed.endsWith(FENCE)
  ) {
    return text;
  }
  return dropJsonTag(trimmed.slice(FENCE.length, -FENCE.length)).trim();
}

/** Take the text between the first fence and the next fence, if both exist. */
function unwrapFirstFence(text: string): string {
  const open = text.indexOf(FENCE);
  const close = open === -1 ? -1 : text.indexOf(FENCE, open + FENCE.length);
  if (close === -1) return text.trim();
  const inner = dropJsonTag(text.slice(open + FENCE.length, close)).trim();
  return inner === "" ? text.trim() : inner;
}

/** Remove a leading `json` language tag from fenced content. */
function dropJsonTag(inner: string): string {
  return inner.startsWith("json") ? inner.slice("json".length) : inner;
}
