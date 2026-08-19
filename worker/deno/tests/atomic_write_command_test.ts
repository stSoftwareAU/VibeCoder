/**
 * Tests for the atomic-write command (Issue #1309).
 *
 * Tests argument validation and successful write operations.
 * The actual atomic write delegates to lib/file_utils.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { atomicWriteCommand } from "../commands/atomic_write.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const config = buildDefaultWorkerConfig();

// ============================================================================
// Command metadata
// ============================================================================

Deno.test("atomicWriteCommand - has correct name", () => {
  assertEquals(atomicWriteCommand.name, "atomic-write");
});

Deno.test("atomicWriteCommand - has description", () => {
  assertEquals(typeof atomicWriteCommand.description, "string");
  assertEquals(atomicWriteCommand.description.length > 0, true);
});

// ============================================================================
// Argument validation
// ============================================================================

Deno.test("atomicWriteCommand - fails when path is missing", async () => {
  const result = await atomicWriteCommand.execute({}, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--path is required");
});

Deno.test("atomicWriteCommand - fails when path is empty string", async () => {
  const result = await atomicWriteCommand.execute({ path: "" }, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--path is required");
});

Deno.test("atomicWriteCommand - fails with invalid octal mode", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await atomicWriteCommand.execute(
      { path: `${tmpDir}/test.txt`, content: "hello", mode: "xyz" },
      config,
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "invalid mode");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ============================================================================
// Successful writes
// ============================================================================

Deno.test("atomicWriteCommand - writes content to file", async () => {
  const tmpDir = await Deno.makeTempDir();
  const targetPath = `${tmpDir}/output.txt`;

  try {
    const result = await atomicWriteCommand.execute(
      { path: targetPath, content: "hello world" },
      config,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "11 bytes");

    // Verify the file was actually written
    const content = await Deno.readTextFile(targetPath);
    assertEquals(content, "hello world");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("atomicWriteCommand - writes empty content when content arg is omitted", async () => {
  const tmpDir = await Deno.makeTempDir();
  const targetPath = `${tmpDir}/empty.txt`;

  try {
    const result = await atomicWriteCommand.execute(
      { path: targetPath },
      config,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "0 bytes");

    const content = await Deno.readTextFile(targetPath);
    assertEquals(content, "");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("atomicWriteCommand - accepts custom octal mode", async () => {
  const tmpDir = await Deno.makeTempDir();
  const targetPath = `${tmpDir}/custom-mode.txt`;

  try {
    const result = await atomicWriteCommand.execute(
      { path: targetPath, content: "test", mode: "644" },
      config,
    );
    assertEquals(result.success, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
