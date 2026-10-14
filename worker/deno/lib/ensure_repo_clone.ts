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
 * setup phase uses, but only when the clone is missing or broken. An existing
 * healthy clone is left completely untouched — no fetch, no `reset --hard` —
 * so calling this before a read-only scan never disturbs another consumer's
 * working tree. A directory holding no git repository is not a clone: it is
 * discarded and cloned afresh rather than reused (Issue #2848). A clone git
 * reports as corrupt (e.g. a bad `.git/config` line) is handed to `setupRepo`,
 * which moves it aside and re-clones it (Issue #2957, capped at once per repo
 * per 24 h per host) — Issue #3708.
 *
 * Fails loud: a clone that could not be created returns `ok: false` with the
 * underlying message. Callers must surface it rather than continuing against
 * a directory that is not there.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { setupRepo as defaultSetupRepo } from "../commands/git_operations.ts";
import type { CommandResult } from "../types.ts";
import { discardBrokenClone, probeCorruptClone } from "./broken_clone.ts";

/** Outcome of {@link ensureRepoClone}. */
export interface EnsureRepoCloneResult {
  /** `true` when a usable clone is present at `repoPath`. */
  ok: boolean;
  /** Absolute path the clone is expected at (`${workDir}/<repo name>`). */
  repoPath: string;
  /** `true` when this call ran `setupRepo` to (re-)clone, `false` when it already existed. */
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

/** Tail of the in-process queue per clone path (see {@link ensureRepoClone}). */
const cloneQueues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for `key` has settled; the queue entry is dropped once idle. */
async function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = cloneQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.catch(() => undefined);
  cloneQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (cloneQueues.get(key) === tail) cloneQueues.delete(key);
  }
}

/**
 * Ensure `${workDir}/<repo name>` holds a clone of `repo`.
 *
 * Calls for the same clone path are serialised within the process: pool lanes,
 * the PR-branch-update pass and the idle-task route all reach here for one
 * repository at once, and an unserialised pair that both saw a corrupt clone
 * would both call `setupRepo` — the second would be refused by the 24 h
 * re-clone cap and reported as a second corruption, or would clone into the
 * first one's half-finished directory (PR #3712 review). A caller that waited
 * re-probes, finds the fresh clone and reuses it.
 *
 * @param repo - Repository in `owner/repo` form
 * @param workDir - Directory the worker clones repositories into
 */
export function ensureRepoClone(
  repo: string,
  workDir: string,
  deps: EnsureRepoCloneDeps = {},
): Promise<EnsureRepoCloneResult> {
  const repoName = repo.split("/").pop() ?? repo;
  return runExclusive(
    `${workDir}/${repoName}`,
    () => ensureRepoCloneLocked(repo, workDir, deps),
  );
}

async function ensureRepoCloneLocked(
  repo: string,
  workDir: string,
  deps: EnsureRepoCloneDeps,
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
    const discarded = await discardBrokenClone(repoPath);
    if (!discarded.ok) {
      return {
        ok: false,
        repoPath,
        cloned: false,
        message: discarded.error.message,
      };
    }
    if (!discarded.value) {
      // The lane path reaches here without ever calling setupRepo, the only
      // place with the Issue #2957 corrupt-clone recovery. A bad `.git/config`
      // was reused as-is and wedged every lane run at setup (Issue #3708), so
      // a corrupt clone is handed to setupRepo to move aside and re-clone.
      const corruption = await probeCorruptClone(repoPath);
      if (corruption === null) return { ok: true, repoPath, cloned: false };
      console.warn(
        `[setup-repo] ${repoPath} is a corrupt clone (${corruption}) — handing it to setupRepo to move aside and re-clone (Issue #3708)`,
      );
    }
  }

  const result = await setupRepoFn(repo, workDir);
  if (!result.success) {
    return { ok: false, repoPath, cloned: false, message: result.message };
  }
  return { ok: true, repoPath, cloned: true };
}
