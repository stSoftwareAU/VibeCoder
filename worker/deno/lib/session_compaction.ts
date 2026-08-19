/**
 * Session compaction for persisted Claude sessions (Issue #1328).
 *
 * Implements progressive compaction to prevent unbounded session growth:
 *   - Level 1 (soft): Remove cached/temporary files (tmp/, cache/, .cache/)
 *   - Level 2 (moderate): Remove old files beyond age threshold, then oldest-first by size
 *   - Level 3 (hard): Delete the entire session directory and start fresh
 *
 * Also provides age-based cleanup of entire session directories that have
 * not been accessed within the configured retention period.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { assertNever } from "./assert_never.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Compaction levels from least to most aggressive. */
export type CompactionLevel = "none" | "soft" | "moderate" | "hard";

/** Result of a single session compaction operation. */
export interface CompactionResult {
  /** Path to the session that was compacted. */
  sessionPath: string;
  /** Compaction level that was applied. */
  level: CompactionLevel;
  /** Session size in bytes before compaction. */
  sizeBefore: number;
  /** Session size in bytes after compaction. */
  sizeAfter: number;
}

/** Result of compacting all sessions in a session store. */
export interface CompactAllResult {
  /** Number of sessions that had compaction applied. */
  sessionsCompacted: number;
  /** Number of sessions removed entirely (age-based or hard compaction). */
  sessionsRemoved: number;
  /** Individual compaction results per session. */
  details: CompactionResult[];
}

/** Options for session compaction. */
export interface CompactionOptions {
  /** Maximum allowed session size in bytes. */
  maxSizeBytes: number;
  /** Maximum age in days for session files. */
  maxAgeDays: number;
  /** Force a specific compaction level (skips auto-detection). */
  level?: CompactionLevel;
}

// ---------------------------------------------------------------------------
// Constants — directory names treated as cache/temporary
// ---------------------------------------------------------------------------

/** Directory names that are safe to remove during soft compaction. */
const CACHE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "tmp",
  "temp",
  "cache",
  ".cache",
  ".tmp",
  "tool-outputs",
  "intermediate",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Measure the total size of a session directory in bytes.
 *
 * Recursively sums all file sizes within the directory. Returns 0
 * if the directory does not exist.
 *
 * @param sessionPath - Absolute path to the session directory
 * @returns Result with the total size in bytes
 */
