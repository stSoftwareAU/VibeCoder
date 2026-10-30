/**
 * Host build-cache reclaim (Issue #4498).
 *
 * ## What went wrong
 *
 * A host sat below its disk claiming floor for 25 hours with about 150 GB of
 * regenerable build output on it: stale cargo `target` directories left in
 * `/tmp` and under `~/src`. Nothing on the host knew how to reclaim them, so
 * the floor never cleared and the worker stayed parked.
 *
 * ## The design
 *
 * - A build cache is a directory whose `CACHEDIR.TAG` file carries the cargo
 *   signature line from the CACHEDIR.TAG specification. Nothing is inferred
 *   from a directory name.
 * - Every candidate must pass each guard, or it is skipped and the reason is
 *   reported: it has not been touched within the minimum age, no running
 *   process holds it open, it holds no `.git` entry, and it neither contains
 *   nor equals a protected path (the launcher's base directory, the cwd).
 * - The walk never follows symlinks, never descends into a tagged directory,
 *   never treats a root as a candidate, and stops at a fixed depth.
 * - The reclaim acts only when free space is below the floor. It removes the
 *   oldest eligible caches first and stops once the estimated free space
 *   (free space at the start plus the bytes removed) reaches floor + headroom.
 *   No `df` is needed after the start.
 * - If the process table cannot be read, nothing is removed. A cache that
 *   cannot be proven idle is not deleted.
 *
 * Every environment probe is injectable. The tests run against real temporary
 * directories with the process table and sizes supplied by the test.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  isAbsolutePath,
  joinPath,
  type LauncherPathStyle,
  separatorFor,
} from "./host_path_style.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";

/** The file a cache directory carries, per the CACHEDIR.TAG specification. */
export const CACHEDIR_TAG_FILENAME = "CACHEDIR.TAG";

/**
 * The first line of a cargo cache tag (the CACHEDIR.TAG specification's
 * signature). A tag with any other first line marks nothing this reclaim may
 * remove.
 */
export const CACHEDIR_TAG_SIGNATURE =
  "Signature: 8a477f597d28d172789f06886806bc55";

/** Defaults for the `.config.json` keys (Issue #4498). */
export const DEFAULT_MIN_AGE_HOURS = 24;
export const DEFAULT_HEADROOM_GB = 10;

/**
 * How deep under each root candidates are sought: a root's children are depth
 * 1, so `root/a/b/c/d` is a candidate at depth 4 and nothing deeper is seen.
 */
export const DEFAULT_WALK_DEPTH = 4;

/** Per-call budget for `du` and for the portable walk; over it is unmeasured. */
export const DU_TIMEOUT_MS = 60_000;

/** How much of a CACHEDIR.TAG is read: far more than the signature line needs. */
export const TAG_READ_BYTES = 512;

/** Upper bound on the entries one portable size walk visits. */
export const SIZE_WALK_MAX_ENTRIES = 500_000;

const PROCESS_TIMEOUT_MS = 30_000;
const LARGEST_DIRECTORY_COUNT = 8;
const GIB = 1_073_741_824;
const HOUR_MS = 3_600_000;

/** `.config.json` keys (host settings live in the file, never in env vars). */
export const HOST_CACHE_RECLAIM_ENABLED_KEY = "host_cache_reclaim_enabled";
export const HOST_CACHE_RECLAIM_MIN_AGE_KEY =
  "host_cache_reclaim_min_age_hours";
export const HOST_CACHE_RECLAIM_HEADROOM_KEY = "host_cache_reclaim_headroom_gb";
export const HOST_CACHE_RECLAIM_ROOTS_KEY = "host_cache_reclaim_roots";

/** One entry of a directory listing. Symlinks are never followed. */
export interface FsEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** Metadata of one path, read without following a symlink. */
export interface FsStat {
  isSymlink: boolean;
  isDirectory: boolean;
  isFile: boolean;
  /** Last modification, ms since the epoch; null when the platform has none. */
  mtimeMs: number | null;
}

/** What a `CACHEDIR.TAG` path holds. */
export type CacheTagReading =
  | { state: "absent" }
  | { state: "file"; text: string }
  | { state: "unreadable"; reason: string };

/** The filesystem the walk reads. Real Deno APIs unless a test injects one. */
export interface HostCacheFs {
  /** The entries of a directory. Throws when it cannot be read. */
  readDir(path: string): Promise<FsEntry[]>;
  /** Metadata without following symlinks; null when the path does not exist. */
  lstat(path: string): Promise<FsStat | null>;
  /** The state of a tag file; never follows a symlink. */
  readTagFile(path: string): Promise<CacheTagReading>;
  /** The resolved path; null when it does not exist. */
  realPath(path: string): Promise<string | null>;
}

