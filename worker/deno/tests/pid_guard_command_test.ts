/**
 * Tests for the pid-guard command.
 *
 * CLI-specific tests only — unit tests for PID checking, file parsing,
 * and process management logic live in pid_guard_test.ts. Deduplicated
 * as part of Issue #1307.
 *
 * Issue #903: Migrate pid_guard.sh to Deno TypeScript.
 */

import { assertEquals } from "@std/assert";
import { pidGuardCommand } from "../commands/pid_guard.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(
  overrides: Record<string, unknown> = {},
): WorkerConfig {
  return buildDefaultWorkerConfig(overrides);
}

// ---------------------------------------------------------------------------
// CLI-specific: command metadata
// ---------------------------------------------------------------------------

Deno.test("pid-guard command - has correct name", () => {
  assertEquals(pidGuardCommand.name, "pid-guard");
});

Deno.test("pid-guard command - has description", () => {
  assertEquals(typeof pidGuardCommand.description, "string");
  assertEquals(pidGuardCommand.description.length > 0, true);
});

// ---------------------------------------------------------------------------
// CLI-specific: input validation and edge cases
// ---------------------------------------------------------------------------

Deno.test("pid-guard command - check-pid with invalid PID", async () => {
  const result = await pidGuardCommand.execute(
    { operation: "check-pid", pid: -1 },
    createMockConfig(),
  );
  assertEquals(result.success, false);
});

Deno.test("pid-guard command - check-pid-file with no path", async () => {
  const result = await pidGuardCommand.execute(
    { operation: "check-pid-file" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
});

// ---------------------------------------------------------------------------
// CLI-specific: operations not covered by unit tests
// ---------------------------------------------------------------------------

Deno.test("pid-guard command - terminate-descendants for non-existent PID", async () => {
  const result = await pidGuardCommand.execute(
    { operation: "terminate-descendants", pid: 999999999 },
    createMockConfig(),
  );
  assertEquals(result.success, true);
});

// ---------------------------------------------------------------------------
// CLI-specific: unknown operation error handling
// ---------------------------------------------------------------------------

Deno.test("pid-guard command - unknown operation", async () => {
  const result = await pidGuardCommand.execute(
    { operation: "unknown" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
});
