/**
 * Tests for the log-rotation command.
 *
 * CLI-specific tests only — unit tests for rotation logic live in
 * log_rotation_test.ts. Deduplicated as part of Issue #1307.
 *
 * Issue #902: Migrate log_rotation.sh to Deno TypeScript.
 */

import { assertEquals } from "@std/assert";
import { logRotationCommand } from "../commands/log_rotation.ts";
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

Deno.test("log-rotation command - has correct name", () => {
  assertEquals(logRotationCommand.name, "log-rotation");
});

Deno.test("log-rotation command - has description", () => {
  assertEquals(typeof logRotationCommand.description, "string");
  assertEquals(logRotationCommand.description.length > 0, true);
});

// ---------------------------------------------------------------------------
// CLI-specific: command integration
// ---------------------------------------------------------------------------

Deno.test("log-rotation command - returns success with valid log dir", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logDir = `${tmpDir}/logs`;
  await Deno.mkdir(logDir, { recursive: true });

  try {
    const result = await logRotationCommand.execute(
      { "log-dir": logDir },
      createMockConfig(),
    );
    assertEquals(result.success, true);
    assertEquals(typeof result.message, "string");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log-rotation command - handles non-existent log dir", async () => {
  const result = await logRotationCommand.execute(
    { "log-dir": "/tmp/nonexistent_log_dir_test_902" },
    createMockConfig(),
  );
  assertEquals(result.success, true);
});

// ---------------------------------------------------------------------------
// CLI-specific: command output structure
// ---------------------------------------------------------------------------

Deno.test("log-rotation command - returns data with correct structure", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logDir = `${tmpDir}/logs`;
  await Deno.mkdir(logDir, { recursive: true });

  try {
    const result = await logRotationCommand.execute(
      { "log-dir": logDir },
      createMockConfig(),
    );
    assertEquals(result.success, true);
    assertEquals(typeof result.data, "object");
    if (result.data) {
      const data = result.data as {
        rotatedCount: number;
        skippedCount: number;
        message: string;
      };
      assertEquals(typeof data.rotatedCount, "number");
      assertEquals(typeof data.skippedCount, "number");
      assertEquals(typeof data.message, "string");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
