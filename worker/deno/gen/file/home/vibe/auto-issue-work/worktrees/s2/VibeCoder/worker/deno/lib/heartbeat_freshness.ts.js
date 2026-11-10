/**
 * Is a `.heartbeat_*` file's recorded epoch actually live? (Issue #1232)
 *
 * ## Why this exists
 *
 * `${WORK_DIR}` is agent-writable, so any process that has ever run in the
 * container can drop `${WORK_DIR}/.heartbeat_a_<repo>_1` containing
 * `9999999999`. Every housekeeping reader used to ask only "is this beat no
 * older than the window?" (`now - epoch <= windowSeconds`), which a
 * future-dated epoch satisfies for the next three centuries — one such file
 * turned the disk-reclaim sweeps (Issues #228, #242, #387) off permanently,
 * and nothing on the sweep side ever aged the file out again. The host then
 * fills with no way back short of manual intervention.
 *
 * A beat is therefore live only inside a **bounded** interval: no older than
 * the window, and no further ahead of now than the clock skew a legitimate
 * writer could plausibly show. Anything beyond that upper bound is forged or
 * a badly wrong clock, and either way it must not pin a sweep off.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ /**
 * How far ahead of `now` a heartbeat epoch may sit and still count as live.
 *
 * The heartbeat file is rewritten roughly every 60 seconds by the worker
 * holding the claim, so a genuine beat is at most a few seconds ahead of a
 * reader whose clock lags. Five minutes is generous for NTP drift between
 * a container and its host, and still bounded — a forged far-future epoch
 * expires immediately rather than never.
 */ export const HEARTBEAT_FUTURE_SKEW_SECONDS = 300;
/**
 * How recent a beat must be for its claim to count as live — the single
 * definition shared by the work-volume sweeps.
 */ export const DEFAULT_HEARTBEAT_LIVE_WINDOW_SECONDS = 900;
