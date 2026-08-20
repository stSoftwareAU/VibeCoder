/**
 * Persistent default-branch cache (Issue #1509).
 *
 * Default-branch renames are rare, yet the worker was re-querying the
 * GitHub REST API for every repository on every run_core cycle. On a
 * 5000 requests/hour quota that waste is material — it can exhaust the
 * GraphQL budget before Priority 2 (issue pickup) even runs.
 *
 * This module backs the lookup with a JSON file in
 * `${WORK_DIR}/.vibe-cache/default-branch-cache.json` with a 7-day TTL. If
 * a cached branch no longer exists on the remote (e.g., renamed), the
 * caller invalidates the entry and the next read refetches from the API.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { validateDefaultBranchCacheJson } from "./validation.ts";
import { legacyHomeCachePath, workerCachePath } from "./worker_cache_dir.ts";

/** 7-day time-to-live. Branch renames are rare, a week is conservative. */
export const DEFAULT_BRANCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One entry in the persistent cache. */
export interface DefaultBranchCacheEntry {
  branch: string;
  fetchedAt: number;
}

/**
 * Resolve the default path for the persistent cache file.
 *
 * Honours `VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH` for overrides (used by
 * tests); otherwise uses `${WORK_DIR}/.vibe-cache/default-branch-cache.json`.
 * Returns `undefined` when `WORK_DIR` is unset — there is no cache directory
 * then (Issue #131), and every function in this module is a full no-op that
 * never touches the filesystem (Issue #132): host-side runs (setup, launcher,
 * housekeeping) cache nothing and re-query the GitHub API each time.
 */
export function defaultBranchCachePath(): string | undefined {
  const override = Deno.env.get("VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH");
  if (override) return override;
  // On the durable work volume (Issue #4318): $HOME/.vibe-coder is
  // root-owned in container mode, so the cache never persisted there.
  return workerCachePath(DEFAULT_BRANCH_CACHE_FILE);
}

/** File name of the cache within the worker cache directory. */
export const DEFAULT_BRANCH_CACHE_FILE = "default-branch-cache.json";

/**
 * Load the cache from disk. Returns an empty Map if the file is missing
 * or the contents cannot be parsed (corrupt cache must not crash the worker).
 *
 * An `undefined` path (no cache directory — WORK_DIR unset, Issue #132)
 * returns an empty Map without touching the filesystem — not even the
 * legacy HOME location is read.
 */
export async function loadDefaultBranchCache(
  path: string | undefined = defaultBranchCachePath(),
): Promise<Map<string, DefaultBranchCacheEntry>> {
  if (path === undefined) return new Map();
  let text: string | null = null;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    // Fall through to the legacy location below.
  }
  if (text === null) {
    // Legacy-location fallback (Issue #4318) — read-only, and only for the
    // module's own default path (an explicit caller-supplied path, e.g.
    // from tests, reads nothing else).
    if (path !== defaultBranchCachePath()) return new Map();
    try {
      text = await Deno.readTextFile(
        legacyHomeCachePath(DEFAULT_BRANCH_CACHE_FILE),
      );
    } catch {
      return new Map();
    }
  }

  try {
    const parsed: unknown = JSON.parse(text);
    const validated = validateDefaultBranchCacheJson(parsed);
    if (!validated.ok) return new Map();
    const cache = new Map<string, DefaultBranchCacheEntry>();
    for (const [repo, entry] of Object.entries(validated.value)) {
      cache.set(repo, { branch: entry.branch, fetchedAt: entry.fetchedAt });
    }
    return cache;
  } catch {
    return new Map();
  }
}

/**
 * Persist the cache to disk, creating the parent directory if needed.
 * An `undefined` path (no cache directory — WORK_DIR unset, Issue #132)
 * returns without creating any directory or file: in particular the
 * `Deno.mkdir` below must never run then — it is the call that used to
 * create a stray `~/auto-issue-work/.vibe-cache` on the host (Issue #118).
 */
export async function saveDefaultBranchCache(
  cache: Map<string, DefaultBranchCacheEntry>,
  path: string | undefined = defaultBranchCachePath(),
): Promise<void> {
  if (path === undefined) return;
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    const dir = path.slice(0, slash);
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch {
      // Directory may already exist — ignore.
    }
  }

  const obj: Record<string, DefaultBranchCacheEntry> = {};
  for (const [repo, entry] of cache) {
    obj[repo] = entry;
  }
  await Deno.writeTextFile(path, JSON.stringify(obj, null, 2));
}

/**
 * Return the cached default branch for `repo` if present and still inside
 * the TTL window; otherwise return `null`. Always `null` when there is no
 * cache directory (`path` undefined — Issue #132), without touching the
 * filesystem.
 */
export async function getCachedDefaultBranch(
  repo: string,
  path: string | undefined = defaultBranchCachePath(),
): Promise<string | null> {
  const cache = await loadDefaultBranchCache(path);
  const entry = cache.get(repo);
  if (!entry) return null;
  const ageMs = Date.now() - entry.fetchedAt;
  if (ageMs >= DEFAULT_BRANCH_CACHE_TTL_MS) return null;
  return entry.branch;
}

/**
 * Store the branch in the cache with the current timestamp. A no-op when
 * there is no cache directory (`path` undefined — Issue #132): no
 * directory or file is created anywhere.
 */
export async function setCachedDefaultBranch(
  repo: string,
  branch: string,
  path: string | undefined = defaultBranchCachePath(),
): Promise<void> {
  if (path === undefined) return;
  const cache = await loadDefaultBranchCache(path);
  cache.set(repo, { branch, fetchedAt: Date.now() });
  await saveDefaultBranchCache(cache, path);
}

/**
 * Remove `repo` from the cache. Used when a cached branch is detected to
 * be stale (e.g., `git fetch origin/<branch>` fails because the branch
 * was renamed on the remote). A no-op when there is no cache directory
 * (`path` undefined — Issue #132).
 */
export async function invalidateCachedDefaultBranch(
  repo: string,
  path: string | undefined = defaultBranchCachePath(),
): Promise<void> {
  if (path === undefined) return;
  const cache = await loadDefaultBranchCache(path);
  if (!cache.has(repo)) return;
  cache.delete(repo);
  await saveDefaultBranchCache(cache, path);
}
