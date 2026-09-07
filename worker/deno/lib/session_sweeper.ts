/**
 * Startup sweep of abandoned Claude session directories (Issue #1494).
 *
 * Walks every per-repo / per-work-stream session under
 * `${workDir}/.claude-sessions/` and enforces three caps regardless of
 * whether the saving path has touched the session recently:
 *
 *   - **Age** — remove sessions older than `maxAgeDays` (default 7).
 *   - **Size** — remove any single session exceeding `maxSessionSizeBytes`
 *                (default 50 MB).
 *   - **Cumulative** — once per-session enforcement is done, if the total
 *                size across all sessions still exceeds
 *                `maxCumulativeSizeBytes` (default 500 MB), remove oldest
 *                sessions first until under the cap.
 *
 * Sessions with a recent heartbeat for their repo are always preserved,
 * since removing them would disrupt a running worker.
 *
 * The existing save-time enforcement in `session_manager.ts` only fires
 * when a session is written. Milestone sessions that are no longer worked
 * on never trigger it, so they can grow or linger until a heavy-handed
 * WORK_DIR nuke wipes everything. This sweep puts a hard upper bound on
 * total session footprint without waiting for disk pressure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import {
  isHeartbeatEpochLive,
  parseHeartbeatEpoch,
} from "./heartbeat_freshness.ts";

/** Default maximum age in days before an idle session is removed. */
export const DEFAULT_MAX_SESSION_AGE_DAYS = 7;

/** Default maximum size for any single session (50 MB). */
export const DEFAULT_MAX_SESSION_SIZE_BYTES = 50 * 1024 * 1024;

/** Default cumulative cap across every session under .claude-sessions/ (500 MB). */
export const DEFAULT_MAX_CUMULATIVE_SIZE_BYTES = 500 * 1024 * 1024;

/** Options for a single sweep pass. */
export interface SweepOptions {
  /** Worker base directory — the parent of `.claude-sessions/`. */
  workDir: string;
  /** Max age in days before an idle session is removed. */
  maxAgeDays?: number;
  /** Max size for a single session before it is removed. */
  maxSessionSizeBytes?: number;
  /** Max cumulative size across every session. */
  maxCumulativeSizeBytes?: number;
  /** Override the "now" clock (seconds since epoch) for testing. */
  nowFn?: () => number;
}

/** Why a particular session was removed. */
export type SweepReason = "age" | "size" | "cumulative";

/** Record of a single session removal. */
export interface SweepRemoval {
  /** Absolute path of the removed session directory. */
  path: string;
  /** Triggering cap. */
  reason: SweepReason;
  /** Size in bytes at the time of removal. */
  bytes: number;
  /** Modification time epoch (seconds) at the time of removal. */
  mtime: number;
}

/** Outcome of a sweep. */
export interface SweepResult {
  /** Number of candidate sessions inspected. */
  scanned: number;
  /** Sessions preserved because they are active (recent heartbeat). */
  active: string[];
  /** Sessions removed, in removal order. */
  removed: SweepRemoval[];
  /** Non-fatal error messages collected during the sweep. */
  errors: string[];
}

/** Internal record of a session discovered on disk. */
interface SessionRecord {
  /** Absolute path to the work-stream session directory. */
  path: string;
  /** Repository name (the `repo` segment of `owner/repo`). */
  repoName: string;
  /** Total size of files beneath `path`. */
  bytes: number;
  /** Latest mtime beneath `path` (epoch seconds). */
  mtime: number;
}

/**
 * Scan `${workDir}/.claude-sessions/` and enforce age, per-session size,
 * and cumulative size caps.
 *
 * Never throws — all errors are collected into `errors` so the shell
 * wrapper can call this safely during startup.
 */
