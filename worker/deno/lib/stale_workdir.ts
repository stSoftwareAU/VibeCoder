/**
 * Stale repository work directory detection and cleanup (Issue #1493).
 *
 * Scans repository clones under `workDir` and classifies each as active,
 * stale, or partial. Stale or partial directories are removed so the next
 * run can re-clone cleanly, avoiding wasted disk without the heavy-handed
 * full-nuke triggered only at 90% disk pressure by `disk_space.ts`.
 *
 * Classification rules per entry `${workDir}/${name}`:
 *   - Skipped          — dot-prefixed (e.g. `.claude-sessions`, heartbeat
 *                        files, marker state) or non-directory entries.
 *   - **Partial**      — directory exists but `.git` is missing — remove so
 *                        the next clone re-initialises cleanly.
 *   - **Active**       — a heartbeat file `.heartbeat_*_{name}_{issue}`
 *                        has a timestamp newer than `now - maxAge`,
 *                        OR the directory mtime is newer than `now - maxAge`.
 *   - **Stale**        — no recent heartbeat and mtime is older than
 *                        `now - maxAge` — remove.
 *
 * Every removal logs a single `SELF-HEALING:` line so the shell wrapper
 * and operators can audit the cleanup.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { isProtectedBranch } from "./git_branch.ts";
import { runGitCommand } from "./git_timeout.ts";
import { LANE_WORKTREE_ROOT } from "./lane_worktree.ts";

/** Default age threshold in days before a repo clone with no heartbeat is stale. */
export const DEFAULT_STALE_WORKDIR_DAYS = 7;

/**
 * Subdirectory names that are *not* repository clones and must be left
 * alone by the scanner. Without this list the scanner classifies them
 * as "partial" (no `.git`) and deletes them every cycle, only for the
 * owning subsystem to recreate them on the next call.
 *
 * - `logs` — `self_heal_events.ts` writes `${workDir}/logs/self-heal.jsonl`.
 * - `lost+found` — the vibe-work named volume (#4203) is a real ext4
 *   filesystem whose root always carries this root-owned directory; the
 *   worker (uid 1000) cannot remove it, and trying produced a
 *   Permission-denied SELF-HEALING warning every cycle (Issue #4212).
 * - `audit` — `audit_journal.ts` writes the hash-chained mutation journals
 *   to `${WORK_DIR}/audit/`. It has no `.git` and sits untouched between
 *   sweeps, so every housekeeping path treated it as a disposable clone and
 *   deleted the worker's own tamper-evident record — `audit-chain-verify`
 *   then reported `AUDIT_CHAIN_BROKEN` on every swept host (Issue #337).
 * - `worktrees` — `lane_worktree.ts` puts each lane's linked worktree under
 *   `${WORK_DIR}/worktrees/<lane>/<repo>` so lanes stop sharing one clone's
 *   `HEAD`, index and working tree (Issue #394). The directory itself holds
 *   no clone, and removing a live worktree's checkout under the lane using
 *   it is the very collision it exists to prevent.
 */
export const RESERVED_WORKDIR_NAMES: ReadonlySet<string> = new Set([
  "logs",
  "lost+found",
  "audit",
  LANE_WORKTREE_ROOT,
]);

/**
 * Work-root **file** names that belong to a reserved subsystem rather than
 * to a clone: the audit trail's roster and its last-known-non-empty marker,
 * kept beside (not inside) `audit/` precisely so removing the directory
 * cannot remove the expectation (Issues #3949, #270).
 */
const RESERVED_WORKDIR_FILES: ReadonlySet<string> = new Set([
  "audit.roster.jsonl",
  "audit.roster.seen",
]);

/**
 * Prefix of the sidecars a torn-roster repair preserves (Issue #1202).
 *
 * `audit.roster.jsonl.torn-<n>` holds the bytes a repair moved aside rather
 * than deleted. Letting housekeeping remove them would delete the only copy
 * of the evidence the repair promised to keep.
 */
const RESERVED_ROSTER_TORN_PREFIX = "audit.roster.jsonl.torn-";

/**
 * Is this work-root entry owned by a subsystem and off-limits to every
 * cleanup sweep? Covers {@link RESERVED_WORKDIR_NAMES} and the audit
 * trail's sibling files, so a sweep that walks files as well as directories
 * (`nukeWorkDir`) cannot half-erase the trail (Issue #337).
 *
 * @param name - Entry name directly under the work root
 * @returns True when the entry must be left alone
 */
