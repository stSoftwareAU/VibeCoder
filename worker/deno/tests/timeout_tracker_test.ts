/**
 * Tests for timeout_tracker.ts — per-repository timeout tracking
 * with escalating cooldowns (Issue #1168).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  calculateCooldown,
  cleanupExpiredTimeouts,
  DEFAULT_BASE_COOLDOWN_SECONDS,
  DEFAULT_MAX_COOLDOWN_SECONDS,
  getRepoTimeoutState,
  isRepoInTimeoutCooldown,
  recordRepoTimeout,
  recordRepoTimeoutSuccess,
  type TimeoutTrackerConfig,
} from "../lib/timeout_tracker.ts";
import { resetFaultCounters } from "../lib/fault_tolerance_counters.ts";

function createTestConfig(tmpDir: string): TimeoutTrackerConfig {
  return {
    stateFile: `${tmpDir}/timeout_state.json`,
    baseCooldownSeconds: DEFAULT_BASE_COOLDOWN_SECONDS,
    maxCooldownSeconds: DEFAULT_MAX_COOLDOWN_SECONDS,
  };
}

Deno.test("timeout_tracker - calculateCooldown returns 0 for no timeouts", () => {
  assertEquals(calculateCooldown(0, 300, 3600), 0);
});

Deno.test("timeout_tracker - calculateCooldown returns base for first timeout", () => {
  assertEquals(calculateCooldown(1, 300, 3600), 300);
});

Deno.test("timeout_tracker - calculateCooldown doubles each consecutive timeout", () => {
  assertEquals(calculateCooldown(2, 300, 3600), 600);
  assertEquals(calculateCooldown(3, 300, 3600), 1200);
});

Deno.test("timeout_tracker - calculateCooldown caps at max", () => {
  assertEquals(calculateCooldown(10, 300, 3600), 3600);
});

Deno.test("timeout_tracker - recordRepoTimeout tracks consecutive timeouts", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir({ prefix: "tt-test-" });
  const config = createTestConfig(tmpDir);

  const result1 = await recordRepoTimeout(config, "org/repo1", () => 1000);
  assertEquals(result1.ok, true);
  if (result1.ok) {
    assertEquals(result1.value.consecutiveTimeouts, 1);
    assertEquals(result1.value.lastTimeoutEpoch, 1000);
  }

  const result2 = await recordRepoTimeout(config, "org/repo1", () => 2000);
  assertEquals(result2.ok, true);
  if (result2.ok) {
    assertEquals(result2.value.consecutiveTimeouts, 2);
    assertEquals(result2.value.lastTimeoutEpoch, 2000);
  }

  await Deno.remove(tmpDir, { recursive: true });
  resetFaultCounters();
});

Deno.test("timeout_tracker - recordRepoTimeoutSuccess resets counter", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir({ prefix: "tt-test-" });
  const config = createTestConfig(tmpDir);

  await recordRepoTimeout(config, "org/repo1", () => 1000);
  await recordRepoTimeout(config, "org/repo1", () => 2000);

  const successResult = await recordRepoTimeoutSuccess(config, "org/repo1");
  assertEquals(successResult.ok, true);

  const state = await getRepoTimeoutState(config, "org/repo1");
  assertEquals(state, null);

  await Deno.remove(tmpDir, { recursive: true });
  resetFaultCounters();
});

Deno.test("timeout_tracker - isRepoInTimeoutCooldown checks correctly", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir({ prefix: "tt-test-" });
  const config = createTestConfig(tmpDir);

  await recordRepoTimeout(config, "org/repo1", () => 1000);

  const inCooldown = await isRepoInTimeoutCooldown(
    config,
    "org/repo1",
    () => 1100,
  );
  assertEquals(inCooldown, true);

  const afterCooldown = await isRepoInTimeoutCooldown(
    config,
    "org/repo1",
    () => 1000 + 300 + 1,
  );
  assertEquals(afterCooldown, false);

  await Deno.remove(tmpDir, { recursive: true });
  resetFaultCounters();
});

Deno.test("timeout_tracker - different repos tracked independently", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir({ prefix: "tt-test-" });
  const config = createTestConfig(tmpDir);

  await recordRepoTimeout(config, "org/repo1", () => 1000);
  await recordRepoTimeout(config, "org/repo2", () => 1000);
  await recordRepoTimeout(config, "org/repo2", () => 2000);

  const state1 = await getRepoTimeoutState(config, "org/repo1");
  const state2 = await getRepoTimeoutState(config, "org/repo2");

  assertEquals(state1?.consecutiveTimeouts, 1);
  assertEquals(state2?.consecutiveTimeouts, 2);

  await Deno.remove(tmpDir, { recursive: true });
  resetFaultCounters();
});

Deno.test("timeout_tracker - cleanupExpiredTimeouts removes old entries", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir({ prefix: "tt-test-" });
  const config = createTestConfig(tmpDir);

  await recordRepoTimeout(config, "org/repo1", () => 1000);
  await recordRepoTimeout(config, "org/repo2", () => 2000);

  const result = await cleanupExpiredTimeouts(config, () => 1000 + 300 + 1);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 1);
  }

  const state1 = await getRepoTimeoutState(config, "org/repo1");
  assertEquals(state1, null);

  const state2 = await getRepoTimeoutState(config, "org/repo2");
  assertEquals(state2?.consecutiveTimeouts, 1);

  await Deno.remove(tmpDir, { recursive: true });
  resetFaultCounters();
});

Deno.test("timeout_tracker - no state file returns safe defaults", async () => {
  const config: TimeoutTrackerConfig = {
    stateFile: "",
    baseCooldownSeconds: 300,
    maxCooldownSeconds: 3600,
  };

  assertEquals(await isRepoInTimeoutCooldown(config, "org/repo1"), false);
  assertEquals(await getRepoTimeoutState(config, "org/repo1"), null);
});

Deno.test("timeout_tracker - escalating cooldown applied correctly", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir({ prefix: "tt-test-" });
  const config = createTestConfig(tmpDir);

  const r1 = await recordRepoTimeout(config, "org/repo1", () => 1000);
  if (r1.ok) {
    assertEquals(r1.value.cooldownUntilEpoch, 1000 + 300);
  }

  const r2 = await recordRepoTimeout(config, "org/repo1", () => 2000);
  if (r2.ok) {
    assertEquals(r2.value.cooldownUntilEpoch, 2000 + 600);
  }

  const r3 = await recordRepoTimeout(config, "org/repo1", () => 3000);
  if (r3.ok) {
    assertEquals(r3.value.cooldownUntilEpoch, 3000 + 1200);
  }

  await Deno.remove(tmpDir, { recursive: true });
  resetFaultCounters();
});
