/**
 * Tests for repo_blocked_alert.ts — alerting when open PRs block
 * all issues in a repository (Issue #745, #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  checkRepoBlockedAlert,
  clearRepoBlocked,
  DEFAULT_REPO_BLOCKED_ALERT_HOURS,
  recordRepoBlocked,
  type RepoBlockedAlertConfig,
} from "../lib/repo_blocked_alert.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "rba-test-" });
}

function testConfig(workDir: string): RepoBlockedAlertConfig {
  return {
    workDir,
    alertHours: DEFAULT_REPO_BLOCKED_ALERT_HOURS,
  };
}

const testPrsJson = JSON.stringify([{ number: 1, title: "Test PR" }]);

// ============================================================================
// recordRepoBlocked
// ============================================================================

Deno.test("repo blocked alert - records blocked state for new repo", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const result = await recordRepoBlocked(
      config,
      "org/repo",
      3,
      testPrsJson,
      () => 1000000,
    );
    assertEquals(result.ok, true);

    // Verify state file was created
    const content = await Deno.readTextFile(`${dir}/.repo_blocked_state`);
    assertEquals(content.includes("org/repo"), true);
    assertEquals(content.includes("1000000"), true);
    assertEquals(content.includes("false"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo blocked alert - preserves existing entry when same PRs", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const prs = JSON.stringify([{ number: 5, title: "PR5" }]);
    await recordRepoBlocked(config, "org/repo", 3, prs, () => 1000000);
    await recordRepoBlocked(config, "org/repo", 3, prs, () => 2000000);

    // Timestamp should still be original
    const content = await Deno.readTextFile(`${dir}/.repo_blocked_state`);
    assertEquals(content.includes("1000000"), true);
    assertEquals(content.includes("2000000"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo blocked alert - resets timestamp when PRs change (Issue #936)", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const prs1 = JSON.stringify([{ number: 1, title: "PR1" }]);
    const prs2 = JSON.stringify([{ number: 2, title: "PR2" }]);
    await recordRepoBlocked(config, "org/repo", 3, prs1, () => 1000000);
    await recordRepoBlocked(config, "org/repo", 3, prs2, () => 2000000);

    // Timestamp should be updated
    const content = await Deno.readTextFile(`${dir}/.repo_blocked_state`);
    assertEquals(content.includes("2000000"), true);
    assertEquals(content.includes("1000000"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo blocked alert - tracks multiple repos independently", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoBlocked(config, "org/repo1", 2, testPrsJson, () => 1000);
    await recordRepoBlocked(config, "org/repo2", 5, testPrsJson, () => 2000);

    const content = await Deno.readTextFile(`${dir}/.repo_blocked_state`);
    assertEquals(content.includes("org/repo1"), true);
    assertEquals(content.includes("org/repo2"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// clearRepoBlocked
// ============================================================================

Deno.test("repo blocked alert - clear removes repo entry", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordRepoBlocked(config, "org/repo1", 2, testPrsJson);
    await recordRepoBlocked(config, "org/repo2", 3, testPrsJson);
    await clearRepoBlocked(config, "org/repo1");

    const content = await Deno.readTextFile(`${dir}/.repo_blocked_state`);
    assertEquals(content.includes("org/repo1"), false);
    assertEquals(content.includes("org/repo2"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo blocked alert - clear succeeds when repo not tracked", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const result = await clearRepoBlocked(config, "org/unknown");
    assertEquals(result.ok, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo blocked alert - clear succeeds when no state file", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const result = await clearRepoBlocked(config, "org/repo");
    assertEquals(result.ok, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// checkRepoBlockedAlert
// ============================================================================

Deno.test("repo blocked alert - no alert when repo not tracked", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const result = await checkRepoBlockedAlert(
      config,
      "org/repo",
      3,
      testPrsJson,
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo blocked alert - no alert when below threshold", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const startTime = 1000000;
    await recordRepoBlocked(
      config,
      "org/repo",
      3,
      testPrsJson,
      () => startTime,
    );

    // Check 1 hour later (below 24h threshold)
    const result = await checkRepoBlockedAlert(
      config,
      "org/repo",
      3,
      testPrsJson,
      () => startTime + 3600,
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo blocked alert - no alert when already alerted", async () => {
  const dir = await makeTempDir();
  try {
    const config: RepoBlockedAlertConfig = { workDir: dir, alertHours: 1 };
    const startTime = 1000000;
    await recordRepoBlocked(
      config,
      "org/repo",
      3,
      testPrsJson,
      () => startTime,
    );

    // First check after threshold — would trigger alert but gh not available in test
    // Instead, manually mark as alerted by writing state
    const stateContent = `org/repo|${startTime}|true|3|${testPrsJson}\n`;
    await Deno.writeTextFile(`${dir}/.repo_blocked_state`, stateContent);

    // Second check — already alerted
    const result = await checkRepoBlockedAlert(
      config,
      "org/repo",
      3,
      testPrsJson,
      () => startTime + 7200,
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Defaults
// ============================================================================

Deno.test("repo blocked alert - default alert hours is 24", () => {
  assertEquals(DEFAULT_REPO_BLOCKED_ALERT_HOURS, 24);
});
