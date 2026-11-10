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
 */ /** Default file permissions for state/cache files (user read/write only). */ const DEFAULT_FILE_MODE = 0o600;
/** Bytes for a write, without a lossy round-trip through the decoder. */ function encodeContent(content) {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
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
 */ export async function atomicWrite(options) {
  const { targetFile, content, mode = DEFAULT_FILE_MODE } = options;
  // Resolve to absolute path for safety
  const targetDir = targetFile.substring(0, targetFile.lastIndexOf("/"));
  // Ensure target directory exists
  try {
    const stat = await Deno.stat(targetDir);
    if (!stat.isDirectory) {
      return {
        ok: false,
        error: new Error(`atomicWrite — target path is not a directory: ${targetDir}`)
      };
    }
  } catch  {
    return {
      ok: false,
      error: new Error(`atomicWrite — target directory does not exist: ${targetDir}`)
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
  const tmpBase = options.tempDir === undefined ? targetFile : `${options.tempDir.replace(/\/+$/, "")}/${targetFile.slice(targetFile.lastIndexOf("/") + 1)}`;
  const tmpFile = `${tmpBase}.tmp.${crypto.randomUUID()}`;
  let file;
  try {
    file = await Deno.open(tmpFile, {
      write: true,
      createNew: true,
      mode
    });
  } catch (err) {
    return {
      ok: false,
      error: new Error(`atomicWrite — failed to create temp file: ${tmpFile}: ${err.message}`)
    };
  }
  // Write content to temp file
  try {
    const encoded = encodeContent(content);
    let written = 0;
    while(written < encoded.length){
      written += await file.write(encoded.subarray(written));
    }
  } catch (err) {
    try {
      file.close();
    } catch  {}
    try {
      await Deno.remove(tmpFile);
    } catch  {}
    return {
      ok: false,
      error: new Error(`atomicWrite — failed to write temp file: ${tmpFile}: ${err.message}`)
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
    } catch  {}
    return {
      ok: false,
      error: new Error(`atomicWrite — failed to set permissions on temp file: ${tmpFile}: ${err.message}`)
    };
  }
  // Atomically replace the target file
  try {
    await Deno.rename(tmpFile, targetFile);
  } catch (err) {
    try {
      await Deno.remove(tmpFile);
    } catch  {}
    return {
      ok: false,
      error: new Error(`atomicWrite — failed to rename temp file to target: ${targetFile}: ${err.message}`)
    };
  }
  return {
    ok: true,
    value: undefined
  };
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
 */ export function atomicWriteSync(options) {
  const { targetFile, content, mode = DEFAULT_FILE_MODE } = options;
  const targetDir = targetFile.substring(0, targetFile.lastIndexOf("/"));
  try {
    if (!Deno.statSync(targetDir).isDirectory) {
      return {
        ok: false,
        error: new Error(`atomicWriteSync — target path is not a directory: ${targetDir}`)
      };
    }
  } catch  {
    return {
      ok: false,
      error: new Error(`atomicWriteSync — target directory does not exist: ${targetDir}`)
    };
  }
  const tmpFile = `${targetFile}.tmp.${crypto.randomUUID()}`;
  let file;
  try {
    file = Deno.openSync(tmpFile, {
      write: true,
      createNew: true,
      mode
    });
  } catch (err) {
    return {
      ok: false,
      error: new Error(`atomicWriteSync — failed to create temp file: ${tmpFile}: ${err.message}`)
    };
  }
  try {
    const encoded = encodeContent(content);
    let written = 0;
    while(written < encoded.length){
      written += file.writeSync(encoded.subarray(written));
    }
  } catch (err) {
    try {
      file.close();
    } catch  {}
    removeSyncBestEffort(tmpFile);
    return {
      ok: false,
      error: new Error(`atomicWriteSync — failed to write temp file: ${tmpFile}: ${err.message}`)
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
      error: new Error(`atomicWriteSync — failed to set permissions on temp file: ${tmpFile}: ${err.message}`)
    };
  }
  try {
    Deno.renameSync(tmpFile, targetFile);
  } catch (err) {
    removeSyncBestEffort(tmpFile);
    return {
      ok: false,
      error: new Error(`atomicWriteSync — failed to rename temp file to target: ${targetFile}: ${err.message}`)
    };
  }
  return {
    ok: true,
    value: undefined
  };
}
/** Remove a temp file we created; a cleanup failure must not mask the cause. */ function removeSyncBestEffort(path) {
  try {
    Deno.removeSync(path);
  } catch  {}
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
 */ export async function appendNoFollow(options) {
  const { targetFile, content, mode = DEFAULT_FILE_MODE } = options;
  const existing = await lstatOrNull(targetFile, "appendNoFollow");
  if (!existing.ok) return existing;
  const refusal = refuseNonRegular(targetFile, existing.value, "appendNoFollow", "append");
  if (refusal) return {
    ok: false,
    error: refusal
  };
  const created = existing.value === null;
  let file;
  try {
    file = created ? await Deno.open(targetFile, {
      append: true,
      createNew: true,
      mode
    }) : await Deno.open(targetFile, {
      append: true
    });
  } catch (err) {
    return {
      ok: false,
      error: new Error(`appendNoFollow — failed to open file: ${targetFile}: ${err.message}`)
    };
  }
  try {
    // Close the lstat→open window: the descriptor must still be the path's
    // own inode. A link swapped in after the check opens its target, whose
    // inode differs from what a fresh lstat of the path now reports.
    const opened = await file.stat();
    const current = await lstatOrNull(targetFile, "appendNoFollow");
    if (!current.ok) return current;
    const swapped = current.value === null || current.value.isSymlink || opened.ino !== null && current.value.ino !== null && opened.ino !== current.value.ino;
    if (swapped) {
      return {
        ok: false,
        error: new Error(`appendNoFollow — refusing to append through a symlink: ${targetFile}`)
      };
    }
    // Defence in depth, as in atomicWrite: the open() mode is reduced by the
    // process umask, so a file created here is chmod'ed to what was asked for.
    // The inode was just verified, so this cannot follow a planted link.
    if (created) await Deno.chmod(targetFile, mode);
    const encoded = new TextEncoder().encode(content);
    let written = 0;
    while(written < encoded.length){
      written += await file.write(encoded.subarray(written));
    }
  } catch (err) {
    return {
      ok: false,
      error: new Error(`appendNoFollow — failed to append to file: ${targetFile}: ${err.message}`)
    };
  } finally{
    try {
      file.close();
    } catch  {}
  }
  return {
    ok: true,
    value: undefined
  };
}
/**
 * Read a file's text, refusing to follow a link at the path (Issue #1234).
 *
 * `Deno.readTextFile` follows a symlink, so a repo-supplied `.gitignore` link
 * makes the reader slurp whatever the link points at — and a
 * read-modify-write caller then copies that content into the file it writes
 * back. The same guards as {@link appendNoFollow} apply: an `lstat` refuses a
 * symlink, a hard link or any non-regular target before the open, and the
 * descriptor is re-checked against a fresh `lstat` afterwards so a link swapped
 * into the check→open window is caught before the bytes are used. The check
 * compares inode and device (each when both sides report one), and the
 * descriptor itself must be a regular file (`fstat`).
 *
 * Because the file may be AGENT-WRITABLE, two further bounds apply when set:
 *  - `maxBytes` refuses a file over the cap (by its stat, and by a read that
 *    stops at maxBytes+1 so growth after the stat is caught too); and
 *  - `openTimeoutMs` opens read-write to prevent a raced FIFO from blocking on
 *    Unix, and stops waiting if the open itself stalls.
 *
 * Residual: an open that times out is abandoned, not cancelled. If it later
 * completes, its descriptor is closed, not used. A pending open can keep the
 * process alive; the babysitter's non-watch entry point explicitly exits after
 * its pass. Read-write opens also require write permission on the file.
 *
 * An absent file is reported as a `null` value, not an error — callers that
 * treat "missing" as "empty" ask for that case explicitly.
 *
 * @param targetFile - Path to read
 * @param options - Optional size cap, open timeout and open seam
 * @returns Result with the file's text, or `null` when the file is absent
 */ export async function readTextFileNoFollow(targetFile, options = {}) {
  const fn = "readTextFileNoFollow";
  const { maxBytes, openTimeoutMs, open = Deno.open } = options;
  const existing = await lstatOrNull(targetFile, fn);
  if (!existing.ok) return existing;
  if (existing.value === null) return {
    ok: true,
    value: null
  };
  const refusal = refuseNonRegular(targetFile, existing.value, fn, "read");
  if (refusal) return {
    ok: false,
    error: refusal
  };
  if (maxBytes !== undefined && existing.value.size > maxBytes) {
    return {
      ok: false,
      error: new Error(`${fn} — file exceeds ${maxBytes} bytes: ${targetFile}`)
    };
  }
  let file;
  try {
    const opening = open(targetFile, {
      read: true,
      ...openTimeoutMs === undefined ? {} : {
        write: true
      }
    });
    if (openTimeoutMs === undefined) {
      file = await opening;
    } else {
      const won = await openWithin(opening, openTimeoutMs);
      if (won === null) {
        return {
          ok: false,
          error: new Error(`${fn} — timed out opening ${targetFile} after ${openTimeoutMs}ms`)
        };
      }
      file = won;
    }
  } catch (err) {
    return {
      ok: false,
      error: new Error(`${fn} — failed to open file: ${targetFile}: ${err.message}`)
    };
  }
  try {
    // Close the lstat→open window: a singly-linked regular descriptor must
    // match both the original path identity and the fresh lstat. Comparing
    // only the fresh lstat would accept a replacement raced in before open.
    const opened = await file.stat();
    if (!opened.isFile) {
      return {
        ok: false,
        error: new Error(`${fn} — target is not a regular file: ${targetFile}`)
      };
    }
    if (opened.nlink !== null && opened.nlink > 1) {
      return {
        ok: false,
        error: new Error(`${fn} — refusing to read a hard link: ${targetFile}`)
      };
    }
    const current = await lstatOrNull(targetFile, fn);
    if (!current.ok) return current;
    const swapped = current.value === null || current.value.isSymlink || opened.ino !== null && existing.value.ino !== null && opened.ino !== existing.value.ino || opened.dev !== null && existing.value.dev !== null && opened.dev !== existing.value.dev || opened.ino !== null && current.value.ino !== null && opened.ino !== current.value.ino || opened.dev !== null && current.value.dev !== null && opened.dev !== current.value.dev;
    if (swapped) {
      return {
        ok: false,
        error: new Error(`${fn} — refusing to read through a symlink: ${targetFile}`)
      };
    }
    // Bounded: read at most maxBytes+1 so one extra byte proves "over cap".
    // Unbounded: the stat size, as before.
    const buffer = new Uint8Array(maxBytes === undefined ? opened.size : maxBytes + 1);
    let read = 0;
    while(read < buffer.length){
      const n = await file.read(buffer.subarray(read));
      if (n === null) break;
      read += n;
    }
    if (maxBytes !== undefined && read > maxBytes) {
      return {
        ok: false,
        error: new Error(`${fn} — file exceeds ${maxBytes} bytes: ${targetFile}`)
      };
    }
    return {
      ok: true,
      value: new TextDecoder().decode(buffer.subarray(0, read))
    };
  } catch (err) {
    return {
      ok: false,
      error: new Error(`${fn} — failed to read file: ${targetFile}: ${err.message}`)
    };
  } finally{
    try {
      file.close();
    } catch  {}
  }
}
/**
 * Await an open for at most `ms`: resolves to the file, or to null when the
 * timer wins. An open abandoned by the timer is closed if it ever completes.
 */ async function openWithin(opening, ms) {
  const timedOut = Symbol("timedOut");
  let timer;
  try {
    const winner = await Promise.race([
      opening,
      new Promise((resolve)=>{
        timer = setTimeout(()=>resolve(timedOut), ms);
      })
    ]);
    if (winner === timedOut) {
      // The caller already has the timeout error; the abandoned descriptor
      // must not leak, so close it when the open eventually settles.
      opening.then((f)=>f.close(), ()=>{});
      return null;
    }
    return winner;
  } finally{
    clearTimeout(timer);
  }
}
/** `lstat` the path, reporting "absent" as a null value rather than a throw. */ async function lstatOrNull(path, fn) {
  try {
    return {
      ok: true,
      value: await Deno.lstat(path)
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {
      ok: true,
      value: null
    };
    return {
      ok: false,
      error: new Error(`${fn} — failed to inspect path: ${path}: ${err.message}`)
    };
  }
}
/**
 * Refuse a symlink, a hard link, or any non-regular file already at the path.
 *
 * A hard link is the same attack with no link to lstat: the bytes land in — or
 * come from — someone else's file just as they would through a symlink, and a
 * file this worker owns never has a second name.
 *
 * `fn` names the calling primitive and `verb` what it was about to do, so the
 * refusal reads as the caller's own ("refusing to append/read through …").
 * Returns the refusal as an Error, or null when the path is safe to use.
 */ function refuseNonRegular(path, info, fn, verb) {
  if (info === null) return null;
  if (info.isSymlink) {
    return new Error(`${fn} — refusing to ${verb} through a symlink: ${path}`);
  }
  if (!info.isFile) {
    return new Error(`${fn} — target is not a regular file: ${path}`);
  }
  if (info.nlink !== null && info.nlink > 1) {
    return new Error(`${fn} — refusing to ${verb} through a hard link ` + `(${info.nlink} names): ${path}`);
  }
  return null;
}
/**
 * Read a file safely, returning empty string if the file does not exist.
 *
 * @param filePath - Path to the file to read
 * @returns Result containing the file contents or empty string
 */ export async function safeReadFile(filePath) {
  try {
    const content = await Deno.readTextFile(filePath);
    return {
      ok: true,
      value: content
    };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return {
        ok: true,
        value: ""
      };
    }
    return {
      ok: false,
      error: new Error(`safeReadFile — failed to read file: ${filePath}: ${err.message}`)
    };
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9maWxlX3V0aWxzLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQXRvbWljIGZpbGUgd3JpdGUgdXRpbGl0aWVzIGZvciBzdGF0ZSBhbmQgY2FjaGUgZmlsZXMgKElzc3VlICM2OTMpLlxuICpcbiAqIFNldmVyYWwgbW9kdWxlcyB3cml0ZSBzdGF0ZSBhbmQgY2FjaGUgZmlsZXMgdGhhdCBjYW4gYmUgY29ycnVwdGVkIGlmXG4gKiB0aGUgd29ya2VyIGlzIGludGVycnVwdGVkIG1pZC13cml0ZSAoa2lsbCBzaWduYWwsIGRpc2sgZnVsbCkuIFRoaXNcbiAqIG1vZHVsZSBwcm92aWRlcyBhdG9taWMgd3JpdGUgZnVuY3Rpb25zIHRoYXQ6XG4gKiAgIC0gV3JpdGUgdG8gYSB0ZW1wb3JhcnkgZmlsZSBpbiB0aGUgc2FtZSBkaXJlY3RvcnkgYXMgdGhlIHRhcmdldFxuICogICAtIFVzZSByZW5hbWUgKHdoaWNoIGlzIGF0b21pYyBvbiBQT1NJWCBmaWxlc3lzdGVtcykgdG8gcmVwbGFjZSB0aGUgdGFyZ2V0XG4gKiAgIC0gU2V0IGFwcHJvcHJpYXRlIHBlcm1pc3Npb25zIChtb2RlIDBvNjAwIGJ5IGRlZmF1bHQgZm9yIHN0YXRlIGZpbGVzKVxuICogICAtIENsZWFuIHVwIHRlbXAgZmlsZXMgb24gZmFpbHVyZVxuICpcbiAqIE1pZ3JhdGVkIGZyb20gd29ya2VyL3NoYXJlZC9maWxlX3V0aWxzLnNoIChJc3N1ZSAjOTAxKS5cbiAqXG4gKiBJc3N1ZSAjMjM0ODogdGhlIHRlbXAgZmlsZSBpcyBjcmVhdGVkIHdpdGggYSBrZXJuZWwtcmFuZG9tIHN1ZmZpeCBhbmRcbiAqIG9wZW5lZCBleGNsdXNpdmVseSAoY3JlYXRlTmV3KSB3aXRoIHRoZSByZXF1ZXN0ZWQgbW9kZSwgc28gYSBjby1sb2NhdGVkXG4gKiBhdHRhY2tlciBjYW5ub3QgcHJlLXBvc2l0aW9uIGEgc3ltbGluayBhdCBhIHByZWRpY3RhYmxlIHBhdGggYW5kIHRoZVxuICogZmlsZSBpcyBuZXZlciBicmllZmx5IHJlYWRhYmxlIGF0IHRoZSBwcm9jZXNzIHVtYXNrJ3MgZGVmYXVsdCBtb2RlLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5cbi8qKiBEZWZhdWx0IGZpbGUgcGVybWlzc2lvbnMgZm9yIHN0YXRlL2NhY2hlIGZpbGVzICh1c2VyIHJlYWQvd3JpdGUgb25seSkuICovXG5jb25zdCBERUZBVUxUX0ZJTEVfTU9ERSA9IDBvNjAwO1xuXG4vKiogT3B0aW9ucyBmb3IgYXRvbWljIHdyaXRlIG9wZXJhdGlvbnMuICovXG5leHBvcnQgaW50ZXJmYWNlIEF0b21pY1dyaXRlT3B0aW9ucyB7XG4gIC8qKiBQYXRoIHRvIHRoZSB0YXJnZXQgZmlsZS4gKi9cbiAgdGFyZ2V0RmlsZTogc3RyaW5nO1xuICAvKiogQ29udGVudCB0byB3cml0ZTsgYnl0ZXMgYXJlIHdyaXR0ZW4gdmVyYmF0aW0sIHRleHQgYXMgVVRGLTguICovXG4gIGNvbnRlbnQ6IHN0cmluZyB8IFVpbnQ4QXJyYXk7XG4gIC8qKiBGaWxlIHBlcm1pc3Npb25zIChkZWZhdWx0OiAwbzYwMCkuICovXG4gIG1vZGU/OiBudW1iZXI7XG4gIC8qKlxuICAgKiBEaXJlY3RvcnkgdGhlIHRlbXBvcmFyeSBmaWxlIGlzIGNyZWF0ZWQgaW4gKElzc3VlICMxNjA0KS4gRGVmYXVsdHMgdG9cbiAgICogdGhlIHRhcmdldCdzIG93biBkaXJlY3RvcnkuIE11c3QgYmUgb24gdGhlIHNhbWUgZmlsZXN5c3RlbSBhcyB0aGVcbiAgICogdGFyZ2V0LCBvciB0aGUgcmVuYW1lIHN0b3BzIGJlaW5nIGF0b21pYyDigJQgdGhlIG9uZSBjYWxsZXIgdGhhdCBzZXRzIGl0XG4gICAqICh0aGUgYXVkaXQgcm9zdGVyJ3Mgc2Vlbi1tYXJrZXIpIHdyaXRlcyBhIGZpbGUgdGhhdCBzaXRzICpiZXNpZGUqIHRoZVxuICAgKiBqb3VybmFsIGRpcmVjdG9yeSBmcm9tIGEgcHJvY2VzcyB3aG9zZSB3cml0ZSBncmFudCBjb3ZlcnMgdGhlIGpvdXJuYWxcbiAgICogZGlyZWN0b3J5IGFuZCB0aGF0IG9uZSBmaWxlLCBidXQgbm90IHRoZSBmaWxlJ3Mgc2libGluZ3MuXG4gICAqL1xuICB0ZW1wRGlyPzogc3RyaW5nO1xufVxuXG4vKiogQnl0ZXMgZm9yIGEgd3JpdGUsIHdpdGhvdXQgYSBsb3NzeSByb3VuZC10cmlwIHRocm91Z2ggdGhlIGRlY29kZXIuICovXG5mdW5jdGlvbiBlbmNvZGVDb250ZW50KGNvbnRlbnQ6IHN0cmluZyB8IFVpbnQ4QXJyYXkpOiBVaW50OEFycmF5IHtcbiAgcmV0dXJuIHR5cGVvZiBjb250ZW50ID09PSBcInN0cmluZ1wiXG4gICAgPyBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoY29udGVudClcbiAgICA6IGNvbnRlbnQ7XG59XG5cbi8qKlxuICogV3JpdGUgY29udGVudCB0byBhIGZpbGUgYXRvbWljYWxseS5cbiAqXG4gKiBXcml0ZXMgY29udGVudCB0byBhIHRlbXBvcmFyeSBmaWxlIGluIHRoZSBzYW1lIGRpcmVjdG9yeSwgdGhlbiB1c2VzXG4gKiByZW5hbWUgdG8gYXRvbWljYWxseSByZXBsYWNlIHRoZSB0YXJnZXQuIElmIHRoZSB3cml0ZSBvciByZW5hbWUgZmFpbHMsXG4gKiB0aGUgb3JpZ2luYWwgZmlsZSBpcyBsZWZ0IGludGFjdCBhbmQgdGhlIHRlbXAgZmlsZSBpcyBjbGVhbmVkIHVwLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gVGFyZ2V0IGZpbGUgcGF0aCwgY29udGVudCwgYW5kIG9wdGlvbmFsIHBlcm1pc3Npb25zXG4gKiBAcmV0dXJucyBSZXN1bHQgaW5kaWNhdGluZyBzdWNjZXNzIG9yIGZhaWx1cmUgd2l0aCBlcnJvciBtZXNzYWdlXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhdG9taWNXcml0ZShcbiAgb3B0aW9uczogQXRvbWljV3JpdGVPcHRpb25zLFxuKTogUHJvbWlzZTxSZXN1bHQ8dm9pZD4+IHtcbiAgY29uc3QgeyB0YXJnZXRGaWxlLCBjb250ZW50LCBtb2RlID0gREVGQVVMVF9GSUxFX01PREUgfSA9IG9wdGlvbnM7XG5cbiAgLy8gUmVzb2x2ZSB0byBhYnNvbHV0ZSBwYXRoIGZvciBzYWZldHlcbiAgY29uc3QgdGFyZ2V0RGlyID0gdGFyZ2V0RmlsZS5zdWJzdHJpbmcoXG4gICAgMCxcbiAgICB0YXJnZXRGaWxlLmxhc3RJbmRleE9mKFwiL1wiKSxcbiAgKTtcblxuICAvLyBFbnN1cmUgdGFyZ2V0IGRpcmVjdG9yeSBleGlzdHNcbiAgdHJ5IHtcbiAgICBjb25zdCBzdGF0ID0gYXdhaXQgRGVuby5zdGF0KHRhcmdldERpcik7XG4gICAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYGF0b21pY1dyaXRlIOKAlCB0YXJnZXQgcGF0aCBpcyBub3QgYSBkaXJlY3Rvcnk6ICR7dGFyZ2V0RGlyfWAsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBhdG9taWNXcml0ZSDigJQgdGFyZ2V0IGRpcmVjdG9yeSBkb2VzIG5vdCBleGlzdDogJHt0YXJnZXREaXJ9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIC8vIENyZWF0ZSB0ZW1wIGZpbGUgaW4gdGhlIHNhbWUgZGlyZWN0b3J5IChzYW1lIGZpbGVzeXN0ZW0gZm9yIGF0b21pY1xuICAvLyByZW5hbWUpLiBVc2UgYSBrZXJuZWwtcmFuZG9tIHN1ZmZpeCByYXRoZXIgdGhhbiB0aGUgUElEIChJc3N1ZSAjMjM0OClcbiAgLy8gc28gYSBjby1sb2NhdGVkIGF0dGFja2VyIGNhbm5vdCBwcmUtcG9zaXRpb24gYSBzeW1saW5rIGF0IGFcbiAgLy8gcHJlZGljdGFibGUgcGF0aC4gT3BlbiB3aXRoIGNyZWF0ZU5ldyAoT19FWENMfE9fQ1JFQVQpIGFuZCB0aGVcbiAgLy8gcmVxdWVzdGVkIG1vZGUgc286XG4gIC8vICAgLSBhbnkgcHJlLWV4aXN0aW5nIHBhdGggYXQgdG1wRmlsZSAoaW5jbHVkaW5nIGEgc3ltbGluaykgY2F1c2VzXG4gIC8vICAgICBjcmVhdGlvbiB0byBmYWlsIHJhdGhlciB0aGFuIGJlIGZvbGxvd2VkOyBhbmRcbiAgLy8gICAtIHRoZSBmaWxlIGlzIHJlc3RyaWN0ZWQgdG8gdGhlIHJlcXVlc3RlZCBtb2RlIGZyb20gY3JlYXRpb24sXG4gIC8vICAgICBjbG9zaW5nIHRoZSBwZXJtaXNzaW9uIHdpbmRvdyBiZXR3ZWVuIHdyaXRlIGFuZCBjaG1vZCB0aGF0IHRoZVxuICAvLyAgICAgcHJldmlvdXMgd3JpdGVUZXh0RmlsZSArIGxhdGUtY2htb2Qgc2VxdWVuY2Ugb3BlbmVkLlxuICBjb25zdCB0bXBCYXNlID0gb3B0aW9ucy50ZW1wRGlyID09PSB1bmRlZmluZWRcbiAgICA/IHRhcmdldEZpbGVcbiAgICA6IGAke29wdGlvbnMudGVtcERpci5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpfS8ke1xuICAgICAgdGFyZ2V0RmlsZS5zbGljZSh0YXJnZXRGaWxlLmxhc3RJbmRleE9mKFwiL1wiKSArIDEpXG4gICAgfWA7XG4gIGNvbnN0IHRtcEZpbGUgPSBgJHt0bXBCYXNlfS50bXAuJHtjcnlwdG8ucmFuZG9tVVVJRCgpfWA7XG5cbiAgbGV0IGZpbGU6IERlbm8uRnNGaWxlO1xuICB0cnkge1xuICAgIGZpbGUgPSBhd2FpdCBEZW5vLm9wZW4odG1wRmlsZSwge1xuICAgICAgd3JpdGU6IHRydWUsXG4gICAgICBjcmVhdGVOZXc6IHRydWUsXG4gICAgICBtb2RlLFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYGF0b21pY1dyaXRlIOKAlCBmYWlsZWQgdG8gY3JlYXRlIHRlbXAgZmlsZTogJHt0bXBGaWxlfTogJHtcbiAgICAgICAgICAoZXJyIGFzIEVycm9yKS5tZXNzYWdlXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gV3JpdGUgY29udGVudCB0byB0ZW1wIGZpbGVcbiAgdHJ5IHtcbiAgICBjb25zdCBlbmNvZGVkID0gZW5jb2RlQ29udGVudChjb250ZW50KTtcbiAgICBsZXQgd3JpdHRlbiA9IDA7XG4gICAgd2hpbGUgKHdyaXR0ZW4gPCBlbmNvZGVkLmxlbmd0aCkge1xuICAgICAgd3JpdHRlbiArPSBhd2FpdCBmaWxlLndyaXRlKGVuY29kZWQuc3ViYXJyYXkod3JpdHRlbikpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdHJ5IHtcbiAgICAgIGZpbGUuY2xvc2UoKTtcbiAgICB9IGNhdGNoIHsgLyogYWxyZWFkeSBjbG9zZWQgKi8gfVxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLnJlbW92ZSh0bXBGaWxlKTtcbiAgICB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgY2xlYW51cCAqLyB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBhdG9taWNXcml0ZSDigJQgZmFpbGVkIHRvIHdyaXRlIHRlbXAgZmlsZTogJHt0bXBGaWxlfTogJHtcbiAgICAgICAgICAoZXJyIGFzIEVycm9yKS5tZXNzYWdlXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGZpbGUuY2xvc2UoKTtcblxuICAvLyBEZWZlbmNlLWluLWRlcHRoOiByZS1hcHBseSBtb2RlIGluIGNhc2UgdGhlIG9wZW4oKSBtb2RlIHdhcyByZWR1Y2VkXG4gIC8vIGJ5IHRoZSBwcm9jZXNzIHVtYXNrLiB0bXBGaWxlIGlzIGEgcmVndWxhciBmaWxlIHdlIGp1c3QgY3JlYXRlZFxuICAvLyBleGNsdXNpdmVseSwgc28gY2htb2QgZG9lcyBub3QgZm9sbG93IGFuIGF0dGFja2VyLWNvbnRyb2xsZWQgc3ltbGluay5cbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLmNobW9kKHRtcEZpbGUsIG1vZGUpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgRGVuby5yZW1vdmUodG1wRmlsZSk7XG4gICAgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0IGNsZWFudXAgKi8gfVxuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgYXRvbWljV3JpdGUg4oCUIGZhaWxlZCB0byBzZXQgcGVybWlzc2lvbnMgb24gdGVtcCBmaWxlOiAke3RtcEZpbGV9OiAke1xuICAgICAgICAgIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2VcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICAvLyBBdG9taWNhbGx5IHJlcGxhY2UgdGhlIHRhcmdldCBmaWxlXG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5yZW5hbWUodG1wRmlsZSwgdGFyZ2V0RmlsZSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLnJlbW92ZSh0bXBGaWxlKTtcbiAgICB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgY2xlYW51cCAqLyB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBhdG9taWNXcml0ZSDigJQgZmFpbGVkIHRvIHJlbmFtZSB0ZW1wIGZpbGUgdG8gdGFyZ2V0OiAke3RhcmdldEZpbGV9OiAke1xuICAgICAgICAgIChlcnIgYXMgRXJyb3IpLm1lc3NhZ2VcbiAgICAgICAgfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xufVxuXG4vKipcbiAqIFN5bmNocm9ub3VzIHNpYmxpbmcgb2Yge0BsaW5rIGF0b21pY1dyaXRlfSAoSXNzdWUgIzM2ODIpLlxuICpcbiAqIFNhbWUgZ3VhcmFudGVlcyDigJQga2VybmVsLXJhbmRvbSB0ZW1wIHN1ZmZpeCwgYGNyZWF0ZU5ld2AgKE9fRVhDTCkgc28gYVxuICogcHJlLXBvc2l0aW9uZWQgc3ltbGluayBjYW4gbmV2ZXIgYmUgZm9sbG93ZWQsIHJlcXVlc3RlZCBtb2RlIGZyb21cbiAqIGNyZWF0aW9uLCBhdG9taWMgcmVuYW1lLCB0ZW1wIGNsZWFudXAgb24gZmFpbHVyZSDigJQgZm9yIHRoZSBjYWxsZXJzIHRoYXRcbiAqIGNhbm5vdCBhd2FpdCAoZS5nLiB0aGUgaGVhbHRoLWNoZWNrIGNhY2hlIHdyaXRlcnMpLlxuICpcbiAqIEBwYXJhbSBvcHRpb25zIC0gVGFyZ2V0IGZpbGUgcGF0aCwgY29udGVudCwgYW5kIG9wdGlvbmFsIHBlcm1pc3Npb25zXG4gKiBAcmV0dXJucyBSZXN1bHQgaW5kaWNhdGluZyBzdWNjZXNzIG9yIGZhaWx1cmUgd2l0aCBlcnJvciBtZXNzYWdlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhdG9taWNXcml0ZVN5bmMoXG4gIG9wdGlvbnM6IEF0b21pY1dyaXRlT3B0aW9ucyxcbik6IFJlc3VsdDx2b2lkPiB7XG4gIGNvbnN0IHsgdGFyZ2V0RmlsZSwgY29udGVudCwgbW9kZSA9IERFRkFVTFRfRklMRV9NT0RFIH0gPSBvcHRpb25zO1xuXG4gIGNvbnN0IHRhcmdldERpciA9IHRhcmdldEZpbGUuc3Vic3RyaW5nKDAsIHRhcmdldEZpbGUubGFzdEluZGV4T2YoXCIvXCIpKTtcblxuICB0cnkge1xuICAgIGlmICghRGVuby5zdGF0U3luYyh0YXJnZXREaXIpLmlzRGlyZWN0b3J5KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYGF0b21pY1dyaXRlU3luYyDigJQgdGFyZ2V0IHBhdGggaXMgbm90IGEgZGlyZWN0b3J5OiAke3RhcmdldERpcn1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgYXRvbWljV3JpdGVTeW5jIOKAlCB0YXJnZXQgZGlyZWN0b3J5IGRvZXMgbm90IGV4aXN0OiAke3RhcmdldERpcn1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgdG1wRmlsZSA9IGAke3RhcmdldEZpbGV9LnRtcC4ke2NyeXB0by5yYW5kb21VVUlEKCl9YDtcblxuICBsZXQgZmlsZTogRGVuby5Gc0ZpbGU7XG4gIHRyeSB7XG4gICAgZmlsZSA9IERlbm8ub3BlblN5bmModG1wRmlsZSwgeyB3cml0ZTogdHJ1ZSwgY3JlYXRlTmV3OiB0cnVlLCBtb2RlIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYGF0b21pY1dyaXRlU3luYyDigJQgZmFpbGVkIHRvIGNyZWF0ZSB0ZW1wIGZpbGU6ICR7dG1wRmlsZX06ICR7XG4gICAgICAgICAgKGVyciBhcyBFcnJvcikubWVzc2FnZVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgZW5jb2RlZCA9IGVuY29kZUNvbnRlbnQoY29udGVudCk7XG4gICAgbGV0IHdyaXR0ZW4gPSAwO1xuICAgIHdoaWxlICh3cml0dGVuIDwgZW5jb2RlZC5sZW5ndGgpIHtcbiAgICAgIHdyaXR0ZW4gKz0gZmlsZS53cml0ZVN5bmMoZW5jb2RlZC5zdWJhcnJheSh3cml0dGVuKSk7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICB0cnkge1xuICAgICAgZmlsZS5jbG9zZSgpO1xuICAgIH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGNsb3NlZCAqLyB9XG4gICAgcmVtb3ZlU3luY0Jlc3RFZmZvcnQodG1wRmlsZSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBhdG9taWNXcml0ZVN5bmMg4oCUIGZhaWxlZCB0byB3cml0ZSB0ZW1wIGZpbGU6ICR7dG1wRmlsZX06ICR7XG4gICAgICAgICAgKGVyciBhcyBFcnJvcikubWVzc2FnZVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICBmaWxlLmNsb3NlKCk7XG5cbiAgLy8gRGVmZW5jZSBpbiBkZXB0aDogdGhlIG9wZW4oKSBtb2RlIG1heSBoYXZlIGJlZW4gcmVkdWNlZCBieSB0aGUgdW1hc2suXG4gIHRyeSB7XG4gICAgRGVuby5jaG1vZFN5bmModG1wRmlsZSwgbW9kZSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJlbW92ZVN5bmNCZXN0RWZmb3J0KHRtcEZpbGUpO1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgYXRvbWljV3JpdGVTeW5jIOKAlCBmYWlsZWQgdG8gc2V0IHBlcm1pc3Npb25zIG9uIHRlbXAgZmlsZTogJHt0bXBGaWxlfTogJHtcbiAgICAgICAgICAoZXJyIGFzIEVycm9yKS5tZXNzYWdlXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICBEZW5vLnJlbmFtZVN5bmModG1wRmlsZSwgdGFyZ2V0RmlsZSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJlbW92ZVN5bmNCZXN0RWZmb3J0KHRtcEZpbGUpO1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgYXRvbWljV3JpdGVTeW5jIOKAlCBmYWlsZWQgdG8gcmVuYW1lIHRlbXAgZmlsZSB0byB0YXJnZXQ6ICR7dGFyZ2V0RmlsZX06ICR7XG4gICAgICAgICAgKGVyciBhcyBFcnJvcikubWVzc2FnZVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG59XG5cbi8qKiBSZW1vdmUgYSB0ZW1wIGZpbGUgd2UgY3JlYXRlZDsgYSBjbGVhbnVwIGZhaWx1cmUgbXVzdCBub3QgbWFzayB0aGUgY2F1c2UuICovXG5mdW5jdGlvbiByZW1vdmVTeW5jQmVzdEVmZm9ydChwYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBEZW5vLnJlbW92ZVN5bmMocGF0aCk7XG4gIH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCBjbGVhbnVwIOKAlCB0aGUgb3JpZ2luYWwgZXJyb3IgaXMgcmV0dXJuZWQgKi8gfVxufVxuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIGFwcGVuZE5vRm9sbG93fS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwZW5kTm9Gb2xsb3dPcHRpb25zIHtcbiAgLyoqIFBhdGggdG8gdGhlIGZpbGUgdG8gYXBwZW5kIHRvLiAqL1xuICB0YXJnZXRGaWxlOiBzdHJpbmc7XG4gIC8qKiBDb250ZW50IHRvIGFwcGVuZCB2ZXJiYXRpbSAoaW5jbHVkZSB0aGUgdHJhaWxpbmcgbmV3bGluZSkuICovXG4gIGNvbnRlbnQ6IHN0cmluZztcbiAgLyoqIEZpbGUgcGVybWlzc2lvbnMgYXBwbGllZCB3aGVuIHRoZSBmaWxlIGlzIGNyZWF0ZWQgKGRlZmF1bHQ6IDBvNjAwKS4gKi9cbiAgbW9kZT86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBBcHBlbmQgdG8gYSBmaWxlLCByZWZ1c2luZyB0byBmb2xsb3cgYSBzeW1saW5rIGF0IHRoZSB0YXJnZXQgKElzc3VlICMxMjM5KS5cbiAqXG4gKiBBIGJhcmUgYERlbm8ud3JpdGVUZXh0RmlsZShwYXRoLCBsaW5lLCB7IGFwcGVuZDogdHJ1ZSB9KWAgb3BlbnNcbiAqIGBPX0NSRUFUfE9fQVBQRU5EYCBhbmQgZm9sbG93cyBhIHN5bWxpbmssIHNvIGFuIGFjY291bnQgdGhhdCBjYW4gY3JlYXRlIHRoZVxuICogcGF0aCDigJQgdGhlIGBhZ2VudGAgYWNjb3VudCBvd25zIHRoYXQgcG93ZXIgb3ZlciB0aGUgc2hhcmVkIHdvcmsgcm9vdCDigJQgY2FuXG4gKiByZWRpcmVjdCBhbiBhcHBlbmQtb25seSBsb2cgaW50byBhbnkgZmlsZSB0aGUgd29ya2VyIHVpZCBjYW4gd3JpdGUuXG4gKlxuICogVGhlIHRhcmdldCBpcyBub3QgcmVwbGFjZWQgKHRoYXQgaXMge0BsaW5rIGF0b21pY1dyaXRlfSdzIGpvYik7IGl0IGlzXG4gKiBhcHBlbmRlZCB0bywgc28gdGhlIHN5bWxpbmsgbXVzdCBiZSByZWZ1c2VkIHJhdGhlciB0aGFuIHJlbmFtZWQgb3ZlcjpcbiAqXG4gKiAgLSBhbiBgbHN0YXRgIHJlZnVzZXMgYSBwYXRoIHRoYXQgaXMgYSBzeW1saW5rLCBhIGhhcmQgbGluayB0byBzb21lb25lXG4gKiAgICBlbHNlJ3MgZmlsZSwgb3IgYW55dGhpbmcgdGhhdCBpcyBub3QgYSByZWd1bGFyIGZpbGUsIGJlZm9yZSB0aGUgb3BlbjtcbiAqICAtIGFuIGFic2VudCB0YXJnZXQgaXMgY3JlYXRlZCB3aXRoIGBjcmVhdGVOZXdgIChgT19FWENMfE9fQ1JFQVRgKSwgc28gYVxuICogICAgbGluayBwbGFudGVkIGluIHRoZSBjaGVja+KGkm9wZW4gd2luZG93IG1ha2VzIHRoZSBjcmVhdGUgZmFpbCByYXRoZXIgdGhhblxuICogICAgYmUgZm9sbG93ZWQg4oCUIHRoZSBsaW5rJ3MgdGFyZ2V0IGlzIG5ldmVyIGV2ZW4gY3JlYXRlZCBlbXB0eTtcbiAqICAtIGFuIGV4aXN0aW5nIHRhcmdldCdzIGRlc2NyaXB0b3IgaXMgcmUtY2hlY2tlZCBhZ2FpbnN0IGEgc2Vjb25kIGBsc3RhdGAsXG4gKiAgICBzbyBhIGxpbmsgc3dhcHBlZCBpbiBvdmVyIGl0IGlzIGNhdWdodCBiZWZvcmUgYSBzaW5nbGUgYnl0ZSBpcyB3cml0dGVuO1xuICogICAgYW5kXG4gKiAgLSBhIGZpbGUgY3JlYXRlZCBoZXJlIGlzIGNyZWF0ZWQgYXQgYG1vZGVgICgwNjAwIGJ5IGRlZmF1bHQpIGFuZCBjaG1vZCdlZFxuICogICAgdG8gaXQsIGluIGNhc2UgdGhlIG9wZW4gbW9kZSB3YXMgcmVkdWNlZCBieSB0aGUgcHJvY2VzcyB1bWFzay5cbiAqXG4gKiBGYWlsdXJlIGlzIHJldHVybmVkLCBuZXZlciBzd2FsbG93ZWQg4oCUIHRoZSBjYWxsZXIgZGVjaWRlcyB3aGV0aGVyIGEgcmVmdXNlZFxuICogYXBwZW5kIGlzIGZhdGFsLCBidXQgaXQgaXMgYWx3YXlzIHRvbGQuXG4gKlxuICogQHBhcmFtIG9wdGlvbnMgLSBUYXJnZXQgZmlsZSBwYXRoLCBjb250ZW50LCBhbmQgb3B0aW9uYWwgcGVybWlzc2lvbnNcbiAqIEByZXR1cm5zIFJlc3VsdCBpbmRpY2F0aW5nIHN1Y2Nlc3Mgb3IgZmFpbHVyZSB3aXRoIGVycm9yIG1lc3NhZ2VcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFwcGVuZE5vRm9sbG93KFxuICBvcHRpb25zOiBBcHBlbmROb0ZvbGxvd09wdGlvbnMsXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkPj4ge1xuICBjb25zdCB7IHRhcmdldEZpbGUsIGNvbnRlbnQsIG1vZGUgPSBERUZBVUxUX0ZJTEVfTU9ERSB9ID0gb3B0aW9ucztcblxuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGxzdGF0T3JOdWxsKHRhcmdldEZpbGUsIFwiYXBwZW5kTm9Gb2xsb3dcIik7XG4gIGlmICghZXhpc3Rpbmcub2spIHJldHVybiBleGlzdGluZztcbiAgY29uc3QgcmVmdXNhbCA9IHJlZnVzZU5vblJlZ3VsYXIoXG4gICAgdGFyZ2V0RmlsZSxcbiAgICBleGlzdGluZy52YWx1ZSxcbiAgICBcImFwcGVuZE5vRm9sbG93XCIsXG4gICAgXCJhcHBlbmRcIixcbiAgKTtcbiAgaWYgKHJlZnVzYWwpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6IHJlZnVzYWwgfTtcbiAgY29uc3QgY3JlYXRlZCA9IGV4aXN0aW5nLnZhbHVlID09PSBudWxsO1xuXG4gIGxldCBmaWxlOiBEZW5vLkZzRmlsZTtcbiAgdHJ5IHtcbiAgICBmaWxlID0gY3JlYXRlZFxuICAgICAgLy8gT19FWENMOiBhIGxpbmsgcGxhbnRlZCBzaW5jZSB0aGUgbHN0YXQgbG9zZXMgdGhlIHJhY2UgbG91ZGx5LlxuICAgICAgPyBhd2FpdCBEZW5vLm9wZW4odGFyZ2V0RmlsZSwgeyBhcHBlbmQ6IHRydWUsIGNyZWF0ZU5ldzogdHJ1ZSwgbW9kZSB9KVxuICAgICAgOiBhd2FpdCBEZW5vLm9wZW4odGFyZ2V0RmlsZSwgeyBhcHBlbmQ6IHRydWUgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgYXBwZW5kTm9Gb2xsb3cg4oCUIGZhaWxlZCB0byBvcGVuIGZpbGU6ICR7dGFyZ2V0RmlsZX06ICR7XG4gICAgICAgICAgKGVyciBhcyBFcnJvcikubWVzc2FnZVxuICAgICAgICB9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gQ2xvc2UgdGhlIGxzdGF04oaSb3BlbiB3aW5kb3c6IHRoZSBkZXNjcmlwdG9yIG11c3Qgc3RpbGwgYmUgdGhlIHBhdGgnc1xuICAgIC8vIG93biBpbm9kZS4gQSBsaW5rIHN3YXBwZWQgaW4gYWZ0ZXIgdGhlIGNoZWNrIG9wZW5zIGl0cyB0YXJnZXQsIHdob3NlXG4gICAgLy8gaW5vZGUgZGlmZmVycyBmcm9tIHdoYXQgYSBmcmVzaCBsc3RhdCBvZiB0aGUgcGF0aCBub3cgcmVwb3J0cy5cbiAgICBjb25zdCBvcGVuZWQgPSBhd2FpdCBmaWxlLnN0YXQoKTtcbiAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgbHN0YXRPck51bGwodGFyZ2V0RmlsZSwgXCJhcHBlbmROb0ZvbGxvd1wiKTtcbiAgICBpZiAoIWN1cnJlbnQub2spIHJldHVybiBjdXJyZW50O1xuICAgIGNvbnN0IHN3YXBwZWQgPSBjdXJyZW50LnZhbHVlID09PSBudWxsIHx8IGN1cnJlbnQudmFsdWUuaXNTeW1saW5rIHx8XG4gICAgICAob3BlbmVkLmlubyAhPT0gbnVsbCAmJiBjdXJyZW50LnZhbHVlLmlubyAhPT0gbnVsbCAmJlxuICAgICAgICBvcGVuZWQuaW5vICE9PSBjdXJyZW50LnZhbHVlLmlubyk7XG4gICAgaWYgKHN3YXBwZWQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgICBgYXBwZW5kTm9Gb2xsb3cg4oCUIHJlZnVzaW5nIHRvIGFwcGVuZCB0aHJvdWdoIGEgc3ltbGluazogJHt0YXJnZXRGaWxlfWAsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIERlZmVuY2UgaW4gZGVwdGgsIGFzIGluIGF0b21pY1dyaXRlOiB0aGUgb3BlbigpIG1vZGUgaXMgcmVkdWNlZCBieSB0aGVcbiAgICAvLyBwcm9jZXNzIHVtYXNrLCBzbyBhIGZpbGUgY3JlYXRlZCBoZXJlIGlzIGNobW9kJ2VkIHRvIHdoYXQgd2FzIGFza2VkIGZvci5cbiAgICAvLyBUaGUgaW5vZGUgd2FzIGp1c3QgdmVyaWZpZWQsIHNvIHRoaXMgY2Fubm90IGZvbGxvdyBhIHBsYW50ZWQgbGluay5cbiAgICBpZiAoY3JlYXRlZCkgYXdhaXQgRGVuby5jaG1vZCh0YXJnZXRGaWxlLCBtb2RlKTtcblxuICAgIGNvbnN0IGVuY29kZWQgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoY29udGVudCk7XG4gICAgbGV0IHdyaXR0ZW4gPSAwO1xuICAgIHdoaWxlICh3cml0dGVuIDwgZW5jb2RlZC5sZW5ndGgpIHtcbiAgICAgIHdyaXR0ZW4gKz0gYXdhaXQgZmlsZS53cml0ZShlbmNvZGVkLnN1YmFycmF5KHdyaXR0ZW4pKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgYXBwZW5kTm9Gb2xsb3cg4oCUIGZhaWxlZCB0byBhcHBlbmQgdG8gZmlsZTogJHt0YXJnZXRGaWxlfTogJHtcbiAgICAgICAgICAoZXJyIGFzIEVycm9yKS5tZXNzYWdlXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7XG4gICAgICBmaWxlLmNsb3NlKCk7XG4gICAgfSBjYXRjaCB7IC8qIGFscmVhZHkgY2xvc2VkICovIH1cbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG59XG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgcmVhZFRleHRGaWxlTm9Gb2xsb3d9LiBBbGwgb3B0aW9uYWw7IHVuc2V0ID0gdG9kYXkncyByZWFkLiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZWFkVGV4dEZpbGVOb0ZvbGxvd09wdGlvbnMge1xuICAvKipcbiAgICogUmVmdXNlIGEgZmlsZSBsYXJnZXIgdGhhbiB0aGlzIG1hbnkgYnl0ZXMuIFRoZSByZWFkIGl0c2VsZiBzdG9wcyBhdFxuICAgKiBtYXhCeXRlcysxLCBzbyBhIGZpbGUgdGhhdCBncm93cyBhZnRlciB0aGUgc3RhdCBpcyBzdGlsbCByZWZ1c2VkLiBVbnNldCA9XG4gICAqIHRvZGF5J3MgdW5ib3VuZGVkIHJlYWQgb2YgdGhlIHN0YXQgc2l6ZS5cbiAgICovXG4gIG1heEJ5dGVzPzogbnVtYmVyO1xuICAvKipcbiAgICogR2l2ZSB1cCBvbiB0aGUgb3BlbiBhZnRlciB0aGlzIG1hbnkgbXMuIE9wZW5zIHJlYWQtd3JpdGUgc28gYSBGSUZPIHJhY2VkXG4gICAqIGluIGFmdGVyIGxzdGF0IGNhbm5vdCBibG9jayBvbiBVbml4LiBVbnNldCA9IHJlYWQtb25seSBhbmQgd2FpdC5cbiAgICovXG4gIG9wZW5UaW1lb3V0TXM/OiBudW1iZXI7XG4gIC8qKiBUZXN0IHNlYW07IGRlZmF1bHRzIHRvIERlbm8ub3Blbi4gKi9cbiAgb3Blbj86IHR5cGVvZiBEZW5vLm9wZW47XG59XG5cbi8qKlxuICogUmVhZCBhIGZpbGUncyB0ZXh0LCByZWZ1c2luZyB0byBmb2xsb3cgYSBsaW5rIGF0IHRoZSBwYXRoIChJc3N1ZSAjMTIzNCkuXG4gKlxuICogYERlbm8ucmVhZFRleHRGaWxlYCBmb2xsb3dzIGEgc3ltbGluaywgc28gYSByZXBvLXN1cHBsaWVkIGAuZ2l0aWdub3JlYCBsaW5rXG4gKiBtYWtlcyB0aGUgcmVhZGVyIHNsdXJwIHdoYXRldmVyIHRoZSBsaW5rIHBvaW50cyBhdCDigJQgYW5kIGFcbiAqIHJlYWQtbW9kaWZ5LXdyaXRlIGNhbGxlciB0aGVuIGNvcGllcyB0aGF0IGNvbnRlbnQgaW50byB0aGUgZmlsZSBpdCB3cml0ZXNcbiAqIGJhY2suIFRoZSBzYW1lIGd1YXJkcyBhcyB7QGxpbmsgYXBwZW5kTm9Gb2xsb3d9IGFwcGx5OiBhbiBgbHN0YXRgIHJlZnVzZXMgYVxuICogc3ltbGluaywgYSBoYXJkIGxpbmsgb3IgYW55IG5vbi1yZWd1bGFyIHRhcmdldCBiZWZvcmUgdGhlIG9wZW4sIGFuZCB0aGVcbiAqIGRlc2NyaXB0b3IgaXMgcmUtY2hlY2tlZCBhZ2FpbnN0IGEgZnJlc2ggYGxzdGF0YCBhZnRlcndhcmRzIHNvIGEgbGluayBzd2FwcGVkXG4gKiBpbnRvIHRoZSBjaGVja+KGkm9wZW4gd2luZG93IGlzIGNhdWdodCBiZWZvcmUgdGhlIGJ5dGVzIGFyZSB1c2VkLiBUaGUgY2hlY2tcbiAqIGNvbXBhcmVzIGlub2RlIGFuZCBkZXZpY2UgKGVhY2ggd2hlbiBib3RoIHNpZGVzIHJlcG9ydCBvbmUpLCBhbmQgdGhlXG4gKiBkZXNjcmlwdG9yIGl0c2VsZiBtdXN0IGJlIGEgcmVndWxhciBmaWxlIChgZnN0YXRgKS5cbiAqXG4gKiBCZWNhdXNlIHRoZSBmaWxlIG1heSBiZSBBR0VOVC1XUklUQUJMRSwgdHdvIGZ1cnRoZXIgYm91bmRzIGFwcGx5IHdoZW4gc2V0OlxuICogIC0gYG1heEJ5dGVzYCByZWZ1c2VzIGEgZmlsZSBvdmVyIHRoZSBjYXAgKGJ5IGl0cyBzdGF0LCBhbmQgYnkgYSByZWFkIHRoYXRcbiAqICAgIHN0b3BzIGF0IG1heEJ5dGVzKzEgc28gZ3Jvd3RoIGFmdGVyIHRoZSBzdGF0IGlzIGNhdWdodCB0b28pOyBhbmRcbiAqICAtIGBvcGVuVGltZW91dE1zYCBvcGVucyByZWFkLXdyaXRlIHRvIHByZXZlbnQgYSByYWNlZCBGSUZPIGZyb20gYmxvY2tpbmcgb25cbiAqICAgIFVuaXgsIGFuZCBzdG9wcyB3YWl0aW5nIGlmIHRoZSBvcGVuIGl0c2VsZiBzdGFsbHMuXG4gKlxuICogUmVzaWR1YWw6IGFuIG9wZW4gdGhhdCB0aW1lcyBvdXQgaXMgYWJhbmRvbmVkLCBub3QgY2FuY2VsbGVkLiBJZiBpdCBsYXRlclxuICogY29tcGxldGVzLCBpdHMgZGVzY3JpcHRvciBpcyBjbG9zZWQsIG5vdCB1c2VkLiBBIHBlbmRpbmcgb3BlbiBjYW4ga2VlcCB0aGVcbiAqIHByb2Nlc3MgYWxpdmU7IHRoZSBiYWJ5c2l0dGVyJ3Mgbm9uLXdhdGNoIGVudHJ5IHBvaW50IGV4cGxpY2l0bHkgZXhpdHMgYWZ0ZXJcbiAqIGl0cyBwYXNzLiBSZWFkLXdyaXRlIG9wZW5zIGFsc28gcmVxdWlyZSB3cml0ZSBwZXJtaXNzaW9uIG9uIHRoZSBmaWxlLlxuICpcbiAqIEFuIGFic2VudCBmaWxlIGlzIHJlcG9ydGVkIGFzIGEgYG51bGxgIHZhbHVlLCBub3QgYW4gZXJyb3Ig4oCUIGNhbGxlcnMgdGhhdFxuICogdHJlYXQgXCJtaXNzaW5nXCIgYXMgXCJlbXB0eVwiIGFzayBmb3IgdGhhdCBjYXNlIGV4cGxpY2l0bHkuXG4gKlxuICogQHBhcmFtIHRhcmdldEZpbGUgLSBQYXRoIHRvIHJlYWRcbiAqIEBwYXJhbSBvcHRpb25zIC0gT3B0aW9uYWwgc2l6ZSBjYXAsIG9wZW4gdGltZW91dCBhbmQgb3BlbiBzZWFtXG4gKiBAcmV0dXJucyBSZXN1bHQgd2l0aCB0aGUgZmlsZSdzIHRleHQsIG9yIGBudWxsYCB3aGVuIHRoZSBmaWxlIGlzIGFic2VudFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZFRleHRGaWxlTm9Gb2xsb3coXG4gIHRhcmdldEZpbGU6IHN0cmluZyxcbiAgb3B0aW9uczogUmVhZFRleHRGaWxlTm9Gb2xsb3dPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDxzdHJpbmcgfCBudWxsPj4ge1xuICBjb25zdCBmbiA9IFwicmVhZFRleHRGaWxlTm9Gb2xsb3dcIjtcbiAgY29uc3QgeyBtYXhCeXRlcywgb3BlblRpbWVvdXRNcywgb3BlbiA9IERlbm8ub3BlbiB9ID0gb3B0aW9ucztcbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCBsc3RhdE9yTnVsbCh0YXJnZXRGaWxlLCBmbik7XG4gIGlmICghZXhpc3Rpbmcub2spIHJldHVybiBleGlzdGluZztcbiAgaWYgKGV4aXN0aW5nLnZhbHVlID09PSBudWxsKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG51bGwgfTtcbiAgY29uc3QgcmVmdXNhbCA9IHJlZnVzZU5vblJlZ3VsYXIodGFyZ2V0RmlsZSwgZXhpc3RpbmcudmFsdWUsIGZuLCBcInJlYWRcIik7XG4gIGlmIChyZWZ1c2FsKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiByZWZ1c2FsIH07XG4gIGlmIChtYXhCeXRlcyAhPT0gdW5kZWZpbmVkICYmIGV4aXN0aW5nLnZhbHVlLnNpemUgPiBtYXhCeXRlcykge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgJHtmbn0g4oCUIGZpbGUgZXhjZWVkcyAke21heEJ5dGVzfSBieXRlczogJHt0YXJnZXRGaWxlfWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICBsZXQgZmlsZTogRGVuby5Gc0ZpbGU7XG4gIHRyeSB7XG4gICAgY29uc3Qgb3BlbmluZyA9IG9wZW4odGFyZ2V0RmlsZSwge1xuICAgICAgcmVhZDogdHJ1ZSxcbiAgICAgIC4uLihvcGVuVGltZW91dE1zID09PSB1bmRlZmluZWQgPyB7fSA6IHsgd3JpdGU6IHRydWUgfSksXG4gICAgfSk7XG4gICAgaWYgKG9wZW5UaW1lb3V0TXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZmlsZSA9IGF3YWl0IG9wZW5pbmc7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHdvbiA9IGF3YWl0IG9wZW5XaXRoaW4ob3BlbmluZywgb3BlblRpbWVvdXRNcyk7XG4gICAgICBpZiAod29uID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgJHtmbn0g4oCUIHRpbWVkIG91dCBvcGVuaW5nICR7dGFyZ2V0RmlsZX0gYWZ0ZXIgJHtvcGVuVGltZW91dE1zfW1zYCxcbiAgICAgICAgICApLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgZmlsZSA9IHdvbjtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgJHtmbn0g4oCUIGZhaWxlZCB0byBvcGVuIGZpbGU6ICR7dGFyZ2V0RmlsZX06ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBDbG9zZSB0aGUgbHN0YXTihpJvcGVuIHdpbmRvdzogYSBzaW5nbHktbGlua2VkIHJlZ3VsYXIgZGVzY3JpcHRvciBtdXN0XG4gICAgLy8gbWF0Y2ggYm90aCB0aGUgb3JpZ2luYWwgcGF0aCBpZGVudGl0eSBhbmQgdGhlIGZyZXNoIGxzdGF0LiBDb21wYXJpbmdcbiAgICAvLyBvbmx5IHRoZSBmcmVzaCBsc3RhdCB3b3VsZCBhY2NlcHQgYSByZXBsYWNlbWVudCByYWNlZCBpbiBiZWZvcmUgb3Blbi5cbiAgICBjb25zdCBvcGVuZWQgPSBhd2FpdCBmaWxlLnN0YXQoKTtcbiAgICBpZiAoIW9wZW5lZC5pc0ZpbGUpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBFcnJvcihgJHtmbn0g4oCUIHRhcmdldCBpcyBub3QgYSByZWd1bGFyIGZpbGU6ICR7dGFyZ2V0RmlsZX1gKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChvcGVuZWQubmxpbmsgIT09IG51bGwgJiYgb3BlbmVkLm5saW5rID4gMSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogbmV3IEVycm9yKGAke2ZufSDigJQgcmVmdXNpbmcgdG8gcmVhZCBhIGhhcmQgbGluazogJHt0YXJnZXRGaWxlfWApLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3QgY3VycmVudCA9IGF3YWl0IGxzdGF0T3JOdWxsKHRhcmdldEZpbGUsIGZuKTtcbiAgICBpZiAoIWN1cnJlbnQub2spIHJldHVybiBjdXJyZW50O1xuICAgIGNvbnN0IHN3YXBwZWQgPSBjdXJyZW50LnZhbHVlID09PSBudWxsIHx8IGN1cnJlbnQudmFsdWUuaXNTeW1saW5rIHx8XG4gICAgICAob3BlbmVkLmlubyAhPT0gbnVsbCAmJiBleGlzdGluZy52YWx1ZS5pbm8gIT09IG51bGwgJiZcbiAgICAgICAgb3BlbmVkLmlubyAhPT0gZXhpc3RpbmcudmFsdWUuaW5vKSB8fFxuICAgICAgKG9wZW5lZC5kZXYgIT09IG51bGwgJiYgZXhpc3RpbmcudmFsdWUuZGV2ICE9PSBudWxsICYmXG4gICAgICAgIG9wZW5lZC5kZXYgIT09IGV4aXN0aW5nLnZhbHVlLmRldikgfHxcbiAgICAgIChvcGVuZWQuaW5vICE9PSBudWxsICYmIGN1cnJlbnQudmFsdWUuaW5vICE9PSBudWxsICYmXG4gICAgICAgIG9wZW5lZC5pbm8gIT09IGN1cnJlbnQudmFsdWUuaW5vKSB8fFxuICAgICAgKG9wZW5lZC5kZXYgIT09IG51bGwgJiYgY3VycmVudC52YWx1ZS5kZXYgIT09IG51bGwgJiZcbiAgICAgICAgb3BlbmVkLmRldiAhPT0gY3VycmVudC52YWx1ZS5kZXYpO1xuICAgIGlmIChzd2FwcGVkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYCR7Zm59IOKAlCByZWZ1c2luZyB0byByZWFkIHRocm91Z2ggYSBzeW1saW5rOiAke3RhcmdldEZpbGV9YCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gQm91bmRlZDogcmVhZCBhdCBtb3N0IG1heEJ5dGVzKzEgc28gb25lIGV4dHJhIGJ5dGUgcHJvdmVzIFwib3ZlciBjYXBcIi5cbiAgICAvLyBVbmJvdW5kZWQ6IHRoZSBzdGF0IHNpemUsIGFzIGJlZm9yZS5cbiAgICBjb25zdCBidWZmZXIgPSBuZXcgVWludDhBcnJheShcbiAgICAgIG1heEJ5dGVzID09PSB1bmRlZmluZWQgPyBvcGVuZWQuc2l6ZSA6IG1heEJ5dGVzICsgMSxcbiAgICApO1xuICAgIGxldCByZWFkID0gMDtcbiAgICB3aGlsZSAocmVhZCA8IGJ1ZmZlci5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IG4gPSBhd2FpdCBmaWxlLnJlYWQoYnVmZmVyLnN1YmFycmF5KHJlYWQpKTtcbiAgICAgIGlmIChuID09PSBudWxsKSBicmVhaztcbiAgICAgIHJlYWQgKz0gbjtcbiAgICB9XG4gICAgaWYgKG1heEJ5dGVzICE9PSB1bmRlZmluZWQgJiYgcmVhZCA+IG1heEJ5dGVzKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgICAgYCR7Zm59IOKAlCBmaWxlIGV4Y2VlZHMgJHttYXhCeXRlc30gYnl0ZXM6ICR7dGFyZ2V0RmlsZX1gLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShidWZmZXIuc3ViYXJyYXkoMCwgcmVhZCkpLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgJHtmbn0g4oCUIGZhaWxlZCB0byByZWFkIGZpbGU6ICR7dGFyZ2V0RmlsZX06ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7XG4gICAgICBmaWxlLmNsb3NlKCk7XG4gICAgfSBjYXRjaCB7IC8qIGFscmVhZHkgY2xvc2VkICovIH1cbiAgfVxufVxuXG4vKipcbiAqIEF3YWl0IGFuIG9wZW4gZm9yIGF0IG1vc3QgYG1zYDogcmVzb2x2ZXMgdG8gdGhlIGZpbGUsIG9yIHRvIG51bGwgd2hlbiB0aGVcbiAqIHRpbWVyIHdpbnMuIEFuIG9wZW4gYWJhbmRvbmVkIGJ5IHRoZSB0aW1lciBpcyBjbG9zZWQgaWYgaXQgZXZlciBjb21wbGV0ZXMuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG9wZW5XaXRoaW4oXG4gIG9wZW5pbmc6IFByb21pc2U8RGVuby5Gc0ZpbGU+LFxuICBtczogbnVtYmVyLFxuKTogUHJvbWlzZTxEZW5vLkZzRmlsZSB8IG51bGw+IHtcbiAgY29uc3QgdGltZWRPdXQgPSBTeW1ib2woXCJ0aW1lZE91dFwiKTtcbiAgbGV0IHRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb25zdCB3aW5uZXIgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgb3BlbmluZyxcbiAgICAgIG5ldyBQcm9taXNlPHR5cGVvZiB0aW1lZE91dD4oKHJlc29sdmUpID0+IHtcbiAgICAgICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUodGltZWRPdXQpLCBtcyk7XG4gICAgICB9KSxcbiAgICBdKTtcbiAgICBpZiAod2lubmVyID09PSB0aW1lZE91dCkge1xuICAgICAgLy8gVGhlIGNhbGxlciBhbHJlYWR5IGhhcyB0aGUgdGltZW91dCBlcnJvcjsgdGhlIGFiYW5kb25lZCBkZXNjcmlwdG9yXG4gICAgICAvLyBtdXN0IG5vdCBsZWFrLCBzbyBjbG9zZSBpdCB3aGVuIHRoZSBvcGVuIGV2ZW50dWFsbHkgc2V0dGxlcy5cbiAgICAgIG9wZW5pbmcudGhlbigoZikgPT4gZi5jbG9zZSgpLCAoKSA9PiB7fSk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgcmV0dXJuIHdpbm5lcjtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICB9XG59XG5cbi8qKiBgbHN0YXRgIHRoZSBwYXRoLCByZXBvcnRpbmcgXCJhYnNlbnRcIiBhcyBhIG51bGwgdmFsdWUgcmF0aGVyIHRoYW4gYSB0aHJvdy4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxzdGF0T3JOdWxsKFxuICBwYXRoOiBzdHJpbmcsXG4gIGZuOiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlc3VsdDxEZW5vLkZpbGVJbmZvIHwgbnVsbD4+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IGF3YWl0IERlbm8ubHN0YXQocGF0aCkgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKGVyciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLk5vdEZvdW5kKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG51bGwgfTtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYCR7Zm59IOKAlCBmYWlsZWQgdG8gaW5zcGVjdCBwYXRoOiAke3BhdGh9OiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZnVzZSBhIHN5bWxpbmssIGEgaGFyZCBsaW5rLCBvciBhbnkgbm9uLXJlZ3VsYXIgZmlsZSBhbHJlYWR5IGF0IHRoZSBwYXRoLlxuICpcbiAqIEEgaGFyZCBsaW5rIGlzIHRoZSBzYW1lIGF0dGFjayB3aXRoIG5vIGxpbmsgdG8gbHN0YXQ6IHRoZSBieXRlcyBsYW5kIGluIOKAlCBvclxuICogY29tZSBmcm9tIOKAlCBzb21lb25lIGVsc2UncyBmaWxlIGp1c3QgYXMgdGhleSB3b3VsZCB0aHJvdWdoIGEgc3ltbGluaywgYW5kIGFcbiAqIGZpbGUgdGhpcyB3b3JrZXIgb3ducyBuZXZlciBoYXMgYSBzZWNvbmQgbmFtZS5cbiAqXG4gKiBgZm5gIG5hbWVzIHRoZSBjYWxsaW5nIHByaW1pdGl2ZSBhbmQgYHZlcmJgIHdoYXQgaXQgd2FzIGFib3V0IHRvIGRvLCBzbyB0aGVcbiAqIHJlZnVzYWwgcmVhZHMgYXMgdGhlIGNhbGxlcidzIG93biAoXCJyZWZ1c2luZyB0byBhcHBlbmQvcmVhZCB0aHJvdWdoIOKAplwiKS5cbiAqIFJldHVybnMgdGhlIHJlZnVzYWwgYXMgYW4gRXJyb3IsIG9yIG51bGwgd2hlbiB0aGUgcGF0aCBpcyBzYWZlIHRvIHVzZS5cbiAqL1xuZnVuY3Rpb24gcmVmdXNlTm9uUmVndWxhcihcbiAgcGF0aDogc3RyaW5nLFxuICBpbmZvOiBEZW5vLkZpbGVJbmZvIHwgbnVsbCxcbiAgZm46IHN0cmluZyxcbiAgdmVyYjogc3RyaW5nLFxuKTogRXJyb3IgfCBudWxsIHtcbiAgaWYgKGluZm8gPT09IG51bGwpIHJldHVybiBudWxsO1xuICBpZiAoaW5mby5pc1N5bWxpbmspIHtcbiAgICByZXR1cm4gbmV3IEVycm9yKGAke2ZufSDigJQgcmVmdXNpbmcgdG8gJHt2ZXJifSB0aHJvdWdoIGEgc3ltbGluazogJHtwYXRofWApO1xuICB9XG4gIGlmICghaW5mby5pc0ZpbGUpIHtcbiAgICByZXR1cm4gbmV3IEVycm9yKGAke2ZufSDigJQgdGFyZ2V0IGlzIG5vdCBhIHJlZ3VsYXIgZmlsZTogJHtwYXRofWApO1xuICB9XG4gIGlmIChpbmZvLm5saW5rICE9PSBudWxsICYmIGluZm8ubmxpbmsgPiAxKSB7XG4gICAgcmV0dXJuIG5ldyBFcnJvcihcbiAgICAgIGAke2ZufSDigJQgcmVmdXNpbmcgdG8gJHt2ZXJifSB0aHJvdWdoIGEgaGFyZCBsaW5rIGAgK1xuICAgICAgICBgKCR7aW5mby5ubGlua30gbmFtZXMpOiAke3BhdGh9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIFJlYWQgYSBmaWxlIHNhZmVseSwgcmV0dXJuaW5nIGVtcHR5IHN0cmluZyBpZiB0aGUgZmlsZSBkb2VzIG5vdCBleGlzdC5cbiAqXG4gKiBAcGFyYW0gZmlsZVBhdGggLSBQYXRoIHRvIHRoZSBmaWxlIHRvIHJlYWRcbiAqIEByZXR1cm5zIFJlc3VsdCBjb250YWluaW5nIHRoZSBmaWxlIGNvbnRlbnRzIG9yIGVtcHR5IHN0cmluZ1xuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2FmZVJlYWRGaWxlKFxuICBmaWxlUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8c3RyaW5nPj4ge1xuICB0cnkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShmaWxlUGF0aCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBjb250ZW50IH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmIChlcnIgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBcIlwiIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgICBgc2FmZVJlYWRGaWxlIOKAlCBmYWlsZWQgdG8gcmVhZCBmaWxlOiAke2ZpbGVQYXRofTogJHtcbiAgICAgICAgICAoZXJyIGFzIEVycm9yKS5tZXNzYWdlXG4gICAgICAgIH1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBaUJDLEdBSUQsMkVBQTJFLEdBQzNFLE1BQU0sb0JBQW9CO0FBcUIxQix1RUFBdUUsR0FDdkUsU0FBUyxjQUFjLE9BQTRCO0VBQ2pELE9BQU8sT0FBTyxZQUFZLFdBQ3RCLElBQUksY0FBYyxNQUFNLENBQUMsV0FDekI7QUFDTjtBQUVBOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sZUFBZSxZQUNwQixPQUEyQjtFQUUzQixNQUFNLEVBQUUsVUFBVSxFQUFFLE9BQU8sRUFBRSxPQUFPLGlCQUFpQixFQUFFLEdBQUc7RUFFMUQsc0NBQXNDO0VBQ3RDLE1BQU0sWUFBWSxXQUFXLFNBQVMsQ0FDcEMsR0FDQSxXQUFXLFdBQVcsQ0FBQztFQUd6QixpQ0FBaUM7RUFDakMsSUFBSTtJQUNGLE1BQU0sT0FBTyxNQUFNLEtBQUssSUFBSSxDQUFDO0lBQzdCLElBQUksQ0FBQyxLQUFLLFdBQVcsRUFBRTtNQUNyQixPQUFPO1FBQ0wsSUFBSTtRQUNKLE9BQU8sSUFBSSxNQUNULENBQUMsOENBQThDLEVBQUUsV0FBVztNQUVoRTtJQUNGO0VBQ0YsRUFBRSxPQUFNO0lBQ04sT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLElBQUksTUFDVCxDQUFDLCtDQUErQyxFQUFFLFdBQVc7SUFFakU7RUFDRjtFQUVBLHFFQUFxRTtFQUNyRSx3RUFBd0U7RUFDeEUsOERBQThEO0VBQzlELGlFQUFpRTtFQUNqRSxxQkFBcUI7RUFDckIsb0VBQW9FO0VBQ3BFLG9EQUFvRDtFQUNwRCxrRUFBa0U7RUFDbEUscUVBQXFFO0VBQ3JFLDJEQUEyRDtFQUMzRCxNQUFNLFVBQVUsUUFBUSxPQUFPLEtBQUssWUFDaEMsYUFDQSxHQUFHLFFBQVEsT0FBTyxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksQ0FBQyxFQUN4QyxXQUFXLEtBQUssQ0FBQyxXQUFXLFdBQVcsQ0FBQyxP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
// denoCacheMetadata=4239478817077930095,16177555319540701226