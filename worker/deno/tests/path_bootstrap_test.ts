/**
 * Tests for path_bootstrap.ts — PATH bootstrap helpers.
 *
 * Issue #902: Migrate path_bootstrap.sh to Deno TypeScript.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  appendDirIfPresent,
  applyDefaults,
  ensureCommand,
  pathContainsDir,
  prependDirIfPresent,
  prependExecutableDir,
} from "../lib/path_bootstrap.ts";

// =============================================================================
// pathContainsDir tests
// =============================================================================

Deno.test("path_bootstrap - pathContainsDir returns true when dir is present", () => {
  assertEquals(pathContainsDir("/usr/bin:/bin:/usr/sbin", "/bin"), true);
});

Deno.test("path_bootstrap - pathContainsDir returns false when dir is absent", () => {
  assertEquals(pathContainsDir("/usr/bin:/bin", "/opt/homebrew/bin"), false);
});

Deno.test("path_bootstrap - pathContainsDir handles empty PATH", () => {
  assertEquals(pathContainsDir("", "/usr/bin"), false);
});

Deno.test("path_bootstrap - pathContainsDir does not partial-match", () => {
  // /usr/bin should not match /usr/bin/local
  assertEquals(pathContainsDir("/usr/bin", "/usr/bin/local"), false);
  // /usr/bin/local should not match /usr/bin
  assertEquals(pathContainsDir("/usr/bin/local", "/usr/bin"), false);
});

// =============================================================================
// prependDirIfPresent tests
// =============================================================================

Deno.test("path_bootstrap - prependDirIfPresent adds dir to front", () => {
  const result = prependDirIfPresent("/usr/bin:/bin", "/opt/new", true);
  assertEquals(result, "/opt/new:/usr/bin:/bin");
});

Deno.test("path_bootstrap - prependDirIfPresent skips if already present", () => {
  const result = prependDirIfPresent("/opt/new:/usr/bin", "/opt/new", true);
  assertEquals(result, "/opt/new:/usr/bin");
});

Deno.test("path_bootstrap - prependDirIfPresent skips if dir does not exist", () => {
  const result = prependDirIfPresent("/usr/bin", "/opt/new", false);
  assertEquals(result, "/usr/bin");
});

Deno.test("path_bootstrap - prependDirIfPresent handles empty PATH", () => {
  const result = prependDirIfPresent("", "/opt/new", true);
  assertEquals(result, "/opt/new");
});

Deno.test("path_bootstrap - prependDirIfPresent skips empty dir", () => {
  const result = prependDirIfPresent("/usr/bin", "", true);
  assertEquals(result, "/usr/bin");
});

// =============================================================================
// prependExecutableDir tests (Issue #3532)
// =============================================================================

Deno.test("path_bootstrap - prependExecutableDir adds the deno bin dir", () => {
  const result = prependExecutableDir(
    "/usr/bin:/bin",
    "/Users/worker/.deno/bin/deno",
  );
  assertEquals(result, "/Users/worker/.deno/bin:/usr/bin:/bin");
});

Deno.test("path_bootstrap - prependExecutableDir dedupes when already present", () => {
  const result = prependExecutableDir(
    "/Users/worker/.deno/bin:/usr/bin",
    "/Users/worker/.deno/bin/deno",
  );
  assertEquals(result, "/Users/worker/.deno/bin:/usr/bin");
});

Deno.test("path_bootstrap - prependExecutableDir handles empty PATH", () => {
  const result = prependExecutableDir("", "/opt/homebrew/bin/deno");
  assertEquals(result, "/opt/homebrew/bin");
});

Deno.test("path_bootstrap - prependExecutableDir leaves PATH unchanged for a bare name", () => {
  assertEquals(prependExecutableDir("/usr/bin", "deno"), "/usr/bin");
  // Leading-slash bare name has no meaningful directory component.
  assertEquals(prependExecutableDir("/usr/bin", "/deno"), "/usr/bin");
});

// =============================================================================
// USER_PATH_SUFFIXES coverage (Issue #3532)
// =============================================================================

Deno.test("path_bootstrap - applyDefaults adds ~/.deno/bin when it exists", async () => {
  const homeDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${homeDir}/.deno/bin`, { recursive: true });
    const result = await applyDefaults("/usr/bin", homeDir, undefined);
    assertEquals(result.path.includes(`${homeDir}/.deno/bin`), true);
    assertEquals(result.added.includes(`${homeDir}/.deno/bin`), true);
  } finally {
    await Deno.remove(homeDir, { recursive: true });
  }
});

// =============================================================================
// appendDirIfPresent tests
// =============================================================================

Deno.test("path_bootstrap - appendDirIfPresent adds dir to end", () => {
  const result = appendDirIfPresent("/usr/bin", "/opt/new", true);
  assertEquals(result, "/usr/bin:/opt/new");
});

Deno.test("path_bootstrap - appendDirIfPresent skips if already present", () => {
  const result = appendDirIfPresent("/opt/new:/usr/bin", "/opt/new", true);
  assertEquals(result, "/opt/new:/usr/bin");
});

Deno.test("path_bootstrap - appendDirIfPresent handles empty PATH", () => {
  const result = appendDirIfPresent("", "/opt/new", true);
  assertEquals(result, "/opt/new");
});

// =============================================================================
// applyDefaults tests
// =============================================================================

Deno.test("path_bootstrap - applyDefaults adds system paths that exist", async () => {
  const result = await applyDefaults("", "", undefined);
  // At minimum, /usr/bin and /bin should exist on any Unix system
  assertEquals(result.path.includes("/usr/bin"), true);
  assertEquals(result.path.includes("/bin"), true);
});

Deno.test("path_bootstrap - applyDefaults does not duplicate existing paths", async () => {
  const result = await applyDefaults("/usr/bin:/bin", "", undefined);
  // Count occurrences of /usr/bin — should be exactly 1
  const parts = result.path.split(":");
  const usrBinCount = parts.filter((p) => p === "/usr/bin").length;
  assertEquals(usrBinCount, 1);
});

Deno.test("path_bootstrap - applyDefaults handles fallback paths", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await applyDefaults("/usr/bin", "", tmpDir);
    assertEquals(result.path.includes(tmpDir), true);
    assertEquals(result.added.includes(tmpDir), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("path_bootstrap - applyDefaults returns result with correct structure", async () => {
  const result = await applyDefaults("/usr/bin", "", undefined);
  assertEquals(typeof result.path, "string");
  assertEquals(Array.isArray(result.added), true);
  assertEquals(typeof result.message, "string");
});

// =============================================================================
// ensureCommand tests
// =============================================================================

Deno.test("path_bootstrap - ensureCommand finds command already on PATH", async () => {
  // 'ls' should be in /bin or /usr/bin
  const result = await ensureCommand("ls", "/usr/bin:/bin", undefined);
  assertEquals(result.found, true);
  assertStringIncludes(result.message, "ls");
});

Deno.test("path_bootstrap - ensureCommand returns false for non-existent command", async () => {
  const result = await ensureCommand(
    "nonexistent_cmd_test_902",
    "/usr/bin:/bin",
    "/tmp",
  );
  assertEquals(result.found, false);
  assertStringIncludes(result.message, "not found");
});

Deno.test("path_bootstrap - ensureCommand finds command in fallback", async () => {
  const tmpDir = await Deno.makeTempDir();
  const cmdPath = `${tmpDir}/test_cmd_902`;
  await Deno.writeTextFile(cmdPath, "#!/bin/sh\necho ok");
  // Make it executable - need Deno.chmod
  await Deno.chmod(cmdPath, 0o755);

  try {
    const result = await ensureCommand("test_cmd_902", "/usr/bin", tmpDir);
    assertEquals(result.found, true);
    assertEquals(result.foundIn, tmpDir);
    // PATH should now include the fallback dir
    assertEquals(result.updatedPath.includes(tmpDir), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("path_bootstrap - ensureCommand does not modify PATH when found on existing PATH", async () => {
  const originalPath = "/usr/bin:/bin";
  const result = await ensureCommand("ls", originalPath, undefined);
  assertEquals(result.updatedPath, originalPath);
});
