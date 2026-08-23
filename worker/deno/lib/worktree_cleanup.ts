/**
 * Orphaned git worktree cleanup (Issue #1492).
 *
 * On worker startup, scans every repository clone under `workDir` and:
 *   1. Runs `git worktree prune` — removes administrative files for
 *      worktrees whose on-disk directory is gone.
 *   2. Lists remaining worktrees via `git worktree list --porcelain` and
 *      removes any worktree directory whose linked branch no longer
 *      exists and whose mtime is older than `maxAgeHours`.
 *
 * Every removal emits a `SELF-HEALING:` log line so operators can audit
 * the cleanup.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { runGitCommand } from "./git_timeout.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isReservedWorkRootEntry } from "./stale_workdir.ts";

/** Default age threshold — only remove orphaned worktrees older than 24h. */
export const DEFAULT_MAX_AGE_HOURS = 24;

/** Options for {@link cleanupOrphanedWorktrees}. */
export interface WorktreeCleanupOptions {
  /** Directory containing repository clones (usually WORK_DIR). */
  workDir: string;
  /** Only remove orphans older than this many hours. Default: 24. */
  maxAgeHours?: number;
  /** Override the "now" clock for testing. Returns epoch ms. */
  nowFn?: () => number;
}

/** A single worktree as reported by `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Full ref name (e.g., `refs/heads/feature-x`) or null for detached/bare. */
  branch: string | null;
  /** Whether this is the main worktree (not a linked worktree). */
  isMain: boolean;
}

/** Outcome of the cleanup run. */
export interface WorktreeCleanupResult {
  /** Number of repositories inspected. */
  reposScanned: number;
  /** Number of admin files pruned via `git worktree prune`. */
  pruned: number;
  /** Absolute paths of worktree directories removed. */
  removedDirs: string[];
  /** Human-readable reasons a candidate was kept (for debugging/tests). */
  preserved: string[];
  /** Errors collected during the scan — never thrown. */
  errors: string[];
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * The first worktree listed is always the main worktree; subsequent
 * entries are linked worktrees. Each entry is separated by a blank line.
 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const blocks = output.split(/\n\n+/).map((b) => b.trim()).filter((b) =>
    b.length > 0
  );
  const entries: WorktreeEntry[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    let path = "";
    let branch: string | null = null;

    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).trim();
      } else if (line === "detached") {
        branch = null;
      }
    }

    if (path) {
      entries.push({ path, branch, isMain: i === 0 });
    }
  }

  return entries;
}

/**
 * Verify a branch ref exists in the repository.
 *
 * Uses `git rev-parse --verify` which returns exit code 0 when the ref
 * resolves and non-zero otherwise.
 */
export async function branchExists(
  repoDir: string,
  branchRef: string,
): Promise<boolean> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", branchRef],
    { cwd: repoDir },
  );
  return result.ok && result.value.code === 0;
}

/**
 * Cleanup orphaned git worktrees across all repositories in `workDir`.
 *
 * For each subdirectory of `workDir` that is itself a git repository
 * (contains a `.git` directory or file), runs `git worktree prune` and
 * then removes any linked worktree whose branch no longer exists and
 * whose mtime is older than `maxAgeHours`.
 *
 * Errors are collected into the result — this function never throws,
 * so it is safe to call during startup.
 */
