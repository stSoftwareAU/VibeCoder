/**
 * Bound the work volume's growth (Issue #228).
 *
 * ## What went wrong
 *
 * Host GRQ-23 crashed out of disk on 2026-08-21. Its 39 GB work volume
 * held ~20 GB of Rust `target/` directories across six repos, a 1.5 GB
 * `.bench-history-*` and a copied `.before-src` repo an agent had dumped
 * in the work root (outside any clone), and 14 stale heartbeat-marker
 * state files going back days. Nothing aged any of it out: the per-issue
 * cleanup resets the clone it worked in, and the stale-workdir scanner
 * skips dot-prefixed entries by design.
 *
 * ## The rules
 *
 * 1. **Build artefacts.** A `target/` directory beside a `Cargo.toml`
 *    (the repo root or one level down) is disposable — `cargo` rebuilds
 *    it. It goes when it has not been touched for `maxAgeDays`, or, when
 *    the artefacts across all repos exceed `maxTotalBytes`, oldest first
 *    until they fit. A repo with a live heartbeat is never touched.
 * 2. **Scratch in the work root.** A dot-prefixed *directory* in the work
 *    root that is not one of the worker's own state directories and has
 *    not been modified for `scratchMaxAgeHours` is an agent's leftover
 *    and is removed. Files are left alone (the worker keeps state files
 *    there).
 * 3. **Marker state files.** `.heartbeat-marker_*` files older than
 *    `markerMaxAgeDays` belong to claims long released; a live claim
 *    refreshes its file every few minutes.
 *
 * Every removal is named in the result; every failure is recorded, never
 * thrown — housekeeping must not abort a launch.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { runWithTimeout } from "./subprocess_timeout.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { RESERVED_WORKDIR_NAMES } from "./stale_workdir.ts";

const GIB = 1_073_741_824;
const DU_TIMEOUT_MS = 120_000;

/** Defaults, overridable through the housekeeping env knobs. */
export const DEFAULT_ARTEFACT_MAX_AGE_DAYS = 2;
export const DEFAULT_ARTEFACT_MAX_TOTAL_BYTES = 10 * GIB;
export const DEFAULT_SCRATCH_MAX_AGE_HOURS = 24;
export const DEFAULT_MARKER_MAX_AGE_DAYS = 2;

/**
 * Dot-prefixed directories the worker itself keeps in the work root.
 * Anything else dot-prefixed and old is scratch.
 */
export const WORK_ROOT_STATE_DIRS: ReadonlySet<string> = new Set([
  ".claude-sessions",
  ".claude-config",
  ".deno-cache",
  ".vibe-cache",
  ".gh-scan-cache",
  ".gh-timeline-cache",
  ".runlogs",
  ".github",
  ".git",
  ".resume-state",
]);

export interface WorkVolumePruneOptions {
  workDir: string;
  artefactMaxAgeDays?: number;
  artefactMaxTotalBytes?: number;
  scratchMaxAgeHours?: number;
  markerMaxAgeDays?: number;
  /** Epoch seconds, injectable. */
  nowFn?: () => number;
  /** Size of a directory in bytes, injectable (default `du -sk`). */
  sizeOf?: (path: string) => Promise<number | null>;
  /** Whether a repo has a live claim on this host, injectable. */
  isRepoActive?: (workDir: string, repoName: string) => Promise<boolean>;
}

export interface ArtefactRecord {
  repo: string;
  path: string;
  bytes: number;
  ageDays: number;
}

export interface WorkVolumePruneResult {
  artefacts: {
    scanned: ArtefactRecord[];
    removed: ArtefactRecord[];
    skippedActive: string[];
    bytesReclaimed: number;
  };
  scratch: { removed: string[] };
  markers: { removed: string[] };
  errors: string[];
}

