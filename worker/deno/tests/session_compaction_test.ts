/**
 * Tests for session compaction (Issue #1328).
 *
 * Verifies progressive compaction levels, size measurement,
 * threshold detection, age-based cleanup, and metrics logging.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  compactAllSessions,
  type CompactionLevel,
  compactSession,
  measureSessionSize,
} from "../lib/session_compaction.ts";
import { getWorkStreamSessionPath } from "../lib/session_manager.ts";
import { setSelfHealEventsWorkDir } from "../lib/self_heal_events.ts";

/**
 * Create a temporary directory for testing, and point self-heal telemetry at
 * it (Issue #4226, mechanism replaced by Issue #4250).
 *
 * `compactSession` records its work through `emitSelfHealEventAuto`. Before
 * #4250 the sink fell back to `WORK_DIR`, then `HOME`, so this suite once
 * appended 225 forged `session_compaction` records to the operator's real
 * `~/logs/self-heal.jsonl`. The sink now requires explicit wiring — the
 * tests that want to assert emissions wire it here; a suite that forgets
 * emits nothing at all.
 */
async function createTestDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "session_compaction_test_" });
  setSelfHealEventsWorkDir(dir);
  return dir;
}

/** Clean up a temporary directory and release the telemetry sandbox. */
async function removeTestDir(path: string): Promise<void> {
  // Unwire first: a failure to remove the fixture must not leave the next
  // test emitting into a directory this one is about to delete.
  setSelfHealEventsWorkDir(undefined);
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

/** Create a file with specific content and optional old mtime. */
async function createFile(
  path: string,
  content: string,
  ageDays?: number,
): Promise<void> {
  const dir = path.substring(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content);
  if (ageDays !== undefined) {
    const mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    await Deno.utime(path, mtime, mtime);
  }
}

// ---------------------------------------------------------------------------
// measureSessionSize tests
// ---------------------------------------------------------------------------

Deno.test("session_compaction - measureSessionSize returns 0 for non-existent directory", async () => {
  const result = await measureSessionSize("/nonexistent/path");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value, 0);
  }
});

Deno.test("session_compaction - measureSessionSize returns 0 for empty directory", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    await Deno.mkdir(sessionPath, { recursive: true });

    const result = await measureSessionSize(sessionPath);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, 0);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("session_compaction - measureSessionSize sums all file sizes recursively", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    // Create files of known sizes
    await createFile(`${sessionPath}/file1.txt`, "A".repeat(100));
    await createFile(`${sessionPath}/subdir/file2.txt`, "B".repeat(200));
    await createFile(`${sessionPath}/subdir/nested/file3.txt`, "C".repeat(50));

    const result = await measureSessionSize(sessionPath);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, 350);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

// ---------------------------------------------------------------------------
// compactSession — Level 1 (soft) tests
// ---------------------------------------------------------------------------

Deno.test("session_compaction - level 1 removes temporary and cached files", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    // Create cacheable files (patterns that indicate temporary/cached data)
    await createFile(`${sessionPath}/tmp/output.json`, "A".repeat(500));
    await createFile(`${sessionPath}/cache/data.bin`, "B".repeat(500));
    await createFile(`${sessionPath}/.cache/tools.json`, "C".repeat(500));
    // Create an important file that should survive
    await createFile(`${sessionPath}/projects.json`, '{"important": true}');
    await createFile(`${sessionPath}/settings.json`, '{"keep": true}');

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 2000, // Over threshold due to cache files
      maxAgeDays: 365,
      level: "soft" as CompactionLevel,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.level, "soft");
      // Important files should survive
      assertEquals(await pathExists(`${sessionPath}/projects.json`), true);
      assertEquals(await pathExists(`${sessionPath}/settings.json`), true);
      // Cache/temp directories should be removed
      assertEquals(await pathExists(`${sessionPath}/tmp`), false);
      assertEquals(await pathExists(`${sessionPath}/cache`), false);
      assertEquals(await pathExists(`${sessionPath}/.cache`), false);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("session_compaction - level 1 returns size reduction metrics", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    await createFile(`${sessionPath}/tmp/big.bin`, "X".repeat(1000));
    await createFile(`${sessionPath}/keep.json`, '{"data": true}');

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 500,
      maxAgeDays: 365,
      level: "soft" as CompactionLevel,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.sizeBefore > result.value.sizeAfter, true);
      assertEquals(result.value.level, "soft");
    }
  } finally {
    await removeTestDir(testDir);
  }
});

// ---------------------------------------------------------------------------
// compactSession — Level 2 (moderate) tests
// ---------------------------------------------------------------------------

