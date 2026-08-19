/**
 * Tests for the per-host scan cursor (Issue #2427).
 *
 * Exercises the real functions against a temp WORK_DIR: atomic write, read,
 * staleness guard, reset-on-claim, per-host filename, and corrupt-file
 * tolerance.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CURSOR_STALENESS_SECONDS,
  isCursorFresh,
  readScanCursor,
  resetScanCursor,
  resolveStartPriority,
  type ScanCursor,
  scanCursorPath,
  writeScanCursor,
} from "../lib/scan_cursor.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "scan_cursor_test_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("scanCursorPath - embeds the hostname, not the pid", () => {
  const path = scanCursorPath("/work", "host-a");
  assertEquals(path, "/work/scan_cursor_host-a.json");
});

Deno.test("scanCursorPath - sanitises unsafe characters so the file stays in workDir", () => {
  const path = scanCursorPath("/work", "evil/../host name");
  // No slashes or spaces survive — the file cannot escape workDir.
  assertEquals(path, "/work/scan_cursor_evil_.._host_name.json");
  assert(!path.slice("/work/".length).includes("/"));
});

Deno.test("scanCursorPath - per-host filenames differ so two hosts never collide", () => {
  assert(
    scanCursorPath("/work", "host-a") !== scanCursorPath("/work", "host-b"),
  );
});

Deno.test("writeScanCursor + readScanCursor - round-trips the snapshot", async () => {
  await withTempDir(async (dir) => {
    const path = scanCursorPath(dir, "host-a");
    const write = await writeScanCursor(
      path,
      { priority: 2, repoIndex: 4 },
      () => 1000,
    );
    assert(write.ok);

    const cursor = await readScanCursor(path);
    assertEquals(cursor, { priority: 2, repoIndex: 4, savedAt: 1000 });
  });
});

Deno.test("writeScanCursor - stamps savedAt from the injected clock", async () => {
  await withTempDir(async (dir) => {
    const path = scanCursorPath(dir, "host-a");
    await writeScanCursor(path, { priority: 1.55, repoIndex: 0 }, () => 555);
    const cursor = await readScanCursor(path);
    assertEquals(cursor?.savedAt, 555);
  });
});

Deno.test("writeScanCursor - produces a small file (< 200 bytes)", async () => {
  await withTempDir(async (dir) => {
    const path = scanCursorPath(dir, "host-a");
    await writeScanCursor(
      path,
      { priority: 1.85, repoIndex: 99 },
      () => 1234567890,
    );
    const stat = await Deno.stat(path);
    assert(stat.size < 200, `cursor file too large: ${stat.size} bytes`);
  });
});

Deno.test("readScanCursor - returns null when the file is missing", async () => {
  await withTempDir(async (dir) => {
    const cursor = await readScanCursor(scanCursorPath(dir, "absent"));
    assertEquals(cursor, null);
  });
});

Deno.test("readScanCursor - returns null on truncated/corrupt JSON", async () => {
  await withTempDir(async (dir) => {
    const path = scanCursorPath(dir, "host-a");
    // Simulate a crash mid-write leaving a truncated file.
    await Deno.writeTextFile(path, '{"priority": 2, "repoInde');
    assertEquals(await readScanCursor(path), null);
  });
});

Deno.test("readScanCursor - returns null when a required field is the wrong type", async () => {
  await withTempDir(async (dir) => {
    const path = scanCursorPath(dir, "host-a");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ priority: "2", repoIndex: 0, savedAt: 1 }),
    );
    assertEquals(await readScanCursor(path), null);
  });
});

Deno.test("isCursorFresh - fresh below the staleness window, stale at or beyond", () => {
  const cursor: ScanCursor = { priority: 2, repoIndex: 0, savedAt: 1000 };
  // 59s old → fresh.
  assert(isCursorFresh(cursor, 1059));
  // Exactly 60s old → stale (not < 60).
  assertEquals(isCursorFresh(cursor, 1060), false);
  // 61s old → stale.
  assertEquals(isCursorFresh(cursor, 1061), false);
});

Deno.test("isCursorFresh - a future-stamped cursor is treated as fresh", () => {
  const cursor: ScanCursor = { priority: 2, repoIndex: 0, savedAt: 2000 };
  assert(isCursorFresh(cursor, 1000));
});

Deno.test("resolveStartPriority - resumes from a fresh cursor's priority", () => {
  const cursor: ScanCursor = { priority: 1.65, repoIndex: 3, savedAt: 1000 };
  assertEquals(resolveStartPriority(cursor, 1030), 1.65);
});

Deno.test("resolveStartPriority - a stale cursor is ignored (starts at Priority 1)", () => {
  const cursor: ScanCursor = { priority: 1.65, repoIndex: 3, savedAt: 1000 };
  assertEquals(
    resolveStartPriority(cursor, 1000 + CURSOR_STALENESS_SECONDS + 1),
    1,
  );
});

Deno.test("resolveStartPriority - a missing cursor starts at Priority 1", () => {
  assertEquals(resolveStartPriority(null, 1000), 1);
});

Deno.test("resetScanCursor - writes the start-of-cycle position", async () => {
  await withTempDir(async (dir) => {
    const path = scanCursorPath(dir, "host-a");
    await writeScanCursor(path, { priority: 2, repoIndex: 7 }, () => 1000);
    const reset = await resetScanCursor(path, () => 2000);
    assert(reset.ok);

    const cursor = await readScanCursor(path);
    assertEquals(cursor, { priority: 1, repoIndex: 0, savedAt: 2000 });
  });
});

Deno.test("writeScanCursor - overwrites a prior cursor atomically", async () => {
  await withTempDir(async (dir) => {
    const path = scanCursorPath(dir, "host-a");
    await writeScanCursor(path, { priority: 1, repoIndex: 0 }, () => 1000);
    await writeScanCursor(path, { priority: 1.9, repoIndex: 2 }, () => 1010);
    // No leftover temp file beside the live cursor.
    const entries: string[] = [];
    for await (const e of Deno.readDir(dir)) entries.push(e.name);
    assertEquals(entries.filter((n) => n.endsWith(".json")).length, 1);
    assertEquals(entries.some((n) => n.includes(".tmp.")), false);

    const cursor = await readScanCursor(path);
    assertEquals(cursor, { priority: 1.9, repoIndex: 2, savedAt: 1010 });
  });
});
