/**
 * Temporary file/directory management with cleanup.
 *
 * Provides safe temporary file creation with error checking and
 * both registered cleanup (for the current process) and stale
 * file cleanup (for orphaned files from previous runs).
 *
 * Migrated from worker/shared/temp_utils.sh (Issue #901).
 * Issue #215: Add error checking to mktemp calls.
 * Issue #337: Periodic stale temp file cleanup.
 */

import type { Result } from "../types.ts";

/** Default maximum age in minutes for stale temp file cleanup (24 hours). */
const DEFAULT_STALE_MAX_AGE_MINUTES = 1440;

/** Options for creating a temporary file or directory. */
export interface SafeMktempOptions {
  /** Create a directory instead of a file. */
  directory?: boolean;
  /** Custom prefix for the temp path. */
  prefix?: string;
  /** Custom suffix for the temp path. */
  suffix?: string;
  /** Directory in which to create the temp file/dir. */
  dir?: string;
}

/**
 * Create a temporary file or directory with error checking.
 *
 * Wraps Deno.makeTempFile/makeTempDir and verifies the result.
 * On failure, returns an error Result so callers can handle it
 * explicitly rather than continuing with an invalid path.
 *
 * @param options - Options for temp file/dir creation
 * @returns Result containing the path to the created temp file/directory
 */
export async function safeMktemp(
  options: SafeMktempOptions = {},
): Promise<Result<string>> {
  const { directory = false, prefix, suffix, dir } = options;

  try {
    const tempOptions: Deno.MakeTempOptions = {};
    if (prefix !== undefined) tempOptions.prefix = prefix;
    if (suffix !== undefined) tempOptions.suffix = suffix;
    if (dir !== undefined) tempOptions.dir = dir;

    const path = directory
      ? await Deno.makeTempDir(tempOptions)
      : await Deno.makeTempFile(tempOptions);

    if (!path || path.length === 0) {
      return {
        ok: false,
        error: new Error("safeMktemp — received empty path from system"),
      };
    }

    return { ok: true, value: path };
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `safeMktemp — failed to create temp ${
          directory ? "directory" : "file"
        }: ${(err as Error).message}`,
      ),
    };
  }
}

/**
 * Manages registered temp files for cleanup on process exit.
 *
 * Create an instance with createTempCleanupRegistry() and register
 * temp paths for later bulk cleanup.
 */
export interface TempCleanupRegistry {
  /** Register a temp path for later cleanup. */
  register(path: string): void;
  /** Remove all registered temp files and directories. */
  cleanup(): Promise<void>;
  /** Get the number of registered paths. */
  readonly count: number;
}

/**
 * Create a registry for tracking temp files/directories for cleanup.
 *
 * @returns A TempCleanupRegistry instance
 */
export function createTempCleanupRegistry(): TempCleanupRegistry {
  const registeredPaths: string[] = [];

  return {
    register(path: string): void {
      registeredPaths.push(path);
    },

    async cleanup(): Promise<void> {
      for (const path of registeredPaths) {
        try {
          const stat = await Deno.stat(path);
          if (stat.isDirectory) {
            await Deno.remove(path, { recursive: true });
          } else {
            await Deno.remove(path);
          }
        } catch {
          // Best-effort cleanup — file may already be removed
        }
      }
      registeredPaths.length = 0;
    },

    get count(): number {
      return registeredPaths.length;
    },
  };
}

/** Options for cleaning up stale temp files. */
export interface CleanupStaleTempOptions {
  /** Directory to scan for stale temp files. */
  directory: string;
  /** Maximum age in minutes (default: 1440 = 24 hours). */
  maxAgeMinutes?: number;
}

/** Data returned by the cleanup-stale-temp-files command. */
export interface CleanupStaleTempData {
  /** Number of stale files/directories removed. */
  removedCount: number;
  /** Directory that was scanned. */
  directory: string;
  /** Maximum age threshold in minutes. */
  maxAgeMinutes: number;
}

/**
 * Remove stale temp files and directories older than a configurable age.
 *
 * Scans the given directory (non-recursively) for entries older than
 * maxAgeMinutes and removes them. Used for periodic cleanup of orphaned
 * temp files on unattended machines.
 *
 * @param options - Directory and age threshold
 * @returns Result with cleanup statistics
 */
export async function cleanupStaleTempFiles(
  options: CleanupStaleTempOptions,
): Promise<Result<CleanupStaleTempData>> {
  const {
    directory,
    maxAgeMinutes = DEFAULT_STALE_MAX_AGE_MINUTES,
  } = options;

  // Validate directory exists
  try {
    const stat = await Deno.stat(directory);
    if (!stat.isDirectory) {
      return {
        ok: true,
        value: { removedCount: 0, directory, maxAgeMinutes },
      };
    }
  } catch {
    return {
      ok: true,
      value: { removedCount: 0, directory, maxAgeMinutes },
    };
  }

  const cutoffMs = Date.now() - maxAgeMinutes * 60 * 1000;
  let removedCount = 0;

  try {
    for await (const entry of Deno.readDir(directory)) {
      const fullPath = `${directory}/${entry.name}`;
      try {
        const stat = await Deno.stat(fullPath);
        const mtime = stat.mtime?.getTime() ?? Date.now();
        if (mtime < cutoffMs) {
          if (stat.isDirectory) {
            await Deno.remove(fullPath, { recursive: true });
          } else {
            await Deno.remove(fullPath);
          }
          removedCount++;
        }
      } catch {
        // Best-effort: skip entries that cannot be stat'd or removed
      }
    }
  } catch {
    // Best-effort: if directory listing fails, return what we have
  }

  return {
    ok: true,
    value: { removedCount, directory, maxAgeMinutes },
  };
}
