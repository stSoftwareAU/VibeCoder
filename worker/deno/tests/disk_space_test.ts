/**
 * Tests for disk_space.ts — disk space management utilities.
 *
 * Issue #902: Migrate disk_space.sh to Deno TypeScript.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkAndCleanupDiskSpace,
  checkDiskSpaceAvailable,
  DEFAULT_DISK_CLEANUP_THRESHOLD,
  type DfRunner,
  getDiskAvailableKB,
  getDiskUsagePercent,
  nukeWorkDir,
} from "../lib/disk_space.ts";
import type { Result } from "../types.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";
import { resetFaultCounters } from "../lib/fault_tolerance_counters.ts";

// =============================================================================
// getDiskAvailableKB tests (Issue #3042 — exercise the real df -Pk parsing)
// =============================================================================

/** Build a fake DfRunner that returns the given df stdout as a success. */
function fakeRunDfReturning(stdout: string): DfRunner {
  return () =>
    Promise.resolve<Result<SubprocessResult>>({
      ok: true,
      value: { success: true, code: 0, stdout, stderr: "", timedOut: false },
    });
}

/** Build a fake DfRunner that reports a timeout. */
function fakeRunDfTimingOut(): DfRunner {
  return () =>
    Promise.resolve<Result<SubprocessResult>>({
      ok: true,
      value: {
        success: false,
        code: 124,
        stdout: "",
        stderr: "Timed out",
        timedOut: true,
      },
    });
}

/** Build a fake DfRunner that reports a non-zero exit. */
function fakeRunDfFailing(): DfRunner {
  return () =>
    Promise.resolve<Result<SubprocessResult>>({
      ok: true,
      value: {
        success: false,
        code: 1,
        stdout: "",
        stderr: "df: error",
        timedOut: false,
      },
    });
}

const DF_HEADER = "Filesystem 1024-blocks Used Available Capacity Mounted";

Deno.test("disk_space - getDiskAvailableKB parses well-formed df -Pk output", async () => {
  const out = `${DF_HEADER}\n/dev/disk1 100 40 60 40% /`;
  assertEquals(await getDiskAvailableKB("/", fakeRunDfReturning(out)), 60);
});

Deno.test("disk_space - getDiskAvailableKB handles irregular whitespace", async () => {
  // Leading spaces and tab/multi-space separators must still parse field 3.
  const out = `${DF_HEADER}\n   /dev/disk1\t204800   102400\t98304  50%  /`;
  assertEquals(await getDiskAvailableKB("/", fakeRunDfReturning(out)), 98304);
});

Deno.test("disk_space - getDiskAvailableKB returns null on timeout", async () => {
  assertEquals(await getDiskAvailableKB("/", fakeRunDfTimingOut()), null);
});

Deno.test("disk_space - getDiskAvailableKB returns null on non-zero exit", async () => {
  assertEquals(await getDiskAvailableKB("/", fakeRunDfFailing()), null);
});

Deno.test("disk_space - getDiskAvailableKB returns null when runner errors", async () => {
  const run: DfRunner = () =>
    Promise.resolve<Result<SubprocessResult>>({
      ok: false,
      error: new Error("spawn failed"),
    });
  assertEquals(await getDiskAvailableKB("/", run), null);
});

Deno.test("disk_space - getDiskAvailableKB returns null when only header present", async () => {
  assertEquals(
    await getDiskAvailableKB("/", fakeRunDfReturning(DF_HEADER)),
    null,
  );
});

Deno.test("disk_space - getDiskAvailableKB returns null when available field is non-numeric", async () => {
  const out = `${DF_HEADER}\n/dev/disk1 100 40 - 40% /`;
  assertEquals(await getDiskAvailableKB("/", fakeRunDfReturning(out)), null);
});

Deno.test("disk_space - getDiskAvailableKB returns null when available field is missing", async () => {
  // Data line truncated before the Available column (only 3 fields).
  const out = `${DF_HEADER}\n/dev/disk1 100 40`;
  assertEquals(await getDiskAvailableKB("/", fakeRunDfReturning(out)), null);
});

Deno.test("disk_space - getDiskAvailableKB real probe returns number or null", async () => {
  // Smoke test against the real df on the host (no injection).
  const result = await getDiskAvailableKB("/tmp");
  if (result !== null) {
    assertEquals(typeof result, "number");
    assertEquals(result >= 0, true);
  }
});

// =============================================================================
// getDiskUsagePercent tests
// =============================================================================

Deno.test("disk_space - getDiskUsagePercent returns a number for valid path", async () => {
  const result = await getDiskUsagePercent("/tmp");
  // Should return a valid number (or null on unusual systems)
  if (result !== null) {
    assertEquals(typeof result, "number");
    assertEquals(result >= 0, true);
    assertEquals(result <= 100, true);
  }
});