/** `du -sk` in bytes, or null when it cannot be measured. */
export async function duBytes(path: string): Promise<number | null> {
  const result = await runWithTimeout("du", ["-sk", path], {
    timeoutMs: DU_TIMEOUT_MS,
    quiet: true,
  });
  if (!result.ok || result.value.timedOut || !result.value.success) {
    return null;
  }
  const kb = Number(result.value.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/** Default liveness check: any `.heartbeat_*_<repo>_<n>` file in the root. */
export async function repoHasHeartbeat(
  workDir: string,
  repoName: string,
): Promise<boolean> {
  try {
    for await (const entry of Deno.readDir(workDir)) {
      if (!entry.isFile || !entry.name.startsWith(".heartbeat_")) continue;
      // `.heartbeat_<owner>_<repo>_<issue>` — the repo name sits before the
      // trailing issue number.
      const stem = entry.name.slice(".heartbeat_".length);
      const withoutIssue = stem.replace(/_\d+$/, "");
      if (withoutIssue.endsWith(`_${repoName}`) || withoutIssue === repoName) {
        return true;
      }
    }
  } catch {
    // Unreadable root — treat as active (fail safe).
    return true;
  }
  return false;
}

async function mtimeEpoch(path: string): Promise<number | null> {
  try {
    const stat = await Deno.stat(path);
    return stat.mtime ? Math.floor(stat.mtime.getTime() / 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Newest modification time under a target dir, two levels deep — the
 * directory's own mtime does not move when cargo writes inside `debug/`.
 */
async function newestMtimeShallow(path: string): Promise<number | null> {
  let newest = await mtimeEpoch(path);
  try {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      const m = await mtimeEpoch(child);
      if (m !== null && (newest === null || m > newest)) newest = m;
      if (!entry.isDirectory) continue;
      try {
        for await (const grand of Deno.readDir(child)) {
          const gm = await mtimeEpoch(`${child}/${grand.name}`);
          if (gm !== null && (newest === null || gm > newest)) newest = gm;
        }
      } catch {
        // Unreadable subdirectory — its parent's mtime stands.
      }
    }
  } catch {
    // Unreadable — the dir's own mtime stands.
  }
  return newest;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Find cargo `target/` dirs in a repo: the root and one level down. */
export async function findCargoTargets(repoDir: string): Promise<string[]> {
  const found: string[] = [];
  const check = async (dir: string) => {
    if (
      await exists(`${dir}/Cargo.toml`) && await exists(`${dir}/target`)
    ) {
      found.push(`${dir}/target`);
    }
  };
  await check(repoDir);
  try {
    for await (const entry of Deno.readDir(repoDir)) {
      if (!entry.isDirectory || entry.name.startsWith(".")) continue;
      if (entry.name === "target" || entry.name === "node_modules") continue;
      await check(`${repoDir}/${entry.name}`);
    }
  } catch {
    // Unreadable repo — nothing found.
  }
  return found;
}

/**
 * Decide which artefact dirs go: every one past the age limit, then the
 * oldest until the rest fit under the cap.
 */
export function selectArtefactsToRemove(
  records: readonly ArtefactRecord[],
  maxAgeDays: number,
  maxTotalBytes: number,
): ArtefactRecord[] {
  const remove = new Set<ArtefactRecord>();
  for (const r of records) {
    if (r.ageDays > maxAgeDays) remove.add(r);
  }
  let remaining = records.filter((r) => !remove.has(r));
  let total = remaining.reduce((sum, r) => sum + r.bytes, 0);
  remaining = [...remaining].sort((a, b) => b.ageDays - a.ageDays);
  for (const r of remaining) {
    if (total <= maxTotalBytes) break;
    remove.add(r);
    total -= r.bytes;
  }
  return records.filter((r) => remove.has(r));
}

async function removeDir(path: string, errors: string[]): Promise<boolean> {
  try {
    await Deno.remove(path, { recursive: true });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`could not remove ${path}: ${msg}`);
    recordFaultEvent(
      "catch_block_warning",
      `work-volume-prune could not remove ${path}: ${msg}`,
    );
    return false;
  }
}

/** Run all three sweeps. */
export async function pruneWorkVolume(
  options: WorkVolumePruneOptions,
): Promise<WorkVolumePruneResult> {
  const workDir = options.workDir;
  const now = (options.nowFn ?? (() => Math.floor(Date.now() / 1000)))();
  const sizeOf = options.sizeOf ?? duBytes;
  const isRepoActive = options.isRepoActive ?? repoHasHeartbeat;
  const artefactMaxAgeDays = options.artefactMaxAgeDays ??
    DEFAULT_ARTEFACT_MAX_AGE_DAYS;
  const artefactMaxTotalBytes = options.artefactMaxTotalBytes ??
    DEFAULT_ARTEFACT_MAX_TOTAL_BYTES;
  const scratchMaxAgeSeconds =
    (options.scratchMaxAgeHours ?? DEFAULT_SCRATCH_MAX_AGE_HOURS) * 3600;
  const markerMaxAgeSeconds =
    (options.markerMaxAgeDays ?? DEFAULT_MARKER_MAX_AGE_DAYS) * 86400;

  const result: WorkVolumePruneResult = {
    artefacts: {
      scanned: [],
      removed: [],
      skippedActive: [],
      bytesReclaimed: 0,
    },
    scratch: { removed: [] },
    markers: { removed: [] },
    errors: [],
  };

  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(workDir)) entries.push(entry);
  } catch (err) {
    result.errors.push(
      `cannot read ${workDir}: ${err instanceof Error ? err.message : err}`,
    );
    return result;
  }

  // 1. Build artefacts.
  for (const entry of entries) {
    if (!entry.isDirectory || entry.name.startsWith(".")) continue;
    if (RESERVED_WORKDIR_NAMES.has(entry.name)) continue;
    const repoDir = `${workDir}/${entry.name}`;
    if (!(await exists(`${repoDir}/.git`))) continue;
    const targets = await findCargoTargets(repoDir);
    if (targets.length === 0) continue;
    if (await isRepoActive(workDir, entry.name)) {
      result.artefacts.skippedActive.push(entry.name);
      continue;
    }
    for (const target of targets) {
      const bytes = (await sizeOf(target)) ?? 0;
      const newest = await newestMtimeShallow(target);
      const ageDays = newest === null ? Infinity : (now - newest) / 86400;
      result.artefacts.scanned.push({
        repo: entry.name,
        path: target,
        bytes,
        ageDays,
      });
    }
  }
  for (
    const record of selectArtefactsToRemove(
      result.artefacts.scanned,
      artefactMaxAgeDays,
      artefactMaxTotalBytes,
    )
  ) {
    if (await removeDir(record.path, result.errors)) {
      result.artefacts.removed.push(record);
      result.artefacts.bytesReclaimed += record.bytes;
    }
  }

  // 2. Scratch directories in the work root.
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name.startsWith(".")) continue;
    if (WORK_ROOT_STATE_DIRS.has(entry.name)) continue;
    if (RESERVED_WORKDIR_NAMES.has(entry.name)) continue;
    const path = `${workDir}/${entry.name}`;
    const m = await mtimeEpoch(path);
    if (m !== null && now - m < scratchMaxAgeSeconds) continue;
    if (await removeDir(path, result.errors)) {
      result.scratch.removed.push(entry.name);
    }
  }

  // 3. Stale marker state files.
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.startsWith(".heartbeat-marker_")) continue;
    const path = `${workDir}/${entry.name}`;
    const m = await mtimeEpoch(path);
    if (m === null || now - m < markerMaxAgeSeconds) continue;
    try {
      await Deno.remove(path);
      result.markers.removed.push(entry.name);
    } catch (err) {
      result.errors.push(
        `could not remove ${path}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return result;
}

export function formatGb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** One-line summary for the housekeeping log. */
export function summariseWorkVolumePrune(r: WorkVolumePruneResult): string {
  const scannedBytes = r.artefacts.scanned.reduce((s, a) => s + a.bytes, 0);
  const parts = [
    `artefacts: ${r.artefacts.scanned.length} target dir(s) ${
      formatGb(scannedBytes)
    }, removed ${r.artefacts.removed.length} (${
      formatGb(r.artefacts.bytesReclaimed)
    })` +
    (r.artefacts.skippedActive.length > 0
      ? `, skipped active ${r.artefacts.skippedActive.join(", ")}`
      : ""),
    `scratch: removed ${r.scratch.removed.length}` +
    (r.scratch.removed.length > 0 ? ` (${r.scratch.removed.join(", ")})` : ""),
    `markers: removed ${r.markers.removed.length}`,
  ];
  if (r.errors.length > 0) parts.push(`errors: ${r.errors.join("; ")}`);
  return parts.join(" | ");
}
