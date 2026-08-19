/**
 * Tests for incrementalReclaim() — tiered disk-space reclamation before
 * the full WORK_DIR nuke.
 *
 * Issue #1495: Self-healing — incremental cache reclaim before WORK_DIR nuke.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkAndCleanupDiskSpace,
  incrementalReclaim,
  type ReclaimTierName,
} from "../lib/disk_space.ts";
import { resetFaultCounters } from "../lib/fault_tolerance_counters.ts";

// Helper: capture console.log calls for SELF-HEALING log verification.
function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  return {
    logs,
    restore: () => {
      console.log = original;
    },
  };
}

// -----------------------------------------------------------------------------
// incrementalReclaim — tier ordering & early-exit
// -----------------------------------------------------------------------------

Deno.test("incrementalReclaim - runs tiers in documented order", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });

  const attempted: ReclaimTierName[] = [];
  try {
    const result = await incrementalReclaim({
      workDir,
      threshold: 90,
      // Never meet threshold — all tiers should be attempted.
      checkUsage: () => Promise.resolve(95),
      checkAvailableKB: () => Promise.resolve(1000),
      toolAvailable: () => Promise.resolve(true),
      runCommand: (executable, _args) => {
        attempted.push(`subprocess-${executable}` as ReclaimTierName);
        return Promise.resolve({ success: true, code: 0 });
      },
      cleanDenoCache: () => {
        attempted.push("deno-cache");
        return Promise.resolve({ success: true, message: "cleaned" });
      },
      forceMacOS: true,
    });

    // Tiers should be recorded in order in the result.
    const orderedTiers = result.tiers.map((t) => t.tier);
    assertEquals(orderedTiers, [
      "deno-cache",
      "npm-cache",
      "node-modules",
      "pip-cache",
      "brew-cleanup",
    ]);
    assertEquals(result.thresholdMet, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("incrementalReclaim - early-exits once threshold is met", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });

  try {
    // First check returns above threshold (trigger loop), then below after
    // the second tier runs — simulate npm cache clean freeing enough space.
    let callCount = 0;
    const result = await incrementalReclaim({
      workDir,
      threshold: 90,
      checkUsage: () => {
        callCount++;
        // Deno cache tier: still full. After npm cache tier: below threshold.
        return Promise.resolve(callCount >= 2 ? 50 : 95);
      },
      checkAvailableKB: () => Promise.resolve(1000),
      toolAvailable: () => Promise.resolve(true),
      runCommand: () => Promise.resolve({ success: true, code: 0 }),
      cleanDenoCache: () =>
        Promise.resolve({ success: true, message: "cleaned" }),
      forceMacOS: true,
    });

    // Only the first two tiers should have been attempted.
    const attempted = result.tiers.map((t) => t.tier);
    assertEquals(attempted, ["deno-cache", "npm-cache"]);
    assertEquals(result.thresholdMet, true);
    assertEquals(result.finalUsagePercent, 50);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// -----------------------------------------------------------------------------
// Missing tools — graceful skip
// -----------------------------------------------------------------------------

Deno.test("incrementalReclaim - skips tiers whose tools are missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });

  try {
    const result = await incrementalReclaim({
      workDir,
      threshold: 90,
      checkUsage: () => Promise.resolve(95),
      checkAvailableKB: () => Promise.resolve(1000),
      // No tool is available — every external tier is skipped.
      toolAvailable: () => Promise.resolve(false),
      runCommand: () => Promise.resolve({ success: true, code: 0 }),
      cleanDenoCache: () =>
        Promise.resolve({ success: true, message: "cleaned" }),
      forceMacOS: true,
    });

    // Deno cache is run via cleanDenoCache (not via toolAvailable("deno"));
    // tiers with missing tools should be recorded as attempted=false.
    const npm = result.tiers.find((t) => t.tier === "npm-cache");
    const pip = result.tiers.find((t) => t.tier === "pip-cache");
    const brew = result.tiers.find((t) => t.tier === "brew-cleanup");

    assertEquals(npm?.attempted, false);
    assertEquals(pip?.attempted, false);
    assertEquals(brew?.attempted, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("incrementalReclaim - skips brew on non-macOS", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });

  try {
    const result = await incrementalReclaim({
      workDir,
      threshold: 90,
      checkUsage: () => Promise.resolve(95),
      checkAvailableKB: () => Promise.resolve(1000),
      toolAvailable: () => Promise.resolve(true),
      runCommand: () => Promise.resolve({ success: true, code: 0 }),
      cleanDenoCache: () =>
        Promise.resolve({ success: true, message: "cleaned" }),
      // Explicit Linux → brew should never be attempted.
      forceMacOS: false,
    });

    const brew = result.tiers.find((t) => t.tier === "brew-cleanup");
    assertEquals(brew?.attempted, false);
    assertStringIncludes(brew?.message ?? "", "not macOS");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// -----------------------------------------------------------------------------
// node_modules removal
// -----------------------------------------------------------------------------

Deno.test("incrementalReclaim - removes stray node_modules directories", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(`${workDir}/repo-a/node_modules/foo`, { recursive: true });
  await Deno.mkdir(`${workDir}/repo-b/src/node_modules/bar`, {
    recursive: true,
  });
  await Deno.writeTextFile(`${workDir}/repo-a/node_modules/foo/pkg.json`, "{}");
  await Deno.writeTextFile(
    `${workDir}/repo-b/src/node_modules/bar/pkg.json`,
    "{}",
  );

  try {
    const result = await incrementalReclaim({
      workDir,
      threshold: 90,
      checkUsage: () => Promise.resolve(95),
      checkAvailableKB: () => Promise.resolve(1000),
      toolAvailable: () => Promise.resolve(false),
      runCommand: () => Promise.resolve({ success: false, code: 1 }),
      cleanDenoCache: () =>
        Promise.resolve({ success: false, message: "skipped" }),
      forceMacOS: false,
    });

    const tier = result.tiers.find((t) => t.tier === "node-modules");
    assertEquals(tier?.attempted, true);
    assertStringIncludes(tier?.message ?? "", "2");

    // Both node_modules directories should be gone.
    let aExists = true;
    let bExists = true;
    try {
      await Deno.stat(`${workDir}/repo-a/node_modules`);
    } catch {
      aExists = false;
    }
    try {
      await Deno.stat(`${workDir}/repo-b/src/node_modules`);
    } catch {
      bExists = false;
    }
    assertEquals(aExists, false);
    assertEquals(bExists, false);

    // Parent directories should still exist.
    const aStat = await Deno.stat(`${workDir}/repo-a`);
    assertEquals(aStat.isDirectory, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// -----------------------------------------------------------------------------
// SELF-HEALING logging
// -----------------------------------------------------------------------------

Deno.test("incrementalReclaim - logs SELF-HEALING entry with bytes reclaimed per tier", async () => {
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });

  const cap = captureConsole();
  try {
    // Simulate available-KB growing by 1024 KB per tier → 1 MB per tier.
    let availSeq = 0;
    await incrementalReclaim({
      workDir,
      threshold: 90,
      checkUsage: () => Promise.resolve(95),
      checkAvailableKB: () => {
        // Even calls = before tier, odd calls = after tier (grown by 1024 KB).
        const val = Math.floor(availSeq / 2) * 1024 +
          (availSeq % 2 === 0 ? 0 : 1024);
        availSeq++;
        return Promise.resolve(val);
      },
      toolAvailable: () => Promise.resolve(true),
      runCommand: () => Promise.resolve({ success: true, code: 0 }),
      cleanDenoCache: () =>
        Promise.resolve({ success: true, message: "cleaned" }),
      forceMacOS: true,
    });
  } finally {
    cap.restore();
    await Deno.remove(tmpDir, { recursive: true });
  }

  const healingLogs = cap.logs.filter((l) => l.includes("SELF-HEALING"));
  // At least one SELF-HEALING log per attempted tier.
  assertEquals(healingLogs.length >= 1, true);
  // Every log mentions reclaimed bytes.
  for (const log of healingLogs) {
    assertStringIncludes(log, "bytes");
  }
});

// -----------------------------------------------------------------------------
// Integration: checkAndCleanupDiskSpace uses incremental reclaim before nuke
// -----------------------------------------------------------------------------

Deno.test("checkAndCleanupDiskSpace - skips nuke when incremental reclaim succeeds", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });
  await Deno.writeTextFile(`${workDir}/keep_me.txt`, "important data");

  try {
    const result = await checkAndCleanupDiskSpace({
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise engage the Issue #4164 guard.
      env: () => undefined,
      workDir,
      // threshold=1 guarantees the outer over-threshold branch triggers
      // (real disk usage is always >=1%) while the injected checkUsage
      // returns 0, letting incremental reclaim clear the threshold.
      threshold: 1,
      reclaimOverrides: {
        // Simulate incremental reclaim resolving the pressure immediately.
        checkUsage: () => Promise.resolve(0),
        checkAvailableKB: () => Promise.resolve(1000),
        toolAvailable: () => Promise.resolve(true),
        runCommand: () => Promise.resolve({ success: true, code: 0 }),
        cleanDenoCache: () =>
          Promise.resolve({ success: true, message: "cleaned" }),
        forceMacOS: false,
      },
    });

    // Work directory should not have been nuked.
    assertEquals(result.cleanedUp, false);
    const content = await Deno.readTextFile(`${workDir}/keep_me.txt`);
    assertEquals(content, "important data");
    assertStringIncludes(result.message, "Incremental reclaim");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    resetFaultCounters();
  }
});

Deno.test("checkAndCleanupDiskSpace - falls through to nuke when incremental reclaim insufficient", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });
  await Deno.writeTextFile(`${workDir}/doomed.txt`, "sacrifice");

  try {
    const result = await checkAndCleanupDiskSpace({
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise engage the Issue #4164 guard.
      env: () => undefined,
      workDir,
      threshold: 0, // Force the "over threshold" branch.
      reclaimOverrides: {
        // Usage never drops below threshold → fall through to nuke.
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

    // Doomed file should be gone.
    let exists = true;
    try {
      await Deno.stat(`${workDir}/doomed.txt`);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
    assertStringIncludes(result.message, "Incremental reclaim insufficient");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    resetFaultCounters();
  }
});

Deno.test("checkAndCleanupDiskSpace - legacy path (skipDenoCache) skips incremental reclaim", async () => {
  resetFaultCounters();
  const tmpDir = await Deno.makeTempDir();
  const workDir = `${tmpDir}/work`;
  await Deno.mkdir(workDir, { recursive: true });
  await Deno.writeTextFile(`${workDir}/legacy.txt`, "legacy");

  try {
    const result = await checkAndCleanupDiskSpace({
      // Host context: the suite also runs inside the worker image, where
      // the container stamp would otherwise engage the Issue #4164 guard.
      env: () => undefined,
      workDir,
      threshold: 0,
      skipDenoCache: true,
    });

    // Legacy hermetic path — file is gone, denoCacheCleaned is false,
    // message should not claim incremental reclaim ran.
    assertEquals(result.cleanedUp, true);
    assertEquals(result.denoCacheCleaned, false);
    let exists = true;
    try {
      await Deno.stat(`${workDir}/legacy.txt`);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
    assertEquals(result.message.includes("Incremental reclaim"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    resetFaultCounters();
  }
});
