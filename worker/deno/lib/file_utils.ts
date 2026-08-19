/**
 * Atomic file write utilities for state and cache files (Issue #693).
 *
 * Several modules write state and cache files that can be corrupted if
 * the worker is interrupted mid-write (kill signal, disk full). This
 * module provides atomic write functions that:
 *   - Write to a temporary file in the same directory as the target
 *   - Use rename (which is atomic on POSIX filesystems) to replace the target
 *   - Set appropriate permissions (mode 0o600 by default for state files)
 *   - Clean up temp files on failure
 *
 * Migrated from worker/shared/file_utils.sh (Issue #901).
 *
 * Issue #2348: the temp file is created with a kernel-random suffix and
 * opened exclusively (createNew) with the requested mode, so a co-located
 * attacker cannot pre-position a symlink at a predictable path and the
 * file is never briefly readable at the process umask's default mode.
 */

import type { Result } from "../types.ts";

/** Default file permissions for state/cache files (user read/write only). */
const DEFAULT_FILE_MODE = 0o600;

/** Options for atomic write operations. */
export interface AtomicWriteOptions {
  /** Path to the target file. */
  targetFile: string;
  /** Content to write. */
  content: string;
  /** File permissions (default: 0o600). */
  mode?: number;
}

/**
 * Write content to a file atomically.
 *
 * Writes content to a temporary file in the same directory, then uses
 * rename to atomically replace the target. If the write or rename fails,
 * the original file is left intact and the temp file is cleaned up.
 *
 * @param options - Target file path, content, and optional permissions
 * @returns Result indicating success or failure with error message
 */
export async function atomicWrite(
  options: AtomicWriteOptions,
): Promise<Result<void>> {
  const { targetFile, content, mode = DEFAULT_FILE_MODE } = options;

  // Resolve to absolute path for safety
  const targetDir = targetFile.substring(
    0,
    targetFile.lastIndexOf("/"),
  );

  // Ensure target directory exists
  try {
    const stat = await Deno.stat(targetDir);
    if (!stat.isDirectory) {
      return {
        ok: false,
        error: new Error(
          `atomicWrite — target path is not a directory: ${targetDir}`,
        ),
      };
    }
  } catch {
    return {
      ok: false,
      error: new Error(
        `atomicWrite — target directory does not exist: ${targetDir}`,
      ),
    };
  }

  // Create temp file in the same directory (same filesystem for atomic
  // rename). Use a kernel-random suffix rather than the PID (Issue #2348)
  // so a co-located attacker cannot pre-position a symlink at a
  // predictable path. Open with createNew (O_EXCL|O_CREAT) and the
  // requested mode so:
  //   - any pre-existing path at tmpFile (including a symlink) causes
  //     creation to fail rather than be followed; and
  //   - the file is restricted to the requested mode from creation,
  //     closing the permission window between write and chmod that the
  //     previous writeTextFile + late-chmod sequence opened.
  const tmpFile = `${targetFile}.tmp.${crypto.randomUUID()}`;

  let file: Deno.FsFile;
  try {
    file = await Deno.open(tmpFile, {
      write: true,
      createNew: true,
      mode,
    });
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `atomicWrite — failed to create temp file: ${tmpFile}: ${
          (err as Error).message
        }`,
      ),
    };
  }

  // Write content to temp file
  try {
    const encoded = new TextEncoder().encode(content);
    let written = 0;
    while (written < encoded.length) {
      written += await file.write(encoded.subarray(written));
    }
  } catch (err) {
    try {
      file.close();
    } catch { /* already closed */ }
    try {
      await Deno.remove(tmpFile);
    } catch { /* best effort cleanup */ }
    return {
      ok: false,
      error: new Error(
        `atomicWrite — failed to write temp file: ${tmpFile}: ${
          (err as Error).message
        }`,
      ),
    };
  }
  file.close();

  // Defence-in-depth: re-apply mode in case the open() mode was reduced
  // by the process umask. tmpFile is a regular file we just created
  // exclusively, so chmod does not follow an attacker-controlled symlink.
  try {
    await Deno.chmod(tmpFile, mode);
  } catch (err) {
    try {
      await Deno.remove(tmpFile);
    } catch { /* best effort cleanup */ }
    return {
      ok: false,
      error: new Error(
        `atomicWrite — failed to set permissions on temp file: ${tmpFile}: ${
          (err as Error).message
        }`,
      ),
    };
  }

  // Atomically replace the target file
  try {
    await Deno.rename(tmpFile, targetFile);
  } catch (err) {
    try {
      await Deno.remove(tmpFile);
    } catch { /* best effort cleanup */ }
    return {
      ok: false,
      error: new Error(
        `atomicWrite — failed to rename temp file to target: ${targetFile}: ${
          (err as Error).message
        }`,
      ),
    };
  }

  return { ok: true, value: undefined };
}