/** Everything environment-dependent the reclaim touches. */
export interface HostCacheReclaimDeps {
  now(): number;
  /**
   * Lines of text from the process table and the processes' working
   * directories. Throwing, or returning nothing usable, removes nothing.
   */
  processSnapshot(): Promise<string[]>;
  /** Size of a directory in bytes; null when it cannot be measured. */
  dirSizeBytes(path: string): Promise<number | null>;
  /** Removes a directory tree without following its symlinks. */
  remove(path: string): Promise<void>;
  fs: HostCacheFs;
  /** The host's path spelling, for joins and boundary checks. */
  style: LauncherPathStyle;
}

/** What one reclaim run is asked to do. */
export interface HostCacheReclaimOptions {
  /** Free bytes on the host now. */
  freeBytes: number;
  /** The claiming floor, in bytes. Below it the reclaim acts. */
  floorBytes: number;
  /** How far past the floor the reclaim keeps going once it has started. */
  headroomBytes: number;
  /** A cache touched more recently than this is fresh and kept. */
  minAgeMs: number;
  /** Directories to walk for caches. */
  roots: string[];
  /** Paths a candidate may not contain or equal. */
  protect: string[];
  /** Walk depth; defaults to {@link DEFAULT_WALK_DEPTH}. */
  maxDepth?: number;
}

/** One cache directory the reclaim removed. */
export interface HostCacheRemoval {
  path: string;
  /** Bytes removed; null when the size could not be measured. */
  bytes: number | null;
  /** Time since the cache was last touched, in ms. */
  idleMs: number;
}

/** One candidate or root the reclaim declined, and why. */
export interface HostCacheSkip {
  path: string;
  reason: string;
}

/** The outcome of one reclaim run. */
export interface HostCacheReclaimResult {
  removed: HostCacheRemoval[];
  skipped: HostCacheSkip[];
  /** Estimated free bytes after the run: free at the start plus removed bytes. */
  freeBytesAfter: number;
  /** floor + headroom: where the reclaim stops once it has started. */
  targetBytes: number;
  /** Bytes still missing to clear the floor; zero once the floor is cleared. */
  shortBytes: number;
  /**
   * Set when the process table could not be read. Nothing was removed and the
   * caller must report the failure, not treat the run as a quiet no-op.
   */
  processTableError?: string;
}

/** One directory and its size, for naming where the space went. */
export interface HostDirectorySize {
  path: string;
  /** Bytes; null when the size timed out or failed (unmeasured, not dropped). */
  bytes: number | null;
}

/** The host's path spelling, from the platform the worker runs on. */
export function hostPathStyle(): LauncherPathStyle {
  return Deno.build.os === "windows" ? "windows" : "posix";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound;
}

/**
 * The first {@link TAG_READ_BYTES} bytes of a tag file (#4500 review). The
 * walk reads a tag in world-writable scratch directories, so a huge or sparse
 * file named CACHEDIR.TAG must not be loaded whole. A first line longer than
 * the prefix is cut short and so cannot equal the signature.
 */
async function readTagPrefix(path: string): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(TAG_READ_BYTES);
    let filled = 0;
    while (filled < TAG_READ_BYTES) {
      const n = await file.read(buffer.subarray(filled));
      if (n === null) break;
      filled += n;
    }
    return new TextDecoder().decode(buffer.subarray(0, filled));
  } finally {
    file.close();
  }
}