Deno.test("disk_space - getDiskUsagePercent works with home directory", async () => {
  const home = Deno.env.get("HOME") ?? "/tmp";
  const result = await getDiskUsagePercent(home);
  if (result !== null) {
    assertEquals(typeof result, "number");
    assertEquals(result >= 0, true);
    assertEquals(result <= 100, true);
  }
});

Deno.test("disk_space - getDiskUsagePercent handles non-existent path by using parent", async () => {
  const result = await getDiskUsagePercent("/tmp/nonexistent-path-test-902");
  if (result !== null) {
    assertEquals(typeof result, "number");
    assertEquals(result >= 0, true);
  }
});

Deno.test("disk_space - DEFAULT_DISK_CLEANUP_THRESHOLD is 90", () => {
  assertEquals(DEFAULT_DISK_CLEANUP_THRESHOLD, 90);
});

// =============================================================================
// checkAndCleanupDiskSpace tests
// =============================================================================

Deno.test("disk_space - checkAndCleanupDiskSpace returns error for empty workDir", async () => {
  const result = await checkAndCleanupDiskSpace({ workDir: "" });
  assertEquals(result.cleanedUp, false);
  assertStringIncludes(result.message, "ERROR");
});

Deno.test("disk_space - checkAndCleanupDiskSpace ensures directory exists below threshold", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;

  try {
    // Disk usage for /tmp is almost certainly below 90%
    const result = await checkAndCleanupDiskSpace({ workDir, threshold: 99 });
    assertEquals(result.cleanedUp, false);
    // Directory should have been created
    const stat = await Deno.stat(workDir);
    assertEquals(stat.isDirectory, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("disk_space - checkAndCleanupDiskSpace cleans up at threshold", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });
  await Deno.writeTextFile(`${workDir}/important_file.txt`, "test data");

  try {
    // Use threshold of 0 to guarantee cleanup happens. skipDenoCache to
    // keep the test hermetic — we exercise Deno cache wiring in the
    // dedicated Issue #1489 test below.
    const result = await checkAndCleanupDiskSpace({
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise engage the Issue #4164 guard.
      env: () => undefined,
      workDir,
      threshold: 0,
      skipDenoCache: true,
    });
    assertEquals(result.cleanedUp, true);
    assertStringIncludes(result.message, "WARNING");

    // Directory should exist but file should be gone
    const stat = await Deno.stat(workDir);
    assertEquals(stat.isDirectory, true);

    let fileExists = true;
    try {
      await Deno.stat(`${workDir}/important_file.txt`);
    } catch {
      fileExists = false;
    }
    assertEquals(fileExists, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    resetFaultCounters();
  }
});

// Issue #1489: when the threshold is exceeded, the Deno download cache
// should also be considered for cleanup. We use skipDenoCache=true to
// suppress the real `deno clean` call, then verify the result fields.
Deno.test("disk_space - checkAndCleanupDiskSpace exposes denoCacheCleaned field (Issue #1489)", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });

  try {
    const skipped = await checkAndCleanupDiskSpace({
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise engage the Issue #4164 guard.
      env: () => undefined,
      workDir,
      threshold: 0,
      skipDenoCache: true,
    });
    assertEquals(skipped.cleanedUp, true);
    assertEquals(skipped.denoCacheCleaned, false);
    // The message should not claim the Deno cache was touched when skipped.
    assertEquals(skipped.message.includes("Deno cache cleanup"), false);

    // Below threshold: denoCacheCleaned must be false (no cleanup).
    const ok = await checkAndCleanupDiskSpace({ workDir, threshold: 100 });
    assertEquals(ok.cleanedUp, false);
    assertEquals(ok.denoCacheCleaned, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    resetFaultCounters();
  }
});