export async function sweepAllSessions(
  options: SweepOptions,
): Promise<SweepResult> {
  const workDir = options.workDir;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_SESSION_AGE_DAYS;
  const maxAgeSeconds = Math.max(0, maxAgeDays) * 86400;
  const maxSessionSize = options.maxSessionSizeBytes ??
    DEFAULT_MAX_SESSION_SIZE_BYTES;
  const maxCumulativeSize = options.maxCumulativeSizeBytes ??
    DEFAULT_MAX_CUMULATIVE_SIZE_BYTES;
  const nowFn = options.nowFn ?? (() => Math.floor(Date.now() / 1000));
  const now = nowFn();

  const result: SweepResult = {
    scanned: 0,
    active: [],
    removed: [],
    errors: [],
  };

  const sessionsRoot = `${workDir}/.claude-sessions`;

  // Missing sessions root is normal on a fresh install — nothing to sweep.
  const rootExists = await pathExists(sessionsRoot);
  if (!rootExists) {
    // No session store yet — the durable transcript store may still exist
    // and must not escape its caps (Issue #4170).
    await sweepClaudeConfigTranscripts(
      workDir,
      maxAgeSeconds,
      maxSessionSize,
      now,
      result,
    );
    return result;
  }

  const activeRepos = await collectActiveRepos(workDir, maxAgeSeconds, now);

  const sessions = await enumerateSessions(sessionsRoot, result.errors);
  result.scanned = sessions.length;

  // Stage 1: per-session age and size enforcement.
  const survivors: SessionRecord[] = [];
  for (const session of sessions) {
    if (activeRepos.has(session.repoName)) {
      result.active.push(session.path);
      continue;
    }

    if (now - session.mtime > maxAgeSeconds) {
      await removeSession(session, "age", result);
      continue;
    }

    if (session.bytes > maxSessionSize) {
      await removeSession(session, "size", result);
      continue;
    }

    survivors.push(session);
  }

  // Stage 2: cumulative cap — remove oldest first among idle survivors.
  let totalSize = survivors.reduce((sum, s) => sum + s.bytes, 0);
  if (totalSize > maxCumulativeSize) {
    survivors.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const session of survivors) {
      if (totalSize <= maxCumulativeSize) break;
      await removeSession(session, "cumulative", result);
      totalSize -= session.bytes;
    }
  }

  // Stage 3: durable CLI transcripts (Issue #4170) — `.claude-config`
  // shares the session store's age/size caps so transcripts cannot grow
  // unbounded on fleet machines.
  await sweepClaudeConfigTranscripts(
    workDir,
    maxAgeSeconds,
    maxSessionSize,
    now,
    result,
  );

  return result;
}

/**
 * Sweep the durable Claude CLI transcript store (Issue #4170).
 *
 * `CLAUDE_CONFIG_DIR` lives at `${workDir}/.claude-config` so session
 * transcripts survive container death (#4171/#4203) — which also means
 * nothing bounded their growth. This pass applies the session-store caps
 * to `.claude-config/projects/`:
 *
 *   - files older than `maxAgeSeconds` are removed;
 *   - if the surviving total still exceeds `maxSessionSizeBytes`, the
 *     oldest files are removed until under the cap — except files younger
 *     than one day, which may belong to a live or resumable session.
 */
async function sweepClaudeConfigTranscripts(
  workDir: string,
  maxAgeSeconds: number,
  maxSessionSizeBytes: number,
  now: number,
  result: SweepResult,
): Promise<void> {
  const projectsRoot = `${workDir}/.claude-config/projects`;
  if (!(await pathExists(projectsRoot))) return;

  interface TranscriptFile {
    path: string;
    bytes: number;
    mtime: number;
  }
  const files: TranscriptFile[] = [];
  const collect = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await readDirSafe(dir);
    } catch (err) {
      result.errors.push(`Cannot read ${dir}: ${errorMessage(err)}`);
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await collect(path);
        continue;
      }
      if (!entry.isFile) continue;
      try {
        const stat = await Deno.stat(path);
        files.push({
          path,
          bytes: stat.size,
          mtime: stat.mtime ? Math.floor(stat.mtime.getTime() / 1000) : now,
        });
      } catch {
        // Vanished between readDir and stat — ignore.
      }
    }
  };
  await collect(projectsRoot);
  result.scanned += files.length;

  const removeFile = async (
    file: TranscriptFile,
    reason: SweepReason,
  ): Promise<boolean> => {
    try {
      await Deno.remove(file.path);
    } catch (err) {
      result.errors.push(`Cannot remove ${file.path}: ${errorMessage(err)}`);
      return false;
    }
    result.removed.push({
      path: file.path,
      reason,
      bytes: file.bytes,
      mtime: file.mtime,
    });
    return true;
  };

  const survivors: TranscriptFile[] = [];
  for (const file of files) {
    if (now - file.mtime > maxAgeSeconds) {
      await removeFile(file, "age");
      continue;
    }
    survivors.push(file);
  }

  let totalSize = survivors.reduce((sum, f) => sum + f.bytes, 0);
  if (totalSize > maxSessionSizeBytes) {
    survivors.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const file of survivors) {
      if (totalSize <= maxSessionSizeBytes) break;
      // A file younger than a day may be a live or resumable session's
      // transcript — never size-sweep it.
      if (now - file.mtime < 86400) continue;
      if (await removeFile(file, "size")) {
        totalSize -= file.bytes;
      }
    }
  }
}

