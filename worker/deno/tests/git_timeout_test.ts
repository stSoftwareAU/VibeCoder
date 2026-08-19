/**
 * Tests for git_timeout.ts — Git operation timeout management (Issue #619, #912).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getTimeoutForOperation,
  isGitTimeout,
  runGitCommand,
  runGitCommandChecked,
  TIMEOUT_EXIT_CODE,
} from "../lib/git_timeout.ts";

// ---------------------------------------------------------------------------
// getTimeoutForOperation
// ---------------------------------------------------------------------------

Deno.test("git timeout - getTimeoutForOperation returns merge timeout for merge", () => {
  const timeout = getTimeoutForOperation("merge");
  assertEquals(timeout, 120);
});

Deno.test("git timeout - getTimeoutForOperation returns merge timeout for rebase", () => {
  const timeout = getTimeoutForOperation("rebase");
  assertEquals(timeout, 120);
});

Deno.test("git timeout - getTimeoutForOperation returns merge timeout for pull", () => {
  const timeout = getTimeoutForOperation("pull");
  assertEquals(timeout, 120);
});

Deno.test("git timeout - getTimeoutForOperation returns default timeout for fetch", () => {
  const timeout = getTimeoutForOperation("fetch");
  assertEquals(timeout, 60);
});

Deno.test("git timeout - getTimeoutForOperation returns default timeout for push", () => {
  const timeout = getTimeoutForOperation("push");
  assertEquals(timeout, 60);
});

Deno.test("git timeout - getTimeoutForOperation returns default timeout for unknown commands", () => {
  const timeout = getTimeoutForOperation("status");
  assertEquals(timeout, 60);
});

// ---------------------------------------------------------------------------
// isGitTimeout
// ---------------------------------------------------------------------------

Deno.test("git timeout - isGitTimeout returns true for timeout exit code", () => {
  assertEquals(isGitTimeout(TIMEOUT_EXIT_CODE), true);
});

Deno.test("git timeout - isGitTimeout returns false for zero", () => {
  assertEquals(isGitTimeout(0), false);
});

Deno.test("git timeout - isGitTimeout returns false for other non-zero codes", () => {
  assertEquals(isGitTimeout(1), false);
  assertEquals(isGitTimeout(128), false);
});

// ---------------------------------------------------------------------------
// TIMEOUT_EXIT_CODE
// ---------------------------------------------------------------------------

Deno.test("git timeout - TIMEOUT_EXIT_CODE is 124", () => {
  assertEquals(TIMEOUT_EXIT_CODE, 124);
});

// ---------------------------------------------------------------------------
// runGitCommand — real git invocations
// ---------------------------------------------------------------------------

Deno.test("git timeout - runGitCommand runs a simple git command", async () => {
  const result = await runGitCommand(["--version"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.code, 0);
    assertStringIncludes(result.value.stdout, "git version");
  }
});

Deno.test("git timeout - runGitCommand returns non-zero for invalid command", async () => {
  const result = await runGitCommand(["nonexistent-subcommand"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.code !== 0, true);
  }
});

// ---------------------------------------------------------------------------
// runGitCommandChecked
// ---------------------------------------------------------------------------

Deno.test("git timeout - runGitCommandChecked returns stdout on success", async () => {
  const result = await runGitCommandChecked(["--version"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "git version");
  }
});

Deno.test("git timeout - runGitCommandChecked returns error for invalid command", async () => {
  const result = await runGitCommandChecked(["nonexistent-subcommand"]);
  assertEquals(result.ok, false);
});
