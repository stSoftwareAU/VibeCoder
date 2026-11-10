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
 */ /** Most `.torn-<n>` sidecars one file may accumulate before we stop. */ export const MAX_TORN_SIDECARS = 100;
/**
 * How much of the discarded text a report quotes.
 *
 * The whole of it is on disk in the sidecar, so the log line only has to
 * be enough to recognise; an unbounded copy of an arbitrarily long line
 * into a log and a JSON result is not.
 */ export const DROPPED_TEXT_QUOTE = 512;
/**
 * The discarded bytes as text, quoted to a length a log can carry.
 *
 * @param dropped - Bytes the repair set aside
 * @returns The text, truncated with its full byte length named when longer
 *   than {@link DROPPED_TEXT_QUOTE}
 */ export function quoteDropped(dropped) {
  const text = new TextDecoder().decode(dropped);
  if (text.length <= DROPPED_TEXT_QUOTE) return text;
  return `${text.slice(0, DROPPED_TEXT_QUOTE)}… (${dropped.length} bytes in ` + `total)`;
}
/**
 * First free `.torn-<n>` sidecar path beside `path`.
 *
 * @param path - File whose torn bytes are being set aside
 * @returns A sidecar path that does not yet exist
 * @throws When every name is taken — overwriting one would destroy bytes an
 *   earlier repair preserved, so the repair refuses instead.
 */ export async function freeSidecarPath(path) {
  for(let n = 1; n <= MAX_TORN_SIDECARS; n++){
    const candidate = `${path}.torn-${n}`;
    try {
      await Deno.stat(candidate);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return candidate;
      throw error;
    }
  }
  throw new Error(`refusing to discard a torn tail from ${path}: ${MAX_TORN_SIDECARS} ` + `.torn-<n> sidecars already exist beside it, so the previous ones ` + `would have to be overwritten`);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi90b3JuX2J5dGVzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2hhcmVkIGhhbmRsaW5nIGZvciBieXRlcyBhIGNyYXNoLXJlY292ZXJ5IHNldHMgYXNpZGUgKElzc3VlICMxMjAyKS5cbiAqXG4gKiBgYXVkaXRfYXBwZW5kX3JlY292ZXJ5LnRzYCBzZXQgdGhlIHJ1bGUgZm9yIGEgdG9ybiBqb3VybmFsIHRhaWw6IG5ldmVyXG4gKiBkZWxldGUgdGhlIGJ5dGVzLCBtb3ZlIHRoZW0gdG8gYSBgLnRvcm4tPG4+YCBzaWRlY2FyIGJlc2lkZSB0aGUgZmlsZSwgYW5kXG4gKiBxdW90ZSBlbm91Z2ggb2YgdGhlbSBpbiB0aGUgcmVwb3J0IHRvIHJlY29nbmlzZS4gVGhlIHJvc3RlciBiZXNpZGUgdGhlXG4gKiBqb3VybmFsIG5lZWRzIGV4YWN0bHkgdGhlIHNhbWUgcnVsZSAoSXNzdWUgIzEyMDIpLCBzbyB0aGUgdHdvIGhlbHBlcnNcbiAqIHRoYXQgaW1wbGVtZW50IGl0IGxpdmUgaGVyZSByYXRoZXIgdGhhbiBiZWluZyB3cml0dGVuIHR3aWNlLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uLCBhdXRob3Jpc2VkKS5cbiAqL1xuXG4vKiogTW9zdCBgLnRvcm4tPG4+YCBzaWRlY2FycyBvbmUgZmlsZSBtYXkgYWNjdW11bGF0ZSBiZWZvcmUgd2Ugc3RvcC4gKi9cbmV4cG9ydCBjb25zdCBNQVhfVE9STl9TSURFQ0FSUyA9IDEwMDtcblxuLyoqXG4gKiBIb3cgbXVjaCBvZiB0aGUgZGlzY2FyZGVkIHRleHQgYSByZXBvcnQgcXVvdGVzLlxuICpcbiAqIFRoZSB3aG9sZSBvZiBpdCBpcyBvbiBkaXNrIGluIHRoZSBzaWRlY2FyLCBzbyB0aGUgbG9nIGxpbmUgb25seSBoYXMgdG9cbiAqIGJlIGVub3VnaCB0byByZWNvZ25pc2U7IGFuIHVuYm91bmRlZCBjb3B5IG9mIGFuIGFyYml0cmFyaWx5IGxvbmcgbGluZVxuICogaW50byBhIGxvZyBhbmQgYSBKU09OIHJlc3VsdCBpcyBub3QuXG4gKi9cbmV4cG9ydCBjb25zdCBEUk9QUEVEX1RFWFRfUVVPVEUgPSA1MTI7XG5cbi8qKlxuICogVGhlIGRpc2NhcmRlZCBieXRlcyBhcyB0ZXh0LCBxdW90ZWQgdG8gYSBsZW5ndGggYSBsb2cgY2FuIGNhcnJ5LlxuICpcbiAqIEBwYXJhbSBkcm9wcGVkIC0gQnl0ZXMgdGhlIHJlcGFpciBzZXQgYXNpZGVcbiAqIEByZXR1cm5zIFRoZSB0ZXh0LCB0cnVuY2F0ZWQgd2l0aCBpdHMgZnVsbCBieXRlIGxlbmd0aCBuYW1lZCB3aGVuIGxvbmdlclxuICogICB0aGFuIHtAbGluayBEUk9QUEVEX1RFWFRfUVVPVEV9XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBxdW90ZURyb3BwZWQoZHJvcHBlZDogVWludDhBcnJheSk6IHN0cmluZyB7XG4gIGNvbnN0IHRleHQgPSBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUoZHJvcHBlZCk7XG4gIGlmICh0ZXh0Lmxlbmd0aCA8PSBEUk9QUEVEX1RFWFRfUVVPVEUpIHJldHVybiB0ZXh0O1xuICByZXR1cm4gYCR7dGV4dC5zbGljZSgwLCBEUk9QUEVEX1RFWFRfUVVPVEUpfeKApiAoJHtkcm9wcGVkLmxlbmd0aH0gYnl0ZXMgaW4gYCArXG4gICAgYHRvdGFsKWA7XG59XG5cbi8qKlxuICogRmlyc3QgZnJlZSBgLnRvcm4tPG4+YCBzaWRlY2FyIHBhdGggYmVzaWRlIGBwYXRoYC5cbiAqXG4gKiBAcGFyYW0gcGF0aCAtIEZpbGUgd2hvc2UgdG9ybiBieXRlcyBhcmUgYmVpbmcgc2V0IGFzaWRlXG4gKiBAcmV0dXJucyBBIHNpZGVjYXIgcGF0aCB0aGF0IGRvZXMgbm90IHlldCBleGlzdFxuICogQHRocm93cyBXaGVuIGV2ZXJ5IG5hbWUgaXMgdGFrZW4g4oCUIG92ZXJ3cml0aW5nIG9uZSB3b3VsZCBkZXN0cm95IGJ5dGVzIGFuXG4gKiAgIGVhcmxpZXIgcmVwYWlyIHByZXNlcnZlZCwgc28gdGhlIHJlcGFpciByZWZ1c2VzIGluc3RlYWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmcmVlU2lkZWNhclBhdGgocGF0aDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgZm9yIChsZXQgbiA9IDE7IG4gPD0gTUFYX1RPUk5fU0lERUNBUlM7IG4rKykge1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IGAke3BhdGh9LnRvcm4tJHtufWA7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IERlbm8uc3RhdChjYW5kaWRhdGUpO1xuICAgIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIGNhbmRpZGF0ZTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgYHJlZnVzaW5nIHRvIGRpc2NhcmQgYSB0b3JuIHRhaWwgZnJvbSAke3BhdGh9OiAke01BWF9UT1JOX1NJREVDQVJTfSBgICtcbiAgICAgIGAudG9ybi08bj4gc2lkZWNhcnMgYWxyZWFkeSBleGlzdCBiZXNpZGUgaXQsIHNvIHRoZSBwcmV2aW91cyBvbmVzIGAgK1xuICAgICAgYHdvdWxkIGhhdmUgdG8gYmUgb3ZlcndyaXR0ZW5gLFxuICApO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7O0NBVUMsR0FFRCxzRUFBc0UsR0FDdEUsT0FBTyxNQUFNLG9CQUFvQixJQUFJO0FBRXJDOzs7Ozs7Q0FNQyxHQUNELE9BQU8sTUFBTSxxQkFBcUIsSUFBSTtBQUV0Qzs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsYUFBYSxPQUFtQjtFQUM5QyxNQUFNLE9BQU8sSUFBSSxjQUFjLE1BQU0sQ0FBQztFQUN0QyxJQUFJLEtBQUssTUFBTSxJQUFJLG9CQUFvQixPQUFPO0VBQzlDLE9BQU8sR0FBRyxLQUFLLEtBQUssQ0FBQyxHQUFHLG9CQUFvQixHQUFHLEVBQUUsUUFBUSxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQ3pFLENBQUMsTUFBTSxDQUFDO0FBQ1o7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxlQUFlLGdCQUFnQixJQUFZO0VBQ2hELElBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxtQkFBbUIsSUFBSztJQUMzQyxNQUFNLFlBQVksR0FBRyxLQUFLLE1BQU0sRUFBRSxHQUFHO0lBQ3JDLElBQUk7TUFDRixNQUFNLEtBQUssSUFBSSxDQUFDO0lBQ2xCLEVBQUUsT0FBTyxPQUFnQjtNQUN2QixJQUFJLGlCQUFpQixLQUFLLE1BQU0sQ0FBQyxRQUFRLEVBQUUsT0FBTztNQUNsRCxNQUFNO0lBQ1I7RUFDRjtFQUNBLE1BQU0sSUFBSSxNQUNSLENBQUMscUNBQXFDLEVBQUUsS0FBSyxFQUFFLEVBQUUsa0JBQWtCLENBQUMsQ0FBQyxHQUNuRSxDQUFDLGlFQUFpRSxDQUFDLEdBQ25FLENBQUMsNEJBQTRCLENBQUM7QUFFcEMifQ==
// denoCacheMetadata=8605355080605491742,17765996722927988043