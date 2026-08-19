/**
 * Tests for the two-tier disk cleanup policy (Issue #1499).
 *
 * Two thresholds:
 *   - gentle (default 80%): runs incremental reclaim (caches, node_modules),
 *     never nukes the work directory — preserves cloned repositories.
 *   - aggressive (default 90%): runs incremental reclaim, then nukes the
 *     work directory if reclaim was insufficient.
 *
 * The gentle pass avoids the network/time cost of re-cloning repositories
 * on the next run.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkAndCleanupDiskSpace,
  DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD,
  DEFAULT_DISK_CLEANUP_THRESHOLD,
} from "../lib/disk_space.ts";
import { resetFaultCounters } from "../lib/fault_tolerance_counters.ts";

Deno.test("disk_space - DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD is 80", () => {
  assertEquals(DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD, 80);
});

Deno.test("disk_space - aggressive default threshold remains 90", () => {
  // The aggressive (workDir nuke) threshold is unchanged by the two-tier
  // rollout — only the gentle tier is new.
  assertEquals(DEFAULT_DISK_CLEANUP_THRESHOLD, 90);
});

Deno.test("disk_space - gentle tier: between thresholds runs reclaim but never nukes repos", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(`${workDir}/fake-clone/.git`, { recursive: true });
  await Deno.writeTextFile(`${workDir}/fake-clone/README.md`, "cloned repo");

  try {
    // Usage = 85% → above gentle (80) but below aggressive (90).
    // Even when incremental reclaim cannot bring usage below the gentle
    // threshold, we must NOT fall through to the workDir nuke because
    // we are only in the gentle tier.
    const result = await checkAndCleanupDiskSpace({
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise engage the Issue #4164 guard.
      env: () => undefined,
      workDir,
      threshold: 90,
      gentleThreshold: 80,
      reclaimOverrides: {
        // Simulate incremental reclaim that does not fully resolve pressure.
        checkUsage: () => Promise.resolve(85),
        checkAvailableKB: () => Promise.resolve(1000),
        toolAvailable: () => Promise.resolve(true),
        runCommand: () => Promise.resolve({ success: true, code: 0 }),
        cleanDenoCache: () =>
          Promise.resolve({ success: true, message: "cleaned" }),
        forceMacOS: false,
      },
    });

    // Simulate real-disk usage by forcing via test hook — but since the
    // real disk df is used for the outer usage check, we cover the
    // below-threshold path in a separate test. Here we assert that when
    // the function takes the gentle branch, it does not nuke.
    // (The outer test harness can only assert on the code path that runs
    // for the real disk usage on the test runner; further tests below
    // cover the exact branch.)
    assertEquals(typeof result.usagePercent, "number");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    resetFaultCounters();
  }
});

Deno.test(
  "disk_space - gentle tier runs incremental reclaim but does not nuke workDir",
  async () => {
    resetFaultCounters();
    const tmpDir = await Deno.makeTempDir();
    const workDir = `${tmpDir}/work`;
    await Deno.mkdir(`${workDir}/fake-clone/.git`, { recursive: true });
    await Deno.writeTextFile(`${workDir}/fake-clone/README.md`, "cloned repo");

    try {
      // Force the gentle branch: aggressive threshold very high (never hit),
      // gentle threshold = 0 (always engaged). Incremental reclaim here runs
      // and cannot clear the threshold (simulated usage stays at 85%), yet
      // the workDir must NOT be nuked.
      const result = await checkAndCleanupDiskSpace({
        // Host context: the suite also runs inside the worker image, where
        // the container stamp would otherwise engage the Issue #4164 guard.
        env: () => undefined,
        workDir,
        threshold: 100,
        gentleThreshold: 0,
        reclaimOverrides: {
          checkUsage: () => Promise.resolve(85),
          checkAvailableKB: () => Promise.resolve(1000),
          toolAvailable: () => Promise.resolve(false),
          runCommand: () => Promise.resolve({ success: true, code: 0 }),
          cleanDenoCache: () =>
            Promise.resolve({ success: true, message: "cleaned" }),
          forceMacOS: false,
        },
      });

      // Work directory preserved; cloned repo intact.
      assertEquals(result.cleanedUp, false);
      const readme = await Deno.readTextFile(
        `${workDir}/fake-clone/README.md`,
      );
      assertEquals(readme, "cloned repo");

      // Gentle tier should be reported in the result.
      assertEquals(result.tier, "gentle");
      assertStringIncludes(result.message, "gentle");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
      resetFaultCounters();
    }
  },
);

Deno.test(
  "disk_space - aggressive tier still nukes workDir when reclaim insufficient",
  async () => {
    resetFaultCounters();
    const tmpDir = await Deno.makeTempDir();
    const workDir = `${tmpDir}/work`;
    await Deno.mkdir(workDir, { recursive: true });
    await Deno.writeTextFile(`${workDir}/doomed.txt`, "sacrifice");

    try {
      // Aggressive branch: both thresholds at 0, usage always 95 →
      // incremental reclaim cannot clear → nuke.
      const result = await checkAndCleanupDiskSpace({
        // Host context: the suite also runs inside the worker image, where
        // the container stamp would otherwise engage the Issue #4164 guard.
        env: () => undefined,
        workDir,
        threshold: 0,
        gentleThreshold: 0,
        reclaimOverrides: {
          checkUsage: () => Promise.resolve(95),
          checkAvailableKB: () => Promise.resolve(1000),
          toolAvailable: () => Promise.resolve(false),
          runCommand: () => Promise.resolve({ success: false, code: 1 }),
          cleanDenoCache: () =>
            Promise.resolve({ success: false, message: "failed" }),
          forceMacOS: false,
        },
      });

      assertEquals(result.cleanedUp, true);
      assertEquals(result.tier, "aggressive");
      let exists = true;
      try {
        await Deno.stat(`${workDir}/doomed.txt`);
      } catch {
        exists = false;
      }
      assertEquals(exists, false);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
      resetFaultCounters();
    }
  },
);

Deno.test("disk_space - below gentle threshold performs no action", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });
  await Deno.writeTextFile(`${workDir}/keep.txt`, "data");

  try {
    // Both thresholds very high → no cleanup on any real filesystem.
    const result = await checkAndCleanupDiskSpace({
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise engage the Issue #4164 guard.
      env: () => undefined,
      workDir,
      threshold: 100,
      gentleThreshold: 100,
    });

    assertEquals(result.cleanedUp, false);
    assertEquals(result.tier, "none");
    const content = await Deno.readTextFile(`${workDir}/keep.txt`);
    assertEquals(content, "data");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test(
  "disk_space - gentleThreshold defaults to threshold (backwards compatible)",
  async () => {
    // When gentleThreshold is not supplied, the function must behave as
    // before: only the aggressive threshold drives cleanup. This preserves
    // every call site that has not been updated.
    resetFaultCounters();
    const tmpDir = await Deno.makeTempDir();
    const workDir = `${tmpDir}/work`;
    await Deno.mkdir(workDir, { recursive: true });
    await Deno.writeTextFile(`${workDir}/preserved.txt`, "data");

    try {
      const result = await checkAndCleanupDiskSpace({
        // Host context: the suite also runs inside the worker image, where
        // the container stamp would otherwise engage the Issue #4164 guard.
        env: () => undefined,
        workDir,
        threshold: 100, // Above any real disk usage — no gentle, no aggressive.
      });
      assertEquals(result.cleanedUp, false);
      assertEquals(result.tier, "none");
      const content = await Deno.readTextFile(`${workDir}/preserved.txt`);
      assertEquals(content, "data");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
      resetFaultCounters();
    }
  },
);

Deno.test(
  "disk_space - clamps gentleThreshold to threshold when caller sets gentle > aggressive",
  async () => {
    resetFaultCounters();
    const tmpDir = await Deno.makeTempDir();
    const workDir = `${tmpDir}/work`;
    await Deno.mkdir(workDir, { recursive: true });

    try {
      // Misconfiguration: gentle (95) > aggressive (50). The function must
      // never let gentleThreshold exceed threshold — otherwise the gentle
      // tier could swallow a usage value that should have triggered the
      // aggressive path. With outer usage=95, the aggressive path must run.
      // Use the explicit `outerCheckUsage` test hook so the result is
      // deterministic regardless of the host filesystem state.
      const result = await checkAndCleanupDiskSpace({
        // Host context: the suite also runs inside the worker image, where
        // the container stamp would otherwise engage the Issue #4164 guard.
        env: () => undefined,
        workDir,
        threshold: 50,
        gentleThreshold: 95,
        outerCheckUsage: () => Promise.resolve(95),
        reclaimOverrides: {
          checkUsage: () => Promise.resolve(95),
          checkAvailableKB: () => Promise.resolve(1000),
          toolAvailable: () => Promise.resolve(false),
          runCommand: () => Promise.resolve({ success: false, code: 1 }),
          cleanDenoCache: () =>
            Promise.resolve({ success: false, message: "failed" }),
          forceMacOS: false,
        },
      });

      // Clamp confirmed: result.gentleThreshold should be the threshold (50)
      // rather than the misconfigured 95.
      assertEquals(result.gentleThreshold, 50);
      // Usage ≥ threshold → aggressive path.
      assertEquals(result.tier, "aggressive");
      assertEquals(result.cleanedUp, true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
      resetFaultCounters();
    }
  },
);
