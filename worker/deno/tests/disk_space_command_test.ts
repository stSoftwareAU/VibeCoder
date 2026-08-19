/**
 * Tests for the disk-space command.
 *
 * CLI-specific tests only — unit tests for disk space checking and cleanup
 * logic live in disk_space_test.ts. Deduplicated as part of Issue #1307.
 *
 * Issue #902: Migrate disk_space.sh to Deno TypeScript.
 */

import { assertEquals } from "@std/assert";
import { diskSpaceCommand } from "../commands/disk_space.ts";
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

Deno.test("disk-space command - has correct name", () => {
  assertEquals(diskSpaceCommand.name, "disk-space");
});

Deno.test("disk-space command - has description", () => {
  assertEquals(typeof diskSpaceCommand.description, "string");
  assertEquals(diskSpaceCommand.description.length > 0, true);
});

// ---------------------------------------------------------------------------
// CLI-specific: command output structure
// ---------------------------------------------------------------------------

Deno.test("disk-space command - returns data with correct structure", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await diskSpaceCommand.execute(
      { "work-dir": tmpDir, threshold: 100 },
      createMockConfig(),
    );
    assertEquals(result.success, true);
    assertEquals(typeof result.data, "object");
    if (result.data) {
      const data = result.data as {
        usagePercent: number;
        threshold: number;
        cleanedUp: boolean;
        message: string;
      };
      assertEquals(typeof data.usagePercent, "number");
      assertEquals(typeof data.threshold, "number");
      assertEquals(typeof data.cleanedUp, "boolean");
      assertEquals(typeof data.message, "string");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
