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
 */

/**
 * How far ahead of `now` a heartbeat epoch may sit and still count as live.
 *
 * The heartbeat file is rewritten roughly every 60 seconds by the worker
 * holding the claim, so a genuine beat is at most a few seconds ahead of a
 * reader whose clock lags. Five minutes is generous for NTP drift between
 * a container and its host, and still bounded — a forged far-future epoch
 * expires immediately rather than never.
 */
export const HEARTBEAT_FUTURE_SKEW_SECONDS = 300;

/**
 * How recent a beat must be for its claim to count as live — the single
 * definition shared by the work-volume sweeps.
 */
export const DEFAULT_HEARTBEAT_LIVE_WINDOW_SECONDS = 900;

/**
 * Parse the epoch a heartbeat file carries, or null when the content is not
 * one.
 *
 * Digits only: the file is written with `String(epoch)`, and refusing
 * anything else keeps a partially-written or hand-crafted file from being
 * read as a timestamp. A value too large to be a plausible second-precision
 * epoch is rejected here as well, so the bound below cannot be sidestepped
 * with a millisecond-scale number.
 */
export function parseHeartbeatEpoch(raw: string): number | null {
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
 */
export function isHeartbeatEpochLive(
  epoch: number,
  now: number,
  windowSeconds: number,
  skewSeconds: number = HEARTBEAT_FUTURE_SKEW_SECONDS,
): boolean {
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
 */
export async function isHeartbeatFileLive(
  path: string,
  now: number,
  windowSeconds: number,
): Promise<boolean> {
  let epoch: number | null = null;
  try {
    epoch = parseHeartbeatEpoch(await Deno.readTextFile(path));
  } catch {
    // Unreadable — fall through to the mtime fallback.
  }
  if (epoch === null) {
    try {
      const stat = await Deno.stat(path);
      epoch = stat.mtime ? Math.floor(stat.mtime.getTime() / 1000) : null;
    } catch {
      return false;
    }
  }
  if (epoch === null) return false;
  return isHeartbeatEpochLive(epoch, now, windowSeconds);
}
