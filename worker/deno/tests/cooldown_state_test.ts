/**
 * Tests for cooldown_state.ts — persistent issue retry cooldown
 * tracking (Issue #633, #908).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  cleanExpiredCooldowns,
  COOLDOWN_DEFAULTS,
  type CooldownConfig,
  isIssueInCooldown,
  loadState,
  recordIssueCooldown,
  timeoutCooldownSeconds,
} from "../lib/cooldown_state.ts";

/** Create a temp directory for test state files. */
async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "cd-test-" });
}

/** Build a test config with the given workDir. */
function testConfig(workDir: string): CooldownConfig {
  return {
    workDir,
    issueRetryCooldown: COOLDOWN_DEFAULTS.issueRetryCooldown,
  };
}

// ============================================================================
// loadState
// ============================================================================

Deno.test("cooldown - loadState returns empty state when no file exists", async () => {
  const dir = await makeTempDir();
  try {
    const state = await loadState(dir);
    assertEquals(state.entries.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown - loadState returns empty state when workDir is empty", async () => {
  const state = await loadState("");
  assertEquals(state.entries.length, 0);
});

// ============================================================================
// recordIssueCooldown
// ============================================================================

Deno.test("cooldown - recordIssueCooldown adds an entry", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const result = await recordIssueCooldown(
      config,
      "example-org/private-repo-13",
      42,
    );
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.state.entries.length, 1);
      assertEquals(
        result.value.state.entries[0]!.repo,
        "example-org/private-repo-13",
      );
      assertEquals(result.value.state.entries[0]!.issueNumber, 42);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown - multiple cooldowns are tracked", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordIssueCooldown(config, "example-org/private-repo-13", 42);
    await recordIssueCooldown(config, "example-org/private-repo-13", 100);
    await recordIssueCooldown(config, "other/repo", 5);

    const state = await loadState(dir);
    assertEquals(state.entries.length, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// isIssueInCooldown
// ============================================================================

Deno.test("cooldown - isIssueInCooldown returns true for recently recorded issue", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordIssueCooldown(config, "example-org/private-repo-13", 42);
    const inCooldown = await isIssueInCooldown(
      config,
      "example-org/private-repo-13",
      42,
    );
    assertEquals(inCooldown, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown - isIssueInCooldown returns false for unrecorded issue", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordIssueCooldown(config, "example-org/private-repo-13", 42);
    const inCooldown = await isIssueInCooldown(
      config,
      "example-org/private-repo-13",
      100,
    );
    assertEquals(inCooldown, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown - isIssueInCooldown returns false for empty state", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    const inCooldown = await isIssueInCooldown(
      config,
      "example-org/private-repo-13",
      42,
    );
    assertEquals(inCooldown, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Expiry
// ============================================================================

Deno.test("cooldown - expired entries are cleaned up on load", async () => {
  const dir = await makeTempDir();
  try {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    const state = {
      entries: [
        {
          repo: "example-org/private-repo-13",
          issueNumber: 42,
          timestamp: oldTimestamp,
        },
      ],
    };
    await Deno.writeTextFile(
      `${dir}/.cooldown_state.json`,
      JSON.stringify(state),
    );

    const config = testConfig(dir);
    const inCooldown = await isIssueInCooldown(
      config,
      "example-org/private-repo-13",
      42,
    );
    assertEquals(inCooldown, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown - non-expired entries are preserved on load", async () => {
  const dir = await makeTempDir();
  try {
    const recentTimestamp = Math.floor(Date.now() / 1000);
    const state = {
      entries: [
        {
          repo: "example-org/private-repo-13",
          issueNumber: 42,
          timestamp: recentTimestamp,
        },
      ],
    };
    await Deno.writeTextFile(
      `${dir}/.cooldown_state.json`,
      JSON.stringify(state),
    );

    const config = testConfig(dir);
    const inCooldown = await isIssueInCooldown(
      config,
      "example-org/private-repo-13",
      42,
    );
    assertEquals(inCooldown, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown - cleanExpiredCooldowns removes only old entries", async () => {
  const dir = await makeTempDir();
  try {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 7200;
    const recentTimestamp = Math.floor(Date.now() / 1000);
    const state = {
      entries: [
        {
          repo: "example-org/private-repo-13",
          issueNumber: 10,
          timestamp: oldTimestamp,
        },
        {
          repo: "example-org/private-repo-13",
          issueNumber: 42,
          timestamp: recentTimestamp,
        },
      ],
    };
    await Deno.writeTextFile(
      `${dir}/.cooldown_state.json`,
      JSON.stringify(state),
    );

    const config = testConfig(dir);
    const result = await cleanExpiredCooldowns(config);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.entries.length, 1);
      assertEquals(result.value.entries[0]!.issueNumber, 42);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Persistence (survives simulated restart)
// ============================================================================

Deno.test("cooldown - state persists and reloads correctly", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordIssueCooldown(config, "example-org/private-repo-13", 42);

    // Simulate restart: reload from disk
    const inCooldown = await isIssueInCooldown(
      config,
      "example-org/private-repo-13",
      42,
    );
    assertEquals(inCooldown, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown - different repos are tracked independently", async () => {
  const dir = await makeTempDir();
  try {
    const config = testConfig(dir);
    await recordIssueCooldown(config, "example-org/private-repo-13", 42);

    const inCooldown1 = await isIssueInCooldown(
      config,
      "example-org/private-repo-13",
      42,
    );
    assertEquals(inCooldown1, true);

    const inCooldown2 = await isIssueInCooldown(config, "other/repo", 42);
    assertEquals(inCooldown2, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Defaults
// ============================================================================

Deno.test("cooldown - defaults have expected values", () => {
  assertEquals(COOLDOWN_DEFAULTS.issueRetryCooldown, 600);
});

// ---------------------------------------------------------------------------
// Escalating timeout-class cooldown (Issue #4304)
// ---------------------------------------------------------------------------

Deno.test("cooldown - a timeout failure escalates the ladder and persists across loads (Issue #4304)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "cooldown_4304_" });
  const config = { workDir, issueRetryCooldown: 600 };
  try {
    const first = await recordIssueCooldown(config, "o/r", 4281, "timeout");
    assert(first.ok);
    assertEquals(first.value.consecutiveTimeouts, 1);

    // Still in cooldown well after the 600s base — the first rung is 2h.
    assertEquals(await isIssueInCooldown(config, "o/r", 4281), true);

    const second = await recordIssueCooldown(config, "o/r", 4281, "timeout");
    assert(second.ok);
    assertEquals(second.value.consecutiveTimeouts, 2);
    const third = await recordIssueCooldown(config, "o/r", 4281, "timeout");
    assert(third.ok);
    assertEquals(third.value.consecutiveTimeouts, 3);

    assertEquals(timeoutCooldownSeconds(1), 2 * 60 * 60);
    assertEquals(timeoutCooldownSeconds(2), 6 * 60 * 60);
    assertEquals(timeoutCooldownSeconds(3), 24 * 60 * 60);
    assertEquals(timeoutCooldownSeconds(7), 24 * 60 * 60);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("cooldown - timeout entries survive the base-cooldown expiry that clears ordinary failures (Issue #4304)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "cooldown_4304_" });
  const config = { workDir, issueRetryCooldown: 600 };
  try {
    // Write a state file directly: one plain failure and one timeout,
    // both 2 hours old.
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60 - 5;
    await Deno.writeTextFile(
      `${workDir}/.cooldown_state.json`,
      JSON.stringify({
        entries: [
          { repo: "o/r", issueNumber: 1, timestamp: twoHoursAgo },
          {
            repo: "o/r",
            issueNumber: 2,
            timestamp: twoHoursAgo,
            kind: "timeout",
          },
        ],
      }),
    );
    const state = await loadState(workDir, 600);
    // The plain failure expired at 600s; the timeout entry is retained
    // for the 48h escalation history.
    assertEquals(state.entries.length, 1);
    assertEquals(state.entries[0]!.issueNumber, 2);

    // 2h+ old first-rung timeout: the 2h rung has just expired.
    assertEquals(await isIssueInCooldown(config, "o/r", 2), false);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("cooldown - non-timeout failures keep the flat base cooldown (Issue #4304)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "cooldown_4304_" });
  const config = { workDir, issueRetryCooldown: 600 };
  try {
    const rec = await recordIssueCooldown(config, "o/r", 7);
    assert(rec.ok);
    assertEquals(rec.value.consecutiveTimeouts, 0);
    assertEquals(await isIssueInCooldown(config, "o/r", 7), true);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

// ============================================================================
// Concurrent slots (Issue #4180)
// ============================================================================

Deno.test("cooldown - concurrent recordIssueCooldown from two slots both persist (Issue #4180)", async () => {
  const workDir = await makeTempDir();
  try {
    const config = testConfig(workDir);
    // Two slots finishing at once each did load → add → write; without the
    // mutex the second write dropped the first entry.
    await Promise.all([
      recordIssueCooldown(config, "o/a", 1),
      recordIssueCooldown(config, "o/b", 2),
      recordIssueCooldown(config, "o/c", 3),
    ]);
    assert(await isIssueInCooldown(config, "o/a", 1));
    assert(await isIssueInCooldown(config, "o/b", 2));
    assert(await isIssueInCooldown(config, "o/c", 3));
    const state = await loadState(workDir);
    assertEquals(state.entries.length, 3);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
