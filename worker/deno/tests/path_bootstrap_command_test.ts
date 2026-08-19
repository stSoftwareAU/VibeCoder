/**
 * Tests for the path-bootstrap command.
 *
 * CLI-specific tests only — unit tests for path manipulation and command
 * lookup logic live in path_bootstrap_test.ts. Deduplicated as part of
 * Issue #1307.
 *
 * Issue #902: Migrate path_bootstrap.sh to Deno TypeScript.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { pathBootstrapCommand } from "../commands/path_bootstrap.ts";
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

Deno.test("path-bootstrap command - has correct name", () => {
  assertEquals(pathBootstrapCommand.name, "path-bootstrap");
});

Deno.test("path-bootstrap command - has description", () => {
  assertEquals(typeof pathBootstrapCommand.description, "string");
  assertEquals(pathBootstrapCommand.description.length > 0, true);
});

// ---------------------------------------------------------------------------
// CLI-specific: default action handling
// ---------------------------------------------------------------------------

Deno.test("path-bootstrap command - apply-defaults is the default action", async () => {
  const result = await pathBootstrapCommand.execute(
    { "current-path": "/usr/bin:/bin" },
    createMockConfig(),
  );
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "/usr/bin");
});

// ---------------------------------------------------------------------------
// CLI-specific: argument validation
// ---------------------------------------------------------------------------

Deno.test("path-bootstrap command - ensure-command fails without --command", async () => {
  const result = await pathBootstrapCommand.execute(
    { action: "ensure-command" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "ERROR");
});

// ---------------------------------------------------------------------------
// CLI-specific: command output structure
// ---------------------------------------------------------------------------

Deno.test("path-bootstrap command - returns data with correct structure", async () => {
  const result = await pathBootstrapCommand.execute(
    { "current-path": "/usr/bin" },
    createMockConfig(),
  );
  assertEquals(result.success, true);
  assertEquals(typeof result.data, "object");
  if (result.data) {
    const data = result.data as {
      path: string;
      added: string[];
      message: string;
    };
    assertEquals(typeof data.path, "string");
    assertEquals(Array.isArray(data.added), true);
    assertEquals(typeof data.message, "string");
  }
});
