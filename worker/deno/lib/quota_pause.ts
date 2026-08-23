/**
 * Scheduled quota-pause exit (Issue #342).
 *
 * When the host runs out of Claude quota the worker stops working and exits —
 * cleanly, on purpose, with the reset time already known. That is a *scheduled*
 * outcome, not a crash, and the supervisor must be able to tell the two apart:
 * a crash earns exponential backoff and, eventually, an escalation; a quota
 * pause earns a fixed re-probe cadence and nothing else. Before this module the
 * two shared one exit status, so an out-of-quota host walked its retry interval
 * out to 16 minutes and beyond, rebuilt its container each time, and filed
 * failure reports for a worker that was behaving correctly.
 *
 * Two pieces of evidence carry the distinction, because one of them cannot be
 * relied on alone:
 *
 *   1. **The exit status.** {@link QUOTA_PAUSE_EXIT_STATUS} is a status no
 *      crash produces, so the supervisor can classify on it directly.
 *   2. **The marker file.** The work directory rides a named volume the host
 *      cannot read, and a container runtime that loses a container's exit code
 *      reports its own generic status instead — so the run also *writes* its
 *      declaration to the host-visible log directory. The marker is consumed
 *      (read and deleted) by the supervisor, so exactly one launcher outcome
 *      can ever be classified from it: a later run that crashes while the
 *      quota is still out finds no marker and backs off normally.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";

/**
 * Exit status a worker run uses to declare a scheduled quota pause.
 *
 * 75 is `EX_TEMPFAIL` from `sysexits.h` — "temporary failure, the caller is
 * invited to retry" — which is exactly what an out-of-quota host is. It sits
 * outside the runtime CLI's 125/126/127 range, outside the launcher's own 87
 * (wedged container) and 124/137 (supervisor deadline), and below 128 so it
 * can never be confused with a signal death.
 */
export const QUOTA_PAUSE_EXIT_STATUS = 75;

/** Marker file name, relative to the host-visible log directory. */
export const QUOTA_PAUSE_MARKER_FILENAME = "quota-pause.json";

/**
 * How stale a marker may be and still be believed, in seconds.
 *
 * A marker is consumed by the next launcher outcome, so a stale one means the
 * supervisor never recorded that outcome (a host reboot mid-cycle, say). Six
 * hours is far longer than the hourly re-probe cadence and far shorter than a
 * weekly usage window, so a leftover cannot silently buy an out-of-date pause.
 */
export const QUOTA_PAUSE_MARKER_MAX_AGE_SECONDS = 6 * 3600;

/** A run's own declaration that it stopped because the quota is out. */
export interface QuotaPauseMarker {
  /** Unix milliseconds when the run declared the pause. */
  declaredAtMs: number;
  /**
   * When the usage window actually reopens, in epoch milliseconds, when the
   * run knew it. Absent for a limit whose message carried no reset time.
   */
  resetEpochMs?: number;
  /** The run's own words for why it paused, carried into the self-heal log. */
  reason: string;
}

/** Path of the quota-pause marker inside a log directory. */
export function quotaPauseMarkerPath(logDir: string): string {
  return `${logDir}/${QUOTA_PAUSE_MARKER_FILENAME}`;
}

/**
 * Declare a quota pause on disk.
 *
 * @param logDir - Host-visible log directory (`$HOME/logs` on both sides of
 *   the container boundary)
 * @param marker - What the run is declaring
 */
export async function writeQuotaPauseMarker(
  logDir: string,
  marker: QuotaPauseMarker,
): Promise<Result<void>> {
  if (!logDir) {
    return { ok: false, error: new Error("no log directory for the marker") };
  }
  const written = await atomicWrite({
    targetFile: quotaPauseMarkerPath(logDir),
    content: JSON.stringify(marker, null, 2),
  });
  if (written.ok) return { ok: true, value: undefined };
  return {
    ok: false,
    error: new Error(
      `Failed to write quota-pause marker: ${written.error.message}`,
    ),
  };
}

/** Options for {@link consumeQuotaPauseMarker}. */
export interface ConsumeQuotaPauseOptions {
  /** Clock seam, in Unix milliseconds. */
  nowMs?: number;
  /** Staleness bound (defaults to {@link QUOTA_PAUSE_MARKER_MAX_AGE_SECONDS}). */
  maxAgeSeconds?: number;
  /** Sink for the loud "found something unusable" cases. */
  warn?: (message: string) => void;
}

/**
 * Read the marker and remove it, so one declaration classifies exactly one
 * launcher outcome.
 *
 * The file is deleted whatever it contained: a corrupt or stale marker must
 * not be re-read on the next outcome, and it is reported rather than dropped
 * silently. Returns null when there is no usable declaration — the ordinary
 * case for a healthy host.
 */
export async function consumeQuotaPauseMarker(
  logDir: string,
  options: ConsumeQuotaPauseOptions = {},
): Promise<QuotaPauseMarker | null> {
  if (!logDir) return null;
  const path = quotaPauseMarkerPath(logDir);

  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (err) {
    // A missing marker is the healthy case and stays quiet; anything else is
    // a marker we cannot read, which is worth saying out loud.
    if (!(err instanceof Deno.errors.NotFound)) {
      (options.warn ?? console.error)(
        `[quota-pause] cannot read ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return null;
  }

  // Consume before parsing: a marker that cannot be parsed must still not be
  // seen twice.
  try {
    await Deno.remove(path);
  } catch (err) {
    (options.warn ?? console.error)(
      `[quota-pause] cannot remove ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed: Partial<QuotaPauseMarker>;
  try {
    parsed = JSON.parse(content) as Partial<QuotaPauseMarker>;
  } catch (err) {
    (options.warn ?? console.error)(
      `[quota-pause] discarding an unparseable marker at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  if (
    typeof parsed.declaredAtMs !== "number" ||
    !Number.isFinite(parsed.declaredAtMs)
  ) {
    (options.warn ?? console.error)(
      `[quota-pause] discarding a marker at ${path} with no declaration time`,
    );
    return null;
  }

  const nowMs = options.nowMs ?? Date.now();
  const maxAgeSeconds = options.maxAgeSeconds ??
    QUOTA_PAUSE_MARKER_MAX_AGE_SECONDS;
  const ageSeconds = (nowMs - parsed.declaredAtMs) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    (options.warn ?? console.error)(
      `[quota-pause] discarding a marker at ${path} declared ${
        Math.round(ageSeconds)
      }s ago (older than the ${maxAgeSeconds}s bound)`,
    );
    return null;
  }

  return {
    declaredAtMs: parsed.declaredAtMs,
    ...(typeof parsed.resetEpochMs === "number" &&
        Number.isFinite(parsed.resetEpochMs)
      ? { resetEpochMs: parsed.resetEpochMs }
      : {}),
    reason: typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason
      : "quota exhausted",
  };
}
