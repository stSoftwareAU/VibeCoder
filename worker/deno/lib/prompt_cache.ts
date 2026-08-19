/**
 * Per-repo prompt compilation cache with SHA-based invalidation (Issue #1272).
 *
 * Caches assembled static prompt content on disk, keyed by repository name
 * and SHA-256 hash. Since system and agent prompts seldom change, this cache
 * avoids re-reading and re-assembling prompt templates on every Claude
 * invocation — and ensures a byte-identical prompt prefix is sent each time,
 * maximising Claude's built-in token caching hit rate.
 *
 * Cache invalidation:
 * - **SHA change**: When prompt templates or custom instructions are modified,
 *   the SHA changes, triggering a cache miss and re-assembly.
 * - **TTL safety net**: Entries older than the configurable TTL (default 24h)
 *   are treated as stale, even if the SHA still matches.
 * - **Cleanup**: Old cache files for the same repo are removed when a new SHA
 *   is written, preventing disk bloat.
 *
 * File format: plain text (human-readable for debugging). Metadata (timestamp)
 * is stored as a JSON header line, followed by the prompt content.
 *
 * Atomic writes: content is written to a temporary file first, then renamed
 * into place, ensuring concurrent readers never see a partial write.
 *
 * Uses the Result type pattern consistent with the codebase.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/** Default cache TTL in seconds (24 hours). */
const DEFAULT_TTL_SECONDS = 86400;

/** Default cache directory. */
const DEFAULT_CACHE_DIR = "/tmp/vibe-prompt-cache-deno";

/** Separator between metadata header and content in cache files. */
const HEADER_SEPARATOR = "\n---PROMPT-CACHE-CONTENT---\n";

/** Cache file metadata stored in the first line. */
interface CacheMetadata {
  /** Unix epoch timestamp (seconds) when the entry was written. */
  timestamp: number;
  /** SHA-256 hash of the prompt content used as cache key. */
  sha: string;
}

/** Cache statistics for monitoring. */
export interface PromptCacheStats {
  hits: number;
  misses: number;
}

/** Options for creating a PromptCache instance. */
export interface PromptCacheOptions {
  /** Directory for cache files (defaults to /tmp/vibe-prompt-cache-deno/). */
  cacheDir?: string;
  /** Cache TTL in seconds (default: 86400 = 24 hours). */
  ttlSeconds?: number;
  /** Injectable time source for testing (returns Unix seconds). */
  now?: () => number;
}

/**
 * Disk-based prompt compilation cache with SHA-based invalidation.
 *
 * Stores assembled static prompt text on disk, keyed by `{repo}_{sha}.cache.txt`.
 * On cache hit (SHA matches and within TTL): returns the cached prompt text.
 * On cache miss: returns null so the caller can assemble and cache the result.
 */
export class PromptCache {
  private readonly cacheDir: string;
  private readonly ttlSeconds: number;
  private readonly now: () => number;
  private stats: PromptCacheStats;

  constructor(options?: PromptCacheOptions) {
    this.cacheDir = options?.cacheDir ?? DEFAULT_CACHE_DIR;
    this.ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.now = options?.now ?? (() => Math.floor(Date.now() / 1000));
    this.stats = { hits: 0, misses: 0 };
  }

  /** Get the configured TTL in seconds. */
  getTtlSeconds(): number {
    return this.ttlSeconds;
  }

  /** Get current cache statistics. */
  getStats(): PromptCacheStats {
    return { ...this.stats };
  }

