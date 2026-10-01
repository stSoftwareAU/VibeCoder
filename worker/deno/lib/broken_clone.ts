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
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import { isCloneCorruption } from "./corrupt_clone_recovery.ts";

/**
 * Remove `repoPath` when it is a directory holding no git repository.
 *
 * @returns `ok(true)` when a broken clone was removed, `ok(false)` when there
 *   was nothing to discard (missing path, or a real repository).
 */
export async function discardBrokenClone(
  repoPath: string,
): Promise<Result<boolean>> {
  try {
    if (!(await Deno.stat(repoPath)).isDirectory) {
      return { ok: true, value: false };
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { ok: true, value: false };
    }
    return {
      ok: false,
      error: new Error(`Could not inspect ${repoPath}: ${error}`),
    };
  }

  const probe = await runGitCommand(["rev-parse", "--git-dir"], {
    cwd: repoPath,
    env: { GIT_CEILING_DIRECTORIES: parentDirectory(repoPath) },
  });
  if (!probe.ok) {
    return {
      ok: false,
      error: new Error(
        `Could not check whether ${repoPath} is a git repository: ${probe.error.message}`,
      ),
    };
  }
  const notARepository = probe.value.code !== 0 &&
    /not a git repository/i.test(probe.value.stderr);
  if (!notARepository) return { ok: true, value: false };

  console.warn(
    `[setup-repo] ${repoPath} holds no git repository (${probe.value.stderr.trim()}) — removing it so it is cloned afresh (Issue #2848)`,
  );
  try {
    await Deno.remove(repoPath, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `Could not remove the broken clone at ${repoPath}: ${error}`,
      ),
    };
  }
  return { ok: true, value: true };
}

/**
 * Probe an existing clone; returns git's stderr (trimmed) when it reports
 * clone corruption, else null.
 */
export async function probeCorruptClone(
  repoPath: string,
): Promise<string | null> {
  try {
    if (!(await Deno.stat(repoPath)).isDirectory) {
      return null;
    }
  } catch {
    return null;
  }

  const probe = await runGitCommand(["rev-parse", "--git-dir"], {
    cwd: repoPath,
    env: { GIT_CEILING_DIRECTORIES: parentDirectory(repoPath) },
  });
  if (!probe.ok) return null;
  if (probe.value.code === 0) return null;
  const stderr = probe.value.stderr.trim();
  return isCloneCorruption(stderr) ? stderr : null;
}

/** The directory holding `path` — no `@std/path` in this import map. */
function parentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : "/";
}