export async function measureSessionSize(
  sessionPath: string,
): Promise<Result<number>> {
  try {
    const stat = await Deno.stat(sessionPath);
    if (!stat.isDirectory) {
      return { ok: true, value: 0 };
    }
  } catch {
    // Directory does not exist
    return { ok: true, value: 0 };
  }

  try {
    const totalSize = await sumDirectorySize(sessionPath);
    return { ok: true, value: totalSize };
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `Failed to measure session size: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

/**
 * Compact a single session directory using progressive compaction.
 *
 * When `level` is specified, applies that specific compaction level.
 * When omitted, auto-selects by escalating from soft → moderate → hard
 * until the session is under the size threshold (or hard is reached).
 *
 * @param sessionPath - Absolute path to the session directory
 * @param options - Compaction thresholds and optional forced level
 * @returns Result with compaction metrics
 */
export async function compactSession(
  sessionPath: string,
  options: CompactionOptions,
): Promise<Result<CompactionResult>> {
  const sizeBefore = await getDirectorySize(sessionPath);

  // Non-existent directory — nothing to compact
  if (sizeBefore === 0) {
    const dirExists = await directoryExists(sessionPath);
    if (!dirExists) {
      return {
        ok: true,
        value: {
          sessionPath,
          level: options.level ?? "none",
          sizeBefore: 0,
          sizeAfter: 0,
        },
      };
    }
  }

  // If a specific level is forced, apply it directly
  if (options.level) {
    return await applyCompactionLevel(
      sessionPath,
      options.level,
      sizeBefore,
      options,
    );
  }

  // Auto-select: check if compaction is needed
  if (sizeBefore <= options.maxSizeBytes) {
    return {
      ok: true,
      value: {
        sessionPath,
        level: "none",
        sizeBefore,
        sizeAfter: sizeBefore,
      },
    };
  }

  // Escalate through compaction levels
  // Level 1: soft
  const softResult = await applyCompactionLevel(
    sessionPath,
    "soft",
    sizeBefore,
    options,
  );
  if (!softResult.ok) return softResult;
  if (softResult.value.sizeAfter <= options.maxSizeBytes) {
    return softResult;
  }

  // Level 2: moderate
  const moderateResult = await applyCompactionLevel(
    sessionPath,
    "moderate",
    softResult.value.sizeAfter,
    options,
  );
  if (!moderateResult.ok) return moderateResult;
  // Update sizeBefore to reflect original size
  moderateResult.value.sizeBefore = sizeBefore;
  if (moderateResult.value.sizeAfter <= options.maxSizeBytes) {
    return moderateResult;
  }

  // Level 3: hard — delete everything
  const hardResult = await applyCompactionLevel(
    sessionPath,
    "hard",
    moderateResult.value.sizeAfter,
    options,
  );
  if (!hardResult.ok) return hardResult;
  hardResult.value.sizeBefore = sizeBefore;
  return hardResult;
}

/**
 * Compact all sessions in a session store directory.
 *
 * Walks the session store (`.claude-sessions/`) and applies age-based
 * cleanup and size-based compaction to each work stream session.
 *
 * Session directories older than `maxAgeDays` (based on newest file
 * modification time) are removed entirely.
 *
 * @param storePath - Path to the `.claude-sessions/` root
 * @param options - Compaction thresholds
 * @returns Result with aggregate compaction metrics
 */
export async function compactAllSessions(
  storePath: string,
  options: CompactionOptions,
): Promise<Result<CompactAllResult>> {
  const result: CompactAllResult = {
    sessionsCompacted: 0,
    sessionsRemoved: 0,
    details: [],
  };

  // Verify store exists
  if (!(await directoryExists(storePath))) {
    return { ok: true, value: result };
  }

  // Walk the session store: owner/repo/work-stream
  const sessionPaths = await collectSessionPaths(storePath);

  for (const sessionPath of sessionPaths) {
    // Check if session should be removed by age
    const shouldRemove = await isSessionExpired(
      sessionPath,
      options.maxAgeDays,
    );
    if (shouldRemove) {
      try {
        await Deno.remove(sessionPath, { recursive: true });
        result.sessionsRemoved++;
        result.details.push({
          sessionPath,
          level: "hard",
          sizeBefore: await getDirectorySize(sessionPath),
          sizeAfter: 0,
        });
      } catch {
        // Best-effort removal
      }
      continue;
    }

    // Apply size-based compaction
    const compactResult = await compactSession(sessionPath, options);
    if (compactResult.ok && compactResult.value.level !== "none") {
      result.sessionsCompacted++;
      result.details.push(compactResult.value);
      if (compactResult.value.level === "hard") {
        result.sessionsRemoved++;
      }
    }
  }

  return { ok: true, value: result };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Apply a specific compaction level to a session directory.
 */
async function applyCompactionLevel(
  sessionPath: string,
  level: CompactionLevel,
  sizeBefore: number,
  options: CompactionOptions,
): Promise<Result<CompactionResult>> {
  try {
    switch (level) {
      case "none":
        return {
          ok: true,
          value: { sessionPath, level, sizeBefore, sizeAfter: sizeBefore },
        };

      case "soft":
        await removeCacheDirectories(sessionPath);
        break;

      case "moderate":
        await removeCacheDirectories(sessionPath);
        await removeOldFiles(sessionPath, options.maxAgeDays);
        await trimBySize(sessionPath, options.maxSizeBytes);
        break;

      case "hard": {
        try {
          await Deno.remove(sessionPath, { recursive: true });
        } catch {
          // Already gone
        }
        await emitSelfHealEventAuto({
          module: "session_compaction",
          action: "compact_hard",
          reason: `session=${sessionPath} removed`,
          result: "ok",
          bytesReclaimed: sizeBefore,
          details: { sizeBefore, sizeAfter: 0 },
        });
        return {
          ok: true,
          value: { sessionPath, level, sizeBefore, sizeAfter: 0 },
        };
      }
      default:
        return assertNever(level);
    }

    const sizeAfter = await getDirectorySize(sessionPath);
    await emitSelfHealEventAuto({
      module: "session_compaction",
      action: `compact_${level}`,
      reason: `session=${sessionPath}`,
      result: "ok",
      bytesReclaimed: Math.max(0, sizeBefore - sizeAfter),
      details: { sizeBefore, sizeAfter },
    });
    return {
      ok: true,
      value: { sessionPath, level, sizeBefore, sizeAfter },
    };
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `Compaction failed at level ${level}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

/**
 * Remove well-known cache/temporary directories from a session.
 * This is the "soft" compaction step.
 */
async function removeCacheDirectories(sessionPath: string): Promise<void> {
  if (!(await directoryExists(sessionPath))) return;

  try {
    for await (const entry of Deno.readDir(sessionPath)) {
      if (entry.isDirectory && CACHE_DIRECTORY_NAMES.has(entry.name)) {
        try {
          await Deno.remove(`${sessionPath}/${entry.name}`, {
            recursive: true,
          });
        } catch {
          // Best-effort removal
        }
      }
    }
  } catch {
    // Directory may have been removed concurrently
  }
}

/**
 * Remove files older than the age threshold.
 */
async function removeOldFiles(
  sessionPath: string,
  maxAgeDays: number,
): Promise<void> {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const files = await collectAllFiles(sessionPath);
  for (const file of files) {
    if (now - file.mtime > maxAgeMs) {
      try {
        await Deno.remove(file.path);
      } catch {
        // Best-effort removal
      }
    }
  }

  // Clean up empty directories
  await removeEmptyDirectories(sessionPath);
}

/**
 * Remove oldest files until the session is under the size threshold.
 */
async function trimBySize(
  sessionPath: string,
  maxSizeBytes: number,
): Promise<void> {
  const files = await collectAllFiles(sessionPath);
  // Sort oldest first
  files.sort((a, b) => a.mtime - b.mtime);

  let totalSize = files.reduce((sum, f) => sum + f.size, 0);
  for (const file of files) {
    if (totalSize <= maxSizeBytes) break;
    try {
      await Deno.remove(file.path);
      totalSize -= file.size;
    } catch {
      // Best-effort removal
    }
  }

  // Clean up empty directories
  await removeEmptyDirectories(sessionPath);
}

/**
 * Get the total size of a directory, returning 0 if it does not exist.
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  if (!(await directoryExists(dirPath))) return 0;
  try {
    return await sumDirectorySize(dirPath);
  } catch {
    return 0;
  }
}

/**
 * Recursively sum all file sizes in a directory.
 */
async function sumDirectorySize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isDirectory) {
        total += await sumDirectorySize(fullPath);
      } else if (entry.isFile) {
        try {
          const stat = await Deno.stat(fullPath);
          total += stat.size;
        } catch {
          // Skip files we cannot stat
        }
      }
    }
  } catch {
    // Directory may not exist or be unreadable
  }
  return total;
}

