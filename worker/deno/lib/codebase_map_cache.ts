/**
 * Per-repo codebase map cache (Issue #4281).
 *
 * Generating the map costs a `git ls-files` plus a bounded set of file-head
 * reads. That is cheap, but it is not free and the result is identical run
 * after run, so it is cached on disk exactly as the compiled prompt is
 * (Issue #1272) — same {@link PromptCache} store, keyed by the repository's
 * **tree hash** instead of a prompt SHA:
 *
 * - **Structure change** — a file added, removed, or moved changes the tree
 *   hash, so the next run regenerates.
 * - **Cadence refresh** — the TTL bounds drift the tree hash cannot see, such
 *   as an edited docstring inside an otherwise unchanged tree.
 *
 * A generation fault is returned to the caller, never swallowed into an empty
 * map (Issue #3234): the caller logs it and runs without the map, which is the
 * pre-#4281 behaviour rather than a silently blank index.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  type CodebaseMapOptions,
  computeTreeHash,
  listRepoFiles,
  renderCodebaseMap,
} from "./codebase_map.ts";
import { PromptCache } from "./prompt_cache.ts";

/** Default cache directory for generated codebase maps. */
export const DEFAULT_CODEBASE_MAP_CACHE_DIR = "/tmp/vibe-codebase-map-deno";

/**
 * Default cadence refresh in seconds (6 hours).
 *
 * Shorter than the prompt cache's 24 hours: the tree hash misses content-only
 * drift, so the TTL is the only thing that keeps stale docstrings out.
 */
export const DEFAULT_CODEBASE_MAP_TTL_SECONDS = 21_600;

/** A codebase map served from cache or freshly generated. */
export interface CachedCodebaseMap {
  /** The rendered map. */
  content: string;
  /** Tree hash the map was generated from — the cache key. */
  treeHash: string;
  /** Whether the map came from cache rather than being generated. */
  cacheHit: boolean;
}

/** Options for {@link getOrGenerateCodebaseMap}. */
export interface GetOrGenerateCodebaseMapOptions extends CodebaseMapOptions {
  /** Repository identifier (e.g. "org/repo") used in the cache key. */
  repo: string;
  /** Path to the repository checkout. */
  repoDir: string;
  /** Cache instance. Omit to build one from `cacheDir`/`ttlSeconds`. */
  cache?: PromptCache;
  /** Cache directory when no instance is supplied. */
  cacheDir?: string;
  /** Cadence refresh in seconds when no instance is supplied. */
  ttlSeconds?: number;
}

/**
 * Return the repository's codebase map, generating it only when needed.
 *
 * @param options - Repository, cache, and map-size settings
 * @returns Result containing the map, its tree hash, and the cache verdict
 */
export async function getOrGenerateCodebaseMap(
  options: GetOrGenerateCodebaseMapOptions,
): Promise<Result<CachedCodebaseMap>> {
  const { repo, repoDir, cache, cacheDir, ttlSeconds, ...mapOptions } = options;

  const filesResult = await listRepoFiles(repoDir);
  if (!filesResult.ok) return filesResult;

  const files = filesResult.value;
  const treeHash = await computeTreeHash(files);

  const store = cache ?? new PromptCache({
    cacheDir: cacheDir ?? DEFAULT_CODEBASE_MAP_CACHE_DIR,
    ttlSeconds: ttlSeconds ?? DEFAULT_CODEBASE_MAP_TTL_SECONDS,
  });

  const cached = await store.get(repo, treeHash);
  if (cached.ok && cached.value !== null) {
    return {
      ok: true,
      value: { content: cached.value, treeHash, cacheHit: true },
    };
  }

  const rendered = await renderCodebaseMap(repoDir, files, mapOptions);
  if (!rendered.ok) return rendered;

  // Drop superseded entries for this repo before writing the new one, so a
  // long-lived worker does not accumulate a map per tree hash on disk.
  await store.cleanupRepo(repo);
  await store.set(repo, treeHash, rendered.value.content);

  return {
    ok: true,
    value: { content: rendered.value.content, treeHash, cacheHit: false },
  };
}
