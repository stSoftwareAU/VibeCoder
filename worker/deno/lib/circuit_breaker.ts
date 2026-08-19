/**
 * Circuit breaker for scan-cycle backoff (Issue #588, #908).
 *
 * When all eligible issues across all repos are stuck, the worker retries the
 * same failures every scan cycle. The circuit breaker tracks consecutive
 * zero-progress cycles and applies exponential backoff to the sleep interval.
 *
 * Also provides operation-specific backoff tracking (Issue #620): when a
 * specific operation (pr_creation, issue_claiming, api_calls) fails 2+ times
 * consecutively, its sleep interval increases independently.
 *
 * State is persisted to JSON on disk so it survives worker crashes (Issue #633).
 *
 * Migrated from worker/shared/circuit_breaker.sh (Issue #908).
 */

import type { Result } from "../types.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";
import { reportStateLoadFailure } from "./state_load_failure.ts";
import { atomicWrite } from "./file_utils.ts";
import { withStateLock } from "./state_mutex.ts";

/** Configuration for the circuit breaker. */
export interface CircuitBreakerConfig {
  /** Directory for persistent state file. */
  workDir: string;
  /** Zero-progress cycles before backoff activates (default: 3). */
  threshold: number;
  /** Base sleep interval in seconds (default: 30). */
  sleepInterval: number;
  /** Maximum backoff interval in seconds (default: 300). */
  creditWaitInterval: number;
  /** Seconds before persisted state expires (default: 3600). */
  stateExpirySeconds: number;
  /** Consecutive operation failures before backoff (default: 2). */
  operationBackoffThreshold: number;
}

/** Persisted circuit breaker state (JSON). */
export interface CircuitBreakerState {
  /** Consecutive zero-progress scan cycles. */
  zeroCycles: number;
  /** Unix timestamp of the last state update. */
  lastUpdated: number;
  /** Per-operation consecutive failure counts. */
  operationFailures: Record<string, number>;
}

/** Default circuit breaker configuration values. */
export const CIRCUIT_BREAKER_DEFAULTS: Readonly<
  Omit<CircuitBreakerConfig, "workDir">
> = {
  threshold: 3,
  sleepInterval: 30,
  creditWaitInterval: 300,
  stateExpirySeconds: 3600,
  operationBackoffThreshold: 2,
} as const;

const STATE_FILENAME = ".circuit_breaker_state.json";

/** Create a fresh (empty) state. */
function emptyState(): CircuitBreakerState {
  return { zeroCycles: 0, lastUpdated: nowSeconds(), operationFailures: {} };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function statePath(workDir: string): string {
  return `${workDir}/${STATE_FILENAME}`;
}

/**
 * Write state to disk atomically (write-to-tmp then rename).
 */
async function persistState(
  workDir: string,
  state: CircuitBreakerState,
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
      `Failed to persist circuit breaker state: ${result.error.message}`,
    ),
  };
}

/**
 * Load state from disk. Returns empty state if file is missing or expired.
 *
 * Issue #3649 (SEC-6b03e9d5127f): a missing file is the ordinary first run
 * and an expired file is a designed reset, so both stay quiet. A read,
 * parse, or structural failure silently discarded all accumulated backoff,
 * so it is now reported through `warn`.
 *
 * @param warn - Sink for load-failure notices (defaults to `console.error`)
 */
export async function loadState(
  workDir: string,
  stateExpirySeconds: number = CIRCUIT_BREAKER_DEFAULTS.stateExpirySeconds,
  warn?: (message: string) => void,
): Promise<CircuitBreakerState> {
  if (!workDir) return emptyState();
  const path = statePath(workDir);
  try {
    const content = await Deno.readTextFile(path);
    const parsed = JSON.parse(content) as CircuitBreakerState;

    // Validate structure
    if (
      typeof parsed.zeroCycles !== "number" ||
      typeof parsed.lastUpdated !== "number"
    ) {
      reportStateLoadFailure(
        "circuit-breaker state",
        path,
        new Error("malformed state: zeroCycles/lastUpdated are not numbers"),
        warn,
      );
      return emptyState();
    }

    // Check expiry
    const elapsed = nowSeconds() - parsed.lastUpdated;
    if (elapsed >= stateExpirySeconds) {
      return emptyState();
    }

    // Ensure operationFailures exists
    if (
      !parsed.operationFailures || typeof parsed.operationFailures !== "object"
    ) {
      parsed.operationFailures = {};
    }

    return parsed;
  } catch (err) {
    reportStateLoadFailure("circuit-breaker state", path, err, warn);
    return emptyState();
  }
}

/**
 * Record a scan cycle with no progress.
 *
 * Increments the zero-progress counter and persists to disk.
 */
