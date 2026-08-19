/**
 * Hybrid retention policy for worker-PID.log files.
 *
 * Issue #1902: the previous count-based policy (`KEEP_LOG_COUNT=10`) destroyed
 * overnight diagnostics during restart storms — ten quick restarts after a
 * stall would wipe the long-running log that contained the stall evidence.
 *
 * The new policy is age-based with two safety nets:
 *
 *  1. Header-only stubs (< {@link DEFAULT_HEADER_ONLY_MAX_BYTES} bytes) older
 *     than {@link DEFAULT_HEADER_ONLY_MIN_AGE_MINUTES} minutes are deleted.
 *     These carry no diagnostic value and accumulate quickly during PID-guard
 *     storms.
 *  2. Any log older than {@link DEFAULT_MAX_AGE_DAYS} days is deleted, matching
 *     the existing `~/logs` cleanup window.
 *  3. A hard cap of {@link DEFAULT_HARD_CAP_COUNT} files prevents pathological
 *     growth — the oldest files above the cap are removed.
 *
 * Logs that are large (≥ 200 bytes) and young (< 3 days) are always preserved.
 *
 * Issue #4027: prior runs' logs are gzipped at worker start, so the same rules
 * apply to `worker-<PID>.log.gz` files. The stub rule (1) is the one exception —
 * it applies to plain logs only, because a well-compressed multi-KiB log can
 * shrink below the stub threshold and must not be mistaken for a stub.
 */

/** Header-only files smaller than this many bytes are eligible for early deletion. */
export const DEFAULT_HEADER_ONLY_MAX_BYTES = 200;

/** Header-only files must be at least this old (minutes) before they are deleted. */
export const DEFAULT_HEADER_ONLY_MIN_AGE_MINUTES = 60;

/** Maximum age in days for any worker log, regardless of size. */
export const DEFAULT_MAX_AGE_DAYS = 3;

/** Hard ceiling on the number of worker-PID.log files retained. */
export const DEFAULT_HARD_CAP_COUNT = 200;

/**
 * Age in days after which an unrecognised plain file in the log directory
 * is removed (Issue #4306). `~/logs` is a shared junk drawer: 748
 * `node-*.log` and 747 `stage-*.state` orphans from a long-gone native
 * run sat there indefinitely because the cleanup only matched its own
 * patterns. Anything a live subsystem owns has a fresh mtime; a plain
 * file untouched for this long is debris. Symlinks and directories are
 * never touched.
 */
export const DEFAULT_FOREIGN_FILE_MAX_AGE_DAYS = 14;

