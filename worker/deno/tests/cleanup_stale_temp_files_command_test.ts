/**
 * Tests for the cleanup-stale-temp-files command (Issue #1309).
 *
 * Tests argument validation and cleanup behaviour.
 * The actual cleanup logic delegates to lib/temp_utils.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { cleanupStaleTempFilesCommand } from "../commands/cleanup_stale_temp_files.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("cleanupStaleTempFilesCommand - has correct name", () => {
  assertEquals(cleanupStaleTempFilesCommand.name, "cleanup-stale-temp-files");
});

Deno.test("cleanupStaleTempFilesCommand - has description", () => {
  assertEquals(typeof cleanupStaleTempFilesCommand.description, "string");
  assertEquals(cleanupStaleTempFilesCommand.description.length > 0, true);
});

// ============================================================================
// Argument validation
// ============================================================================

Deno.test("cleanupStaleTempFilesCommand - fails when directory is missing", async () => {
  const result = await cleanupStaleTempFilesCommand.execute({}, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--directory is required");
});

Deno.test("cleanupStaleTempFilesCommand - fails when directory is empty string", async () => {
  const result = await cleanupStaleTempFilesCommand.execute(
    { directory: "" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--directory is required");
});

Deno.test("cleanupStaleTempFilesCommand - fails with invalid max-age-minutes", async () => {
  const result = await cleanupStaleTempFilesCommand.execute(
    { directory: "/tmp/test", "max-age-minutes": "not-a-number" },
    config,
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "invalid --max-age-minutes");
});

// ============================================================================
// Successful cleanup with empty directory
// ============================================================================

Deno.test("cleanupStaleTempFilesCommand - reports no stale files in empty dir", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await cleanupStaleTempFilesCommand.execute(
      { directory: tmpDir },
      config,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "No stale temp files");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupStaleTempFilesCommand - accepts numeric max-age-minutes", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await cleanupStaleTempFilesCommand.execute(
      { directory: tmpDir, "max-age-minutes": 60 },
      config,
    );
    assertEquals(result.success, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupStaleTempFilesCommand - accepts string max-age-minutes", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await cleanupStaleTempFilesCommand.execute(
      { directory: tmpDir, "max-age-minutes": "120" },
      config,
    );
    assertEquals(result.success, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
