/**
 * File-backed issue cache with TTL (Issue #910).
 *
 * Replaces worker/shared/issue_cache.sh with type-safe TypeScript.
 * Caches GitHub API responses to reduce API call volume and avoid
 * rate limiting.
 *
 * Cache format: JSON file with timestamp and data fields.
 *
 * Issue #1215: the default directory lives under a world-writable `TMPDIR`,
 * so it carries a per-account suffix, is created `0700`, and is
 * ownership-checked before any entry is read or written — the same control
 * `timeline_cache.ts` has had since Issue #3709. Without it any local account
 * could pre-create the directory and plant entries the worker would read back
 * as GitHub API responses. A caller-supplied directory (the production path,
 * on the user-owned work volume) is used verbatim and not permission-checked.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  recordCacheExpired,
  recordCacheHit,
  recordCacheMiss,
} from "./gh_call_metrics.ts";
import { defaultLogger } from "./logger.ts";
import {
  ensurePrivateDir,
  isSharedTmpPath,
  sharedTmpStateDir,
  verifyPrivateDir,
} from "./private_cache_dir.ts";

/**
 * Default cache directory: per-account, under the shared temporary root.
 *
 * @param lookup - Environment reader, injectable for tests.
 */
export function defaultIssueCacheDir(
  lookup?: (key: string) => string | undefined,
): string {
  return lookup === undefined
    ? sharedTmpStateDir("vibe-issue-cache-deno")
    : sharedTmpStateDir("vibe-issue-cache-deno", lookup);
}

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
  /** True when the directory is the shared-tmp default and must be verified. */
  private readonly sharedTmpDir: boolean;
  /** Memoised result of the one-off directory ownership check. */
  private privateDirCheck: Promise<boolean> | null = null;
  private stats: CacheStats;

  /**
   * Create a new issue cache.
   *
   * @param cacheDir - Directory to store cache files. Omit it to use the
   *   per-account default under `TMPDIR`. Any directory under the shared
   *   temporary root — supplied or defaulted — is ownership-checked.
   * @param ttlSeconds - Cache time-to-live in seconds (default: 600 = 10 minutes)
   */
  constructor(cacheDir?: string, ttlSeconds = 600) {
    this.cacheDir = cacheDir ?? defaultIssueCacheDir();
    this.sharedTmpDir = isSharedTmpPath(this.cacheDir);
    this.ttlSeconds = ttlSeconds;
    this.stats = { hits: 0, misses: 0, saved: 0 };
  }

  /**
   * Whether the backing directory may be used (Issue #1215).
   *
   * The check follows the directory's **location**, not whether the caller
   * named it: any directory at or below the shared temporary root is created
   * `0700` and ownership-checked, while a work-volume directory (whose
   * permissions the worker does not own) is used as given. A directory
   * another account could have written to disables the cache entirely, so
   * planted entries can never be read back and a poisoned directory is never
   * written to. Checked once per instance; failure is logged, never
   * swallowed.
   */
  private dirIsUsable(): Promise<boolean> {
    if (!this.sharedTmpDir) return Promise.resolve(true);
    this.privateDirCheck ??= (async () => {
      try {
        await ensurePrivateDir(this.cacheDir);
      } catch {
        // Creation failure is reported by the verification below.
      }
      const trust = await verifyPrivateDir(this.cacheDir);
      if (!trust.trusted) {
        defaultLogger.warn(
          "Issue cache directory is not worker-private — cache disabled " +
            "(Issue #1215)",
          { cacheDir: this.cacheDir, reason: trust.reason ?? "unknown" },
        );
      }
      return trust.trusted;
    })();
    return this.privateDirCheck;
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
    if (!await this.dirIsUsable()) {
      this.stats.misses++;
      recordCacheMiss();
      return null;
    }
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
    if (!await this.dirIsUsable()) return;
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