/** The real filesystem, read without following symlinks. */
export const realHostCacheFs: HostCacheFs = {
  async readDir(path) {
    const entries: FsEntry[] = [];
    for await (const entry of Deno.readDir(path)) {
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isSymlink: entry.isSymlink,
      });
    }
    return entries;
  },

  async lstat(path) {
    try {
      const info = await Deno.lstat(path);
      return {
        isSymlink: info.isSymlink,
        isDirectory: info.isDirectory,
        isFile: info.isFile,
        mtimeMs: info.mtime?.getTime() ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },

  async readTagFile(path) {
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (error) {
      if (isNotFound(error)) return { state: "absent" };
      return {
        state: "unreadable",
        reason: `${CACHEDIR_TAG_FILENAME} cannot be inspected (${
          errorText(error)
        })`,
      };
    }
    if (info.isSymlink) {
      return {
        state: "unreadable",
        reason: `${CACHEDIR_TAG_FILENAME} is a symbolic link`,
      };
    }
    if (!info.isFile) {
      return {
        state: "unreadable",
        reason: `${CACHEDIR_TAG_FILENAME} is not a regular file`,
      };
    }
    try {
      return { state: "file", text: await readTagPrefix(path) };
    } catch (error) {
      return {
        state: "unreadable",
        reason: `${CACHEDIR_TAG_FILENAME} cannot be read (${errorText(error)})`,
      };
    }
  },

  async realPath(path) {
    try {
      return await Deno.realPath(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  },
};

/**
 * The production process snapshot (Issue #4498).
 *
 * POSIX: `ps -axww -o command=`, plus the working directory of every process
 * from `lsof` where it is available. A failing `ps` throws. A missing or
 * failing `lsof` is tolerated, because `ps` alone still names every command
 * line. Windows: the command lines from `Get-CimInstance`; a failure throws.
 */
export async function defaultProcessSnapshot(
  style: LauncherPathStyle,
): Promise<string[]> {
  if (style === "windows") {
    const ps = await runWithTimeout("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }",
    ], { timeoutMs: PROCESS_TIMEOUT_MS });
    return requireOutput(ps, "powershell Get-CimInstance").split(/\r?\n/);
  }

  const ps = await runWithTimeout("ps", ["-axww", "-o", "command="], {
    timeoutMs: PROCESS_TIMEOUT_MS,
  });
  const lines = requireOutput(ps, "ps -axww -o command=").split("\n");
  try {
    const lsof = await runWithTimeout(
      "lsof",
      ["-w", "-a", "-d", "cwd", "-Fn"],
      { timeoutMs: PROCESS_TIMEOUT_MS },
    );
    if (lsof.ok && !lsof.value.timedOut) {
      for (const line of lsof.value.stdout.split("\n")) {
        // `-Fn` names each field; only the `n` lines carry the cwd path.
        if (line.startsWith("n")) lines.push(line.slice(1));
      }
    }
  } catch {
    // lsof is absent or broke: tolerated, because ps already succeeded.
  }
  return lines;
}

function requireOutput(
  result: Awaited<ReturnType<typeof runWithTimeout>>,
  label: string,
): string {
  if (!result.ok) {
    throw new Error(`${label} could not run (${result.error.message})`);
  }
  if (result.value.timedOut) throw new Error(`${label} timed out`);
  if (!result.value.success) {
    throw new Error(
      `${label} exited ${result.value.code}` +
        `${
          result.value.stderr.trim() ? `: ${result.value.stderr.trim()}` : ""
        }`,
    );
  }
  return result.value.stdout;
}

/** What the portable size walk reads and how long it may run. */
export interface SizeWalkOptions {
  now?: () => number;
  timeoutMs?: number;
  maxEntries?: number;
}

/**
 * The size of a directory by walking it with Deno, for hosts without `du`
 * (Windows) (#4500 review). Sums allocated blocks where the platform reports
 * them, else apparent sizes; symlinks are counted as links and never followed.
 * Null when the walk exceeds its entry or time budget or the root cannot be
 * read: the size is unmeasured. An unreadable subdirectory is skipped, so the
 * figure can omit it.
 */
export async function walkDirSizeBytes(
  path: string,
  options: SizeWalkOptions = {},
): Promise<number | null> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? DU_TIMEOUT_MS);
  const maxEntries = options.maxEntries ?? SIZE_WALK_MAX_ENTRIES;
  const style = hostPathStyle();
  let visited = 0;
  let total = 0;

  async function visit(dir: string, isRoot: boolean): Promise<boolean> {
    let names: Deno.DirEntry[];
    try {
      names = [];
      for await (const entry of Deno.readDir(dir)) names.push(entry);
    } catch {
      return !isRoot; // an unreadable subdirectory is skipped, the root is not
    }
    for (const entry of names) {
      if (++visited > maxEntries || now() > deadline) return false;
      const child = joinPath(dir, entry.name, style);
      let info: Deno.FileInfo;
      try {
        info = await Deno.lstat(child);
      } catch {
        continue; // vanished while walking
      }
      total += info.blocks !== null ? info.blocks * 512 : info.size;
      if (info.isDirectory && !info.isSymlink && !await visit(child, false)) {
        return false;
      }
    }
    return true;
  }

  return await visit(path, true) ? total : null;
}