export function isReservedWorkRootEntry(name: string): boolean {
  return RESERVED_WORKDIR_NAMES.has(name) ||
    RESERVED_WORKDIR_FILES.has(name) ||
    name.startsWith(RESERVED_ROSTER_TORN_PREFIX);
}

/** Options for scanning the work directory. */
export interface StaleWorkDirOptions {
  /** Directory containing repository clones (usually WORK_DIR). */
  workDir: string;
  /** Age threshold in days — defaults to {@link DEFAULT_STALE_WORKDIR_DAYS}. */
  maxAgeDays?: number;
  /** Override the "now" clock for testing. Returns epoch seconds. */
  nowFn?: () => number;
}

/** Outcome of a single work-directory scan. */
export interface StaleWorkDirResult {
  /** Number of candidate directories inspected. */
  scanned: number;
  /** Names preserved because they are active. */
  active: string[];
  /** Names removed because they were stale (old mtime, no heartbeat). */
  removedStale: string[];
  /** Names removed because they were partial (missing `.git`). */
  removedPartial: string[];
  /** Human-readable error messages collected during the scan. */
  errors: string[];
}

/** Classification of a single repository work directory. */
export type WorkDirClassification =
  | { kind: "active"; reason: string }
  | { kind: "stale"; reason: string }
  | { kind: "partial"; reason: string };

/**
 * Classify a single repository work directory.
 *
 * Inspects heartbeat files in `workDir`, the presence of `.git`, and
 * the directory mtime to decide the correct disposition.
 */
export async function classifyWorkDir(
  workDir: string,
  repoDir: string,
  maxAgeSeconds: number,
  now: number,
): Promise<WorkDirClassification> {
  const repoName = basename(repoDir);

  // 1. Live heartbeat pinned to this repo keeps it alive regardless of mtime.
  const heartbeatHit = await findRecentHeartbeat(
    workDir,
    repoName,
    maxAgeSeconds,
    now,
  );
  if (heartbeatHit !== null) {
    return {
      kind: "active",
      reason: `heartbeat ${heartbeatHit.filename} within window`,
    };
  }

  // 2. Missing `.git` — the clone is partial/broken.
  const hasGit = await pathExists(`${repoDir}/.git`);
  if (!hasGit) {
    return { kind: "partial", reason: ".git missing or inaccessible" };
  }

  // 3. Mtime-based freshness check.
  try {
    const stat = await Deno.stat(repoDir);
    const mtime = stat.mtime;
    if (mtime !== null) {
      const ageSeconds = now - Math.floor(mtime.getTime() / 1000);
      if (ageSeconds <= maxAgeSeconds) {
        const days = (ageSeconds / 86400).toFixed(1);
        return { kind: "active", reason: `modified ${days} days ago` };
      }
      const days = (ageSeconds / 86400).toFixed(1);
      return {
        kind: "stale",
        reason: `modified ${days} days ago, exceeds threshold`,
      };
    }
  } catch (err) {
    // Fall through — unreadable stat is treated as stale below.
    recordFaultEvent(
      "catch_block_warning",
      `stale_workdir stat failed for ${repoDir}: ${err}`,
    );
  }

  return { kind: "stale", reason: "no mtime available" };
}

/**
 * Scan `workDir` and remove stale or partial repository clones.
 *
 * Returns a summary describing which entries were scanned, preserved,
 * or removed. Errors reading `workDir` or removing a specific entry are
 * collected into `errors` — they never throw out of this function so
 * callers can rely on it during startup.
 */
