/**
 * Tests for worker_log_gzip.ts — start-of-run compression of prior worker logs
 * (Issue #4027).
 *
 * Australian English spelling throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_MIN_COMPRESS_BYTES,
  gzipOldWorkerLogs,
} from "../lib/worker_log_gzip.ts";

/** Never treat any PID as live — the common case for prior-run logs. */
const noneRunning = (_pid: number) => Promise.resolve(false);

/** Write a log file of `size` bytes with a known mtime. */
async function writeLog(
  dir: string,
  name: string,
  size: number,
  mtime: Date,
): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, "x".repeat(size));
  await Deno.utime(path, mtime, mtime);
  return path;
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Decompress a `.gz` file back to text. */
async function gunzip(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  const stream = file.readable.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

Deno.test("gzipOldWorkerLogs - compresses a prior run's log and removes the original", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gzip-logs-" });
  try {
    const body = "diagnostic line\n".repeat(500);
    const path = `${dir}/worker-111.log`;
    await Deno.writeTextFile(path, body);

    const result = await gzipOldWorkerLogs(dir, {
      currentLogFile: "worker-999.log",
      isRunning: noneRunning,
    });

    assertEquals(result.compressed, [`${dir}/worker-111.log.gz`]);
    assertEquals(result.failures, []);
    // Original replaced by the gzip; content recoverable with zcat/gunzip.
    assertEquals(await gunzip(`${dir}/worker-111.log.gz`), body);
    await assertMissing(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gzipOldWorkerLogs - leaves the current run's log as plain text", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gzip-logs-" });
  try {
    const current = await writeLog(dir, "worker-4242.log", 5000, new Date());

    const result = await gzipOldWorkerLogs(dir, {
      currentLogFile: "worker-4242.log",
      isRunning: noneRunning,
    });

    assertEquals(result.compressed, []);
    assertEquals((await Deno.stat(current)).isFile, true);
    await assertMissing(`${current}.gz`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gzipOldWorkerLogs - skips logs owned by a live process", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gzip-logs-" });
  try {
    await writeLog(dir, "worker-555.log", 5000, new Date());
    await writeLog(dir, "worker-556.log", 5000, new Date());

    const result = await gzipOldWorkerLogs(dir, {
      currentLogFile: "worker-999.log",
      isRunning: (pid) => Promise.resolve(pid === 555),
    });

    assertEquals(result.compressed, [`${dir}/worker-556.log.gz`]);
    assertEquals((await Deno.stat(`${dir}/worker-555.log`)).isFile, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gzipOldWorkerLogs - skips header-only stubs below the size floor", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gzip-logs-" });
  try {
    const stub = await writeLog(dir, "worker-777.log", 74, new Date());

    const result = await gzipOldWorkerLogs(dir, {
      currentLogFile: "worker-999.log",
      isRunning: noneRunning,
    });

    assertEquals(result.compressed, []);
    assert(result.skipped >= 1);
    assertEquals((await Deno.stat(stub)).isFile, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gzipOldWorkerLogs - honours a custom size floor", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gzip-logs-" });
  try {
    await writeLog(dir, "worker-778.log", 74, new Date());

    const result = await gzipOldWorkerLogs(dir, {
      currentLogFile: "worker-999.log",
      minCompressBytes: 10,
      isRunning: noneRunning,
    });

    assertEquals(result.compressed, [`${dir}/worker-778.log.gz`]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gzipOldWorkerLogs - preserves the original modification time", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gzip-logs-" });
  try {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await writeLog(dir, "worker-888.log", 4000, old);

    await gzipOldWorkerLogs(dir, {
      currentLogFile: "worker-999.log",
      isRunning: noneRunning,
    });

    const stat = await Deno.stat(`${dir}/worker-888.log.gz`);
    const drift = Math.abs((stat.mtime?.getTime() ?? 0) - old.getTime());
    // Age-based retention must count from the last write, not the compression.
    assert(drift < 2000, `mtime drifted by ${drift}ms`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gzipOldWorkerLogs - ignores non-worker files and already-gzipped logs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gzip-logs-" });
  try {
    await writeLog(dir, "run_core.log", 5000, new Date());
    await writeLog(dir, "pull.log.1", 5000, new Date());
    await writeLog(dir, "worker-222.log.gz", 5000, new Date());

    const result = await gzipOldWorkerLogs(dir, {
      currentLogFile: "worker-999.log",
      isRunning: noneRunning,
    });

    assertEquals(result.compressed, []);
    await assertMissing(`${dir}/run_core.log.gz`);
    await assertMissing(`${dir}/worker-222.log.gz.gz`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gzipOldWorkerLogs - reports a compression failure loudly and keeps the original", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gzip-logs-" });
  try {
    const path = await writeLog(dir, "worker-333.log", 5000, new Date());
    // A non-empty directory at the destination makes the final rename fail.
    await Deno.mkdir(`${dir}/worker-333.log.gz`);
    await Deno.writeTextFile(`${dir}/worker-333.log.gz/blocker`, "x");

    const result = await gzipOldWorkerLogs(dir, {
      currentLogFile: "worker-999.log",
      isRunning: noneRunning,
    });

    assertEquals(result.compressed, []);
    assertEquals(result.failures.length, 1);
    assertEquals(result.failures[0]?.path, path);
    assert(result.failures[0]!.error.length > 0);
    assertStringIncludes(result.message, "failed");
    // The source log survives a failed compression — no data loss.
    assertEquals((await Deno.stat(path)).isFile, true);
    // No temporary artefact left behind.
    await assertMissing(`${path}.gz.tmp`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gzipOldWorkerLogs - returns an empty result for a missing directory", async () => {
  const result = await gzipOldWorkerLogs("/tmp/does-not-exist-4027", {
    currentLogFile: "worker-1.log",
    isRunning: noneRunning,
  });

  assertEquals(result.compressed, []);
  assertEquals(result.failures, []);
  assertStringIncludes(result.message, "unreadable");
});

Deno.test("gzipOldWorkerLogs - default size floor matches the stub threshold", () => {
  assertEquals(DEFAULT_MIN_COMPRESS_BYTES, 200);
});

/** Assert a path does not exist. */
async function assertMissing(path: string): Promise<void> {
  let exists = true;
  try {
    await Deno.stat(path);
  } catch {
    exists = false;
  }
  assertEquals(exists, false, `expected ${path} to be absent`);
}

Deno.test("gzipOldWorkerLogs - container era: the eternal worker-1.log finally compresses (Issue #4227)", async () => {
  // In container mode every run was PID 1, so the PID-keyed exclusion
  // exempted the one accumulating file that most needed compressing. Keyed
  // on the current FILE, the legacy log compresses and the timestamp-named
  // current log stays plain.
  const dir = await Deno.makeTempDir({ prefix: "gzip4227_" });
  try {
    await Deno.writeTextFile(`${dir}/worker-1.log`, "x".repeat(500));
    await Deno.writeTextFile(
      `${dir}/worker-20260817-021352.log`,
      "y".repeat(500),
    );
    const result = await gzipOldWorkerLogs(dir, {
      currentLogFile: `${dir}/worker-20260817-021352.log`,
      isRunning: noneRunning,
    });
    assertEquals(result.compressed, [`${dir}/worker-1.log.gz`]);
    assertEquals(await exists(`${dir}/worker-20260817-021352.log`), true);
    assertEquals(await exists(`${dir}/worker-20260817-021352.log.gz`), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
