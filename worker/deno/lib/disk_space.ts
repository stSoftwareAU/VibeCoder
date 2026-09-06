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
 */

import type { Result } from "../types.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isReservedWorkRootEntry } from "./stale_workdir.ts";
import { runWithTimeout, type SubprocessResult } from "./subprocess_timeout.ts";
import { cleanDenoCache as realCleanDenoCache } from "./deno_cache.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";

/** Timeout for df commands: 10 seconds (handles NFS stalls). */
const DF_TIMEOUT_MS = 10_000;

/** Timeout for tool availability checks via `which`: 5 seconds. */
const WHICH_TIMEOUT_MS = 5_000;

/** Default timeout for incremental reclaim subprocesses: 60 seconds. */
const RECLAIM_SUBPROCESS_TIMEOUT_MS = 60_000;

/** Default aggressive threshold: 90% disk usage triggers workDir nuke. */
export const DEFAULT_DISK_CLEANUP_THRESHOLD = 90;

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
 */
export const DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD = 80;

/** Default minimum free space in MB before large git operations (Issue #1168). */
export const DEFAULT_MIN_FREE_SPACE_MB = 500;

/** Lowest usable cleanup threshold (Issue #1268). */
export const DISK_CLEANUP_THRESHOLD_MIN = 1;

/** Highest usable cleanup threshold — disk usage is a percentage. */
export const DISK_CLEANUP_THRESHOLD_MAX = 100;

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
 */
export function validateCleanupThreshold(
  name: string,
  value: number,
): string | null {
  if (
    Number.isInteger(value) &&
    value >= DISK_CLEANUP_THRESHOLD_MIN &&
    value <= DISK_CLEANUP_THRESHOLD_MAX
  ) {
    return null;
  }
  return `${name} must be ${DISK_CLEANUP_THRESHOLD_MIN}–` +
    `${DISK_CLEANUP_THRESHOLD_MAX} (whole percent), got ${value}: ` +
    `refusing to run disk cleanup`;
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
 */
export function parseCleanupThreshold(
  value: unknown,
  fallback: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }
  return NaN;
}

/** Ordered list of reclaim tier names. */
export type ReclaimTierName =
  | "deno-cache"
  | "npm-cache"
  | "node-modules"
  | "pip-cache"
  | "brew-cleanup";

/** Result of a single tier of incremental reclaim. */
export interface ReclaimTier {
  tier: ReclaimTierName;
  /** Whether the tier actually ran (false if the tool was unavailable). */
  attempted: boolean;
  /** Whether the tier's reclaim action returned success. */
  succeeded: boolean;
  /** Bytes reclaimed (best-effort, from df available-space diff). */
  bytesReclaimed: number;
  /** Human-readable summary message. */
  message: string;
}

/** Result of running the incremental reclaim pass. */
export interface IncrementalReclaimResult {
  /** Tiers that were attempted or explicitly skipped, in execution order. */
  tiers: ReclaimTier[];
  /** Whether disk usage dropped below the threshold during reclaim. */
  thresholdMet: boolean;
  /** Final disk usage percentage observed (null if df could not be read). */
  finalUsagePercent: number | null;
  /** Sum of bytesReclaimed across attempted tiers. */
  totalBytesReclaimed: number;
}

/** Minimal subprocess result used by the reclaim command injection. */
export interface ReclaimCommandResult {
  success: boolean;
  code: number;
}

/** Options for {@link incrementalReclaim}. */
export interface IncrementalReclaimOptions {
  /** Work directory under which to remove stray node_modules. */
  workDir: string;
  /** Usage threshold (0-100); loop exits once usage drops below it. */
  threshold?: number;