/**
 * The size of a directory, or null when it cannot be measured (Issue #4498).
 * Uses `du -sk`; where `du` cannot run or fails without a figure (Windows has
 * none), falls back to {@link walkDirSizeBytes}. A `du` timeout is unmeasured,
 * not zero, and is not retried with a slower walk.
 */
export async function defaultDirSizeBytes(
  path: string,
  run: typeof runWithTimeout = runWithTimeout,
): Promise<number | null> {
  try {
    const du = await run("du", ["-sk", path], {
      timeoutMs: DU_TIMEOUT_MS,
    });
    if (du.ok) {
      if (du.value.timedOut) return null;
      const kb = Number(du.value.stdout.trim().split(/\s+/)[0]);
      if (Number.isFinite(kb) && kb >= 0) return kb * 1024;
    }
  } catch {
    // du could not be spawned: measure with the walk below.
  }
  try {
    return await walkDirSizeBytes(path);
  } catch {
    return null;
  }
}

/** The production dependencies. Each one can be replaced by a test. */
export function defaultHostCacheReclaimDeps(): HostCacheReclaimDeps {
  const style = hostPathStyle();
  return {
    now: () => Date.now(),
    processSnapshot: () => defaultProcessSnapshot(style),
    dirSizeBytes: defaultDirSizeBytes,
    remove: (path) => Deno.remove(path, { recursive: true }),
    fs: realHostCacheFs,
    style,
  };
}

/**
 * Whether a line of the process table names `path` at a path boundary.
 *
 * A boundary is the start or end of the text, or a character that cannot be
 * part of a file name. So `/tmp/a` is named by `/tmp/a/debug` and by
 * `cwd=/tmp/a`, but not by `/tmp/ab` or `/tmp/a.old`.
 */
export function namesPath(line: string, path: string): boolean {
  if (path === "") return false;
  let at = line.indexOf(path);
  while (at >= 0) {
    const before = at === 0 ? "" : line.charAt(at - 1);
    const after = line.charAt(at + path.length);
    if (!isFileNameChar(before) && !isFileNameChar(after)) return true;
    at = line.indexOf(path, at + 1);
  }
  return false;
}

const FILE_NAME_CHAR = /[A-Za-z0-9_.-]/;

function isFileNameChar(ch: string): boolean {
  return ch !== "" && FILE_NAME_CHAR.test(ch);
}

/** The first line of a tag file's text, without its line ending. */
function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

