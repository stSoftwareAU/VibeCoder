/**
 * Two tiers in the work root (Issue #242).
 *
 * ## The split
 *
 * `.config.json` monitors a handful of repositories, but the work volume
 * holds far more than those clones: a monitored repo's `quality.sh` or
 * bench scripts clone sibling **data** repos as `../<name>`, and on GRQ-23
 * those siblings (`GRQ-shareprices2026Q2` 7.3 GB, `GRQ-listing` 3.9 GB, …)
 * were ~15 GB of the 43 directories on the volume. Nothing aged them out
 * inside a week (the stale-workdir scanner waits 7 idle days) and nothing
 * tied their removal to the host's disk, so the host filled while the
 * cheap, disposable content sat there.
 *
 * - **Tier 1 — monitored repos.** Persistent: the context we want to keep
 *   across runs so a large clone is not re-downloaded every cycle. Never
 *   removed by either path here; their build output is bounded by the
 *   artefact rules in `work_volume_prune.ts` (Issue #228).
 * - **Tier 2 — everything else** in the work root. Disposable: aged out
 *   after `maxAgeDays` (default 3 — long enough that a nightly gate's data
 *   repo stays warm), and removed **largest first** the moment the host
 *   disk monitor (Issue #226) reports `low`, before the gate stops
 *   claiming.
 *
 * Removal is safe because the consuming scripts re-fetch on demand: GRQ's
 * `worker/model_fetch.sh` clones the sibling when the directory is absent
 * (`if [[ ! -d "${REPO}" ]]` → `git_clone_safe`) and fetches when it is
 * present, so a removed data repo costs one clone, not a failed gate.
 *
 * ## Protections
 *
 * 1. Nothing is removed while a slot is mid-execute — a gate may be reading
 *    the clone right now.
 * 2. Unpushed commits are rescued first with the existing
 *    {@link pushUnpushedBranches}; a directory whose rescue fails is kept.
 * 3. A `.git`-less or unreadable directory has nothing to rescue and goes
 *    without one.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import {
  isReservedWorkRootEntry,
  pushUnpushedBranches,
} from "./stale_workdir.ts";
import { duBytes, formatGb } from "./work_volume_prune.ts";

/** Days a tier-2 directory may sit untouched before it is aged out. */
export const DEFAULT_SIDE_REPO_MAX_AGE_DAYS = 3;

/** How recent a heartbeat must be for its slot to count as mid-execute. */
export const DEFAULT_ACTIVE_HEARTBEAT_WINDOW_SECONDS = 900;

/** Which tier a work-root entry belongs to. */
export type WorkRootTier =
  /** A monitored repository clone — persistent. */
  | "monitored"
  /** Worker-owned state (dot-prefixed entries, reserved names). */
  | "state"
  /** A sibling/data clone or anything else an agent left — disposable. */
  | "disposable";

/**
 * Directory name a repository is cloned into: the segment after the owner
 * in `owner/repo`, or the name itself when no owner is given.
 */
