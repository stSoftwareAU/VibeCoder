/**
 * Tests for worker_log_cleanup.ts — hybrid age/size retention policy for
 * worker-PID.log files.
 *
 * Issue #1902: count-based retention destroyed overnight diagnostics during
 * restart storms. Replaced with an age-based primary policy that preserves
 * large logs and aggressively prunes header-only stubs.
 */

import { assertEquals } from "@std/assert";
import {
  cleanupWorkerLogs,
  DEFAULT_HARD_CAP_COUNT,
  DEFAULT_HEADER_ONLY_MAX_BYTES,
  DEFAULT_HEADER_ONLY_MIN_AGE_MINUTES,
  DEFAULT_MAX_AGE_DAYS,
} from "../lib/worker_log_cleanup.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function writeLog(
  path: string,
  bytes: number,
  mtimeMs: number,
): Promise<void> {
  await Deno.writeFile(path, new Uint8Array(bytes));
  const mtime = new Date(mtimeMs);
  await Deno.utime(path, mtime, mtime);
}

Deno.test("cleanupWorkerLogs - keeps multi-KiB log created within last 24h after restart storm", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    // Yesterday's real overnight log: 6.9 KiB, 8 hours old
    const overnight = `${tmpDir}/worker-67319.log`;
    await writeLog(overnight, 6903, now - 8 * HOUR_MS);

    // Ten header-only stubs created in the last 5 minutes (the restart storm)
    for (
      const pid of [
        5185,
        6902,
        16817,
        18226,
        28698,
        40214,
        51391,
        83316,
        94416,
        99999,
      ]
    ) {
      await writeLog(`${tmpDir}/worker-${pid}.log`, 54, now - 60_000);
    }

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    // The overnight log MUST survive — it carries diagnostic value
    const overnightStat = await Deno.stat(overnight);
    assertEquals(overnightStat.isFile, true);
    assertEquals(result.deleted.includes(overnight), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - deletes header-only stubs older than 1 hour", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    // Header-only stub older than 1 hour — should be deleted
    const oldStub = `${tmpDir}/worker-100.log`;
    await writeLog(oldStub, 54, now - 90 * 60 * 1000);

    // Header-only stub younger than 1 hour — should be kept
    const freshStub = `${tmpDir}/worker-200.log`;
    await writeLog(freshStub, 54, now - 30 * 60 * 1000);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.deleted.includes(oldStub), true);
    assertEquals(result.deleted.includes(freshStub), false);

    let oldStubExists = true;
    try {
      await Deno.stat(oldStub);
    } catch {
      oldStubExists = false;
    }
    assertEquals(oldStubExists, false);

    const freshStubStat = await Deno.stat(freshStub);
    assertEquals(freshStubStat.isFile, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - deletes logs older than max age days even if large", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    const ancient = `${tmpDir}/worker-1.log`;
    await writeLog(ancient, 10_000, now - 5 * DAY_MS);

    const recent = `${tmpDir}/worker-2.log`;
    await writeLog(recent, 10_000, now - 2 * DAY_MS);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.deleted.includes(ancient), true);
    assertEquals(result.deleted.includes(recent), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - preserves header-only stub younger than min age", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    // Brand-new header-only log from the worker that's about to write to it
    const fresh = `${tmpDir}/worker-300.log`;
    await writeLog(fresh, 54, now - 1000);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.deleted.includes(fresh), false);
    const stat = await Deno.stat(fresh);
    assertEquals(stat.isFile, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - hard cap deletes oldest when count exceeds limit", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    // 5 large young logs, hard cap of 3 — oldest 2 must be deleted
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = `${tmpDir}/worker-${100 + i}.log`;
      // mtime increases with i — i=0 is oldest
      await writeLog(p, 5_000, now - (5 - i) * 60_000);
      paths.push(p);
    }

    const result = await cleanupWorkerLogs(tmpDir, {
      now: new Date(now),
      hardCapCount: 3,
    });

    // Oldest two (indices 0 and 1) must be deleted
    assertEquals(result.deleted.includes(paths[0]!), true);
    assertEquals(result.deleted.includes(paths[1]!), true);
    // Newest three must survive
    for (const p of paths.slice(2)) {
      let exists = true;
      try {
        await Deno.stat(p);
      } catch {
        exists = false;
      }
      assertEquals(exists, true, `${p} should still exist`);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - ignores non-worker log files", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    const other = `${tmpDir}/run_core.log`;
    await writeLog(other, 50, now - 10 * DAY_MS);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.deleted.includes(other), false);
    const stat = await Deno.stat(other);
    assertEquals(stat.isFile, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - returns zero deletions on missing directory", async () => {
  const result = await cleanupWorkerLogs("/tmp/does-not-exist-1902");
  assertEquals(result.deleted.length, 0);
});

Deno.test("cleanupWorkerLogs - defaults are documented and reasonable", () => {
  assertEquals(DEFAULT_HEADER_ONLY_MAX_BYTES, 200);
  assertEquals(DEFAULT_HEADER_ONLY_MIN_AGE_MINUTES, 60);
  assertEquals(DEFAULT_MAX_AGE_DAYS, 3);
  assertEquals(DEFAULT_HARD_CAP_COUNT, 200);
});

// --- Gzipped worker logs (Issue #4027) -------------------------------------