/** Whether `dir` is `path` itself or a directory above it. */
function dirContainsOrEquals(
  dir: string,
  path: string,
  style: LauncherPathStyle,
): boolean {
  if (path === dir) return true;
  const sep = separatorFor(style);
  return path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

function requireMtime(stat: FsStat, path: string): number {
  if (stat.mtimeMs === null) {
    throw new Error(`${path} has no modification time`);
  }
  return stat.mtimeMs;
}

/**
 * When a cache was last touched: the newest modification time of the
 * directory, its children and its grandchildren (Issue #4498).
 *
 * SIMPLE ON PURPOSE. A bounded walk to depth two catches a build writing into
 * `debug/` or `release/`, which is where cargo writes. It does not see
 * activity deeper down, so a build that only touches deeper files could be
 * judged idle. Upgrade this to a deeper walk the first time an active build is
 * seen having a cache deleted from under it.
 *
 * Any entry that cannot be read throws, and the caller treats the cache as
 * fresh and skips it. An unreadable subtree could hide recent activity.
 */
async function lastTouchedMs(
  dir: string,
  deps: HostCacheReclaimDeps,
): Promise<number> {
  const style = deps.style;
  const self = await deps.fs.lstat(dir);
  if (self === null) throw new Error("vanished before it was inspected");
  let newest = requireMtime(self, dir);

  for (const child of await deps.fs.readDir(dir)) {
    const childPath = joinPath(dir, child.name, style);
    const childStat = await deps.fs.lstat(childPath);
    if (childStat === null) continue;
    newest = Math.max(newest, requireMtime(childStat, childPath));
    if (child.isDirectory && !child.isSymlink) {
      for (const grandchild of await deps.fs.readDir(childPath)) {
        const grandPath = joinPath(childPath, grandchild.name, style);
        const grandStat = await deps.fs.lstat(grandPath);
        if (grandStat === null) continue;
        newest = Math.max(newest, requireMtime(grandStat, grandPath));
      }
    }
  }
  return newest;
}

/**
 * Walk `root` to `maxDepth` and collect the cargo cache directories found.
 *
 * Symlinks are never followed. A tagged directory is a cache or is not, and
 * is never descended into either way. Unreadable directories and tags are
 * reported as skips.
 */
async function collectCandidates(
  root: string,
  maxDepth: number,
  deps: HostCacheReclaimDeps,
  skipped: HostCacheSkip[],
  found: Set<string>,
): Promise<void> {
  const style = deps.style;

  async function visit(dir: string, depth: number): Promise<void> {
    let entries: FsEntry[];
    try {
      entries = await deps.fs.readDir(dir);
    } catch (error) {
      skipped.push({
        path: dir,
        reason: `unreadable directory (${errorText(error)})`,
      });
      return;
    }

    for (const entry of entries) {
      if (entry.isSymlink || !entry.isDirectory) continue;
      const child = joinPath(dir, entry.name, style);
      const tag = await deps.fs.readTagFile(
        joinPath(child, CACHEDIR_TAG_FILENAME, style),
      );
      if (tag.state === "unreadable") {
        skipped.push({ path: child, reason: tag.reason });
        continue;
      }
      if (tag.state === "file") {
        if (firstLine(tag.text) === CACHEDIR_TAG_SIGNATURE) {
          found.add(child);
        } else {
          skipped.push({
            path: child,
            reason:
              `${CACHEDIR_TAG_FILENAME} does not carry the cargo signature`,
          });
        }
        continue;
      }
      if (depth < maxDepth) await visit(child, depth + 1);
    }
  }

  await visit(root, 1);
}

/**
 * Resolve roots to distinct real directories (Issue #4498).
 *
 * A missing root is normal on most hosts and is dropped silently. A root that
 * exists but cannot be read is reported. Two roots that resolve to the same
 * place (macOS `/tmp` is `/private/tmp`) are walked once.
 *
 * `spellings` keeps every way each real root was named — the path as given as
 * well as its real path — because the process table is never resolved: a
 * process started under `/tmp/...` names the cache that way, not as
 * `/private/tmp/...` (#4500 review).
 */
async function resolveRoots(
  roots: string[],
  fs: HostCacheFs,
): Promise<{
  paths: string[];
  skipped: HostCacheSkip[];
  spellings: Map<string, string[]>;
}> {
  const paths: string[] = [];
  const skipped: HostCacheSkip[] = [];
  const spellings = new Map<string, string[]>();
  for (const root of roots) {
    try {
      const real = await fs.realPath(root);
      if (real === null) continue;
      const stat = await fs.lstat(real);
      if (stat === null) continue;
      if (!stat.isDirectory) {
        skipped.push({ path: root, reason: "root is not a directory" });
        continue;
      }
      const given = root.replace(/[\\/]+$/, "") || root;
      const known = spellings.get(real);
      if (known !== undefined) {
        if (!known.includes(given)) known.push(given);
        continue;
      }
      spellings.set(real, given === real ? [real] : [real, given]);
      paths.push(real);
    } catch (error) {
      skipped.push({
        path: root,
        reason: `root unreadable (${errorText(error)})`,
      });
    }
  }
  return { paths, skipped, spellings };
}

/**
 * Every spelling of `path` (a real path under one of `spellings`' roots): the
 * real path itself, then the same suffix under each other name its root was
 * given by (#4500 review).
 */
function pathSpellings(
  path: string,
  spellings: ReadonlyMap<string, readonly string[]>,
  style: LauncherPathStyle,
): string[] {
  let bestRoot = "";
  for (const root of spellings.keys()) {
    if (
      dirContainsOrEquals(root, path, style) && root.length > bestRoot.length
    ) {
      bestRoot = root;
    }
  }
  if (bestRoot === "") return [path];
  const suffix = path.slice(bestRoot.length);
  const all = new Set<string>([path]);
  for (const name of spellings.get(bestRoot) ?? []) all.add(name + suffix);
  return [...all];
}

/** Resolve protected paths so a symlinked one still matches (Issue #4498). */
async function resolveProtect(
  protect: string[],
  fs: HostCacheFs,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const entry of protect) {
    const trimmed = entry.replace(/[\\/]+$/, "") || entry;
    let real: string | null = null;
    try {
      real = await fs.realPath(trimmed);
    } catch {
      real = null;
    }
    resolved.push(real ?? trimmed);
  }
  return resolved;
}

/** A candidate that passed every guard. */
interface EligibleCache {
  path: string;
  touchedMs: number;
  idleMs: number;
}

type Judgement =
  | ({ kind: "eligible" } & Omit<EligibleCache, "path">)
  | { kind: "skip"; reason: string };

