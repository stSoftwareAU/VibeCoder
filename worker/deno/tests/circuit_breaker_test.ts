/**
 * Tests for circuit_breaker.ts — scan-cycle backoff and operation-specific
 * failure tracking (Issue #588, #620, #908).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertGreater } from "@std/assert";
import {
  calculateOperationSleepInterval,
  calculateSleepInterval,
  CIRCUIT_BREAKER_DEFAULTS,
  type CircuitBreakerConfig,
  getOperationFailureCount,
  getOperationSleepInterval,
  getSleepInterval,
  isActive,
  loadState,
  recordOperationFailure,
  recordZeroProgress,
  reset,
  resetOperation,
} from "../lib/circuit_breaker.ts";

/** Create a temp directory for test state files. */
async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "cb-test-" });
}

/** Build a test config with the given workDir. */
function testConfig(workDir: string): CircuitBreakerConfig {
  return {
    workDir,
    threshold: CIRCUIT_BREAKER_DEFAULTS.threshold,
    sleepInterval: CIRCUIT_BREAKER_DEFAULTS.sleepInterval,
    creditWaitInterval: CIRCUIT_BREAKER_DEFAULTS.creditWaitInterval,
    stateExpirySeconds: CIRCUIT_BREAKER_DEFAULTS.stateExpirySeconds,
    operationBackoffThreshold:
      CIRCUIT_BREAKER_DEFAULTS.operationBackoffThreshold,
  };
}

// ============================================================================
// loadState
// ============================================================================

