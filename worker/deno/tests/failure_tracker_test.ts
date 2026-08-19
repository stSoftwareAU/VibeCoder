/**
 * Tests for failure_tracker.ts — consecutive failure tracking and
 * self-healing exit thresholds (Issue #451, #908).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  FAILURE_TRACKER_DEFAULTS,
  type FailureTrackerConfig,
  loadState,
  resetFailures,
  shouldExitOnFailures,
  trackFailure,
} from "../lib/failure_tracker.ts";

/** Create a temp directory for test state files. */
async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "ft-test-" });
}

/** Build a test config with the given workDir. */
function testConfig(workDir: string): FailureTrackerConfig {
  return {
    workDir,
    maxConsecutiveFailures: FAILURE_TRACKER_DEFAULTS.maxConsecutiveFailures,
    stateExpirySeconds: FAILURE_TRACKER_DEFAULTS.stateExpirySeconds,
  };
}

// ============================================================================
// loadState
// ============================================================================

Deno.test("failure tracker - loadState returns empty state when no file exists", async () => {
  const dir = await makeTempDir();
  try {
    const state = await loadState(dir);
    assertEquals(state.consecutiveFailures, 0);
    assertEquals(state.lastFailureKey, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failure tracker - loadState returns empty state when workDir is empty", async () => {
  const state = await loadState("");
  assertEquals(state.consecutiveFailures, 0);
});

// ============================================================================
// trackFailure
// ============================================================================

Deno.test("failure tracker - trackFailure increments counter for same key", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const r1 = await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    assertEquals(r1.ok, true);
    if (r1.ok) assertEquals(r1.value.consecutiveFailures, 1);

    const r2 = await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    if (r2.ok) assertEquals(r2.value.consecutiveFailures, 2);

    const r3 = await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    if (r3.ok) assertEquals(r3.value.consecutiveFailures, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failure tracker - trackFailure resets counter for different key", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");

    const result = await trackFailure(config, "issue|example-org/private-repo-13|42");
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.consecutiveFailures, 1);
      assertEquals(result.value.lastFailureKey, "issue|example-org/private-repo-13|42");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// resetFailures
// ============================================================================

Deno.test("failure tracker - resetFailures clears counter and key", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");

    const result = await resetFailures(config);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.consecutiveFailures, 0);
      assertEquals(result.value.lastFailureKey, "");
    }

    // Verify persisted state is also cleared
    const state = await loadState(dir);
    assertEquals(state.consecutiveFailures, 0);
    assertEquals(state.lastFailureKey, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// shouldExitOnFailures
// ============================================================================

Deno.test("failure tracker - shouldExitOnFailures returns false below threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");

    const shouldExit = await shouldExitOnFailures(config);
    assertEquals(shouldExit, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failure tracker - shouldExitOnFailures returns true at threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");

    const shouldExit = await shouldExitOnFailures(config);
    assertEquals(shouldExit, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failure tracker - shouldExitOnFailures returns true above threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");

    const shouldExit = await shouldExitOnFailures(config);
    assertEquals(shouldExit, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// State expiry
// ============================================================================

Deno.test("failure tracker - expired state is treated as empty", async () => {
  const dir = await makeTempDir();
  try {
    const oldState = {
      consecutiveFailures: 2,
      lastFailureKey: "spelling|example-org/private-repo-13|1277",
      lastFailureTimestamp: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
    };
    await Deno.writeTextFile(
      `${dir}/.failure_state.json`,
      JSON.stringify(oldState),
    );

    const state = await loadState(dir, 3600); // 1 hour expiry
    assertEquals(state.consecutiveFailures, 0);
    assertEquals(state.lastFailureKey, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failure tracker - non-expired state is preserved", async () => {
  const dir = await makeTempDir();
  try {
    const recentState = {
      consecutiveFailures: 2,
      lastFailureKey: "issue|example-org/private-repo-13|42",
      lastFailureTimestamp: Math.floor(Date.now() / 1000),
    };
    await Deno.writeTextFile(
      `${dir}/.failure_state.json`,
      JSON.stringify(recentState),
    );

    const state = await loadState(dir, 3600);
    assertEquals(state.consecutiveFailures, 2);
    assertEquals(state.lastFailureKey, "issue|example-org/private-repo-13|42");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Persistence (survives simulated restart)
// ============================================================================

Deno.test("failure tracker - state persists and reloads correctly", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");

    // Simulate restart: reload from disk
    const state = await loadState(dir);
    assertEquals(state.consecutiveFailures, 2);
    assertEquals(state.lastFailureKey, "spelling|example-org/private-repo-13|1277");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failure tracker - resetFailures clears persisted state", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await trackFailure(config, "spelling|example-org/private-repo-13|1277");
    await resetFailures(config);

    // Simulate restart: reload from disk
    const state = await loadState(dir);
    assertEquals(state.consecutiveFailures, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Defaults
// ============================================================================

Deno.test("failure tracker - defaults have expected values", () => {
  assertEquals(FAILURE_TRACKER_DEFAULTS.maxConsecutiveFailures, 3);
  assertEquals(FAILURE_TRACKER_DEFAULTS.stateExpirySeconds, 3600);
});

// ============================================================================
// Concurrent slots (Issue #4180)
// ============================================================================

Deno.test("failure tracker - three concurrent trackFailure calls for one key count 3, not 1 (Issue #4180)", async () => {
  const workDir = await makeTempDir();
  try {
    const config = testConfig(workDir);
    // Without the state mutex each call reads 0, writes 1 — the last
    // writer wins and the pool's failure budget silently multiplies.
    await Promise.all([
      trackFailure(config, "issue|o/a|1"),
      trackFailure(config, "issue|o/a|1"),
      trackFailure(config, "issue|o/a|1"),
    ]);
    const state = await loadState(workDir, config.stateExpirySeconds);
    assertEquals(state.consecutiveFailures, 3);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("failure tracker - concurrent trackFailure and resetFailures serialise in call order (Issue #4180)", async () => {
  const workDir = await makeTempDir();
  try {
    const config = testConfig(workDir);
    await Promise.all([
      trackFailure(config, "issue|o/a|1"),
      trackFailure(config, "issue|o/a|1"),
      resetFailures(config),
      trackFailure(config, "issue|o/b|2"),
    ]);
    const state = await loadState(workDir, config.stateExpirySeconds);
    assertEquals(state.consecutiveFailures, 1);
    assertEquals(state.lastFailureKey, "issue|o/b|2");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