/**
 * Apply each safety guard to one candidate (Issue #4498). Every refusal
 * carries a reason. A candidate that cannot be inspected is refused, not
 * assumed idle.
 */
async function judgeCandidate(
  path: string,
  options: HostCacheReclaimOptions,
  protect: string[],
  processLines: string[],
  deps: HostCacheReclaimDeps,
  spellings: readonly string[] = [path],
): Promise<Judgement> {
  let touchedMs: number;
  try {
    touchedMs = await lastTouchedMs(path, deps);
  } catch (error) {
    return {
      kind: "skip",
      reason: `could not be inspected (${errorText(error)})`,
    };
  }

  const idleMs = deps.now() - touchedMs;
  if (idleMs < options.minAgeMs) {
    return {
      kind: "skip",
      reason: `fresh: last touched ${
        hoursText(Math.max(0, idleMs))
      } h ago, inside the ${hoursText(options.minAgeMs)} h minimum age`,
    };
  }

  let gitEntry: FsStat | null;
  try {
    gitEntry = await deps.fs.lstat(joinPath(path, ".git", deps.style));
  } catch (error) {
    return {
      kind: "skip",
      reason: `could not be inspected (${errorText(error)})`,
    };
  }
  if (gitEntry !== null) {
    return {
      kind: "skip",
      reason: "contains a .git entry, so it is not a bare build cache",
    };
  }

  const guarded = protect.find((p) => dirContainsOrEquals(path, p, deps.style));
  if (guarded !== undefined) {
    return {
      kind: "skip",
      reason: `contains or equals the protected path ${guarded}`,
    };
  }

  // Issue #4498: a cache a live process has open is never removed. This check
  // is the guard the test suite proves by breaking it on purpose. The process
  // table is never resolved, so the cache is looked for under every spelling
  // of its root (#4500 review).
  if (
    processLines.some((line) =>
      spellings.some((spelling) => namesPath(line, spelling))
    )
  ) {
    return { kind: "skip", reason: "held open by a running process" };
  }

  return { kind: "eligible", touchedMs, idleMs };
}

function hoursText(ms: number): string {
  return (ms / HOUR_MS).toFixed(1);
}

/** The process-table lines, or a throw when there are none usable. */
function usableProcessTable(lines: unknown): string[] {
  if (!Array.isArray(lines)) throw new Error("returned no list of processes");
  const usable = lines.filter((line): line is string =>
    typeof line === "string" && line.trim() !== ""
  );
  if (usable.length === 0) throw new Error("returned no process lines");
  return usable;
}

/**
 * Reclaim stale build caches until the host is clear of its floor
 * (Issue #4498).
 *
 * Acts only when `freeBytes` is below `floorBytes`. Then it removes the oldest
 * eligible caches first and stops once `freeBytes` plus the bytes removed
 * reaches `floorBytes + headroomBytes`. If the process table cannot be read,
 * it removes nothing and reports `processTableError`.
 *
 * @param options - The space figures, the age rule, the roots and protections
 * @param overrides - Any dependency to replace (the rest are the production ones)
 * @returns What was removed, what was declined and why, and the estimate
 */