/**
 * Synchronous sibling of {@link atomicWrite} (Issue #3682).
 *
 * Same guarantees — kernel-random temp suffix, `createNew` (O_EXCL) so a
 * pre-positioned symlink can never be followed, requested mode from
 * creation, atomic rename, temp cleanup on failure — for the callers that
 * cannot await (e.g. the health-check cache writers).
 *
 * @param options - Target file path, content, and optional permissions
 * @returns Result indicating success or failure with error message
 */
export function atomicWriteSync(
  options: AtomicWriteOptions,
): Result<void> {
  const { targetFile, content, mode = DEFAULT_FILE_MODE } = options;

  const targetDir = targetFile.substring(0, targetFile.lastIndexOf("/"));

  try {
    if (!Deno.statSync(targetDir).isDirectory) {
      return {
        ok: false,
        error: new Error(
          `atomicWriteSync — target path is not a directory: ${targetDir}`,
        ),
      };
    }
  } catch {
    return {
      ok: false,
      error: new Error(
        `atomicWriteSync — target directory does not exist: ${targetDir}`,
      ),
    };
  }

  const tmpFile = `${targetFile}.tmp.${crypto.randomUUID()}`;

  let file: Deno.FsFile;
  try {
    file = Deno.openSync(tmpFile, { write: true, createNew: true, mode });
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `atomicWriteSync — failed to create temp file: ${tmpFile}: ${
          (err as Error).message
        }`,
      ),
    };
  }

  try {
    const encoded = new TextEncoder().encode(content);
    let written = 0;
    while (written < encoded.length) {
      written += file.writeSync(encoded.subarray(written));
    }
  } catch (err) {
    try {
      file.close();
    } catch { /* already closed */ }
    removeSyncBestEffort(tmpFile);
    return {
      ok: false,
      error: new Error(
        `atomicWriteSync — failed to write temp file: ${tmpFile}: ${
          (err as Error).message
        }`,
      ),
    };
  }
  file.close();

  // Defence in depth: the open() mode may have been reduced by the umask.
  try {
    Deno.chmodSync(tmpFile, mode);
  } catch (err) {
    removeSyncBestEffort(tmpFile);
    return {
      ok: false,
      error: new Error(
        `atomicWriteSync — failed to set permissions on temp file: ${tmpFile}: ${
          (err as Error).message
        }`,
      ),
    };
  }

  try {
    Deno.renameSync(tmpFile, targetFile);
  } catch (err) {
    removeSyncBestEffort(tmpFile);
    return {
      ok: false,
      error: new Error(
        `atomicWriteSync — failed to rename temp file to target: ${targetFile}: ${
          (err as Error).message
        }`,
      ),
    };
  }

  return { ok: true, value: undefined };
}

/** Remove a temp file we created; a cleanup failure must not mask the cause. */
function removeSyncBestEffort(path: string): void {
  try {
    Deno.removeSync(path);
  } catch { /* best effort cleanup — the original error is returned */ }
}

/**
 * Read a file safely, returning empty string if the file does not exist.
 *
 * @param filePath - Path to the file to read
 * @returns Result containing the file contents or empty string
 */
export async function safeReadFile(
  filePath: string,
): Promise<Result<string>> {
  try {
    const content = await Deno.readTextFile(filePath);
    return { ok: true, value: content };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { ok: true, value: "" };
    }
    return {
      ok: false,
      error: new Error(
        `safeReadFile — failed to read file: ${filePath}: ${
          (err as Error).message
        }`,
      ),
    };
  }
}