Deno.test("disk_space - checkAndCleanupDiskSpace does not clean below threshold", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });
  await Deno.writeTextFile(`${workDir}/keep_me.txt`, "data");

  try {
    // Use threshold of 100 to guarantee no cleanup
    const result = await checkAndCleanupDiskSpace({ workDir, threshold: 100 });
    assertEquals(result.cleanedUp, false);

    // File should still exist
    const content = await Deno.readTextFile(`${workDir}/keep_me.txt`);
    assertEquals(content, "data");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("disk_space - checkAndCleanupDiskSpace handles non-existent directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/nonexistent`;

  try {
    const result = await checkAndCleanupDiskSpace({ workDir, threshold: 100 });
    assertEquals(result.cleanedUp, false);
    // Directory should have been created
    const stat = await Deno.stat(workDir);
    assertEquals(stat.isDirectory, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("disk_space - checkAndCleanupDiskSpace result has correct fields", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;

  try {
    const result = await checkAndCleanupDiskSpace({ workDir, threshold: 100 });
    assertEquals(typeof result.usagePercent, "number");
    assertEquals(typeof result.threshold, "number");
    assertEquals(typeof result.cleanedUp, "boolean");
    assertEquals(typeof result.message, "string");
    assertEquals(result.threshold, 100);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// Disk space pre-check tests (Issue #1168)
// NOTE: DEFAULT_MIN_FREE_SPACE_MB constant test lives in
// disk_space_git_precheck_test.ts (Issue #1308).
// =============================================================================

Deno.test("disk_space - checkDiskSpaceAvailable returns result for valid path", async () => {
  const result = await checkDiskSpaceAvailable("/tmp");
  assertEquals(typeof result.availableMB, "number");
  assertEquals(typeof result.requiredMB, "number");
  assertEquals(typeof result.sufficient, "boolean");
  assertEquals(typeof result.message, "string");
});

Deno.test("disk_space - checkDiskSpaceAvailable with low threshold passes", async () => {
  // Require only 1 MB — should always pass
  const result = await checkDiskSpaceAvailable("/tmp", 1);
  assertEquals(result.sufficient, true);
  assertEquals(result.requiredMB, 1);
});

Deno.test("disk_space - checkDiskSpaceAvailable with impossibly high threshold fails", async () => {
  resetFaultCounters();
  // Require 10 TB — should fail on any normal system
  const result = await checkDiskSpaceAvailable("/tmp", 10_000_000);
  assertEquals(result.sufficient, false);
  assertEquals(result.requiredMB, 10_000_000);
  resetFaultCounters();
});

Deno.test("disk_space - checkDiskSpaceAvailable handles non-existent path", async () => {
  const result = await checkDiskSpaceAvailable(
    "/tmp/nonexistent-disk-check-1168",
  );
  // Should still work by walking up to parent
  assertEquals(typeof result.sufficient, "boolean");
});

// ---------------------------------------------------------------------------
// Container nuke guard (Issue #4164)
// ---------------------------------------------------------------------------

Deno.test("checkAndCleanupDiskSpace - container mode preserves the workDir when host free space is ample", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${workDir}/keep.txt`, "clone cache\n");
    const result = await checkAndCleanupDiskSpace({
      workDir,
      threshold: 90,
      skipDenoCache: true,
      outerCheckUsage: () => Promise.resolve(95),
      env: (name) =>
        name === "VIBE_IMAGE_AGENT_PROVIDERS" ? "claude" : undefined,
      freeBytesProbe: () => Promise.resolve(50 * 1024 ** 3),
    });
    assertEquals(result.cleanedUp, false);
    assertEquals(
      await Deno.readTextFile(`${workDir}/keep.txt`),
      "clone cache\n",
    );
    assertEquals(/preserving/.test(result.message), true, result.message);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("checkAndCleanupDiskSpace - container mode still nukes below the absolute floor", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${workDir}/stale.txt`, "stale\n");
    const result = await checkAndCleanupDiskSpace({
      workDir,
      threshold: 90,
      skipDenoCache: true,
      outerCheckUsage: () => Promise.resolve(99),
      env: (name) =>
        name === "VIBE_IMAGE_AGENT_PROVIDERS" ? "claude" : undefined,
      freeBytesProbe: () => Promise.resolve(1 * 1024 ** 3),
    });
    assertEquals(result.cleanedUp, true);
    assertEquals(
      await Deno.stat(`${workDir}/stale.txt`).then(() => true, () => false),
      false,
      "below the floor the stale contents must actually be removed",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// nukeWorkDir on a volume mountpoint (Issue #4212)
// ---------------------------------------------------------------------------

Deno.test("nukeWorkDir - clears contents without removing the directory itself (Issue #4212)", async () => {
  // The work dir is a named-volume mountpoint since #4203: removing the
  // directory itself always fails (EBUSY), and the old swallow-and-recreate
  // shape silently nuked nothing in a genuine disk emergency.
  const workDir = await Deno.makeTempDir({ prefix: "nuke_workdir_" });
  try {
    await Deno.mkdir(`${workDir}/example-org/private-repo-56`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${workDir}/example-org/private-repo-56/f.txt`,
      "x",
    );
    await Deno.writeTextFile(`${workDir}/.heartbeat_a_b_1`, "123");
    await Deno.mkdir(`${workDir}/lost+found`);

    const statBefore = await Deno.stat(workDir);
    await nukeWorkDir(workDir);

    // The directory itself survives (a mountpoint cannot be removed)...
    assertEquals((await Deno.stat(workDir)).isDirectory, true);
    assertEquals(statBefore.isDirectory, true);
    // ...its clone content and metadata are gone...
    let repoGone = false;
    try {
      await Deno.stat(`${workDir}/stSoftwareAU`);
    } catch {
      repoGone = true;
    }
    assertEquals(repoGone, true, "clone content must be removed");
    let hbGone = false;
    try {
      await Deno.stat(`${workDir}/.heartbeat_a_b_1`);
    } catch {
      hbGone = true;
    }
    assertEquals(hbGone, true, "metadata files must be removed");
    // ...and the unremovable ext4 artefact is skipped, not fought.
    assertEquals((await Deno.stat(`${workDir}/lost+found`)).isDirectory, true);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