export async function reclaimHostCaches(
  options: HostCacheReclaimOptions,
  overrides: Partial<HostCacheReclaimDeps> = {},
): Promise<HostCacheReclaimResult> {
  const deps: HostCacheReclaimDeps = {
    ...defaultHostCacheReclaimDeps(),
    ...overrides,
  };
  const targetBytes = options.floorBytes + options.headroomBytes;
  const skipped: HostCacheSkip[] = [];

  if (options.freeBytes >= options.floorBytes) {
    return {
      removed: [],
      skipped,
      freeBytesAfter: options.freeBytes,
      targetBytes,
      shortBytes: 0,
    };
  }

  // The process table gates every removal, so it is read before any walk.
  let processLines: string[];
  try {
    processLines = usableProcessTable(await deps.processSnapshot());
  } catch (error) {
    return {
      removed: [],
      skipped,
      freeBytesAfter: options.freeBytes,
      targetBytes,
      shortBytes: Math.max(0, options.floorBytes - options.freeBytes),
      processTableError: errorText(error),
    };
  }

  const roots = await resolveRoots(options.roots, deps.fs);
  skipped.push(...roots.skipped);
  const protect = await resolveProtect(options.protect, deps.fs);

  const found = new Set<string>();
  for (const root of roots.paths) {
    await collectCandidates(
      root,
      options.maxDepth ?? DEFAULT_WALK_DEPTH,
      deps,
      skipped,
      found,
    );
  }

  const eligible: EligibleCache[] = [];
  for (const path of found) {
    const judgement = await judgeCandidate(
      path,
      options,
      protect,
      processLines,
      deps,
      pathSpellings(path, roots.spellings, deps.style),
    );
    if (judgement.kind === "skip") {
      skipped.push({ path, reason: judgement.reason });
    } else {
      eligible.push({
        path,
        touchedMs: judgement.touchedMs,
        idleMs: judgement.idleMs,
      });
    }
  }
  // Oldest first: the longest-idle cache is the least likely to be in use.
  eligible.sort((a, b) =>
    a.touchedMs - b.touchedMs || a.path.localeCompare(b.path)
  );

  const removed: HostCacheRemoval[] = [];
  let freeBytes = options.freeBytes;
  for (const cache of eligible) {
    if (freeBytes >= targetBytes) break;
    const bytes = await safeDirSize(deps, cache.path);
    try {
      await deps.remove(cache.path);
    } catch (error) {
      skipped.push({
        path: cache.path,
        reason: `removal failed (${errorText(error)})`,
      });
      continue;
    }
    removed.push({ path: cache.path, bytes, idleMs: cache.idleMs });
    freeBytes += bytes ?? 0;
  }

  return {
    removed,
    skipped,
    freeBytesAfter: freeBytes,
    targetBytes,
    shortBytes: Math.max(0, options.floorBytes - freeBytes),
  };
}

async function safeDirSize(
  deps: HostCacheReclaimDeps,
  path: string,
): Promise<number | null> {
  try {
    return await deps.dirSizeBytes(path);
  } catch {
    return null;
  }
}

/**
 * The largest directories directly under the roots, for naming where the space
 * went when the reclaim cannot cover the shortfall (Issue #4498).
 *
 * An unmeasured directory stays in the list with `bytes: null`. Unmeasured
 * entries sort last.
 *
 * @param roots - The roots whose immediate children are sized
 * @param overrides - Any dependency to replace
 * @param n - How many to return
 * @returns The `n` largest, largest first
 */
export async function largestHostDirectories(
  roots: string[],
  overrides: Partial<HostCacheReclaimDeps> = {},
  n: number = LARGEST_DIRECTORY_COUNT,
): Promise<HostDirectorySize[]> {
  const deps: HostCacheReclaimDeps = {
    ...defaultHostCacheReclaimDeps(),
    ...overrides,
  };
  const resolved = await resolveRoots(roots, deps.fs);
  const paths = new Set<string>();
  for (const root of resolved.paths) {
    let entries: FsEntry[];
    try {
      entries = await deps.fs.readDir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory && !entry.isSymlink) {
        paths.add(joinPath(root, entry.name, deps.style));
      }
    }
  }

  const sized: HostDirectorySize[] = [];
  for (const path of paths) {
    sized.push({ path, bytes: await safeDirSize(deps, path) });
  }
  sized.sort((a, b) =>
    (b.bytes ?? -1) - (a.bytes ?? -1) || a.path.localeCompare(b.path)
  );
  return sized.slice(0, n);
}

/**
 * The default roots (Issue #4498): `<home>/src`, `/tmp`, `/private/tmp`, the
 * TMPDIR / TEMP / TMP directories, then any configured extras. Duplicates are
 * removed later, by real path, in {@link reclaimHostCaches}.
 *
 * @param home - The user's home directory, if known
 * @param env - The environment reader
 * @param extras - The `host_cache_reclaim_roots` the configuration adds
 * @param style - The host's path spelling
 * @returns The roots, possibly with duplicates
 */
export function defaultCacheRoots(
  home: string | undefined,
  env: (name: string) => string | undefined,
  extras: string[],
  style: LauncherPathStyle,
): string[] {
  const roots: string[] = [];
  if (home !== undefined && home.trim() !== "") {
    roots.push(joinPath(home, "src", style));
  }
  roots.push("/tmp", "/private/tmp");
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    const value = env(name)?.trim() ?? "";
    if (value !== "") roots.push(value);
  }
  roots.push(...extras);
  return roots;
}

/** The host cache reclaim settings, as `.config.json` states them. */
export interface HostCacheReclaimConfig {
  enabled: boolean;
  minAgeHours: number;
  headroomGb: number;
  /** Extra roots to walk, absolute paths. */
  extraRoots: string[];
}