  // ---- Test / integration injection hooks. Production code uses defaults. ----
  /** Override disk usage percentage probe (defaults to {@link getDiskUsagePercent}). */
  checkUsage?: (path: string) => Promise<number | null>;
  /** Override available-KB probe used to compute bytes reclaimed. */
  checkAvailableKB?: (path: string) => Promise<number | null>;
  /** Override tool-availability check (defaults to `which <name>`). */
  toolAvailable?: (name: string) => Promise<boolean>;
  /** Override subprocess runner for npm/pip/brew invocations. */
  runCommand?: (
    executable: string,
    args: string[],
  ) => Promise<ReclaimCommandResult>;
  /** Override Deno cache cleaner (defaults to {@link cleanDenoCache}). */
  cleanDenoCache?: () => Promise<{ success: boolean; message: string }>;
  /** Override OS detection — true treats host as macOS for the brew tier. */
  forceMacOS?: boolean;
}

/**
 * Which cleanup tier was engaged by {@link checkAndCleanupDiskSpace}
 * (Issue #1499):
 *
 *   - "none"       — usage below the gentle threshold, nothing done.
 *   - "gentle"     — incremental reclaim only; cloned repos preserved.
 *   - "aggressive" — incremental reclaim plus workDir nuke if reclaim
 *                    was insufficient.
 */
export type DiskCleanupTier = "none" | "gentle" | "aggressive";

/** Result of a disk space check. */
export interface DiskCheckResult {
  /** Disk usage percentage that was observed. */
  usagePercent: number;
  /** The aggressive threshold that was applied. */
  threshold: number;
  /** The gentle threshold that was applied (Issue #1499). */
  gentleThreshold: number;
  /** Which cleanup tier was engaged (Issue #1499). */
  tier: DiskCleanupTier;
  /** Whether cleanup was performed (workDir nuke). */
  cleanedUp: boolean;
  /** Whether the Deno download cache was cleaned (Issue #1489). */
  denoCacheCleaned: boolean;
  /** Result of the incremental reclaim pass, if it ran (Issue #1495). */
  incrementalReclaim?: IncrementalReclaimResult;
  /** Human-readable summary message. */
  message: string;
}

/** Options for the disk space check. */
export interface DiskCheckOptions {
  /** Directory to check and potentially clean up (usually WORK_DIR). */
  workDir: string;
  /** Aggressive percentage threshold (0-100). Defaults to 90. */
  threshold?: number;
  /**
   * Gentle percentage threshold (0-100). When usage is at or above this
   * but below {@link threshold}, only the incremental reclaim pass runs —
   * the work directory is never nuked. Defaults to `threshold` (i.e. no
   * gentle tier) for backwards compatibility; callers should pass
   * {@link DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD} (80) to opt in.
   * Values above `threshold` are clamped to `threshold` (Issue #1499).
   */
  gentleThreshold?: number;
  /**
   * Legacy hermetic test flag (Issue #1489): when true, bypasses the
   * incremental reclaim pass entirely and goes straight to the workDir
   * nuke. Preserved so existing tests stay hermetic without invoking
   * `deno clean`, npm, pip, or brew on the host.
   */
  skipDenoCache?: boolean;
  /**
   * Override injection hooks for incremental reclaim (Issue #1495). Used
   * by tests to simulate tool availability, usage curves, and subprocess
   * outcomes without touching the host.
   */
  reclaimOverrides?: Partial<IncrementalReclaimOptions>;
  /**
   * Test-only override for the OUTER usage probe (Issue #1549 prereq).
   * When supplied, replaces the call to `getDiskUsagePercent` that
   * decides which tier (none/gentle/aggressive) to run. The inner
   * incremental reclaim continues to use `reclaimOverrides.checkUsage`
   * so tests can model the usage trajectory through the reclaim loop
   * independently. Production code never sets this.
   */
  outerCheckUsage?: (path: string) => Promise<number | null>;
  /** Injectable environment lookup (tests inject a fixed map). */
  env?: (name: string) => string | undefined;
  /** Injectable free-bytes probe (tests model host free space). */
  freeBytesProbe?: (path: string) => Promise<number | null>;
}

