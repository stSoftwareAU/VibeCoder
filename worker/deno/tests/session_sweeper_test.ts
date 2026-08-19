/**
 * Tests for session_sweeper.ts — startup sweep of abandoned Claude
 * session directories (Issue #1494).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_MAX_CUMULATIVE_SIZE_BYTES,
  DEFAULT_MAX_SESSION_AGE_DAYS,
  DEFAULT_MAX_SESSION_SIZE_BYTES,
  sweepAllSessions,
} from "../lib/session_sweeper.ts";

async function makeTempWorkDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "vibe-session-sweeper-" });
}

async function makeSession(
  workDir: string,
  owner: string,
  repo: string,
  stream: string,
  bytes: number,
  mtimeEpoch?: number,
): Promise<string> {
  const path = `${workDir}/.claude-sessions/${owner}/${repo}/${stream}`;
  await Deno.mkdir(path, { recursive: true });
  const filePath = `${path}/data.json`;
  await Deno.writeTextFile(filePath, "x".repeat(bytes));
  if (mtimeEpoch !== undefined) {
    const t = new Date(mtimeEpoch * 1000);
    await Deno.utime(filePath, t, t);
    await Deno.utime(path, t, t);
  }
  return path;
}

async function writeHeartbeat(
  workDir: string,
  owner: string,
  repo: string,
  issue: number,
  epoch: number,
): Promise<void> {
  await Deno.writeTextFile(
    `${workDir}/.heartbeat_${owner}_${repo}_${issue}`,
    String(epoch),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Constants
// ============================================================================

Deno.test("session_sweeper - default constants match spec", () => {
  assertEquals(DEFAULT_MAX_SESSION_AGE_DAYS, 7);
  assertEquals(DEFAULT_MAX_SESSION_SIZE_BYTES, 50 * 1024 * 1024);
  assertEquals(DEFAULT_MAX_CUMULATIVE_SIZE_BYTES, 500 * 1024 * 1024);
});

// ============================================================================
// Enumeration
// ============================================================================

Deno.test("sweepAllSessions - enumerates every per-repo/per-work-stream session", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const now = Math.floor(Date.now() / 1000);
    await makeSession(workDir, "a", "repo1", "default", 10, now);
    await makeSession(workDir, "a", "repo1", "milestone-1", 10, now);
    await makeSession(workDir, "a", "repo2", "default", 10, now);
    await makeSession(workDir, "b", "repo3", "default", 10, now);

    const result = await sweepAllSessions({ workDir, nowFn: () => now });
    assertEquals(result.scanned, 4);
    assertEquals(result.removed.length, 0);
    // Sessions without heartbeats are silently preserved — active[] only
    // records sessions kept specifically because of a heartbeat guard.
    assertEquals(result.active.length, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("sweepAllSessions - returns empty result when sessions dir is missing", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const result = await sweepAllSessions({ workDir });
    assertEquals(result.scanned, 0);
    assertEquals(result.removed.length, 0);
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// Age expiry
// ============================================================================

Deno.test("sweepAllSessions - removes sessions older than 7 days", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const now = Math.floor(Date.now() / 1000);
    const oldEpoch = now - 30 * 86400; // 30 days old
    const freshEpoch = now - 60; // 60 seconds old

    const oldPath = await makeSession(
      workDir,
      "a",
      "old",
      "default",
      10,
      oldEpoch,
    );
    const freshPath = await makeSession(
      workDir,
      "a",
      "fresh",
      "default",
      10,
      freshEpoch,
    );

    const result = await sweepAllSessions({
      workDir,
      maxAgeDays: 7,
      nowFn: () => now,
    });

    assertEquals(await pathExists(oldPath), false);
    assertEquals(await pathExists(freshPath), true);
    assertEquals(result.removed.length, 1);
    assertEquals(result.removed[0]?.reason, "age");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// Per-session size cap
// ============================================================================

Deno.test("sweepAllSessions - removes sessions exceeding per-session size cap", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const now = Math.floor(Date.now() / 1000);
    const smallPath = await makeSession(
      workDir,
      "a",
      "small",
      "default",
      10,
      now,
    );
    const bigPath = await makeSession(workDir, "a", "big", "default", 500, now);

    const result = await sweepAllSessions({
      workDir,
      maxSessionSizeBytes: 100,
      nowFn: () => now,
    });

    assertEquals(await pathExists(bigPath), false);
    assertEquals(await pathExists(smallPath), true);
    assertEquals(result.removed.length, 1);
    assertEquals(result.removed[0]?.reason, "size");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// Cumulative cap
// ============================================================================

Deno.test("sweepAllSessions - removes oldest sessions first when cumulative cap exceeded", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const now = Math.floor(Date.now() / 1000);

    // Each session ~100 bytes; total 400; cap at 250 bytes.
    const oldest = await makeSession(
      workDir,
      "a",
      "s1",
      "default",
      100,
      now - 300,
    );
    const older = await makeSession(
      workDir,
      "a",
      "s2",
      "default",
      100,
      now - 200,
    );
    const newer = await makeSession(
      workDir,
      "a",
      "s3",
      "default",
      100,
      now - 100,
    );
    const newest = await makeSession(
      workDir,
      "a",
      "s4",
      "default",
      100,
      now - 10,
    );

    const result = await sweepAllSessions({
      workDir,
      maxSessionSizeBytes: 10 * 1024 * 1024, // high — don't trigger per-session cap
      maxAgeDays: 365, // high — don't trigger age expiry
      maxCumulativeSizeBytes: 250,
      nowFn: () => now,
    });

    // Oldest two should be removed to bring total below 250
    assertEquals(await pathExists(oldest), false);
    assertEquals(await pathExists(older), false);
    assertEquals(await pathExists(newer), true);
    assertEquals(await pathExists(newest), true);
    assertEquals(
      result.removed.filter((r) => r.reason === "cumulative").length,
      2,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// Active heartbeat preservation
// ============================================================================

Deno.test("sweepAllSessions - preserves sessions with an active heartbeat even when stale", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const now = Math.floor(Date.now() / 1000);
    // Session is 30 days old — would normally expire.
    const sessionPath = await makeSession(
      workDir,
      "acme",
      "myrepo",
      "default",
      10,
      now - 30 * 86400,
    );
    // Fresh heartbeat for any issue under this repo.
    await writeHeartbeat(workDir, "acme", "myrepo", 42, now - 60);

    const result = await sweepAllSessions({
      workDir,
      maxAgeDays: 7,
      nowFn: () => now,
    });

    assertEquals(await pathExists(sessionPath), true);
    assertEquals(result.removed.length, 0);
    assertEquals(result.active.length, 1);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("sweepAllSessions - preserves active sessions even under cumulative cap pressure", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const now = Math.floor(Date.now() / 1000);

    // Active (heartbeat) but old — should never be removed.
    const activePath = await makeSession(
      workDir,
      "acme",
      "active",
      "default",
      200,
      now - 500,
    );
    await writeHeartbeat(workDir, "acme", "active", 1, now - 30);

    // Three idle sessions newer than the active session.
    const idle1 = await makeSession(
      workDir,
      "acme",
      "idle1",
      "default",
      200,
      now - 400,
    );
    const idle2 = await makeSession(
      workDir,
      "acme",
      "idle2",
      "default",
      200,
      now - 300,
    );
    const idle3 = await makeSession(
      workDir,
      "acme",
      "idle3",
      "default",
      200,
      now - 200,
    );

    const result = await sweepAllSessions({
      workDir,
      maxSessionSizeBytes: 10 * 1024 * 1024,
      maxAgeDays: 365,
      maxCumulativeSizeBytes: 300, // much less than the 800-byte total
      nowFn: () => now,
    });

    // Active session must survive regardless of its age.
    assertEquals(await pathExists(activePath), true);
    // At least one idle removed under cumulative pressure, active ignored.
    const cumulativeRemovals = result.removed.filter((r) =>
      r.reason === "cumulative"
    );
    assert(cumulativeRemovals.length >= 1);
    for (const r of cumulativeRemovals) {
      assert(
        !r.path.includes("/active/"),
        "active session must not be removed",
      );
    }
    // Ensure we didn't accidentally leave everything in place.
    const remainingIdle = [idle1, idle2, idle3].filter((p) =>
      [idle1, idle2, idle3].indexOf(p) !== -1
    );
    assert(remainingIdle.length > 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ============================================================================
// Error handling
// ============================================================================

Deno.test("sweepAllSessions - unreadable workDir reports error without throwing", async () => {
  const result = await sweepAllSessions({
    workDir: "/nonexistent/path/that/cannot/be/read",
  });
  assertEquals(result.scanned, 0);
  // Missing `.claude-sessions/` is treated as "nothing to sweep", not an error.
  assertEquals(result.errors.length, 0);
});

Deno.test("sweepAllSessions - skips non-session entries at owner/repo level", async () => {
  const workDir = await makeTempWorkDir();
  try {
    const now = Math.floor(Date.now() / 1000);
    await makeSession(workDir, "a", "repo", "default", 10, now);
    // Stray file at .claude-sessions/ root — must not crash the sweep.
    await Deno.writeTextFile(
      `${workDir}/.claude-sessions/stray.txt`,
      "ignore me",
    );
    // Stray file at owner level.
    await Deno.writeTextFile(
      `${workDir}/.claude-sessions/a/stray.txt`,
      "ignore",
    );
    // Stray file at repo level (non-work-stream file).
    await Deno.writeTextFile(
      `${workDir}/.claude-sessions/a/repo/stray.txt`,
      "ignore",
    );

    const result = await sweepAllSessions({ workDir, nowFn: () => now });
    assertEquals(result.scanned, 1);
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// .claude-config transcript hygiene (Issue #4170)
// ---------------------------------------------------------------------------

Deno.test("session sweeper - ages out old .claude-config transcripts (Issue #4170)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "sweeper_cc_" });
  try {
    const projectDir = `${workDir}/.claude-config/projects/-work-VibeCoder`;
    await Deno.mkdir(projectDir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);

    const fresh = `${projectDir}/fresh-session.jsonl`;
    await Deno.writeTextFile(fresh, "x".repeat(100));
    const old = `${projectDir}/old-session.jsonl`;
    await Deno.writeTextFile(old, "x".repeat(100));
    const oldDate = new Date((now - 8 * 86400) * 1000);
    await Deno.utime(old, oldDate, oldDate);

    const result = await sweepAllSessions({
      workDir,
      maxAgeDays: 7,
      nowFn: () => now,
    });

    assertEquals(result.removed.length, 1);
    assertEquals(result.removed[0]!.path, old);
    assertEquals(result.removed[0]!.reason, "age");
    await Deno.stat(fresh);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("session sweeper - size-caps .claude-config transcripts oldest-first, sparing files under a day old (Issue #4170)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "sweeper_cc_" });
  try {
    const projectDir = `${workDir}/.claude-config/projects/-work-Repo`;
    await Deno.mkdir(projectDir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);

    // Three 40-byte transcripts against a 100-byte cap: total 120 > 100.
    const oldest = `${projectDir}/a.jsonl`;
    const middle = `${projectDir}/b.jsonl`;
    const newest = `${projectDir}/c.jsonl`;
    for (const path of [oldest, middle, newest]) {
      await Deno.writeTextFile(path, "x".repeat(40));
    }
    const set = async (path: string, ageDays: number) => {
      const d = new Date((now - ageDays * 86400) * 1000);
      await Deno.utime(path, d, d);
    };
    await set(oldest, 5);
    await set(middle, 3);
    await set(newest, 0); // under a day old — never size-swept

    const result = await sweepAllSessions({
      workDir,
      maxAgeDays: 7,
      maxSessionSizeBytes: 100,
      nowFn: () => now,
    });

    // Oldest goes first, bringing the total to 80 <= 100; the rest stay.
    assertEquals(result.removed.length, 1);
    assertEquals(result.removed[0]!.path, oldest);
    assertEquals(result.removed[0]!.reason, "size");
    await Deno.stat(middle);
    await Deno.stat(newest);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("session sweeper - a missing .claude-config is a clean no-op", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "sweeper_cc_" });
  try {
    const result = await sweepAllSessions({ workDir });
    assertEquals(result.removed.length, 0);
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => undefined);
  }
});
