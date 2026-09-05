/**
 * A launcher run that was stopped from outside, not one that failed
 * (Issue #1072).
 *
 * ## What went wrong
 *
 * `run.sh` forwards SIGTERM/SIGINT to the container runtime client and then
 * exits with **that client's** status. On the fleet's macOS hosts a client
 * whose container is stopped under it exits **255**, so a deliberate stop
 * looks exactly like a crash: the supervisor counts it towards the
 * consecutive-failure streak, and three of them escalate a host that was
 * working perfectly. Issue #879 was that report — one of its three counted
 * failures was an operator's own `kill` — and the operator closing it wrote:
 *
 *   > a deliberate kill is indistinguishable from a crash here … the report
 *   > then advised looking at the container runtime, which for that one would
 *   > have been a phantom. A killed run could record that it was signalled, so
 *   > the streak does not count it.
 *
 * Issue #1072 is the recurrence, from the same host, with the same exit 255
 * and a log tail full of a worker doing its job.
 *
 * ## The marker
 *
 * The exit status cannot carry this: the status belongs to the runtime client
 * and is whatever it chose. So the launcher writes what it *knows* — that it
 * forwarded a termination signal — beside the phase marker in the state
 * directory, and the outcome recorder reads it.
 *
 * It is **consumed** (read and deleted), exactly like the quota-pause marker:
 * one declaration classifies one launcher outcome, so a later run that
 * genuinely crashes cannot inherit an earlier stop. It also carries the time
 * it was declared, because believing a leftover would silence a real failure —
 * the opposite of the fail-loud default.
 *
 * Australian English spelling throughout (behaviour, recognise, signalled).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";

/** Marker file name, relative to the Vibe Coder state directory. */
export const LAUNCH_TERMINATION_MARKER_FILENAME = "last-launch-termination";

/**
 * How stale a marker may be and still be believed, in seconds.
 *
 * The recorder runs within seconds of the launcher exiting — the supervisor
 * calls it on the next line — so anything appreciably older is a leftover from
 * a run whose outcome was never recorded (a host reboot mid-cycle, an
 * unwritable state directory). Believing one of those would classify a genuine
 * crash as a deliberate stop and suppress the escalation it earned, so the
 * bound is deliberately tight relative to the launch cadence.
 */
export const LAUNCH_TERMINATION_MARKER_MAX_AGE_SECONDS = 3600;

/** A launcher's own record that it was stopped by a signal. */
export interface LaunchTerminationMarker {
  /** Signal name as the launcher saw it (`TERM`, `INT`). */
  signal: string;
  /** Unix milliseconds when the launcher was signalled. */
  declaredAtMs: number;
}

/** Path of the termination marker inside a state directory. */
export function launchTerminationMarkerPath(stateDir: string): string {
  return `${stateDir}/${LAUNCH_TERMINATION_MARKER_FILENAME}`;
}

/**
 * Declare that this launcher run was terminated by a signal.
 *
 * Used by the Deno-side tests and available to any caller that needs to write
 * the same declaration; production writes it from `run.sh`'s signal trap,
 * which cannot call into Deno while it is being shut down.
 *
 * @param stateDir - Vibe Coder state directory (`~/.vibe-coder` by default)
 * @param marker - What the launcher is declaring
 */
export async function writeLaunchTerminationMarker(
  stateDir: string,
  marker: LaunchTerminationMarker,
): Promise<Result<void>> {
  if (!stateDir) {
    return { ok: false, error: new Error("no state directory for the marker") };
  }
  const written = await atomicWrite({
    targetFile: launchTerminationMarkerPath(stateDir),
    content: JSON.stringify(marker, null, 2),
  });
  if (written.ok) return { ok: true, value: undefined };
  return {
    ok: false,
    error: new Error(
      `Failed to write launch-termination marker: ${written.error.message}`,
    ),
  };
}

/** Options for {@link consumeLaunchTerminationMarker}. */
export interface ConsumeLaunchTerminationOptions {
  /** Clock seam, in Unix milliseconds. */
  nowMs?: number;
  /** Staleness bound (defaults to {@link LAUNCH_TERMINATION_MARKER_MAX_AGE_SECONDS}). */
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
 * case for a run that ended on its own.
 *
 * @param path - Marker path, or empty to skip the read entirely
 * @param options - Clock, staleness bound and warning sink seams
 * @returns The declaration, or null when there is nothing usable
 */
export async function consumeLaunchTerminationMarker(
  path: string,
  options: ConsumeLaunchTerminationOptions = {},
): Promise<LaunchTerminationMarker | null> {
  if (!path) return null;
  const warn = options.warn ?? console.error;

  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (err) {
    // A missing marker is the ordinary case and stays quiet; anything else is
    // a marker we cannot read, which is worth saying out loud.
    if (!(err instanceof Deno.errors.NotFound)) {
      warn(
        `[launch-termination] cannot read ${path}: ${
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
    warn(
      `[launch-termination] cannot remove ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed: Partial<LaunchTerminationMarker>;
  try {
    parsed = JSON.parse(content) as Partial<LaunchTerminationMarker>;
  } catch (err) {
    warn(
      `[launch-termination] discarding an unparseable marker at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  if (
    typeof parsed.declaredAtMs !== "number" ||
    !Number.isFinite(parsed.declaredAtMs)
  ) {
    warn(
      `[launch-termination] discarding a marker at ${path} with no ` +
        "declaration time",
    );
    return null;
  }

  const nowMs = options.nowMs ?? Date.now();
  const maxAgeSeconds = options.maxAgeSeconds ??
    LAUNCH_TERMINATION_MARKER_MAX_AGE_SECONDS;
  const ageSeconds = (nowMs - parsed.declaredAtMs) / 1000;
  if (ageSeconds > maxAgeSeconds) {
    warn(
      `[launch-termination] discarding a marker at ${path} declared ${
        Math.round(ageSeconds)
      }s ago (older than the ${maxAgeSeconds}s bound) — this launcher outcome ` +
        "is judged on its own evidence",
    );
    return null;
  }

  return {
    signal: typeof parsed.signal === "string" && parsed.signal.trim()
      ? parsed.signal.trim()
      : "unknown",
    declaredAtMs: parsed.declaredAtMs,
  };
}