/**
 * Free-space floor below which the in-container workDir nuke is permitted
 * (Issue #4164). Inside the container the measured filesystem is the HOST
 * volume seen through the mount, so a percentage threshold is chronically
 * exceeded on a large disk while the work directory itself may hold almost
 * nothing — observed live: a 4 KB work directory deleted and recreated on
 * every cycle at "92% usage" of a 460 GB volume. Only genuinely critical
 * absolute free space justifies destroying the clone cache.
 */
export const CONTAINER_NUKE_FREE_BYTES_FLOOR = 5 * 1024 ** 3;

/**
 * Get disk usage percentage for the filesystem containing the given path.
 *
 * Uses `df -P` (POSIX format) for cross-platform compatibility.
 * If the path does not exist, walks up to the closest existing parent.
 *
 * @returns Usage percentage (0-100), or null if it cannot be determined.
 */
export async function getDiskUsagePercent(
  path: string,
): Promise<number | null> {
  const checkPath = resolveExistingPath(path);

  const result = await runWithTimeout("df", ["-P", checkPath], {
    timeoutMs: DF_TIMEOUT_MS,
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
 */
export async function getDiskFreeBytes(path: string): Promise<number | null> {
  const checkPath = resolveExistingPath(path);

  const result = await runWithTimeout("df", ["-P", checkPath], {
    timeoutMs: DF_TIMEOUT_MS,
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
 * Injectable `df` runner (test seam). Matches the {@link runWithTimeout}
 * signature so production can pass it directly and tests can supply a fake
 * that returns fixture `df -Pk` output without spawning a subprocess.
 */
export type DfRunner = (
  executable: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; quiet?: boolean },
) => Promise<Result<SubprocessResult>>;

/**
 * Get available disk space in KB for the filesystem containing the given path.
 *
 * Used by {@link incrementalReclaim} to compute per-tier bytes-reclaimed.
 *
 * @param path - Filesystem path to probe (walks up to the closest parent).
 * @param run - Subprocess runner (test seam; defaults to {@link runWithTimeout}).
 * @returns Available kilobytes, or null on timeout/failure/unparseable output.
 */
export async function getDiskAvailableKB(
  path: string,
  run: DfRunner = runWithTimeout,
): Promise<number | null> {
  const checkPath = resolveExistingPath(path);

  const result = await run("df", ["-Pk", checkPath], {
    timeoutMs: DF_TIMEOUT_MS,
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
 */
export async function incrementalReclaim(
  options: IncrementalReclaimOptions,
): Promise<IncrementalReclaimResult> {
  const {
    workDir,
    threshold = DEFAULT_DISK_CLEANUP_THRESHOLD,
  } = options;

  const checkUsage = options.checkUsage ?? getDiskUsagePercent;
  const checkAvailableKB = options.checkAvailableKB ?? getDiskAvailableKB;
  const toolAvailable = options.toolAvailable ?? defaultToolAvailable;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const cleanDenoCache = options.cleanDenoCache ?? (async () => {
    const r = await realCleanDenoCache();
    return { success: r.success, message: r.message };
  });
  const isMacOS = options.forceMacOS ?? (Deno.build.os === "darwin");

  const tiers: ReclaimTier[] = [];
  let totalBytesReclaimed = 0;
  let currentUsage: number | null = null;

  const recordAttempt = async (
    tier: ReclaimTierName,
    description: string,
    run: () => Promise<{ success: boolean; message: string }>,
  ): Promise<void> => {
    const beforeKB = await checkAvailableKB(workDir);
    const outcome = await run();
    const afterKB = await checkAvailableKB(workDir);

    const bytesReclaimed =
      beforeKB !== null && afterKB !== null && afterKB > beforeKB
        ? (afterKB - beforeKB) * 1024
        : 0;
    totalBytesReclaimed += bytesReclaimed;

    tiers.push({
      tier,
      attempted: true,
      succeeded: outcome.success,
      bytesReclaimed,
      message: `${description} — ${outcome.message}`,
    });

    console.log(
      `SELF-HEALING: ${description} reclaimed ${bytesReclaimed} bytes (${
        outcome.success ? "ok" : "failed"
      })`,
    );
    recordFaultEvent(
      "disk_space_cleanup",
      `${tier}: reclaimed ${bytesReclaimed} bytes (${
        outcome.success ? "ok" : "failed"
      })`,
    );
    await emitSelfHealEventAuto({
      module: "disk_space",
      action: `reclaim_${tier}`,
      reason: description,
      result: outcome.success ? "ok" : "failed",
      bytesReclaimed,
    }, workDir);
  };

  const recordSkip = async (
    tier: ReclaimTierName,
    description: string,
    reason: string,
  ): Promise<void> => {
    tiers.push({
      tier,
      attempted: false,
      succeeded: false,
      bytesReclaimed: 0,
      message: `${description} — skipped (${reason})`,
    });
    console.log(`SELF-HEALING: ${description} skipped (${reason})`);
    await emitSelfHealEventAuto({
      module: "disk_space",
      action: `reclaim_${tier}`,
      reason: `${description} skipped: ${reason}`,
      result: "skipped",
    }, workDir);
  };

  const isThresholdMet = (): boolean =>
    currentUsage !== null && currentUsage < threshold;

  // Tier 1: Deno cache.
  await recordAttempt("deno-cache", "deno clean", cleanDenoCache);
  currentUsage = await checkUsage(workDir);
  if (isThresholdMet()) return finalise();

  // Tier 2: npm cache clean --force.
  if (await toolAvailable("npm")) {
    await recordAttempt("npm-cache", "npm cache clean --force", async () => {
      const r = await runCommand("npm", ["cache", "clean", "--force"]);
      return {
        success: r.success,
        message: r.success ? "cleaned" : `exit ${r.code}`,
      };
    });
    currentUsage = await checkUsage(workDir);
    if (isThresholdMet()) return finalise();
  } else {
    await recordSkip(
      "npm-cache",
      "npm cache clean --force",
      "npm not available",
    );
  }

  // Tier 3: remove stray node_modules directories under workDir.
  await recordAttempt("node-modules", "remove stray node_modules", async () => {
    const removed = await removeNodeModulesDirs(workDir);
    return { success: true, message: `${removed} directories removed` };
  });
  currentUsage = await checkUsage(workDir);
  if (isThresholdMet()) return finalise();

  // Tier 4: pip cache purge.
  if (await toolAvailable("pip")) {
    await recordAttempt("pip-cache", "pip cache purge", async () => {
      const r = await runCommand("pip", ["cache", "purge"]);
      return {
        success: r.success,
        message: r.success ? "cleaned" : `exit ${r.code}`,
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
  } else if (!(await toolAvailable("brew"))) {
    await recordSkip("brew-cleanup", "brew cleanup -s", "brew not available");
  } else {
    await recordAttempt("brew-cleanup", "brew cleanup -s", async () => {
      const r = await runCommand("brew", ["cleanup", "-s"]);
      return {
        success: r.success,
        message: r.success ? "cleaned" : `exit ${r.code}`,
      };
    });
    currentUsage = await checkUsage(workDir);
  }

  return finalise();

  function finalise(): IncrementalReclaimResult {
    return {
      tiers,
      thresholdMet: isThresholdMet(),
      finalUsagePercent: currentUsage,
      totalBytesReclaimed,
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
 */
export async function checkAndCleanupDiskSpace(
  options: DiskCheckOptions,
): Promise<DiskCheckResult> {
  const {
    workDir,
    threshold = DEFAULT_DISK_CLEANUP_THRESHOLD,
    skipDenoCache = false,
    reclaimOverrides,
  } = options;

  // Clamp gentleThreshold to threshold to prevent misconfiguration from
  // masking an aggressive-tier condition (Issue #1499).
  const gentleThreshold = Math.min(
    options.gentleThreshold ?? threshold,
    threshold,
  );

  if (!workDir) {
    return {
      usagePercent: 0,
      threshold,
      gentleThreshold,
      tier: "none",
      cleanedUp: false,
      denoCacheCleaned: false,
      message: "ERROR: No directory specified for disk space check",
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
      message: "WARNING: Could not determine disk usage, skipping cleanup",
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
      message: `Disk usage ${usagePercent}% is below gentle threshold ` +
        `${gentleThreshold}%, no cleanup needed`,
    };
  }

  const isAggressive = usagePercent >= threshold;

  // Container guard (Issue #4164), evaluated before EITHER nuke path: only a
  // genuinely critical amount of absolute free space justifies destroying
  // the clone cache — the percentage alone reflects the whole host volume
  // seen through the mount, not the work directory's contribution to it.
  let containerPreserveMessage: string | null = null;
  const envLookup = options.env ?? ((name: string) => Deno.env.get(name));
  if (isAggressive && envLookup("VIBE_IMAGE_AGENT_PROVIDERS") !== undefined) {
    const probe = options.freeBytesProbe ?? getDiskFreeBytes;
    const freeBytes = await probe(workDir);
    if (freeBytes === null || freeBytes >= CONTAINER_NUKE_FREE_BYTES_FLOOR) {
      const freeGb = freeBytes === null
        ? "unknown"
        : (freeBytes / 1024 ** 3).toFixed(1);
      containerPreserveMessage =
        `Disk usage ${usagePercent}% >= threshold ${threshold}%, but ` +
        `${freeGb} GiB free on the host volume — preserving ${workDir} ` +
        `(Issue #4164: the pressure is host-wide, not the work directory). ` +
        `The nuke only proceeds below ` +
        `${CONTAINER_NUKE_FREE_BYTES_FLOOR / 1024 ** 3} GiB free.`;
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
        message: containerPreserveMessage,
      };
    }
    await nukeWorkDir(workDir);
    recordFaultEvent(
      "disk_space_cleanup",
      `Disk at ${usagePercent}% on ${workDir}, cleaned up (legacy path)`,
    );
    await emitSelfHealEventAuto({
      module: "disk_space",
      action: "threshold_cleanup",
      reason: `usage ${usagePercent}% >= ${threshold}% (legacy nuke)`,
      result: "ok",
    }, workDir);
    return {
      usagePercent,
      threshold,
      gentleThreshold,
      tier: "aggressive",
      cleanedUp: true,
      denoCacheCleaned: false,
      message:
        `WARNING: Disk usage ${usagePercent}% >= threshold ${threshold}%. ` +
        `Deleted and recreated ${workDir}.`,
    };
  }

  // Run incremental reclaim (applies to both gentle and aggressive tiers).
  const reclaimTarget = isAggressive ? threshold : gentleThreshold;
  const reclaim = await incrementalReclaim({
    workDir,
    threshold: reclaimTarget,
    ...reclaimOverrides,
  });

  const denoCacheCleaned = reclaim.tiers.some(
    (t) => t.tier === "deno-cache" && t.attempted && t.succeeded,
  );

  // Gentle tier: never nuke, regardless of whether reclaim cleared pressure.
  if (!isAggressive) {
    const attempted = reclaim.tiers.filter((t) => t.attempted).length;
    return {
      usagePercent,
      threshold,
      gentleThreshold,
      tier: "gentle",
      cleanedUp: false,
      denoCacheCleaned,
      incrementalReclaim: reclaim,
      message:
        `Disk usage ${usagePercent}% >= gentle threshold ${gentleThreshold}% ` +
        `(< aggressive ${threshold}%). Gentle incremental reclaim freed ` +
        `${reclaim.totalBytesReclaimed} bytes across ${attempted} tier(s); ` +
        `cloned repositories preserved.`,
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
      message: `Incremental reclaim succeeded on ${workDir}: freed ` +
        `${reclaim.totalBytesReclaimed} bytes across ` +
        `${reclaim.tiers.filter((t) => t.attempted).length} tier(s); ` +
        `usage now ${reclaim.finalUsagePercent ?? "unknown"}%.`,
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
      message: containerPreserveMessage,
    };
  }

  await nukeWorkDir(workDir);
  recordFaultEvent(
    "disk_space_cleanup",
    `Disk at ${usagePercent}% on ${workDir}, incremental reclaim insufficient, nuked`,
  );
  await emitSelfHealEventAuto({
    module: "disk_space",
    action: "threshold_cleanup",
    reason: `usage ${usagePercent}% >= ${threshold}%, reclaim insufficient`,
    result: "ok",
    bytesReclaimed: reclaim.totalBytesReclaimed,
  }, workDir);
  return {
    usagePercent,
    threshold,
    gentleThreshold,
    tier: "aggressive",
    cleanedUp: true,
    denoCacheCleaned,
    incrementalReclaim: reclaim,
    message:
      `WARNING: Disk usage ${usagePercent}% >= threshold ${threshold}%. ` +
      `Incremental reclaim insufficient (freed ${reclaim.totalBytesReclaimed} bytes). ` +
      `Deleted and recreated ${workDir}.`,
  };
}

/** Result of a disk space availability pre-check (Issue #1168). */
export interface DiskAvailabilityResult {
  /** Available disk space in MB. */
  availableMB: number;
  /** Required minimum free space in MB. */
  requiredMB: number;
  /** Whether sufficient space is available. */
  sufficient: boolean;
  /** Human-readable summary message. */
  message: string;
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
 */
export async function checkDiskSpaceAvailable(
  path: string,
  requiredMB: number = DEFAULT_MIN_FREE_SPACE_MB,
): Promise<DiskAvailabilityResult> {
  const checkPath = resolveExistingPath(path);

  const result = await runWithTimeout("df", ["-P", checkPath], {
    timeoutMs: DF_TIMEOUT_MS,
  });

  if (!result.ok || result.value.timedOut || !result.value.success) {
    return {
      availableMB: 0,
      requiredMB,
      sufficient: false,
      message: "WARNING: Could not determine available disk space",
    };
  }

  const lines = result.value.stdout.split("\n");
  if (lines.length < 2) {
    return {
      availableMB: 0,
      requiredMB,
      sufficient: false,
      message: "WARNING: Unexpected df output format",
    };
  }

  // POSIX df -P format: Filesystem 1024-blocks Used Available Capacity Mounted
  const dataLine = lines[1]!;
  const fields = dataLine.trim().split(/\s+/);
  if (fields.length < 4) {
    return {
      availableMB: 0,
      requiredMB,
      sufficient: false,
      message: "WARNING: Unexpected df output format",
    };
  }

  const availableKB = parseInt(fields[3]!, 10);
  if (isNaN(availableKB)) {
    return {
      availableMB: 0,
      requiredMB,
      sufficient: false,
      message: "WARNING: Could not parse available disk space",
    };
  }

  const availableMB = Math.floor(availableKB / 1024);
  const sufficient = availableMB >= requiredMB;

  if (!sufficient) {
    recordFaultEvent(
      "disk_space_cleanup",
      `Insufficient disk space: ${availableMB} MB available, ${requiredMB} MB required at ${path}`,
    );
  }

  return {
    availableMB,
    requiredMB,
    sufficient,
    message: sufficient
      ? `Disk space OK: ${availableMB} MB available (${requiredMB} MB required)`
      : `WARNING: Insufficient disk space: ${availableMB} MB available, ${requiredMB} MB required`,
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
 */
export async function requireDiskSpaceForGitOperation(
  path: string,
  operation: string,
  requiredMB: number = DEFAULT_MIN_FREE_SPACE_MB,
): Promise<Result<true>> {
  const check = await checkDiskSpaceAvailable(path, requiredMB);

  if (check.sufficient) {
    return { ok: true, value: true };
  }

  return {
    ok: false,
    error: new Error(
      `Insufficient disk space before ${operation}: ` +
        `${check.availableMB} MB available, ${requiredMB} MB required`,
    ),
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/** Walk up to the closest existing directory (root fallback). */
function resolveExistingPath(path: string): string {
  let checkPath = path;
  while (checkPath !== "/" && checkPath !== "") {
    try {
      Deno.statSync(checkPath);
      break;
    } catch {
      const parent = dirname(checkPath);
      if (parent === checkPath) break;
      checkPath = parent;
    }
  }
  if (checkPath === "") checkPath = "/";
  return checkPath;
}

/** Delete and recreate the work directory. */
export async function nukeWorkDir(workDir: string): Promise<void> {
  // Clear the directory's CONTENTS rather than the directory itself
  // (Issue #4212): since #4203 the work dir is a named-volume mountpoint,
  // which cannot be removed (EBUSY) — the old remove-and-recreate shape
  // swallowed that error and silently nuked nothing in a genuine disk
  // emergency. Reserved entries (the ext4 lost+found, the logs dir, the
  // audit trail and its roster sidecars) are skipped: the worker cannot
  // remove the first and must not remove the rest — a disk emergency is no
  // reason to erase the tamper-evident record of what it did (Issue #337).
  // Per-entry failures are logged loud and never abort the sweep.
  let entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(workDir)) {
      entries.push(entry);
    }
  } catch {
    // Directory may not exist — ensureDir below recreates it.
    entries = [];
  }
  for (const entry of entries) {
    if (isReservedWorkRootEntry(entry.name)) continue;
    try {
      await Deno.remove(`${workDir}/${entry.name}`, { recursive: true });
    } catch (err) {
      console.warn(
        `nukeWorkDir: could not remove ${workDir}/${entry.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  await ensureDir(workDir);
}

/** Default tool-availability check via `which`. */
async function defaultToolAvailable(name: string): Promise<boolean> {
  const r = await runWithTimeout("which", [name], {
    timeoutMs: WHICH_TIMEOUT_MS,
    quiet: true,
  });
  return r.ok && !r.value.timedOut && r.value.success;
}

/** Default subprocess runner for reclaim tiers. */
async function defaultRunCommand(
  executable: string,
  args: string[],
): Promise<ReclaimCommandResult> {
  const r = await runWithTimeout(executable, args, {
    timeoutMs: RECLAIM_SUBPROCESS_TIMEOUT_MS,
    quiet: true,
  });
  if (!r.ok) return { success: false, code: -1 };
  return { success: r.value.success, code: r.value.code };
}

/**
 * Recursively walk workDir and remove every directory named `node_modules`
 * (without descending into them). Returns the count removed.
 */
async function removeNodeModulesDirs(workDir: string): Promise<number> {
  let count = 0;
  const queue: string[] = [workDir];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(dir);
    } catch {
      continue;
    }
    for await (const entry of entries) {
      if (!entry.isDirectory) continue;
      const path = `${dir}/${entry.name}`;
      if (entry.name === "node_modules") {
        try {
          await Deno.remove(path, { recursive: true });
          count++;
        } catch {
          // Best-effort — ignore removal failures.
        }
      } else {
        queue.push(path);
      }
    }
  }
  return count;
}

/** Simple dirname implementation (avoids importing std/path). */
function dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx);
}

/** Ensure a directory exists (equivalent to mkdir -p). */
async function ensureDir(dir: string): Promise<void> {
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch (err) {
    // Ignore AlreadyExists
    if (!(err instanceof Deno.errors.AlreadyExists)) {
      throw err;
    }
  }
}
