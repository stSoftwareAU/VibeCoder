/**
 * Disk space management utilities for self-healing unattended machines.
 *
 * When disk pressure is detected (usage >= threshold), the module runs an
 * incremental reclamation pass (Deno cache → npm cache → stray node_modules
 * → pip cache → brew cleanup), re-checking disk usage after each tier and
 * exiting early once the threshold is met. Only when incremental reclaim
 * is insufficient does the work directory get nuked (Issue #1495).
 *
 * Migrated from worker/shared/disk_space.sh (Issue #902).
 * Issue #95: Check disk space of WORK_DIR at startup.
 * Issue #1489: Clean Deno cache when low on disk space.
 * Issue #1495: Incremental cache reclaim before WORK_DIR nuke.
 */ import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isReservedWorkRootEntry } from "./stale_workdir.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";
import { cleanDenoCache as realCleanDenoCache } from "./deno_cache.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";
import { runningInContainerImage } from "./container_stamp.ts";
/** Timeout for df commands: 10 seconds (handles NFS stalls). */ const DF_TIMEOUT_MS = 10_000;
/** Timeout for tool availability checks via `which`: 5 seconds. */ const WHICH_TIMEOUT_MS = 5_000;
/** Default timeout for incremental reclaim subprocesses: 60 seconds. */ const RECLAIM_SUBPROCESS_TIMEOUT_MS = 60_000;
/** Default aggressive threshold: 90% disk usage triggers workDir nuke. */ export const DEFAULT_DISK_CLEANUP_THRESHOLD = 90;
/**
 * Default gentle threshold: 80% disk usage triggers the incremental reclaim
 * pass without nuking the work directory (Issue #1499).
 *
 * The gentle pass targets cheap-to-recreate items (Deno cache, npm cache,
 * node_modules, pip cache, brew cleanup) so that warm cloned repositories
 * are preserved for the next run — re-cloning is expensive in network and
 * time. Only the aggressive tier (see {@link DEFAULT_DISK_CLEANUP_THRESHOLD})
 * will remove cloned repositories, and only when the gentle pass is not
 * enough.
 */ export const DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD = 80;
/** Default minimum free space in MB before large git operations (Issue #1168). */ export const DEFAULT_MIN_FREE_SPACE_MB = 500;
/** Lowest usable cleanup threshold (Issue #1268). */ export const DISK_CLEANUP_THRESHOLD_MIN = 1;
/** Highest usable cleanup threshold — disk usage is a percentage. */ export const DISK_CLEANUP_THRESHOLD_MAX = 100;
/**
 * Check an operator-supplied cleanup threshold (Issue #1268).
 *
 * A threshold of `0` reads as "usage is always at or above the aggressive
 * threshold", so every start nuked the work directory and every cloned
 * repository on the volume with it — the opposite of the "disabled" an
 * operator naturally expects `0` to mean. Negative values and values above
 * 100 are equally meaningless against a usage percentage, as is a fraction.
 *
 * Enforced at the operator-facing boundaries — the `disk-space` CLI args and
 * the housekeeping environment values — so a bad value is refused before it
 * can reach {@link checkAndCleanupDiskSpace}. There is no "disabled"
 * spelling: set the threshold to 100 to make the aggressive tier
 * unreachable in practice.
 *
 * @param name - Flag or variable name to name in the failure message.
 * @param value - The supplied threshold.
 * @returns `null` when the value is usable, otherwise the failure message.
 */ export function validateCleanupThreshold(name, value) {
  if (Number.isInteger(value) && value >= DISK_CLEANUP_THRESHOLD_MIN && value <= DISK_CLEANUP_THRESHOLD_MAX) {
    return null;
  }
  return `${name} must be ${DISK_CLEANUP_THRESHOLD_MIN}–` + `${DISK_CLEANUP_THRESHOLD_MAX} (whole percent), got ${value}: ` + `refusing to run disk cleanup`;
}
/**
 * Parse an operator-supplied threshold, from a CLI argument or an
 * environment string (Issue #1268).
 *
 * `parseInt` read `"0abc"` as `0` — the very value that made every start
 * aggressive — and `"9x"` as `9`, so a present-but-unreadable value returns
 * `NaN` here and is refused by {@link validateCleanupThreshold} rather than
 * standing in for a number the operator never wrote. Only an absent value
 * falls back.
 *
 * @param value - The supplied threshold (CLI argument or environment string).
 * @param fallback - Used when the value is absent.
 * @returns The parsed threshold, `fallback` when absent, `NaN` when unreadable.
 */ export function parseCleanupThreshold(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }
  return NaN;
}
/**
 * Free-space floor below which the in-container workDir nuke is permitted
 * (Issue #4164). Inside the container the measured filesystem is the HOST
 * volume seen through the mount, so a percentage threshold is chronically
 * exceeded on a large disk while the work directory itself may hold almost
 * nothing — observed live: a 4 KB work directory deleted and recreated on
 * every cycle at "92% usage" of a 460 GB volume. Only genuinely critical
 * absolute free space justifies destroying the clone cache.
 */ export const CONTAINER_NUKE_FREE_BYTES_FLOOR = 5 * 1024 ** 3;