export async function recordZeroProgress(
  config: CircuitBreakerConfig,
): Promise<Result<CircuitBreakerState>> {
  return await withStateLock(`circuit-breaker:${config.workDir}`, async () => {
    const state = await loadState(config.workDir, config.stateExpirySeconds);
    state.zeroCycles += 1;
    state.lastUpdated = nowSeconds();

    if (state.zeroCycles > config.threshold) {
      incrementCounter("circuitBreakerActivations");
    }

    const writeResult = await persistState(config.workDir, state);
    if (!writeResult.ok) return writeResult as Result<CircuitBreakerState>;

    return { ok: true, value: state };
  });
}

/**
 * Reset the circuit breaker (call after any successful work).
 */
export async function reset(
  config: CircuitBreakerConfig,
): Promise<Result<CircuitBreakerState>> {
  return await withStateLock(`circuit-breaker:${config.workDir}`, async () => {
    const state = await loadState(config.workDir, config.stateExpirySeconds);
    const wasActive = state.zeroCycles > config.threshold;
    state.zeroCycles = 0;
    state.lastUpdated = nowSeconds();

    const writeResult = await persistState(config.workDir, state);
    if (!writeResult.ok) return writeResult as Result<CircuitBreakerState>;

    return {
      ok: true,
      value: { ...state, _wasActive: wasActive } as CircuitBreakerState,
    };
  });
}

/**
 * Calculate exponential backoff interval.
 *
 * Returns base interval when below threshold, or base * 2^(cycles - threshold)
 * when above, capped at creditWaitInterval.
 */
export function calculateSleepInterval(
  zeroCycles: number,
  threshold: number,
  sleepInterval: number,
  creditWaitInterval: number,
): number {
  if (zeroCycles <= threshold) {
    return sleepInterval;
  }
  const exponent = zeroCycles - threshold;
  const multiplier = Math.pow(2, exponent);
  const interval = sleepInterval * multiplier;
  return Math.min(interval, creditWaitInterval);
}

/**
 * Get the current sleep interval based on state.
 */
export async function getSleepInterval(
  config: CircuitBreakerConfig,
): Promise<number> {
  const state = await loadState(config.workDir, config.stateExpirySeconds);
  return calculateSleepInterval(
    state.zeroCycles,
    config.threshold,
    config.sleepInterval,
    config.creditWaitInterval,
  );
}

/**
 * Check whether the circuit breaker backoff is currently active.
 */
export async function isActive(
  config: CircuitBreakerConfig,
): Promise<boolean> {
  const state = await loadState(config.workDir, config.stateExpirySeconds);
  return state.zeroCycles > config.threshold;
}

// ============================================================================
// Operation-specific backoff (Issue #620)
// ============================================================================

/**
 * Record a consecutive failure for a specific operation.
 *
 * Returns the new failure count.
 */
export async function recordOperationFailure(
  config: CircuitBreakerConfig,
  operation: string,
): Promise<Result<number>> {
  return await withStateLock(`circuit-breaker:${config.workDir}`, async () => {
    const state = await loadState(config.workDir, config.stateExpirySeconds);
    const current = state.operationFailures[operation] ?? 0;
    state.operationFailures[operation] = current + 1;
    state.lastUpdated = nowSeconds();

    const writeResult = await persistState(config.workDir, state);
    if (!writeResult.ok) return { ok: false, error: writeResult.error };

    return { ok: true, value: current + 1 };
  });
}

/**
 * Reset the failure counter for a specific operation (call on success).
 */
export async function resetOperation(
  config: CircuitBreakerConfig,
  operation: string,
): Promise<Result<number>> {
  return await withStateLock(`circuit-breaker:${config.workDir}`, async () => {
    const state = await loadState(config.workDir, config.stateExpirySeconds);
    const previous = state.operationFailures[operation] ?? 0;
    state.operationFailures[operation] = 0;
    state.lastUpdated = nowSeconds();

    const writeResult = await persistState(config.workDir, state);
    if (!writeResult.ok) return { ok: false, error: writeResult.error };

    return { ok: true, value: previous };
  });
}

/**
 * Get the consecutive failure count for an operation.
 */
export async function getOperationFailureCount(
  config: CircuitBreakerConfig,
  operation: string,
): Promise<number> {
  const state = await loadState(config.workDir, config.stateExpirySeconds);
  return state.operationFailures[operation] ?? 0;
}

/**
 * Calculate backoff interval for an operation based on failure count.
 */
export function calculateOperationSleepInterval(
  failureCount: number,
  operationBackoffThreshold: number,
  sleepInterval: number,
  creditWaitInterval: number,
): number {
  if (failureCount < operationBackoffThreshold) {
    return sleepInterval;
  }
  const exponent = failureCount - 1;
  const multiplier = Math.pow(2, exponent);
  const interval = sleepInterval * multiplier;
  return Math.min(interval, creditWaitInterval);
}

/**
 * Get the current backoff interval for a specific operation.
 */
export async function getOperationSleepInterval(
  config: CircuitBreakerConfig,
  operation: string,
): Promise<number> {
  const failureCount = await getOperationFailureCount(config, operation);
  return calculateOperationSleepInterval(
    failureCount,
    config.operationBackoffThreshold,
    config.sleepInterval,
    config.creditWaitInterval,
  );
}
