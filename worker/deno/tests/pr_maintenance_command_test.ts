/**
 * Tests for the pr-maintenance command operations (Issue #1119).
 *
 * CLI-specific tests only — unit tests for extractIssueFromBranch and other
 * PR maintenance logic live in pr_maintenance_test.ts. Deduplicated as part
 * of Issue #1307.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { prMaintenanceCommand } from "../commands/pr_maintenance.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

// ============================================================================
// find-pr-comments-to-fix argument validation
// ============================================================================

Deno.test("pr-maintenance command - find-pr-comments-to-fix rejects missing github-user", async () => {
  const config = makeConfig({ repos: ["org/repo"] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "find-pr-comments-to-fix",
    },
    config,
    emptyEnv,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

Deno.test("pr-maintenance command - find-pr-comments-to-fix rejects empty repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "find-pr-comments-to-fix",
      "github-user": "testbot",
      repos: [],
    },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("No repositories"), true);
});

Deno.test("pr-maintenance command - find-pr-comments-to-fix parses comma-separated repos", async () => {
  // This test verifies the argument parsing; the actual API call will fail
  // gracefully since we're not in a real GitHub environment
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "find-pr-comments-to-fix",
      "github-user": "testbot",
      repos: "org/repo1,org/repo2",
    },
    config,
  );
  // It should attempt to process (not reject with validation error)
  // The actual gh command will fail, which is expected in test environment
  assertEquals(
    !result.message.includes("Missing required") &&
      !result.message.includes("No repositories"),
    true,
  );
});

// ============================================================================
// find-failed-pr-checks argument validation (Issue #1120)
// ============================================================================

Deno.test("pr-maintenance command - find-failed-pr-checks rejects missing github-user", async () => {
  const config = makeConfig({ repos: ["org/repo"] });
  const result = await prMaintenanceCommand.execute(
    { operation: "find-failed-pr-checks" },
    config,
    emptyEnv,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

Deno.test("pr-maintenance command - find-failed-pr-checks rejects empty repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "find-failed-pr-checks",
      "github-user": "testbot",
      repos: [],
    },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("No repositories"), true);
});

// ============================================================================
// find-failed-ci-checks argument validation (Issue #1120)
// ============================================================================

Deno.test("pr-maintenance command - find-failed-ci-checks rejects missing github-user", async () => {
  const config = makeConfig({ repos: ["org/repo"] });
  const result = await prMaintenanceCommand.execute(
    { operation: "find-failed-ci-checks" },
    config,
    emptyEnv,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

Deno.test("pr-maintenance command - find-failed-ci-checks rejects empty repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "find-failed-ci-checks",
      "github-user": "testbot",
      repos: [],
    },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("No repositories"), true);
});

Deno.test("pr-maintenance command - find-failed-ci-checks parses comma-separated repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "find-failed-ci-checks",
      "github-user": "testbot",
      repos: "org/repo1,org/repo2",
    },
    config,
  );
  // Should attempt to process (not reject with validation error)
  assertEquals(
    !result.message.includes("Missing required") &&
      !result.message.includes("No repositories"),
    true,
  );
});

// ============================================================================
// ensure-auto-merge-on-open-prs argument validation (Issue #1234)
// ============================================================================

Deno.test("pr-maintenance command - ensure-auto-merge-on-open-prs rejects missing github-user", async () => {
  const config = makeConfig({ repos: ["org/repo"] });
  const result = await prMaintenanceCommand.execute(
    { operation: "ensure-auto-merge-on-open-prs" },
    config,
    emptyEnv,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

Deno.test("pr-maintenance command - ensure-auto-merge-on-open-prs rejects empty repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "ensure-auto-merge-on-open-prs",
      "github-user": "testbot",
      repos: [],
    },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("No repositories"), true);
});

Deno.test("pr-maintenance command - ensure-auto-merge-on-open-prs returns scan result message", async () => {
  // With no real GH API, the scan will find no PRs and return success with counts
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "ensure-auto-merge-on-open-prs",
      "github-user": "testbot",
      repos: "org/repo1",
    },
    config,
  );
  // Should succeed with zero counts (gh calls will fail gracefully — no PRs found)
  assertEquals(result.success, true);
  assertEquals(result.message.includes("enabled="), true);
  assertEquals(result.message.includes("skipped="), true);
  assertEquals(result.message.includes("failed="), true);
});

Deno.test("pr-maintenance command - ensure-auto-merge-on-open-prs parses comma-separated repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "ensure-auto-merge-on-open-prs",
      "github-user": "testbot",
      repos: "org/repo1,org/repo2",
    },
    config,
  );
  // Should attempt to process (not reject with validation error)
  assertEquals(
    !result.message.includes("Missing required") &&
      !result.message.includes("No repositories"),
    true,
  );
});

// ============================================================================
// update-open-pr-branches argument validation (Issue #1233)
// ============================================================================

Deno.test("pr-maintenance command - update-open-pr-branches rejects missing github-user", async () => {
  const config = makeConfig({ repos: ["org/repo"] });
  const result = await prMaintenanceCommand.execute(
    { operation: "update-open-pr-branches" },
    config,
    emptyEnv,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Missing required"), true);
});

Deno.test("pr-maintenance command - update-open-pr-branches rejects empty repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "update-open-pr-branches",
      "github-user": "testbot",
      repos: [],
    },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("No repositories"), true);
});

Deno.test("pr-maintenance command - update-open-pr-branches returns structured summary", async () => {
  // With no real GH API, scan will find no PRs and return success with counts
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "update-open-pr-branches",
      "github-user": "testbot",
      repos: "org/repo1",
      "work-dir": "/tmp/test-work",
    },
    config,
  );
  // Should succeed — scan finds no PRs, so 0 updated / 0 failed
  assertEquals(result.success, true);
  // Message should be human-readable summary (not pipe-delimited)
  assertEquals(result.message.includes("PR branch update complete"), true);
  assertEquals(result.message.includes("updated"), true);
  assertEquals(result.message.includes("failed"), true);
  // Should NOT contain pipe-delimited data
  assertEquals(result.message.includes("|"), false);
});

Deno.test("pr-maintenance command - update-open-pr-branches parses comma-separated repos", async () => {
  const config = makeConfig({ repos: [] });
  const result = await prMaintenanceCommand.execute(
    {
      operation: "update-open-pr-branches",
      "github-user": "testbot",
      repos: "org/repo1,org/repo2",
      "work-dir": "/tmp/test-work",
    },
    config,
  );
  // Should attempt to process (not reject with validation error)
  assertEquals(
    !result.message.includes("Missing required") &&
      !result.message.includes("No repositories"),
    true,
  );
});

// ============================================================================
// Unknown operation
// ============================================================================

Deno.test("pr-maintenance command - unknown operation returns error", async () => {
  const config = makeConfig();
  const result = await prMaintenanceCommand.execute(
    { operation: "nonexistent" },
    config,
  );
  assertEquals(result.success, false);
  assertEquals(result.message.includes("Unknown operation"), true);
  assertEquals(result.message.includes("find-pr-comments-to-fix"), true);
  assertEquals(result.message.includes("find-failed-pr-checks"), true);
  assertEquals(result.message.includes("find-failed-ci-checks"), true);
  assertEquals(result.message.includes("ensure-auto-merge-on-open-prs"), true);
});

Deno.test("pr-maintenance command - has correct name", () => {
  assertEquals(prMaintenanceCommand.name, "pr-maintenance");
});

// ============================================================================
// The GITHUB_USER seam (Issue #965)
//
// The acting login reaches the command as its third parameter, so the tests
// above state an empty environment instead of deleting `GITHUB_USER` from
// the process — a write that races every other test sharing the process.
//
// This test asserts the other direction with a login that exists in no real
// environment. Together the two directions pin the seam whichever way the
// host's own `GITHUB_USER` happens to be set: ignore the injected lookup and
// either the rejection above or the acceptance below goes red.
// ============================================================================

const USER_CHECKING_OPERATIONS = [
  "find-pr-comments-to-fix",
  "find-failed-pr-checks",
  "find-failed-ci-checks",
  "update-open-pr-branches",
  "ensure-auto-merge-on-open-prs",
] as const;

for (const operation of USER_CHECKING_OPERATIONS) {
  Deno.test(`pr-maintenance command - ${operation} accepts the injected GITHUB_USER`, async () => {
    const config = makeConfig({ repos: [] });
    const result = await prMaintenanceCommand.execute(
      { operation },
      config,
      envFrom({ GITHUB_USER: "seam-only-bot" }),
    );
    // Past the identity check on the injected login, and stopped by the next
    // guard instead — no repositories to scan.
    assertEquals(result.success, false);
    assertEquals(result.message, "No repositories configured");
  });
}
