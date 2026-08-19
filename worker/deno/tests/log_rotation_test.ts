/**
 * Tests for log_rotation.ts — size-based log rotation utilities.
 *
 * Issue #902: Migrate log_rotation.sh to Deno TypeScript.
 */

import { assertEquals } from "@std/assert";
import {
  checkAndRotateLog,
  DEFAULT_LOG_MAX_ROTATIONS,
  DEFAULT_LOG_MAX_SIZE_MB,
  getFileSizeBytes,
  rotateAllLogs,
  rotateLogFile,
} from "../lib/log_rotation.ts";

// =============================================================================
// getFileSizeBytes tests
// =============================================================================

Deno.test("log_rotation - getFileSizeBytes returns correct size", async () => {
  const tmpDir = await Deno.makeTempDir();
  const filePath = `${tmpDir}/sized.log`;
  // Write exactly 5120 bytes
  const data = new Uint8Array(5120);
  await Deno.writeFile(filePath, data);

  try {
    const size = await getFileSizeBytes(filePath);
    assertEquals(size, 5120);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - getFileSizeBytes returns 0 for non-existent file", async () => {
  const size = await getFileSizeBytes("/tmp/nonexistent-test-902.log");
  assertEquals(size, 0);
});

// =============================================================================
// rotateLogFile tests
// =============================================================================

Deno.test("log_rotation - rotateLogFile rotates a file that exists", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testLog = `${tmpDir}/app.log`;
  await Deno.writeTextFile(testLog, "some log content");

  try {
    await rotateLogFile(testLog, 3);

    const rotatedContent = await Deno.readTextFile(`${testLog}.1`);
    assertEquals(rotatedContent, "some log content");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateLogFile shifts existing rotated files", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testLog = `${tmpDir}/app.log`;
  await Deno.writeTextFile(testLog, "content-current");
  await Deno.writeTextFile(`${testLog}.1`, "content-1");
  await Deno.writeTextFile(`${testLog}.2`, "content-2");

  try {
    await rotateLogFile(testLog, 3);

    const content1 = await Deno.readTextFile(`${testLog}.1`);
    assertEquals(content1, "content-current");

    const content2 = await Deno.readTextFile(`${testLog}.2`);
    assertEquals(content2, "content-1");

    const content3 = await Deno.readTextFile(`${testLog}.3`);
    assertEquals(content3, "content-2");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateLogFile deletes files beyond max rotations", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testLog = `${tmpDir}/app.log`;
  await Deno.writeTextFile(testLog, "current");
  await Deno.writeTextFile(`${testLog}.1`, "rot-1");
  await Deno.writeTextFile(`${testLog}.2`, "rot-2");
  await Deno.writeTextFile(`${testLog}.3`, "rot-3");

  try {
    await rotateLogFile(testLog, 3);

    // .1, .2, .3 should exist; .4 should NOT
    assertEquals(await fileExists(`${testLog}.1`), true);
    assertEquals(await fileExists(`${testLog}.2`), true);
    assertEquals(await fileExists(`${testLog}.3`), true);
    assertEquals(await fileExists(`${testLog}.4`), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateLogFile with maxRotations=1 keeps only one backup", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testLog = `${tmpDir}/app.log`;
  await Deno.writeTextFile(testLog, "current");
  await Deno.writeTextFile(`${testLog}.1`, "old-backup");

  try {
    await rotateLogFile(testLog, 1);

    const content1 = await Deno.readTextFile(`${testLog}.1`);
    assertEquals(content1, "current");
    assertEquals(await fileExists(`${testLog}.2`), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateLogFile does nothing for non-existent file", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await rotateLogFile(`${tmpDir}/nonexistent.log`, 3);
    assertEquals(await fileExists(`${tmpDir}/nonexistent.log.1`), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateLogFile handles empty file", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testLog = `${tmpDir}/empty.log`;
  await Deno.writeTextFile(testLog, "");

  try {
    await rotateLogFile(testLog, 3);
    assertEquals(await fileExists(`${testLog}.1`), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// checkAndRotateLog tests
// =============================================================================

Deno.test("log_rotation - checkAndRotateLog skips file under threshold", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testLog = `${tmpDir}/small.log`;
  await Deno.writeTextFile(testLog, "tiny content");

  try {
    const rotated = await checkAndRotateLog(testLog, 1024 * 1024, 3);
    assertEquals(rotated, false);
    assertEquals(await fileExists(`${testLog}.1`), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - checkAndRotateLog rotates file over threshold", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testLog = `${tmpDir}/big.log`;
  // Create a file of 2048 bytes
  await Deno.writeFile(testLog, new Uint8Array(2048));

  try {
    const rotated = await checkAndRotateLog(testLog, 1024, 3);
    assertEquals(rotated, true);
    assertEquals(await fileExists(`${testLog}.1`), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// rotateAllLogs tests
// =============================================================================

Deno.test("log_rotation - rotateAllLogs processes multiple log files", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logDir = `${tmpDir}/logs`;
  await Deno.mkdir(logDir, { recursive: true });

  // Create two log files over threshold (using bytes-level options)
  await Deno.writeFile(`${logDir}/run_core.log`, new Uint8Array(2048));
  await Deno.writeFile(`${logDir}/pull.log`, new Uint8Array(2048));

  try {
    // maxSizeMb of 0 will cause 0 bytes threshold — but we need > 0 to trigger
    // Use a very small maxSizeMb to ensure files are above threshold
    // 2048 bytes > 0.001 MB * 1024 * 1024 = 1048 bytes
    const result = await rotateAllLogs(logDir, {
      maxSizeMb: 0.001,
      maxRotations: 3,
    });
    assertEquals(result.rotatedCount, 2);
    assertEquals(await fileExists(`${logDir}/run_core.log.1`), true);
    assertEquals(await fileExists(`${logDir}/pull.log.1`), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateAllLogs skips worker-PID log files", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logDir = `${tmpDir}/logs`;
  await Deno.mkdir(logDir, { recursive: true });

  await Deno.writeFile(`${logDir}/worker-12345.log`, new Uint8Array(2048));
  await Deno.writeFile(`${logDir}/run_core.log`, new Uint8Array(2048));

  try {
    const result = await rotateAllLogs(logDir, {
      maxSizeMb: 0.001,
      maxRotations: 3,
    });
    // worker-PID log should NOT be rotated
    assertEquals(await fileExists(`${logDir}/worker-12345.log.1`), false);
    // run_core.log should be rotated
    assertEquals(await fileExists(`${logDir}/run_core.log.1`), true);
    assertEquals(result.rotatedCount, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateAllLogs skips symlinks", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logDir = `${tmpDir}/logs`;
  await Deno.mkdir(logDir, { recursive: true });

  // Create a real file and a symlink
  await Deno.writeFile(`${logDir}/worker-99.log`, new Uint8Array(2048));
  await Deno.symlink(`${logDir}/worker-99.log`, `${logDir}/worker.log`);
  await Deno.writeFile(`${logDir}/run_core.log`, new Uint8Array(2048));

  try {
    await rotateAllLogs(logDir, { maxSizeMb: 0.001, maxRotations: 3 });
    // Symlink should not be rotated
    assertEquals(await fileExists(`${logDir}/worker.log.1`), false);
    // run_core.log should be rotated
    assertEquals(await fileExists(`${logDir}/run_core.log.1`), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateAllLogs does not rotate small files", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logDir = `${tmpDir}/logs`;
  await Deno.mkdir(logDir, { recursive: true });

  await Deno.writeTextFile(`${logDir}/small.log`, "small");
  await Deno.writeFile(`${logDir}/large.log`, new Uint8Array(2048));

  try {
    await rotateAllLogs(logDir, { maxSizeMb: 0.001, maxRotations: 3 });
    assertEquals(await fileExists(`${logDir}/small.log.1`), false);
    assertEquals(await fileExists(`${logDir}/large.log.1`), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateAllLogs handles empty directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  const logDir = `${tmpDir}/empty_logs`;
  await Deno.mkdir(logDir, { recursive: true });

  try {
    const result = await rotateAllLogs(logDir);
    assertEquals(result.rotatedCount, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("log_rotation - rotateAllLogs handles non-existent directory", async () => {
  const result = await rotateAllLogs("/tmp/no_such_dir_test_902");
  assertEquals(result.rotatedCount, 0);
});

// =============================================================================
// Default constants tests
// =============================================================================

Deno.test("log_rotation - DEFAULT_LOG_MAX_SIZE_MB is 10", () => {
  assertEquals(DEFAULT_LOG_MAX_SIZE_MB, 10);
});

Deno.test("log_rotation - DEFAULT_LOG_MAX_ROTATIONS is 3", () => {
  assertEquals(DEFAULT_LOG_MAX_ROTATIONS, 3);
});

// =============================================================================
// Helper
// =============================================================================

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
