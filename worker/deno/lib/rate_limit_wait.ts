/**
 * Shutdown-aware GitHub rate-limit wait helper (Issue #1779).
 *
 * Sleeps until a GitHub rate-limit reset epoch (Unix seconds) passes,
 * while remaining responsive to shutdown signals and run-duration caps.
 * This is the foundation for the pause-and-resume behaviour requested in
 * #1777 — instead of exiting on rate-limit exhaustion and relying on the
 * supervisor to respawn every ~30 seconds, callers can park the worker
 * in place until the quota refreshes.
 *
 * Behaviour:
 *   - If the reset epoch is already in the past, return immediately.
 *   - Otherwise loop, sleeping in small (default 30s) increments so that
 *     a shutdown request is detected within one increment.
 *   - A configurable safety cap (default 3600s) bounds the wait so a
 *     malformed or far-future reset value cannot block the worker
 *     indefinitely.
 *   - A small grace pad (default +30s) is applied after the reset so the
 *     next API call is unlikely to race the quota refresh.
 *   - All inputs (`now`, `sleep`, `shouldShutdown`, cap, grace pad,
 *     increment) are dependency-injected so the helper can be tested
 *     deterministically without touching `Date.now()` or `setTimeout`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/** Default safety cap — never wait more than one hour in a single call. */
const DEFAULT_CAP_SECONDS = 3600;

/** Default grace pad — sleep an extra 30s past the reset to avoid races. */
const DEFAULT_GRACE_SECONDS = 30;

/** Default sleep increment — poll for shutdown every 30s. */
const DEFAULT_INCREMENT_SECONDS = 30;

/**
 * Default heartbeat interval — emit a one-line "still waiting" log entry
 * every 60s when a `log` dep is provided (Issue #1903). Without this, the
 * worker can sit silent for tens of minutes during a rate-limit pause and
 * appear hung to anyone tailing the log.
 */
const DEFAULT_HEARTBEAT_SECONDS = 60;

/** Reason the wait ended early, or null if it completed normally. */
type WaitAbortReason = "shutdown" | "cap" | null;

/** Outcome of a successful wait. */
interface WaitOutcome {
  /** Total seconds spent sleeping (per the injected clock). */
  waited: number;
  /** Why the wait ended early, or null if reset+grace was reached. */
  aborted: WaitAbortReason;
}

/** Dependencies injected into {@link waitUntilRateLimitReset}. */
interface WaitDeps {
  /** Current Unix time in seconds. */
  now: () => number;
  /** Sleep for the given number of milliseconds. */
  sleep: (ms: number) => Promise<void>;
  /** Return true if a shutdown has been requested. */
  shouldShutdown: () => boolean;
  /**
   * Optional logger for periodic heartbeats while waiting. When provided,
   * a one-line message is emitted every `heartbeatSeconds` so the worker
   * does not appear hung during long rate-limit pauses. Issue #1903.
   */
  log?: (message: string) => void;
}

/** Per-call options for {@link waitUntilRateLimitReset}. */
interface WaitOptions {
  /** GitHub rate-limit reset epoch in seconds. */
  resetEpoch: number;
  /** Maximum total wait in seconds (default {@link DEFAULT_CAP_SECONDS}). */
  capSeconds?: number;
  /** Grace pad added after reset (default {@link DEFAULT_GRACE_SECONDS}). */
  graceSeconds?: number;
  /** Sleep increment between shutdown polls (default {@link DEFAULT_INCREMENT_SECONDS}). */
  incrementSeconds?: number;
  /**
   * Heartbeat cadence in seconds when a logger dep is set
   * (default {@link DEFAULT_HEARTBEAT_SECONDS}). No heartbeat is emitted
   * if the total wait is shorter than the interval. Issue #1903.
   */
  heartbeatSeconds?: number;
}

/**
 * Format a remaining-seconds duration as `Xm Ys` (with `Y` zero-padded).
 * Exported for the heartbeat tests; not intended for general use.
 */
