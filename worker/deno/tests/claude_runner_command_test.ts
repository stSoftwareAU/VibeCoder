/**
 * Tests for claude_runner command (Issue #913).
 *
 * CLI-specific tests only — unit tests for strip-escape-codes, token
 * estimation, stream JSON extraction, model args, and timeout diagnostics
 * live in claude_runner_test.ts. Deduplicated as part of Issue #1307.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { claudeRunnerCommand } from "../commands/claude_runner.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(): WorkerConfig {
  return buildDefaultWorkerConfig();
}

// ---------------------------------------------------------------------------
// CLI-specific: file-based operations (unique to command layer)
// ---------------------------------------------------------------------------

Deno.test("claude-runner command - extract-error-patterns from file", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "TypeError: something bad\nAll good\n");
    const result = await claudeRunnerCommand.execute(
      { operation: "extract-error-patterns", "file-path": tempFile },
      createMockConfig(),
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "TypeError");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("claude-runner command - extract-error-patterns requires file-path", async () => {
  const result = await claudeRunnerCommand.execute(
    { operation: "extract-error-patterns" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
});

Deno.test("claude-runner command - extract-failure-summary from file", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "I could not find the function\n");
    const result = await claudeRunnerCommand.execute(
      { operation: "extract-failure-summary", "file-path": tempFile },
      createMockConfig(),
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "could not find");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("claude-runner command - detect-already-complete detects completion", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "This is already complete\n");
    const result = await claudeRunnerCommand.execute(
      { operation: "detect-already-complete", "file-path": tempFile },
      createMockConfig(),
    );
    assertEquals(result.success, true);
    assertEquals(result.message, "true");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("claude-runner command - detect-already-complete returns false for normal output", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "I made some changes\n");
    const result = await claudeRunnerCommand.execute(
      { operation: "detect-already-complete", "file-path": tempFile },
      createMockConfig(),
    );
    assertEquals(result.success, true);
    assertEquals(result.message, "false");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("claude-runner command - detect-github-api-success detects API ops", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "I edited issue #42\n");
    const result = await claudeRunnerCommand.execute(
      { operation: "detect-github-api-success", "file-path": tempFile },
      createMockConfig(),
    );
    assertEquals(result.success, true);
    assertEquals(result.message, "true");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("claude-runner command - detect-rate-limit detects rate limiting", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "Error: rate limit exceeded\n");
    const result = await claudeRunnerCommand.execute(
      { operation: "detect-rate-limit", "file-path": tempFile },
      createMockConfig(),
    );
    assertEquals(result.success, true);
    assertEquals(result.message, "true");
  } finally {
    await Deno.remove(tempFile);
  }
});

// ---------------------------------------------------------------------------
// CLI-specific: unknown operation error handling
// ---------------------------------------------------------------------------

Deno.test("claude-runner command - returns error for unknown operation", async () => {
  const result = await claudeRunnerCommand.execute(
    { operation: "unknown" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
});
