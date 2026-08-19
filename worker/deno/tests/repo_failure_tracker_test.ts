/**
 * Tests for repo_failure_tracker.ts — per-repo failure tracking
 * within a scan cycle (Issue #586, #909, #1066).
 *
 * Issue #1066: Repo deprioritisation now tracks unique failed issues
 * per repo, so a single failing issue cannot cascade into deprioritising
 * the entire repository.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_REPO_FAILURE_THRESHOLD,
  DEFAULT_REPO_TIMEOUT_THRESHOLD,
  getRepoFailedIssues,
  getRepoFailureCount,
  getRepoTimeoutCount,
  getTimeoutCooldownMultiplier,
  isRepoDeprioritised,
  isRepoTimeoutThrottled,
  recordRepoFailure,
  recordRepoSuccess,
  recordRepoTimeout,
  type RepoFailureTrackerConfig,
  resetRepoFailures,
} from "../lib/repo_failure_tracker.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "rft-test-" });
}

function testConfig(dir: string): RepoFailureTrackerConfig {
  return {
    failureFile: `${dir}/repo_failures`,
    threshold: DEFAULT_REPO_FAILURE_THRESHOLD,
    timeoutThreshold: DEFAULT_REPO_TIMEOUT_THRESHOLD,
  };
}

// ============================================================================
// getRepoFailureCount
// ============================================================================

Deno.test("repo failure tracker - returns 0 for unknown repo", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const count = await getRepoFailureCount(config, "org/repo1");
    assertEquals(count, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - returns 0 when no failure file", async () => {
  const config: RepoFailureTrackerConfig = {
    failureFile: "/nonexistent/path/failures",
    threshold: 3,
  };
  const count = await getRepoFailureCount(config, "org/repo1");
  assertEquals(count, 0);
});

// ============================================================================
// recordRepoFailure
// ============================================================================

Deno.test("repo failure tracker - records first failure", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const result = await recordRepoFailure(config, "org/repo1");
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, 1);

    const count = await getRepoFailureCount(config, "org/repo1");
    assertEquals(count, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - increments failure count", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo1");
    const result = await recordRepoFailure(config, "org/repo1");
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - tracks repos independently", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo2");

    assertEquals(await getRepoFailureCount(config, "org/repo1"), 2);
    assertEquals(await getRepoFailureCount(config, "org/repo2"), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// recordRepoSuccess
// ============================================================================

Deno.test("repo failure tracker - success resets failure count", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo1");
    await recordRepoSuccess(config, "org/repo1");

    assertEquals(await getRepoFailureCount(config, "org/repo1"), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - success for one repo does not affect another", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo2");
    await recordRepoSuccess(config, "org/repo1");

    assertEquals(await getRepoFailureCount(config, "org/repo1"), 0);
    assertEquals(await getRepoFailureCount(config, "org/repo2"), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// isRepoDeprioritised
// ============================================================================

Deno.test("repo failure tracker - not deprioritised below threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo1");
    assertEquals(await isRepoDeprioritised(config, "org/repo1"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - deprioritised at threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo1");
    assertEquals(await isRepoDeprioritised(config, "org/repo1"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - deprioritised above threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    for (let i = 0; i < 5; i++) await recordRepoFailure(config, "org/repo1");
    assertEquals(await isRepoDeprioritised(config, "org/repo1"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - custom threshold is respected", async () => {
  const dir = await makeTempDir();
  try {
    const config: RepoFailureTrackerConfig = {
      failureFile: `${dir}/repo_failures`,
      threshold: 1,
    };
    await recordRepoFailure(config, "org/repo1");
    assertEquals(await isRepoDeprioritised(config, "org/repo1"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// resetRepoFailures
// ============================================================================

Deno.test("repo failure tracker - reset clears all counts", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo2");
    await resetRepoFailures(config);

    assertEquals(await getRepoFailureCount(config, "org/repo1"), 0);
    assertEquals(await getRepoFailureCount(config, "org/repo2"), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Defaults
// ============================================================================

Deno.test("repo failure tracker - default threshold is 3", () => {
  assertEquals(DEFAULT_REPO_FAILURE_THRESHOLD, 3);
});

// ============================================================================
// Per-issue tracking (Issue #1066)
// ============================================================================

Deno.test("repo failure tracker - same issue failing repeatedly only counts once", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    // Same issue fails 3 times — should NOT deprioritise because it's only 1 unique issue
    await recordRepoFailure(config, "org/repo1", 1588);
    await recordRepoFailure(config, "org/repo1", 1588);
    await recordRepoFailure(config, "org/repo1", 1588);
    assertEquals(await getRepoFailureCount(config, "org/repo1"), 1);
    assertEquals(await isRepoDeprioritised(config, "org/repo1"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - different issues reaching threshold triggers deprioritisation", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1", 100);
    await recordRepoFailure(config, "org/repo1", 200);
    await recordRepoFailure(config, "org/repo1", 300);
    assertEquals(await getRepoFailureCount(config, "org/repo1"), 3);
    assertEquals(await isRepoDeprioritised(config, "org/repo1"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - mixed same and different issues count correctly", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1", 100);
    await recordRepoFailure(config, "org/repo1", 100); // duplicate — no increment
    await recordRepoFailure(config, "org/repo1", 200);
    assertEquals(await getRepoFailureCount(config, "org/repo1"), 2);
    assertEquals(await isRepoDeprioritised(config, "org/repo1"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - getRepoFailedIssues returns unique issue numbers", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1", 100);
    await recordRepoFailure(config, "org/repo1", 200);
    await recordRepoFailure(config, "org/repo1", 100); // duplicate
    const issues = await getRepoFailedIssues(config, "org/repo1");
    assertEquals(issues.length, 2);
    assertEquals(issues.includes(100), true);
    assertEquals(issues.includes(200), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - getRepoFailedIssues returns empty for unknown repo", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const issues = await getRepoFailedIssues(config, "org/unknown");
    assertEquals(issues.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - success clears all failed issues for repo", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1", 100);
    await recordRepoFailure(config, "org/repo1", 200);
    await recordRepoSuccess(config, "org/repo1");
    assertEquals(await getRepoFailureCount(config, "org/repo1"), 0);
    assertEquals((await getRepoFailedIssues(config, "org/repo1")).length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - backward compat: recordRepoFailure without issueNumber still increments", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    // Without issue number, each call should count as a unique failure (legacy behaviour)
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo1");
    await recordRepoFailure(config, "org/repo1");
    assertEquals(await getRepoFailureCount(config, "org/repo1"), 3);
    assertEquals(await isRepoDeprioritised(config, "org/repo1"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Per-repo timeout tracking (Issue #1168)
// ============================================================================

Deno.test("repo failure tracker - default timeout threshold is 3", () => {
  assertEquals(DEFAULT_REPO_TIMEOUT_THRESHOLD, 3);
});

Deno.test("repo failure tracker - records timeout for a repo", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const result = await recordRepoTimeout(config, "org/repo1");
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, 1);
    assertEquals(await getRepoTimeoutCount(config, "org/repo1"), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - timeout count increments", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoTimeout(config, "org/repo1");
    await recordRepoTimeout(config, "org/repo1");
    await recordRepoTimeout(config, "org/repo1");
    assertEquals(await getRepoTimeoutCount(config, "org/repo1"), 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - repo not timeout throttled below threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoTimeout(config, "org/repo1");
    await recordRepoTimeout(config, "org/repo1");
    assertEquals(await isRepoTimeoutThrottled(config, "org/repo1"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - repo timeout throttled at threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    for (let i = 0; i < DEFAULT_REPO_TIMEOUT_THRESHOLD; i++) {
      await recordRepoTimeout(config, "org/repo1");
    }
    assertEquals(await isRepoTimeoutThrottled(config, "org/repo1"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - custom timeout threshold is respected", async () => {
  const dir = await makeTempDir();
  try {
    const config: RepoFailureTrackerConfig = {
      failureFile: `${dir}/repo_failures`,
      threshold: DEFAULT_REPO_FAILURE_THRESHOLD,
      timeoutThreshold: 2,
    };
    await recordRepoTimeout(config, "org/repo1");
    assertEquals(await isRepoTimeoutThrottled(config, "org/repo1"), false);
    await recordRepoTimeout(config, "org/repo1");
    assertEquals(await isRepoTimeoutThrottled(config, "org/repo1"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - success clears timeout count", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoTimeout(config, "org/repo1");
    await recordRepoTimeout(config, "org/repo1");
    await recordRepoSuccess(config, "org/repo1");
    assertEquals(await getRepoTimeoutCount(config, "org/repo1"), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - timeout tracking is independent per repo", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoTimeout(config, "org/repo1");
    await recordRepoTimeout(config, "org/repo1");
    await recordRepoTimeout(config, "org/repo2");
    assertEquals(await getRepoTimeoutCount(config, "org/repo1"), 2);
    assertEquals(await getRepoTimeoutCount(config, "org/repo2"), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - reset clears timeout counts", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoTimeout(config, "org/repo1");
    await recordRepoTimeout(config, "org/repo2");
    await resetRepoFailures(config);
    assertEquals(await getRepoTimeoutCount(config, "org/repo1"), 0);
    assertEquals(await getRepoTimeoutCount(config, "org/repo2"), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - per-issue tracking across repos is independent", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoFailure(config, "org/repo1", 100);
    await recordRepoFailure(config, "org/repo1", 100); // duplicate
    await recordRepoFailure(config, "org/repo2", 100);
    await recordRepoFailure(config, "org/repo2", 200);
    assertEquals(await getRepoFailureCount(config, "org/repo1"), 1);
    assertEquals(await getRepoFailureCount(config, "org/repo2"), 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Escalating cooldown multiplier (Issue #1172)
// ============================================================================

Deno.test("repo failure tracker - cooldown multiplier is 1 below timeout threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoTimeout(config, "org/repo1");
    const multiplier = await getTimeoutCooldownMultiplier(config, "org/repo1");
    assertEquals(multiplier, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - cooldown multiplier is 2 at timeout threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    for (let i = 0; i < DEFAULT_REPO_TIMEOUT_THRESHOLD; i++) {
      await recordRepoTimeout(config, "org/repo1");
    }
    const multiplier = await getTimeoutCooldownMultiplier(config, "org/repo1");
    assertEquals(multiplier, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - cooldown multiplier escalates above threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    // 2x threshold = 2x multiplier for each threshold exceeded
    for (let i = 0; i < DEFAULT_REPO_TIMEOUT_THRESHOLD * 2; i++) {
      await recordRepoTimeout(config, "org/repo1");
    }
    const multiplier = await getTimeoutCooldownMultiplier(config, "org/repo1");
    assertEquals(multiplier, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - cooldown multiplier resets after success", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    for (let i = 0; i < DEFAULT_REPO_TIMEOUT_THRESHOLD; i++) {
      await recordRepoTimeout(config, "org/repo1");
    }
    assertEquals(await getTimeoutCooldownMultiplier(config, "org/repo1"), 2);
    await recordRepoSuccess(config, "org/repo1");
    assertEquals(await getTimeoutCooldownMultiplier(config, "org/repo1"), 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo failure tracker - cooldown multiplier is 1 for unknown repo", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const multiplier = await getTimeoutCooldownMultiplier(
      config,
      "org/unknown",
    );
    assertEquals(multiplier, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
