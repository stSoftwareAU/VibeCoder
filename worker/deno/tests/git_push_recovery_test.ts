/**
 * Tests for the git push recovery module (Issue #1309).
 *
 * Tests the recoverFromPushRejection function's behaviour when
 * git operations fail in expected ways. Uses a temp directory
 * (not a real git repo) to exercise error handling paths.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { recoverFromPushRejection } from "../lib/git_push_recovery.ts";

// ============================================================================
// Error handling paths — exercised in non-git directories
// ============================================================================

Deno.test("recoverFromPushRejection - fails gracefully when not in a git repo", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await recoverFromPushRejection("test-branch", {
      cwd: tmpDir,
    });
    // Should return an error result, not throw
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(typeof result.error.message, "string");
      assertEquals(result.error.message.length > 0, true);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("recoverFromPushRejection - handles empty branch name", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const result = await recoverFromPushRejection("", { cwd: tmpDir });
    // Should return an error (git pull --rebase will fail)
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