export async function cleanupOrphanedWorktrees(
  options: WorktreeCleanupOptions,
): Promise<WorktreeCleanupResult> {
  const workDir = options.workDir;
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const maxAgeMs = Math.max(0, maxAgeHours) * 3600 * 1000;
  const nowFn = options.nowFn ?? (() => Date.now());

  const result: WorktreeCleanupResult = {
    reposScanned: 0,
    pruned: 0,
    removedDirs: [],
    preserved: [],
    errors: [],
  };

  if (!workDir) {
    result.errors.push("worktree-cleanup: workDir is required");
    return result;
  }

  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(workDir)) {
      entries.push(entry);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Cannot read ${workDir}: ${msg}`);
    return result;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory) continue;
    // Reserved non-repo entries (ext4 lost+found, the logs dir) are other
    // subsystems' — or the filesystem's — property (Issue #4212).
    if (isReservedWorkRootEntry(entry.name)) continue;

    const repoDir = `${workDir}/${entry.name}`;
    // Only treat a directory as a main repo when `.git` is itself a
    // directory. A `.git` *file* indicates a linked worktree that will
    // be handled through its main repo — scanning it separately would
    // double-count and emit duplicate prune output.
    const isMainRepo = await isDirectory(`${repoDir}/.git`);
    if (!isMainRepo) continue;

    result.reposScanned++;
    await processRepository(repoDir, maxAgeMs, nowFn(), result);
  }

  return result;
}

/**
 * Process a single repository: prune admin files, then remove linked
 * worktrees whose branch is gone and whose mtime is older than the
 * threshold.
 */
async function processRepository(
  repoDir: string,
  maxAgeMs: number,
  nowMs: number,
  result: WorktreeCleanupResult,
): Promise<void> {
  // 1. Prune admin files for missing worktree directories.
  const pruneResult = await runGitCommand(
    ["worktree", "prune", "-v"],
    { cwd: repoDir },
  );
  if (pruneResult.ok && pruneResult.value.code === 0) {
    // `git worktree prune -v` writes its "Removing worktrees/..." lines
    // to stderr, not stdout, so check both.
    const pruneOutput =
      `${pruneResult.value.stdout}\n${pruneResult.value.stderr}`;
    const prunedLines = pruneOutput
      .split("\n")
      .filter((l) => l.trim().startsWith("Removing "));
    if (prunedLines.length > 0) {
      result.pruned += prunedLines.length;
      for (const line of prunedLines) {
        console.log(`SELF-HEALING: worktree prune in ${repoDir}: ${line}`);
      }
      recordFaultEvent(
        "disk_space_cleanup",
        `worktree_cleanup pruned ${prunedLines.length} admin entries in ${repoDir}`,
      );
    }
  } else if (!pruneResult.ok) {
    result.errors.push(
      `git worktree prune failed in ${repoDir}: ${pruneResult.error.message}`,
    );
    return;
  }

  // 2. List remaining worktrees.
  const listResult = await runGitCommand(
    ["worktree", "list", "--porcelain"],
    { cwd: repoDir },
  );
  if (!listResult.ok || listResult.value.code !== 0) {
    const msg = !listResult.ok
      ? listResult.error.message
      : listResult.value.stderr.trim();
    result.errors.push(`git worktree list failed in ${repoDir}: ${msg}`);
    return;
  }

  const worktrees = parseWorktreeList(listResult.value.stdout);

  for (const wt of worktrees) {
    if (wt.isMain) continue;

    // A detached worktree has no branch — treat as orphan candidate.
    let branchIsGone = true;
    if (wt.branch) {
      branchIsGone = !(await branchExists(repoDir, wt.branch));
    }

    if (!branchIsGone) {
      result.preserved.push(`${wt.path}: branch ${wt.branch} still exists`);
      continue;
    }

    const mtimeMs = await getMtimeMs(wt.path);
    if (mtimeMs === null) {
      // Directory is gone — let the next prune handle it.
      result.preserved.push(`${wt.path}: not accessible (will prune next run)`);
      continue;
    }

    const ageMs = nowMs - mtimeMs;
    if (ageMs < maxAgeMs) {
      const hours = (ageMs / 3600_000).toFixed(1);
      result.preserved.push(`${wt.path}: only ${hours}h old, below threshold`);
      continue;
    }

    // Remove the orphaned worktree.
    const removeResult = await runGitCommand(
      ["worktree", "remove", "--force", wt.path],
      { cwd: repoDir },
    );
    if (!removeResult.ok || removeResult.value.code !== 0) {
      const msg = !removeResult.ok
        ? removeResult.error.message
        : removeResult.value.stderr.trim();
      result.errors.push(`Failed to remove worktree ${wt.path}: ${msg}`);
      console.warn(
        `SELF-HEALING: failed to remove orphaned worktree ${wt.path}: ${msg}`,
      );
      continue;
    }

    result.removedDirs.push(wt.path);
    const branchDesc = wt.branch ?? "detached";
    const ageH = (ageMs / 3600_000).toFixed(1);
    console.log(
      `SELF-HEALING: removed orphaned worktree ${wt.path} ` +
        `(branch ${branchDesc} missing, age ${ageH}h)`,
    );
    recordFaultEvent(
      "disk_space_cleanup",
      `worktree_cleanup removed orphan ${wt.path}`,
    );
  }
}

/** Get directory mtime as epoch ms, or null if stat fails. */
async function getMtimeMs(path: string): Promise<number | null> {
  try {
    const stat = await Deno.stat(path);
    return stat.mtime ? stat.mtime.getTime() : null;
  } catch {
    return null;
  }
}

/** True when the path exists and resolves to a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}