/**
 * Collect all files in a directory with their stats.
 */
async function collectAllFiles(
  dirPath: string,
): Promise<Array<{ path: string; size: number; mtime: number }>> {
  const files: Array<{ path: string; size: number; mtime: number }> = [];
  if (!(await directoryExists(dirPath))) return files;

  try {
    for await (const entry of Deno.readDir(dirPath)) {
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isDirectory) {
        const nested = await collectAllFiles(fullPath);
        files.push(...nested);
      } else if (entry.isFile) {
        try {
          const stat = await Deno.stat(fullPath);
          files.push({
            path: fullPath,
            size: stat.size,
            mtime: stat.mtime?.getTime() ?? Date.now(),
          });
        } catch {
          // Skip files we cannot stat
        }
      }
    }
  } catch {
    // Directory may not exist
  }
  return files;
}

/**
 * Check whether a directory exists and is a directory.
 */
async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(dirPath);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Collect all work stream session paths from the session store.
 *
 * Walks the store hierarchy: `storePath/owner/repo/work-stream/`
 * where work-stream is either `default` or `milestone-N`.
 */
async function collectSessionPaths(storePath: string): Promise<string[]> {
  const paths: string[] = [];

  try {
    // Walk owner directories
    for await (const ownerEntry of Deno.readDir(storePath)) {
      if (!ownerEntry.isDirectory) continue;
      const ownerPath = `${storePath}/${ownerEntry.name}`;

      // Walk repo directories
      try {
        for await (const repoEntry of Deno.readDir(ownerPath)) {
          if (!repoEntry.isDirectory) continue;
          const repoPath = `${ownerPath}/${repoEntry.name}`;

          // Walk work stream directories (default, milestone-N)
          try {
            for await (const wsEntry of Deno.readDir(repoPath)) {
              if (!wsEntry.isDirectory) continue;
              paths.push(`${repoPath}/${wsEntry.name}`);
            }
          } catch {
            // Skip unreadable repo dirs
          }
        }
      } catch {
        // Skip unreadable owner dirs
      }
    }
  } catch {
    // Store doesn't exist
  }

  return paths;
}

/**
 * Determine if an entire session directory is expired based on the
 * newest file modification time within it.
 */
async function isSessionExpired(
  sessionPath: string,
  maxAgeDays: number,
): Promise<boolean> {
  const files = await collectAllFiles(sessionPath);
  if (files.length === 0) return true; // Empty sessions are expired

  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const newestMtime = Math.max(...files.map((f) => f.mtime));

  return now - newestMtime > maxAgeMs;
}

/**
 * Remove empty directories recursively (bottom-up).
 */
async function removeEmptyDirectories(dirPath: string): Promise<void> {
  if (!(await directoryExists(dirPath))) return;

  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (entry.isDirectory) {
        const fullPath = `${dirPath}/${entry.name}`;
        await removeEmptyDirectories(fullPath);
      }
    }

    // Check if this directory is now empty
    let isEmpty = true;
    try {
      for await (const _entry of Deno.readDir(dirPath)) {
        isEmpty = false;
        break;
      }
    } catch {
      return;
    }

    if (isEmpty) {
      try {
        await Deno.remove(dirPath);
      } catch {
        // Best-effort
      }
    }
  } catch {
    // Directory may not exist
  }
}