export function formatRemainingDuration(remainingSec: number): string {
  const total = Math.max(0, Math.ceil(remainingSec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Format an epoch (seconds) as an ISO 8601 string without milliseconds. */
function formatEpochIso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Wait until a GitHub rate-limit reset epoch passes, honouring shutdown
 * requests and a safety cap.
 *
 * Returns a {@link Result} so callers can distinguish between an invalid
 * configuration (Err) and a wait that ended early due to shutdown or cap
 * (Ok with `aborted` set).
 */
export async function waitUntilRateLimitReset(
  options: WaitOptions,
  deps: WaitDeps,
): Promise<Result<WaitOutcome>> {
  const cap = options.capSeconds ?? DEFAULT_CAP_SECONDS;
  const grace = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  const increment = options.incrementSeconds ?? DEFAULT_INCREMENT_SECONDS;
  const heartbeat = options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;

  if (!Number.isFinite(options.resetEpoch)) {
    return {
      ok: false,
      error: new Error("resetEpoch must be a finite number"),
    };
  }
  if (!Number.isFinite(cap) || cap <= 0) {
    return {
      ok: false,
      error: new Error("capSeconds must be a positive finite number"),
    };
  }
  if (!Number.isFinite(grace) || grace < 0) {
    return {
      ok: false,
      error: new Error("graceSeconds must be a non-negative finite number"),
    };
  }
  if (!Number.isFinite(increment) || increment <= 0) {
    return {
      ok: false,
      error: new Error("incrementSeconds must be a positive finite number"),
    };
  }
  if (!Number.isFinite(heartbeat) || heartbeat <= 0) {
    return {
      ok: false,
      error: new Error("heartbeatSeconds must be a positive finite number"),
    };
  }

  const start = deps.now();

  // Reset already past — the quota has already refreshed, so do not
  // sleep at all. The grace pad only matters when we are waiting for
  // the reset to arrive.
  if (start >= options.resetEpoch) {
    return { ok: true, value: { waited: 0, aborted: null } };
  }

  const target = options.resetEpoch + grace;
  const deadline = start + cap;
  // Anchor the heartbeat clock to `start` so the first heartbeat fires
  // roughly `heartbeat` seconds in — short waits below that interval
  // never emit a heartbeat, satisfying the acceptance criterion.
  let lastHeartbeat = start;

  while (true) {
    if (deps.shouldShutdown()) {
      return {
        ok: true,
        value: { waited: deps.now() - start, aborted: "shutdown" },
      };
    }

    const current = deps.now();
    if (current >= target) {
      return { ok: true, value: { waited: current - start, aborted: null } };
    }
    if (current >= deadline) {
      return { ok: true, value: { waited: current - start, aborted: "cap" } };
    }

    // Heartbeat — emit a one-line log entry every `heartbeat` seconds so
    // the worker is visibly alive during long rate-limit pauses
    // (Issue #1903). Skipped entirely when no logger dep is provided.
    if (deps.log && current - lastHeartbeat >= heartbeat) {
      const remaining = target - current;
      deps.log(
        `Rate-limit wait: ${
          formatRemainingDuration(remaining)
        } remaining until reset at ${formatEpochIso(options.resetEpoch)}`,
      );
      lastHeartbeat = current;
    }

    // Sleep the smallest of: the increment, the time left to the
    // target, the time left to the cap, and (when a logger is set) the
    // time left to the next heartbeat. Bounding by heartbeat keeps the
    // cadence near-exact even when the increment is larger.
    const remainingToTarget = target - current;
    const remainingToDeadline = deadline - current;
    const candidates = [increment, remainingToTarget, remainingToDeadline];
    if (deps.log) {
      candidates.push(Math.max(1, lastHeartbeat + heartbeat - current));
    }
    const sleepSeconds = Math.min(...candidates);
    await deps.sleep(Math.max(1, Math.ceil(sleepSeconds * 1000)));
  }
}
