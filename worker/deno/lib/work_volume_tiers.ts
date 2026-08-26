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
 * ## The third path — a warm clone whose object store ratchets (Issue #387)
 *
 * Neither path above touches a directory a gate refreshes every cycle: it is
 * never idle, and the disk-low reclaim only runs once the host is already
 * below the floor. That is exactly how `side/data` climbed 0.7 GB → 10.8 GB
 * in one afternoon on an idle GRQ-23. The writer is the refresh itself —
 * `GRQ/quality.sh` → `worker/repos.sh` → `model_fetch.sh` running `git fetch`
 * + `git reset --hard origin/Develop` in `GRQ-shareprices2026Q2`. In a
 * **blobless** partial clone (Issue #243) that hard reset lazily backfills a
 * whole tree of blobs into a new `.promisor` pack, and git never prunes those:
 * `git repack` deliberately leaves promisor packs alone, so `git gc
 * --prune=now` reclaims nothing. Every refresh of a data repo whose files
 * change wholesale therefore adds a full tree of dead blobs for ever — two
 * refreshes left an 871 MB and a 650 MB pack in a 1.5 GB `.git` on the host.
 *
 * The refresh is legitimate; the accumulation is not, and no git-side
 * maintenance can bound it. So the object store gets a cap, the way
 * `deno-cache-guard` caps the durable Deno cache: a disposable clone whose
 * `.git` exceeds `maxGitBytes` is removed by the age sweep even though it is
 * warm. The next gate run re-clones it blobless and backfills one tree —
 * about what a single refresh already costs — so the disk is bounded and the
 * download is not multiplied.
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

/**
 * Bytes a tier-2 clone's `.git` may reach before the clone is dropped as
 * ratcheted (Issue #387) — 2 GiB, the same order as the Deno cache cap, and
 * comfortably above the ~0.9 GB a single blobless backfill of the largest
 * observed data repo costs. Zero disables the guard.
 */
export const DEFAULT_SIDE_REPO_MAX_GIT_BYTES = 2 * 1024 * 1024 * 1024;

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
  /**
   * Size of the clone's `.git` in bytes; 0 when there is none or it could
   * not be measured. Measured separately from {@link bytes} because the
   * blobless re-fetch ratchet (Issue #387) lands entirely in the object
   * store — the working tree stays the size the data genuinely is.
   */
  gitBytes: number;
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
  /**
   * Names removed because their `.git` was over the cap rather than because
   * they were idle — the blobless re-fetch ratchet (Issue #387).
   */
  removedGitRatchet: string[];
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
  /**
   * Object-store cap for `age` mode (default
   * {@link DEFAULT_SIDE_REPO_MAX_GIT_BYTES}); 0 disables the guard.
   */
  maxGitBytes?: number;
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
    const hasGit = readable && await pathExists(`${path}/.git`);
    dirs.push({
      name: entry.name,
      path,
      tier,
      bytes,
      gitBytes: hasGit ? ((await sizeOf(`${path}/.git`)) ?? 0) : 0,
      ageDays: newest === null ? Infinity : (now - newest) / 86400,
      hasGit,
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
 * Tier-2 clones whose git object store is over the cap (Issue #387).
 *
 * These are typically the *warmest* directories on the volume — a data repo
 * a gate refreshes every cycle — so the age sweep above never reaches them
 * while their `.git` grows by a whole tree of blobs per refresh. A
 * non-positive cap disables the guard.
 */
export function selectRatchetedGitDirs(
  dirs: readonly WorkRootDir[],
  maxGitBytes: number,
): WorkRootDir[] {
  if (!(maxGitBytes > 0)) return [];
  return dirs.filter((d) =>
    d.tier === "disposable" && d.hasGit && d.gitBytes > maxGitBytes
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
    removedGitRatchet: [],
    skippedSlotActive: false,
    errors,
  };

  // The age sweep also takes a warm clone whose object store has ratcheted
  // past the cap (Issue #387) — nothing else on the volume bounds it.
  const maxGitBytes = options.maxGitBytes ?? DEFAULT_SIDE_REPO_MAX_GIT_BYTES;
  const ratcheted = options.mode === "disk-low"
    ? []
    : selectRatchetedGitDirs(dirs, maxGitBytes);
  const ratchetedNames = new Set(ratcheted.map((d) => d.name));

  const selected = options.mode === "disk-low"
    ? selectLargestFirst(dirs, options.bytesNeeded ?? 0)
    : selectAgedOutDirs(
      dirs,
      options.maxAgeDays ?? DEFAULT_SIDE_REPO_MAX_AGE_DAYS,
    );
  const seen = new Set(selected.map((d) => d.name));
  const candidates = [
    ...selected,
    ...ratcheted.filter((d) => !seen.has(d.name)),
  ];
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
    if (ratchetedNames.has(dir.name)) result.removedGitRatchet.push(dir.name);
    const why = ratchetedNames.has(dir.name)
      ? `, .git ${formatGb(dir.gitBytes)} over the ${
        formatGb(maxGitBytes)
      } cap — blobless re-fetch ratchet (Issue #387)`
      : "";
    log(
      `work volume: removed disposable ${dir.name} (${formatGb(dir.bytes)}, ` +
        `${
          Number.isFinite(dir.ageDays) ? dir.ageDays.toFixed(1) : "unknown"
        } days idle, ${options.mode}${why})`,
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
  if (r.removedGitRatchet.length > 0) {
    parts.push(`git-ratchet: ${r.removedGitRatchet.join(", ")}`);
  }
  if (r.keptRescueFailed.length > 0) {
    parts.push(`kept unpushed: ${r.keptRescueFailed.join(", ")}`);
  }
  if (r.errors.length > 0) parts.push(`errors: ${r.errors.join("; ")}`);
  return parts.join("; ");
}
