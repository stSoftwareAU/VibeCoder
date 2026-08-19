/**
 * Tests for claude_auth command (Issue #913).
 *
 * CLI-specific tests only — unit tests for auth detection logic live in
 * claude_auth_test.ts. Deduplicated as part of Issue #1307.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { claudeAuthCommand } from "../commands/claude_auth.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

// ---------------------------------------------------------------------------
// CLI-specific: input validation
// ---------------------------------------------------------------------------

Deno.test("claude-auth command - is-auth-error-in-file requires file-path", async () => {
  const result = await claudeAuthCommand.execute(
    { operation: "is-auth-error-in-file" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
});

// ---------------------------------------------------------------------------
// CLI-specific: unknown operation error handling
// ---------------------------------------------------------------------------

Deno.test("claude-auth command - returns error for unknown operation", async () => {
  const result = await claudeAuthCommand.execute(
    { operation: "unknown" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
});