Deno.test("circuit breaker - loadState returns empty state when no file exists", async () => {
  const dir = await makeTempDir();
  try {
    const state = await loadState(dir);
    assertEquals(state.zeroCycles, 0);
    assertEquals(state.operationFailures, {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("circuit breaker - loadState returns empty state when workDir is empty", async () => {
  const state = await loadState("");
  assertEquals(state.zeroCycles, 0);
});

// ============================================================================
// recordZeroProgress
// ============================================================================

Deno.test("circuit breaker - recordZeroProgress increments counter from zero", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const result = await recordZeroProgress(config);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.zeroCycles, 1);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("circuit breaker - recordZeroProgress increments cumulatively", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    const result = await recordZeroProgress(config);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.zeroCycles, 3);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// reset
// ============================================================================

Deno.test("circuit breaker - reset sets counter to zero", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);

    const result = await reset(config);
    assertEquals(result.ok, true);

    // Verify persisted state is also zero
    const state = await loadState(dir);
    assertEquals(state.zeroCycles, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// calculateSleepInterval
// ============================================================================

Deno.test("circuit breaker - returns base interval below threshold", () => {
  assertEquals(calculateSleepInterval(2, 3, 30, 300), 30);
});

Deno.test("circuit breaker - returns base interval at threshold", () => {
  // At threshold: exponent = 0, 2^0 = 1, 30 * 1 = 30
  assertEquals(calculateSleepInterval(3, 3, 30, 300), 30);
});

Deno.test("circuit breaker - backs off exponentially past threshold", () => {
  // 1 past: exponent = 1, 30 * 2 = 60
  assertEquals(calculateSleepInterval(4, 3, 30, 300), 60);
  // 2 past: exponent = 2, 30 * 4 = 120
  assertEquals(calculateSleepInterval(5, 3, 30, 300), 120);
  // 3 past: exponent = 3, 30 * 8 = 240
  assertEquals(calculateSleepInterval(6, 3, 30, 300), 240);
});

Deno.test("circuit breaker - caps at creditWaitInterval", () => {
  assertEquals(calculateSleepInterval(20, 3, 30, 300), 300);
});

Deno.test("circuit breaker - full progression 30 -> 60 -> 120 -> 240 -> 300", () => {
  const results = [0, 1, 2, 3, 4, 5, 6, 7].map((cycles) =>
    calculateSleepInterval(cycles, 3, 30, 300)
  );
  assertEquals(results, [30, 30, 30, 30, 60, 120, 240, 300]);
});

// ============================================================================
// getSleepInterval (integration with state file)
// ============================================================================

Deno.test("circuit breaker - getSleepInterval reads persisted state", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    // Record 4 zero-progress cycles (1 past threshold)
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);

    const interval = await getSleepInterval(config);
    assertEquals(interval, 60);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// isActive
// ============================================================================

Deno.test("circuit breaker - isActive returns false below threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    const active = await isActive(config);
    assertEquals(active, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("circuit breaker - isActive returns true above threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    const active = await isActive(config);
    assertEquals(active, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// State expiry
// ============================================================================

Deno.test("circuit breaker - expired state is treated as empty", async () => {
  const dir = await makeTempDir();
  try {
    // Write a state file with an old timestamp
    const oldState = {
      zeroCycles: 5,
      lastUpdated: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
      operationFailures: {},
    };
    await Deno.writeTextFile(
      `${dir}/.circuit_breaker_state.json`,
      JSON.stringify(oldState),
    );

    const state = await loadState(dir, 3600); // 1 hour expiry
    assertEquals(state.zeroCycles, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("circuit breaker - non-expired state is preserved", async () => {
  const dir = await makeTempDir();
  try {
    const recentState = {
      zeroCycles: 5,
      lastUpdated: Math.floor(Date.now() / 1000),
      operationFailures: {},
    };
    await Deno.writeTextFile(
      `${dir}/.circuit_breaker_state.json`,
      JSON.stringify(recentState),
    );

    const state = await loadState(dir, 3600);
    assertEquals(state.zeroCycles, 5);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Persistence (survives simulated restart)
// ============================================================================

Deno.test("circuit breaker - state persists and reloads correctly", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);

    // Simulate restart: reload from disk
    const state = await loadState(dir);
    assertEquals(state.zeroCycles, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Operation-specific backoff (Issue #620)
// ============================================================================

Deno.test("circuit breaker - recordOperationFailure increments count", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const r1 = await recordOperationFailure(config, "pr_creation");
    assertEquals(r1.ok, true);
    if (r1.ok) assertEquals(r1.value, 1);

    const r2 = await recordOperationFailure(config, "pr_creation");
    if (r2.ok) assertEquals(r2.value, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("circuit breaker - resetOperation clears count", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordOperationFailure(config, "pr_creation");
    await recordOperationFailure(config, "pr_creation");
    await recordOperationFailure(config, "pr_creation");

    const result = await resetOperation(config, "pr_creation");
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, 3); // returns previous count

    const count = await getOperationFailureCount(config, "pr_creation");
    assertEquals(count, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("circuit breaker - getOperationFailureCount returns 0 for unknown operation", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const count = await getOperationFailureCount(config, "nonexistent");
    assertEquals(count, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("circuit breaker - operations are tracked independently", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordOperationFailure(config, "pr_creation");
    await recordOperationFailure(config, "pr_creation");
    await recordOperationFailure(config, "issue_claiming");

    const prCount = await getOperationFailureCount(config, "pr_creation");
    const claimCount = await getOperationFailureCount(config, "issue_claiming");
    assertEquals(prCount, 2);
    assertEquals(claimCount, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// calculateOperationSleepInterval
// ============================================================================

Deno.test("circuit breaker - operation backoff returns base below threshold", () => {
  assertEquals(calculateOperationSleepInterval(1, 2, 30, 300), 30);
});

Deno.test("circuit breaker - operation backoff applies exponential after threshold", () => {
  // 2 failures: exponent = 1, 30 * 2 = 60
  assertEquals(calculateOperationSleepInterval(2, 2, 30, 300), 60);
  // 3 failures: exponent = 2, 30 * 4 = 120
  assertEquals(calculateOperationSleepInterval(3, 2, 30, 300), 120);
});

Deno.test("circuit breaker - operation backoff caps at creditWaitInterval", () => {
  assertEquals(calculateOperationSleepInterval(20, 2, 30, 300), 300);
});

Deno.test("circuit breaker - getOperationSleepInterval integrates with state", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    // Below threshold: base interval
    const interval1 = await getOperationSleepInterval(config, "pr_creation");
    assertEquals(interval1, 30);

    // Record 2 failures (at threshold)
    await recordOperationFailure(config, "pr_creation");
    await recordOperationFailure(config, "pr_creation");
    const interval2 = await getOperationSleepInterval(config, "pr_creation");
    assertGreater(interval2, 30);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Defaults
// ============================================================================

Deno.test("circuit breaker - defaults have expected values", () => {
  assertEquals(CIRCUIT_BREAKER_DEFAULTS.threshold, 3);
  assertEquals(CIRCUIT_BREAKER_DEFAULTS.sleepInterval, 30);
  assertEquals(CIRCUIT_BREAKER_DEFAULTS.creditWaitInterval, 300);
  assertEquals(CIRCUIT_BREAKER_DEFAULTS.stateExpirySeconds, 3600);
  assertEquals(CIRCUIT_BREAKER_DEFAULTS.operationBackoffThreshold, 2);
});

// ============================================================================
// Concurrent slots (Issue #4180)
// ============================================================================

Deno.test("circuit breaker - concurrent recordZeroProgress calls each count (Issue #4180)", async () => {
  const workDir = await makeTempDir();
  try {
    const config = testConfig(workDir);
    await Promise.all([
      recordZeroProgress(config),
      recordZeroProgress(config),
      recordZeroProgress(config),
    ]);
    const state = await loadState(workDir, config.stateExpirySeconds);
    assertEquals(state.zeroCycles, 3);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("circuit breaker - concurrent recordOperationFailure for two operations both persist (Issue #4180)", async () => {
  const workDir = await makeTempDir();
  try {
    const config = testConfig(workDir);
    await Promise.all([
      recordOperationFailure(config, "op-a"),
      recordOperationFailure(config, "op-b"),
      recordOperationFailure(config, "op-a"),
    ]);
    assertEquals(await getOperationFailureCount(config, "op-a"), 2);
    assertEquals(await getOperationFailureCount(config, "op-b"), 1);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