/** Options controlling {@link cleanupWorkerLogs}. */
export interface WorkerLogCleanupOptions {
  /** Size threshold for header-only stubs (bytes). */
  headerOnlyMaxBytes?: number;
  /** Minimum age (minutes) before a header-only stub may be deleted. */
  headerOnlyMinAgeMinutes?: number;
  /** Maximum age in days before any log is deleted. */
  maxAgeDays?: number;
  /** Hard cap on retained file count (oldest above the cap are deleted). */
  hardCapCount?: number;
  /** Age in days before an unrecognised plain file is removed (Issue #4306). */
  foreignFileMaxAgeDays?: number;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

/** Result of a cleanup pass. */
export interface WorkerLogCleanupResult {
  /** Absolute paths of deleted files. */
  deleted: string[];
  /** Unrecognised debris files removed by the foreign-file pass (Issue #4306). */
  foreignDeleted?: string[];
  /** Count of files that survived the pass. */
  kept: number;
  /** Human-readable summary. */
  message: string;
}

/** Pattern that matches `worker-<digits>.log`, plain or gzipped (Issue #4027). */
const WORKER_LOG_PATTERN = /^worker-\d+(?:-\d+)*\.log(\.gz)?$/;

/**
 * Pattern that matches agent stream-json transcripts (Issue #4169):
 * `agent-<runid>[-<issue>].jsonl`, including log_rotation.ts backups
 * (`.jsonl.N`) and gzipped forms. Transcripts are debug artefacts, so the
 * same age/stub/cap retention applies to them as to the worker logs.
 */
const AGENT_TRANSCRIPT_PATTERN =
  /^agent-vibe-[A-Za-z0-9-]+\.jsonl(\.\d+)?(\.gz)?$/;

interface LogEntry {
  path: string;
  size: number;
  mtimeMs: number;
  /** Whether the entry is a gzipped log (`.log.gz`). */
  gzipped: boolean;
}

/**
 * Apply the hybrid retention policy to `worker-*.log` files in `logDir`.
 *
 * The function is safe to call on a missing or empty directory — it returns
 * an empty result rather than throwing.
 */
export async function cleanupWorkerLogs(
  logDir: string,
  options: WorkerLogCleanupOptions = {},
): Promise<WorkerLogCleanupResult> {
  const headerOnlyMaxBytes = options.headerOnlyMaxBytes ??
    DEFAULT_HEADER_ONLY_MAX_BYTES;
  const headerOnlyMinAgeMs =
    (options.headerOnlyMinAgeMinutes ?? DEFAULT_HEADER_ONLY_MIN_AGE_MINUTES) *
    60_000;
  const maxAgeMs = (options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 *
    60_000;
  const hardCapCount = options.hardCapCount ?? DEFAULT_HARD_CAP_COUNT;
  const foreignMaxAgeMs = (options.foreignFileMaxAgeDays ??
    DEFAULT_FOREIGN_FILE_MAX_AGE_DAYS) * 24 * 60 * 60_000;
  const nowMs = (options.now ?? new Date()).getTime();

  // Read directory contents, returning empty result if the directory is gone.
  const entries: LogEntry[] = [];
  const foreignCandidates: { path: string; mtimeMs: number }[] = [];
  try {
    for await (const dirEntry of Deno.readDir(logDir)) {
      if (!dirEntry.isFile) continue;
      if (
        !WORKER_LOG_PATTERN.test(dirEntry.name) &&
        !AGENT_TRANSCRIPT_PATTERN.test(dirEntry.name)
      ) {
        // Foreign-file pass (Issue #4306): unrecognised plain files age
        // out too, so debris from other subsystems cannot pile up in the
        // shared log directory forever. Symlinks and directories never
        // reach here (`isFile` is false for both).
        const foreignPath = `${logDir}/${dirEntry.name}`;
        try {
          const stat = await Deno.stat(foreignPath);
          const mtimeMs = stat.mtime?.getTime() ?? nowMs;
          if (nowMs - mtimeMs > foreignMaxAgeMs) {
            foreignCandidates.push({ path: foreignPath, mtimeMs });
          }
        } catch {
          // Vanished between readDir and stat
        }
        continue;
      }
      const fullPath = `${logDir}/${dirEntry.name}`;
      try {
        const stat = await Deno.stat(fullPath);
        const mtimeMs = stat.mtime?.getTime() ?? nowMs;
        entries.push({
          path: fullPath,
          size: stat.size,
          mtimeMs,
          gzipped: dirEntry.name.endsWith(".gz"),
        });
      } catch {
        // Skip files that vanished between readDir and stat
      }
    }
  } catch {
    return {
      deleted: [],
      kept: 0,
      message: "log directory missing or unreadable",
    };
  }

  const deleted: string[] = [];

  // Pass 1: aggressively prune header-only stubs older than the min age.
  // Gzipped logs are exempt — their compressed size says nothing about whether
  // the original was a stub (Issue #4027), and stubs are never compressed.
  for (const entry of entries) {
    if (entry.gzipped) continue;
    const ageMs = nowMs - entry.mtimeMs;
    if (entry.size < headerOnlyMaxBytes && ageMs > headerOnlyMinAgeMs) {
      if (await tryRemove(entry.path)) {
        deleted.push(entry.path);
      }
    }
  }

  // Pass 2: delete anything older than the max age cap
  for (const entry of entries) {
    if (deleted.includes(entry.path)) continue;
    const ageMs = nowMs - entry.mtimeMs;
    if (ageMs > maxAgeMs) {
      if (await tryRemove(entry.path)) {
        deleted.push(entry.path);
      }
    }
  }

  // Pass 3: hard cap — if we still have more than hardCapCount files, delete
  // the oldest until we're back under the cap. This protects against
  // pathological cases (e.g. thousands of fresh stubs) while leaving the
  // typical steady-state untouched.
  const remaining = entries
    .filter((e) => !deleted.includes(e.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  const excess = remaining.length - hardCapCount;
  for (let i = 0; i < excess; i++) {
    const entry = remaining[i]!;
    if (await tryRemove(entry.path)) {
      deleted.push(entry.path);
    }
  }

  // Foreign-file pass (Issue #4306).
  const foreignDeleted: string[] = [];
  for (const candidate of foreignCandidates) {
    if (await tryRemove(candidate.path)) {
      foreignDeleted.push(candidate.path);
    }
  }

  const kept = entries.length - deleted.length;
  return {
    deleted,
    ...(foreignDeleted.length > 0 ? { foreignDeleted } : {}),
    kept,
    message: `worker log cleanup: deleted ${deleted.length}, kept ${kept}` +
      (foreignDeleted.length > 0
        ? `, foreign debris removed ${foreignDeleted.length}`
        : ""),
  };
}

async function tryRemove(path: string): Promise<boolean> {
  try {
    await Deno.remove(path);
    return true;
  } catch {
    return false;
  }
}