export function repoDirName(repo: string): string {
  const trimmed = repo.trim().replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/** The set of clone directory names for a monitored repository list. */
export function monitoredDirNames(
  repos: readonly string[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const repo of repos) {
    const name = repoDirName(repo);
    if (name !== "") names.add(name);
  }
  return names;
}

/**
 * Tier of a single work-root entry — a pure function of the directory name
 * and the monitored list (Issue #242).
 *
 * Dot-prefixed entries are the worker's own state and agent scratch, owned
 * by the work-volume prune (Issue #228); reserved names (`logs`,
 * `lost+found`, the `audit` trail and its roster sidecars) belong to other
 * subsystems. Everything else that is not a monitored clone is disposable.
 */
export function classifyWorkRootEntry(
  name: string,
  monitored: ReadonlySet<string>,
): WorkRootTier {
  if (name === "" || name.startsWith(".")) return "state";
  if (isReservedWorkRootEntry(name)) return "state";
  if (monitored.has(name)) return "monitored";
  return "disposable";
}

/** One directory in the work root, measured and aged. */
export interface WorkRootDir {
  name: string;
  path: string;
  tier: WorkRootTier;
  /** Size in bytes; 0 when it could not be measured. */
  bytes: number;
  /** Days since the newest modification found; `Infinity` when unknown. */
  ageDays: number;
  /** Whether the directory carries a `.git` — a clone worth rescuing. */
  hasGit: boolean;
  /** False when the directory could not be read (EIO, permissions). */
  readable: boolean;
}

/** Outcome of the two-tier reclaim. */
export interface WorkVolumeTierResult {
  /** `age` for the periodic sweep, `disk-low` for the reclaim action. */
  mode: "age" | "disk-low";
  monitored: { count: number; bytes: number };
  disposable: { count: number; bytes: number };
  /** Directories removed, in removal order. */
  removed: WorkRootDir[];
  bytesReclaimed: number;
  /** Names kept because their unpushed commits could not be pushed. */
  keptRescueFailed: string[];
  /** True when a slot was mid-execute, so nothing was removed. */
  skippedSlotActive: boolean;
  errors: string[];
}

/** Injectable pieces of {@link reclaimWorkVolumeTiers}. */
export interface WorkVolumeTierOptions {
  workDir: string;
  /** Monitored repositories, `owner/repo` or bare directory names. */
  monitoredRepos: readonly string[];
  /** `age` ages tier 2 out; `disk-low` takes the largest first. */
  mode: "age" | "disk-low";
  /** Age limit for `age` mode (default {@link DEFAULT_SIDE_REPO_MAX_AGE_DAYS}). */
  maxAgeDays?: number;
  /** Bytes the host needs back in `disk-low` mode. */
  bytesNeeded?: number;
  /** Epoch seconds, injectable. */
  nowFn?: () => number;
  /** Directory size in bytes, injectable (default `du -sk`). */
  sizeOf?: (path: string) => Promise<number | null>;
  /** Whether any slot is mid-execute, injectable. */
  anySlotActive?: (workDir: string) => Promise<boolean>;
  /** Push-before-delete rescue, injectable. */
  rescue?: (
    repoDir: string,
  ) => Promise<{ ok: boolean; pushedBranches: string[]; detail: string }>;
  /** Remove a directory, injectable. */
  removeDir?: (path: string) => Promise<void>;
  log?: (message: string) => void;
}

async function statMtime(path: string): Promise<number | null> {
  try {
    const stat = await Deno.stat(path);
    return stat.mtime ? Math.floor(stat.mtime.getTime() / 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Newest modification time of a directory and its immediate children.
 *
 * A `git fetch` into a data repo rewrites `.git/FETCH_HEAD` without moving
 * the clone's own mtime, so the children (including `.git`) are what say
 * whether a gate touched it recently.
 */
async function newestTouch(path: string): Promise<number | null> {
  let newest = await statMtime(path);
  const consider = (value: number | null) => {
    if (value !== null && (newest === null || value > newest)) newest = value;
  };
  try {
    for await (const entry of Deno.readDir(path)) {
      consider(await statMtime(`${path}/${entry.name}`));
    }
  } catch {
    // Unreadable — the directory's own mtime stands.
  }
  consider(await statMtime(`${path}/.git/FETCH_HEAD`));
  return newest;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default liveness check: any `.heartbeat_*` file in the work root whose
 * recorded epoch is inside the window means a slot is mid-execute.
 */
export async function anySlotMidExecute(
  workDir: string,
  now: number = Math.floor(Date.now() / 1000),
  windowSeconds: number = DEFAULT_ACTIVE_HEARTBEAT_WINDOW_SECONDS,
): Promise<boolean> {
  try {
    for await (const entry of Deno.readDir(workDir)) {
      if (!entry.isFile || !entry.name.startsWith(".heartbeat_")) continue;
      try {
        const raw = await Deno.readTextFile(`${workDir}/${entry.name}`);
        const epoch = parseInt(raw.trim(), 10);
        if (Number.isNaN(epoch)) continue;
        if (now - epoch <= windowSeconds) return true;
      } catch {
        // Unreadable heartbeat — cannot claim a slot is live from it.
      }
    }
  } catch {
    // Unreadable work root — fail safe: assume a slot is running.
    return true;
  }
  return false;
}

/** Measure and tier every directory in the work root. */
export async function scanWorkRootTiers(
  workDir: string,
  monitoredRepos: readonly string[],
  options: {
    nowFn?: () => number;
    sizeOf?: (path: string) => Promise<number | null>;
  } = {},
): Promise<{ dirs: WorkRootDir[]; errors: string[] }> {
  const now = (options.nowFn ?? (() => Math.floor(Date.now() / 1000)))();
  const sizeOf = options.sizeOf ?? duBytes;
  const monitored = monitoredDirNames(monitoredRepos);
  const dirs: WorkRootDir[] = [];
  const errors: string[] = [];

  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(workDir)) entries.push(entry);
  } catch (err) {
    errors.push(
      `cannot read ${workDir}: ${err instanceof Error ? err.message : err}`,
    );
    return { dirs, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const tier = classifyWorkRootEntry(entry.name, monitored);
    if (tier === "state") continue;
    const path = `${workDir}/${entry.name}`;
    let readable = true;
    try {
      for await (const _ of Deno.readDir(path)) break;
    } catch {
      readable = false;
    }
    const bytes = (await sizeOf(path)) ?? 0;
    const newest = readable ? await newestTouch(path) : null;
    dirs.push({
      name: entry.name,
      path,
      tier,
      bytes,
      ageDays: newest === null ? Infinity : (now - newest) / 86400,
      hasGit: readable && await pathExists(`${path}/.git`),
      readable,
    });
  }
  return { dirs, errors };
}

/**
 * Tier-2 directories past the age limit. A `.git`-less or unreadable
 * directory is not a warm data clone — it goes whatever its mtime says.
 */
export function selectAgedOutDirs(
  dirs: readonly WorkRootDir[],
  maxAgeDays: number,
): WorkRootDir[] {
  return dirs.filter((d) =>
    d.tier === "disposable" &&
    (!d.readable || !d.hasGit || d.ageDays > maxAgeDays)
  );
}

/**
 * Tier-2 directories to remove for `bytesNeeded` back, largest first —
 * the fewest removals that free the space. Everything disposable goes when
 * the total still falls short.
 */
export function selectLargestFirst(
  dirs: readonly WorkRootDir[],
  bytesNeeded: number,
): WorkRootDir[] {
  if (!(bytesNeeded > 0)) return [];
  const candidates = dirs.filter((d) => d.tier === "disposable")
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const chosen: WorkRootDir[] = [];
  let freed = 0;
  for (const dir of candidates) {
    if (freed >= bytesNeeded) break;
    chosen.push(dir);
    freed += dir.bytes;
  }
  return chosen;
}

/**
 * Run one tier-2 reclaim over the work root (Issue #242).
 *
 * Tier 1 is never a candidate. Nothing is removed while a slot is
 * mid-execute, and a clone whose unpushed commits cannot be pushed is
 * kept — the sizes are still measured and reported either way, so the
 * split is visible in the log before the disk gate trips.
 */
export async function reclaimWorkVolumeTiers(
  options: WorkVolumeTierOptions,
): Promise<WorkVolumeTierResult> {
  const now = (options.nowFn ?? (() => Math.floor(Date.now() / 1000)))();
  const log = options.log ?? (() => {});
  const rescue = options.rescue ?? pushUnpushedBranches;
  const removeDir = options.removeDir ??
    ((path: string) => Deno.remove(path, { recursive: true }));
  const anySlotActive = options.anySlotActive ??
    ((workDir: string) => anySlotMidExecute(workDir, now));

  const { dirs, errors } = await scanWorkRootTiers(
    options.workDir,
    options.monitoredRepos,
    { nowFn: () => now, sizeOf: options.sizeOf },
  );

  const sum = (tier: WorkRootTier) => {
    const of = dirs.filter((d) => d.tier === tier);
    return {
      count: of.length,
      bytes: of.reduce((total, d) => total + d.bytes, 0),
    };
  };

  const result: WorkVolumeTierResult = {
    mode: options.mode,
    monitored: sum("monitored"),
    disposable: sum("disposable"),
    removed: [],
    bytesReclaimed: 0,
    keptRescueFailed: [],
    skippedSlotActive: false,
    errors,
  };

  const candidates = options.mode === "disk-low"
    ? selectLargestFirst(dirs, options.bytesNeeded ?? 0)
    : selectAgedOutDirs(
      dirs,
      options.maxAgeDays ?? DEFAULT_SIDE_REPO_MAX_AGE_DAYS,
    );
  if (candidates.length === 0) return result;

  // A gate may be reading one of these clones right now (Issue #242).
  if (await anySlotActive(options.workDir)) {
    result.skippedSlotActive = true;
    log(
      `work volume: ${candidates.length} disposable dir(s) held back — a slot is mid-execute (Issue #242)`,
    );
    return result;
  }

  for (const dir of candidates) {
    if (dir.readable && dir.hasGit) {
      const pushed = await rescue(dir.path);
      if (!pushed.ok) {
        result.keptRescueFailed.push(dir.name);
        result.errors.push(
          `kept ${dir.path}: unpushed commits could not be pushed (${pushed.detail})`,
        );
        console.warn(
          `SELF-HEALING: NOT removing disposable work directory ${dir.path} — ` +
            `it has unpushed commits and pushing them failed (${pushed.detail}).`,
        );
        continue;
      }
      if (pushed.pushedBranches.length > 0) {
        log(
          `work volume: pushed unpushed work from ${dir.path} before removal ` +
            `(branches: ${pushed.pushedBranches.join(", ")})`,
        );
      }
    }
    try {
      await removeDir(dir.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`could not remove ${dir.path}: ${message}`);
      recordFaultEvent(
        "catch_block_warning",
        `work-volume-tiers could not remove ${dir.path}: ${message}`,
      );
      continue;
    }
    result.removed.push(dir);
    result.bytesReclaimed += dir.bytes;
    log(
      `work volume: removed disposable ${dir.name} (${formatGb(dir.bytes)}, ` +
        `${
          Number.isFinite(dir.ageDays) ? dir.ageDays.toFixed(1) : "unknown"
        } days idle, ${options.mode})`,
    );
    recordFaultEvent(
      "disk_space_cleanup",
      `work-volume-tiers removed disposable ${dir.path} (${
        formatGb(dir.bytes)
      })`,
    );
  }

  return result;
}

/** One-line tier summary for the log (Issue #242). */
export function summariseWorkVolumeTiers(r: WorkVolumeTierResult): string {
  const parts = [
    `monitored ${formatGb(r.monitored.bytes)} in ${r.monitored.count} repos`,
    `side/data ${formatGb(r.disposable.bytes)} in ${r.disposable.count} dirs`,
  ];
  if (r.skippedSlotActive) {
    parts.push("no removals — a slot is mid-execute");
  } else {
    parts.push(
      `removed ${r.removed.length} (${formatGb(r.bytesReclaimed)}, ${r.mode})`,
    );
  }
  if (r.keptRescueFailed.length > 0) {
    parts.push(`kept unpushed: ${r.keptRescueFailed.join(", ")}`);
  }
  if (r.errors.length > 0) parts.push(`errors: ${r.errors.join("; ")}`);
  return parts.join("; ");
}
