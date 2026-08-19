/**
 * Shared rate-limit signal file (Issue #1073).
 *
 * When a worker detects a rate limit, it writes a signal file so that
 * other workers on the same machine can skip their next cycle immediately
 * rather than discovering the limit independently.
 *
 * The signal file contains a JSON object with the timestamp and wait duration.
 * Other workers check this file before starting a Claude invocation — if the
 * signal is still active, they can back off without making a redundant request.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/** Signal file name. */
const SIGNAL_FILENAME = ".rate_limit_signal";

/** Data stored in the signal file. */
export interface RateLimitSignalData {
  /** Unix timestamp (seconds) when the rate limit was detected. */
  timestamp: number;
  /** How long the worker planned to wait, in seconds. */
  waitSeconds: number;
}

/** Result of checking whether a rate limit is currently active. */
export interface RateLimitStatus {
  /** Whether the rate limit is still active (within the wait window). */
  active: boolean;
  /** Seconds remaining in the wait window (0 if expired or no signal). */
  remainingSeconds: number;
}

/**
 * Return the path to the rate-limit signal file.
 */
export function rateLimitSignalPath(workDir: string): string {
  return `${workDir}/${SIGNAL_FILENAME}`;
}

/**
 * Write a rate-limit signal file to notify other workers.
 *
 * @param workDir - Directory for the signal file
 * @param waitSeconds - How long the worker intends to wait
 * @returns Result indicating success or failure
 */
export async function writeRateLimitSignal(
  workDir: string,
  waitSeconds: number,
): Promise<Result<void>> {
  try {
    const data: RateLimitSignalData = {
      timestamp: Math.floor(Date.now() / 1000),
      waitSeconds,
    };
    await Deno.writeTextFile(
      rateLimitSignalPath(workDir),
      JSON.stringify(data),
    );
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `Failed to write rate-limit signal: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

/**
 * Read the rate-limit signal file.
 *
 * @param workDir - Directory containing the signal file
 * @returns Result containing the signal data, or error if missing/invalid
 */
export async function readRateLimitSignal(
  workDir: string,
): Promise<Result<RateLimitSignalData>> {
  try {
    const content = await Deno.readTextFile(rateLimitSignalPath(workDir));
    const data = JSON.parse(content) as RateLimitSignalData;
    if (
      typeof data.timestamp !== "number" || typeof data.waitSeconds !== "number"
    ) {
      return { ok: false, error: new Error("Invalid signal file format") };
    }
    return { ok: true, value: data };
  } catch {
    return {
      ok: false,
      error: new Error("Rate-limit signal file not found or unreadable"),
    };
  }
}

/**
 * Check whether a rate limit is currently active based on the signal file.
 *
 * @param workDir - Directory containing the signal file
 * @param nowFn - Injectable time source for testing (returns Unix seconds)
 * @returns Result with the rate-limit status
 */
export async function isRateLimitActive(
  workDir: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<Result<RateLimitStatus>> {
  const signalResult = await readRateLimitSignal(workDir);

  if (!signalResult.ok) {
    // No signal file — not rate limited
    return { ok: true, value: { active: false, remainingSeconds: 0 } };
  }

  const { timestamp, waitSeconds } = signalResult.value;
  const now = nowFn();
  const expiresAt = timestamp + waitSeconds;
  const remaining = expiresAt - now;

  if (remaining > 0) {
    return { ok: true, value: { active: true, remainingSeconds: remaining } };
  }

  return { ok: true, value: { active: false, remainingSeconds: 0 } };
}

/**
 * Compute the Australia/Sydney wall-clock hour offset (10 for AEST, 11 for
 * AEDT) for a given epoch. Implemented by comparing the Sydney hour to the
 * UTC hour rather than relying on `Intl.DateTimeFormat`'s short timezone
 * name, which is rendered inconsistently across ICU versions (some return
 * "AEST"/"AEDT", others "GMT+10").
 */
function sydneyOffsetHours(date: Date): number {
  const hourFmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
  });
  const utcHour = parseInt(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }).format(date),
    10,
  );
  const sydneyHour = parseInt(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hour12: false,
      timeZone: "Australia/Sydney",
    }).format(date),
    10,
  );
  // Force consistent locale to avoid 24h vs 12h drift.
  void hourFmt;
  return ((sydneyHour - utcHour) + 24) % 24;
}

/**
 * Format a GitHub rate-limit reset epoch as an operator-readable string
 * combining the absolute Australia/Sydney wall-clock time and a relative
 * duration ("at 2026-05-11 14:23:00 AEST (in 47m 12s)").
 *
 * Issue #1910: rate-limit log lines now surface the reset ETA so operators
 * do not have to grep for the preflight log to learn when the quota refreshes.
 *
 * Returns "unknown" for non-finite resets and "already reset" when the
 * reset is at or before `nowEpoch` — callers should still log the original
 * error message; this helper only formats the ETA fragment.
 */
export function formatRateLimitReset(
  resetEpoch: number,
  nowEpoch: number,
): string {
  if (!Number.isFinite(resetEpoch) || !Number.isFinite(nowEpoch)) {
    return "reset time unknown";
  }
  const remaining = Math.floor(resetEpoch) - Math.floor(nowEpoch);
  if (remaining <= 0) {
    return "already reset";
  }

  const date = new Date(Math.floor(resetEpoch) * 1000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // en-GB renders hour "24" at midnight — normalise to "00".
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  const wallClock = `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${
    pick("minute")
  }:${pick("second")}`;
  const tzLabel = sydneyOffsetHours(date) === 11 ? "AEDT" : "AEST";

  let relative: string;
  if (remaining < 60) {
    relative = `${remaining}s`;
  } else if (remaining < 3600) {
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    relative = `${minutes}m ${seconds}s`;
  } else {
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    relative = `${hours}h ${minutes}m`;
  }

  return `at ${wallClock} ${tzLabel} (in ${relative})`;
}
