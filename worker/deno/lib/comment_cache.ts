/**
 * Per-iteration in-memory TTL cache for issue comments (Issue #1841).
 *
 * Within a single worker iteration, several priorities and code paths
 * (stale-workflow detection, refinement, grill-me, planning, …) read
 * the comments of the same issue. Each one currently issues its own
 * `gh api repos/<repo>/issues/<n>/comments` REST call. This cache
 * deduplicates those reads with a short TTL — long enough to span an
 * iteration, short enough that no behavioural change is visible.
 *
 * The cache is invalidated explicitly when the worker posts a comment
 * to the same `(repo, issueNumber)`, so the next read sees the
 * freshly-posted comment without a refetch.
 *
 * Hits and misses are reported through `gh_call_metrics` so the
 * end-of-iteration telemetry line gets a `comments-cache=hit/miss`
 * field.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubComment } from "../types.ts";
import {
  recordCommentsCacheHit,
  recordCommentsCacheMiss,
} from "./gh_call_metrics.ts";

/**
 * Default TTL for cache entries, in seconds.
 *
 * 90 s sits in the middle of the 60–120 s band specified by Issue
 * #1841 — long enough that all priorities within one iteration share
 * a single fetch, short enough that comment freshness drift is
 * negligible.
 */
export const DEFAULT_COMMENT_CACHE_TTL_SECONDS = 90;

interface CacheEntry {
  /** Unix epoch seconds when the entry was populated. */
  timestamp: number;
  /** Cached comment list. */
  data: GitHubComment[];
}

interface CommentCacheStats {
  hits: number;
  misses: number;
}

const cache = new Map<string, CacheEntry>();
const stats: CommentCacheStats = { hits: 0, misses: 0 };

function cacheKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

/** Default clock — overridable from tests. */
function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Options accepted by `getCachedComments`.
 */
export interface GetCachedCommentsOptions {
  /** TTL in seconds for this lookup. Default: {@link DEFAULT_COMMENT_CACHE_TTL_SECONDS}. */
  ttlSeconds?: number;
  /** Clock override for tests (returns Unix epoch seconds). */
  now?: () => number;
}

/**
 * Read the comments for an issue from cache, falling back to the
 * supplied fetcher on miss/expiry. The fetched value is stored in
 * the cache on success.
 *
 * @param repo - "owner/repo".
 * @param issueNumber - Issue or PR number.
 * @param fetcher - Async function that fetches the comments on miss.
 * @param options - Optional TTL and clock overrides.
 */
export async function getCachedComments(
  repo: string,
  issueNumber: number,
  fetcher: () => Promise<GitHubComment[]>,
  options: GetCachedCommentsOptions = {},
): Promise<GitHubComment[]> {
  const ttl = options.ttlSeconds ?? DEFAULT_COMMENT_CACHE_TTL_SECONDS;
  const now = (options.now ?? defaultNow)();
  const key = cacheKey(repo, issueNumber);
  const entry = cache.get(key);

  if (entry && (now - entry.timestamp) < ttl) {
    stats.hits++;
    recordCommentsCacheHit();
    return entry.data;
  }

  stats.misses++;
  recordCommentsCacheMiss();
  const fetched = await fetcher();
  cache.set(key, { timestamp: now, data: fetched });
  return fetched;
}

/**
 * Drop the cached entry for a single `(repo, issueNumber)` pair.
 *
 * Called by `postComment` so the next read picks up the new comment
 * instead of returning a stale list.
 */
export function invalidateComments(repo: string, issueNumber: number): void {
  cache.delete(cacheKey(repo, issueNumber));
}

/**
 * Clear every entry and reset stats. Intended for tests and for the
 * start of a new worker iteration.
 */
export function clearCommentCache(): void {
  cache.clear();
  stats.hits = 0;
  stats.misses = 0;
}

/** Snapshot of cache stats for telemetry/tests. */
export function getCommentCacheStats(): CommentCacheStats {
  return { hits: stats.hits, misses: stats.misses };
}
