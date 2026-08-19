/**
 * Regression test suite — circuit breaker and failure tracker parity (Issue #1235).
 *
 * Validates that the Deno circuit breaker and failure tracker produce identical
 * behaviour to the original shell implementations, focusing on state persistence,
 * exponential backoff calculation, threshold logic, and edge cases.
 *
 * Uses Australian English spelling throughout (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  calculateOperationSleepInterval,
  calculateSleepInterval,
  type CircuitBreakerConfig,
  getOperationFailureCount,
  isActive,
  loadState as loadCircuitBreakerState,
  recordOperationFailure,
  recordZeroProgress,
  reset as resetCircuitBreaker,
  resetOperation,
} from "../lib/circuit_breaker.ts";
import {
  type FailureTrackerConfig,
  loadState as loadFailureState,
  resetFailures,
  shouldExitOnFailures,
  trackFailure,
} from "../lib/failure_tracker.ts";
import {
  cleanExpiredCooldowns,
  type CooldownConfig,
  isIssueInCooldown,
  loadState as loadCooldownState,
  recordIssueCooldown,
} from "../lib/cooldown_state.ts";

// ============================================================================
// Circuit Breaker — calculateSleepInterval edge cases
// ============================================================================

Deno.test("regression circuit_breaker - calculateSleepInterval at threshold returns base", () => {
  assertEquals(calculateSleepInterval(3, 3, 30, 300), 30);
});

Deno.test("regression circuit_breaker - calculateSleepInterval below threshold returns base", () => {
  assertEquals(calculateSleepInterval(0, 3, 30, 300), 30);
  assertEquals(calculateSleepInterval(1, 3, 30, 300), 30);
  assertEquals(calculateSleepInterval(2, 3, 30, 300), 30);
});

Deno.test("regression circuit_breaker - calculateSleepInterval exponential progression", () => {
  // threshold=3, base=30, max=300
  assertEquals(calculateSleepInterval(4, 3, 30, 300), 60); // 30 * 2^1
  assertEquals(calculateSleepInterval(5, 3, 30, 300), 120); // 30 * 2^2
  assertEquals(calculateSleepInterval(6, 3, 30, 300), 240); // 30 * 2^3
  assertEquals(calculateSleepInterval(7, 3, 30, 300), 300); // capped at max
});

Deno.test("regression circuit_breaker - calculateSleepInterval caps at creditWaitInterval", () => {
  assertEquals(calculateSleepInterval(100, 3, 30, 300), 300);
});

Deno.test("regression circuit_breaker - calculateSleepInterval with zero base interval", () => {
  assertEquals(calculateSleepInterval(5, 3, 0, 300), 0);
});

Deno.test("regression circuit_breaker - calculateSleepInterval with threshold 0", () => {
  // Everything above 0 applies backoff
  assertEquals(calculateSleepInterval(0, 0, 30, 300), 30);
  assertEquals(calculateSleepInterval(1, 0, 30, 300), 60);
});

// ============================================================================
// Circuit Breaker — state persistence edge cases
// ============================================================================

function makeCircuitConfig(workDir: string): CircuitBreakerConfig {
  return {
    workDir,
    threshold: 3,
    sleepInterval: 30,
    creditWaitInterval: 300,
    stateExpirySeconds: 3600,
    operationBackoffThreshold: 2,
  };
}

Deno.test("regression circuit_breaker - loadState returns empty for missing state file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const state = await loadCircuitBreakerState(tmpDir);
    assertEquals(state.zeroCycles, 0);
    assertEquals(state.operationFailures, {});
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression circuit_breaker - loadState returns empty for malformed JSON", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tmpDir}/.circuit_breaker_state.json`,
      "not valid json",
    );
    const state = await loadCircuitBreakerState(tmpDir);
    assertEquals(state.zeroCycles, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression circuit_breaker - loadState returns empty for invalid structure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tmpDir}/.circuit_breaker_state.json`,
      JSON.stringify({ zeroCycles: "not-a-number", lastUpdated: 12345 }),
    );
    const state = await loadCircuitBreakerState(tmpDir);
    assertEquals(state.zeroCycles, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression circuit_breaker - loadState returns empty for expired state", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    await Deno.writeTextFile(
      `${tmpDir}/.circuit_breaker_state.json`,
      JSON.stringify({
        zeroCycles: 5,
        lastUpdated: oldTime,
        operationFailures: {},
      }),
    );
    const state = await loadCircuitBreakerState(tmpDir, 3600);
    assertEquals(state.zeroCycles, 0, "Expired state should return empty");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression circuit_breaker - loadState with empty workDir returns empty", async () => {
  const state = await loadCircuitBreakerState("");
  assertEquals(state.zeroCycles, 0);
});

// ============================================================================
// Circuit Breaker — recordZeroProgress and reset cycle
// ============================================================================

Deno.test("regression circuit_breaker - recordZeroProgress increments and persists", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeCircuitConfig(tmpDir);
    const result1 = await recordZeroProgress(config);
    assert(result1.ok);
    assertEquals(result1.ok ? result1.value.zeroCycles : -1, 1);

    const result2 = await recordZeroProgress(config);
    assert(result2.ok);
    assertEquals(result2.ok ? result2.value.zeroCycles : -1, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression circuit_breaker - reset clears zero cycles", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeCircuitConfig(tmpDir);
    await recordZeroProgress(config);
    await recordZeroProgress(config);

    const resetResult = await resetCircuitBreaker(config);
    assert(resetResult.ok);
    assertEquals(resetResult.ok ? resetResult.value.zeroCycles : -1, 0);

    // Verify persisted
    const state = await loadCircuitBreakerState(tmpDir);
    assertEquals(state.zeroCycles, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression circuit_breaker - isActive reflects threshold state", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeCircuitConfig(tmpDir);
    assertEquals(await isActive(config), false);

    // Record 3 zero cycles (at threshold, not above)
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    await recordZeroProgress(config);
    assertEquals(
      await isActive(config),
      false,
      "At threshold should not be active",
    );

    // Record 4th (above threshold)
    await recordZeroProgress(config);
    assertEquals(
      await isActive(config),
      true,
      "Above threshold should be active",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Circuit Breaker — operation-specific backoff
// ============================================================================

Deno.test("regression circuit_breaker - operation failures tracked independently", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeCircuitConfig(tmpDir);
    await recordOperationFailure(config, "pr_creation");
    await recordOperationFailure(config, "api_calls");
    await recordOperationFailure(config, "pr_creation");

    assertEquals(await getOperationFailureCount(config, "pr_creation"), 2);
    assertEquals(await getOperationFailureCount(config, "api_calls"), 1);
    assertEquals(await getOperationFailureCount(config, "unknown_op"), 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression circuit_breaker - resetOperation clears only specified operation", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeCircuitConfig(tmpDir);
    await recordOperationFailure(config, "op_a");
    await recordOperationFailure(config, "op_b");

    await resetOperation(config, "op_a");
    assertEquals(await getOperationFailureCount(config, "op_a"), 0);
    assertEquals(await getOperationFailureCount(config, "op_b"), 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression circuit_breaker - calculateOperationSleepInterval below threshold", () => {
  assertEquals(calculateOperationSleepInterval(0, 2, 30, 300), 30);
  assertEquals(calculateOperationSleepInterval(1, 2, 30, 300), 30);
});

Deno.test("regression circuit_breaker - calculateOperationSleepInterval at and above threshold", () => {
  assertEquals(calculateOperationSleepInterval(2, 2, 30, 300), 60); // 30 * 2^1
  assertEquals(calculateOperationSleepInterval(3, 2, 30, 300), 120); // 30 * 2^2
});

// ============================================================================
// Failure Tracker — key-based discrimination
// ============================================================================

function makeFailureConfig(workDir: string): FailureTrackerConfig {
  return {
    workDir,
    maxConsecutiveFailures: 3,
    stateExpirySeconds: 3600,
  };
}

Deno.test("regression failure_tracker - same key increments failure count", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeFailureConfig(tmpDir);
    await trackFailure(config, "issue|org/repo|42");
    const result = await trackFailure(config, "issue|org/repo|42");
    assert(result.ok);
    assertEquals(result.ok ? result.value.consecutiveFailures : -1, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression failure_tracker - different key resets count to 1", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeFailureConfig(tmpDir);
    await trackFailure(config, "issue|org/repo|42");
    await trackFailure(config, "issue|org/repo|42");
    const result = await trackFailure(config, "issue|org/repo|99");
    assert(result.ok);
    assertEquals(result.ok ? result.value.consecutiveFailures : -1, 1);
    assertEquals(
      result.ok ? result.value.lastFailureKey : "",
      "issue|org/repo|99",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression failure_tracker - shouldExitOnFailures at threshold", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeFailureConfig(tmpDir);
    const key = "issue|org/repo|42";
    await trackFailure(config, key);
    await trackFailure(config, key);
    assertEquals(await shouldExitOnFailures(config), false, "Below threshold");

    await trackFailure(config, key);
    assertEquals(
      await shouldExitOnFailures(config),
      true,
      "At threshold should exit",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression failure_tracker - resetFailures clears state", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeFailureConfig(tmpDir);
    await trackFailure(config, "key");
    await trackFailure(config, "key");

    await resetFailures(config);
    assertEquals(await shouldExitOnFailures(config), false);

    const state = await loadFailureState(tmpDir);
    assertEquals(state.consecutiveFailures, 0);
    assertEquals(state.lastFailureKey, "");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression failure_tracker - loadState with empty workDir", async () => {
  const state = await loadFailureState("");
  assertEquals(state.consecutiveFailures, 0);
  assertEquals(state.lastFailureKey, "");
});

Deno.test("regression failure_tracker - loadState with malformed JSON", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/.failure_state.json`, "{broken json");
    const state = await loadFailureState(tmpDir);
    assertEquals(state.consecutiveFailures, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression failure_tracker - loadState with invalid field types", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tmpDir}/.failure_state.json`,
      JSON.stringify({
        consecutiveFailures: "not-a-number",
        lastFailureKey: 42,
      }),
    );
    const state = await loadFailureState(tmpDir);
    assertEquals(
      state.consecutiveFailures,
      0,
      "Invalid types should return empty state",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression failure_tracker - loadState respects expiry", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const oldTime = Math.floor(Date.now() / 1000) - 7200;
    await Deno.writeTextFile(
      `${tmpDir}/.failure_state.json`,
      JSON.stringify({
        consecutiveFailures: 5,
        lastFailureKey: "stale-key",
        lastFailureTimestamp: oldTime,
      }),
    );
    const state = await loadFailureState(tmpDir, 3600);
    assertEquals(state.consecutiveFailures, 0, "Expired state should reset");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression failure_tracker - failure key with special characters", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeFailureConfig(tmpDir);
    const specialKey = "issue|org/repo|42|special chars: <>&\"'";
    const result = await trackFailure(config, specialKey);
    assert(result.ok);
    assertEquals(result.ok ? result.value.lastFailureKey : "", specialKey);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Cooldown State — edge cases
// ============================================================================

function makeCooldownConfig(workDir: string): CooldownConfig {
  return {
    workDir,
    issueRetryCooldown: 600,
  };
}

Deno.test("regression cooldown - loadState with empty workDir returns empty", async () => {
  const state = await loadCooldownState("");
  assertEquals(state.entries.length, 0);
});

Deno.test("regression cooldown - loadState with malformed JSON returns empty", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmpDir}/.cooldown_state.json`, "not json");
    const state = await loadCooldownState(tmpDir);
    assertEquals(state.entries.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression cooldown - loadState cleans entries with invalid fields", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const now = Math.floor(Date.now() / 1000);
    await Deno.writeTextFile(
      `${tmpDir}/.cooldown_state.json`,
      JSON.stringify({
        entries: [
          { repo: 42, issueNumber: 1, timestamp: now }, // invalid repo type
          { repo: "org/repo", issueNumber: "1", timestamp: now }, // invalid issueNumber type
          { repo: "org/repo", issueNumber: 1, timestamp: now }, // valid
        ],
      }),
    );
    const state = await loadCooldownState(tmpDir, 600);
    assertEquals(state.entries.length, 1, "Should only keep valid entries");
    assertEquals(state.entries[0]!.repo, "org/repo");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression cooldown - isIssueInCooldown differentiates repos", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeCooldownConfig(tmpDir);
    await recordIssueCooldown(config, "org/repo-a", 42);

    assertEquals(
      await isIssueInCooldown(config, "org/repo-a", 42),
      true,
      "Same repo/issue should be in cooldown",
    );
    assertEquals(
      await isIssueInCooldown(config, "org/repo-b", 42),
      false,
      "Different repo should not be in cooldown",
    );
    assertEquals(
      await isIssueInCooldown(config, "org/repo-a", 99),
      false,
      "Different issue should not be in cooldown",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("regression cooldown - cleanExpiredCooldowns removes old entries", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const config = makeCooldownConfig(tmpDir);
    const now = Math.floor(Date.now() / 1000);

    // Write state with mixed fresh and expired entries
    await Deno.writeTextFile(
      `${tmpDir}/.cooldown_state.json`,
      JSON.stringify({
        entries: [
          { repo: "org/old", issueNumber: 1, timestamp: now - 1000 }, // expired
          { repo: "org/fresh", issueNumber: 2, timestamp: now - 10 }, // fresh
        ],
      }),
    );

    const result = await cleanExpiredCooldowns(config);
    assert(result.ok);
    if (result.ok) {
      assertEquals(result.value.entries.length, 1);
      assertEquals(result.value.entries[0]!.repo, "org/fresh");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