/**
 * Get disk usage percentage for the filesystem containing the given path.
 *
 * Uses `df -P` (POSIX format) for cross-platform compatibility.
 * If the path does not exist, walks up to the closest existing parent.
 *
 * @returns Usage percentage (0-100), or null if it cannot be determined.
 */ export async function getDiskUsagePercent(path) {
  const checkPath = resolveExistingPath(path);
  const result = await runWithTimeout("df", [
    "-P",
    checkPath
  ], {
    timeoutMs: DF_TIMEOUT_MS
  });
  if (!result.ok || result.value.timedOut || !result.value.success) {
    return null;
  }
  const lines = result.value.stdout.split("\n");
  const dataLine = lines[1];
  if (dataLine === undefined) return null;
  // POSIX df -P format: Filesystem 1024-blocks Used Available Capacity Mounted
  const fields = dataLine.trim().split(/\s+/);
  const capacityField = fields[4];
  if (capacityField === undefined) return null;
  const capacityStr = capacityField.replace(/%/, "");
  const usage = parseInt(capacityStr, 10);
  if (isNaN(usage)) return null;
  return usage;
}
/**
 * Free bytes on the filesystem containing `path` (Issue #4164).
 *
 * Same `df -P` probe as {@link getDiskUsagePercent}, reading the Available
 * column (1024-byte blocks).
 *
 * @returns Free bytes, or null if they cannot be determined.
 */ export async function getDiskFreeBytes(path) {
  const checkPath = resolveExistingPath(path);
  const result = await runWithTimeout("df", [
    "-P",
    checkPath
  ], {
    timeoutMs: DF_TIMEOUT_MS
  });
  if (!result.ok || result.value.timedOut || !result.value.success) {
    return null;
  }
  const dataLine = result.value.stdout.split("\n")[1];
  if (dataLine === undefined) return null;
  // POSIX df -P format: Filesystem 1024-blocks Used Available Capacity Mounted
  const availableField = dataLine.trim().split(/\s+/)[3];
  if (availableField === undefined) return null;
  const availableKb = parseInt(availableField, 10);
  if (isNaN(availableKb)) return null;
  return availableKb * 1024;
}
/**
 * Get available disk space in KB for the filesystem containing the given path.
 *
 * Used by {@link incrementalReclaim} to compute per-tier bytes-reclaimed.
 *
 * @param path - Filesystem path to probe (walks up to the closest parent).
 * @param run - Subprocess runner (test seam; defaults to {@link runWithTimeout}).
 * @returns Available kilobytes, or null on timeout/failure/unparseable output.
 */ export async function getDiskAvailableKB(path, run = runWithTimeout) {
  const checkPath = resolveExistingPath(path);
  const result = await run("df", [
    "-Pk",
    checkPath
  ], {
    timeoutMs: DF_TIMEOUT_MS
  });
  if (!result.ok || result.value.timedOut || !result.value.success) {
    return null;
  }
  const lines = result.value.stdout.split("\n");
  const dataLine = lines[1];
  if (dataLine === undefined) return null;
  const fields = dataLine.trim().split(/\s+/);
  const availField = fields[3];
  if (availField === undefined) return null;
  const availKB = parseInt(availField, 10);
  return isNaN(availKB) ? null : availKB;
}
/**
 * Run incremental reclaim tiers until disk usage drops below threshold.
 *
 * Tiers run in this order, with an early-exit check after each:
 *   1. Deno cache (`deno clean`)
 *   2. `npm cache clean --force` (if npm is on PATH)
 *   3. Remove stray `node_modules/` directories under workDir
 *   4. `pip cache purge` (if pip is on PATH)
 *   5. `brew cleanup -s` (macOS only, if brew is on PATH)
 *
 * Missing tools are skipped gracefully. Each attempted tier logs a
 * `SELF-HEALING` entry with the bytes reclaimed.
 */ export async function incrementalReclaim(options) {
  const { workDir, threshold = DEFAULT_DISK_CLEANUP_THRESHOLD } = options;
  const checkUsage = options.checkUsage ?? getDiskUsagePercent;
  const checkAvailableKB = options.checkAvailableKB ?? getDiskAvailableKB;
  const toolAvailable = options.toolAvailable ?? defaultToolAvailable;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const cleanDenoCache = options.cleanDenoCache ?? (async ()=>{
    const r = await realCleanDenoCache();
    return {
      success: r.success,
      message: r.message
    };
  });
  const isMacOS = options.forceMacOS ?? Deno.build.os === "darwin";
  const tiers = [];
  let totalBytesReclaimed = 0;
  let currentUsage = null;
  const recordAttempt = async (tier, description, run)=>{
    const beforeKB = await checkAvailableKB(workDir);
    const outcome = await run();
    const afterKB = await checkAvailableKB(workDir);
    const bytesReclaimed = beforeKB !== null && afterKB !== null && afterKB > beforeKB ? (afterKB - beforeKB) * 1024 : 0;
    totalBytesReclaimed += bytesReclaimed;
    tiers.push({
      tier,
      attempted: true,
      succeeded: outcome.success,
      bytesReclaimed,
      message: `${description} — ${outcome.message}`
    });
    console.log(`SELF-HEALING: ${description} reclaimed ${bytesReclaimed} bytes (${outcome.success ? "ok" : "failed"})`);
    recordFaultEvent("disk_space_cleanup", `${tier}: reclaimed ${bytesReclaimed} bytes (${outcome.success ? "ok" : "failed"})`);
    await emitSelfHealEventAuto({
      module: "disk_space",
      action: `reclaim_${tier}`,
      reason: description,
      result: outcome.success ? "ok" : "failed",
      bytesReclaimed
    }, workDir);
  };
  const recordSkip = async (tier, description, reason)=>{
    tiers.push({
      tier,
      attempted: false,
      succeeded: false,
      bytesReclaimed: 0,
      message: `${description} — skipped (${reason})`
    });
    console.log(`SELF-HEALING: ${description} skipped (${reason})`);
    await emitSelfHealEventAuto({
      module: "disk_space",
      action: `reclaim_${tier}`,
      reason: `${description} skipped: ${reason}`,
      result: "skipped"
    }, workDir);
  };
  const isThresholdMet = ()=>currentUsage !== null && currentUsage < threshold;
  // Tier 1: Deno cache.
  await recordAttempt("deno-cache", "deno clean", cleanDenoCache);
  currentUsage = await checkUsage(workDir);
  if (isThresholdMet()) return finalise();
  // Tier 2: npm cache clean --force.
  if (await toolAvailable("npm")) {
    await recordAttempt("npm-cache", "npm cache clean --force", async ()=>{
      const r = await runCommand("npm", [
        "cache",
        "clean",
        "--force"
      ]);
      return {
        success: r.success,
        message: r.success ? "cleaned" : `exit ${r.code}`
      };
    });
    currentUsage = await checkUsage(workDir);
    if (isThresholdMet()) return finalise();
  } else {
    await recordSkip("npm-cache", "npm cache clean --force", "npm not available");
  }
  // Tier 3: remove stray node_modules directories under workDir.
  await recordAttempt("node-modules", "remove stray node_modules", async ()=>{
    const removed = await removeNodeModulesDirs(workDir);
    return {
      success: true,
      message: `${removed} directories removed`
    };
  });
  currentUsage = await checkUsage(workDir);
  if (isThresholdMet()) return finalise();
  // Tier 4: pip cache purge.
  if (await toolAvailable("pip")) {
    await recordAttempt("pip-cache", "pip cache purge", async ()=>{
      const r = await runCommand("pip", [
        "cache",
        "purge"
      ]);
      return {
        success: r.success,
        message: r.success ? "cleaned" : `exit ${r.code}`
      };
    });
    currentUsage = await checkUsage(workDir);
    if (isThresholdMet()) return finalise();
  } else {
    await recordSkip("pip-cache", "pip cache purge", "pip not available");
  }
  // Tier 5: brew cleanup -s (macOS only).
  if (!isMacOS) {
    await recordSkip("brew-cleanup", "brew cleanup -s", "not macOS");
  } else if (!await toolAvailable("brew")) {
    await recordSkip("brew-cleanup", "brew cleanup -s", "brew not available");
  } else {
    await recordAttempt("brew-cleanup", "brew cleanup -s", async ()=>{
      const r = await runCommand("brew", [
        "cleanup",
        "-s"
      ]);
      return {
        success: r.success,
        message: r.success ? "cleaned" : `exit ${r.code}`
      };
    });
    currentUsage = await checkUsage(workDir);
  }
  return finalise();
  function finalise() {
    return {
      tiers,
      thresholdMet: isThresholdMet(),
      finalUsagePercent: currentUsage,
      totalBytesReclaimed
    };
  }
}
/**
 * Check disk space and clean up the work directory based on a two-tier
 * policy (Issue #1499):
 *
 *   - Usage < gentleThreshold: no action.
 *   - gentleThreshold ≤ Usage < threshold: gentle tier — run
 *     {@link incrementalReclaim} only. Cloned repositories are preserved
 *     to avoid the network/time cost of re-cloning on the next run.
 *   - Usage ≥ threshold: aggressive tier — run incremental reclaim, and
 *     if that is insufficient, delete and recreate the work directory.
 *
 * When `skipDenoCache: true` is set, the incremental pass is bypassed
 * entirely and workDir is nuked directly (only in the aggressive tier) —
 * this preserves the hermetic legacy test path (Issue #1489).
 *
 * If `gentleThreshold` is omitted, it defaults to `threshold` (i.e. no
 * gentle tier) to preserve backwards compatibility with callers that
 * have not been updated.
 */ export async function checkAndCleanupDiskSpace(options) {
  const { workDir, threshold = DEFAULT_DISK_CLEANUP_THRESHOLD, skipDenoCache = false, reclaimOverrides } = options;
  // Clamp gentleThreshold to threshold to prevent misconfiguration from
  // masking an aggressive-tier condition (Issue #1499).
  const gentleThreshold = Math.min(options.gentleThreshold ?? threshold, threshold);
  if (!workDir) {
    return {
      usagePercent: 0,
      threshold,
      gentleThreshold,
      tier: "none",
      cleanedUp: false,
      denoCacheCleaned: false,
      message: "No directory specified for disk space check"
    };
  }
  const probe = options.outerCheckUsage ?? getDiskUsagePercent;
  const usagePercent = await probe(workDir);
  if (usagePercent === null) {
    // Cannot determine usage — ensure directory exists and continue
    await ensureDir(workDir);
    return {
      usagePercent: 0,
      threshold,
      gentleThreshold,
      tier: "none",
      cleanedUp: false,
      denoCacheCleaned: false,
      message: "Could not determine disk usage, skipping cleanup"
    };
  }
  if (usagePercent < gentleThreshold) {
    // Below gentle threshold — no action, just ensure directory exists.
    await ensureDir(workDir);
    return {
      usagePercent,
      threshold,
      gentleThreshold,
      tier: "none",
      cleanedUp: false,
      denoCacheCleaned: false,
      message: `Disk usage ${usagePercent}% is below gentle threshold ` + `${gentleThreshold}%, no cleanup needed`
    };
  }
  const isAggressive = usagePercent >= threshold;
  // Container guard (Issue #4164), evaluated before EITHER nuke path: only a
  // genuinely critical amount of absolute free space justifies destroying
  // the clone cache — the percentage alone reflects the whole host volume
  // seen through the mount, not the work directory's contribution to it.
  let containerPreserveMessage = null;
  const envLookup = options.env ?? ((name)=>Deno.env.get(name));
  if (isAggressive && runningInContainerImage(envLookup)) {
    const probe = options.freeBytesProbe ?? getDiskFreeBytes;
    const freeBytes = await probe(workDir);
    if (freeBytes === null || freeBytes >= CONTAINER_NUKE_FREE_BYTES_FLOOR) {
      const freeGb = freeBytes === null ? "unknown" : (freeBytes / 1024 ** 3).toFixed(1);
      containerPreserveMessage = `Disk usage ${usagePercent}% >= threshold ${threshold}%, but ` + `${freeGb} GiB free on the host volume — preserving ${workDir} ` + `(Issue #4164: the pressure is host-wide, not the work directory). ` + `The nuke only proceeds below ` + `${CONTAINER_NUKE_FREE_BYTES_FLOOR / 1024 ** 3} GiB free.`;
    }
  }
  // Aggressive legacy hermetic path: skip reclaim, nuke directly.
  if (isAggressive && skipDenoCache) {
    if (containerPreserveMessage !== null) {
      return {
        usagePercent,
        threshold,
        gentleThreshold,
        tier: "aggressive",
        cleanedUp: false,
        denoCacheCleaned: false,
        message: containerPreserveMessage
      };
    }
    await nukeWorkDir(workDir);
    recordFaultEvent("disk_space_cleanup", `Disk at ${usagePercent}% on ${workDir}, cleaned up (legacy path)`);
    await emitSelfHealEventAuto({
      module: "disk_space",
      action: "threshold_cleanup",
      reason: `usage ${usagePercent}% >= ${threshold}% (legacy nuke)`,
      result: "ok"
    }, workDir);
    return {
      usagePercent,
      threshold,
      gentleThreshold,
      tier: "aggressive",
      cleanedUp: true,
      denoCacheCleaned: false,
      message: `Disk usage ${usagePercent}% >= threshold ${threshold}%. ` + `Deleted and recreated ${workDir}.`
    };
  }
  // Run incremental reclaim (applies to both gentle and aggressive tiers).
  const reclaimTarget = isAggressive ? threshold : gentleThreshold;
  const reclaim = await incrementalReclaim({
    workDir,
    threshold: reclaimTarget,
    ...reclaimOverrides
  });
  const denoCacheCleaned = reclaim.tiers.some((t)=>t.tier === "deno-cache" && t.attempted && t.succeeded);
  // Gentle tier: never nuke, regardless of whether reclaim cleared pressure.
  if (!isAggressive) {
    const attempted = reclaim.tiers.filter((t)=>t.attempted).length;
    return {
      usagePercent,
      threshold,
      gentleThreshold,
      tier: "gentle",
      cleanedUp: false,
      denoCacheCleaned,
      incrementalReclaim: reclaim,
      message: `Disk usage ${usagePercent}% >= gentle threshold ${gentleThreshold}% ` + `(< aggressive ${threshold}%). Gentle incremental reclaim freed ` + `${reclaim.totalBytesReclaimed} bytes across ${attempted} tier(s); ` + `cloned repositories preserved.`
    };
  }
  // Aggressive tier: if reclaim succeeded, no nuke.
  if (reclaim.thresholdMet) {
    return {
      usagePercent,
      threshold,
      gentleThreshold,
      tier: "aggressive",
      cleanedUp: false,
      denoCacheCleaned,
      incrementalReclaim: reclaim,
      message: `Incremental reclaim succeeded on ${workDir}: freed ` + `${reclaim.totalBytesReclaimed} bytes across ` + `${reclaim.tiers.filter((t)=>t.attempted).length} tier(s); ` + `usage now ${reclaim.finalUsagePercent ?? "unknown"}%.`
    };
  }
  // Aggressive fall-through: incremental reclaim insufficient. The
  // container guard above may veto the nuke (Issue #4164).
  if (containerPreserveMessage !== null) {
    return {
      usagePercent,
      threshold,
      gentleThreshold,
      tier: "aggressive",
      cleanedUp: false,
      denoCacheCleaned,
      incrementalReclaim: reclaim,
      message: containerPreserveMessage
    };
  }
  await nukeWorkDir(workDir);
  recordFaultEvent("disk_space_cleanup", `Disk at ${usagePercent}% on ${workDir}, incremental reclaim insufficient, nuked`);
  await emitSelfHealEventAuto({
    module: "disk_space",
    action: "threshold_cleanup",
    reason: `usage ${usagePercent}% >= ${threshold}%, reclaim insufficient`,
    result: "ok",
    bytesReclaimed: reclaim.totalBytesReclaimed
  }, workDir);
  return {
    usagePercent,
    threshold,
    gentleThreshold,
    tier: "aggressive",
    cleanedUp: true,
    denoCacheCleaned,
    incrementalReclaim: reclaim,
    message: `Disk usage ${usagePercent}% >= threshold ${threshold}%. ` + `Incremental reclaim insufficient (freed ${reclaim.totalBytesReclaimed} bytes). ` + `Deleted and recreated ${workDir}.`
  };
}
/**
 * Check whether sufficient disk space is available before a large
 * git operation (clone, fetch, checkout) — Issue #1168.
 *
 * Uses `df -P` to read available blocks and converts to MB.
 * If the path does not exist, walks up to the closest existing parent.
 *
 * @param path - Filesystem path to check (usually the work directory).
 * @param requiredMB - Minimum free space in MB (default: 500).
 * @returns Result indicating whether sufficient space is available.
 */ export async function checkDiskSpaceAvailable(path, requiredMB = DEFAULT_MIN_FREE_SPACE_MB) {
  const checkPath = resolveExistingPath(path);
  const result = await runWithTimeout("df", [
    "-P",
    checkPath
  ], {
    timeoutMs: DF_TIMEOUT_MS
  });
  if (!result.ok || result.value.timedOut || !result.value.success) {
    return {
      availableMB: 0,
      requiredMB,
      sufficient: false,
      message: "Could not determine available disk space"
    };
  }
  const lines = result.value.stdout.split("\n");
  if (lines.length < 2) {
    return {
      availableMB: 0,
      requiredMB,
      sufficient: false,
      message: "Unexpected df output format"
    };
  }
  // POSIX df -P format: Filesystem 1024-blocks Used Available Capacity Mounted
  const dataLine = lines[1];
  const fields = dataLine.trim().split(/\s+/);
  if (fields.length < 4) {
    return {
      availableMB: 0,
      requiredMB,
      sufficient: false,
      message: "Unexpected df output format"
    };
  }
  const availableKB = parseInt(fields[3], 10);
  if (isNaN(availableKB)) {
    return {
      availableMB: 0,
      requiredMB,
      sufficient: false,
      message: "Could not parse available disk space"
    };
  }
  const availableMB = Math.floor(availableKB / 1024);
  const sufficient = availableMB >= requiredMB;
  if (!sufficient) {
    recordFaultEvent("disk_space_cleanup", `Insufficient disk space: ${availableMB} MB available, ${requiredMB} MB required at ${path}`);
  }
  return {
    availableMB,
    requiredMB,
    sufficient,
    message: sufficient ? `Disk space OK: ${availableMB} MB available (${requiredMB} MB required)` : `Insufficient disk space: ${availableMB} MB available, ${requiredMB} MB required`
  };
}
/**
 * Pre-check that sufficient disk space is available before a large
 * git operation (Issue #1174).
 *
 * Returns ok: true when space is sufficient, or ok: false with a
 * descriptive error including available space, required minimum,
 * and the operation that was about to be performed.
 *
 * @param path - Filesystem path to check (usually the work directory).
 * @param operation - Human-readable description of the git operation (e.g. "git clone").
 * @param requiredMB - Minimum free space in MB (default: DEFAULT_MIN_FREE_SPACE_MB).
 */ export async function requireDiskSpaceForGitOperation(path, operation, requiredMB = DEFAULT_MIN_FREE_SPACE_MB) {
  const check = await checkDiskSpaceAvailable(path, requiredMB);
  if (check.sufficient) {
    return {
      ok: true,
      value: true
    };
  }
  return {
    ok: false,
    error: new Error(`Insufficient disk space before ${operation}: ` + `${check.availableMB} MB available, ${requiredMB} MB required`)
  };
}
// =============================================================================
// Internal helpers
// =============================================================================
/** Walk up to the closest existing directory (root fallback). */ function resolveExistingPath(path) {
  let checkPath = path;
  while(checkPath !== "/" && checkPath !== ""){
    try {
      Deno.statSync(checkPath);
      break;
    } catch  {
      const parent = dirname(checkPath);
      if (parent === checkPath) break;
      checkPath = parent;
    }
  }
  if (checkPath === "") checkPath = "/";
  return checkPath;
}
/** Delete and recreate the work directory. */ export async function nukeWorkDir(workDir) {
  // Clear the directory's CONTENTS rather than the directory itself
  // (Issue #4212): since #4203 the work dir is a named-volume mountpoint,
  // which cannot be removed (EBUSY) — the old remove-and-recreate shape
  // swallowed that error and silently nuked nothing in a genuine disk
  // emergency. Reserved entries (the ext4 lost+found, the logs dir, the
  // audit trail and its roster sidecars) are skipped: the worker cannot
  // remove the first and must not remove the rest — a disk emergency is no
  // reason to erase the tamper-evident record of what it did (Issue #337).
  // Per-entry failures are logged loud and never abort the sweep.
  let entries = [];
  try {
    for await (const entry of Deno.readDir(workDir)){
      entries.push(entry);
    }
  } catch  {
    // Directory may not exist — ensureDir below recreates it.
    entries = [];
  }
  for (const entry of entries){
    if (isReservedWorkRootEntry(entry.name)) continue;
    try {
      await Deno.remove(`${workDir}/${entry.name}`, {
        recursive: true
      });
    } catch (err) {
      console.warn(`nukeWorkDir: could not remove ${workDir}/${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await ensureDir(workDir);
}
/** Default tool-availability check via `which`. */ async function defaultToolAvailable(name) {
  const r = await runWithTimeout("which", [
    name
  ], {
    timeoutMs: WHICH_TIMEOUT_MS,
    quiet: true
  });
  return r.ok && !r.value.timedOut && r.value.success;
}
/** Default subprocess runner for reclaim tiers. */ async function defaultRunCommand(executable, args) {
  const r = await runWithTimeout(executable, args, {
    timeoutMs: RECLAIM_SUBPROCESS_TIMEOUT_MS,
    quiet: true
  });
  if (!r.ok) return {
    success: false,
    code: -1
  };
  return {
    success: r.value.success,
    code: r.value.code
  };
}
/**
 * Recursively walk workDir and remove every directory named `node_modules`
 * (without descending into them). Returns the count removed.
 */ async function removeNodeModulesDirs(workDir) {
  let count = 0;
  const queue = [
    workDir
  ];
  while(queue.length > 0){
    const dir = queue.pop();
    let entries;
    try {
      entries = Deno.readDir(dir);
    } catch  {
      continue;
    }
    for await (const entry of entries){
      if (!entry.isDirectory) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.name === "node_modules") {
        try {
          await Deno.remove(path, {
            recursive: true
          });
          count++;
        } catch  {
        // Best-effort — ignore removal failures.
        }
      } else {
        queue.push(path);
      }
    }
  }
  return count;
}
/** Simple dirname implementation (avoids importing std/path). */ function dirname(p) {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx);
}
/** Ensure a directory exists (equivalent to mkdir -p). */ async function ensureDir(dir) {
  try {
    await Deno.mkdir(dir, {
      recursive: true
    });
  } catch (err) {
    // Ignore AlreadyExists
    if (!(err instanceof Deno.errors.AlreadyExists)) {
      throw err;
    }
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9kaXNrX3NwYWNlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRGlzayBzcGFjZSBtYW5hZ2VtZW50IHV0aWxpdGllcyBmb3Igc2VsZi1oZWFsaW5nIHVuYXR0ZW5kZWQgbWFjaGluZXMuXG4gKlxuICogV2hlbiBkaXNrIHByZXNzdXJlIGlzIGRldGVjdGVkICh1c2FnZSA+PSB0aHJlc2hvbGQpLCB0aGUgbW9kdWxlIHJ1bnMgYW5cbiAqIGluY3JlbWVudGFsIHJlY2xhbWF0aW9uIHBhc3MgKERlbm8gY2FjaGUg4oaSIG5wbSBjYWNoZSDihpIgc3RyYXkgbm9kZV9tb2R1bGVzXG4gKiDihpIgcGlwIGNhY2hlIOKGkiBicmV3IGNsZWFudXApLCByZS1jaGVja2luZyBkaXNrIHVzYWdlIGFmdGVyIGVhY2ggdGllciBhbmRcbiAqIGV4aXRpbmcgZWFybHkgb25jZSB0aGUgdGhyZXNob2xkIGlzIG1ldC4gT25seSB3aGVuIGluY3JlbWVudGFsIHJlY2xhaW1cbiAqIGlzIGluc3VmZmljaWVudCBkb2VzIHRoZSB3b3JrIGRpcmVjdG9yeSBnZXQgbnVrZWQgKElzc3VlICMxNDk1KS5cbiAqXG4gKiBNaWdyYXRlZCBmcm9tIHdvcmtlci9zaGFyZWQvZGlza19zcGFjZS5zaCAoSXNzdWUgIzkwMikuXG4gKiBJc3N1ZSAjOTU6IENoZWNrIGRpc2sgc3BhY2Ugb2YgV09SS19ESVIgYXQgc3RhcnR1cC5cbiAqIElzc3VlICMxNDg5OiBDbGVhbiBEZW5vIGNhY2hlIHdoZW4gbG93IG9uIGRpc2sgc3BhY2UuXG4gKiBJc3N1ZSAjMTQ5NTogSW5jcmVtZW50YWwgY2FjaGUgcmVjbGFpbSBiZWZvcmUgV09SS19ESVIgbnVrZS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgcmVjb3JkRmF1bHRFdmVudCB9IGZyb20gXCIuL2ZhdWx0X3RvbGVyYW5jZV9jb3VudGVycy50c1wiO1xuaW1wb3J0IHsgaXNSZXNlcnZlZFdvcmtSb290RW50cnkgfSBmcm9tIFwiLi9zdGFsZV93b3JrZGlyLnRzXCI7XG5pbXBvcnQgeyBydW5XaXRoVGltZW91dCwgdHlwZSBTdWJwcm9jZXNzUmVzdWx0IH0gZnJvbSBcIi4vc3VicHJvY2Vzc190aW1lb3V0LnRzXCI7XG5pbXBvcnQgeyBjbGVhbkRlbm9DYWNoZSBhcyByZWFsQ2xlYW5EZW5vQ2FjaGUgfSBmcm9tIFwiLi9kZW5vX2NhY2hlLnRzXCI7XG5pbXBvcnQgeyBlbWl0U2VsZkhlYWxFdmVudEF1dG8gfSBmcm9tIFwiLi9zZWxmX2hlYWxfZXZlbnRzLnRzXCI7XG5pbXBvcnQgeyBydW5uaW5nSW5Db250YWluZXJJbWFnZSB9IGZyb20gXCIuL2NvbnRhaW5lcl9zdGFtcC50c1wiO1xuXG4vKiogVGltZW91dCBmb3IgZGYgY29tbWFuZHM6IDEwIHNlY29uZHMgKGhhbmRsZXMgTkZTIHN0YWxscykuICovXG5jb25zdCBERl9USU1FT1VUX01TID0gMTBfMDAwO1xuXG4vKiogVGltZW91dCBmb3IgdG9vbCBhdmFpbGFiaWxpdHkgY2hlY2tzIHZpYSBgd2hpY2hgOiA1IHNlY29uZHMuICovXG5jb25zdCBXSElDSF9USU1FT1VUX01TID0gNV8wMDA7XG5cbi8qKiBEZWZhdWx0IHRpbWVvdXQgZm9yIGluY3JlbWVudGFsIHJlY2xhaW0gc3VicHJvY2Vzc2VzOiA2MCBzZWNvbmRzLiAqL1xuY29uc3QgUkVDTEFJTV9TVUJQUk9DRVNTX1RJTUVPVVRfTVMgPSA2MF8wMDA7XG5cbi8qKiBEZWZhdWx0IGFnZ3Jlc3NpdmUgdGhyZXNob2xkOiA5MCUgZGlzayB1c2FnZSB0cmlnZ2VycyB3b3JrRGlyIG51a2UuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9ESVNLX0NMRUFOVVBfVEhSRVNIT0xEID0gOTA7XG5cbi8qKlxuICogRGVmYXVsdCBnZW50bGUgdGhyZXNob2xkOiA4MCUgZGlzayB1c2FnZSB0cmlnZ2VycyB0aGUgaW5jcmVtZW50YWwgcmVjbGFpbVxuICogcGFzcyB3aXRob3V0IG51a2luZyB0aGUgd29yayBkaXJlY3RvcnkgKElzc3VlICMxNDk5KS5cbiAqXG4gKiBUaGUgZ2VudGxlIHBhc3MgdGFyZ2V0cyBjaGVhcC10by1yZWNyZWF0ZSBpdGVtcyAoRGVubyBjYWNoZSwgbnBtIGNhY2hlLFxuICogbm9kZV9tb2R1bGVzLCBwaXAgY2FjaGUsIGJyZXcgY2xlYW51cCkgc28gdGhhdCB3YXJtIGNsb25lZCByZXBvc2l0b3JpZXNcbiAqIGFyZSBwcmVzZXJ2ZWQgZm9yIHRoZSBuZXh0IHJ1biDigJQgcmUtY2xvbmluZyBpcyBleHBlbnNpdmUgaW4gbmV0d29yayBhbmRcbiAqIHRpbWUuIE9ubHkgdGhlIGFnZ3Jlc3NpdmUgdGllciAoc2VlIHtAbGluayBERUZBVUxUX0RJU0tfQ0xFQU5VUF9USFJFU0hPTER9KVxuICogd2lsbCByZW1vdmUgY2xvbmVkIHJlcG9zaXRvcmllcywgYW5kIG9ubHkgd2hlbiB0aGUgZ2VudGxlIHBhc3MgaXMgbm90XG4gKiBlbm91Z2guXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0RJU0tfQ0xFQU5VUF9HRU5UTEVfVEhSRVNIT0xEID0gODA7XG5cbi8qKiBEZWZhdWx0IG1pbmltdW0gZnJlZSBzcGFjZSBpbiBNQiBiZWZvcmUgbGFyZ2UgZ2l0IG9wZXJhdGlvbnMgKElzc3VlICMxMTY4KS4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX01JTl9GUkVFX1NQQUNFX01CID0gNTAwO1xuXG4vKiogTG93ZXN0IHVzYWJsZSBjbGVhbnVwIHRocmVzaG9sZCAoSXNzdWUgIzEyNjgpLiAqL1xuZXhwb3J0IGNvbnN0IERJU0tfQ0xFQU5VUF9USFJFU0hPTERfTUlOID0gMTtcblxuLyoqIEhpZ2hlc3QgdXNhYmxlIGNsZWFudXAgdGhyZXNob2xkIOKAlCBkaXNrIHVzYWdlIGlzIGEgcGVyY2VudGFnZS4gKi9cbmV4cG9ydCBjb25zdCBESVNLX0NMRUFOVVBfVEhSRVNIT0xEX01BWCA9IDEwMDtcblxuLyoqXG4gKiBDaGVjayBhbiBvcGVyYXRvci1zdXBwbGllZCBjbGVhbnVwIHRocmVzaG9sZCAoSXNzdWUgIzEyNjgpLlxuICpcbiAqIEEgdGhyZXNob2xkIG9mIGAwYCByZWFkcyBhcyBcInVzYWdlIGlzIGFsd2F5cyBhdCBvciBhYm92ZSB0aGUgYWdncmVzc2l2ZVxuICogdGhyZXNob2xkXCIsIHNvIGV2ZXJ5IHN0YXJ0IG51a2VkIHRoZSB3b3JrIGRpcmVjdG9yeSBhbmQgZXZlcnkgY2xvbmVkXG4gKiByZXBvc2l0b3J5IG9uIHRoZSB2b2x1bWUgd2l0aCBpdCDigJQgdGhlIG9wcG9zaXRlIG9mIHRoZSBcImRpc2FibGVkXCIgYW5cbiAqIG9wZXJhdG9yIG5hdHVyYWxseSBleHBlY3RzIGAwYCB0byBtZWFuLiBOZWdhdGl2ZSB2YWx1ZXMgYW5kIHZhbHVlcyBhYm92ZVxuICogMTAwIGFyZSBlcXVhbGx5IG1lYW5pbmdsZXNzIGFnYWluc3QgYSB1c2FnZSBwZXJjZW50YWdlLCBhcyBpcyBhIGZyYWN0aW9uLlxuICpcbiAqIEVuZm9yY2VkIGF0IHRoZSBvcGVyYXRvci1mYWNpbmcgYm91bmRhcmllcyDigJQgdGhlIGBkaXNrLXNwYWNlYCBDTEkgYXJncyBhbmRcbiAqIHRoZSBob3VzZWtlZXBpbmcgZW52aXJvbm1lbnQgdmFsdWVzIOKAlCBzbyBhIGJhZCB2YWx1ZSBpcyByZWZ1c2VkIGJlZm9yZSBpdFxuICogY2FuIHJlYWNoIHtAbGluayBjaGVja0FuZENsZWFudXBEaXNrU3BhY2V9LiBUaGVyZSBpcyBubyBcImRpc2FibGVkXCJcbiAqIHNwZWxsaW5nOiBzZXQgdGhlIHRocmVzaG9sZCB0byAxMDAgdG8gbWFrZSB0aGUgYWdncmVzc2l2ZSB0aWVyXG4gKiB1bnJlYWNoYWJsZSBpbiBwcmFjdGljZS5cbiAqXG4gKiBAcGFyYW0gbmFtZSAtIEZsYWcgb3IgdmFyaWFibGUgbmFtZSB0byBuYW1lIGluIHRoZSBmYWlsdXJlIG1lc3NhZ2UuXG4gKiBAcGFyYW0gdmFsdWUgLSBUaGUgc3VwcGxpZWQgdGhyZXNob2xkLlxuICogQHJldHVybnMgYG51bGxgIHdoZW4gdGhlIHZhbHVlIGlzIHVzYWJsZSwgb3RoZXJ3aXNlIHRoZSBmYWlsdXJlIG1lc3NhZ2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUNsZWFudXBUaHJlc2hvbGQoXG4gIG5hbWU6IHN0cmluZyxcbiAgdmFsdWU6IG51bWJlcixcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoXG4gICAgTnVtYmVyLmlzSW50ZWdlcih2YWx1ZSkgJiZcbiAgICB2YWx1ZSA+PSBESVNLX0NMRUFOVVBfVEhSRVNIT0xEX01JTiAmJlxuICAgIHZhbHVlIDw9IERJU0tfQ0xFQU5VUF9USFJFU0hPTERfTUFYXG4gICkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiBgJHtuYW1lfSBtdXN0IGJlICR7RElTS19DTEVBTlVQX1RIUkVTSE9MRF9NSU594oCTYCArXG4gICAgYCR7RElTS19DTEVBTlVQX1RIUkVTSE9MRF9NQVh9ICh3aG9sZSBwZXJjZW50KSwgZ290ICR7dmFsdWV9OiBgICtcbiAgICBgcmVmdXNpbmcgdG8gcnVuIGRpc2sgY2xlYW51cGA7XG59XG5cbi8qKlxuICogUGFyc2UgYW4gb3BlcmF0b3Itc3VwcGxpZWQgdGhyZXNob2xkLCBmcm9tIGEgQ0xJIGFyZ3VtZW50IG9yIGFuXG4gKiBlbnZpcm9ubWVudCBzdHJpbmcgKElzc3VlICMxMjY4KS5cbiAqXG4gKiBgcGFyc2VJbnRgIHJlYWQgYFwiMGFiY1wiYCBhcyBgMGAg4oCUIHRoZSB2ZXJ5IHZhbHVlIHRoYXQgbWFkZSBldmVyeSBzdGFydFxuICogYWdncmVzc2l2ZSDigJQgYW5kIGBcIjl4XCJgIGFzIGA5YCwgc28gYSBwcmVzZW50LWJ1dC11bnJlYWRhYmxlIHZhbHVlIHJldHVybnNcbiAqIGBOYU5gIGhlcmUgYW5kIGlzIHJlZnVzZWQgYnkge0BsaW5rIHZhbGlkYXRlQ2xlYW51cFRocmVzaG9sZH0gcmF0aGVyIHRoYW5cbiAqIHN0YW5kaW5nIGluIGZvciBhIG51bWJlciB0aGUgb3BlcmF0b3IgbmV2ZXIgd3JvdGUuIE9ubHkgYW4gYWJzZW50IHZhbHVlXG4gKiBmYWxscyBiYWNrLlxuICpcbiAqIEBwYXJhbSB2YWx1ZSAtIFRoZSBzdXBwbGllZCB0aHJlc2hvbGQgKENMSSBhcmd1bWVudCBvciBlbnZpcm9ubWVudCBzdHJpbmcpLlxuICogQHBhcmFtIGZhbGxiYWNrIC0gVXNlZCB3aGVuIHRoZSB2YWx1ZSBpcyBhYnNlbnQuXG4gKiBAcmV0dXJucyBUaGUgcGFyc2VkIHRocmVzaG9sZCwgYGZhbGxiYWNrYCB3aGVuIGFic2VudCwgYE5hTmAgd2hlbiB1bnJlYWRhYmxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDbGVhbnVwVGhyZXNob2xkKFxuICB2YWx1ZTogdW5rbm93bixcbiAgZmFsbGJhY2s6IG51bWJlcixcbik6IG51bWJlciB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSBcIlwiKSByZXR1cm4gZmFsbGJhY2s7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwibnVtYmVyXCIpIHJldHVybiB2YWx1ZTtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiAvXlsrLV0/XFxkKyQvLnRlc3QodmFsdWUudHJpbSgpKSkge1xuICAgIHJldHVybiBwYXJzZUludCh2YWx1ZS50cmltKCksIDEwKTtcbiAgfVxuICByZXR1cm4gTmFOO1xufVxuXG4vKiogT3JkZXJlZCBsaXN0IG9mIHJlY2xhaW0gdGllciBuYW1lcy4gKi9cbmV4cG9ydCB0eXBlIFJlY2xhaW1UaWVyTmFtZSA9XG4gIHwgXCJkZW5vLWNhY2hlXCJcbiAgfCBcIm5wbS1jYWNoZVwiXG4gIHwgXCJub2RlLW1vZHVsZXNcIlxuICB8IFwicGlwLWNhY2hlXCJcbiAgfCBcImJyZXctY2xlYW51cFwiO1xuXG4vKiogUmVzdWx0IG9mIGEgc2luZ2xlIHRpZXIgb2YgaW5jcmVtZW50YWwgcmVjbGFpbS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmVjbGFpbVRpZXIge1xuICB0aWVyOiBSZWNsYWltVGllck5hbWU7XG4gIC8qKiBXaGV0aGVyIHRoZSB0aWVyIGFjdHVhbGx5IHJhbiAoZmFsc2UgaWYgdGhlIHRvb2wgd2FzIHVuYXZhaWxhYmxlKS4gKi9cbiAgYXR0ZW1wdGVkOiBib29sZWFuO1xuICAvKiogV2hldGhlciB0aGUgdGllcidzIHJlY2xhaW0gYWN0aW9uIHJldHVybmVkIHN1Y2Nlc3MuICovXG4gIHN1Y2NlZWRlZDogYm9vbGVhbjtcbiAgLyoqIEJ5dGVzIHJlY2xhaW1lZCAoYmVzdC1lZmZvcnQsIGZyb20gZGYgYXZhaWxhYmxlLXNwYWNlIGRpZmYpLiAqL1xuICBieXRlc1JlY2xhaW1lZDogbnVtYmVyO1xuICAvKiogSHVtYW4tcmVhZGFibGUgc3VtbWFyeSBtZXNzYWdlLiAqL1xuICBtZXNzYWdlOiBzdHJpbmc7XG59XG5cbi8qKiBSZXN1bHQgb2YgcnVubmluZyB0aGUgaW5jcmVtZW50YWwgcmVjbGFpbSBwYXNzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBJbmNyZW1lbnRhbFJlY2xhaW1SZXN1bHQge1xuICAvKiogVGllcnMgdGhhdCB3ZXJlIGF0dGVtcHRlZCBvciBleHBsaWNpdGx5IHNraXBwZWQsIGluIGV4ZWN1dGlvbiBvcmRlci4gKi9cbiAgdGllcnM6IFJlY2xhaW1UaWVyW107XG4gIC8qKiBXaGV0aGVyIGRpc2sgdXNhZ2UgZHJvcHBlZCBiZWxvdyB0aGUgdGhyZXNob2xkIGR1cmluZyByZWNsYWltLiAqL1xuICB0aHJlc2hvbGRNZXQ6IGJvb2xlYW47XG4gIC8qKiBGaW5hbCBkaXNrIHVzYWdlIHBlcmNlbnRhZ2Ugb2JzZXJ2ZWQgKG51bGwgaWYgZGYgY291bGQgbm90IGJlIHJlYWQpLiAqL1xuICBmaW5hbFVzYWdlUGVyY2VudDogbnVtYmVyIHwgbnVsbDtcbiAgLyoqIFN1bSBvZiBieXRlc1JlY2xhaW1lZCBhY3Jvc3MgYXR0ZW1wdGVkIHRpZXJzLiAqL1xuICB0b3RhbEJ5dGVzUmVjbGFpbWVkOiBudW1iZXI7XG59XG5cbi8qKiBNaW5pbWFsIHN1YnByb2Nlc3MgcmVzdWx0IHVzZWQgYnkgdGhlIHJlY2xhaW0gY29tbWFuZCBpbmplY3Rpb24uICovXG5leHBvcnQgaW50ZXJmYWNlIFJlY2xhaW1Db21tYW5kUmVzdWx0IHtcbiAgc3VjY2VzczogYm9vbGVhbjtcbiAgY29kZTogbnVtYmVyO1xufVxuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIGluY3JlbWVudGFsUmVjbGFpbX0uICovXG5leHBvcnQgaW50ZXJmYWNlIEluY3JlbWVudGFsUmVjbGFpbU9wdGlvbnMge1xuICAvKiogV29yayBkaXJlY3RvcnkgdW5kZXIgd2hpY2ggdG8gcmVtb3ZlIHN0cmF5IG5vZGVfbW9kdWxlcy4gKi9cbiAgd29ya0Rpcjogc3RyaW5nO1xuICAvKiogVXNhZ2UgdGhyZXNob2xkICgwLTEwMCk7IGxvb3AgZXhpdHMgb25jZSB1c2FnZSBkcm9wcyBiZWxvdyBpdC4gKi9cbiAgdGhyZXNob2xkPzogbnVtYmVyO1xuXG4gIC8vIC0tLS0gVGVzdCAvIGludGVncmF0aW9uIGluamVjdGlvbiBob29rcy4gUHJvZHVjdGlvbiBjb2RlIHVzZXMgZGVmYXVsdHMuIC0tLS1cbiAgLyoqIE92ZXJyaWRlIGRpc2sgdXNhZ2UgcGVyY2VudGFnZSBwcm9iZSAoZGVmYXVsdHMgdG8ge0BsaW5rIGdldERpc2tVc2FnZVBlcmNlbnR9KS4gKi9cbiAgY2hlY2tVc2FnZT86IChwYXRoOiBzdHJpbmcpID0+IFByb21pc2U8bnVtYmVyIHwgbnVsbD47XG4gIC8qKiBPdmVycmlkZSBhdmFpbGFibGUtS0IgcHJvYmUgdXNlZCB0byBjb21wdXRlIGJ5dGVzIHJlY2xhaW1lZC4gKi9cbiAgY2hlY2tBdmFpbGFibGVLQj86IChwYXRoOiBzdHJpbmcpID0+IFByb21pc2U8bnVtYmVyIHwgbnVsbD47XG4gIC8qKiBPdmVycmlkZSB0b29sLWF2YWlsYWJpbGl0eSBjaGVjayAoZGVmYXVsdHMgdG8gYHdoaWNoIDxuYW1lPmApLiAqL1xuICB0b29sQXZhaWxhYmxlPzogKG5hbWU6IHN0cmluZykgPT4gUHJvbWlzZTxib29sZWFuPjtcbiAgLyoqIE92ZXJyaWRlIHN1YnByb2Nlc3MgcnVubmVyIGZvciBucG0vcGlwL2JyZXcgaW52b2NhdGlvbnMuICovXG4gIHJ1bkNvbW1hbmQ/OiAoXG4gICAgZXhlY3V0YWJsZTogc3RyaW5nLFxuICAgIGFyZ3M6IHN0cmluZ1tdLFxuICApID0+IFByb21pc2U8UmVjbGFpbUNvbW1hbmRSZXN1bHQ+O1xuICAvKiogT3ZlcnJpZGUgRGVubyBjYWNoZSBjbGVhbmVyIChkZWZhdWx0cyB0byB7QGxpbmsgY2xlYW5EZW5vQ2FjaGV9KS4gKi9cbiAgY2xlYW5EZW5vQ2FjaGU/OiAoKSA9PiBQcm9taXNlPHsgc3VjY2VzczogYm9vbGVhbjsgbWVzc2FnZTogc3RyaW5nIH0+O1xuICAvKiogT3ZlcnJpZGUgT1MgZGV0ZWN0aW9uIOKAlCB0cnVlIHRyZWF0cyBob3N0IGFzIG1hY09TIGZvciB0aGUgYnJldyB0aWVyLiAqL1xuICBmb3JjZU1hY09TPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBXaGljaCBjbGVhbnVwIHRpZXIgd2FzIGVuZ2FnZWQgYnkge0BsaW5rIGNoZWNrQW5kQ2xlYW51cERpc2tTcGFjZX1cbiAqIChJc3N1ZSAjMTQ5OSk6XG4gKlxuICogICAtIFwibm9uZVwiICAgICAgIOKAlCB1c2FnZSBiZWxvdyB0aGUgZ2VudGxlIHRocmVzaG9sZCwgbm90aGluZyBkb25lLlxuICogICAtIFwiZ2VudGxlXCIgICAgIOKAlCBpbmNyZW1lbnRhbCByZWNsYWltIG9ubHk7IGNsb25lZCByZXBvcyBwcmVzZXJ2ZWQuXG4gKiAgIC0gXCJhZ2dyZXNzaXZlXCIg4oCUIGluY3JlbWVudGFsIHJlY2xhaW0gcGx1cyB3b3JrRGlyIG51a2UgaWYgcmVjbGFpbVxuICogICAgICAgICAgICAgICAgICAgIHdhcyBpbnN1ZmZpY2llbnQuXG4gKi9cbmV4cG9ydCB0eXBlIERpc2tDbGVhbnVwVGllciA9IFwibm9uZVwiIHwgXCJnZW50bGVcIiB8IFwiYWdncmVzc2l2ZVwiO1xuXG4vKiogUmVzdWx0IG9mIGEgZGlzayBzcGFjZSBjaGVjay4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGlza0NoZWNrUmVzdWx0IHtcbiAgLyoqIERpc2sgdXNhZ2UgcGVyY2VudGFnZSB0aGF0IHdhcyBvYnNlcnZlZC4gKi9cbiAgdXNhZ2VQZXJjZW50OiBudW1iZXI7XG4gIC8qKiBUaGUgYWdncmVzc2l2ZSB0aHJlc2hvbGQgdGhhdCB3YXMgYXBwbGllZC4gKi9cbiAgdGhyZXNob2xkOiBudW1iZXI7XG4gIC8qKiBUaGUgZ2VudGxlIHRocmVzaG9sZCB0aGF0IHdhcyBhcHBsaWVkIChJc3N1ZSAjMTQ5OSkuICovXG4gIGdlbnRsZVRocmVzaG9sZDogbnVtYmVyO1xuICAvKiogV2hpY2ggY2xlYW51cCB0aWVyIHdhcyBlbmdhZ2VkIChJc3N1ZSAjMTQ5OSkuICovXG4gIHRpZXI6IERpc2tDbGVhbnVwVGllcjtcbiAgLyoqIFdoZXRoZXIgY2xlYW51cCB3YXMgcGVyZm9ybWVkICh3b3JrRGlyIG51a2UpLiAqL1xuICBjbGVhbmVkVXA6IGJvb2xlYW47XG4gIC8qKiBXaGV0aGVyIHRoZSBEZW5vIGRvd25sb2FkIGNhY2hlIHdhcyBjbGVhbmVkIChJc3N1ZSAjMTQ4OSkuICovXG4gIGRlbm9DYWNoZUNsZWFuZWQ6IGJvb2xlYW47XG4gIC8qKiBSZXN1bHQgb2YgdGhlIGluY3JlbWVudGFsIHJlY2xhaW0gcGFzcywgaWYgaXQgcmFuIChJc3N1ZSAjMTQ5NSkuICovXG4gIGluY3JlbWVudGFsUmVjbGFpbT86IEluY3JlbWVudGFsUmVjbGFpbVJlc3VsdDtcbiAgLyoqIEh1bWFuLXJlYWRhYmxlIHN1bW1hcnkgbWVzc2FnZS4gKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xufVxuXG4vKiogT3B0aW9ucyBmb3IgdGhlIGRpc2sgc3BhY2UgY2hlY2suICovXG5leHBvcnQgaW50ZXJmYWNlIERpc2tDaGVja09wdGlvbnMge1xuICAvKiogRGlyZWN0b3J5IHRvIGNoZWNrIGFuZCBwb3RlbnRpYWxseSBjbGVhbiB1cCAodXN1YWxseSBXT1JLX0RJUikuICovXG4gIHdvcmtEaXI6IHN0cmluZztcbiAgLyoqIEFnZ3Jlc3NpdmUgcGVyY2VudGFnZSB0aHJlc2hvbGQgKDAtMTAwKS4gRGVmYXVsdHMgdG8gOTAuICovXG4gIHRocmVzaG9sZD86IG51bWJlcjtcbiAgLyoqXG4gICAqIEdlbnRsZSBwZXJjZW50YWdlIHRocmVzaG9sZCAoMC0xMDApLiBXaGVuIHVzYWdlIGlzIGF0IG9yIGFib3ZlIHRoaXNcbiAgICogYnV0IGJlbG93IHtAbGluayB0aHJlc2hvbGR9LCBvbmx5IHRoZSBpbmNyZW1lbnRhbCByZWNsYWltIHBhc3MgcnVucyDigJRcbiAgICogdGhlIHdvcmsgZGlyZWN0b3J5IGlzIG5ldmVyIG51a2VkLiBEZWZhdWx0cyB0byBgdGhyZXNob2xkYCAoaS5lLiBub1xuICAgKiBnZW50bGUgdGllcikgZm9yIGJhY2t3YXJkcyBjb21wYXRpYmlsaXR5OyBjYWxsZXJzIHNob3VsZCBwYXNzXG4gICAqIHtAbGluayBERUZBVUxUX0RJU0tfQ0xFQU5VUF9HRU5UTEVfVEhSRVNIT0xEfSAoODApIHRvIG9wdCBpbi5cbiAgICogVmFsdWVzIGFib3ZlIGB0aHJlc2hvbGRgIGFyZSBjbGFtcGVkIHRvIGB0aHJlc2hvbGRgIChJc3N1ZSAjMTQ5OSkuXG4gICAqL1xuICBnZW50bGVUaHJlc2hvbGQ/OiBudW1iZXI7XG4gIC8qKlxuICAgKiBMZWdhY3kgaGVybWV0aWMgdGVzdCBmbGFnIChJc3N1ZSAjMTQ4OSk6IHdoZW4gdHJ1ZSwgYnlwYXNzZXMgdGhlXG4gICAqIGluY3JlbWVudGFsIHJlY2xhaW0gcGFzcyBlbnRpcmVseSBhbmQgZ29lcyBzdHJhaWdodCB0byB0aGUgd29ya0RpclxuICAgKiBudWtlLiBQcmVzZXJ2ZWQgc28gZXhpc3RpbmcgdGVzdHMgc3RheSBoZXJtZXRpYyB3aXRob3V0IGludm9raW5nXG4gICAqIGBkZW5vIGNsZWFuYCwgbnBtLCBwaXAsIG9yIGJyZXcgb24gdGhlIGhvc3QuXG4gICAqL1xuICBza2lwRGVub0NhY2hlPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIE92ZXJyaWRlIGluamVjdGlvbiBob29rcyBmb3IgaW5jcmVtZW50YWwgcmVjbGFpbSAoSXNzdWUgIzE0OTUpLiBVc2VkXG4gICAqIGJ5IHRlc3RzIHRvIHNpbXVsYXRlIHRvb2wgYXZhaWxhYmlsaXR5LCB1c2FnZSBjdXJ2ZXMsIGFuZCBzdWJwcm9jZXNzXG4gICAqIG91dGNvbWVzIHdpdGhvdXQgdG91Y2hpbmcgdGhlIGhvc3QuXG4gICAqL1xuICByZWNsYWltT3ZlcnJpZGVzPzogUGFydGlhbDxJbmNyZW1lbnRhbFJlY2xhaW1PcHRpb25zPjtcbiAgLyoqXG4gICAqIFRlc3Qtb25seSBvdmVycmlkZSBmb3IgdGhlIE9VVEVSIHVzYWdlIHByb2JlIChJc3N1ZSAjMTU0OSBwcmVyZXEpLlxuICAgKiBXaGVuIHN1cHBsaWVkLCByZXBsYWNlcyB0aGUgY2FsbCB0byBgZ2V0RGlza1VzYWdlUGVyY2VudGAgdGhhdFxuICAgKiBkZWNpZGVzIHdoaWNoIHRpZXIgKG5vbmUvZ2VudGxlL2FnZ3Jlc3NpdmUpIHRvIHJ1bi4gVGhlIGlubmVyXG4gICAqIGluY3JlbWVudGFsIHJlY2xhaW0gY29udGludWVzIHRvIHVzZSBgcmVjbGFpbU92ZXJyaWRlcy5jaGVja1VzYWdlYFxuICAgKiBzbyB0ZXN0cyBjYW4gbW9kZWwgdGhlIHVzYWdlIHRyYWplY3RvcnkgdGhyb3VnaCB0aGUgcmVjbGFpbSBsb29wXG4gICAqIGluZGVwZW5kZW50bHkuIFByb2R1Y3Rpb24gY29kZSBuZXZlciBzZXRzIHRoaXMuXG4gICAqL1xuICBvdXRlckNoZWNrVXNhZ2U/OiAocGF0aDogc3RyaW5nKSA9PiBQcm9taXNlPG51bWJlciB8IG51bGw+O1xuICAvKiogSW5qZWN0YWJsZSBlbnZpcm9ubWVudCBsb29rdXAgKHRlc3RzIGluamVjdCBhIGZpeGVkIG1hcCkuICovXG4gIGVudj86IChuYW1lOiBzdHJpbmcpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEluamVjdGFibGUgZnJlZS1ieXRlcyBwcm9iZSAodGVzdHMgbW9kZWwgaG9zdCBmcmVlIHNwYWNlKS4gKi9cbiAgZnJlZUJ5dGVzUHJvYmU/OiAocGF0aDogc3RyaW5nKSA9PiBQcm9taXNlPG51bWJlciB8IG51bGw+O1xufVxuXG4vKipcbiAqIEZyZWUtc3BhY2UgZmxvb3IgYmVsb3cgd2hpY2ggdGhlIGluLWNvbnRhaW5lciB3b3JrRGlyIG51a2UgaXMgcGVybWl0dGVkXG4gKiAoSXNzdWUgIzQxNjQpLiBJbnNpZGUgdGhlIGNvbnRhaW5lciB0aGUgbWVhc3VyZWQgZmlsZXN5c3RlbSBpcyB0aGUgSE9TVFxuICogdm9sdW1lIHNlZW4gdGhyb3VnaCB0aGUgbW91bnQsIHNvIGEgcGVyY2VudGFnZSB0aHJlc2hvbGQgaXMgY2hyb25pY2FsbHlcbiAqIGV4Y2VlZGVkIG9uIGEgbGFyZ2UgZGlzayB3aGlsZSB0aGUgd29yayBkaXJlY3RvcnkgaXRzZWxmIG1heSBob2xkIGFsbW9zdFxuICogbm90aGluZyDigJQgb2JzZXJ2ZWQgbGl2ZTogYSA0IEtCIHdvcmsgZGlyZWN0b3J5IGRlbGV0ZWQgYW5kIHJlY3JlYXRlZCBvblxuICogZXZlcnkgY3ljbGUgYXQgXCI5MiUgdXNhZ2VcIiBvZiBhIDQ2MCBHQiB2b2x1bWUuIE9ubHkgZ2VudWluZWx5IGNyaXRpY2FsXG4gKiBhYnNvbHV0ZSBmcmVlIHNwYWNlIGp1c3RpZmllcyBkZXN0cm95aW5nIHRoZSBjbG9uZSBjYWNoZS5cbiAqL1xuZXhwb3J0IGNvbnN0IENPTlRBSU5FUl9OVUtFX0ZSRUVfQllURVNfRkxPT1IgPSA1ICogMTAyNCAqKiAzO1xuXG4vKipcbiAqIEdldCBkaXNrIHVzYWdlIHBlcmNlbnRhZ2UgZm9yIHRoZSBmaWxlc3lzdGVtIGNvbnRhaW5pbmcgdGhlIGdpdmVuIHBhdGguXG4gKlxuICogVXNlcyBgZGYgLVBgIChQT1NJWCBmb3JtYXQpIGZvciBjcm9zcy1wbGF0Zm9ybSBjb21wYXRpYmlsaXR5LlxuICogSWYgdGhlIHBhdGggZG9lcyBub3QgZXhpc3QsIHdhbGtzIHVwIHRvIHRoZSBjbG9zZXN0IGV4aXN0aW5nIHBhcmVudC5cbiAqXG4gKiBAcmV0dXJucyBVc2FnZSBwZXJjZW50YWdlICgwLTEwMCksIG9yIG51bGwgaWYgaXQgY2Fubm90IGJlIGRldGVybWluZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXREaXNrVXNhZ2VQZXJjZW50KFxuICBwYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgY29uc3QgY2hlY2tQYXRoID0gcmVzb2x2ZUV4aXN0aW5nUGF0aChwYXRoKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5XaXRoVGltZW91dChcImRmXCIsIFtcIi1QXCIsIGNoZWNrUGF0aF0sIHtcbiAgICB0aW1lb3V0TXM6IERGX1RJTUVPVVRfTVMsXG4gIH0pO1xuXG4gIGlmICghcmVzdWx0Lm9rIHx8IHJlc3VsdC52YWx1ZS50aW1lZE91dCB8fCAhcmVzdWx0LnZhbHVlLnN1Y2Nlc3MpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IGxpbmVzID0gcmVzdWx0LnZhbHVlLnN0ZG91dC5zcGxpdChcIlxcblwiKTtcbiAgY29uc3QgZGF0YUxpbmUgPSBsaW5lc1sxXTtcbiAgaWYgKGRhdGFMaW5lID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuXG4gIC8vIFBPU0lYIGRmIC1QIGZvcm1hdDogRmlsZXN5c3RlbSAxMDI0LWJsb2NrcyBVc2VkIEF2YWlsYWJsZSBDYXBhY2l0eSBNb3VudGVkXG4gIGNvbnN0IGZpZWxkcyA9IGRhdGFMaW5lLnRyaW0oKS5zcGxpdCgvXFxzKy8pO1xuICBjb25zdCBjYXBhY2l0eUZpZWxkID0gZmllbGRzWzRdO1xuICBpZiAoY2FwYWNpdHlGaWVsZCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBjYXBhY2l0eVN0ciA9IGNhcGFjaXR5RmllbGQucmVwbGFjZSgvJS8sIFwiXCIpO1xuICBjb25zdCB1c2FnZSA9IHBhcnNlSW50KGNhcGFjaXR5U3RyLCAxMCk7XG5cbiAgaWYgKGlzTmFOKHVzYWdlKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB1c2FnZTtcbn1cblxuLyoqXG4gKiBGcmVlIGJ5dGVzIG9uIHRoZSBmaWxlc3lzdGVtIGNvbnRhaW5pbmcgYHBhdGhgIChJc3N1ZSAjNDE2NCkuXG4gKlxuICogU2FtZSBgZGYgLVBgIHByb2JlIGFzIHtAbGluayBnZXREaXNrVXNhZ2VQZXJjZW50fSwgcmVhZGluZyB0aGUgQXZhaWxhYmxlXG4gKiBjb2x1bW4gKDEwMjQtYnl0ZSBibG9ja3MpLlxuICpcbiAqIEByZXR1cm5zIEZyZWUgYnl0ZXMsIG9yIG51bGwgaWYgdGhleSBjYW5ub3QgYmUgZGV0ZXJtaW5lZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldERpc2tGcmVlQnl0ZXMocGF0aDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIGNvbnN0IGNoZWNrUGF0aCA9IHJlc29sdmVFeGlzdGluZ1BhdGgocGF0aCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuV2l0aFRpbWVvdXQoXCJkZlwiLCBbXCItUFwiLCBjaGVja1BhdGhdLCB7XG4gICAgdGltZW91dE1zOiBERl9USU1FT1VUX01TLFxuICB9KTtcblxuICBpZiAoIXJlc3VsdC5vayB8fCByZXN1bHQudmFsdWUudGltZWRPdXQgfHwgIXJlc3VsdC52YWx1ZS5zdWNjZXNzKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBjb25zdCBkYXRhTGluZSA9IHJlc3VsdC52YWx1ZS5zdGRvdXQuc3BsaXQoXCJcXG5cIilbMV07XG4gIGlmIChkYXRhTGluZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbnVsbDtcblxuICAvLyBQT1NJWCBkZiAtUCBmb3JtYXQ6IEZpbGVzeXN0ZW0gMTAyNC1ibG9ja3MgVXNlZCBBdmFpbGFibGUgQ2FwYWNpdHkgTW91bnRlZFxuICBjb25zdCBhdmFpbGFibGVGaWVsZCA9IGRhdGFMaW5lLnRyaW0oKS5zcGxpdCgvXFxzKy8pWzNdO1xuICBpZiAoYXZhaWxhYmxlRmllbGQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgYXZhaWxhYmxlS2IgPSBwYXJzZUludChhdmFpbGFibGVGaWVsZCwgMTApO1xuICBpZiAoaXNOYU4oYXZhaWxhYmxlS2IpKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGF2YWlsYWJsZUtiICogMTAyNDtcbn1cblxuLyoqXG4gKiBJbmplY3RhYmxlIGBkZmAgcnVubmVyICh0ZXN0IHNlYW0pLiBNYXRjaGVzIHRoZSB7QGxpbmsgcnVuV2l0aFRpbWVvdXR9XG4gKiBzaWduYXR1cmUgc28gcHJvZHVjdGlvbiBjYW4gcGFzcyBpdCBkaXJlY3RseSBhbmQgdGVzdHMgY2FuIHN1cHBseSBhIGZha2VcbiAqIHRoYXQgcmV0dXJucyBmaXh0dXJlIGBkZiAtUGtgIG91dHB1dCB3aXRob3V0IHNwYXduaW5nIGEgc3VicHJvY2Vzcy5cbiAqL1xuZXhwb3J0IHR5cGUgRGZSdW5uZXIgPSAoXG4gIGV4ZWN1dGFibGU6IHN0cmluZyxcbiAgYXJnczogc3RyaW5nW10sXG4gIG9wdGlvbnM6IHsgY3dkPzogc3RyaW5nOyB0aW1lb3V0TXM6IG51bWJlcjsgcXVpZXQ/OiBib29sZWFuIH0sXG4pID0+IFByb21pc2U8UmVzdWx0PFN1YnByb2Nlc3NSZXN1bHQ+PjtcblxuLyoqXG4gKiBHZXQgYXZhaWxhYmxlIGRpc2sgc3BhY2UgaW4gS0IgZm9yIHRoZSBmaWxlc3lzdGVtIGNvbnRhaW5pbmcgdGhlIGdpdmVuIHBhdGguXG4gKlxuICogVXNlZCBieSB7QGxpbmsgaW5jcmVtZW50YWxSZWNsYWltfSB0byBjb21wdXRlIHBlci10aWVyIGJ5dGVzLXJlY2xhaW1lZC5cbiAqXG4gKiBAcGFyYW0gcGF0aCAtIEZpbGVzeXN0ZW0gcGF0aCB0byBwcm9iZSAod2Fsa3MgdXAgdG8gdGhlIGNsb3Nlc3QgcGFyZW50KS5cbiAqIEBwYXJhbSBydW4gLSBTdWJwcm9jZXNzIHJ1bm5lciAodGVzdCBzZWFtOyBkZWZhdWx0cyB0byB7QGxpbmsgcnVuV2l0aFRpbWVvdXR9KS5cbiAqIEByZXR1cm5zIEF2YWlsYWJsZSBraWxvYnl0ZXMsIG9yIG51bGwgb24gdGltZW91dC9mYWlsdXJlL3VucGFyc2VhYmxlIG91dHB1dC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldERpc2tBdmFpbGFibGVLQihcbiAgcGF0aDogc3RyaW5nLFxuICBydW46IERmUnVubmVyID0gcnVuV2l0aFRpbWVvdXQsXG4pOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgY29uc3QgY2hlY2tQYXRoID0gcmVzb2x2ZUV4aXN0aW5nUGF0aChwYXRoKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW4oXCJkZlwiLCBbXCItUGtcIiwgY2hlY2tQYXRoXSwge1xuICAgIHRpbWVvdXRNczogREZfVElNRU9VVF9NUyxcbiAgfSk7XG5cbiAgaWYgKCFyZXN1bHQub2sgfHwgcmVzdWx0LnZhbHVlLnRpbWVkT3V0IHx8ICFyZXN1bHQudmFsdWUuc3VjY2Vzcykge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3QgbGluZXMgPSByZXN1bHQudmFsdWUuc3Rkb3V0LnNwbGl0KFwiXFxuXCIpO1xuICBjb25zdCBkYXRhTGluZSA9IGxpbmVzWzFdO1xuICBpZiAoZGF0YUxpbmUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgZmllbGRzID0gZGF0YUxpbmUudHJpbSgpLnNwbGl0KC9cXHMrLyk7XG4gIGNvbnN0IGF2YWlsRmllbGQgPSBmaWVsZHNbM107XG4gIGlmIChhdmFpbEZpZWxkID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGF2YWlsS0IgPSBwYXJzZUludChhdmFpbEZpZWxkLCAxMCk7XG4gIHJldHVybiBpc05hTihhdmFpbEtCKSA/IG51bGwgOiBhdmFpbEtCO1xufVxuXG4vKipcbiAqIFJ1biBpbmNyZW1lbnRhbCByZWNsYWltIHRpZXJzIHVudGlsIGRpc2sgdXNhZ2UgZHJvcHMgYmVsb3cgdGhyZXNob2xkLlxuICpcbiAqIFRpZXJzIHJ1biBpbiB0aGlzIG9yZGVyLCB3aXRoIGFuIGVhcmx5LWV4aXQgY2hlY2sgYWZ0ZXIgZWFjaDpcbiAqICAgMS4gRGVubyBjYWNoZSAoYGRlbm8gY2xlYW5gKVxuICogICAyLiBgbnBtIGNhY2hlIGNsZWFuIC0tZm9yY2VgIChpZiBucG0gaXMgb24gUEFUSClcbiAqICAgMy4gUmVtb3ZlIHN0cmF5IGBub2RlX21vZHVsZXMvYCBkaXJlY3RvcmllcyB1bmRlciB3b3JrRGlyXG4gKiAgIDQuIGBwaXAgY2FjaGUgcHVyZ2VgIChpZiBwaXAgaXMgb24gUEFUSClcbiAqICAgNS4gYGJyZXcgY2xlYW51cCAtc2AgKG1hY09TIG9ubHksIGlmIGJyZXcgaXMgb24gUEFUSClcbiAqXG4gKiBNaXNzaW5nIHRvb2xzIGFyZSBza2lwcGVkIGdyYWNlZnVsbHkuIEVhY2ggYXR0ZW1wdGVkIHRpZXIgbG9ncyBhXG4gKiBgU0VMRi1IRUFMSU5HYCBlbnRyeSB3aXRoIHRoZSBieXRlcyByZWNsYWltZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbmNyZW1lbnRhbFJlY2xhaW0oXG4gIG9wdGlvbnM6IEluY3JlbWVudGFsUmVjbGFpbU9wdGlvbnMsXG4pOiBQcm9taXNlPEluY3JlbWVudGFsUmVjbGFpbVJlc3VsdD4ge1xuICBjb25zdCB7XG4gICAgd29ya0RpcixcbiAgICB0aHJlc2hvbGQgPSBERUZBVUxUX0RJU0tfQ0xFQU5VUF9USFJFU0hPTEQsXG4gIH0gPSBvcHRpb25zO1xuXG4gIGNvbnN0IGNoZWNrVXNhZ2UgPSBvcHRpb25zLmNoZWNrVXNhZ2UgPz8gZ2V0RGlza1VzYWdlUGVyY2VudDtcbiAgY29uc3QgY2hlY2tBdmFpbGFibGVLQiA9IG9wdGlvbnMuY2hlY2tBdmFpbGFibGVLQiA/PyBnZXREaXNrQXZhaWxhYmxlS0I7XG4gIGNvbnN0IHRvb2xBdmFpbGFibGUgPSBvcHRpb25zLnRvb2xBdmFpbGFibGUgPz8gZGVmYXVsdFRvb2xBdmFpbGFibGU7XG4gIGNvbnN0IHJ1bkNvbW1hbmQgPSBvcHRpb25zLnJ1bkNvbW1hbmQgPz8gZGVmYXVsdFJ1bkNvbW1hbmQ7XG4gIGNvbnN0IGNsZWFuRGVub0NhY2hlID0gb3B0aW9ucy5jbGVhbkRlbm9DYWNoZSA/PyAoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHIgPSBhd2FpdCByZWFsQ2xlYW5EZW5vQ2FjaGUoKTtcbiAgICByZXR1cm4geyBzdWNjZXNzOiByLnN1Y2Nlc3MsIG1lc3NhZ2U6IHIubWVzc2FnZSB9O1xuICB9KTtcbiAgY29uc3QgaXNNYWNPUyA9IG9wdGlvbnMuZm9yY2VNYWNPUyA/PyAoRGVuby5idWlsZC5vcyA9PT0gXCJkYXJ3aW5cIik7XG5cbiAgY29uc3QgdGllcnM6IFJlY2xhaW1UaWVyW10gPSBbXTtcbiAgbGV0IHRvdGFsQnl0ZXNSZWNsYWltZWQgPSAwO1xuICBsZXQgY3VycmVudFVzYWdlOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuICBjb25zdCByZWNvcmRBdHRlbXB0ID0gYXN5bmMgKFxuICAgIHRpZXI6IFJlY2xhaW1UaWVyTmFtZSxcbiAgICBkZXNjcmlwdGlvbjogc3RyaW5nLFxuICAgIHJ1bjogKCkgPT4gUHJvbWlzZTx7IHN1Y2Nlc3M6IGJvb2xlYW47IG1lc3NhZ2U6IHN0cmluZyB9PixcbiAgKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgY29uc3QgYmVmb3JlS0IgPSBhd2FpdCBjaGVja0F2YWlsYWJsZUtCKHdvcmtEaXIpO1xuICAgIGNvbnN0IG91dGNvbWUgPSBhd2FpdCBydW4oKTtcbiAgICBjb25zdCBhZnRlcktCID0gYXdhaXQgY2hlY2tBdmFpbGFibGVLQih3b3JrRGlyKTtcblxuICAgIGNvbnN0IGJ5dGVzUmVjbGFpbWVkID1cbiAgICAgIGJlZm9yZUtCICE9PSBudWxsICYmIGFmdGVyS0IgIT09IG51bGwgJiYgYWZ0ZXJLQiA+IGJlZm9yZUtCXG4gICAgICAgID8gKGFmdGVyS0IgLSBiZWZvcmVLQikgKiAxMDI0XG4gICAgICAgIDogMDtcbiAgICB0b3RhbEJ5dGVzUmVjbGFpbWVkICs9IGJ5dGVzUmVjbGFpbWVkO1xuXG4gICAgdGllcnMucHVzaCh7XG4gICAgICB0aWVyLFxuICAgICAgYXR0ZW1wdGVkOiB0cnVlLFxuICAgICAgc3VjY2VlZGVkOiBvdXRjb21lLnN1Y2Nlc3MsXG4gICAgICBieXRlc1JlY2xhaW1lZCxcbiAgICAgIG1lc3NhZ2U6IGAke2Rlc2NyaXB0aW9ufSDigJQgJHtvdXRjb21lLm1lc3NhZ2V9YCxcbiAgICB9KTtcblxuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFNFTEYtSEVBTElORzogJHtkZXNjcmlwdGlvbn0gcmVjbGFpbWVkICR7Ynl0ZXNSZWNsYWltZWR9IGJ5dGVzICgke1xuICAgICAgICBvdXRjb21lLnN1Y2Nlc3MgPyBcIm9rXCIgOiBcImZhaWxlZFwiXG4gICAgICB9KWAsXG4gICAgKTtcbiAgICByZWNvcmRGYXVsdEV2ZW50KFxuICAgICAgXCJkaXNrX3NwYWNlX2NsZWFudXBcIixcbiAgICAgIGAke3RpZXJ9OiByZWNsYWltZWQgJHtieXRlc1JlY2xhaW1lZH0gYnl0ZXMgKCR7XG4gICAgICAgIG91dGNvbWUuc3VjY2VzcyA/IFwib2tcIiA6IFwiZmFpbGVkXCJcbiAgICAgIH0pYCxcbiAgICApO1xuICAgIGF3YWl0IGVtaXRTZWxmSGVhbEV2ZW50QXV0byh7XG4gICAgICBtb2R1bGU6IFwiZGlza19zcGFjZVwiLFxuICAgICAgYWN0aW9uOiBgcmVjbGFpbV8ke3RpZXJ9YCxcbiAgICAgIHJlYXNvbjogZGVzY3JpcHRpb24sXG4gICAgICByZXN1bHQ6IG91dGNvbWUuc3VjY2VzcyA/IFwib2tcIiA6IFwiZmFpbGVkXCIsXG4gICAgICBieXRlc1JlY2xhaW1lZCxcbiAgICB9LCB3b3JrRGlyKTtcbiAgfTtcblxuICBjb25zdCByZWNvcmRTa2lwID0gYXN5bmMgKFxuICAgIHRpZXI6IFJlY2xhaW1UaWVyTmFtZSxcbiAgICBkZXNjcmlwdGlvbjogc3RyaW5nLFxuICAgIHJlYXNvbjogc3RyaW5nLFxuICApOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICB0aWVycy5wdXNoKHtcbiAgICAgIHRpZXIsXG4gICAgICBhdHRlbXB0ZWQ6IGZhbHNlLFxuICAgICAgc3VjY2VlZGVkOiBmYWxzZSxcbiAgICAgIGJ5dGVzUmVjbGFpbWVkOiAwLFxuICAgICAgbWVzc2FnZTogYCR7ZGVzY3JpcHRpb259IOKAlCBza2lwcGVkICgke3JlYXNvbn0pYCxcbiAgICB9KTtcbiAgICBjb25zb2xlLmxvZyhgU0VMRi1IRUFMSU5HOiAke2Rlc2NyaXB0aW9ufSBza2lwcGVkICgke3JlYXNvbn0pYCk7XG4gICAgYXdhaXQgZW1pdFNlbGZIZWFsRXZlbnRBdXRvKHtcbiAgICAgIG1vZHVsZTogXCJkaXNrX3NwYWNlXCIsXG4gICAgICBhY3Rpb246IGByZWNsYWltXyR7dGllcn1gLFxuICAgICAgcmVhc29uOiBgJHtkZXNjcmlwdGlvbn0gc2tpcHBlZDogJHtyZWFzb259YCxcbiAgICAgIHJlc3VsdDogXCJza2lwcGVkXCIsXG4gICAgfSwgd29ya0Rpcik7XG4gIH07XG5cbiAgY29uc3QgaXNUaHJlc2hvbGRNZXQgPSAoKTogYm9vbGVhbiA9PlxuICAgIGN1cnJlbnRVc2FnZSAhPT0gbnVsbCAmJiBjdXJyZW50VXNhZ2UgPCB0aHJlc2hvbGQ7XG5cbiAgLy8gVGllciAxOiBEZW5vIGNhY2hlLlxuICBhd2FpdCByZWNvcmRBdHRlbXB0KFwiZGVuby1jYWNoZVwiLCBcImRlbm8gY2xlYW5cIiwgY2xlYW5EZW5vQ2FjaGUpO1xuICBjdXJyZW50VXNhZ2UgPSBhd2FpdCBjaGVja1VzYWdlKHdvcmtEaXIpO1xuICBpZiAoaXNUaHJlc2hvbGRNZXQoKSkgcmV0dXJuIGZpbmFsaXNlKCk7XG5cbiAgLy8gVGllciAyOiBucG0gY2FjaGUgY2xlYW4gLS1mb3JjZS5cbiAgaWYgKGF3YWl0IHRvb2xBdmFpbGFibGUoXCJucG1cIikpIHtcbiAgICBhd2FpdCByZWNvcmRBdHRlbXB0KFwibnBtLWNhY2hlXCIsIFwibnBtIGNhY2hlIGNsZWFuIC0tZm9yY2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgciA9IGF3YWl0IHJ1bkNvbW1hbmQoXCJucG1cIiwgW1wiY2FjaGVcIiwgXCJjbGVhblwiLCBcIi0tZm9yY2VcIl0pO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2Vzczogci5zdWNjZXNzLFxuICAgICAgICBtZXNzYWdlOiByLnN1Y2Nlc3MgPyBcImNsZWFuZWRcIiA6IGBleGl0ICR7ci5jb2RlfWAsXG4gICAgICB9O1xuICAgIH0pO1xuICAgIGN1cnJlbnRVc2FnZSA9IGF3YWl0IGNoZWNrVXNhZ2Uod29ya0Rpcik7XG4gICAgaWYgKGlzVGhyZXNob2xkTWV0KCkpIHJldHVybiBmaW5hbGlzZSgpO1xuICB9IGVsc2Uge1xuICAgIGF3YWl0IHJlY29yZFNraXAoXG4gICAgICBcIm5wbS1jYWNoZVwiLFxuICAgICAgXCJucG0gY2FjaGUgY2xlYW4gLS1mb3JjZVwiLFxuICAgICAgXCJucG0gbm90IGF2YWlsYWJsZVwiLFxuICAgICk7XG4gIH1cblxuICAvLyBUaWVyIDM6IHJlbW92ZSBzdHJheSBub2RlX21vZHVsZXMgZGlyZWN0b3JpZXMgdW5kZXIgd29ya0Rpci5cbiAgYXdhaXQgcmVjb3JkQXR0ZW1wdChcIm5vZGUtbW9kdWxlc1wiLCBcInJlbW92ZSBzdHJheSBub2RlX21vZHVsZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJlbW92ZWQgPSBhd2FpdCByZW1vdmVOb2RlTW9kdWxlc0RpcnMod29ya0Rpcik7XG4gICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgbWVzc2FnZTogYCR7cmVtb3ZlZH0gZGlyZWN0b3JpZXMgcmVtb3ZlZGAgfTtcbiAgfSk7XG4gIGN1cnJlbnRVc2FnZSA9IGF3YWl0IGNoZWNrVXNhZ2Uod29ya0Rpcik7XG4gIGlmIChpc1RocmVzaG9sZE1ldCgpKSByZXR1cm4gZmluYWxpc2UoKTtcblxuICAvLyBUaWVyIDQ6IHBpcCBjYWNoZSBwdXJnZS5cbiAgaWYgKGF3YWl0IHRvb2xBdmFpbGFibGUoXCJwaXBcIikpIHtcbiAgICBhd2FpdCByZWNvcmRBdHRlbXB0KFwicGlwLWNhY2hlXCIsIFwicGlwIGNhY2hlIHB1cmdlXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBydW5Db21tYW5kKFwicGlwXCIsIFtcImNhY2hlXCIsIFwicHVyZ2VcIl0pO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2Vzczogci5zdWNjZXNzLFxuICAgICAgICBtZXNzYWdlOiByLnN1Y2Nlc3MgPyBcImNsZWFuZWRcIiA6IGBleGl0ICR7ci5jb2RlfWAsXG4gICAgICB9O1xuICAgIH0pO1xuICAgIGN1cnJlbnRVc2FnZSA9IGF3YWl0IGNoZWNrVXNhZ2Uod29ya0Rpcik7XG4gICAgaWYgKGlzVGhyZXNob2xkTWV0KCkpIHJldHVybiBmaW5hbGlzZSgpO1xuICB9IGVsc2Uge1xuICAgIGF3YWl0IHJlY29yZFNraXAoXCJwaXAtY2FjaGVcIiwgXCJwaXAgY2FjaGUgcHVyZ2VcIiwgXCJwaXAgbm90IGF2YWlsYWJsZVwiKTtcbiAgfVxuXG4gIC8vIFRpZXIgNTogYnJldyBjbGVhbnVwIC1zIChtYWNPUyBvbmx5KS5cbiAgaWYgKCFpc01hY09TKSB7XG4gICAgYXdhaXQgcmVjb3JkU2tpcChcImJyZXctY2xlYW51cFwiLCBcImJyZXcgY2xlYW51cCAtc1wiLCBcIm5vdCBtYWNPU1wiKTtcbiAgfSBlbHNlIGlmICghKGF3YWl0IHRvb2xBdmFpbGFibGUoXCJicmV3XCIpKSkge1xuICAgIGF3YWl0IHJlY29yZFNraXAoXCJicmV3LWNsZWFudXBcIiwgXCJicmV3IGNsZWFudXAgLXNcIiwgXCJicmV3IG5vdCBhdmFpbGFibGVcIik7XG4gIH0gZWxzZSB7XG4gICAgYXdhaXQgcmVjb3JkQXR0ZW1wdChcImJyZXctY2xlYW51cFwiLCBcImJyZXcgY2xlYW51cCAtc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gYXdhaXQgcnVuQ29tbWFuZChcImJyZXdcIiwgW1wiY2xlYW51cFwiLCBcIi1zXCJdKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN1Y2Nlc3M6IHIuc3VjY2VzcyxcbiAgICAgICAgbWVzc2FnZTogci5zdWNjZXNzID8gXCJjbGVhbmVkXCIgOiBgZXhpdCAke3IuY29kZX1gLFxuICAgICAgfTtcbiAgICB9KTtcbiAgICBjdXJyZW50VXNhZ2UgPSBhd2FpdCBjaGVja1VzYWdlKHdvcmtEaXIpO1xuICB9XG5cbiAgcmV0dXJuIGZpbmFsaXNlKCk7XG5cbiAgZnVuY3Rpb24gZmluYWxpc2UoKTogSW5jcmVtZW50YWxSZWNsYWltUmVzdWx0IHtcbiAgICByZXR1cm4ge1xuICAgICAgdGllcnMsXG4gICAgICB0aHJlc2hvbGRNZXQ6IGlzVGhyZXNob2xkTWV0KCksXG4gICAgICBmaW5hbFVzYWdlUGVyY2VudDogY3VycmVudFVzYWdlLFxuICAgICAgdG90YWxCeXRlc1JlY2xhaW1lZCxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgZGlzayBzcGFjZSBhbmQgY2xlYW4gdXAgdGhlIHdvcmsgZGlyZWN0b3J5IGJhc2VkIG9uIGEgdHdvLXRpZXJcbiAqIHBvbGljeSAoSXNzdWUgIzE0OTkpOlxuICpcbiAqICAgLSBVc2FnZSA8IGdlbnRsZVRocmVzaG9sZDogbm8gYWN0aW9uLlxuICogICAtIGdlbnRsZVRocmVzaG9sZCDiiaQgVXNhZ2UgPCB0aHJlc2hvbGQ6IGdlbnRsZSB0aWVyIOKAlCBydW5cbiAqICAgICB7QGxpbmsgaW5jcmVtZW50YWxSZWNsYWltfSBvbmx5LiBDbG9uZWQgcmVwb3NpdG9yaWVzIGFyZSBwcmVzZXJ2ZWRcbiAqICAgICB0byBhdm9pZCB0aGUgbmV0d29yay90aW1lIGNvc3Qgb2YgcmUtY2xvbmluZyBvbiB0aGUgbmV4dCBydW4uXG4gKiAgIC0gVXNhZ2Ug4omlIHRocmVzaG9sZDogYWdncmVzc2l2ZSB0aWVyIOKAlCBydW4gaW5jcmVtZW50YWwgcmVjbGFpbSwgYW5kXG4gKiAgICAgaWYgdGhhdCBpcyBpbnN1ZmZpY2llbnQsIGRlbGV0ZSBhbmQgcmVjcmVhdGUgdGhlIHdvcmsgZGlyZWN0b3J5LlxuICpcbiAqIFdoZW4gYHNraXBEZW5vQ2FjaGU6IHRydWVgIGlzIHNldCwgdGhlIGluY3JlbWVudGFsIHBhc3MgaXMgYnlwYXNzZWRcbiAqIGVudGlyZWx5IGFuZCB3b3JrRGlyIGlzIG51a2VkIGRpcmVjdGx5IChvbmx5IGluIHRoZSBhZ2dyZXNzaXZlIHRpZXIpIOKAlFxuICogdGhpcyBwcmVzZXJ2ZXMgdGhlIGhlcm1ldGljIGxlZ2FjeSB0ZXN0IHBhdGggKElzc3VlICMxNDg5KS5cbiAqXG4gKiBJZiBgZ2VudGxlVGhyZXNob2xkYCBpcyBvbWl0dGVkLCBpdCBkZWZhdWx0cyB0byBgdGhyZXNob2xkYCAoaS5lLiBub1xuICogZ2VudGxlIHRpZXIpIHRvIHByZXNlcnZlIGJhY2t3YXJkcyBjb21wYXRpYmlsaXR5IHdpdGggY2FsbGVycyB0aGF0XG4gKiBoYXZlIG5vdCBiZWVuIHVwZGF0ZWQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjaGVja0FuZENsZWFudXBEaXNrU3BhY2UoXG4gIG9wdGlvbnM6IERpc2tDaGVja09wdGlvbnMsXG4pOiBQcm9taXNlPERpc2tDaGVja1Jlc3VsdD4ge1xuICBjb25zdCB7XG4gICAgd29ya0RpcixcbiAgICB0aHJlc2hvbGQgPSBERUZBVUxUX0RJU0tfQ0xFQU5VUF9USFJFU0hPTEQsXG4gICAgc2tpcERlbm9DYWNoZSA9IGZhbHNlLFxuICAgIHJlY2xhaW1PdmVycmlkZXMsXG4gIH0gPSBvcHRpb25zO1xuXG4gIC8vIENsYW1wIGdlbnRsZVRocmVzaG9sZCB0byB0aHJlc2hvbGQgdG8gcHJldmVudCBtaXNjb25maWd1cmF0aW9uIGZyb21cbiAgLy8gbWFza2luZyBhbiBhZ2dyZXNzaXZlLXRpZXIgY29uZGl0aW9uIChJc3N1ZSAjMTQ5OSkuXG4gIGNvbnN0IGdlbnRsZVRocmVzaG9sZCA9IE1hdGgubWluKFxuICAgIG9wdGlvbnMuZ2VudGxlVGhyZXNob2xkID8/IHRocmVzaG9sZCxcbiAgICB0aHJlc2hvbGQsXG4gICk7XG5cbiAgaWYgKCF3b3JrRGlyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHVzYWdlUGVyY2VudDogMCxcbiAgICAgIHRocmVzaG9sZCxcbiAgICAgIGdlbnRsZVRocmVzaG9sZCxcbiAgICAgIHRpZXI6IFwibm9uZVwiLFxuICAgICAgY2xlYW5lZFVwOiBmYWxzZSxcbiAgICAgIGRlbm9DYWNoZUNsZWFuZWQ6IGZhbHNlLFxuICAgICAgbWVzc2FnZTogXCJObyBkaXJlY3Rvcnkgc3BlY2lmaWVkIGZvciBkaXNrIHNwYWNlIGNoZWNrXCIsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHByb2JlID0gb3B0aW9ucy5vdXRlckNoZWNrVXNhZ2UgPz8gZ2V0RGlza1VzYWdlUGVyY2VudDtcbiAgY29uc3QgdXNhZ2VQZXJjZW50ID0gYXdhaXQgcHJvYmUod29ya0Rpcik7XG5cbiAgaWYgKHVzYWdlUGVyY2VudCA9PT0gbnVsbCkge1xuICAgIC8vIENhbm5vdCBkZXRlcm1pbmUgdXNhZ2Ug4oCUIGVuc3VyZSBkaXJlY3RvcnkgZXhpc3RzIGFuZCBjb250aW51ZVxuICAgIGF3YWl0IGVuc3VyZURpcih3b3JrRGlyKTtcbiAgICByZXR1cm4ge1xuICAgICAgdXNhZ2VQZXJjZW50OiAwLFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgZ2VudGxlVGhyZXNob2xkLFxuICAgICAgdGllcjogXCJub25lXCIsXG4gICAgICBjbGVhbmVkVXA6IGZhbHNlLFxuICAgICAgZGVub0NhY2hlQ2xlYW5lZDogZmFsc2UsXG4gICAgICBtZXNzYWdlOiBcIkNvdWxkIG5vdCBkZXRlcm1pbmUgZGlzayB1c2FnZSwgc2tpcHBpbmcgY2xlYW51cFwiLFxuICAgIH07XG4gIH1cblxuICBpZiAodXNhZ2VQZXJjZW50IDwgZ2VudGxlVGhyZXNob2xkKSB7XG4gICAgLy8gQmVsb3cgZ2VudGxlIHRocmVzaG9sZCDigJQgbm8gYWN0aW9uLCBqdXN0IGVuc3VyZSBkaXJlY3RvcnkgZXhpc3RzLlxuICAgIGF3YWl0IGVuc3VyZURpcih3b3JrRGlyKTtcbiAgICByZXR1cm4ge1xuICAgICAgdXNhZ2VQZXJjZW50LFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgZ2VudGxlVGhyZXNob2xkLFxuICAgICAgdGllcjogXCJub25lXCIsXG4gICAgICBjbGVhbmVkVXA6IGZhbHNlLFxuICAgICAgZGVub0NhY2hlQ2xlYW5lZDogZmFsc2UsXG4gICAgICBtZXNzYWdlOiBgRGlzayB1c2FnZSAke3VzYWdlUGVyY2VudH0lIGlzIGJlbG93IGdlbnRsZSB0aHJlc2hvbGQgYCArXG4gICAgICAgIGAke2dlbnRsZVRocmVzaG9sZH0lLCBubyBjbGVhbnVwIG5lZWRlZGAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGlzQWdncmVzc2l2ZSA9IHVzYWdlUGVyY2VudCA+PSB0aHJlc2hvbGQ7XG5cbiAgLy8gQ29udGFpbmVyIGd1YXJkIChJc3N1ZSAjNDE2NCksIGV2YWx1YXRlZCBiZWZvcmUgRUlUSEVSIG51a2UgcGF0aDogb25seSBhXG4gIC8vIGdlbnVpbmVseSBjcml0aWNhbCBhbW91bnQgb2YgYWJzb2x1dGUgZnJlZSBzcGFjZSBqdXN0aWZpZXMgZGVzdHJveWluZ1xuICAvLyB0aGUgY2xvbmUgY2FjaGUg4oCUIHRoZSBwZXJjZW50YWdlIGFsb25lIHJlZmxlY3RzIHRoZSB3aG9sZSBob3N0IHZvbHVtZVxuICAvLyBzZWVuIHRocm91Z2ggdGhlIG1vdW50LCBub3QgdGhlIHdvcmsgZGlyZWN0b3J5J3MgY29udHJpYnV0aW9uIHRvIGl0LlxuICBsZXQgY29udGFpbmVyUHJlc2VydmVNZXNzYWdlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgZW52TG9va3VwID0gb3B0aW9ucy5lbnYgPz8gKChuYW1lOiBzdHJpbmcpID0+IERlbm8uZW52LmdldChuYW1lKSk7XG4gIGlmIChpc0FnZ3Jlc3NpdmUgJiYgcnVubmluZ0luQ29udGFpbmVySW1hZ2UoZW52TG9va3VwKSkge1xuICAgIGNvbnN0IHByb2JlID0gb3B0aW9ucy5mcmVlQnl0ZXNQcm9iZSA/PyBnZXREaXNrRnJlZUJ5dGVzO1xuICAgIGNvbnN0IGZyZWVCeXRlcyA9IGF3YWl0IHByb2JlKHdvcmtEaXIpO1xuICAgIGlmIChmcmVlQnl0ZXMgPT09IG51bGwgfHwgZnJlZUJ5dGVzID49IENPTlRBSU5FUl9OVUtFX0ZSRUVfQllURVNfRkxPT1IpIHtcbiAgICAgIGNvbnN0IGZyZWVHYiA9IGZyZWVCeXRlcyA9PT0gbnVsbFxuICAgICAgICA/IFwidW5rbm93blwiXG4gICAgICAgIDogKGZyZWVCeXRlcyAvIDEwMjQgKiogMykudG9GaXhlZCgxKTtcbiAgICAgIGNvbnRhaW5lclByZXNlcnZlTWVzc2FnZSA9XG4gICAgICAgIGBEaXNrIHVzYWdlICR7dXNhZ2VQZXJjZW50fSUgPj0gdGhyZXNob2xkICR7dGhyZXNob2xkfSUsIGJ1dCBgICtcbiAgICAgICAgYCR7ZnJlZUdifSBHaUIgZnJlZSBvbiB0aGUgaG9zdCB2b2x1bWUg4oCUIHByZXNlcnZpbmcgJHt3b3JrRGlyfSBgICtcbiAgICAgICAgYChJc3N1ZSAjNDE2NDogdGhlIHByZXNzdXJlIGlzIGhvc3Qtd2lkZSwgbm90IHRoZSB3b3JrIGRpcmVjdG9yeSkuIGAgK1xuICAgICAgICBgVGhlIG51a2Ugb25seSBwcm9jZWVkcyBiZWxvdyBgICtcbiAgICAgICAgYCR7Q09OVEFJTkVSX05VS0VfRlJFRV9CWVRFU19GTE9PUiAvIDEwMjQgKiogM30gR2lCIGZyZWUuYDtcbiAgICB9XG4gIH1cblxuICAvLyBBZ2dyZXNzaXZlIGxlZ2FjeSBoZXJtZXRpYyBwYXRoOiBza2lwIHJlY2xhaW0sIG51a2UgZGlyZWN0bHkuXG4gIGlmIChpc0FnZ3Jlc3NpdmUgJiYgc2tpcERlbm9DYWNoZSkge1xuICAgIGlmIChjb250YWluZXJQcmVzZXJ2ZU1lc3NhZ2UgIT09IG51bGwpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHVzYWdlUGVyY2VudCxcbiAgICAgICAgdGhyZXNob2xkLFxuICAgICAgICBnZW50bGVUaHJlc2hvbGQsXG4gICAgICAgIHRpZXI6IFwiYWdncmVzc2l2ZVwiLFxuICAgICAgICBjbGVhbmVkVXA6IGZhbHNlLFxuICAgICAgICBkZW5vQ2FjaGVDbGVhbmVkOiBmYWxzZSxcbiAgICAgICAgbWVzc2FnZTogY29udGFpbmVyUHJlc2VydmVNZXNzYWdlLFxuICAgICAgfTtcbiAgICB9XG4gICAgYXdhaXQgbnVrZVdvcmtEaXIod29ya0Rpcik7XG4gICAgcmVjb3JkRmF1bHRFdmVudChcbiAgICAgIFwiZGlza19zcGFjZV9jbGVhbnVwXCIsXG4gICAgICBgRGlzayBhdCAke3VzYWdlUGVyY2VudH0lIG9uICR7d29ya0Rpcn0sIGNsZWFuZWQgdXAgKGxlZ2FjeSBwYXRoKWAsXG4gICAgKTtcbiAgICBhd2FpdCBlbWl0U2VsZkhlYWxFdmVudEF1dG8oe1xuICAgICAgbW9kdWxlOiBcImRpc2tfc3BhY2VcIixcbiAgICAgIGFjdGlvbjogXCJ0aHJlc2hvbGRfY2xlYW51cFwiLFxuICAgICAgcmVhc29uOiBgdXNhZ2UgJHt1c2FnZVBlcmNlbnR9JSA+PSAke3RocmVzaG9sZH0lIChsZWdhY3kgbnVrZSlgLFxuICAgICAgcmVzdWx0OiBcIm9rXCIsXG4gICAgfSwgd29ya0Rpcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHVzYWdlUGVyY2VudCxcbiAgICAgIHRocmVzaG9sZCxcbiAgICAgIGdlbnRsZVRocmVzaG9sZCxcbiAgICAgIHRpZXI6IFwiYWdncmVzc2l2ZVwiLFxuICAgICAgY2xlYW5lZFVwOiB0cnVlLFxuICAgICAgZGVub0NhY2hlQ2xlYW5lZDogZmFsc2UsXG4gICAgICBtZXNzYWdlOiBgRGlzayB1c2FnZSAke3VzYWdlUGVyY2VudH0lID49IHRocmVzaG9sZCAke3RocmVzaG9sZH0lLiBgICtcbiAgICAgICAgYERlbGV0ZWQgYW5kIHJlY3JlYXRlZCAke3dvcmtEaXJ9LmAsXG4gICAgfTtcbiAgfVxuXG4gIC8vIFJ1biBpbmNyZW1lbnRhbCByZWNsYWltIChhcHBsaWVzIHRvIGJvdGggZ2VudGxlIGFuZCBhZ2dyZXNzaXZlIHRpZXJzKS5cbiAgY29uc3QgcmVjbGFpbVRhcmdldCA9IGlzQWdncmVzc2l2ZSA/IHRocmVzaG9sZCA6IGdlbnRsZVRocmVzaG9sZDtcbiAgY29uc3QgcmVjbGFpbSA9IGF3YWl0IGluY3JlbWVudGFsUmVjbGFpbSh7XG4gICAgd29ya0RpcixcbiAgICB0aHJlc2hvbGQ6IHJlY2xhaW1UYXJnZXQsXG4gICAgLi4ucmVjbGFpbU92ZXJyaWRlcyxcbiAgfSk7XG5cbiAgY29uc3QgZGVub0NhY2hlQ2xlYW5lZCA9IHJlY2xhaW0udGllcnMuc29tZShcbiAgICAodCkgPT4gdC50aWVyID09PSBcImRlbm8tY2FjaGVcIiAmJiB0LmF0dGVtcHRlZCAmJiB0LnN1Y2NlZWRlZCxcbiAgKTtcblxuICAvLyBHZW50bGUgdGllcjogbmV2ZXIgbnVrZSwgcmVnYXJkbGVzcyBvZiB3aGV0aGVyIHJlY2xhaW0gY2xlYXJlZCBwcmVzc3VyZS5cbiAgaWYgKCFpc0FnZ3Jlc3NpdmUpIHtcbiAgICBjb25zdCBhdHRlbXB0ZWQgPSByZWNsYWltLnRpZXJzLmZpbHRlcigodCkgPT4gdC5hdHRlbXB0ZWQpLmxlbmd0aDtcbiAgICByZXR1cm4ge1xuICAgICAgdXNhZ2VQZXJjZW50LFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgZ2VudGxlVGhyZXNob2xkLFxuICAgICAgdGllcjogXCJnZW50bGVcIixcbiAgICAgIGNsZWFuZWRVcDogZmFsc2UsXG4gICAgICBkZW5vQ2FjaGVDbGVhbmVkLFxuICAgICAgaW5jcmVtZW50YWxSZWNsYWltOiByZWNsYWltLFxuICAgICAgbWVzc2FnZTpcbiAgICAgICAgYERpc2sgdXNhZ2UgJHt1c2FnZVBlcmNlbnR9JSA+PSBnZW50bGUgdGhyZXNob2xkICR7Z2VudGxlVGhyZXNob2xkfSUgYCArXG4gICAgICAgIGAoPCBhZ2dyZXNzaXZlICR7dGhyZXNob2xkfSUpLiBHZW50bGUgaW5jcmVtZW50YWwgcmVjbGFpbSBmcmVlZCBgICtcbiAgICAgICAgYCR7cmVjbGFpbS50b3RhbEJ5dGVzUmVjbGFpbWVkfSBieXRlcyBhY3Jvc3MgJHthdHRlbXB0ZWR9IHRpZXIocyk7IGAgK1xuICAgICAgICBgY2xvbmVkIHJlcG9zaXRvcmllcyBwcmVzZXJ2ZWQuYCxcbiAgICB9O1xuICB9XG5cbiAgLy8gQWdncmVzc2l2ZSB0aWVyOiBpZiByZWNsYWltIHN1Y2NlZWRlZCwgbm8gbnVrZS5cbiAgaWYgKHJlY2xhaW0udGhyZXNob2xkTWV0KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHVzYWdlUGVyY2VudCxcbiAgICAgIHRocmVzaG9sZCxcbiAgICAgIGdlbnRsZVRocmVzaG9sZCxcbiAgICAgIHRpZXI6IFwiYWdncmVzc2l2ZVwiLFxuICAgICAgY2xlYW5lZFVwOiBmYWxzZSxcbiAgICAgIGRlbm9DYWNoZUNsZWFuZWQsXG4gICAgICBpbmNyZW1lbnRhbFJlY2xhaW06IHJlY2xhaW0sXG4gICAgICBtZXNzYWdlOiBgSW5jcmVtZW50YWwgcmVjbGFpbSBzdWNjZWVkZWQgb24gJHt3b3JrRGlyfTogZnJlZWQgYCArXG4gICAgICAgIGAke3JlY2xhaW0udG90YWxCeXRlc1JlY2xhaW1lZH0gYnl0ZXMgYWNyb3NzIGAgK1xuICAgICAgICBgJHtyZWNsYWltLnRpZXJzLmZpbHRlcigodCkgPT4gdC5hdHRlbXB0ZWQpLmxlbmd0aH0gdGllcihzKTsgYCArXG4gICAgICAgIGB1c2FnZSBub3cgJHtyZWNsYWltLmZpbmFsVXNhZ2VQZXJjZW50ID8/IFwidW5rbm93blwifSUuYCxcbiAgICB9O1xuICB9XG5cbiAgLy8gQWdncmVzc2l2ZSBmYWxsLXRocm91Z2g6IGluY3JlbWVudGFsIHJlY2xhaW0gaW5zdWZmaWNpZW50LiBUaGVcbiAgLy8gY29udGFpbmVyIGd1YXJkIGFib3ZlIG1heSB2ZXRvIHRoZSBudWtlIChJc3N1ZSAjNDE2NCkuXG4gIGlmIChjb250YWluZXJQcmVzZXJ2ZU1lc3NhZ2UgIT09IG51bGwpIHtcbiAgICByZXR1cm4ge1xuICAgICAgdXNhZ2VQZXJjZW50LFxuICAgICAgdGhyZXNob2xkLFxuICAgICAgZ2VudGxlVGhyZXNob2xkLFxuICAgICAgdGllcjogXCJhZ2dyZXNzaXZlXCIsXG4gICAgICBjbGVhbmVkVXA6IGZhbHNlLFxuICAgICAgZGVub0NhY2hlQ2xlYW5lZCxcbiAgICAgIGluY3JlbWVudGFsUmVjbGFpbTogcmVjbGFpbSxcbiAgICAgIG1lc3NhZ2U6IGNvbnRhaW5lclByZXNlcnZlTWVzc2FnZSxcbiAgICB9O1xuICB9XG5cbiAgYXdhaXQgbnVrZVdvcmtEaXIod29ya0Rpcik7XG4gIHJlY29yZEZhdWx0RXZlbnQoXG4gICAgXCJkaXNrX3NwYWNlX2NsZWFudXBcIixcbiAgICBgRGlzayBhdCAke3VzYWdlUGVyY2VudH0lIG9uICR7d29ya0Rpcn0sIGluY3JlbWVudGFsIHJlY2xhaW0gaW5zdWZmaWNpZW50LCBudWtlZGAsXG4gICk7XG4gIGF3YWl0IGVtaXRTZWxmSGVhbEV2ZW50QXV0byh7XG4gICAgbW9kdWxlOiBcImRpc2tfc3BhY2VcIixcbiAgICBhY3Rpb246IFwidGhyZXNob2xkX2NsZWFudXBcIixcbiAgICByZWFzb246IGB1c2FnZSAke3VzYWdlUGVyY2VudH0lID49ICR7dGhyZXNob2xkfSUsIHJlY2xhaW0gaW5zdWZmaWNpZW50YCxcbiAgICByZXN1bHQ6IFwib2tcIixcbiAgICBieXRlc1JlY2xhaW1lZDogcmVjbGFpbS50b3RhbEJ5dGVzUmVjbGFpbWVkLFxuICB9LCB3b3JrRGlyKTtcbiAgcmV0dXJuIHtcbiAgICB1c2FnZVBlcmNlbnQsXG4gICAgdGhyZXNob2xkLFxuICAgIGdlbnRsZVRocmVzaG9sZCxcbiAgICB0aWVyOiBcImFnZ3Jlc3NpdmVcIixcbiAgICBjbGVhbmVkVXA6IHRydWUsXG4gICAgZGVub0NhY2hlQ2xlYW5lZCxcbiAgICBpbmNyZW1lbnRhbFJlY2xhaW06IHJlY2xhaW0sXG4gICAgbWVzc2FnZTogYERpc2sgdXNhZ2UgJHt1c2FnZVBlcmNlbnR9JSA+PSB0aHJlc2hvbGQgJHt0aHJlc2hvbGR9JS4gYCArXG4gICAgICBgSW5jcmVtZW50YWwgcmVjbGFpbSBpbnN1ZmZpY2llbnQgKGZyZWVkICR7cmVjbGFpbS50b3RhbEJ5dGVzUmVjbGFpbWVkfSBieXRlcykuIGAgK1xuICAgICAgYERlbGV0ZWQgYW5kIHJlY3JlYXRlZCAke3dvcmtEaXJ9LmAsXG4gIH07XG59XG5cbi8qKiBSZXN1bHQgb2YgYSBkaXNrIHNwYWNlIGF2YWlsYWJpbGl0eSBwcmUtY2hlY2sgKElzc3VlICMxMTY4KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRGlza0F2YWlsYWJpbGl0eVJlc3VsdCB7XG4gIC8qKiBBdmFpbGFibGUgZGlzayBzcGFjZSBpbiBNQi4gKi9cbiAgYXZhaWxhYmxlTUI6IG51bWJlcjtcbiAgLyoqIFJlcXVpcmVkIG1pbmltdW0gZnJlZSBzcGFjZSBpbiBNQi4gKi9cbiAgcmVxdWlyZWRNQjogbnVtYmVyO1xuICAvKiogV2hldGhlciBzdWZmaWNpZW50IHNwYWNlIGlzIGF2YWlsYWJsZS4gKi9cbiAgc3VmZmljaWVudDogYm9vbGVhbjtcbiAgLyoqIEh1bWFuLXJlYWRhYmxlIHN1bW1hcnkgbWVzc2FnZS4gKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgc3VmZmljaWVudCBkaXNrIHNwYWNlIGlzIGF2YWlsYWJsZSBiZWZvcmUgYSBsYXJnZVxuICogZ2l0IG9wZXJhdGlvbiAoY2xvbmUsIGZldGNoLCBjaGVja291dCkg4oCUIElzc3VlICMxMTY4LlxuICpcbiAqIFVzZXMgYGRmIC1QYCB0byByZWFkIGF2YWlsYWJsZSBibG9ja3MgYW5kIGNvbnZlcnRzIHRvIE1CLlxuICogSWYgdGhlIHBhdGggZG9lcyBub3QgZXhpc3QsIHdhbGtzIHVwIHRvIHRoZSBjbG9zZXN0IGV4aXN0aW5nIHBhcmVudC5cbiAqXG4gKiBAcGFyYW0gcGF0aCAtIEZpbGVzeXN0ZW0gcGF0aCB0byBjaGVjayAodXN1YWxseSB0aGUgd29yayBkaXJlY3RvcnkpLlxuICogQHBhcmFtIHJlcXVpcmVkTUIgLSBNaW5pbXVtIGZyZWUgc3BhY2UgaW4gTUIgKGRlZmF1bHQ6IDUwMCkuXG4gKiBAcmV0dXJucyBSZXN1bHQgaW5kaWNhdGluZyB3aGV0aGVyIHN1ZmZpY2llbnQgc3BhY2UgaXMgYXZhaWxhYmxlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2hlY2tEaXNrU3BhY2VBdmFpbGFibGUoXG4gIHBhdGg6IHN0cmluZyxcbiAgcmVxdWlyZWRNQjogbnVtYmVyID0gREVGQVVMVF9NSU5fRlJFRV9TUEFDRV9NQixcbik6IFByb21pc2U8RGlza0F2YWlsYWJpbGl0eVJlc3VsdD4ge1xuICBjb25zdCBjaGVja1BhdGggPSByZXNvbHZlRXhpc3RpbmdQYXRoKHBhdGgpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bldpdGhUaW1lb3V0KFwiZGZcIiwgW1wiLVBcIiwgY2hlY2tQYXRoXSwge1xuICAgIHRpbWVvdXRNczogREZfVElNRU9VVF9NUyxcbiAgfSk7XG5cbiAgaWYgKCFyZXN1bHQub2sgfHwgcmVzdWx0LnZhbHVlLnRpbWVkT3V0IHx8ICFyZXN1bHQudmFsdWUuc3VjY2Vzcykge1xuICAgIHJldHVybiB7XG4gICAgICBhdmFpbGFibGVNQjogMCxcbiAgICAgIHJlcXVpcmVkTUIsXG4gICAgICBzdWZmaWNpZW50OiBmYWxzZSxcbiAgICAgIG1lc3NhZ2U6IFwiQ291bGQgbm90IGRldGVybWluZSBhdmFpbGFibGUgZGlzayBzcGFjZVwiLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBsaW5lcyA9IHJlc3VsdC52YWx1ZS5zdGRvdXQuc3BsaXQoXCJcXG5cIik7XG4gIGlmIChsaW5lcy5sZW5ndGggPCAyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGF2YWlsYWJsZU1COiAwLFxuICAgICAgcmVxdWlyZWRNQixcbiAgICAgIHN1ZmZpY2llbnQ6IGZhbHNlLFxuICAgICAgbWVzc2FnZTogXCJVbmV4cGVjdGVkIGRmIG91dHB1dCBmb3JtYXRcIixcbiAgICB9O1xuICB9XG5cbiAgLy8gUE9TSVggZGYgLVAgZm9ybWF0OiBGaWxlc3lzdGVtIDEwMjQtYmxvY2tzIFVzZWQgQXZhaWxhYmxlIENhcGFjaXR5IE1vdW50ZWRcbiAgY29uc3QgZGF0YUxpbmUgPSBsaW5lc1sxXSE7XG4gIGNvbnN0IGZpZWxkcyA9IGRhdGFMaW5lLnRyaW0oKS5zcGxpdCgvXFxzKy8pO1xuICBpZiAoZmllbGRzLmxlbmd0aCA8IDQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgYXZhaWxhYmxlTUI6IDAsXG4gICAgICByZXF1aXJlZE1CLFxuICAgICAgc3VmZmljaWVudDogZmFsc2UsXG4gICAgICBtZXNzYWdlOiBcIlVuZXhwZWN0ZWQgZGYgb3V0cHV0IGZvcm1hdFwiLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBhdmFpbGFibGVLQiA9IHBhcnNlSW50KGZpZWxkc1szXSEsIDEwKTtcbiAgaWYgKGlzTmFOKGF2YWlsYWJsZUtCKSkge1xuICAgIHJldHVybiB7XG4gICAgICBhdmFpbGFibGVNQjogMCxcbiAgICAgIHJlcXVpcmVkTUIsXG4gICAgICBzdWZmaWNpZW50OiBmYWxzZSxcbiAgICAgIG1lc3NhZ2U6IFwiQ291bGQgbm90IHBhcnNlIGF2YWlsYWJsZSBkaXNrIHNwYWNlXCIsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGF2YWlsYWJsZU1CID0gTWF0aC5mbG9vcihhdmFpbGFibGVLQiAvIDEwMjQpO1xuICBjb25zdCBzdWZmaWNpZW50ID0gYXZhaWxhYmxlTUIgPj0gcmVxdWlyZWRNQjtcblxuICBpZiAoIXN1ZmZpY2llbnQpIHtcbiAgICByZWNvcmRGYXVsdEV2ZW50KFxuICAgICAgXCJkaXNrX3NwYWNlX2NsZWFudXBcIixcbiAgICAgIGBJbnN1ZmZpY2llbnQgZGlzayBzcGFjZTogJHthdmFpbGFibGVNQn0gTUIgYXZhaWxhYmxlLCAke3JlcXVpcmVkTUJ9IE1CIHJlcXVpcmVkIGF0ICR7cGF0aH1gLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGF2YWlsYWJsZU1CLFxuICAgIHJlcXVpcmVkTUIsXG4gICAgc3VmZmljaWVudCxcbiAgICBtZXNzYWdlOiBzdWZmaWNpZW50XG4gICAgICA/IGBEaXNrIHNwYWNlIE9LOiAke2F2YWlsYWJsZU1CfSBNQiBhdmFpbGFibGUgKCR7cmVxdWlyZWRNQn0gTUIgcmVxdWlyZWQpYFxuICAgICAgOiBgSW5zdWZmaWNpZW50IGRpc2sgc3BhY2U6ICR7YXZhaWxhYmxlTUJ9IE1CIGF2YWlsYWJsZSwgJHtyZXF1aXJlZE1CfSBNQiByZXF1aXJlZGAsXG4gIH07XG59XG5cbi8qKlxuICogUHJlLWNoZWNrIHRoYXQgc3VmZmljaWVudCBkaXNrIHNwYWNlIGlzIGF2YWlsYWJsZSBiZWZvcmUgYSBsYXJnZVxuICogZ2l0IG9wZXJhdGlvbiAoSXNzdWUgIzExNzQpLlxuICpcbiAqIFJldHVybnMgb2s6IHRydWUgd2hlbiBzcGFjZSBpcyBzdWZmaWNpZW50LCBvciBvazogZmFsc2Ugd2l0aCBhXG4gKiBkZXNjcmlwdGl2ZSBlcnJvciBpbmNsdWRpbmcgYXZhaWxhYmxlIHNwYWNlLCByZXF1aXJlZCBtaW5pbXVtLFxuICogYW5kIHRoZSBvcGVyYXRpb24gdGhhdCB3YXMgYWJvdXQgdG8gYmUgcGVyZm9ybWVkLlxuICpcbiAqIEBwYXJhbSBwYXRoIC0gRmlsZXN5c3RlbSBwYXRoIHRvIGNoZWNrICh1c3VhbGx5IHRoZSB3b3JrIGRpcmVjdG9yeSkuXG4gKiBAcGFyYW0gb3BlcmF0aW9uIC0gSHVtYW4tcmVhZGFibGUgZGVzY3JpcHRpb24gb2YgdGhlIGdpdCBvcGVyYXRpb24gKGUuZy4gXCJnaXQgY2xvbmVcIikuXG4gKiBAcGFyYW0gcmVxdWlyZWRNQiAtIE1pbmltdW0gZnJlZSBzcGFjZSBpbiBNQiAoZGVmYXVsdDogREVGQVVMVF9NSU5fRlJFRV9TUEFDRV9NQikuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXF1aXJlRGlza1NwYWNlRm9yR2l0T3BlcmF0aW9uKFxuICBwYXRoOiBzdHJpbmcsXG4gIG9wZXJhdGlvbjogc3RyaW5nLFxuICByZXF1aXJlZE1COiBudW1iZXIgPSBERUZBVUxUX01JTl9GUkVFX1NQQUNFX01CLFxuKTogUHJvbWlzZTxSZXN1bHQ8dHJ1ZT4+IHtcbiAgY29uc3QgY2hlY2sgPSBhd2FpdCBjaGVja0Rpc2tTcGFjZUF2YWlsYWJsZShwYXRoLCByZXF1aXJlZE1CKTtcblxuICBpZiAoY2hlY2suc3VmZmljaWVudCkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdHJ1ZSB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgIGBJbnN1ZmZpY2llbnQgZGlzayBzcGFjZSBiZWZvcmUgJHtvcGVyYXRpb259OiBgICtcbiAgICAgICAgYCR7Y2hlY2suYXZhaWxhYmxlTUJ9IE1CIGF2YWlsYWJsZSwgJHtyZXF1aXJlZE1CfSBNQiByZXF1aXJlZGAsXG4gICAgKSxcbiAgfTtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIEludGVybmFsIGhlbHBlcnNcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKiBXYWxrIHVwIHRvIHRoZSBjbG9zZXN0IGV4aXN0aW5nIGRpcmVjdG9yeSAocm9vdCBmYWxsYmFjaykuICovXG5mdW5jdGlvbiByZXNvbHZlRXhpc3RpbmdQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBjaGVja1BhdGggPSBwYXRoO1xuICB3aGlsZSAoY2hlY2tQYXRoICE9PSBcIi9cIiAmJiBjaGVja1BhdGggIT09IFwiXCIpIHtcbiAgICB0cnkge1xuICAgICAgRGVuby5zdGF0U3luYyhjaGVja1BhdGgpO1xuICAgICAgYnJlYWs7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGNoZWNrUGF0aCk7XG4gICAgICBpZiAocGFyZW50ID09PSBjaGVja1BhdGgpIGJyZWFrO1xuICAgICAgY2hlY2tQYXRoID0gcGFyZW50O1xuICAgIH1cbiAgfVxuICBpZiAoY2hlY2tQYXRoID09PSBcIlwiKSBjaGVja1BhdGggPSBcIi9cIjtcbiAgcmV0dXJuIGNoZWNrUGF0aDtcbn1cblxuLyoqIERlbGV0ZSBhbmQgcmVjcmVhdGUgdGhlIHdvcmsgZGlyZWN0b3J5LiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG51a2VXb3JrRGlyKHdvcmtEaXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBDbGVhciB0aGUgZGlyZWN0b3J5J3MgQ09OVEVOVFMgcmF0aGVyIHRoYW4gdGhlIGRpcmVjdG9yeSBpdHNlbGZcbiAgLy8gKElzc3VlICM0MjEyKTogc2luY2UgIzQyMDMgdGhlIHdvcmsgZGlyIGlzIGEgbmFtZWQtdm9sdW1lIG1vdW50cG9pbnQsXG4gIC8vIHdoaWNoIGNhbm5vdCBiZSByZW1vdmVkIChFQlVTWSkg4oCUIHRoZSBvbGQgcmVtb3ZlLWFuZC1yZWNyZWF0ZSBzaGFwZVxuICAvLyBzd2FsbG93ZWQgdGhhdCBlcnJvciBhbmQgc2lsZW50bHkgbnVrZWQgbm90aGluZyBpbiBhIGdlbnVpbmUgZGlza1xuICAvLyBlbWVyZ2VuY3kuIFJlc2VydmVkIGVudHJpZXMgKHRoZSBleHQ0IGxvc3QrZm91bmQsIHRoZSBsb2dzIGRpciwgdGhlXG4gIC8vIGF1ZGl0IHRyYWlsIGFuZCBpdHMgcm9zdGVyIHNpZGVjYXJzKSBhcmUgc2tpcHBlZDogdGhlIHdvcmtlciBjYW5ub3RcbiAgLy8gcmVtb3ZlIHRoZSBmaXJzdCBhbmQgbXVzdCBub3QgcmVtb3ZlIHRoZSByZXN0IOKAlCBhIGRpc2sgZW1lcmdlbmN5IGlzIG5vXG4gIC8vIHJlYXNvbiB0byBlcmFzZSB0aGUgdGFtcGVyLWV2aWRlbnQgcmVjb3JkIG9mIHdoYXQgaXQgZGlkIChJc3N1ZSAjMzM3KS5cbiAgLy8gUGVyLWVudHJ5IGZhaWx1cmVzIGFyZSBsb2dnZWQgbG91ZCBhbmQgbmV2ZXIgYWJvcnQgdGhlIHN3ZWVwLlxuICBsZXQgZW50cmllczogRGVuby5EaXJFbnRyeVtdID0gW107XG4gIHRyeSB7XG4gICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIod29ya0RpcikpIHtcbiAgICAgIGVudHJpZXMucHVzaChlbnRyeSk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBEaXJlY3RvcnkgbWF5IG5vdCBleGlzdCDigJQgZW5zdXJlRGlyIGJlbG93IHJlY3JlYXRlcyBpdC5cbiAgICBlbnRyaWVzID0gW107XG4gIH1cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGlzUmVzZXJ2ZWRXb3JrUm9vdEVudHJ5KGVudHJ5Lm5hbWUpKSBjb250aW51ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgRGVuby5yZW1vdmUoYCR7d29ya0Rpcn0vJHtlbnRyeS5uYW1lfWAsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgbnVrZVdvcmtEaXI6IGNvdWxkIG5vdCByZW1vdmUgJHt3b3JrRGlyfS8ke2VudHJ5Lm5hbWV9OiAke1xuICAgICAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgICB9YCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGF3YWl0IGVuc3VyZURpcih3b3JrRGlyKTtcbn1cblxuLyoqIERlZmF1bHQgdG9vbC1hdmFpbGFiaWxpdHkgY2hlY2sgdmlhIGB3aGljaGAuICovXG5hc3luYyBmdW5jdGlvbiBkZWZhdWx0VG9vbEF2YWlsYWJsZShuYW1lOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgciA9IGF3YWl0IHJ1bldpdGhUaW1lb3V0KFwid2hpY2hcIiwgW25hbWVdLCB7XG4gICAgdGltZW91dE1zOiBXSElDSF9USU1FT1VUX01TLFxuICAgIHF1aWV0OiB0cnVlLFxuICB9KTtcbiAgcmV0dXJuIHIub2sgJiYgIXIudmFsdWUudGltZWRPdXQgJiYgci52YWx1ZS5zdWNjZXNzO1xufVxuXG4vKiogRGVmYXVsdCBzdWJwcm9jZXNzIHJ1bm5lciBmb3IgcmVjbGFpbSB0aWVycy4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlZmF1bHRSdW5Db21tYW5kKFxuICBleGVjdXRhYmxlOiBzdHJpbmcsXG4gIGFyZ3M6IHN0cmluZ1tdLFxuKTogUHJvbWlzZTxSZWNsYWltQ29tbWFuZFJlc3VsdD4ge1xuICBjb25zdCByID0gYXdhaXQgcnVuV2l0aFRpbWVvdXQoZXhlY3V0YWJsZSwgYXJncywge1xuICAgIHRpbWVvdXRNczogUkVDTEFJTV9TVUJQUk9DRVNTX1RJTUVPVVRfTVMsXG4gICAgcXVpZXQ6IHRydWUsXG4gIH0pO1xuICBpZiAoIXIub2spIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBjb2RlOiAtMSB9O1xuICByZXR1cm4geyBzdWNjZXNzOiByLnZhbHVlLnN1Y2Nlc3MsIGNvZGU6IHIudmFsdWUuY29kZSB9O1xufVxuXG4vKipcbiAqIFJlY3Vyc2l2ZWx5IHdhbGsgd29ya0RpciBhbmQgcmVtb3ZlIGV2ZXJ5IGRpcmVjdG9yeSBuYW1lZCBgbm9kZV9tb2R1bGVzYFxuICogKHdpdGhvdXQgZGVzY2VuZGluZyBpbnRvIHRoZW0pLiBSZXR1cm5zIHRoZSBjb3VudCByZW1vdmVkLlxuICovXG5hc3luYyBmdW5jdGlvbiByZW1vdmVOb2RlTW9kdWxlc0RpcnMod29ya0Rpcjogc3RyaW5nKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgY29uc3QgcXVldWU6IHN0cmluZ1tdID0gW3dvcmtEaXJdO1xuICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGRpciA9IHF1ZXVlLnBvcCgpITtcbiAgICBsZXQgZW50cmllczogQXN5bmNJdGVyYWJsZTxEZW5vLkRpckVudHJ5PjtcbiAgICB0cnkge1xuICAgICAgZW50cmllcyA9IERlbm8ucmVhZERpcihkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGZvciBhd2FpdCAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgaWYgKCFlbnRyeS5pc0RpcmVjdG9yeSkgY29udGludWU7XG4gICAgICBjb25zdCBwYXRoID0gYCR7ZGlyfS8ke2VudHJ5Lm5hbWV9YDtcbiAgICAgIGlmIChlbnRyeS5uYW1lID09PSBcIm5vZGVfbW9kdWxlc1wiKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgRGVuby5yZW1vdmUocGF0aCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgICAgY291bnQrKztcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gQmVzdC1lZmZvcnQg4oCUIGlnbm9yZSByZW1vdmFsIGZhaWx1cmVzLlxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBxdWV1ZS5wdXNoKHBhdGgpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICByZXR1cm4gY291bnQ7XG59XG5cbi8qKiBTaW1wbGUgZGlybmFtZSBpbXBsZW1lbnRhdGlvbiAoYXZvaWRzIGltcG9ydGluZyBzdGQvcGF0aCkuICovXG5mdW5jdGlvbiBkaXJuYW1lKHA6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGlkeCA9IHAubGFzdEluZGV4T2YoXCIvXCIpO1xuICBpZiAoaWR4IDw9IDApIHJldHVybiBcIi9cIjtcbiAgcmV0dXJuIHAuc2xpY2UoMCwgaWR4KTtcbn1cblxuLyoqIEVuc3VyZSBhIGRpcmVjdG9yeSBleGlzdHMgKGVxdWl2YWxlbnQgdG8gbWtkaXIgLXApLiAqL1xuYXN5bmMgZnVuY3Rpb24gZW5zdXJlRGlyKGRpcjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBJZ25vcmUgQWxyZWFkeUV4aXN0c1xuICAgIGlmICghKGVyciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLkFscmVhZHlFeGlzdHMpKSB7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Q0FhQyxHQUdELFNBQVMsZ0JBQWdCLFFBQVEsZ0NBQWdDO0FBQ2pFLFNBQVMsdUJBQXVCLFFBQVEscUJBQXFCO0FBQzdELFNBQVMsY0FBYyxRQUErQiwwQkFBMEI7QUFDaEYsU0FBUyxrQkFBa0Isa0JBQWtCLFFBQVEsa0JBQWtCO0FBQ3ZFLFNBQVMscUJBQXFCLFFBQVEsd0JBQXdCO0FBQzlELFNBQVMsdUJBQXVCLFFBQVEsdUJBQXVCO0FBRS9ELDhEQUE4RCxHQUM5RCxNQUFNLGdCQUFnQjtBQUV0QixpRUFBaUUsR0FDakUsTUFBTSxtQkFBbUI7QUFFekIsc0VBQXNFLEdBQ3RFLE1BQU0sZ0NBQWdDO0FBRXRDLHdFQUF3RSxHQUN4RSxPQUFPLE1BQU0saUNBQWlDLEdBQUc7QUFFakQ7Ozs7Ozs7Ozs7Q0FVQyxHQUNELE9BQU8sTUFBTSx3Q0FBd0MsR0FBRztBQUV4RCxnRkFBZ0YsR0FDaEYsT0FBTyxNQUFNLDRCQUE0QixJQUFJO0FBRTdDLG1EQUFtRCxHQUNuRCxPQUFPLE1BQU0sNkJBQTZCLEVBQUU7QUFFNUMsbUVBQW1FLEdBQ25FLE9BQU8sTUFBTSw2QkFBNkIsSUFBSTtBQUU5Qzs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBa0JDLEdBQ0QsT0FBTyxTQUFTLHlCQUNkLElBQVksRUFDWixLQUFhO0VBRWIsSUFDRSxPQUFPLFNBQVMsQ0FBQyxVQUNqQixTQUFTLDhCQUNULFNBQVMsNEJBQ1Q7SUFDQSxPQUFPO0VBQ1Q7RUFDQSxPQUFPLEdBQUcsS0FBSyxTQUFTLEVBQUUsMkJBQTJCLENBQUMsQ0FBQyxHQUNy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
// denoCacheMetadata=17721702615302685425,18254110303831190478