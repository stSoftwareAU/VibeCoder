/**
 * Tests for crash_cleanup.ts — clean up in-progress issue state
 * on unexpected exit (Issue #631, #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  cleanupInProgressIssue,
  clearHeartbeat,
  heartbeatFilePath,
} from "../lib/crash_cleanup.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "cc-test-" });
}

// ============================================================================
// heartbeatFilePath
// ============================================================================

Deno.test("crash cleanup - heartbeatFilePath generates correct path", () => {
  const path = heartbeatFilePath("/work", "org/repo", 42);
  assertEquals(path, "/work/.heartbeat_org_repo_42");
});

Deno.test("crash cleanup - heartbeatFilePath handles different repos", () => {
  const path = heartbeatFilePath("/work", "myorg/myrepo", 100);
  assertEquals(path, "/work/.heartbeat_myorg_myrepo_100");
});

// ============================================================================
// clearHeartbeat
// ============================================================================

Deno.test("crash cleanup - clearHeartbeat removes existing file", async () => {
  const dir = await makeTempDir();
  try {
    const hbPath = heartbeatFilePath(dir, "org/repo", 42);
    await Deno.writeTextFile(hbPath, "1234567890");

    const result = await clearHeartbeat(dir, "org/repo", 42);
    assertEquals(result.ok, true);

    // Verify file was removed
    try {
      await Deno.stat(hbPath);
      assertEquals(true, false, "File should not exist");
    } catch (e) {
      assertEquals((e as Deno.errors.NotFound).name, "NotFound");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("crash cleanup - clearHeartbeat succeeds when file does not exist", async () => {
  const dir = await makeTempDir();
  try {
    const result = await clearHeartbeat(dir, "org/repo", 999);
    assertEquals(result.ok, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// cleanupInProgressIssue
// ============================================================================

Deno.test("crash cleanup - cleanupInProgressIssue is no-op when repo is empty", async () => {
  const result = await cleanupInProgressIssue({
    repo: "",
    issueNumber: 42,
    githubUser: "testuser",
    workDir: "/tmp",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.heartbeatCleared, false);
    assertEquals(result.value.unassigned, false);
  }
});

Deno.test("crash cleanup - cleanupInProgressIssue is no-op when issueNumber is 0", async () => {
  const result = await cleanupInProgressIssue({
    repo: "org/repo",
    issueNumber: 0,
    githubUser: "testuser",
    workDir: "/tmp",
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.heartbeatCleared, false);
    assertEquals(result.value.unassigned, false);
  }
});

Deno.test("crash cleanup - cleanupInProgressIssue clears heartbeat file", async () => {
  const dir = await makeTempDir();
  try {
    const hbPath = heartbeatFilePath(dir, "org/repo", 42);
    await Deno.writeTextFile(hbPath, "1234567890");

    const result = await cleanupInProgressIssue({
      repo: "org/repo",
      issueNumber: 42,
      githubUser: "",
      workDir: dir,
    });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.heartbeatCleared, true);
    }

    // Verify heartbeat file is gone
    try {
      await Deno.stat(hbPath);
      assertEquals(true, false, "Heartbeat file should be removed");
    } catch (e) {
      assertEquals((e as Deno.errors.NotFound).name, "NotFound");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