  /** Reset cache statistics. */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0 };
  }

  /**
   * Retrieve cached prompt content for a repo + SHA combination.
   *
   * Returns null on cache miss (no entry, wrong SHA, or expired TTL).
   *
   * @param repo - Repository identifier (e.g. "org/repo")
   * @param sha - SHA-256 hash of the static prompt content
   * @returns Result containing the cached content string, or null on miss
   */
  async get(repo: string, sha: string): Promise<Result<string | null>> {
    const filePath = this.getCacheFilePath(repo, sha);

    try {
      const raw = await Deno.readTextFile(filePath);
      const parsed = this.parseCacheFile(raw);

      if (!parsed) {
        this.stats.misses++;
        return { ok: true, value: null };
      }

      // Validate SHA matches (defence in depth — filename already encodes SHA)
      if (parsed.metadata.sha !== sha) {
        this.stats.misses++;
        return { ok: true, value: null };
      }

      // Check TTL
      const age = this.now() - parsed.metadata.timestamp;
      if (age >= this.ttlSeconds) {
        this.stats.misses++;
        return { ok: true, value: null };
      }

      this.stats.hits++;
      return { ok: true, value: parsed.content };
    } catch {
      // File not found or read error — treat as cache miss
      this.stats.misses++;
      return { ok: true, value: null };
    }
  }

  /**
   * Write prompt content to the cache for a repo + SHA combination.
   *
   * Uses atomic write (temp file + rename) for concurrent access safety.
   *
   * @param repo - Repository identifier (e.g. "org/repo")
   * @param sha - SHA-256 hash of the static prompt content
   * @param content - The assembled static prompt text to cache
   * @returns Result indicating success or failure
   */
  async set(repo: string, sha: string, content: string): Promise<Result<void>> {
    const filePath = this.getCacheFilePath(repo, sha);

    try {
      await Deno.mkdir(this.cacheDir, { recursive: true });

      const metadata: CacheMetadata = {
        timestamp: this.now(),
        sha,
      };

      const fileContent = JSON.stringify(metadata) + HEADER_SEPARATOR + content;

      // Atomic write: write to temp file, then rename.
      // Use PID + random suffix to avoid collisions in concurrent writes.
      const suffix = `${Deno.pid}.${crypto.randomUUID().slice(0, 8)}`;
      const tmpFile = `${filePath}.tmp.${suffix}`;
      await Deno.writeTextFile(tmpFile, fileContent);
      await Deno.rename(tmpFile, filePath);

      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /**
   * Remove all cache files for a given repository.
   *
   * Used to clean up old SHA entries when the prompt content changes,
   * preventing disk bloat from accumulated stale cache files.
   *
   * @param repo - Repository identifier (e.g. "org/repo")
   * @returns Result indicating success or failure
   */
  async cleanupRepo(repo: string): Promise<Result<void>> {
    const repoKey = this.sanitiseRepoName(repo);

    try {
      for await (const entry of Deno.readDir(this.cacheDir)) {
        if (
          entry.name.startsWith(`${repoKey}_`) &&
          entry.name.endsWith(".cache.txt")
        ) {
          try {
            await Deno.remove(`${this.cacheDir}/${entry.name}`);
          } catch {
            // Individual file removal failure is non-fatal
          }
        }
      }
      return { ok: true, value: undefined };
    } catch {
      // Directory may not exist — that's fine, nothing to clean up
      return { ok: true, value: undefined };
    }
  }

  /**
   * Get cached content or assemble and cache it.
   *
   * Convenience method that combines get, cleanup, set, and assemble in
   * the correct order:
   * 1. Check cache for existing entry matching the SHA
   * 2. On hit: return cached content
   * 3. On miss: clean up old repo entries, call the assembler, cache the
   *    result, and return it
   *
   * @param repo - Repository identifier (e.g. "org/repo")
   * @param sha - SHA-256 hash of the static prompt content
   * @param assembler - Async function that assembles the prompt content
   * @returns Result containing the prompt content string
   */
  async getOrSet(
    repo: string,
    sha: string,
    assembler: () => Promise<Result<string>>,
  ): Promise<Result<string>> {
    // Try cache first
    const cached = await this.get(repo, sha);
    if (cached.ok && cached.value !== null) {
      return { ok: true, value: cached.value };
    }

    // Cache miss — clean up old entries for this repo
    await this.cleanupRepo(repo);

    // Assemble the prompt content
    const assembleResult = await assembler();
    if (!assembleResult.ok) {
      return assembleResult;
    }

    // Cache the assembled content (non-fatal if caching fails)
    await this.set(repo, sha, assembleResult.value);

    return { ok: true, value: assembleResult.value };
  }

  /**
   * Build the cache file path for a repo + SHA combination.
   *
   * Format: {cacheDir}/{repoKey}_{sha}.cache.txt
   */
  private getCacheFilePath(repo: string, sha: string): string {
    const repoKey = this.sanitiseRepoName(repo);
    return `${this.cacheDir}/${repoKey}_${sha}.cache.txt`;
  }

  /**
   * Sanitise a repository name for use in filenames.
   *
   * Replaces slashes and other unsafe characters with underscores.
   */
  private sanitiseRepoName(repo: string): string {
    return repo.replace(/[\s/]/g, "_");
  }

  /**
   * Parse a cache file's raw content into metadata and prompt content.
   *
   * Returns null if the file format is invalid.
   */
  private parseCacheFile(
    raw: string,
  ): { metadata: CacheMetadata; content: string } | null {
    const separatorIndex = raw.indexOf(HEADER_SEPARATOR);
    if (separatorIndex === -1) {
      return null;
    }

    const headerStr = raw.substring(0, separatorIndex);
    const content = raw.substring(separatorIndex + HEADER_SEPARATOR.length);

    try {
      const metadata = JSON.parse(headerStr) as CacheMetadata;
      if (
        typeof metadata.timestamp !== "number" ||
        typeof metadata.sha !== "string"
      ) {
        return null;
      }
      return { metadata, content };
    } catch {
      return null;
    }
  }
}