export async function scanAndCleanupStaleWorkDirs(
  options: StaleWorkDirOptions,
): Promise<StaleWorkDirResult> {
  const workDir = options.workDir;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_STALE_WORKDIR_DAYS;
  const maxAgeSeconds = Math.max(0, maxAgeDays) * 86400;
  const nowFn = options.nowFn ?? (() => Math.floor(Date.now() / 1000));
  const now = nowFn();

  const result: StaleWorkDirResult = {
    scanned: 0,
    active: [],
    removedStale: [],
    removedPartial: [],
    errors: [],
  };

  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(workDir)) {
      entries.push(entry);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Cannot read ${workDir}: ${msg}`);
    return result;
  }

  for (const entry of entries) {
    // Skip dotfiles/dotdirs — these are heartbeats, marker state,
    // .claude-sessions, .vibe_* metadata, etc. and are owned by other
    // subsystems.
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory) continue;
    // Skip reserved non-repo subdirs that other subsystems own. Without
    // this guard the scanner deletes them every cycle and the owning
    // subsystem recreates them — see RESERVED_WORKDIR_NAMES.
    if (isReservedWorkRootEntry(entry.name)) continue;

    result.scanned++;
    const repoDir = `${workDir}/${entry.name}`;

    const classification = await classifyWorkDir(
      workDir,
      repoDir,
      maxAgeSeconds,
      now,
    );

    if (classification.kind === "active") {
      result.active.push(entry.name);
      continue;
    }

    // Push-before-delete guard (Issue #4170): a stale clone may hold the
    // only copy of a killed session's commits. Push every branch that is
    // ahead of its remote before removal; if any push fails, keep the
    // directory (loud warning) so the work survives for another cycle.
    if (classification.kind === "stale") {
      const rescue = await pushUnpushedBranches(repoDir);
      if (!rescue.ok) {
        result.errors.push(
          `Kept ${repoDir}: unpushed commits could not be pushed (${rescue.detail})`,
        );
        console.warn(
          `SELF-HEALING: NOT removing stale work directory ${repoDir} — it ` +
            `has unpushed commits and pushing them failed (${rescue.detail}). ` +
            `The work is preserved for another cycle; push it manually if ` +
            `this repeats.`,
        );
        continue;
      }
      if (rescue.pushedBranches.length > 0) {
        console.log(
          `SELF-HEALING: pushed unpushed work from ${repoDir} before ` +
            `removal (branches: ${rescue.pushedBranches.join(", ")})`,
        );
      }
    }

    const removedOk = await removeDirectory(repoDir);
    if (!removedOk.ok) {
      result.errors.push(
        `Failed to remove ${repoDir}: ${removedOk.error}`,
      );
      console.warn(
        `SELF-HEALING: failed to remove ${classification.kind} work directory ` +
          `${repoDir}: ${removedOk.error}`,
      );
      continue;
    }

    if (classification.kind === "stale") {
      result.removedStale.push(entry.name);
    } else {
      result.removedPartial.push(entry.name);
    }

    console.log(
      `SELF-HEALING: removed ${classification.kind} work directory ` +
        `${repoDir} (${classification.reason})`,
    );
    recordFaultEvent(
      "disk_space_cleanup",
      `stale_workdir removed ${classification.kind} ${repoDir}`,
    );
  }

  return result;
}

/**
 * Find a heartbeat file in `workDir` that references the given repo name
 * and has a timestamp newer than `now - maxAgeSeconds`.
 *
 * Heartbeat filenames use the format `.heartbeat_{owner}_{repo}_{issue}`.
 * Only the repo segment needs to match — the issue number and owner are
 * free to vary.
 */
async function findRecentHeartbeat(
  workDir: string,
  repoName: string,
  maxAgeSeconds: number,
  now: number,
): Promise<{ filename: string; epoch: number } | null> {
  try {
    for await (const entry of Deno.readDir(workDir)) {
      if (!entry.isFile) continue;
      if (!entry.name.startsWith(".heartbeat_")) continue;
      if (!filenameReferencesRepo(entry.name, repoName)) continue;

      try {
        const raw = await Deno.readTextFile(`${workDir}/${entry.name}`);
        const epoch = parseInt(raw.trim(), 10);
        if (isNaN(epoch)) continue;
        if (now - epoch <= maxAgeSeconds) {
          return { filename: entry.name, epoch };
        }
      } catch {
        // Unreadable heartbeat — ignore.
      }
    }
  } catch {
    // Parent directory gone during scan — treat as "no heartbeat".
  }
  return null;
}

/**
 * Check whether a heartbeat filename references the given repo name.
 *
 * The filename format is `.heartbeat_{owner}_{repo}_{issue}`. Because
 * owner and repo segments may themselves contain underscores, we strip
 * the trailing `_{issue}` and the leading `{owner}_` and check whether
 * the remainder equals the repo name.
 */
function filenameReferencesRepo(filename: string, repoName: string): boolean {
  const prefix = ".heartbeat_";
  if (!filename.startsWith(prefix)) return false;
  const body = filename.slice(prefix.length);
  const lastUnderscore = body.lastIndexOf("_");
  if (lastUnderscore < 0) return false;
  const issueSegment = body.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(issueSegment)) return false;
  const ownerAndRepo = body.slice(0, lastUnderscore);
  const firstUnderscore = ownerAndRepo.indexOf("_");
  if (firstUnderscore < 0) return false;
  const repoPart = ownerAndRepo.slice(firstUnderscore + 1);
  return repoPart === repoName;
}

/** Outcome of the push-before-delete rescue (Issue #4170). */
export interface UnpushedRescueResult {
  /** True when the directory is safe to delete (nothing unpushed remains). */
  ok: boolean;
  /** Branches that were pushed by the rescue. */
  pushedBranches: string[];
  /** Failure detail when `ok` is false. */
  detail: string;
}

/**
 * Push every local branch of `repoDir` that is ahead of its remote
 * counterpart (or has no remote counterpart) to origin (Issue #4170).
 *
 * Protected branches are never pushed — a stale clone must not be the
 * thing that writes to `main`/`Develop`; unpushed commits there fail the
 * rescue instead, keeping the directory. Any git failure fails the
 * rescue: the caller keeps the directory rather than deleting unpushed
 * work.
 */
export async function pushUnpushedBranches(
  repoDir: string,
): Promise<UnpushedRescueResult> {
  // Issue #1214: every git spawn goes through the timeout chokepoint, so a
  // stalled remote fails the rescue instead of hanging the sweep.
  const run = async (args: string[]) => {
    const result = await runGitCommand(["-C", repoDir, ...args]);
    if (!result.ok) {
      return { code: -1, stdout: "", stderr: result.error.message };
    }
    return result.value;
  };

  // Fast path: nothing anywhere is ahead of any remote — safe to delete.
  const anyUnpushed = await run([
    "log",
    "--branches",
    "--not",
    "--remotes",
    "--oneline",
    "-1",
  ]);
  if (anyUnpushed.code !== 0) {
    // A directory git cannot even read as a repository (empty or corrupt
    // `.git`) has no rescuable commits — deleting it loses nothing, so
    // fail open. Every other git failure fails closed: the caller keeps
    // the directory rather than deleting possibly-unpushed work.
    if (/not a git repository/i.test(anyUnpushed.stderr)) {
      return { ok: true, pushedBranches: [], detail: "" };
    }
    return {
      ok: false,
      pushedBranches: [],
      detail: `git log failed: ${anyUnpushed.stderr.trim() || "unknown"}`,
    };
  }
  if (anyUnpushed.stdout.trim().length === 0) {
    return { ok: true, pushedBranches: [], detail: "" };
  }

  const branchList = await run([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (branchList.code !== 0) {
    return {
      ok: false,
      pushedBranches: [],
      detail: `git for-each-ref failed: ${branchList.stderr.trim()}`,
    };
  }

  const pushed: string[] = [];
  for (const branch of branchList.stdout.split("\n")) {
    const name = branch.trim();
    if (!name) continue;
    // A branch is unpushed when it has commits not on origin/<name>
    // (a missing remote ref makes rev-list fail — treat as unpushed).
    const ahead = await run([
      "rev-list",
      "--count",
      `origin/${name}..${name}`,
    ]);
    const isUnpushed = ahead.code !== 0 ||
      (parseInt(ahead.stdout.trim(), 10) || 0) > 0;
    if (!isUnpushed) continue;

    if (isProtectedBranch(name)) {
      return {
        ok: false,
        pushedBranches: pushed,
        detail:
          `branch '${name}' has unpushed commits but is protected — not ` +
          `pushing, not deleting`,
      };
    }

    const push = await run(["push", "origin", `${name}:${name}`]);
    if (push.code !== 0) {
      return {
        ok: false,
        pushedBranches: pushed,
        detail: `push of '${name}' failed: ${push.stderr.trim() || "unknown"}`,
      };
    }
    pushed.push(name);
  }

  return { ok: true, pushedBranches: pushed, detail: "" };
}

/** Return true when the path exists and is accessible. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Remove a directory recursively; returns Result-style outcome. */
async function removeDirectory(
  path: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await Deno.remove(path, { recursive: true });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Minimal path-basename implementation (avoids std/path import). */
function basename(p: string): string {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}