Deno.test("cleanupWorkerLogs - deletes gzipped logs older than max age days", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    const old = `${tmpDir}/worker-4001.log.gz`;
    await writeLog(old, 5000, now - 5 * DAY_MS);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.deleted, [old]);
    assertEquals(result.kept, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - keeps a young gzipped log", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    const young = `${tmpDir}/worker-4002.log.gz`;
    await writeLog(young, 5000, now - 2 * HOUR_MS);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.deleted, []);
    assertEquals(result.kept, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - a small gzipped log is not treated as a header-only stub", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    // A well-compressed multi-KiB log can shrink below the stub threshold —
    // the stub rule must not delete it before it reaches the age cap.
    const compressed = `${tmpDir}/worker-4003.log.gz`;
    await writeLog(compressed, 120, now - 6 * HOUR_MS);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.deleted, []);
    assertEquals(result.kept, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - hard cap counts plain and gzipped logs together", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    // Six young logs, alternating plain and gzipped, with a cap of 4.
    const paths: string[] = [];
    for (let i = 0; i < 6; i++) {
      const suffix = i % 2 === 0 ? ".log" : ".log.gz";
      const path = `${tmpDir}/worker-41${i}${suffix}`;
      await writeLog(path, 5000, now - (6 - i) * 60_000);
      paths.push(path);
    }

    const result = await cleanupWorkerLogs(tmpDir, {
      now: new Date(now),
      hardCapCount: 4,
    });

    // The two oldest go, regardless of which form they are in.
    assertEquals(result.deleted.sort(), [paths[0], paths[1]].sort());
    assertEquals(result.kept, 4);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - ignores gzip temporary files", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    const partial = `${tmpDir}/worker-4200.log.gz.tmp`;
    await writeLog(partial, 5000, now - 5 * DAY_MS);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.deleted, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - ages out agent transcripts with the worker logs (Issue #4169)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    // Fresh, meaty transcript: survives.
    const fresh = `${tmpDir}/agent-vibe-abc123-def456-4169.jsonl`;
    await writeLog(fresh, 4096, now - 2 * HOUR_MS);
    // Old transcript, rotated backup, and gzipped rotation: all age out.
    const old = `${tmpDir}/agent-vibe-old111-222222-7.jsonl`;
    await writeLog(old, 4096, now - (DEFAULT_MAX_AGE_DAYS + 1) * DAY_MS);
    const rotated = `${tmpDir}/agent-vibe-old111-222222-7.jsonl.2`;
    await writeLog(rotated, 4096, now - (DEFAULT_MAX_AGE_DAYS + 1) * DAY_MS);
    const gzipped = `${tmpDir}/agent-vibe-old111-222222-7.jsonl.gz`;
    await writeLog(gzipped, 512, now - (DEFAULT_MAX_AGE_DAYS + 1) * DAY_MS);
    // Unrelated jsonl (self-heal events): never touched.
    const unrelated = `${tmpDir}/self-heal.jsonl`;
    await writeLog(unrelated, 64, now - (DEFAULT_MAX_AGE_DAYS + 5) * DAY_MS);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.deleted.sort(), [gzipped, old, rotated].sort());
    await Deno.stat(fresh);
    await Deno.stat(unrelated);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Foreign-file pass (Issue #4306)
// ---------------------------------------------------------------------------

Deno.test("cleanupWorkerLogs - ages out foreign debris files, preserves fresh and non-file entries (Issue #4306)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    // 748 node-*.log / stage-*.state orphans observed live: foreign files
    // no live pattern matches, parked in ~/logs forever.
    const oldDebris = `${tmpDir}/node-10022.log`;
    await writeLog(oldDebris, 5088, now - 20 * DAY_MS);
    const oldState = `${tmpDir}/stage-10022.state`;
    await writeLog(oldState, 12, now - 20 * DAY_MS);
    // Fresh foreign files stay — they may belong to a live subsystem.
    const freshForeign = `${tmpDir}/run_core.log`;
    await writeLog(freshForeign, 4096, now - 2 * HOUR_MS);
    // Old-but-recognised worker logs are the existing passes' business —
    // they age out under the 3-day rule, not the foreign rule.
    const workerLog = `${tmpDir}/worker-123.log`;
    await writeLog(workerLog, 4096, now - 1 * DAY_MS);
    // Directories and symlinks are never touched.
    await Deno.mkdir(`${tmpDir}/subdir`);
    await Deno.symlink(workerLog, `${tmpDir}/worker.log`);

    const result = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });

    assertEquals(result.foreignDeleted?.sort(), [oldDebris, oldState].sort());
    await Deno.stat(freshForeign);
    await Deno.stat(workerLog);
    await Deno.stat(`${tmpDir}/subdir`);
    await Deno.lstat(`${tmpDir}/worker.log`);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("cleanupWorkerLogs - foreign age cap is configurable (Issue #4306)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const now = Date.now();
  try {
    const debris = `${tmpDir}/stage-99.state`;
    await writeLog(debris, 12, now - 3 * DAY_MS);

    const kept = await cleanupWorkerLogs(tmpDir, { now: new Date(now) });
    assertEquals(kept.foreignDeleted ?? [], []);

    const swept = await cleanupWorkerLogs(tmpDir, {
      now: new Date(now),
      foreignFileMaxAgeDays: 2,
    });
    assertEquals(swept.foreignDeleted, [debris]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
