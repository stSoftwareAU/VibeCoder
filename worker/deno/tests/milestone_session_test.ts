/**
 * Tests for milestone-aware Claude session branching (Issue #1322).
 *
 * Verifies that milestone sessions are initialised from the default branch
 * session on first use, then maintained independently.
 *
 * Issue #3663 narrowed persistence to an allowlist of session data, so the
 * fixtures below use allowlisted names. The behaviours under test are
 * unchanged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  getWorkStreamSessionPath,
  initialiseMilestoneSession,
  restoreSession,
  saveSession,
} from "../lib/session_manager.ts";

/** Create a temporary directory for testing. */
async function createTestDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "milestone_session_test_" });
}

/** Clean up a temporary directory. */
async function removeTestDir(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch {
    // Ignore
  }
}

/** Helper to check if a path exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- getWorkStreamSessionPath tests ---

Deno.test("milestone_session - getWorkStreamSessionPath returns default/ subdir when no milestoneId", () => {
  const result = getWorkStreamSessionPath("/work", "owner/repo");
  assertEquals(result, "/work/.claude-sessions/owner/repo/default");
});

Deno.test("milestone_session - getWorkStreamSessionPath returns milestone subdir with milestoneId", () => {
  const result = getWorkStreamSessionPath("/work", "owner/repo", 42);
  assertEquals(result, "/work/.claude-sessions/owner/repo/milestone-42");
});

Deno.test("milestone_session - getWorkStreamSessionPath handles different milestones separately", () => {
  const path1 = getWorkStreamSessionPath("/work", "owner/repo", 1);
  const path2 = getWorkStreamSessionPath("/work", "owner/repo", 2);
  assertEquals(path1, "/work/.claude-sessions/owner/repo/milestone-1");
  assertEquals(path2, "/work/.claude-sessions/owner/repo/milestone-2");
  assertEquals(path1 !== path2, true);
});

// --- initialiseMilestoneSession tests ---

Deno.test("milestone_session - initialiseMilestoneSession copies default session on first use", async () => {
  const testDir = await createTestDir();
  try {
    // Set up a default session with some content
    const defaultPath = getWorkStreamSessionPath(testDir, "owner/repo");
    await Deno.mkdir(defaultPath, { recursive: true });
    await Deno.writeTextFile(`${defaultPath}/session.json`, '{"learnt": true}');
    await Deno.mkdir(`${defaultPath}/projects`, { recursive: true });
    await Deno.writeTextFile(
      `${defaultPath}/projects/proj.json`,
      '{"name": "test"}',
    );

    // Initialise milestone session
    const result = await initialiseMilestoneSession(testDir, "owner/repo", 42);
    assertEquals(result.ok, true);

    // Verify milestone session has the default content
    const milestonePath = getWorkStreamSessionPath(testDir, "owner/repo", 42);
    assertEquals(await pathExists(milestonePath), true);
    const config = await Deno.readTextFile(`${milestonePath}/session.json`);
    assertEquals(config, '{"learnt": true}');
    const proj = await Deno.readTextFile(`${milestonePath}/projects/proj.json`);
    assertEquals(proj, '{"name": "test"}');
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("milestone_session - initialiseMilestoneSession does not re-copy if milestone session already exists", async () => {
  const testDir = await createTestDir();
  try {
    // Set up default session
    const defaultPath = getWorkStreamSessionPath(testDir, "owner/repo");
    await Deno.mkdir(defaultPath, { recursive: true });
    await Deno.writeTextFile(`${defaultPath}/session.json`, '{"version": 1}');

    // Create existing milestone session with different content
    const milestonePath = getWorkStreamSessionPath(testDir, "owner/repo", 42);
    await Deno.mkdir(milestonePath, { recursive: true });
    await Deno.writeTextFile(
      `${milestonePath}/session.json`,
      '{"version": 2, "milestone_specific": true}',
    );

    // Initialise — should NOT overwrite existing milestone session
    const result = await initialiseMilestoneSession(testDir, "owner/repo", 42);
    assertEquals(result.ok, true);

    // Milestone session should retain its own content
    const config = await Deno.readTextFile(`${milestonePath}/session.json`);
    assertEquals(config, '{"version": 2, "milestone_specific": true}');
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("milestone_session - initialiseMilestoneSession succeeds with empty session when no default exists", async () => {
  const testDir = await createTestDir();
  try {
    // No default session exists at all
    const result = await initialiseMilestoneSession(testDir, "owner/repo", 42);
    assertEquals(result.ok, true);

    // Milestone session directory should not be created (no source to copy)
    const milestonePath = getWorkStreamSessionPath(testDir, "owner/repo", 42);
    assertEquals(await pathExists(milestonePath), false);
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("milestone_session - default session is not modified by milestone save", async () => {
  const testDir = await createTestDir();
  try {
    const repoPath = `${testDir}/repo`;

    // Set up default session
    const defaultPath = getWorkStreamSessionPath(testDir, "owner/repo");
    await Deno.mkdir(defaultPath, { recursive: true });
    await Deno.writeTextFile(
      `${defaultPath}/session-original.json`,
      "default content",
    );

    // Initialise milestone from default
    await initialiseMilestoneSession(testDir, "owner/repo", 42);

    // Simulate milestone work: create .claude/ with modified content
    await Deno.mkdir(`${repoPath}/.claude`, { recursive: true });
    await Deno.writeTextFile(
      `${repoPath}/.claude/session-original.json`,
      "modified by milestone",
    );
    await Deno.writeTextFile(
      `${repoPath}/.claude/session-milestone_only.json`,
      "milestone-specific",
    );

    // Save to milestone session store
    const saveResult = await saveSession(
      repoPath,
      testDir,
      "owner/repo",
      undefined,
      42,
    );
    assertEquals(saveResult.ok, true);

    // Default session should be unchanged
    const defaultContent = await Deno.readTextFile(
      `${defaultPath}/session-original.json`,
    );
    assertEquals(defaultContent, "default content");
    assertEquals(
      await pathExists(`${defaultPath}/session-milestone_only.json`),
      false,
    );
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("milestone_session - restoreSession with milestoneId uses milestone session", async () => {
  const testDir = await createTestDir();
  try {
    const repoPath = `${testDir}/repo`;
    await Deno.mkdir(repoPath, { recursive: true });

    // Create both default and milestone sessions with different content
    const defaultPath = getWorkStreamSessionPath(testDir, "owner/repo");
    await Deno.mkdir(defaultPath, { recursive: true });
    await Deno.writeTextFile(`${defaultPath}/session.json`, "default data");

    const milestonePath = getWorkStreamSessionPath(testDir, "owner/repo", 42);
    await Deno.mkdir(milestonePath, { recursive: true });
    await Deno.writeTextFile(`${milestonePath}/session.json`, "milestone data");

    // Restore milestone session
    const result = await restoreSession(repoPath, testDir, "owner/repo", 42);
    assertEquals(result.ok, true);

    // Should have milestone content, not default
    const content = await Deno.readTextFile(`${repoPath}/.claude/session.json`);
    assertEquals(content, "milestone data");
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("milestone_session - restoreSession without milestoneId uses default session", async () => {
  const testDir = await createTestDir();
  try {
    const repoPath = `${testDir}/repo`;
    await Deno.mkdir(repoPath, { recursive: true });

    // Create default session
    const defaultPath = getWorkStreamSessionPath(testDir, "owner/repo");
    await Deno.mkdir(defaultPath, { recursive: true });
    await Deno.writeTextFile(`${defaultPath}/session.json`, "default data");

    // Restore default session (no milestoneId)
    const result = await restoreSession(repoPath, testDir, "owner/repo");
    assertEquals(result.ok, true);

    // Should have default content
    const content = await Deno.readTextFile(`${repoPath}/.claude/session.json`);
    assertEquals(content, "default data");
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("milestone_session - saveSession with milestoneId saves to milestone store", async () => {
  const testDir = await createTestDir();
  try {
    const repoPath = `${testDir}/repo`;
    await Deno.mkdir(`${repoPath}/.claude`, { recursive: true });
    await Deno.writeTextFile(
      `${repoPath}/.claude/session.json`,
      '{"milestone": 42}',
    );

    const result = await saveSession(
      repoPath,
      testDir,
      "owner/repo",
      undefined,
      42,
    );
    assertEquals(result.ok, true);

    // Verify saved to milestone path
    const milestonePath = getWorkStreamSessionPath(testDir, "owner/repo", 42);
    const content = await Deno.readTextFile(`${milestonePath}/session.json`);
    assertEquals(content, '{"milestone": 42}');

    // Verify default session was NOT created
    const defaultPath = getWorkStreamSessionPath(testDir, "owner/repo");
    assertEquals(await pathExists(defaultPath), false);
  } finally {
    await removeTestDir(testDir);
  }
});

// --- Migration test ---

Deno.test("milestone_session - restoreSession migrates old-style session to default/ subdir", async () => {
  const testDir = await createTestDir();
  try {
    const repoPath = `${testDir}/repo`;
    await Deno.mkdir(repoPath, { recursive: true });

    // Set up old-style session (files directly in owner/repo/)
    const oldStorePath = `${testDir}/.claude-sessions/owner/repo`;
    await Deno.mkdir(oldStorePath, { recursive: true });
    await Deno.writeTextFile(
      `${oldStorePath}/session-legacy.json`,
      "old format data",
    );

    // Restore without milestoneId — should migrate and restore
    const result = await restoreSession(repoPath, testDir, "owner/repo");
    assertEquals(result.ok, true);

    // Should have the content from the migrated session
    const content = await Deno.readTextFile(
      `${repoPath}/.claude/session-legacy.json`,
    );
    assertEquals(content, "old format data");

    // New default/ subdir should exist after migration
    const defaultPath = getWorkStreamSessionPath(testDir, "owner/repo");
    assertEquals(await pathExists(defaultPath), true);
  } finally {
    await removeTestDir(testDir);
  }
});

// --- Full round-trip milestone test ---

Deno.test("milestone_session - full milestone workflow: branch from default, work, save independently", async () => {
  const testDir = await createTestDir();
  try {
    const repoPath = `${testDir}/repo`;

    // Step 1: Create initial .claude/ with default branch context
    await Deno.mkdir(`${repoPath}/.claude`, { recursive: true });
    await Deno.writeTextFile(
      `${repoPath}/.claude/session-conventions.json`,
      '{"spelling": "australian"}',
    );
    await Deno.writeTextFile(
      `${repoPath}/.claude/session-patterns.json`,
      '{"pattern": "result-type"}',
    );

    // Step 2: Save as default session
    const saveDefault = await saveSession(repoPath, testDir, "owner/repo");
    assertEquals(saveDefault.ok, true);

    // Step 3: Initialise milestone session (first invocation)
    const initResult = await initialiseMilestoneSession(
      testDir,
      "owner/repo",
      10,
    );
    assertEquals(initResult.ok, true);

    // Step 4: Restore milestone session into .claude/
    await Deno.remove(`${repoPath}/.claude`, { recursive: true });
    const restoreMs = await restoreSession(repoPath, testDir, "owner/repo", 10);
    assertEquals(restoreMs.ok, true);

    // Should have default content as starting point
    const conventions = await Deno.readTextFile(
      `${repoPath}/.claude/session-conventions.json`,
    );
    assertEquals(conventions, '{"spelling": "australian"}');

    // Step 5: Simulate milestone work — add milestone-specific context
    await Deno.writeTextFile(
      `${repoPath}/.claude/session-milestone_context.json`,
      '{"oidc": true}',
    );

    // Step 6: Save milestone session
    const saveMs = await saveSession(
      repoPath,
      testDir,
      "owner/repo",
      undefined,
      10,
    );
    assertEquals(saveMs.ok, true);

    // Step 7: Verify default session is unchanged
    const defaultPath = getWorkStreamSessionPath(testDir, "owner/repo");
    assertEquals(
      await pathExists(`${defaultPath}/session-milestone_context.json`),
      false,
    );
    const defaultConventions = await Deno.readTextFile(
      `${defaultPath}/session-conventions.json`,
    );
    assertEquals(defaultConventions, '{"spelling": "australian"}');

    // Step 8: Verify milestone session has both old and new content
    const milestonePath = getWorkStreamSessionPath(testDir, "owner/repo", 10);
    const msConventions = await Deno.readTextFile(
      `${milestonePath}/session-conventions.json`,
    );
    assertEquals(msConventions, '{"spelling": "australian"}');
    const msContext = await Deno.readTextFile(
      `${milestonePath}/session-milestone_context.json`,
    );
    assertEquals(msContext, '{"oidc": true}');

    // Step 9: Second invocation should NOT re-copy from default
    // Add something to default that should NOT appear in milestone
    await Deno.writeTextFile(
      `${defaultPath}/session-new_default.json`,
      "new default content",
    );

    const initResult2 = await initialiseMilestoneSession(
      testDir,
      "owner/repo",
      10,
    );
    assertEquals(initResult2.ok, true);

    // Milestone should NOT have the new default file
    assertEquals(
      await pathExists(`${milestonePath}/session-new_default.json`),
      false,
    );
    // But should still have milestone-specific content
    const msContext2 = await Deno.readTextFile(
      `${milestonePath}/session-milestone_context.json`,
    );
    assertEquals(msContext2, '{"oidc": true}');
  } finally {
    await removeTestDir(testDir);
  }
});
