/**
 * Consecutive failure tracking and exit thresholds (Issue #451, #908).
 *
 * When the same work item fails repeatedly, the worker should exit so the
 * scheduler (cron/launchd) can restart with fresh code. This prevents
 * infinite loops where the same error repeats every iteration.
 *
 * State is persisted to JSON on disk so it survives worker crashes (Issue #633).
 *
 * Migrated from worker/shared/failure_tracker.sh (Issue #908).
 */

import type { Result } from "../types.ts";
import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";

/** Configuration for the failure tracker. */
export interface FailureTrackerConfig {
  /** Directory for persistent state file. */
  workDir: string;
  /** Maximum consecutive failures before exit (default: 3). */
  maxConsecutiveFailures: number;
  /** Seconds before persisted state expires (default: 3600). */
  stateExpirySeconds: number;
}

/** Persisted failure tracker state (JSON). */
export interface FailureTrackerState {
  /** Number of consecutive failures on the current work item. */
  consecutiveFailures: number;
  /** Key identifying the failing work item (e.g., "issue|org/repo|42"). */
  lastFailureKey: string;
  /** Unix timestamp of the last failure. */
  lastFailureTimestamp: number;
}

/** Default failure tracker configuration values. */
export const FAILURE_TRACKER_DEFAULTS: Readonly<
  Omit<FailureTrackerConfig, "workDir">
> = {
  maxConsecutiveFailures: 3,
  stateExpirySeconds: 3600,
} as const;

const STATE_FILENAME = ".failure_state.json";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Create a fresh (empty) state. */
function emptyState(): FailureTrackerState {
  return {
    consecutiveFailures: 0,
    lastFailureKey: "",
    lastFailureTimestamp: 0,
  };
}

function statePath(workDir: string): string {
  return `${workDir}/${STATE_FILENAME}`;
}

/**
 * Write state to disk atomically (write-to-tmp then rename).
 */
async function persistState(
  workDir: string,
  state: FailureTrackerState,
): Promise<Result<void>> {
  if (!workDir) return { ok: true, value: undefined };
  const result = await atomicWrite({
    targetFile: statePath(workDir),
    content: JSON.stringify(state, null, 2),
  });
  if (result.ok) return result;
  return {
    ok: false,
    error: new Error(
      `Failed to persist failure state: ${result.error.message}`,
    ),
  };
}

/**
 * Load state from disk. Returns empty state if file is missing or expired.
 */
export async function loadState(
  workDir: string,
  stateExpirySeconds: number = FAILURE_TRACKER_DEFAULTS.stateExpirySeconds,
): Promise<FailureTrackerState> {
  if (!workDir) return emptyState();
  const path = statePath(workDir);
  try {
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content) as FailureTrackerState;

    // Validate structure
    if (
      typeof parsed.consecutiveFailures !== "number" ||
      typeof parsed.lastFailureKey !== "string"
    ) {
      return emptyState();
    }

    // Check expiry
    if (
      typeof parsed.lastFailureTimestamp === "number" &&
      parsed.lastFailureTimestamp > 0
    ) {
      const elapsed = nowSeconds() - parsed.lastFailureTimestamp;
      if (elapsed >= stateExpirySeconds) {
        return emptyState();
      }
    }

    return parsed;
  } catch {
    return emptyState();
  }
}

/**
 * Record a failure for a given work item key.
 *
 * If the key matches the previous failure, increments the counter.
 * If the key is different, resets the counter to 1 (new work item failing).
 */
export async function trackFailure(
  config: FailureTrackerConfig,
  failureKey: string,
): Promise<Result<FailureTrackerState>> {
  return await withStateLock(`failure-tracker:${config.workDir}`, async () => {
    const state = await loadState(config.workDir, config.stateExpirySeconds);

    if (failureKey === state.lastFailureKey) {
      state.consecutiveFailures += 1;
    } else {
      state.consecutiveFailures = 1;
      state.lastFailureKey = failureKey;
    }
    state.lastFailureTimestamp = nowSeconds();

    const writeResult = await persistState(config.workDir, state);
    if (!writeResult.ok) return writeResult as Result<FailureTrackerState>;

    return { ok: true, value: state };
  });
}

/**
 * Reset the consecutive failure counter (call after successful work).
 */
export async function resetFailures(
  config: FailureTrackerConfig,
): Promise<Result<FailureTrackerState>> {
  return await withStateLock(`failure-tracker:${config.workDir}`, async () => {
    const state = emptyState();
    state.lastFailureTimestamp = nowSeconds();

    const writeResult = await persistState(config.workDir, state);
    if (!writeResult.ok) return writeResult as Result<FailureTrackerState>;

    return { ok: true, value: state };
  });
}

/**
 * Check whether the failure threshold has been reached.
 *
 * Returns true if the worker should exit for a restart.
 */
export async function shouldExitOnFailures(
  config: FailureTrackerConfig,
): Promise<boolean> {
  const state = await loadState(config.workDir, config.stateExpirySeconds);
  return state.consecutiveFailures >= config.maxConsecutiveFailures;
}
