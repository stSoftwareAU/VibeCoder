/**
 * Tests for operational_defaults.ts — internal tuning parameters.
 *
 * Issue #907: Migrated from worker/shared/operational_defaults.sh to Deno.
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  getOperationalDefault,
  getOperationalDefaultKeys,
  SHELL_OPERATIONAL_DEFAULTS,
} from "../lib/operational_defaults.ts";

// =============================================================================
// Token Estimation
// =============================================================================

Deno.test("operational_defaults - CHARS_PER_TOKEN defaults to 4", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.CHARS_PER_TOKEN, "4");
});

// =============================================================================
// Evidence and Output Paths
// =============================================================================

Deno.test("operational_defaults - SCREENSHOT_EVIDENCE_DIR defaults to docs/evidence", () => {
  assertEquals(
    SHELL_OPERATIONAL_DEFAULTS.SCREENSHOT_EVIDENCE_DIR,
    "docs/evidence",
  );
});

// =============================================================================
// Git Operation Timeouts
// =============================================================================

Deno.test("operational_defaults - GIT_COMMAND_TIMEOUT defaults to 60", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.GIT_COMMAND_TIMEOUT, "60");
});

Deno.test("operational_defaults - GIT_MERGE_TIMEOUT defaults to 120", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.GIT_MERGE_TIMEOUT, "120");
});

// =============================================================================
// GitHub CLI Timeouts
// =============================================================================

Deno.test("operational_defaults - GH_COMMAND_TIMEOUT defaults to 60", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.GH_COMMAND_TIMEOUT, "60");
});

Deno.test("operational_defaults - GH_CLONE_TIMEOUT defaults to 600", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.GH_CLONE_TIMEOUT, "600");
});

Deno.test("operational_defaults - GH_PAGINATED_TIMEOUT defaults to 300", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.GH_PAGINATED_TIMEOUT, "300");
});

Deno.test("operational_defaults - GH_RATE_LIMIT_COOLDOWN defaults to 300", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.GH_RATE_LIMIT_COOLDOWN, "300");
});

// =============================================================================
// Stuck Issue Detection
// =============================================================================

Deno.test("operational_defaults - ASSIGNED_NO_HEARTBEAT_TIMEOUT defaults to 1800", () => {
  assertEquals(
    SHELL_OPERATIONAL_DEFAULTS.ASSIGNED_NO_HEARTBEAT_TIMEOUT,
    "1800",
  );
});

Deno.test("operational_defaults - STALE_ASSIGNMENT_TIMEOUT defaults to 14400", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.STALE_ASSIGNMENT_TIMEOUT, "14400");
});

// =============================================================================
// Cache TTLs
// =============================================================================

Deno.test("operational_defaults - HEALTH_CHECK_CACHE_TTL defaults to 300", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.HEALTH_CHECK_CACHE_TTL, "300");
});

Deno.test("operational_defaults - ISSUE_CACHE_TTL defaults to 600", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.ISSUE_CACHE_TTL, "600");
});

// =============================================================================
// Retry Configuration
// =============================================================================

Deno.test("operational_defaults - RETRY_MAX_ATTEMPTS defaults to 4", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.RETRY_MAX_ATTEMPTS, "4");
});

Deno.test("operational_defaults - RETRY_INITIAL_DELAY defaults to 2", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.RETRY_INITIAL_DELAY, "2");
});

Deno.test("operational_defaults - RATE_LIMIT_MAX_WAIT defaults to 3600", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.RATE_LIMIT_MAX_WAIT, "3600");
});

// =============================================================================
// Circuit Breaker and Failure Tracking
// =============================================================================

Deno.test("operational_defaults - CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS defaults to 3600", () => {
  assertEquals(
    SHELL_OPERATIONAL_DEFAULTS.CIRCUIT_BREAKER_STATE_EXPIRY_SECONDS,
    "3600",
  );
});

Deno.test("operational_defaults - OPERATION_BACKOFF_THRESHOLD defaults to 2", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.OPERATION_BACKOFF_THRESHOLD, "2");
});

Deno.test("operational_defaults - FAILURE_STATE_EXPIRY_SECONDS defaults to 3600", () => {
  assertEquals(
    SHELL_OPERATIONAL_DEFAULTS.FAILURE_STATE_EXPIRY_SECONDS,
    "3600",
  );
});

// =============================================================================
// Software Update Checks
// =============================================================================

Deno.test("operational_defaults - SOFTWARE_UPDATE_CHECK_INTERVAL_SECONDS defaults to 604800", () => {
  assertEquals(
    SHELL_OPERATIONAL_DEFAULTS.SOFTWARE_UPDATE_CHECK_INTERVAL_SECONDS,
    "604800",
  );
});

Deno.test("operational_defaults - CLAUDE_UPDATE_TIMEOUT defaults to 120", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.CLAUDE_UPDATE_TIMEOUT, "120");
});

Deno.test("operational_defaults - GH_UPDATE_TIMEOUT defaults to 120", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.GH_UPDATE_TIMEOUT, "120");
});

Deno.test("operational_defaults - DENO_UPDATE_TIMEOUT defaults to 120", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.DENO_UPDATE_TIMEOUT, "120");
});

// =============================================================================
// Crash Notification
// =============================================================================

Deno.test("operational_defaults - CRASH_NOTIFICATION_COOLDOWN_SECONDS defaults to 600", () => {
  assertEquals(
    SHELL_OPERATIONAL_DEFAULTS.CRASH_NOTIFICATION_COOLDOWN_SECONDS,
    "600",
  );
});

// =============================================================================
// Claude Runner Operational Constants
// =============================================================================

Deno.test("operational_defaults - PROGRESS_MONITOR_MIN_TIMEOUT defaults to 60", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.PROGRESS_MONITOR_MIN_TIMEOUT, "60");
});

Deno.test("operational_defaults - ERROR_SCAN_TAIL_LINES defaults to 30", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.ERROR_SCAN_TAIL_LINES, "30");
});

Deno.test("operational_defaults - HEARTBEAT_UPDATE_INTERVAL defaults to 120", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.HEARTBEAT_UPDATE_INTERVAL, "120");
});

// =============================================================================
// Comment Filtering
// =============================================================================

Deno.test("operational_defaults - ANSWER_TRUNCATE_LENGTH defaults to 500", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.ANSWER_TRUNCATE_LENGTH, "500");
});

// =============================================================================
// Pre-Setup Command
// =============================================================================

Deno.test("operational_defaults - PRE_SETUP_TIMEOUT defaults to 300", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.PRE_SETUP_TIMEOUT, "300");
});

// =============================================================================
// Issue Query Limits
// =============================================================================

Deno.test("operational_defaults - GH_ISSUE_LIST_LIMIT defaults to 50", () => {
  assertEquals(SHELL_OPERATIONAL_DEFAULTS.GH_ISSUE_LIST_LIMIT, "50");
});

// =============================================================================
// Helper functions
// =============================================================================

Deno.test("getOperationalDefault - returns correct value for known key", () => {
  assertEquals(getOperationalDefault("CHARS_PER_TOKEN"), "4");
  assertEquals(getOperationalDefault("GIT_COMMAND_TIMEOUT"), "60");
});

Deno.test("getOperationalDefaultKeys - returns all keys", () => {
  const keys = getOperationalDefaultKeys();
  assertNotEquals(keys.length, 0);
  assertEquals(keys.includes("CHARS_PER_TOKEN"), true);
  assertEquals(keys.includes("GH_ISSUE_LIST_LIMIT"), true);
});

Deno.test("operational_defaults - all values are non-empty strings", () => {
  for (const [key, value] of Object.entries(SHELL_OPERATIONAL_DEFAULTS)) {
    assertEquals(typeof value, "string", `${key} should be a string`);
    assertNotEquals(value, "", `${key} should not be empty`);
  }
});