export const DEFAULT_HOST_CACHE_RECLAIM_CONFIG: HostCacheReclaimConfig = {
  enabled: true,
  minAgeHours: DEFAULT_MIN_AGE_HOURS,
  headroomGb: DEFAULT_HEADROOM_GB,
  extraRoots: [],
};

function settingError(key: string, expected: string, value: unknown): Error {
  return new Error(
    `Cannot read the host cache reclaim settings: ${key} must be ${expected}, ` +
      `got ${JSON.stringify(value)}.`,
  );
}

/**
 * Read the reclaim settings from a parsed `.config.json` object (Issue #4498).
 *
 * A key that is absent takes its default. A key present with the wrong type,
 * or outside its range, throws and names the key: a silently ignored typo
 * would change what gets deleted from the host.
 *
 * @param record - The parsed configuration
 * @returns The settings in force
 * @throws When a present key is the wrong type or out of range
 */
export function parseHostCacheReclaimConfig(
  record: Record<string, unknown>,
): HostCacheReclaimConfig {
  const enabledRaw = record[HOST_CACHE_RECLAIM_ENABLED_KEY];
  if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
    throw settingError(HOST_CACHE_RECLAIM_ENABLED_KEY, "a boolean", enabledRaw);
  }

  const minAgeRaw = record[HOST_CACHE_RECLAIM_MIN_AGE_KEY];
  if (
    minAgeRaw !== undefined &&
    (typeof minAgeRaw !== "number" || !Number.isFinite(minAgeRaw) ||
      minAgeRaw <= 0)
  ) {
    throw settingError(
      HOST_CACHE_RECLAIM_MIN_AGE_KEY,
      "a positive number of hours",
      minAgeRaw,
    );
  }

  const headroomRaw = record[HOST_CACHE_RECLAIM_HEADROOM_KEY];
  if (
    headroomRaw !== undefined &&
    (typeof headroomRaw !== "number" || !Number.isFinite(headroomRaw) ||
      headroomRaw < 0)
  ) {
    throw settingError(
      HOST_CACHE_RECLAIM_HEADROOM_KEY,
      "a non-negative number of gigabytes",
      headroomRaw,
    );
  }

  const rootsRaw = record[HOST_CACHE_RECLAIM_ROOTS_KEY];
  if (
    rootsRaw !== undefined &&
    (!Array.isArray(rootsRaw) ||
      !rootsRaw.every((root) =>
        typeof root === "string" &&
        (isAbsolutePath(root, "posix") || isAbsolutePath(root, "windows"))
      ))
  ) {
    throw settingError(
      HOST_CACHE_RECLAIM_ROOTS_KEY,
      "an array of absolute paths",
      rootsRaw,
    );
  }

  return {
    enabled: enabledRaw ?? DEFAULT_HOST_CACHE_RECLAIM_CONFIG.enabled,
    minAgeHours: minAgeRaw ?? DEFAULT_HOST_CACHE_RECLAIM_CONFIG.minAgeHours,
    headroomGb: headroomRaw ?? DEFAULT_HOST_CACHE_RECLAIM_CONFIG.headroomGb,
    extraRoots: rootsRaw ?? [],
  };
}

/**
 * Read the reclaim settings from a `.config.json` file (Issue #4498).
 *
 * Mirrors `readConfiguredDiskFloors`. A missing file means the defaults. A
 * file that exists but cannot be read or parsed throws, because a silently
 * different setting is worse than a refusal.
 *
 * @param configFile - Host path of the worker configuration file
 * @returns The settings in force
 * @throws When the file is unreadable, not JSON, not an object, or has a bad key
 */
export async function readHostCacheReclaimConfig(
  configFile: string,
): Promise<HostCacheReclaimConfig> {
  let text: string;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (isNotFound(error)) return parseHostCacheReclaimConfig({});
    throw new Error(
      `Cannot read the host cache reclaim settings: ${configFile} is ` +
        `unreadable (${errorText(error)}).`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Cannot read the host cache reclaim settings: ${configFile} is not ` +
        `valid JSON (${errorText(error)}).`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Cannot read the host cache reclaim settings: ${configFile} is not a JSON object.`,
    );
  }
  return parseHostCacheReclaimConfig(parsed as Record<string, unknown>);
}

/** The gigabyte figure the headroom setting states, in bytes. */
export function headroomBytesFor(headroomGb: number): number {
  return headroomGb * GIB;
}

/** The age the minimum-age setting states, in milliseconds. */
export function minAgeMsFor(minAgeHours: number): number {
  return minAgeHours * HOUR_MS;
}
