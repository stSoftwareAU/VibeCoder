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
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** 7-day time-to-live. Branch renames are rare, a week is conservative. */
export const DEFAULT_BRANCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One entry in the persistent cache. */
export interface DefaultBranchCacheEntry {
  branch: string;
  fetchedAt: number;
}

/** Environment variable overriding where the cache file lives. */
export const DEFAULT_BRANCH_CACHE_PATH_ENV =
  "VIBE_CODER_DEFAULT_BRANCH_CACHE_PATH";

/**
 * Resolve the default path for the persistent cache file.
 *
 * Honours {@link DEFAULT_BRANCH_CACHE_PATH_ENV} for overrides; otherwise uses
 * `${WORK_DIR}/.vibe-cache/default-branch-cache.json`.
 * Returns `undefined` when `WORK_DIR` is unset — there is no cache directory
 * then (Issue #131), and every function in this module is a full no-op that
 * never touches the filesystem (Issue #132): host-side runs (setup, launcher,
 * housekeeping) cache nothing and re-query the GitHub API each time.
 *
 * @param env - Environment lookup (Issue #964). Defaults to the process
 *   environment, so production callers pass nothing and behave exactly as
 *   they did when this read `Deno.env.get` itself. A test hands in a fixed
 *   map rather than mutating the environment every parallel worker shares.
 */
export function defaultBranchCachePath(
  env: EnvLookup = processEnvLookup,
): string | undefined {
  const override = env(DEFAULT_BRANCH_CACHE_PATH_ENV);
  if (override) return override;
  // On the durable work volume (Issue #4318): $HOME/.vibe-coder is
  // root-owned in container mode, so the cache never persisted there. The
  // lookup goes through: a test that names `WORK_DIR` in its map must not
  // have the resolution answered by whatever the host exports (Issue #969).
  return workerCachePath(DEFAULT_BRANCH_CACHE_FILE, { env });
}

/** File name of the cache within the worker cache directory. */
export const DEFAULT_BRANCH_CACHE_FILE = "default-branch-cache.json";

/**
 * How every accessor below takes its cache path (Issue #969).
 *
 * A tuple union rather than two optional parameters, because a default
 * parameter cannot tell an *omitted* argument from an explicit `undefined` —
 * JavaScript applies the default to both. That mattered: `undefined` is what
 * {@link defaultBranchCachePath} returns for *there is no cache directory at
 * all* (Issue #132), so a caller passing on the `undefined` it had just been
 * handed re-resolved against the process environment and wrote the very file
 * it had been told did not exist. With `WORK_DIR` set that is a stray cache
 * write behind the caller's back, the class of bug #132 exists to prevent, and
 * it made the "creates nothing anywhere" tests pass only because the host
 * running them happened to export no `WORK_DIR`.
 *
 * With the tuple the three cases are distinct and every doc comment below is
 * true as written:
 *
 * - **omitted** — resolve the default against `env` (production's shape);
 * - **`undefined`** — there is no cache directory; every accessor is a full
 *   no-op that touches no filesystem path at all;
 * - **a string** — use exactly that file.
 *
 * `env` is the lookup backing the default resolution and the legacy HOME
 * fallback. It defaults to the process environment, so production callers are
 * unchanged; a test that names `WORK_DIR` or `HOME` in a map passes that map
 * and mutates nothing (Issue #944).
 */
export type DefaultBranchCacheArgs =
  | []
  | [path: string | undefined]
  | [path: string | undefined, env: EnvLookup];

/** The `env` half of {@link DefaultBranchCacheArgs}. */
function argsEnv(rest: DefaultBranchCacheArgs): EnvLookup {
  return rest.length === 2 ? rest[1] : processEnvLookup;
}

/** The resolved cache file of {@link DefaultBranchCacheArgs}, or undefined. */
function argsPath(rest: DefaultBranchCacheArgs): string | undefined {
  return rest.length === 0 ? defaultBranchCachePath() : rest[0];
}

/**
 * Load the cache from disk. Returns an empty Map if the file is missing
 * or the contents cannot be parsed (corrupt cache must not crash the worker).
 *
 * An `undefined` path (no cache directory — WORK_DIR unset, Issue #132)
 * returns an empty Map without touching the filesystem — not even the
 * legacy HOME location is read.
 *
 * @param rest - Cache path and environment lookup; see
 *   {@link DefaultBranchCacheArgs}.
 */
export async function loadDefaultBranchCache(
  ...rest: DefaultBranchCacheArgs
): Promise<Map<string, DefaultBranchCacheEntry>> {
  const env = argsEnv(rest);
  const file = argsPath(rest);
  if (file === undefined) return new Map();
  let text: string | null = null;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    // Fall through to the legacy location below.
  }
  if (text === null) {
    // Legacy-location fallback (Issue #4318) — read-only, and only for the
    // module's own default path (an explicit caller-supplied path, e.g.
    // from tests, reads nothing else).
    if (file !== defaultBranchCachePath(env)) return new Map();
    try {
      text = await Deno.readTextFile(
        legacyHomeCachePath(DEFAULT_BRANCH_CACHE_FILE, { env }),
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
 *
 * @param cache - The entries to persist.
 * @param rest - Cache path and environment lookup; see
 *   {@link DefaultBranchCacheArgs}.
 */
export async function saveDefaultBranchCache(
  cache: Map<string, DefaultBranchCacheEntry>,
  ...rest: DefaultBranchCacheArgs
): Promise<void> {
  const file = argsPath(rest);
  if (file === undefined) return;
  const slash = file.lastIndexOf("/");
  if (slash > 0) {
    const dir = file.slice(0, slash);
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
  await Deno.writeTextFile(file, JSON.stringify(obj, null, 2));
}

/**
 * Return the cached default branch for `repo` if present and still inside
 * the TTL window; otherwise return `null`. Always `null` when there is no
 * cache directory (`path` undefined — Issue #132), without touching the
 * filesystem.
 *
 * @param rest - Cache path and environment lookup; see
 *   {@link DefaultBranchCacheArgs}.
 */
export async function getCachedDefaultBranch(
  repo: string,
  ...rest: DefaultBranchCacheArgs
): Promise<string | null> {
  const cache = await loadDefaultBranchCache(argsPath(rest), argsEnv(rest));
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
 *
 * @param rest - Cache path and environment lookup; see
 *   {@link DefaultBranchCacheArgs}.
 */
export async function setCachedDefaultBranch(
  repo: string,
  branch: string,
  ...rest: DefaultBranchCacheArgs
): Promise<void> {
  const env = argsEnv(rest);
  const file = argsPath(rest);
  if (file === undefined) return;
  const cache = await loadDefaultBranchCache(file, env);
  cache.set(repo, { branch, fetchedAt: Date.now() });
  await saveDefaultBranchCache(cache, file, env);
}

/**
 * Remove `repo` from the cache. Used when a cached branch is detected to
 * be stale (e.g., `git fetch origin/<branch>` fails because the branch
 * was renamed on the remote). A no-op when there is no cache directory
 * (`path` undefined — Issue #132).
 *
 * @param rest - Cache path and environment lookup; see
 *   {@link DefaultBranchCacheArgs}.
 */
export async function invalidateCachedDefaultBranch(
  repo: string,
  ...rest: DefaultBranchCacheArgs
): Promise<void> {
  const env = argsEnv(rest);
  const file = argsPath(rest);
  if (file === undefined) return;
  const cache = await loadDefaultBranchCache(file, env);
  if (!cache.has(repo)) return;
  cache.delete(repo);
  await saveDefaultBranchCache(cache, file, env);
}
