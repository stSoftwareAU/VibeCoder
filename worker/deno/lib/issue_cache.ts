/**
 * File-backed issue cache with TTL (Issue #910).
 *
 * Replaces worker/shared/issue_cache.sh with type-safe TypeScript.
 * Caches GitHub API responses to reduce API call volume and avoid
 * rate limiting.
 *
 * Cache format: JSON file with timestamp and data fields.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  recordCacheExpired,
  recordCacheHit,
  recordCacheMiss,
} from "./gh_call_metrics.ts";

/**
 * Cache entry stored on disk.
 */
interface CacheEntry {
  /** Unix epoch timestamp when cached */
  timestamp: number;
  /** Cached data (JSON-serialisable) */
  data: unknown;
}

/**
 * Cache statistics for monitoring.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  saved: number;
}

/**
 * File-backed cache with TTL support.
 */
export class IssueCache {
  private readonly cacheDir: string;
  private readonly ttlSeconds: number;
  private stats: CacheStats;

  /**
   * Create a new issue cache.
   *
   * @param cacheDir - Directory to store cache files
   * @param ttlSeconds - Cache time-to-live in seconds (default: 600 = 10 minutes)
   */
  constructor(cacheDir?: string, ttlSeconds = 600) {
    const tmpDir = Deno.env.get("TMPDIR") ?? "/tmp";
    this.cacheDir = cacheDir ?? `${tmpDir}/vibe-issue-cache-deno`;
    this.ttlSeconds = ttlSeconds;
    this.stats = { hits: 0, misses: 0, saved: 0 };
  }

  /**
   * Get the cache file path for a given repo and cache key.
   */
  private getCacheFilePath(repo: string, cacheKey: string): string {
    const repoKey = repo.replace("/", "_");
    const keySafe = cacheKey.replace(/[\s/]/g, "_");
    return `${this.cacheDir}/${repoKey}_${keySafe}.cache.json`;
  }

  /**
   * Check whether a cache entry is still valid (within TTL).
   */
  private isValid(entry: CacheEntry): boolean {
    const now = Math.floor(Date.now() / 1000);
    return (now - entry.timestamp) < this.ttlSeconds;
  }

  /**
   * Read cached data if the cache entry is valid.
   *
   * @param repo - Repository in "owner/repo" format
   * @param cacheKey - Cache key string
   * @returns Cached data or null if cache miss/expired
   */
  async read<T>(repo: string, cacheKey: string): Promise<T | null> {
    const filePath = this.getCacheFilePath(repo, cacheKey);

    try {
      const content = await Deno.readTextFile(filePath);
      const entry = JSON.parse(content) as CacheEntry;

      if (!this.isValid(entry)) {
        this.stats.misses++;
        // Issue #1671: distinguish TTL-expired entries from missing ones.
        recordCacheExpired();
        return null;
      }

      this.stats.hits++;
      this.stats.saved++;
      // Issue #1671: increment global telemetry too.
      recordCacheHit();
      return entry.data as T;
    } catch {
      this.stats.misses++;
      recordCacheMiss();
      return null;
    }
  }

  /**
   * Write data to cache with current timestamp.
   *
   * @param repo - Repository in "owner/repo" format
   * @param cacheKey - Cache key string
   * @param data - Data to cache
   */
  async write(repo: string, cacheKey: string, data: unknown): Promise<void> {
    const filePath = this.getCacheFilePath(repo, cacheKey);

    try {
      await Deno.mkdir(this.cacheDir, { recursive: true });

      const entry: CacheEntry = {
        timestamp: Math.floor(Date.now() / 1000),
        data,
      };

      await Deno.writeTextFile(filePath, JSON.stringify(entry));
    } catch {
      // Cache write failures are non-fatal — log and continue
    }
  }

  /**
   * Invalidate a specific cache entry.
   */
  async invalidate(repo: string, cacheKey: string): Promise<void> {
    const filePath = this.getCacheFilePath(repo, cacheKey);
    try {
      await Deno.remove(filePath);
    } catch {
      // Already removed or doesn't exist — fine
    }
  }

  /**
   * Invalidate all cache entries for a repository.
   */
  async invalidateRepo(repo: string): Promise<void> {
    const repoKey = repo.replace("/", "_");
    try {
      for await (const entry of Deno.readDir(this.cacheDir)) {
        if (
          entry.name.startsWith(`${repoKey}_`) &&
          entry.name.endsWith(".cache.json")
        ) {
          await Deno.remove(`${this.cacheDir}/${entry.name}`);
        }
      }
    } catch {
      // Directory may not exist — fine
    }
  }

  /**
   * Reset cache statistics.
   */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0, saved: 0 };
  }

  /**
   * Get current cache statistics.
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }
}
