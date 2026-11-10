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
 */ import { assertNever } from "./assert_never.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";
// ---------------------------------------------------------------------------
// Constants — directory names treated as cache/temporary
// ---------------------------------------------------------------------------
/** Directory names that are safe to remove during soft compaction. */ const CACHE_DIRECTORY_NAMES = new Set([
  "tmp",
  "temp",
  "cache",
  ".cache",
  ".tmp",
  "tool-outputs",
  "intermediate"
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
 */ export async function measureSessionSize(sessionPath) {
  try {
    const stat = await Deno.stat(sessionPath);
    if (!stat.isDirectory) {
      return {
        ok: true,
        value: 0
      };
    }
  } catch  {
    // Directory does not exist
    return {
      ok: true,
      value: 0
    };
  }
  try {
    const totalSize = await sumDirectorySize(sessionPath);
    return {
      ok: true,
      value: totalSize
    };
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Failed to measure session size: ${error instanceof Error ? error.message : String(error)}`)
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
 */ export async function compactSession(sessionPath, options) {
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
          sizeAfter: 0
        }
      };
    }
  }
  // If a specific level is forced, apply it directly
  if (options.level) {
    return await applyCompactionLevel(sessionPath, options.level, sizeBefore, options);
  }
  // Auto-select: check if compaction is needed
  if (sizeBefore <= options.maxSizeBytes) {
    return {
      ok: true,
      value: {
        sessionPath,
        level: "none",
        sizeBefore,
        sizeAfter: sizeBefore
      }
    };
  }
  // Escalate through compaction levels
  // Level 1: soft
  const softResult = await applyCompactionLevel(sessionPath, "soft", sizeBefore, options);
  if (!softResult.ok) return softResult;
  if (softResult.value.sizeAfter <= options.maxSizeBytes) {
    return softResult;
  }
  // Level 2: moderate
  const moderateResult = await applyCompactionLevel(sessionPath, "moderate", softResult.value.sizeAfter, options);
  if (!moderateResult.ok) return moderateResult;
  // Update sizeBefore to reflect original size
  moderateResult.value.sizeBefore = sizeBefore;
  if (moderateResult.value.sizeAfter <= options.maxSizeBytes) {
    return moderateResult;
  }
  // Level 3: hard — delete everything
  const hardResult = await applyCompactionLevel(sessionPath, "hard", moderateResult.value.sizeAfter, options);
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
 */ export async function compactAllSessions(storePath, options) {
  const result = {
    sessionsCompacted: 0,
    sessionsRemoved: 0,
    details: []
  };
  // Verify store exists
  if (!await directoryExists(storePath)) {
    return {
      ok: true,
      value: result
    };
  }
  // Walk the session store: owner/repo/work-stream
  const sessionPaths = await collectSessionPaths(storePath);
  for (const sessionPath of sessionPaths){
    // Check if session should be removed by age
    const shouldRemove = await isSessionExpired(sessionPath, options.maxAgeDays);
    if (shouldRemove) {
      try {
        await Deno.remove(sessionPath, {
          recursive: true
        });
        result.sessionsRemoved++;
        result.details.push({
          sessionPath,
          level: "hard",
          sizeBefore: await getDirectorySize(sessionPath),
          sizeAfter: 0
        });
      } catch  {
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
  return {
    ok: true,
    value: result
  };
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Apply a specific compaction level to a session directory.
 */ async function applyCompactionLevel(sessionPath, level, sizeBefore, options) {
  try {
    switch(level){
      case "none":
        return {
          ok: true,
          value: {
            sessionPath,
            level,
            sizeBefore,
            sizeAfter: sizeBefore
          }
        };
      case "soft":
        await removeCacheDirectories(sessionPath);
        break;
      case "moderate":
        await removeCacheDirectories(sessionPath);
        await removeOldFiles(sessionPath, options.maxAgeDays);
        await trimBySize(sessionPath, options.maxSizeBytes);
        break;
      case "hard":
        {
          try {
            await Deno.remove(sessionPath, {
              recursive: true
            });
          } catch  {
          // Already gone
          }
          await emitSelfHealEventAuto({
            module: "session_compaction",
            action: "compact_hard",
            reason: `session=${sessionPath} removed`,
            result: "ok",
            bytesReclaimed: sizeBefore,
            details: {
              sizeBefore,
              sizeAfter: 0
            }
          });
          return {
            ok: true,
            value: {
              sessionPath,
              level,
              sizeBefore,
              sizeAfter: 0
            }
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
      details: {
        sizeBefore,
        sizeAfter
      }
    });
    return {
      ok: true,
      value: {
        sessionPath,
        level,
        sizeBefore,
        sizeAfter
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Compaction failed at level ${level}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
}
/**
 * Remove well-known cache/temporary directories from a session.
 * This is the "soft" compaction step.
 */ async function removeCacheDirectories(sessionPath) {
  if (!await directoryExists(sessionPath)) return;
  try {
    for await (const entry of Deno.readDir(sessionPath)){
      if (entry.isDirectory && CACHE_DIRECTORY_NAMES.has(entry.name)) {
        try {
          await Deno.remove(`${sessionPath}/${entry.name}`, {
            recursive: true
          });
        } catch  {
        // Best-effort removal
        }
      }
    }
  } catch  {
  // Directory may have been removed concurrently
  }
}
/**
 * Remove files older than the age threshold.
 */ async function removeOldFiles(sessionPath, maxAgeDays) {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const files = await collectAllFiles(sessionPath);
  for (const file of files){
    if (now - file.mtime > maxAgeMs) {
      try {
        await Deno.remove(file.path);
      } catch  {
      // Best-effort removal
      }
    }
  }
  // Clean up empty directories
  await removeEmptyDirectories(sessionPath);
}
/**
 * Remove oldest files until the session is under the size threshold.
 */ async function trimBySize(sessionPath, maxSizeBytes) {
  const files = await collectAllFiles(sessionPath);
  // Sort oldest first
  files.sort((a, b)=>a.mtime - b.mtime);
  let totalSize = files.reduce((sum, f)=>sum + f.size, 0);
  for (const file of files){
    if (totalSize <= maxSizeBytes) break;
    try {
      await Deno.remove(file.path);
      totalSize -= file.size;
    } catch  {
    // Best-effort removal
    }
  }
  // Clean up empty directories
  await removeEmptyDirectories(sessionPath);
}
/**
 * Get the total size of a directory, returning 0 if it does not exist.
 */ async function getDirectorySize(dirPath) {
  if (!await directoryExists(dirPath)) return 0;
  try {
    return await sumDirectorySize(dirPath);
  } catch  {
    return 0;
  }
}
/**
 * Recursively sum all file sizes in a directory.
 */ async function sumDirectorySize(dirPath) {
  let total = 0;
  try {
    for await (const entry of Deno.readDir(dirPath)){
      const fullPath = `${dirPath}/${entry.name}`;
      if (entry.isDirectory) {
        total += await sumDirectorySize(fullPath);
      } else if (entry.isFile) {
        try {
          const stat = await Deno.stat(fullPath);
          total += stat.size;
        } catch  {
        // Skip files we cannot stat
        }
      }
    }
  } catch  {
  // Directory may not exist or be unreadable
  }
  return total;
}
/**
 * Collect all files in a directory with their stats.
 */ async function collectAllFiles(dirPath) {
  const files = [];
  if (!await directoryExists(dirPath)) return files;
  try {
    for await (const entry of Deno.readDir(dirPath)){
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
            mtime: stat.mtime?.getTime() ?? Date.now()
          });
        } catch  {
        // Skip files we cannot stat
        }
      }
    }
  } catch  {
  // Directory may not exist
  }
  return files;
}
/**
 * Check whether a directory exists and is a directory.
 */ async function directoryExists(dirPath) {
  try {
    const stat = await Deno.stat(dirPath);
    return stat.isDirectory;
  } catch  {
    return false;
  }
}
/**
 * Collect all work stream session paths from the session store.
 *
 * Walks the store hierarchy: `storePath/owner/repo/work-stream/`
 * where work-stream is either `default` or `milestone-N`.
 */ async function collectSessionPaths(storePath) {
  const paths = [];
  try {
    // Walk owner directories
    for await (const ownerEntry of Deno.readDir(storePath)){
      if (!ownerEntry.isDirectory) continue;
      const ownerPath = `${storePath}/${ownerEntry.name}`;
      // Walk repo directories
      try {
        for await (const repoEntry of Deno.readDir(ownerPath)){
          if (!repoEntry.isDirectory) continue;
          const repoPath = `${ownerPath}/${repoEntry.name}`;
          // Walk work stream directories (default, milestone-N)
          try {
            for await (const wsEntry of Deno.readDir(repoPath)){
              if (!wsEntry.isDirectory) continue;
              paths.push(`${repoPath}/${wsEntry.name}`);
            }
          } catch  {
          // Skip unreadable repo dirs
          }
        }
      } catch  {
      // Skip unreadable owner dirs
      }
    }
  } catch  {
  // Store doesn't exist
  }
  return paths;
}
/**
 * Determine if an entire session directory is expired based on the
 * newest file modification time within it.
 */ async function isSessionExpired(sessionPath, maxAgeDays) {
  const files = await collectAllFiles(sessionPath);
  if (files.length === 0) return true; // Empty sessions are expired
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const newestMtime = Math.max(...files.map((f)=>f.mtime));
  return now - newestMtime > maxAgeMs;
}
/**
 * Remove empty directories recursively (bottom-up).
 */ async function removeEmptyDirectories(dirPath) {
  if (!await directoryExists(dirPath)) return;
  try {
    for await (const entry of Deno.readDir(dirPath)){
      if (entry.isDirectory) {
        const fullPath = `${dirPath}/${entry.name}`;
        await removeEmptyDirectories(fullPath);
      }
    }
    // Check if this directory is now empty
    let isEmpty = true;
    try {
      for await (const _entry of Deno.readDir(dirPath)){
        isEmpty = false;
        break;
      }
    } catch  {
      return;
    }
    if (isEmpty) {
      try {
        await Deno.remove(dirPath);
      } catch  {
      // Best-effort
      }
    }
  } catch  {
  // Directory may not exist
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zZXNzaW9uX2NvbXBhY3Rpb24udHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTZXNzaW9uIGNvbXBhY3Rpb24gZm9yIHBlcnNpc3RlZCBDbGF1ZGUgc2Vzc2lvbnMgKElzc3VlICMxMzI4KS5cbiAqXG4gKiBJbXBsZW1lbnRzIHByb2dyZXNzaXZlIGNvbXBhY3Rpb24gdG8gcHJldmVudCB1bmJvdW5kZWQgc2Vzc2lvbiBncm93dGg6XG4gKiAgIC0gTGV2ZWwgMSAoc29mdCk6IFJlbW92ZSBjYWNoZWQvdGVtcG9yYXJ5IGZpbGVzICh0bXAvLCBjYWNoZS8sIC5jYWNoZS8pXG4gKiAgIC0gTGV2ZWwgMiAobW9kZXJhdGUpOiBSZW1vdmUgb2xkIGZpbGVzIGJleW9uZCBhZ2UgdGhyZXNob2xkLCB0aGVuIG9sZGVzdC1maXJzdCBieSBzaXplXG4gKiAgIC0gTGV2ZWwgMyAoaGFyZCk6IERlbGV0ZSB0aGUgZW50aXJlIHNlc3Npb24gZGlyZWN0b3J5IGFuZCBzdGFydCBmcmVzaFxuICpcbiAqIEFsc28gcHJvdmlkZXMgYWdlLWJhc2VkIGNsZWFudXAgb2YgZW50aXJlIHNlc3Npb24gZGlyZWN0b3JpZXMgdGhhdCBoYXZlXG4gKiBub3QgYmVlbiBhY2Nlc3NlZCB3aXRoaW4gdGhlIGNvbmZpZ3VyZWQgcmV0ZW50aW9uIHBlcmlvZC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0TmV2ZXIgfSBmcm9tIFwiLi9hc3NlcnRfbmV2ZXIudHNcIjtcbmltcG9ydCB7IGVtaXRTZWxmSGVhbEV2ZW50QXV0byB9IGZyb20gXCIuL3NlbGZfaGVhbF9ldmVudHMudHNcIjtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUeXBlc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBDb21wYWN0aW9uIGxldmVscyBmcm9tIGxlYXN0IHRvIG1vc3QgYWdncmVzc2l2ZS4gKi9cbmV4cG9ydCB0eXBlIENvbXBhY3Rpb25MZXZlbCA9IFwibm9uZVwiIHwgXCJzb2Z0XCIgfCBcIm1vZGVyYXRlXCIgfCBcImhhcmRcIjtcblxuLyoqIFJlc3VsdCBvZiBhIHNpbmdsZSBzZXNzaW9uIGNvbXBhY3Rpb24gb3BlcmF0aW9uLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb21wYWN0aW9uUmVzdWx0IHtcbiAgLyoqIFBhdGggdG8gdGhlIHNlc3Npb24gdGhhdCB3YXMgY29tcGFjdGVkLiAqL1xuICBzZXNzaW9uUGF0aDogc3RyaW5nO1xuICAvKiogQ29tcGFjdGlvbiBsZXZlbCB0aGF0IHdhcyBhcHBsaWVkLiAqL1xuICBsZXZlbDogQ29tcGFjdGlvbkxldmVsO1xuICAvKiogU2Vzc2lvbiBzaXplIGluIGJ5dGVzIGJlZm9yZSBjb21wYWN0aW9uLiAqL1xuICBzaXplQmVmb3JlOiBudW1iZXI7XG4gIC8qKiBTZXNzaW9uIHNpemUgaW4gYnl0ZXMgYWZ0ZXIgY29tcGFjdGlvbi4gKi9cbiAgc2l6ZUFmdGVyOiBudW1iZXI7XG59XG5cbi8qKiBSZXN1bHQgb2YgY29tcGFjdGluZyBhbGwgc2Vzc2lvbnMgaW4gYSBzZXNzaW9uIHN0b3JlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb21wYWN0QWxsUmVzdWx0IHtcbiAgLyoqIE51bWJlciBvZiBzZXNzaW9ucyB0aGF0IGhhZCBjb21wYWN0aW9uIGFwcGxpZWQuICovXG4gIHNlc3Npb25zQ29tcGFjdGVkOiBudW1iZXI7XG4gIC8qKiBOdW1iZXIgb2Ygc2Vzc2lvbnMgcmVtb3ZlZCBlbnRpcmVseSAoYWdlLWJhc2VkIG9yIGhhcmQgY29tcGFjdGlvbikuICovXG4gIHNlc3Npb25zUmVtb3ZlZDogbnVtYmVyO1xuICAvKiogSW5kaXZpZHVhbCBjb21wYWN0aW9uIHJlc3VsdHMgcGVyIHNlc3Npb24uICovXG4gIGRldGFpbHM6IENvbXBhY3Rpb25SZXN1bHRbXTtcbn1cblxuLyoqIE9wdGlvbnMgZm9yIHNlc3Npb24gY29tcGFjdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcGFjdGlvbk9wdGlvbnMge1xuICAvKiogTWF4aW11bSBhbGxvd2VkIHNlc3Npb24gc2l6ZSBpbiBieXRlcy4gKi9cbiAgbWF4U2l6ZUJ5dGVzOiBudW1iZXI7XG4gIC8qKiBNYXhpbXVtIGFnZSBpbiBkYXlzIGZvciBzZXNzaW9uIGZpbGVzLiAqL1xuICBtYXhBZ2VEYXlzOiBudW1iZXI7XG4gIC8qKiBGb3JjZSBhIHNwZWNpZmljIGNvbXBhY3Rpb24gbGV2ZWwgKHNraXBzIGF1dG8tZGV0ZWN0aW9uKS4gKi9cbiAgbGV2ZWw/OiBDb21wYWN0aW9uTGV2ZWw7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ29uc3RhbnRzIOKAlCBkaXJlY3RvcnkgbmFtZXMgdHJlYXRlZCBhcyBjYWNoZS90ZW1wb3Jhcnlcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogRGlyZWN0b3J5IG5hbWVzIHRoYXQgYXJlIHNhZmUgdG8gcmVtb3ZlIGR1cmluZyBzb2Z0IGNvbXBhY3Rpb24uICovXG5jb25zdCBDQUNIRV9ESVJFQ1RPUllfTkFNRVM6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgXCJ0bXBcIixcbiAgXCJ0ZW1wXCIsXG4gIFwiY2FjaGVcIixcbiAgXCIuY2FjaGVcIixcbiAgXCIudG1wXCIsXG4gIFwidG9vbC1vdXRwdXRzXCIsXG4gIFwiaW50ZXJtZWRpYXRlXCIsXG5dKTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQdWJsaWMgQVBJXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBNZWFzdXJlIHRoZSB0b3RhbCBzaXplIG9mIGEgc2Vzc2lvbiBkaXJlY3RvcnkgaW4gYnl0ZXMuXG4gKlxuICogUmVjdXJzaXZlbHkgc3VtcyBhbGwgZmlsZSBzaXplcyB3aXRoaW4gdGhlIGRpcmVjdG9yeS4gUmV0dXJucyAwXG4gKiBpZiB0aGUgZGlyZWN0b3J5IGRvZXMgbm90IGV4aXN0LlxuICpcbiAqIEBwYXJhbSBzZXNzaW9uUGF0aCAtIEFic29sdXRlIHBhdGggdG8gdGhlIHNlc3Npb24gZGlyZWN0b3J5XG4gKiBAcmV0dXJucyBSZXN1bHQgd2l0aCB0aGUgdG90YWwgc2l6ZSBpbiBieXRlc1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWVhc3VyZVNlc3Npb25TaXplKFxuICBzZXNzaW9uUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8bnVtYmVyPj4ge1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBEZW5vLnN0YXQoc2Vzc2lvblBhdGgpO1xuICAgIGlmICghc3RhdC5pc0RpcmVjdG9yeSkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiAwIH07XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBEaXJlY3RvcnkgZG9lcyBub3QgZXhpc3RcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IDAgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgdG90YWxTaXplID0gYXdhaXQgc3VtRGlyZWN0b3J5U2l6ZShzZXNzaW9uUGF0aCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB0b3RhbFNpemUgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYEZhaWxlZCB0byBtZWFzdXJlIHNlc3Npb24gc2l6ZTogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBDb21wYWN0IGEgc2luZ2xlIHNlc3Npb24gZGlyZWN0b3J5IHVzaW5nIHByb2dyZXNzaXZlIGNvbXBhY3Rpb24uXG4gKlxuICogV2hlbiBgbGV2ZWxgIGlzIHNwZWNpZmllZCwgYXBwbGllcyB0aGF0IHNwZWNpZmljIGNvbXBhY3Rpb24gbGV2ZWwuXG4gKiBXaGVuIG9taXR0ZWQsIGF1dG8tc2VsZWN0cyBieSBlc2NhbGF0aW5nIGZyb20gc29mdCDihpIgbW9kZXJhdGUg4oaSIGhhcmRcbiAqIHVudGlsIHRoZSBzZXNzaW9uIGlzIHVuZGVyIHRoZSBzaXplIHRocmVzaG9sZCAob3IgaGFyZCBpcyByZWFjaGVkKS5cbiAqXG4gKiBAcGFyYW0gc2Vzc2lvblBhdGggLSBBYnNvbHV0ZSBwYXRoIHRvIHRoZSBzZXNzaW9uIGRpcmVjdG9yeVxuICogQHBhcmFtIG9wdGlvbnMgLSBDb21wYWN0aW9uIHRocmVzaG9sZHMgYW5kIG9wdGlvbmFsIGZvcmNlZCBsZXZlbFxuICogQHJldHVybnMgUmVzdWx0IHdpdGggY29tcGFjdGlvbiBtZXRyaWNzXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb21wYWN0U2Vzc2lvbihcbiAgc2Vzc2lvblBhdGg6IHN0cmluZyxcbiAgb3B0aW9uczogQ29tcGFjdGlvbk9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDxDb21wYWN0aW9uUmVzdWx0Pj4ge1xuICBjb25zdCBzaXplQmVmb3JlID0gYXdhaXQgZ2V0RGlyZWN0b3J5U2l6ZShzZXNzaW9uUGF0aCk7XG5cbiAgLy8gTm9uLWV4aXN0ZW50IGRpcmVjdG9yeSDigJQgbm90aGluZyB0byBjb21wYWN0XG4gIGlmIChzaXplQmVmb3JlID09PSAwKSB7XG4gICAgY29uc3QgZGlyRXhpc3RzID0gYXdhaXQgZGlyZWN0b3J5RXhpc3RzKHNlc3Npb25QYXRoKTtcbiAgICBpZiAoIWRpckV4aXN0cykge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIHZhbHVlOiB7XG4gICAgICAgICAgc2Vzc2lvblBhdGgsXG4gICAgICAgICAgbGV2ZWw6IG9wdGlvbnMubGV2ZWwgPz8gXCJub25lXCIsXG4gICAgICAgICAgc2l6ZUJlZm9yZTogMCxcbiAgICAgICAgICBzaXplQWZ0ZXI6IDAsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIElmIGEgc3BlY2lmaWMgbGV2ZWwgaXMgZm9yY2VkLCBhcHBseSBpdCBkaXJlY3RseVxuICBpZiAob3B0aW9ucy5sZXZlbCkge1xuICAgIHJldHVybiBhd2FpdCBhcHBseUNvbXBhY3Rpb25MZXZlbChcbiAgICAgIHNlc3Npb25QYXRoLFxuICAgICAgb3B0aW9ucy5sZXZlbCxcbiAgICAgIHNpemVCZWZvcmUsXG4gICAgICBvcHRpb25zLFxuICAgICk7XG4gIH1cblxuICAvLyBBdXRvLXNlbGVjdDogY2hlY2sgaWYgY29tcGFjdGlvbiBpcyBuZWVkZWRcbiAgaWYgKHNpemVCZWZvcmUgPD0gb3B0aW9ucy5tYXhTaXplQnl0ZXMpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZToge1xuICAgICAgICBzZXNzaW9uUGF0aCxcbiAgICAgICAgbGV2ZWw6IFwibm9uZVwiLFxuICAgICAgICBzaXplQmVmb3JlLFxuICAgICAgICBzaXplQWZ0ZXI6IHNpemVCZWZvcmUsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICAvLyBFc2NhbGF0ZSB0aHJvdWdoIGNvbXBhY3Rpb24gbGV2ZWxzXG4gIC8vIExldmVsIDE6IHNvZnRcbiAgY29uc3Qgc29mdFJlc3VsdCA9IGF3YWl0IGFwcGx5Q29tcGFjdGlvbkxldmVsKFxuICAgIHNlc3Npb25QYXRoLFxuICAgIFwic29mdFwiLFxuICAgIHNpemVCZWZvcmUsXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFzb2Z0UmVzdWx0Lm9rKSByZXR1cm4gc29mdFJlc3VsdDtcbiAgaWYgKHNvZnRSZXN1bHQudmFsdWUuc2l6ZUFmdGVyIDw9IG9wdGlvbnMubWF4U2l6ZUJ5dGVzKSB7XG4gICAgcmV0dXJuIHNvZnRSZXN1bHQ7XG4gIH1cblxuICAvLyBMZXZlbCAyOiBtb2RlcmF0ZVxuICBjb25zdCBtb2RlcmF0ZVJlc3VsdCA9IGF3YWl0IGFwcGx5Q29tcGFjdGlvbkxldmVsKFxuICAgIHNlc3Npb25QYXRoLFxuICAgIFwibW9kZXJhdGVcIixcbiAgICBzb2Z0UmVzdWx0LnZhbHVlLnNpemVBZnRlcixcbiAgICBvcHRpb25zLFxuICApO1xuICBpZiAoIW1vZGVyYXRlUmVzdWx0Lm9rKSByZXR1cm4gbW9kZXJhdGVSZXN1bHQ7XG4gIC8vIFVwZGF0ZSBzaXplQmVmb3JlIHRvIHJlZmxlY3Qgb3JpZ2luYWwgc2l6ZVxuICBtb2RlcmF0ZVJlc3VsdC52YWx1ZS5zaXplQmVmb3JlID0gc2l6ZUJlZm9yZTtcbiAgaWYgKG1vZGVyYXRlUmVzdWx0LnZhbHVlLnNpemVBZnRlciA8PSBvcHRpb25zLm1heFNpemVCeXRlcykge1xuICAgIHJldHVybiBtb2RlcmF0ZVJlc3VsdDtcbiAgfVxuXG4gIC8vIExldmVsIDM6IGhhcmQg4oCUIGRlbGV0ZSBldmVyeXRoaW5nXG4gIGNvbnN0IGhhcmRSZXN1bHQgPSBhd2FpdCBhcHBseUNvbXBhY3Rpb25MZXZlbChcbiAgICBzZXNzaW9uUGF0aCxcbiAgICBcImhhcmRcIixcbiAgICBtb2RlcmF0ZVJlc3VsdC52YWx1ZS5zaXplQWZ0ZXIsXG4gICAgb3B0aW9ucyxcbiAgKTtcbiAgaWYgKCFoYXJkUmVzdWx0Lm9rKSByZXR1cm4gaGFyZFJlc3VsdDtcbiAgaGFyZFJlc3VsdC52YWx1ZS5zaXplQmVmb3JlID0gc2l6ZUJlZm9yZTtcbiAgcmV0dXJuIGhhcmRSZXN1bHQ7XG59XG5cbi8qKlxuICogQ29tcGFjdCBhbGwgc2Vzc2lvbnMgaW4gYSBzZXNzaW9uIHN0b3JlIGRpcmVjdG9yeS5cbiAqXG4gKiBXYWxrcyB0aGUgc2Vzc2lvbiBzdG9yZSAoYC5jbGF1ZGUtc2Vzc2lvbnMvYCkgYW5kIGFwcGxpZXMgYWdlLWJhc2VkXG4gKiBjbGVhbnVwIGFuZCBzaXplLWJhc2VkIGNvbXBhY3Rpb24gdG8gZWFjaCB3b3JrIHN0cmVhbSBzZXNzaW9uLlxuICpcbiAqIFNlc3Npb24gZGlyZWN0b3JpZXMgb2xkZXIgdGhhbiBgbWF4QWdlRGF5c2AgKGJhc2VkIG9uIG5ld2VzdCBmaWxlXG4gKiBtb2RpZmljYXRpb24gdGltZSkgYXJlIHJlbW92ZWQgZW50aXJlbHkuXG4gKlxuICogQHBhcmFtIHN0b3JlUGF0aCAtIFBhdGggdG8gdGhlIGAuY2xhdWRlLXNlc3Npb25zL2Agcm9vdFxuICogQHBhcmFtIG9wdGlvbnMgLSBDb21wYWN0aW9uIHRocmVzaG9sZHNcbiAqIEByZXR1cm5zIFJlc3VsdCB3aXRoIGFnZ3JlZ2F0ZSBjb21wYWN0aW9uIG1ldHJpY3NcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbXBhY3RBbGxTZXNzaW9ucyhcbiAgc3RvcmVQYXRoOiBzdHJpbmcsXG4gIG9wdGlvbnM6IENvbXBhY3Rpb25PcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8Q29tcGFjdEFsbFJlc3VsdD4+IHtcbiAgY29uc3QgcmVzdWx0OiBDb21wYWN0QWxsUmVzdWx0ID0ge1xuICAgIHNlc3Npb25zQ29tcGFjdGVkOiAwLFxuICAgIHNlc3Npb25zUmVtb3ZlZDogMCxcbiAgICBkZXRhaWxzOiBbXSxcbiAgfTtcblxuICAvLyBWZXJpZnkgc3RvcmUgZXhpc3RzXG4gIGlmICghKGF3YWl0IGRpcmVjdG9yeUV4aXN0cyhzdG9yZVBhdGgpKSkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogcmVzdWx0IH07XG4gIH1cblxuICAvLyBXYWxrIHRoZSBzZXNzaW9uIHN0b3JlOiBvd25lci9yZXBvL3dvcmstc3RyZWFtXG4gIGNvbnN0IHNlc3Npb25QYXRocyA9IGF3YWl0IGNvbGxlY3RTZXNzaW9uUGF0aHMoc3RvcmVQYXRoKTtcblxuICBmb3IgKGNvbnN0IHNlc3Npb25QYXRoIG9mIHNlc3Npb25QYXRocykge1xuICAgIC8vIENoZWNrIGlmIHNlc3Npb24gc2hvdWxkIGJlIHJlbW92ZWQgYnkgYWdlXG4gICAgY29uc3Qgc2hvdWxkUmVtb3ZlID0gYXdhaXQgaXNTZXNzaW9uRXhwaXJlZChcbiAgICAgIHNlc3Npb25QYXRoLFxuICAgICAgb3B0aW9ucy5tYXhBZ2VEYXlzLFxuICAgICk7XG4gICAgaWYgKHNob3VsZFJlbW92ZSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgRGVuby5yZW1vdmUoc2Vzc2lvblBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICByZXN1bHQuc2Vzc2lvbnNSZW1vdmVkKys7XG4gICAgICAgIHJlc3VsdC5kZXRhaWxzLnB1c2goe1xuICAgICAgICAgIHNlc3Npb25QYXRoLFxuICAgICAgICAgIGxldmVsOiBcImhhcmRcIixcbiAgICAgICAgICBzaXplQmVmb3JlOiBhd2FpdCBnZXREaXJlY3RvcnlTaXplKHNlc3Npb25QYXRoKSxcbiAgICAgICAgICBzaXplQWZ0ZXI6IDAsXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIEJlc3QtZWZmb3J0IHJlbW92YWxcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIEFwcGx5IHNpemUtYmFzZWQgY29tcGFjdGlvblxuICAgIGNvbnN0IGNvbXBhY3RSZXN1bHQgPSBhd2FpdCBjb21wYWN0U2Vzc2lvbihzZXNzaW9uUGF0aCwgb3B0aW9ucyk7XG4gICAgaWYgKGNvbXBhY3RSZXN1bHQub2sgJiYgY29tcGFjdFJlc3VsdC52YWx1ZS5sZXZlbCAhPT0gXCJub25lXCIpIHtcbiAgICAgIHJlc3VsdC5zZXNzaW9uc0NvbXBhY3RlZCsrO1xuICAgICAgcmVzdWx0LmRldGFpbHMucHVzaChjb21wYWN0UmVzdWx0LnZhbHVlKTtcbiAgICAgIGlmIChjb21wYWN0UmVzdWx0LnZhbHVlLmxldmVsID09PSBcImhhcmRcIikge1xuICAgICAgICByZXN1bHQuc2Vzc2lvbnNSZW1vdmVkKys7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiByZXN1bHQgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBJbnRlcm5hbCBoZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBBcHBseSBhIHNwZWNpZmljIGNvbXBhY3Rpb24gbGV2ZWwgdG8gYSBzZXNzaW9uIGRpcmVjdG9yeS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gYXBwbHlDb21wYWN0aW9uTGV2ZWwoXG4gIHNlc3Npb25QYXRoOiBzdHJpbmcsXG4gIGxldmVsOiBDb21wYWN0aW9uTGV2ZWwsXG4gIHNpemVCZWZvcmU6IG51bWJlcixcbiAgb3B0aW9uczogQ29tcGFjdGlvbk9wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDxDb21wYWN0aW9uUmVzdWx0Pj4ge1xuICB0cnkge1xuICAgIHN3aXRjaCAobGV2ZWwpIHtcbiAgICAgIGNhc2UgXCJub25lXCI6XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IHRydWUsXG4gICAgICAgICAgdmFsdWU6IHsgc2Vzc2lvblBhdGgsIGxldmVsLCBzaXplQmVmb3JlLCBzaXplQWZ0ZXI6IHNpemVCZWZvcmUgfSxcbiAgICAgICAgfTtcblxuICAgICAgY2FzZSBcInNvZnRcIjpcbiAgICAgICAgYXdhaXQgcmVtb3ZlQ2FjaGVEaXJlY3RvcmllcyhzZXNzaW9uUGF0aCk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwibW9kZXJhdGVcIjpcbiAgICAgICAgYXdhaXQgcmVtb3ZlQ2FjaGVEaXJlY3RvcmllcyhzZXNzaW9uUGF0aCk7XG4gICAgICAgIGF3YWl0IHJlbW92ZU9sZEZpbGVzKHNlc3Npb25QYXRoLCBvcHRpb25zLm1heEFnZURheXMpO1xuICAgICAgICBhd2FpdCB0cmltQnlTaXplKHNlc3Npb25QYXRoLCBvcHRpb25zLm1heFNpemVCeXRlcyk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwiaGFyZFwiOiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgRGVuby5yZW1vdmUoc2Vzc2lvblBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvLyBBbHJlYWR5IGdvbmVcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBlbWl0U2VsZkhlYWxFdmVudEF1dG8oe1xuICAgICAgICAgIG1vZHVsZTogXCJzZXNzaW9uX2NvbXBhY3Rpb25cIixcbiAgICAgICAgICBhY3Rpb246IFwiY29tcGFjdF9oYXJkXCIsXG4gICAgICAgICAgcmVhc29uOiBgc2Vzc2lvbj0ke3Nlc3Npb25QYXRofSByZW1vdmVkYCxcbiAgICAgICAgICByZXN1bHQ6IFwib2tcIixcbiAgICAgICAgICBieXRlc1JlY2xhaW1lZDogc2l6ZUJlZm9yZSxcbiAgICAgICAgICBkZXRhaWxzOiB7IHNpemVCZWZvcmUsIHNpemVBZnRlcjogMCB9LFxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICB2YWx1ZTogeyBzZXNzaW9uUGF0aCwgbGV2ZWwsIHNpemVCZWZvcmUsIHNpemVBZnRlcjogMCB9LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmV0dXJuIGFzc2VydE5ldmVyKGxldmVsKTtcbiAgICB9XG5cbiAgICBjb25zdCBzaXplQWZ0ZXIgPSBhd2FpdCBnZXREaXJlY3RvcnlTaXplKHNlc3Npb25QYXRoKTtcbiAgICBhd2FpdCBlbWl0U2VsZkhlYWxFdmVudEF1dG8oe1xuICAgICAgbW9kdWxlOiBcInNlc3Npb25fY29tcGFjdGlvblwiLFxuICAgICAgYWN0aW9uOiBgY29tcGFjdF8ke2xldmVsfWAsXG4gICAgICByZWFzb246IGBzZXNzaW9uPSR7c2Vzc2lvblBhdGh9YCxcbiAgICAgIHJlc3VsdDogXCJva1wiLFxuICAgICAgYnl0ZXNSZWNsYWltZWQ6IE1hdGgubWF4KDAsIHNpemVCZWZvcmUgLSBzaXplQWZ0ZXIpLFxuICAgICAgZGV0YWlsczogeyBzaXplQmVmb3JlLCBzaXplQWZ0ZXIgfSxcbiAgICB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZTogeyBzZXNzaW9uUGF0aCwgbGV2ZWwsIHNpemVCZWZvcmUsIHNpemVBZnRlciB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBDb21wYWN0aW9uIGZhaWxlZCBhdCBsZXZlbCAke2xldmVsfTogJHtcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cbn1cblxuLyoqXG4gKiBSZW1vdmUgd2VsbC1rbm93biBjYWNoZS90ZW1wb3JhcnkgZGlyZWN0b3JpZXMgZnJvbSBhIHNlc3Npb24uXG4gKiBUaGlzIGlzIHRoZSBcInNvZnRcIiBjb21wYWN0aW9uIHN0ZXAuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlbW92ZUNhY2hlRGlyZWN0b3JpZXMoc2Vzc2lvblBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoIShhd2FpdCBkaXJlY3RvcnlFeGlzdHMoc2Vzc2lvblBhdGgpKSkgcmV0dXJuO1xuXG4gIHRyeSB7XG4gICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIoc2Vzc2lvblBhdGgpKSB7XG4gICAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkgJiYgQ0FDSEVfRElSRUNUT1JZX05BTUVTLmhhcyhlbnRyeS5uYW1lKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKGAke3Nlc3Npb25QYXRofS8ke2VudHJ5Lm5hbWV9YCwge1xuICAgICAgICAgICAgcmVjdXJzaXZlOiB0cnVlLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvLyBCZXN0LWVmZm9ydCByZW1vdmFsXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIERpcmVjdG9yeSBtYXkgaGF2ZSBiZWVuIHJlbW92ZWQgY29uY3VycmVudGx5XG4gIH1cbn1cblxuLyoqXG4gKiBSZW1vdmUgZmlsZXMgb2xkZXIgdGhhbiB0aGUgYWdlIHRocmVzaG9sZC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVtb3ZlT2xkRmlsZXMoXG4gIHNlc3Npb25QYXRoOiBzdHJpbmcsXG4gIG1heEFnZURheXM6IG51bWJlcixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBtYXhBZ2VNcyA9IG1heEFnZURheXMgKiAyNCAqIDYwICogNjAgKiAxMDAwO1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IGZpbGVzID0gYXdhaXQgY29sbGVjdEFsbEZpbGVzKHNlc3Npb25QYXRoKTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSB7XG4gICAgaWYgKG5vdyAtIGZpbGUubXRpbWUgPiBtYXhBZ2VNcykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgRGVuby5yZW1vdmUoZmlsZS5wYXRoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBCZXN0LWVmZm9ydCByZW1vdmFsXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gQ2xlYW4gdXAgZW1wdHkgZGlyZWN0b3JpZXNcbiAgYXdhaXQgcmVtb3ZlRW1wdHlEaXJlY3RvcmllcyhzZXNzaW9uUGF0aCk7XG59XG5cbi8qKlxuICogUmVtb3ZlIG9sZGVzdCBmaWxlcyB1bnRpbCB0aGUgc2Vzc2lvbiBpcyB1bmRlciB0aGUgc2l6ZSB0aHJlc2hvbGQuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHRyaW1CeVNpemUoXG4gIHNlc3Npb25QYXRoOiBzdHJpbmcsXG4gIG1heFNpemVCeXRlczogbnVtYmVyLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGZpbGVzID0gYXdhaXQgY29sbGVjdEFsbEZpbGVzKHNlc3Npb25QYXRoKTtcbiAgLy8gU29ydCBvbGRlc3QgZmlyc3RcbiAgZmlsZXMuc29ydCgoYSwgYikgPT4gYS5tdGltZSAtIGIubXRpbWUpO1xuXG4gIGxldCB0b3RhbFNpemUgPSBmaWxlcy5yZWR1Y2UoKHN1bSwgZikgPT4gc3VtICsgZi5zaXplLCAwKTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIGZpbGVzKSB7XG4gICAgaWYgKHRvdGFsU2l6ZSA8PSBtYXhTaXplQnl0ZXMpIGJyZWFrO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLnJlbW92ZShmaWxlLnBhdGgpO1xuICAgICAgdG90YWxTaXplIC09IGZpbGUuc2l6ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEJlc3QtZWZmb3J0IHJlbW92YWxcbiAgICB9XG4gIH1cblxuICAvLyBDbGVhbiB1cCBlbXB0eSBkaXJlY3Rvcmllc1xuICBhd2FpdCByZW1vdmVFbXB0eURpcmVjdG9yaWVzKHNlc3Npb25QYXRoKTtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIHRvdGFsIHNpemUgb2YgYSBkaXJlY3RvcnksIHJldHVybmluZyAwIGlmIGl0IGRvZXMgbm90IGV4aXN0LlxuICovXG5hc3luYyBmdW5jdGlvbiBnZXREaXJlY3RvcnlTaXplKGRpclBhdGg6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGlmICghKGF3YWl0IGRpcmVjdG9yeUV4aXN0cyhkaXJQYXRoKSkpIHJldHVybiAwO1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBzdW1EaXJlY3RvcnlTaXplKGRpclBhdGgpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gMDtcbiAgfVxufVxuXG4vKipcbiAqIFJlY3Vyc2l2ZWx5IHN1bSBhbGwgZmlsZSBzaXplcyBpbiBhIGRpcmVjdG9yeS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc3VtRGlyZWN0b3J5U2l6ZShkaXJQYXRoOiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgdG90YWwgPSAwO1xuICB0cnkge1xuICAgIGZvciBhd2FpdCAoY29uc3QgZW50cnkgb2YgRGVuby5yZWFkRGlyKGRpclBhdGgpKSB7XG4gICAgICBjb25zdCBmdWxsUGF0aCA9IGAke2RpclBhdGh9LyR7ZW50cnkubmFtZX1gO1xuICAgICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KSB7XG4gICAgICAgIHRvdGFsICs9IGF3YWl0IHN1bURpcmVjdG9yeVNpemUoZnVsbFBhdGgpO1xuICAgICAgfSBlbHNlIGlmIChlbnRyeS5pc0ZpbGUpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KGZ1bGxQYXRoKTtcbiAgICAgICAgICB0b3RhbCArPSBzdGF0LnNpemU7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8vIFNraXAgZmlsZXMgd2UgY2Fubm90IHN0YXRcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gRGlyZWN0b3J5IG1heSBub3QgZXhpc3Qgb3IgYmUgdW5yZWFkYWJsZVxuICB9XG4gIHJldHVybiB0b3RhbDtcbn1cblxuLyoqXG4gKiBDb2xsZWN0IGFsbCBmaWxlcyBpbiBhIGRpcmVjdG9yeSB3aXRoIHRoZWlyIHN0YXRzLlxuICovXG5hc3luYyBmdW5jdGlvbiBjb2xsZWN0QWxsRmlsZXMoXG4gIGRpclBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8QXJyYXk8eyBwYXRoOiBzdHJpbmc7IHNpemU6IG51bWJlcjsgbXRpbWU6IG51bWJlciB9Pj4ge1xuICBjb25zdCBmaWxlczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IHNpemU6IG51bWJlcjsgbXRpbWU6IG51bWJlciB9PiA9IFtdO1xuICBpZiAoIShhd2FpdCBkaXJlY3RvcnlFeGlzdHMoZGlyUGF0aCkpKSByZXR1cm4gZmlsZXM7XG5cbiAgdHJ5IHtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGVudHJ5IG9mIERlbm8ucmVhZERpcihkaXJQYXRoKSkge1xuICAgICAgY29uc3QgZnVsbFBhdGggPSBgJHtkaXJQYXRofS8ke2VudHJ5Lm5hbWV9YDtcbiAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSkge1xuICAgICAgICBjb25zdCBuZXN0ZWQgPSBhd2FpdCBjb2xsZWN0QWxsRmlsZXMoZnVsbFBhdGgpO1xuICAgICAgICBmaWxlcy5wdXNoKC4uLm5lc3RlZCk7XG4gICAgICB9IGVsc2UgaWYgKGVudHJ5LmlzRmlsZSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHN0YXQgPSBhd2FpdCBEZW5vLnN0YXQoZnVsbFBhdGgpO1xuICAgICAgICAgIGZpbGVzLnB1c2goe1xuICAgICAgICAgICAgcGF0aDogZnVsbFBhdGgsXG4gICAgICAgICAgICBzaXplOiBzdGF0LnNpemUsXG4gICAgICAgICAgICBtdGltZTogc3RhdC5tdGltZT8uZ2V0VGltZSgpID8/IERhdGUubm93KCksXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8vIFNraXAgZmlsZXMgd2UgY2Fubm90IHN0YXRcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gRGlyZWN0b3J5IG1heSBub3QgZXhpc3RcbiAgfVxuICByZXR1cm4gZmlsZXM7XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBhIGRpcmVjdG9yeSBleGlzdHMgYW5kIGlzIGEgZGlyZWN0b3J5LlxuICovXG5hc3luYyBmdW5jdGlvbiBkaXJlY3RvcnlFeGlzdHMoZGlyUGF0aDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IGF3YWl0IERlbm8uc3RhdChkaXJQYXRoKTtcbiAgICByZXR1cm4gc3RhdC5pc0RpcmVjdG9yeTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogQ29sbGVjdCBhbGwgd29yayBzdHJlYW0gc2Vzc2lvbiBwYXRocyBmcm9tIHRoZSBzZXNzaW9uIHN0b3JlLlxuICpcbiAqIFdhbGtzIHRoZSBzdG9yZSBoaWVyYXJjaHk6IGBzdG9yZVBhdGgvb3duZXIvcmVwby93b3JrLXN0cmVhbS9gXG4gKiB3aGVyZSB3b3JrLXN0cmVhbSBpcyBlaXRoZXIgYGRlZmF1bHRgIG9yIGBtaWxlc3RvbmUtTmAuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RTZXNzaW9uUGF0aHMoc3RvcmVQYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IHBhdGhzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIHRyeSB7XG4gICAgLy8gV2FsayBvd25lciBkaXJlY3Rvcmllc1xuICAgIGZvciBhd2FpdCAoY29uc3Qgb3duZXJFbnRyeSBvZiBEZW5vLnJlYWREaXIoc3RvcmVQYXRoKSkge1xuICAgICAgaWYgKCFvd25lckVudHJ5LmlzRGlyZWN0b3J5KSBjb250aW51ZTtcbiAgICAgIGNvbnN0IG93bmVyUGF0aCA9IGAke3N0b3JlUGF0aH0vJHtvd25lckVudHJ5Lm5hbWV9YDtcblxuICAgICAgLy8gV2FsayByZXBvIGRpcmVjdG9yaWVzXG4gICAgICB0cnkge1xuICAgICAgICBmb3IgYXdhaXQgKGNvbnN0IHJlcG9FbnRyeSBvZiBEZW5vLnJlYWREaXIob3duZXJQYXRoKSkge1xuICAgICAgICAgIGlmICghcmVwb0VudHJ5LmlzRGlyZWN0b3J5KSBjb250aW51ZTtcbiAgICAgICAgICBjb25zdCByZXBvUGF0aCA9IGAke293bmVyUGF0aH0vJHtyZXBvRW50cnkubmFtZX1gO1xuXG4gICAgICAgICAgLy8gV2FsayB3b3JrIHN0cmVhbSBkaXJlY3RvcmllcyAoZGVmYXVsdCwgbWlsZXN0b25lLU4pXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGZvciBhd2FpdCAoY29uc3Qgd3NFbnRyeSBvZiBEZW5vLnJlYWREaXIocmVwb1BhdGgpKSB7XG4gICAgICAgICAgICAgIGlmICghd3NFbnRyeS5pc0RpcmVjdG9yeSkgY29udGludWU7XG4gICAgICAgICAgICAgIHBhdGhzLnB1c2goYCR7cmVwb1BhdGh9LyR7d3NFbnRyeS5uYW1lfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLy8gU2tpcCB1bnJlYWRhYmxlIHJlcG8gZGlyc1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFNraXAgdW5yZWFkYWJsZSBvd25lciBkaXJzXG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBTdG9yZSBkb2Vzbid0IGV4aXN0XG4gIH1cblxuICByZXR1cm4gcGF0aHM7XG59XG5cbi8qKlxuICogRGV0ZXJtaW5lIGlmIGFuIGVudGlyZSBzZXNzaW9uIGRpcmVjdG9yeSBpcyBleHBpcmVkIGJhc2VkIG9uIHRoZVxuICogbmV3ZXN0IGZpbGUgbW9kaWZpY2F0aW9uIHRpbWUgd2l0aGluIGl0LlxuICovXG5hc3luYyBmdW5jdGlvbiBpc1Nlc3Npb25FeHBpcmVkKFxuICBzZXNzaW9uUGF0aDogc3RyaW5nLFxuICBtYXhBZ2VEYXlzOiBudW1iZXIsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgZmlsZXMgPSBhd2FpdCBjb2xsZWN0QWxsRmlsZXMoc2Vzc2lvblBhdGgpO1xuICBpZiAoZmlsZXMubGVuZ3RoID09PSAwKSByZXR1cm4gdHJ1ZTsgLy8gRW1wdHkgc2Vzc2lvbnMgYXJlIGV4cGlyZWRcblxuICBjb25zdCBtYXhBZ2VNcyA9IG1heEFnZURheXMgKiAyNCAqIDYwICogNjAgKiAxMDAwO1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCBuZXdlc3RNdGltZSA9IE1hdGgubWF4KC4uLmZpbGVzLm1hcCgoZikgPT4gZi5tdGltZSkpO1xuXG4gIHJldHVybiBub3cgLSBuZXdlc3RNdGltZSA+IG1heEFnZU1zO1xufVxuXG4vKipcbiAqIFJlbW92ZSBlbXB0eSBkaXJlY3RvcmllcyByZWN1cnNpdmVseSAoYm90dG9tLXVwKS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVtb3ZlRW1wdHlEaXJlY3RvcmllcyhkaXJQYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCEoYXdhaXQgZGlyZWN0b3J5RXhpc3RzKGRpclBhdGgpKSkgcmV0dXJuO1xuXG4gIHRyeSB7XG4gICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIoZGlyUGF0aCkpIHtcbiAgICAgIGlmIChlbnRyeS5pc0RpcmVjdG9yeSkge1xuICAgICAgICBjb25zdCBmdWxsUGF0aCA9IGAke2RpclBhdGh9LyR7ZW50cnkubmFtZX1gO1xuICAgICAgICBhd2FpdCByZW1vdmVFbXB0eURpcmVjdG9yaWVzKGZ1bGxQYXRoKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDaGVjayBpZiB0aGlzIGRpcmVjdG9yeSBpcyBub3cgZW1wdHlcbiAgICBsZXQgaXNFbXB0eSA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGZvciBhd2FpdCAoY29uc3QgX2VudHJ5IG9mIERlbm8ucmVhZERpcihkaXJQYXRoKSkge1xuICAgICAgICBpc0VtcHR5ID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmIChpc0VtcHR5KSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBEZW5vLnJlbW92ZShkaXJQYXRoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBCZXN0LWVmZm9ydFxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gRGlyZWN0b3J5IG1heSBub3QgZXhpc3RcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Q0FZQyxHQUdELFNBQVMsV0FBVyxRQUFRLG9CQUFvQjtBQUNoRCxTQUFTLHFCQUFxQixRQUFRLHdCQUF3QjtBQXlDOUQsOEVBQThFO0FBQzlFLHlEQUF5RDtBQUN6RCw4RUFBOEU7QUFFOUUsb0VBQW9FLEdBQ3BFLE1BQU0sd0JBQTZDLElBQUksSUFBSTtFQUN6RDtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtDQUNEO0FBRUQsOEVBQThFO0FBQzlFLGFBQWE7QUFDYiw4RUFBOEU7QUFFOUU7Ozs7Ozs7O0NBUUMsR0FDRCxPQUFPLGVBQWUsbUJBQ3BCLFdBQW1CO0VBRW5CLElBQUk7SUFDRixNQUFNLE9BQU8sTUFBTSxLQUFLLElBQUksQ0FBQztJQUM3QixJQUFJLENBQUMsS0FBSyxXQUFXLEVBQUU7TUFDckIsT0FBTztRQUFFLElBQUk7UUFBTSxPQUFPO01BQUU7SUFDOUI7RUFDRixFQUFFLE9BQU07SUFDTiwyQkFBMkI7SUFDM0IsT0FBTztNQUFFLElBQUk7TUFBTSxPQUFPO0lBQUU7RUFDOUI7RUFFQSxJQUFJO0lBQ0YsTUFBTSxZQUFZLE1BQU0saUJBQWlCO0lB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
// denoCacheMetadata=2621265772303301089,11508372655606011773