/**
 * Walk `.claude-sessions/` and return every work-stream session directory.
 *
 * Layout:
 *   `.claude-sessions/{owner}/{repo}/{default,milestone-N}/...`
 *
 * Stray files at any level are ignored — they are not our concern.
 */
async function enumerateSessions(
  sessionsRoot: string,
  errors: string[],
): Promise<SessionRecord[]> {
  const sessions: SessionRecord[] = [];

  let ownerEntries: Deno.DirEntry[];
  try {
    ownerEntries = await readDirSafe(sessionsRoot);
  } catch (err) {
    errors.push(`Cannot read ${sessionsRoot}: ${errorMessage(err)}`);
    return sessions;
  }

  for (const owner of ownerEntries) {
    if (!owner.isDirectory) continue;
    const ownerPath = `${sessionsRoot}/${owner.name}`;

    let repoEntries: Deno.DirEntry[];
    try {
      repoEntries = await readDirSafe(ownerPath);
    } catch (err) {
      errors.push(`Cannot read ${ownerPath}: ${errorMessage(err)}`);
      continue;
    }

    for (const repo of repoEntries) {
      if (!repo.isDirectory) continue;
      const repoPath = `${ownerPath}/${repo.name}`;

      let streamEntries: Deno.DirEntry[];
      try {
        streamEntries = await readDirSafe(repoPath);
      } catch (err) {
        errors.push(`Cannot read ${repoPath}: ${errorMessage(err)}`);
        continue;
      }

      for (const stream of streamEntries) {
        if (!stream.isDirectory) continue;
        // Only `default` or `milestone-{N}` are valid work streams.
        if (
          stream.name !== "default" && !stream.name.startsWith("milestone-")
        ) {
          continue;
        }

        const streamPath = `${repoPath}/${stream.name}`;
        const stats = await summariseDirectory(streamPath);
        sessions.push({
          path: streamPath,
          repoName: repo.name,
          bytes: stats.bytes,
          mtime: stats.mtime,
        });
      }
    }
  }

  return sessions;
}

/**
 * Collect the set of repo names that currently have a fresh heartbeat.
 *
 * Heartbeat filenames use `.heartbeat_{owner}_{repo}_{issue}` stored in
 * `workDir`. A repo is active if any heartbeat for that repo name has a
 * timestamp newer than `now - maxAgeSeconds`.
 *
 * We intentionally match on the `repo` segment only — a running worker
 * might be on any work stream within that repo, and losing that context
 * would defeat the point of per-repo session persistence.
 */
