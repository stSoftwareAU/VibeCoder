/**
 * Tests for the temporary file utilities module.
 *
 * Migrated from tests/safe-mktemp.bats and tests/temp-cleanup.bats (Issue #901).
 * Issue #215: Safe mktemp with error checking.
 * Issue #337: Stale temp file cleanup.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  cleanupStaleTempFiles,
  createTempCleanupRegistry,
  safeMktemp,
} from "../lib/temp_utils.ts";

// =============================================================================
// safeMktemp
// =============================================================================

Deno.test("temp_utils - safeMktemp creates a temp file", async () => {
  const result = await safeMktemp();
  assertEquals(result.ok, true);
  if (result.ok) {
    const stat = await Deno.stat(result.value);
    assertEquals(stat.isFile, true);
    await Deno.remove(result.value);
  }
});

Deno.test("temp_utils - safeMktemp creates a temp directory", async () => {
  const result = await safeMktemp({ directory: true });
  assertEquals(result.ok, true);
  if (result.ok) {
    const stat = await Deno.stat(result.value);
    assertEquals(stat.isDirectory, true);
    await Deno.remove(result.value, { recursive: true });
  }
});

Deno.test("temp_utils - safeMktemp with custom prefix", async () => {
  const result = await safeMktemp({ prefix: "vibe_test_" });
  assertEquals(result.ok, true);
  if (result.ok) {
    const basename = result.value.split("/").pop() ?? "";
    assertEquals(basename.startsWith("vibe_test_"), true);
    await Deno.remove(result.value);
  }
});

Deno.test("temp_utils - safeMktemp with custom suffix", async () => {
  const result = await safeMktemp({ suffix: ".json" });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.endsWith(".json"), true);
    await Deno.remove(result.value);
  }
});

Deno.test("temp_utils - safeMktemp with custom directory", async () => {
  const parentDir = await Deno.makeTempDir({ prefix: "parent_" });
  try {
    const result = await safeMktemp({ dir: parentDir });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.startsWith(parentDir), true);
      await Deno.remove(result.value);
    }
  } finally {
    await Deno.remove(parentDir, { recursive: true });
  }
});

Deno.test("temp_utils - safeMktemp fails for invalid directory", async () => {
  const result = await safeMktemp({ dir: "/nonexistent/path" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "safeMktemp");
  }
});

Deno.test("temp_utils - safeMktemp creates unique paths", async () => {
  const paths: string[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      const result = await safeMktemp();
      assertEquals(result.ok, true);
      if (result.ok) {
        paths.push(result.value);
      }
    }
    // All paths should be unique
    const uniquePaths = new Set(paths);
    assertEquals(uniquePaths.size, paths.length);
  } finally {
    for (const p of paths) {
      await Deno.remove(p).catch(() => {});
    }
  }
});

// =============================================================================
// TempCleanupRegistry
// =============================================================================

Deno.test("temp_utils - TempCleanupRegistry starts empty", () => {
  const registry = createTempCleanupRegistry();
  assertEquals(registry.count, 0);
});

Deno.test("temp_utils - TempCleanupRegistry tracks registered paths", () => {
  const registry = createTempCleanupRegistry();
  registry.register("/tmp/a");
  registry.register("/tmp/b");
  assertEquals(registry.count, 2);
});

Deno.test("temp_utils - TempCleanupRegistry cleanup removes files", async () => {
  const registry = createTempCleanupRegistry();

  const file1 = await Deno.makeTempFile({ prefix: "cleanup_test_" });
  const file2 = await Deno.makeTempFile({ prefix: "cleanup_test_" });

  registry.register(file1);
  registry.register(file2);
  assertEquals(registry.count, 2);

  await registry.cleanup();
  assertEquals(registry.count, 0);

  // Files should be removed
  let file1Exists = true;
  try {
    await Deno.stat(file1);
  } catch {
    file1Exists = false;
  }
  assertEquals(file1Exists, false);

  let file2Exists = true;
  try {
    await Deno.stat(file2);
  } catch {
    file2Exists = false;
  }
  assertEquals(file2Exists, false);
});

Deno.test("temp_utils - TempCleanupRegistry cleanup removes directories", async () => {
  const registry = createTempCleanupRegistry();

  const dir = await Deno.makeTempDir({ prefix: "cleanup_dir_test_" });
  // Create a file inside the directory
  await Deno.writeTextFile(`${dir}/inner.txt`, "test");

  registry.register(dir);
  await registry.cleanup();

  let dirExists = true;
  try {
    await Deno.stat(dir);
  } catch {
    dirExists = false;
  }
  assertEquals(dirExists, false);
});

Deno.test("temp_utils - TempCleanupRegistry cleanup is safe for already-removed paths", async () => {
  const registry = createTempCleanupRegistry();

  const file = await Deno.makeTempFile({ prefix: "already_gone_" });
  registry.register(file);

  // Remove before cleanup
  await Deno.remove(file);

  // Should not throw
  await registry.cleanup();
  assertEquals(registry.count, 0);
});

Deno.test("temp_utils - TempCleanupRegistry cleanup can be called multiple times", async () => {
  const registry = createTempCleanupRegistry();

  const file = await Deno.makeTempFile({ prefix: "multi_cleanup_" });
  registry.register(file);

  await registry.cleanup();
  assertEquals(registry.count, 0);

  // Second cleanup should be safe
  await registry.cleanup();
  assertEquals(registry.count, 0);
});

// =============================================================================
// cleanupStaleTempFiles
// =============================================================================

Deno.test("temp_utils - cleanupStaleTempFiles returns zero for nonexistent directory", async () => {
  const result = await cleanupStaleTempFiles({
    directory: "/nonexistent/dir",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.removedCount, 0);
  }
});

Deno.test("temp_utils - cleanupStaleTempFiles returns zero for empty directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "stale_empty_" });
  try {
    const result = await cleanupStaleTempFiles({ directory: dir });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.removedCount, 0);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("temp_utils - cleanupStaleTempFiles removes stale files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "stale_test_" });
  try {
    // Create a file and backdate its mtime
    const staleFile = `${dir}/stale.txt`;
    await Deno.writeTextFile(staleFile, "old");

    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await Deno.utime(staleFile, twoHoursAgo, twoHoursAgo);

    const result = await cleanupStaleTempFiles({
      directory: dir,
      maxAgeMinutes: 60, // 1 hour threshold
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.removedCount, 1);
    }

    // File should be gone
    let exists = true;
    try {
      await Deno.stat(staleFile);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("temp_utils - cleanupStaleTempFiles preserves fresh files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "stale_fresh_" });
  try {
    // Create a fresh file (just created = current mtime)
    const freshFile = `${dir}/fresh.txt`;
    await Deno.writeTextFile(freshFile, "new");

    const result = await cleanupStaleTempFiles({
      directory: dir,
      maxAgeMinutes: 60,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.removedCount, 0);
    }

    // File should still exist
    const stat = await Deno.stat(freshFile);
    assertEquals(stat.isFile, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("temp_utils - cleanupStaleTempFiles removes stale directories", async () => {
  const dir = await Deno.makeTempDir({ prefix: "stale_dir_" });
  try {
    const staleDir = `${dir}/old_dir`;
    await Deno.mkdir(staleDir);
    await Deno.writeTextFile(`${staleDir}/inner.txt`, "data");

    // Backdate mtime
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await Deno.utime(staleDir, threeHoursAgo, threeHoursAgo);

    const result = await cleanupStaleTempFiles({
      directory: dir,
      maxAgeMinutes: 60,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.removedCount, 1);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("temp_utils - cleanupStaleTempFiles reports correct statistics", async () => {
  const dir = await Deno.makeTempDir({ prefix: "stale_stats_" });
  try {
    const result = await cleanupStaleTempFiles({
      directory: dir,
      maxAgeMinutes: 120,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.directory, dir);
      assertEquals(result.value.maxAgeMinutes, 120);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