Deno.test("session_compaction - level 2 removes old files beyond age threshold", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    // Create old files (beyond threshold)
    await createFile(`${sessionPath}/old-data.json`, "A".repeat(500), 10);
    await createFile(`${sessionPath}/ancient.log`, "B".repeat(500), 20);
    // Create recent files
    await createFile(`${sessionPath}/recent.json`, '{"current": true}');
    await createFile(`${sessionPath}/projects.json`, '{"keep": true}');

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 500,
      maxAgeDays: 7,
      level: "moderate" as CompactionLevel,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.level, "moderate");
      // Old files removed
      assertEquals(await pathExists(`${sessionPath}/old-data.json`), false);
      assertEquals(await pathExists(`${sessionPath}/ancient.log`), false);
      // Recent files kept
      assertEquals(await pathExists(`${sessionPath}/recent.json`), true);
      assertEquals(await pathExists(`${sessionPath}/projects.json`), true);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("session_compaction - level 2 removes oldest files first when over size", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    // Create files of different ages — all within age limit but over size
    await createFile(`${sessionPath}/oldest.bin`, "A".repeat(300), 5);
    await createFile(`${sessionPath}/middle.bin`, "B".repeat(300), 3);
    await createFile(`${sessionPath}/newest.bin`, "C".repeat(300), 1);

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 400, // Only room for ~1 file
      maxAgeDays: 30,
      level: "moderate" as CompactionLevel,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      // Oldest files should be removed first
      assertEquals(await pathExists(`${sessionPath}/oldest.bin`), false);
      // Newest should remain
      assertEquals(await pathExists(`${sessionPath}/newest.bin`), true);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

// ---------------------------------------------------------------------------
// compactSession — Level 3 (hard) tests
// ---------------------------------------------------------------------------

Deno.test("session_compaction - level 3 deletes entire session directory", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    await createFile(`${sessionPath}/file1.txt`, "A".repeat(1000));
    await createFile(`${sessionPath}/subdir/file2.txt`, "B".repeat(1000));
    await createFile(`${sessionPath}/projects.json`, '{"data": true}');

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 500,
      maxAgeDays: 365,
      level: "hard" as CompactionLevel,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.level, "hard");
      assertEquals(result.value.sizeAfter, 0);
      assertEquals(await pathExists(sessionPath), false);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("session_compaction - level 3 handles non-existent directory gracefully", async () => {
  const result = await compactSession("/nonexistent/session", {
    maxSizeBytes: 500,
    maxAgeDays: 365,
    level: "hard" as CompactionLevel,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.level, "hard");
    assertEquals(result.value.sizeBefore, 0);
    assertEquals(result.value.sizeAfter, 0);
  }
});

// ---------------------------------------------------------------------------
// compactSession — auto-level selection tests
// ---------------------------------------------------------------------------

Deno.test("session_compaction - auto level selects soft first", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    // Create enough cache data that soft compaction will bring us under threshold
    await createFile(`${sessionPath}/tmp/big.bin`, "X".repeat(2000));
    await createFile(`${sessionPath}/keep.json`, '{"small": true}');

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 500,
      maxAgeDays: 365,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      // Should have applied soft compaction and stopped (or escalated)
      assertEquals(result.value.level !== "none", true);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("session_compaction - auto level returns none when under threshold", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    await createFile(`${sessionPath}/small.json`, '{"tiny": true}');

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 50 * 1024 * 1024, // 50 MB — well over what we have
      maxAgeDays: 365,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.level, "none");
      assertEquals(result.value.sizeBefore, result.value.sizeAfter);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

// ---------------------------------------------------------------------------
// compactAllSessions — age-based cleanup tests
// ---------------------------------------------------------------------------

Deno.test("session_compaction - compactAllSessions removes sessions beyond age limit", async () => {
  const testDir = await createTestDir();
  try {
    // Create sessions in the expected structure
    const basePath = `${testDir}/.claude-sessions/owner/repo`;
    const defaultPath = `${basePath}/default`;
    const milestonePath = `${basePath}/milestone-1`;

    // Default session — ancient (should be removed)
    await createFile(`${defaultPath}/data.json`, '{"old": true}', 30);
    // Milestone session — recent (should be kept)
    await createFile(`${milestonePath}/data.json`, '{"recent": true}');

    const result = await compactAllSessions(`${testDir}/.claude-sessions`, {
      maxSizeBytes: 50 * 1024 * 1024,
      maxAgeDays: 7,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      // Ancient default session removed
      assertEquals(await pathExists(defaultPath), false);
      // Recent milestone session kept
      assertEquals(await pathExists(milestonePath), true);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("session_compaction - compactAllSessions handles empty session store", async () => {
  const result = await compactAllSessions("/nonexistent/store", {
    maxSizeBytes: 50 * 1024 * 1024,
    maxAgeDays: 7,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.sessionsCompacted, 0);
    assertEquals(result.value.sessionsRemoved, 0);
  }
});

Deno.test("session_compaction - compactAllSessions applies size-based compaction", async () => {
  const testDir = await createTestDir();
  try {
    const basePath = `${testDir}/.claude-sessions/owner/repo`;
    const defaultPath = `${basePath}/default`;

    // Create a session with lots of cache data over threshold
    await createFile(`${defaultPath}/tmp/big.bin`, "X".repeat(2000));
    await createFile(`${defaultPath}/keep.json`, '{"data": true}');

    const result = await compactAllSessions(`${testDir}/.claude-sessions`, {
      maxSizeBytes: 500,
      maxAgeDays: 365,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.sessionsCompacted >= 0, true);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

// ---------------------------------------------------------------------------
// CompactionResult structure tests
// ---------------------------------------------------------------------------

Deno.test("session_compaction - CompactionResult includes before and after sizes", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    await createFile(`${sessionPath}/tmp/removable.bin`, "X".repeat(1000));
    await createFile(`${sessionPath}/keep.json`, '{"data": true}');

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 100,
      maxAgeDays: 365,
      level: "soft" as CompactionLevel,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(typeof result.value.sizeBefore, "number");
      assertEquals(typeof result.value.sizeAfter, "number");
      assertEquals(typeof result.value.level, "string");
      assertEquals(typeof result.value.sessionPath, "string");
    }
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("session_compaction - compactSession preserves recent context files", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    // Create important context files
    await createFile(`${sessionPath}/projects.json`, '{"project": "test"}');
    await createFile(`${sessionPath}/settings.json`, '{"setting": "value"}');
    await createFile(
      `${sessionPath}/todos.json`,
      '{"todos": []}',
    );

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 50 * 1024 * 1024,
      maxAgeDays: 365,
      level: "soft" as CompactionLevel,
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      // All important files should survive soft compaction
      assertEquals(await pathExists(`${sessionPath}/projects.json`), true);
      assertEquals(await pathExists(`${sessionPath}/settings.json`), true);
      assertEquals(await pathExists(`${sessionPath}/todos.json`), true);
    }
  } finally {
    await removeTestDir(testDir);
  }
});

// ---------------------------------------------------------------------------
// Integration with getWorkStreamSessionPath
// ---------------------------------------------------------------------------

Deno.test("session_compaction - works with session manager paths", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = getWorkStreamSessionPath(testDir, "owner/repo");
    await createFile(`${sessionPath}/data.json`, '{"data": true}');

    const sizeResult = await measureSessionSize(sessionPath);
    assertEquals(sizeResult.ok, true);
    if (sizeResult.ok) {
      assertEquals(sizeResult.value > 0, true);
    }

    const compactResult = await compactSession(sessionPath, {
      maxSizeBytes: 50 * 1024 * 1024,
      maxAgeDays: 365,
    });
    assertEquals(compactResult.ok, true);
    if (compactResult.ok) {
      assertEquals(compactResult.value.level, "none");
    }
  } finally {
    await removeTestDir(testDir);
  }
});

// ---------------------------------------------------------------------------
// Telemetry containment (Issue #4226)
// ---------------------------------------------------------------------------

Deno.test("session_compaction - self-heal telemetry lands in the fixture, not the operator's log", async () => {
  const testDir = await createTestDir();
  try {
    const sessionPath = `${testDir}/session`;
    await createFile(`${sessionPath}/tmp/output.json`, "A".repeat(2000));
    await createFile(`${sessionPath}/keep.json`, '{"keep": true}');

    const result = await compactSession(sessionPath, {
      maxSizeBytes: 500,
      maxAgeDays: 365,
      level: "soft" as CompactionLevel,
    });
    assertEquals(result.ok, true);

    // `compactSession` emits through `emitSelfHealEventAuto`, which resolves
    // its work directory from the environment. Unsandboxed that is the
    // operator's real `~/logs/self-heal.jsonl`: every run of this suite forged
    // production self-heal records naming temp directories that never existed
    // on the host (Issue #4226, same family as #4209). Pin the event to the
    // fixture instead.
    const sandboxed = await Deno.readTextFile(
      `${testDir}/logs/self-heal.jsonl`,
    );
    assertStringIncludes(sandboxed, '"module":"session_compaction"');
    assertStringIncludes(sandboxed, '"action":"compact_soft"');
    assertStringIncludes(sandboxed, sessionPath);
  } finally {
    await removeTestDir(testDir);
  }
});

Deno.test("session_compaction - the fixture sandbox is restored after each test", async () => {
  // A leaked WORK_DIR would silently redirect every later test's telemetry —
  // and, worse, redirect it back at the operator's log if it leaked as unset.
  const before = Deno.env.get("WORK_DIR");
  const testDir = await createTestDir();
  await removeTestDir(testDir);
  assertEquals(Deno.env.get("WORK_DIR"), before);
});