/**
 * Parse the epoch a heartbeat file carries, or null when the content is not
 * one.
 *
 * Digits only: the file is written with `String(epoch)`, and refusing
 * anything else keeps a partially-written or hand-crafted file from being
 * read as a timestamp. A value too large to be a plausible second-precision
 * epoch is rejected here as well, so the bound below cannot be sidestepped
 * with a millisecond-scale number.
 */ export function parseHeartbeatEpoch(raw) {
  const text = raw.trim();
  if (!/^\d{1,12}$/.test(text)) return null;
  const epoch = Number(text);
  return Number.isFinite(epoch) ? epoch : null;
}
/**
 * True when `epoch` names a beat inside `[now - windowSeconds, now + skew]`.
 *
 * Both ends matter: the lower bound ages a stale claim out (as before), and
 * the upper bound is what stops a forged future epoch from claiming
 * liveness for ever.
 */ export function isHeartbeatEpochLive(epoch, now, windowSeconds, skewSeconds = HEARTBEAT_FUTURE_SKEW_SECONDS) {
  if (!Number.isFinite(epoch)) return false;
  const age = now - epoch;
  // Ahead of now by more than the tolerated skew — forged, or a clock so
  // wrong its beat says nothing about liveness.
  if (age < -Math.abs(skewSeconds)) return false;
  return age <= windowSeconds;
}
/**
 * Read a heartbeat file and say whether its beat is live.
 *
 * An unreadable or unparseable file falls back to the file's own mtime, so
 * the microsecond window in which a live worker's rewrite leaves the file
 * empty does not read as "not running". The fallback is bounded by the same
 * window and skew, so a forged file still expires.
 */ export async function isHeartbeatFileLive(path, now, windowSeconds) {
  let epoch = null;
  try {
    epoch = parseHeartbeatEpoch(await Deno.readTextFile(path));
  } catch  {
  // Unreadable — fall through to the mtime fallback.
  }
  if (epoch === null) {
    try {
      const stat = await Deno.stat(path);
      epoch = stat.mtime ? Math.floor(stat.mtime.getTime() / 1000) : null;
    } catch  {
      return false;
    }
  }
  if (epoch === null) return false;
  return isHeartbeatEpochLive(epoch, now, windowSeconds);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9oZWFydGJlYXRfZnJlc2huZXNzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogSXMgYSBgLmhlYXJ0YmVhdF8qYCBmaWxlJ3MgcmVjb3JkZWQgZXBvY2ggYWN0dWFsbHkgbGl2ZT8gKElzc3VlICMxMjMyKVxuICpcbiAqICMjIFdoeSB0aGlzIGV4aXN0c1xuICpcbiAqIGAke1dPUktfRElSfWAgaXMgYWdlbnQtd3JpdGFibGUsIHNvIGFueSBwcm9jZXNzIHRoYXQgaGFzIGV2ZXIgcnVuIGluIHRoZVxuICogY29udGFpbmVyIGNhbiBkcm9wIGAke1dPUktfRElSfS8uaGVhcnRiZWF0X2FfPHJlcG8+XzFgIGNvbnRhaW5pbmdcbiAqIGA5OTk5OTk5OTk5YC4gRXZlcnkgaG91c2VrZWVwaW5nIHJlYWRlciB1c2VkIHRvIGFzayBvbmx5IFwiaXMgdGhpcyBiZWF0IG5vXG4gKiBvbGRlciB0aGFuIHRoZSB3aW5kb3c/XCIgKGBub3cgLSBlcG9jaCA8PSB3aW5kb3dTZWNvbmRzYCksIHdoaWNoIGFcbiAqIGZ1dHVyZS1kYXRlZCBlcG9jaCBzYXRpc2ZpZXMgZm9yIHRoZSBuZXh0IHRocmVlIGNlbnR1cmllcyDigJQgb25lIHN1Y2ggZmlsZVxuICogdHVybmVkIHRoZSBkaXNrLXJlY2xhaW0gc3dlZXBzIChJc3N1ZXMgIzIyOCwgIzI0MiwgIzM4Nykgb2ZmIHBlcm1hbmVudGx5LFxuICogYW5kIG5vdGhpbmcgb24gdGhlIHN3ZWVwIHNpZGUgZXZlciBhZ2VkIHRoZSBmaWxlIG91dCBhZ2Fpbi4gVGhlIGhvc3QgdGhlblxuICogZmlsbHMgd2l0aCBubyB3YXkgYmFjayBzaG9ydCBvZiBtYW51YWwgaW50ZXJ2ZW50aW9uLlxuICpcbiAqIEEgYmVhdCBpcyB0aGVyZWZvcmUgbGl2ZSBvbmx5IGluc2lkZSBhICoqYm91bmRlZCoqIGludGVydmFsOiBubyBvbGRlciB0aGFuXG4gKiB0aGUgd2luZG93LCBhbmQgbm8gZnVydGhlciBhaGVhZCBvZiBub3cgdGhhbiB0aGUgY2xvY2sgc2tldyBhIGxlZ2l0aW1hdGVcbiAqIHdyaXRlciBjb3VsZCBwbGF1c2libHkgc2hvdy4gQW55dGhpbmcgYmV5b25kIHRoYXQgdXBwZXIgYm91bmQgaXMgZm9yZ2VkIG9yXG4gKiBhIGJhZGx5IHdyb25nIGNsb2NrLCBhbmQgZWl0aGVyIHdheSBpdCBtdXN0IG5vdCBwaW4gYSBzd2VlcCBvZmYuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbi8qKlxuICogSG93IGZhciBhaGVhZCBvZiBgbm93YCBhIGhlYXJ0YmVhdCBlcG9jaCBtYXkgc2l0IGFuZCBzdGlsbCBjb3VudCBhcyBsaXZlLlxuICpcbiAqIFRoZSBoZWFydGJlYXQgZmlsZSBpcyByZXdyaXR0ZW4gcm91Z2hseSBldmVyeSA2MCBzZWNvbmRzIGJ5IHRoZSB3b3JrZXJcbiAqIGhvbGRpbmcgdGhlIGNsYWltLCBzbyBhIGdlbnVpbmUgYmVhdCBpcyBhdCBtb3N0IGEgZmV3IHNlY29uZHMgYWhlYWQgb2YgYVxuICogcmVhZGVyIHdob3NlIGNsb2NrIGxhZ3MuIEZpdmUgbWludXRlcyBpcyBnZW5lcm91cyBmb3IgTlRQIGRyaWZ0IGJldHdlZW5cbiAqIGEgY29udGFpbmVyIGFuZCBpdHMgaG9zdCwgYW5kIHN0aWxsIGJvdW5kZWQg4oCUIGEgZm9yZ2VkIGZhci1mdXR1cmUgZXBvY2hcbiAqIGV4cGlyZXMgaW1tZWRpYXRlbHkgcmF0aGVyIHRoYW4gbmV2ZXIuXG4gKi9cbmV4cG9ydCBjb25zdCBIRUFSVEJFQVRfRlVUVVJFX1NLRVdfU0VDT05EUyA9IDMwMDtcblxuLyoqXG4gKiBIb3cgcmVjZW50IGEgYmVhdCBtdXN0IGJlIGZvciBpdHMgY2xhaW0gdG8gY291bnQgYXMgbGl2ZSDigJQgdGhlIHNpbmdsZVxuICogZGVmaW5pdGlvbiBzaGFyZWQgYnkgdGhlIHdvcmstdm9sdW1lIHN3ZWVwcy5cbiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX0xJVkVfV0lORE9XX1NFQ09ORFMgPSA5MDA7XG5cbi8qKlxuICogUGFyc2UgdGhlIGVwb2NoIGEgaGVhcnRiZWF0IGZpbGUgY2Fycmllcywgb3IgbnVsbCB3aGVuIHRoZSBjb250ZW50IGlzIG5vdFxuICogb25lLlxuICpcbiAqIERpZ2l0cyBvbmx5OiB0aGUgZmlsZSBpcyB3cml0dGVuIHdpdGggYFN0cmluZyhlcG9jaClgLCBhbmQgcmVmdXNpbmdcbiAqIGFueXRoaW5nIGVsc2Uga2VlcHMgYSBwYXJ0aWFsbHktd3JpdHRlbiBvciBoYW5kLWNyYWZ0ZWQgZmlsZSBmcm9tIGJlaW5nXG4gKiByZWFkIGFzIGEgdGltZXN0YW1wLiBBIHZhbHVlIHRvbyBsYXJnZSB0byBiZSBhIHBsYXVzaWJsZSBzZWNvbmQtcHJlY2lzaW9uXG4gKiBlcG9jaCBpcyByZWplY3RlZCBoZXJlIGFzIHdlbGwsIHNvIHRoZSBib3VuZCBiZWxvdyBjYW5ub3QgYmUgc2lkZXN0ZXBwZWRcbiAqIHdpdGggYSBtaWxsaXNlY29uZC1zY2FsZSBudW1iZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUhlYXJ0YmVhdEVwb2NoKHJhdzogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gIGNvbnN0IHRleHQgPSByYXcudHJpbSgpO1xuICBpZiAoIS9eXFxkezEsMTJ9JC8udGVzdCh0ZXh0KSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGVwb2NoID0gTnVtYmVyKHRleHQpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKGVwb2NoKSA/IGVwb2NoIDogbnVsbDtcbn1cblxuLyoqXG4gKiBUcnVlIHdoZW4gYGVwb2NoYCBuYW1lcyBhIGJlYXQgaW5zaWRlIGBbbm93IC0gd2luZG93U2Vjb25kcywgbm93ICsgc2tld11gLlxuICpcbiAqIEJvdGggZW5kcyBtYXR0ZXI6IHRoZSBsb3dlciBib3VuZCBhZ2VzIGEgc3RhbGUgY2xhaW0gb3V0IChhcyBiZWZvcmUpLCBhbmRcbiAqIHRoZSB1cHBlciBib3VuZCBpcyB3aGF0IHN0b3BzIGEgZm9yZ2VkIGZ1dHVyZSBlcG9jaCBmcm9tIGNsYWltaW5nXG4gKiBsaXZlbmVzcyBmb3IgZXZlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSGVhcnRiZWF0RXBvY2hMaXZlKFxuICBlcG9jaDogbnVtYmVyLFxuICBub3c6IG51bWJlcixcbiAgd2luZG93U2Vjb25kczogbnVtYmVyLFxuICBza2V3U2Vjb25kczogbnVtYmVyID0gSEVBUlRCRUFUX0ZVVFVSRV9TS0VXX1NFQ09ORFMsXG4pOiBib29sZWFuIHtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoZXBvY2gpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGFnZSA9IG5vdyAtIGVwb2NoO1xuICAvLyBBaGVhZCBvZiBub3cgYnkgbW9yZSB0aGFuIHRoZSB0b2xlcmF0ZWQgc2tldyDigJQgZm9yZ2VkLCBvciBhIGNsb2NrIHNvXG4gIC8vIHdyb25nIGl0cyBiZWF0IHNheXMgbm90aGluZyBhYm91dCBsaXZlbmVzcy5cbiAgaWYgKGFnZSA8IC1NYXRoLmFicyhza2V3U2Vjb25kcykpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGFnZSA8PSB3aW5kb3dTZWNvbmRzO1xufVxuXG4vKipcbiAqIFJlYWQgYSBoZWFydGJlYXQgZmlsZSBhbmQgc2F5IHdoZXRoZXIgaXRzIGJlYXQgaXMgbGl2ZS5cbiAqXG4gKiBBbiB1bnJlYWRhYmxlIG9yIHVucGFyc2VhYmxlIGZpbGUgZmFsbHMgYmFjayB0byB0aGUgZmlsZSdzIG93biBtdGltZSwgc29cbiAqIHRoZSBtaWNyb3NlY29uZCB3aW5kb3cgaW4gd2hpY2ggYSBsaXZlIHdvcmtlcidzIHJld3JpdGUgbGVhdmVzIHRoZSBmaWxlXG4gKiBlbXB0eSBkb2VzIG5vdCByZWFkIGFzIFwibm90IHJ1bm5pbmdcIi4gVGhlIGZhbGxiYWNrIGlzIGJvdW5kZWQgYnkgdGhlIHNhbWVcbiAqIHdpbmRvdyBhbmQgc2tldywgc28gYSBmb3JnZWQgZmlsZSBzdGlsbCBleHBpcmVzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaXNIZWFydGJlYXRGaWxlTGl2ZShcbiAgcGF0aDogc3RyaW5nLFxuICBub3c6IG51bWJlcixcbiAgd2luZG93U2Vjb25kczogbnVtYmVyLFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGxldCBlcG9jaDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgZXBvY2ggPSBwYXJzZUhlYXJ0YmVhdEVwb2NoKGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKHBhdGgpKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gVW5yZWFkYWJsZSDigJQgZmFsbCB0aHJvdWdoIHRvIHRoZSBtdGltZSBmYWxsYmFjay5cbiAgfVxuICBpZiAoZXBvY2ggPT09IG51bGwpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChwYXRoKTtcbiAgICAgIGVwb2NoID0gc3RhdC5tdGltZSA/IE1hdGguZmxvb3Ioc3RhdC5tdGltZS5nZXRUaW1lKCkgLyAxMDAwKSA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG4gIGlmIChlcG9jaCA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNIZWFydGJlYXRFcG9jaExpdmUoZXBvY2gsIG5vdywgd2luZG93U2Vjb25kcyk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBRUQ7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLE1BQU0sZ0NBQWdDLElBQUk7QUFFakQ7OztDQUdDLEdBQ0QsT0FBTyxNQUFNLHdDQUF3QyxJQUFJO0FBRXpEOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sU0FBUyxvQkFBb0IsR0FBVztFQUM3QyxNQUFNLE9BQU8sSUFBSSxJQUFJO0VBQ3JCLElBQUksQ0FBQyxhQUFhLElBQUksQ0FBQyxPQUFPLE9BQU87RUFDckMsTUFBTSxRQUFRLE9BQU87RUFDckIsT0FBTyxPQUFPLFFBQVEsQ0FBQyxTQUFTLFFBQVE7QUFDMUM7QUFFQTs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMscUJBQ2QsS0FBYSxFQUNiLEdBQVcsRUFDWCxhQUFxQixFQUNyQixjQUFzQiw2QkFBNkI7RUFFbkQsSUFBSSxDQUFDLE9BQU8sUUFBUSxDQUFDLFFBQVEsT0FBTztFQUNwQyxNQUFNLE1BQU0sTUFBTTtFQUNsQix1RUFBdUU7RUFDdkUsOENBQThDO0VBQzlDLElBQUksTUFBTSxDQUFDLEtBQUssR0FBRyxDQUFDLGNBQWMsT0FBTztFQUN6QyxPQUFPLE9BQU87QUFDaEI7QUFFQTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxlQUFlLG9CQUNwQixJQUFZLEVBQ1osR0FBVyxFQUNYLGFBQXFCO0VBRXJCLElBQUksUUFBdUI7RUFDM0IsSUFBSTtJQUNGLFFBQVEsb0JBQW9CLE1BQU0sS0FBSyxZQUFZLENBQUM7RUFDdEQsRUFBRSxPQUFNO0VBQ04sbURBQW1EO0VBQ3JEO0VBQ0EsSUFBSSxVQUFVLE1BQU07SUFDbEIsSUFBSTtNQUNGLE1BQU0sT0FBTyxNQUFNLEtBQUssSUFBSSxDQUFDO01BQzdCLFFBQVEsS0FBSyxLQUFLLEdBQUcsS0FBSyxLQUFLLENBQUMsS0FBSyxLQUFLLENBQUMsT0FBTyxLQUFLLFFBQVE7SUFDakUsRUFBRSxPQUFNO01BQ04sT0FBTztJQUNUO0VBQ0Y7RUFDQSxJQUFJLFVBQVUsTUFBTSxPQUFPO0VBQzNCLE9BQU8scUJBQXFCLE9BQU8sS0FBSztBQUMxQyJ9
// denoCacheMetadata=6978939354212461779,63774622239981832