async function collectActiveRepos(
  workDir: string,
  maxAgeSeconds: number,
  now: number,
): Promise<Set<string>> {
  const active = new Set<string>();
  try {
    for await (const entry of Deno.readDir(workDir)) {
      if (!entry.isFile) continue;
      if (!entry.name.startsWith(".heartbeat_")) continue;

      const repoName = parseHeartbeatRepoName(entry.name);
      if (repoName === null) continue;

      try {
        const raw = await Deno.readTextFile(`${workDir}/${entry.name}`);
        const epoch = parseHeartbeatEpoch(raw);
        if (epoch === null) continue;
        // Treat recent heartbeats as "active". Use the session-age window
        // so a worker that has been alive within the sweep horizon still
        // has its session preserved. The window is bounded ahead of now as
        // well (Issue #1232): a future-dated epoch in the agent-writable
        // work root would otherwise pin a repo "active" for ever and stop
        // its sessions being swept.
        if (isHeartbeatEpochLive(epoch, now, Math.max(maxAgeSeconds, 3600))) {
          active.add(repoName);
        }
      } catch {
        // Unreadable heartbeat — ignore.
      }
    }
  } catch {
    // No workDir to scan — treat as "no active repos".
  }
  return active;
}

/**
 * Extract the repo name from a heartbeat filename
 * `.heartbeat_{owner}_{repo}_{issue}`.
 *
 * Owner and repo segments may themselves contain underscores, so we strip
 * the trailing `_{issue}` and the leading `{owner}_` to get the repo.
 */
function parseHeartbeatRepoName(filename: string): string | null {
  const prefix = ".heartbeat_";
  if (!filename.startsWith(prefix)) return null;
  const body = filename.slice(prefix.length);
  const lastUnderscore = body.lastIndexOf("_");
  if (lastUnderscore < 0) return null;
  const issueSegment = body.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(issueSegment)) return null;
  const ownerAndRepo = body.slice(0, lastUnderscore);
  const firstUnderscore = ownerAndRepo.indexOf("_");
  if (firstUnderscore < 0) return null;
  return ownerAndRepo.slice(firstUnderscore + 1);
}

/**
 * Compute total byte size and latest mtime beneath `dirPath`.
 *
 * Uses the directory's own mtime as a floor so an empty or recently
 * created session still has a sensible age.
 */
async function summariseDirectory(
  dirPath: string,
): Promise<{ bytes: number; mtime: number }> {
  let bytes = 0;
  let latestMtime = 0;

  try {
    const dirStat = await Deno.stat(dirPath);
    if (dirStat.mtime) {
      latestMtime = Math.floor(dirStat.mtime.getTime() / 1000);
    }
  } catch {
    // Directory disappeared — return zero, caller will see no files.
  }

  async function walk(path: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(path)) {
        const childPath = `${path}/${entry.name}`;
        if (entry.isDirectory) {
          await walk(childPath);
        } else if (entry.isFile) {
          try {
            const stat = await Deno.stat(childPath);
            bytes += stat.size;
            const mtime = stat.mtime
              ? Math.floor(stat.mtime.getTime() / 1000)
              : 0;
            if (mtime > latestMtime) latestMtime = mtime;
          } catch {
            // Skip files we cannot stat.
          }
        }
      }
    } catch {
      // Unreadable subdirectory — ignore.
    }
  }

  await walk(dirPath);
  return { bytes, mtime: latestMtime };
}

/** Remove a session directory and record the outcome. */
async function removeSession(
  session: SessionRecord,
  reason: SweepReason,
  result: SweepResult,
): Promise<void> {
  try {
    await Deno.remove(session.path, { recursive: true });
    result.removed.push({
      path: session.path,
      reason,
      bytes: session.bytes,
      mtime: session.mtime,
    });
    console.log(
      `SELF-HEALING: removed ${reason} session ${session.path} ` +
        `(${session.bytes} bytes, mtime=${session.mtime})`,
    );
    recordFaultEvent(
      "disk_space_cleanup",
      `session_sweeper removed ${reason} ${session.path}`,
    );
  } catch (err) {
    const msg = errorMessage(err);
    result.errors.push(`Failed to remove ${session.path}: ${msg}`);
    console.warn(
      `SELF-HEALING: failed to remove ${reason} session ${session.path}: ${msg}`,
    );
  }
}

/** Read a directory into an array; throws on error. */
async function readDirSafe(path: string): Promise<Deno.DirEntry[]> {
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(path)) {
    entries.push(entry);
  }
  return entries;
}

/** Return true when `path` exists and is accessible. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Normalise an unknown error to a string message. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
