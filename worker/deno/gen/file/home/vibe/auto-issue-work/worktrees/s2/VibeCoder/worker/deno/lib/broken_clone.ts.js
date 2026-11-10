/**
 * Discard a clone directory that holds no git repository (Issue #2848).
 *
 * An interrupted clone, or a `.git` left corrupt, leaves `${workDir}/<repo>`
 * behind as a plain directory. It passed every "already cloned" check, so each
 * run then failed at setup with git's `not a git repository (or any parent up
 * to mount point …) / Stopping at filesystem boundary` — permanently, because
 * nothing ever re-cloned it.
 *
 * Only a directory git positively reports as "not a git repository" is
 * removed; a probe that could not run fails loud and removes nothing.
 * Discovery is fenced at the parent directory (`GIT_CEILING_DIRECTORIES`) so
 * an enclosing repository cannot vouch for a clone that has none of its own.
 *
 * Australian English spelling used throughout.
 */ import { runGitCommand } from "./git_timeout.ts";
import { isCloneCorruption } from "./corrupt_clone_recovery.ts";
/**
 * Remove `repoPath` when it is a directory holding no git repository.
 *
 * @returns `ok(true)` when a broken clone was removed, `ok(false)` when there
 *   was nothing to discard (missing path, or a real repository).
 */ export async function discardBrokenClone(repoPath) {
  try {
    if (!(await Deno.stat(repoPath)).isDirectory) {
      return {
        ok: true,
        value: false
      };
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        ok: true,
        value: false
      };
    }
    return {
      ok: false,
      error: new Error(`Could not inspect ${repoPath}: ${error}`)
    };
  }
  const ownershipError = await checkCloneOwnership(repoPath, undefined, undefined, true);
  if (ownershipError) return {
    ok: false,
    error: new Error(ownershipError)
  };
  const probe = await runGitCommand([
    "rev-parse",
    "--git-dir"
  ], {
    cwd: repoPath,
    env: {
      GIT_CEILING_DIRECTORIES: parentDirectory(repoPath)
    }
  });
  if (!probe.ok) {
    return {
      ok: false,
      error: new Error(`Could not check whether ${repoPath} is a git repository: ${probe.error.message}`)
    };
  }
  const notARepository = probe.value.code !== 0 && /not a git repository/i.test(probe.value.stderr);
  if (!notARepository) return {
    ok: true,
    value: false
  };
  console.warn(`[setup-repo] ${repoPath} holds no git repository (${probe.value.stderr.trim()}) — removing it so it is cloned afresh (Issue #2848)`);
  try {
    await Deno.remove(repoPath, {
      recursive: true
    });
  } catch (error) {
    return {
      ok: false,
      error: new Error(`Could not remove the broken clone at ${repoPath}: ${error}`)
    };
  }
  return {
    ok: true,
    value: true
  };
}
/**
 * Probe an existing clone; returns git's stderr (trimmed) when it reports
 * clone corruption, else null.
 */ export async function probeCorruptClone(repoPath) {
  try {
    if (!(await Deno.stat(repoPath)).isDirectory) {
      return null;
    }
  } catch  {
    return null;
  }
  const ownershipError = await checkCloneOwnership(repoPath, undefined, undefined, true);
  if (ownershipError) throw new Error(ownershipError);
  const probe = await runGitCommand([
    "rev-parse",
    "--git-dir"
  ], {
    cwd: repoPath,
    env: {
      GIT_CEILING_DIRECTORIES: parentDirectory(repoPath)
    }
  });
  if (!probe.ok) return null;
  if (probe.value.code === 0) return null;
  const stderr = probe.value.stderr.trim();
  return isCloneCorruption(stderr) ? stderr : null;
}
/** The directory holding `path` — no `@std/path` in this import map. */ function parentDirectory(path) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : "/";
}
/** Refuse to run git in a clone supplied by another account (Issue #4737). */ export async function checkCloneOwnership(path, uidProbe = async ()=>{
  const result = await new Deno.Command("id", {
    args: [
      "-u"
    ],
    signal: AbortSignal.timeout(5_000)
  }).output();
  const output = new TextDecoder().decode(result.stdout).trim();
  const uid = Number(output);
  if (!result.success || !/^\d+$/.test(output) || !Number.isSafeInteger(uid)) {
    throw new Error("could not determine worker uid");
  }
  return uid;
}, lstat = Deno.lstat, requireRoot = false, requireGit = false) {
  try {
    let root;
    try {
      root = await lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return requireRoot ? `Refusing missing clone path ${path}` : null;
      }
      throw error;
    }
    const uid = await uidProbe();
    if (!root.isDirectory || root.uid === null || root.uid !== uid) {
      return `Refusing untrusted clone path ${path}: root is not owned by worker uid ${uid}`;
    }
    let git;
    try {
      git = await lstat(`${path}/.git`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return requireGit ? `Refusing missing .git at ${path}` : null;
      }
      throw error;
    }
    if (git.isSymlink || git.uid === null || git.uid !== uid) {
      return `Refusing untrusted clone path ${path}: .git is not owned by worker uid ${uid} or is a symlink`;
    }
    return null;
  } catch (error) {
    return `Could not check clone ownership at ${path}: ${error}`;
  }
}
/** Skip missing or untrusted clones before milestone maintenance runs git. */ export async function trustedLocalCloneExists(path, warn) {
  const refusal = await checkCloneOwnership(path);
  if (refusal) {
    warn(refusal);
    return false;
  }
  try {
    const info = await Deno.lstat(`${path}/.git`);
    return info.isDirectory || info.isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    warn(`Could not inspect clone at ${path}: ${error}`);
    return false;
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9icm9rZW5fY2xvbmUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEaXNjYXJkIGEgY2xvbmUgZGlyZWN0b3J5IHRoYXQgaG9sZHMgbm8gZ2l0IHJlcG9zaXRvcnkgKElzc3VlICMyODQ4KS5cbiAqXG4gKiBBbiBpbnRlcnJ1cHRlZCBjbG9uZSwgb3IgYSBgLmdpdGAgbGVmdCBjb3JydXB0LCBsZWF2ZXMgYCR7d29ya0Rpcn0vPHJlcG8+YFxuICogYmVoaW5kIGFzIGEgcGxhaW4gZGlyZWN0b3J5LiBJdCBwYXNzZWQgZXZlcnkgXCJhbHJlYWR5IGNsb25lZFwiIGNoZWNrLCBzbyBlYWNoXG4gKiBydW4gdGhlbiBmYWlsZWQgYXQgc2V0dXAgd2l0aCBnaXQncyBgbm90IGEgZ2l0IHJlcG9zaXRvcnkgKG9yIGFueSBwYXJlbnQgdXBcbiAqIHRvIG1vdW50IHBvaW50IOKApikgLyBTdG9wcGluZyBhdCBmaWxlc3lzdGVtIGJvdW5kYXJ5YCDigJQgcGVybWFuZW50bHksIGJlY2F1c2VcbiAqIG5vdGhpbmcgZXZlciByZS1jbG9uZWQgaXQuXG4gKlxuICogT25seSBhIGRpcmVjdG9yeSBnaXQgcG9zaXRpdmVseSByZXBvcnRzIGFzIFwibm90IGEgZ2l0IHJlcG9zaXRvcnlcIiBpc1xuICogcmVtb3ZlZDsgYSBwcm9iZSB0aGF0IGNvdWxkIG5vdCBydW4gZmFpbHMgbG91ZCBhbmQgcmVtb3ZlcyBub3RoaW5nLlxuICogRGlzY292ZXJ5IGlzIGZlbmNlZCBhdCB0aGUgcGFyZW50IGRpcmVjdG9yeSAoYEdJVF9DRUlMSU5HX0RJUkVDVE9SSUVTYCkgc29cbiAqIGFuIGVuY2xvc2luZyByZXBvc2l0b3J5IGNhbm5vdCB2b3VjaCBmb3IgYSBjbG9uZSB0aGF0IGhhcyBub25lIG9mIGl0cyBvd24uXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dC5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgcnVuR2l0Q29tbWFuZCB9IGZyb20gXCIuL2dpdF90aW1lb3V0LnRzXCI7XG5pbXBvcnQgeyBpc0Nsb25lQ29ycnVwdGlvbiB9IGZyb20gXCIuL2NvcnJ1cHRfY2xvbmVfcmVjb3ZlcnkudHNcIjtcblxuLyoqXG4gKiBSZW1vdmUgYHJlcG9QYXRoYCB3aGVuIGl0IGlzIGEgZGlyZWN0b3J5IGhvbGRpbmcgbm8gZ2l0IHJlcG9zaXRvcnkuXG4gKlxuICogQHJldHVybnMgYG9rKHRydWUpYCB3aGVuIGEgYnJva2VuIGNsb25lIHdhcyByZW1vdmVkLCBgb2soZmFsc2UpYCB3aGVuIHRoZXJlXG4gKiAgIHdhcyBub3RoaW5nIHRvIGRpc2NhcmQgKG1pc3NpbmcgcGF0aCwgb3IgYSByZWFsIHJlcG9zaXRvcnkpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGlzY2FyZEJyb2tlbkNsb25lKFxuICByZXBvUGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZXN1bHQ8Ym9vbGVhbj4+IHtcbiAgdHJ5IHtcbiAgICBpZiAoIShhd2FpdCBEZW5vLnN0YXQocmVwb1BhdGgpKS5pc0RpcmVjdG9yeSkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBmYWxzZSB9O1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkge1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBmYWxzZSB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihgQ291bGQgbm90IGluc3BlY3QgJHtyZXBvUGF0aH06ICR7ZXJyb3J9YCksXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IG93bmVyc2hpcEVycm9yID0gYXdhaXQgY2hlY2tDbG9uZU93bmVyc2hpcChcbiAgICByZXBvUGF0aCxcbiAgICB1bmRlZmluZWQsXG4gICAgdW5kZWZpbmVkLFxuICAgIHRydWUsXG4gICk7XG4gIGlmIChvd25lcnNoaXBFcnJvcikgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogbmV3IEVycm9yKG93bmVyc2hpcEVycm9yKSB9O1xuICBjb25zdCBwcm9iZSA9IGF3YWl0IHJ1bkdpdENvbW1hbmQoW1wicmV2LXBhcnNlXCIsIFwiLS1naXQtZGlyXCJdLCB7XG4gICAgY3dkOiByZXBvUGF0aCxcbiAgICBlbnY6IHsgR0lUX0NFSUxJTkdfRElSRUNUT1JJRVM6IHBhcmVudERpcmVjdG9yeShyZXBvUGF0aCkgfSxcbiAgfSk7XG4gIGlmICghcHJvYmUub2spIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZXJyb3I6IG5ldyBFcnJvcihcbiAgICAgICAgYENvdWxkIG5vdCBjaGVjayB3aGV0aGVyICR7cmVwb1BhdGh9IGlzIGEgZ2l0IHJlcG9zaXRvcnk6ICR7cHJvYmUuZXJyb3IubWVzc2FnZX1gLFxuICAgICAgKSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IG5vdEFSZXBvc2l0b3J5ID0gcHJvYmUudmFsdWUuY29kZSAhPT0gMCAmJlxuICAgIC9ub3QgYSBnaXQgcmVwb3NpdG9yeS9pLnRlc3QocHJvYmUudmFsdWUuc3RkZXJyKTtcbiAgaWYgKCFub3RBUmVwb3NpdG9yeSkgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiBmYWxzZSB9O1xuXG4gIGNvbnNvbGUud2FybihcbiAgICBgW3NldHVwLXJlcG9dICR7cmVwb1BhdGh9IGhvbGRzIG5vIGdpdCByZXBvc2l0b3J5ICgke3Byb2JlLnZhbHVlLnN0ZGVyci50cmltKCl9KSDigJQgcmVtb3ZpbmcgaXQgc28gaXQgaXMgY2xvbmVkIGFmcmVzaCAoSXNzdWUgIzI4NDgpYCxcbiAgKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyZXBvUGF0aCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBuZXcgRXJyb3IoXG4gICAgICAgIGBDb3VsZCBub3QgcmVtb3ZlIHRoZSBicm9rZW4gY2xvbmUgYXQgJHtyZXBvUGF0aH06ICR7ZXJyb3J9YCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHRydWUgfTtcbn1cblxuLyoqXG4gKiBQcm9iZSBhbiBleGlzdGluZyBjbG9uZTsgcmV0dXJucyBnaXQncyBzdGRlcnIgKHRyaW1tZWQpIHdoZW4gaXQgcmVwb3J0c1xuICogY2xvbmUgY29ycnVwdGlvbiwgZWxzZSBudWxsLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJvYmVDb3JydXB0Q2xvbmUoXG4gIHJlcG9QYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBpZiAoIShhd2FpdCBEZW5vLnN0YXQocmVwb1BhdGgpKS5pc0RpcmVjdG9yeSkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IG93bmVyc2hpcEVycm9yID0gYXdhaXQgY2hlY2tDbG9uZU93bmVyc2hpcChcbiAgICByZXBvUGF0aCxcbiAgICB1bmRlZmluZWQsXG4gICAgdW5kZWZpbmVkLFxuICAgIHRydWUsXG4gICk7XG4gIGlmIChvd25lcnNoaXBFcnJvcikgdGhyb3cgbmV3IEVycm9yKG93bmVyc2hpcEVycm9yKTtcbiAgY29uc3QgcHJvYmUgPSBhd2FpdCBydW5HaXRDb21tYW5kKFtcInJldi1wYXJzZVwiLCBcIi0tZ2l0LWRpclwiXSwge1xuICAgIGN3ZDogcmVwb1BhdGgsXG4gICAgZW52OiB7IEdJVF9DRUlMSU5HX0RJUkVDVE9SSUVTOiBwYXJlbnREaXJlY3RvcnkocmVwb1BhdGgpIH0sXG4gIH0pO1xuICBpZiAoIXByb2JlLm9rKSByZXR1cm4gbnVsbDtcbiAgaWYgKHByb2JlLnZhbHVlLmNvZGUgPT09IDApIHJldHVybiBudWxsO1xuICBjb25zdCBzdGRlcnIgPSBwcm9iZS52YWx1ZS5zdGRlcnIudHJpbSgpO1xuICByZXR1cm4gaXNDbG9uZUNvcnJ1cHRpb24oc3RkZXJyKSA/IHN0ZGVyciA6IG51bGw7XG59XG5cbi8qKiBUaGUgZGlyZWN0b3J5IGhvbGRpbmcgYHBhdGhgIOKAlCBubyBgQHN0ZC9wYXRoYCBpbiB0aGlzIGltcG9ydCBtYXAuICovXG5mdW5jdGlvbiBwYXJlbnREaXJlY3RvcnkocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IHBhdGgucmVwbGFjZSgvW1xcXFwvXSskLywgXCJcIik7XG4gIGNvbnN0IGN1dCA9IE1hdGgubWF4KHRyaW1tZWQubGFzdEluZGV4T2YoXCIvXCIpLCB0cmltbWVkLmxhc3RJbmRleE9mKFwiXFxcXFwiKSk7XG4gIHJldHVybiBjdXQgPiAwID8gdHJpbW1lZC5zbGljZSgwLCBjdXQpIDogXCIvXCI7XG59XG5cbi8qKiBSZWZ1c2UgdG8gcnVuIGdpdCBpbiBhIGNsb25lIHN1cHBsaWVkIGJ5IGFub3RoZXIgYWNjb3VudCAoSXNzdWUgIzQ3MzcpLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrQ2xvbmVPd25lcnNoaXAoXG4gIHBhdGg6IHN0cmluZyxcbiAgdWlkUHJvYmU6ICgpID0+IFByb21pc2U8bnVtYmVyPiA9IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBuZXcgRGVuby5Db21tYW5kKFwiaWRcIiwge1xuICAgICAgYXJnczogW1wiLXVcIl0sXG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNV8wMDApLFxuICAgIH0pLm91dHB1dCgpO1xuICAgIGNvbnN0IG91dHB1dCA9IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShyZXN1bHQuc3Rkb3V0KS50cmltKCk7XG4gICAgY29uc3QgdWlkID0gTnVtYmVyKG91dHB1dCk7XG4gICAgaWYgKFxuICAgICAgIXJlc3VsdC5zdWNjZXNzIHx8ICEvXlxcZCskLy50ZXN0KG91dHB1dCkgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHVpZClcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImNvdWxkIG5vdCBkZXRlcm1pbmUgd29ya2VyIHVpZFwiKTtcbiAgICB9XG4gICAgcmV0dXJuIHVpZDtcbiAgfSxcbiAgbHN0YXQ6IChwYXRoOiBzdHJpbmcpID0+IFByb21pc2U8RGVuby5GaWxlSW5mbz4gPSBEZW5vLmxzdGF0LFxuICByZXF1aXJlUm9vdCA9IGZhbHNlLFxuICByZXF1aXJlR2l0ID0gZmFsc2UsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBsZXQgcm9vdDogRGVuby5GaWxlSW5mbztcbiAgICB0cnkge1xuICAgICAgcm9vdCA9IGF3YWl0IGxzdGF0KHBhdGgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkge1xuICAgICAgICByZXR1cm4gcmVxdWlyZVJvb3QgPyBgUmVmdXNpbmcgbWlzc2luZyBjbG9uZSBwYXRoICR7cGF0aH1gIDogbnVsbDtcbiAgICAgIH1cbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cbiAgICBjb25zdCB1aWQgPSBhd2FpdCB1aWRQcm9iZSgpO1xuICAgIGlmICghcm9vdC5pc0RpcmVjdG9yeSB8fCByb290LnVpZCA9PT0gbnVsbCB8fCByb290LnVpZCAhPT0gdWlkKSB7XG4gICAgICByZXR1cm4gYFJlZnVzaW5nIHVudHJ1c3RlZCBjbG9uZSBwYXRoICR7cGF0aH06IHJvb3QgaXMgbm90IG93bmVkIGJ5IHdvcmtlciB1aWQgJHt1aWR9YDtcbiAgICB9XG4gICAgbGV0IGdpdDogRGVuby5GaWxlSW5mbztcbiAgICB0cnkge1xuICAgICAgZ2l0ID0gYXdhaXQgbHN0YXQoYCR7cGF0aH0vLmdpdGApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkge1xuICAgICAgICByZXR1cm4gcmVxdWlyZUdpdCA/IGBSZWZ1c2luZyBtaXNzaW5nIC5naXQgYXQgJHtwYXRofWAgOiBudWxsO1xuICAgICAgfVxuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuICAgIGlmIChnaXQuaXNTeW1saW5rIHx8IGdpdC51aWQgPT09IG51bGwgfHwgZ2l0LnVpZCAhPT0gdWlkKSB7XG4gICAgICByZXR1cm4gYFJlZnVzaW5nIHVudHJ1c3RlZCBjbG9uZSBwYXRoICR7cGF0aH06IC5naXQgaXMgbm90IG93bmVkIGJ5IHdvcmtlciB1aWQgJHt1aWR9IG9yIGlzIGEgc3ltbGlua2A7XG4gICAgfVxuICAgIHJldHVybiBudWxsO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBgQ291bGQgbm90IGNoZWNrIGNsb25lIG93bmVyc2hpcCBhdCAke3BhdGh9OiAke2Vycm9yfWA7XG4gIH1cbn1cblxuLyoqIFNraXAgbWlzc2luZyBvciB1bnRydXN0ZWQgY2xvbmVzIGJlZm9yZSBtaWxlc3RvbmUgbWFpbnRlbmFuY2UgcnVucyBnaXQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdHJ1c3RlZExvY2FsQ2xvbmVFeGlzdHMoXG4gIHBhdGg6IHN0cmluZyxcbiAgd2FybjogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZCxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCByZWZ1c2FsID0gYXdhaXQgY2hlY2tDbG9uZU93bmVyc2hpcChwYXRoKTtcbiAgaWYgKHJlZnVzYWwpIHtcbiAgICB3YXJuKHJlZnVzYWwpO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IGluZm8gPSBhd2FpdCBEZW5vLmxzdGF0KGAke3BhdGh9Ly5naXRgKTtcbiAgICByZXR1cm4gaW5mby5pc0RpcmVjdG9yeSB8fCBpbmZvLmlzRmlsZTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIGZhbHNlO1xuICAgIHdhcm4oYENvdWxkIG5vdCBpbnNwZWN0IGNsb25lIGF0ICR7cGF0aH06ICR7ZXJyb3J9YCk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7OztDQWVDLEdBR0QsU0FBUyxhQUFhLFFBQVEsbUJBQW1CO0FBQ2pELFNBQVMsaUJBQWlCLFFBQVEsOEJBQThCO0FBRWhFOzs7OztDQUtDLEdBQ0QsT0FBTyxlQUFlLG1CQUNwQixRQUFnQjtFQUVoQixJQUFJO0lBQ0YsSUFBSSxDQUFDLENBQUMsTUFBTSxLQUFLLElBQUksQ0FBQyxTQUFTLEVBQUUsV0FBVyxFQUFFO01BQzVDLE9BQU87UUFBRSxJQUFJO1FBQU0sT0FBTztNQUFNO0lBQ2xDO0VBQ0YsRUFBRSxPQUFPLE9BQU87SUFDZCxJQUFJLGlCQUFpQixLQUFLLE1BQU0sQ0FBQyxRQUFRLEVBQUU7TUFDekMsT0FBTztRQUFFLElBQUk7UUFBTSxPQUFPO01BQU07SUFDbEM7SUFDQSxPQUFPO01BQ0wsSUFBSTtNQUNKLE9BQU8sSUFBSSxNQUFNLENBQUMsa0JBQWtCLEVBQUUsU0FBUyxFQUFFLEVBQUUsT0FBTztJQUM1RDtFQUNGO0VBRUEsTUFBTSxpQkFBaUIsTUFBTSxvQkFDM0IsVUFDQSxXQUNBLFdBQ0E7RUFFRixJQUFJLGdCQUFnQixPQUFPO0lBQUUsSUFBSTtJQUFPLE9BQU8sSUFBSSxNQUFNO0VBQWdCO0VBQ3pFLE1BQU0sUUFBUSxNQUFNLGNBQWM7SUFBQztJQUFhO0dBQVksRUFBRTtJQUM1RCxLQUFLO0lBQ0wsS0FBSztNQUFFLHlCQUF5QixnQkFBZ0I7SUFBVTtFQUM1RDtFQUNBLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRTtJQUNiLE9BQU87TUFDTCxJQUFJO01BQ0osT0FBTyxJQUFJLE1BQ1QsQ0FBQyx3QkFBd0IsRUFBRSxTQUFTLHNCQUFzQixFQUFFLE1BQU0sS0FBSyxDQUFDLE9BQU8sRUFBRTtJQUVyRjtFQUNGO0VBQ0EsTUFBTSxpQkFBaUIsTUFBTSxLQUFLLENBQUMsSUFBSSxLQUFLLEtBQzFDLHdCQUF3QixJQUFJLENBQUMsTUFBTSxLQUFLLENBQUMsTUFBTTtFQUNqRCxJQUFJLENBQUMsZ0JBQWdCLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztFQUFNO0VBRXJELFFBQVEsSUFBSSxDQUNWLENBQUMsYUFBYSxFQUFFLFNBQVMsMEJBQTBCLEVBQUUsTUFBTSxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksR0FBRyxvREFBb0QsQ0FBQztFQUV0SSxJQUFJO0lBQ0YsTUFBTSxLQUFLLE1BQU0sQ0FBQyxVQUFVO01BQUUsV0FBVztJQUFLO0VBQ2hELEVBQUUsT0FBTyxPQUFPO0lBQ2QsT0FBTztNQUNMLElBQUk7TUFDSixPQUFPLElBQUksTUFDVCxDQUFDLHFDQUFxQyxFQUFFLFNBQVMsRUFBRSxFQUFFLE9BQU87SUFFaEU7RUFDRjtFQUNBLE9BQU87SUFBRSxJQUFJO0lBQU0sT0FBTztFQUFLO0FBQ2pDO0FBRUE7OztDQUdDLEdBQ0QsT0FBTyxlQUFlLGtCQUNwQixRQUFnQjtFQUVoQixJQUFJO0lBQ0YsSUFBSSxDQUFDLENBQUMsTUFBTSxLQUFLLElBQUksQ0FBQyxTQUFTLEVBQUUsV0FBVyxFQUFFO01BQzVDLE9BQU87SUFDVDtFQUNGLEVBQUUsT0FBTTtJQUNOLE9BQU87RUFDVDtFQUVBLE1BQU0saUJBQWlCLE1BQU0sb0JBQzNCLFVBQ0EsV0FDQSxXQUNBO0VBRUYsSUFBSSxnQkFBZ0IsTUFBTSxJQUFJLE1BQU07RUFDcEMsTUFBTSxRQUFRLE1BQU0sY0FBYztJQUFDO0lBQWE7R0FBWSxFQUFFO0lBQzVELEtBQUs7SUFDTCxLQUFLO01BQUUseUJBQXlCLGdCQUFnQjtJQUFVO0VBQzVEO0VBQ0EsSUFBSSxDQUFDLE1BQU0sRUFBRSxFQUFFLE9BQU87RUFDdEIsSUFBSSxNQUFNLEtBQUssQ0FBQyxJQUFJLEtBQUssR0FBRyxPQUFPO0VBQ25DLE1BQU0sU0FBUyxNQUFNLEtBQUssQ0FBQyxNQUFNLENBQUMsSUFBSTtFQUN0QyxPQUFPLGtCQUFrQixVQUFVLFNBQVM7QUFDOUM7QUFFQSxzRUFBc0UsR0FDdEUsU0FBUyxnQkFBZ0IsSUFBWTtFQUNuQyxNQUFNLFVBQVUsS0FBSyxPQUFPLENBQUMsV0FBVztFQUN4QyxNQUFNLE1BQU0sS0FBSyxHQUFHLENBQUMsUUFBUSxXQUFXLENBQUMsTUFBTSxRQUFRLFdBQVcsQ0FBQztFQUNuRSxPQUFPLE1BQU0sSUFBSSxRQUFRLEtBQUssQ0FBQyxHQUFHLE9BQU87QUFDM0M7QUFFQSw0RUFBNEUsR0FDNUUsT0FBTyxlQUFlLG9CQUNwQixJQUFZLEVBQ1osV0FBa0M7RUFDaEMsTUFBTSxTQUFTLE1BQU0sSUFBSSxLQUFLLE9BQU8sQ0FBQyxNQUFNO0lBQzFDLE1BQU07TUFBQztLQUFLO0lBQ1osUUFBUSxZQUFZLE9BQU8sQ0FBQztFQUM5QixHQUFHLE1BQU07RUFDVCxNQUFNLFNBQVMsSUFBSSxjQUFjLE1BQU0sQ0FBQyxPQUFPLE1BQU0sRUFBRSxJQUFJO0VBQzNELE1BQU0sTUFBTSxPQUFPO0VBQ25CLElBQ0UsQ0FBQyxPQUFPLE9BQU8sSUFBSSxDQUFDLFFBQVEsSUFBSSxDQUFDLFdBQVcsQ0FBQyxPQUFPLGFBQWEsQ0FBQyxNQUNsRTtJQUNBLE1BQU0sSUFBSSxNQUFNO0VBQ2xCO0VBQ0EsT0FBTztBQUNULENBQUMsRUFDRCxRQUFrRCxLQUFLLEtBQUssRUFDNUQsY0FBYyxLQUFLLEVBQ25CLGFBQWEsS0FBSztFQUVsQixJQUFJO0lBQ0YsSUFBSTtJQUNKLElBQUk7TUFDRixPQUFPLE1BQU0sTUFBTTtJQUNyQixFQUFFLE9BQU8sT0FBTztNQUNkLElBQUksaUJBQWlCLEtBQUssTUFBTSxDQUFDLFFBQVEsRUFBRTtRQUN6QyxPQUFPLGNBQWMsQ0FBQyw0QkFBNEIsRUFBRSxNQUFNLEdBQUc7TUFDL0Q7TUFDQSxNQUFNO0lBQ1I7SUFDQSxNQUFNLE1BQU0sTUFBTTtJQUNsQixJQUFJLENBQUMsS0FBSyxXQUFXLElBQUksS0FBSyxHQUFHLEtBQUssUUFBUSxLQUFLLEdBQUcsS0FBSyxLQUFLO01BQzlELE9BQU8sQ0FBQyw4QkFBOEIsRUFBRSxLQUFLLGtDQUFrQyxFQUFFLEtBQUs7SUFDeEY7SUFDQSxJQUFJO0lBQ0osSUFBSTtNQUNGLE1BQU0sTUFBTSxNQUFNLEdBQUcsS0FBSyxLQUFLLENBQUM7SUFDbEMsRUFBRSxPQUFPLE9BQU87TUFDZCxJQUFJLGlCQUFpQixLQUFLLE1BQU0sQ0FBQyxRQUFRLEVBQUU7UUFDekMsT0FBTyxhQUFhLENBQUMseUJBQXlCLEVBQUUsTUFBTSxHQUFHO01BQzNEO01BQ0EsTUFBTTtJQUNSO0lBQ0EsSUFBSSxJQUFJLFNBQVMsSUFBSSxJQUFJLEdBQUcsS0FBSyxRQUFRLElBQUksR0FBRyxLQUFLLEtBQUs7TUFDeEQsT0FBTyxDQUFDLDhCQUE4QixFQUFFLEtBQUssa0NBQWtDLEVBQUUsSUFBSSxnQkFBZ0IsQ0FBQztJQUN4RztJQUNBLE9BQU87RUFDVCxFQUFFLE9BQU8sT0FBTztJQUNkLE9BQU8sQ0FBQyxtQ0FBbUMsRUFBRSxLQUFLLEVBQUUsRUFBRSxPQUFPO0VBQy9EO0FBQ0Y7QUFFQSw0RUFBNEUsR0FDNUUsT0FBTyxlQUFlLHdCQUNwQixJQUFZLEVBQ1osSUFBK0I7RUFFL0IsTUFBTSxVQUFVLE1BQU0sb0JBQW9CO0VBQzFDLElBQUksU0FBUztJQUNYLEtBQUs7SUFDTCxPQUFPO0VBQ1Q7RUFDQSxJQUFJO0lBQ0YsTUFBTSxPQUFPLE1BQU0sS0FBSyxLQUFLLENBQUMsR0FBRyxLQUFLLEtBQUssQ0FBQztJQUM1QyxPQUFPLEtBQUssV0FBVyxJQUFJLEtBQUssTUFBTTtFQUN4QyxFQUFFLE9BQU8sT0FBTztJQUNkLElBQUksaUJBQWlCLEtBQUssTUFBTSxDQUFDLFFBQVEsRUFBRSxPQUFPO0lBQ2xELEtBQUssQ0FBQywyQkFBMkIsRUFBRSxLQUFLLEVBQUUsRUFBRSxPQUFPO0lBQ25ELE9BQU87RUFDVDtBQUNGIn0=
// denoCacheMetadata=1972865561087195552,5398966455947262581