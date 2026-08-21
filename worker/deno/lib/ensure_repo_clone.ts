/**
 * Lazy "make sure this repo has a local clone" helper (Issue #179).
 *
 * Consumers that walk a repository's working tree — idle-task scans in
 * particular — assumed a clone already existed under `${workDir}/<repo>`.
 * For a repo freshly added to `.config.json` nothing had cloned it yet, so
 * the scan failed with `ENOENT: readdir '<workDir>/<repo>'` and the wrapper
 * was closed carrying that error as its "result".
 *
 * This helper closes that gap: it reuses the same `setupRepo()` the standard
 * setup phase uses, but only when the clone is genuinely missing. An existing
 * clone is left completely untouched — no fetch, no `reset --hard` — so
 * calling this before a read-only scan never disturbs another consumer's
 * working tree.
 *
 * Fails loud: a clone that could not be created returns `ok: false` with the
 * underlying message. Callers must surface it rather than continuing against
 * a directory that is not there.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { setupRepo as defaultSetupRepo } from "../commands/git_operations.ts";
import type { CommandResult } from "../types.ts";

/** Outcome of {@link ensureRepoClone}. */
export interface EnsureRepoCloneResult {
  /** `true` when a usable clone is present at `repoPath`. */
  ok: boolean;
  /** Absolute path the clone is expected at (`${workDir}/<repo name>`). */
  repoPath: string;
  /** `true` when this call performed the clone, `false` when it already existed. */
  cloned: boolean;
  /** Failure detail — populated only when `ok` is false. */
  message?: string;
}

/** Injectable seams. Defaults wire the production implementations. */
export interface EnsureRepoCloneDeps {
  /** Clone-or-update helper. Defaults to `setupRepo` from git-operations. */
  setupRepoFn?: (repo: string, workDir: string) => Promise<CommandResult>;
  /** Directory probe. Defaults to a `Deno.stat` check. */
  isDirectoryFn?: (path: string) => Promise<boolean>;
}

/** Default directory probe — a missing path is simply "not a directory". */
async function statIsDirectory(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

/**
 * Ensure `${workDir}/<repo name>` holds a clone of `repo`.
 *
 * @param repo - Repository in `owner/repo` form
 * @param workDir - Directory the worker clones repositories into
 */
export async function ensureRepoClone(
  repo: string,
  workDir: string,
  deps: EnsureRepoCloneDeps = {},
): Promise<EnsureRepoCloneResult> {
  const setupRepoFn = deps.setupRepoFn ?? defaultSetupRepo;
  const isDirectory = deps.isDirectoryFn ?? statIsDirectory;

  const repoName = repo.split("/").pop() ?? repo;
  const repoPath = `${workDir}/${repoName}`;

  // A slug whose derived path segment would escape `workDir` must never be
  // probed as "already cloned" — `${workDir}/..` is a real directory. Hand it
  // straight to `setupRepo`, which owns the refusal (and its message).
  const unsafeSegment = repoName === "" || repoName === "." ||
    repoName === ".." || repoName.includes("/") || repoName.includes("\\");

  if (!unsafeSegment && await isDirectory(repoPath)) {
    return { ok: true, repoPath, cloned: false };
  }

  const result = await setupRepoFn(repo, workDir);
  if (!result.success) {
    return { ok: false, repoPath, cloned: false, message: result.message };
  }
  return { ok: true, repoPath, cloned: true };
}
