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
  /** Content to write; bytes are written verbatim, text as UTF-8. */
  content: string | Uint8Array;
  /** File permissions (default: 0o600). */
  mode?: number;
}

/** Bytes for a write, without a lossy round-trip through the decoder. */
function encodeContent(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
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
    const encoded = encodeContent(content);
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
    const encoded = encodeContent(content);
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

/** Options for {@link appendNoFollow}. */
export interface AppendNoFollowOptions {
  /** Path to the file to append to. */
  targetFile: string;
  /** Content to append verbatim (include the trailing newline). */
  content: string;
  /** File permissions applied when the file is created (default: 0o600). */
  mode?: number;
}

/**
 * Append to a file, refusing to follow a symlink at the target (Issue #1239).
 *
 * A bare `Deno.writeTextFile(path, line, { append: true })` opens
 * `O_CREAT|O_APPEND` and follows a symlink, so an account that can create the
 * path — the `agent` account owns that power over the shared work root — can
 * redirect an append-only log into any file the worker uid can write.
 *
 * The target is not replaced (that is {@link atomicWrite}'s job); it is
 * appended to, so the symlink must be refused rather than renamed over:
 *
 *  - an `lstat` refuses a path that is a symlink, a hard link to someone
 *    else's file, or anything that is not a regular file, before the open;
 *  - an absent target is created with `createNew` (`O_EXCL|O_CREAT`), so a
 *    link planted in the check→open window makes the create fail rather than
 *    be followed — the link's target is never even created empty;
 *  - an existing target's descriptor is re-checked against a second `lstat`,
 *    so a link swapped in over it is caught before a single byte is written;
 *    and
 *  - a file created here is created at `mode` (0600 by default) and chmod'ed
 *    to it, in case the open mode was reduced by the process umask.
 *
 * Failure is returned, never swallowed — the caller decides whether a refused
 * append is fatal, but it is always told.
 *
 * @param options - Target file path, content, and optional permissions
 * @returns Result indicating success or failure with error message
 */
export async function appendNoFollow(
  options: AppendNoFollowOptions,
): Promise<Result<void>> {
  const { targetFile, content, mode = DEFAULT_FILE_MODE } = options;

  const existing = await lstatOrNull(targetFile);
  if (!existing.ok) return existing;
  const refusal = refuseNonRegular(targetFile, existing.value);
  if (refusal) return refusal;
  const created = existing.value === null;

  let file: Deno.FsFile;
  try {
    file = created
      // O_EXCL: a link planted since the lstat loses the race loudly.
      ? await Deno.open(targetFile, { append: true, createNew: true, mode })
      : await Deno.open(targetFile, { append: true });
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `appendNoFollow — failed to open file: ${targetFile}: ${
          (err as Error).message
        }`,
      ),
    };
  }

  try {
    // Close the lstat→open window: the descriptor must still be the path's
    // own inode. A link swapped in after the check opens its target, whose
    // inode differs from what a fresh lstat of the path now reports.
    const opened = await file.stat();
    const current = await lstatOrNull(targetFile);
    if (!current.ok) return current;
    const swapped = current.value === null || current.value.isSymlink ||
      (opened.ino !== null && current.value.ino !== null &&
        opened.ino !== current.value.ino);
    if (swapped) {
      return {
        ok: false,
        error: new Error(
          `appendNoFollow — refusing to append through a symlink: ${targetFile}`,
        ),
      };
    }

    // Defence in depth, as in atomicWrite: the open() mode is reduced by the
    // process umask, so a file created here is chmod'ed to what was asked for.
    // The inode was just verified, so this cannot follow a planted link.
    if (created) await Deno.chmod(targetFile, mode);

    const encoded = new TextEncoder().encode(content);
    let written = 0;
    while (written < encoded.length) {
      written += await file.write(encoded.subarray(written));
    }
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `appendNoFollow — failed to append to file: ${targetFile}: ${
          (err as Error).message
        }`,
      ),
    };
  } finally {
    try {
      file.close();
    } catch { /* already closed */ }
  }

  return { ok: true, value: undefined };
}

/** `lstat` the path, reporting "absent" as a null value rather than a throw. */
async function lstatOrNull(
  path: string,
): Promise<Result<Deno.FileInfo | null>> {
  try {
    return { ok: true, value: await Deno.lstat(path) };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { ok: true, value: null };
    return {
      ok: false,
      error: new Error(
        `appendNoFollow — failed to inspect path: ${path}: ${
          (err as Error).message
        }`,
      ),
    };
  }
}

/**
 * Refuse a symlink, a hard link, or any non-regular file already at the path.
 *
 * A hard link is the same attack with no link to lstat: the appended bytes
 * land in someone else's file just as they would through a symlink, and a
 * log this worker owns never has a second name.
 */
function refuseNonRegular(
  path: string,
  info: Deno.FileInfo | null,
): Result<void> | null {
  if (info === null) return null;
  if (info.isSymlink) {
    return {
      ok: false,
      error: new Error(
        `appendNoFollow — refusing to append through a symlink: ${path}`,
      ),
    };
  }
  if (!info.isFile) {
    return {
      ok: false,
      error: new Error(
        `appendNoFollow — target is not a regular file: ${path}`,
      ),
    };
  }
  if (info.nlink !== null && info.nlink > 1) {
    return {
      ok: false,
      error: new Error(
        `appendNoFollow — refusing to append through a hard link ` +
          `(${info.nlink} names): ${path}`,
      ),
    };
  }
  return null;
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
