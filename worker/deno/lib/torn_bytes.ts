/**
 * Shared handling for bytes a crash-recovery sets aside (Issue #1202).
 *
 * `audit_append_recovery.ts` set the rule for a torn journal tail: never
 * delete the bytes, move them to a `.torn-<n>` sidecar beside the file, and
 * quote enough of them in the report to recognise. The roster beside the
 * journal needs exactly the same rule (Issue #1202), so the two helpers
 * that implement it live here rather than being written twice.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

/** Most `.torn-<n>` sidecars one file may accumulate before we stop. */
export const MAX_TORN_SIDECARS = 100;

/**
 * How much of the discarded text a report quotes.
 *
 * The whole of it is on disk in the sidecar, so the log line only has to
 * be enough to recognise; an unbounded copy of an arbitrarily long line
 * into a log and a JSON result is not.
 */
export const DROPPED_TEXT_QUOTE = 512;

/**
 * The discarded bytes as text, quoted to a length a log can carry.
 *
 * @param dropped - Bytes the repair set aside
 * @returns The text, truncated with its full byte length named when longer
 *   than {@link DROPPED_TEXT_QUOTE}
 */
export function quoteDropped(dropped: Uint8Array): string {
  const text = new TextDecoder().decode(dropped);
  if (text.length <= DROPPED_TEXT_QUOTE) return text;
  return `${text.slice(0, DROPPED_TEXT_QUOTE)}… (${dropped.length} bytes in ` +
    `total)`;
}

/**
 * First free `.torn-<n>` sidecar path beside `path`.
 *
 * @param path - File whose torn bytes are being set aside
 * @returns A sidecar path that does not yet exist
 * @throws When every name is taken — overwriting one would destroy bytes an
 *   earlier repair preserved, so the repair refuses instead.
 */
export async function freeSidecarPath(path: string): Promise<string> {
  for (let n = 1; n <= MAX_TORN_SIDECARS; n++) {
    const candidate = `${path}.torn-${n}`;
    try {
      await Deno.stat(candidate);
    } catch (error: unknown) {
      if (error instanceof Deno.errors.NotFound) return candidate;
      throw error;
    }
  }
  throw new Error(
    `refusing to discard a torn tail from ${path}: ${MAX_TORN_SIDECARS} ` +
      `.torn-<n> sidecars already exist beside it, so the previous ones ` +
      `would have to be overwritten`,
  );
}
