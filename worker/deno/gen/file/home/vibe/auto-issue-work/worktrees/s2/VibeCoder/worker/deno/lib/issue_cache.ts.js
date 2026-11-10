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
 * as GitHub API responses.
 *
 * Issue #1261: that check now follows the cache rather than the location. A
 * caller-supplied work-volume directory (`${WORK_DIR}/.gh-scan-cache`, the
 * production path) is hardened and ownership-checked too, and every payload
 * is redacted on the way in — the cached JSON carries untrusted issue and PR
 * bodies, which are read back into agent prompts.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */ import { recordCacheExpired, recordCacheHit, recordCacheMiss } from "./gh_call_metrics.ts";
import { defaultLogger } from "./logger.ts";
import { hardenStateDir, sharedTmpStateDir } from "./private_cache_dir.ts";
import { redactJsonStrings } from "./redact_json.ts";
/**
 * Cache key prefix for a referenced issue's state (Issue #1818).
 *
 * Lives here, beside the cache itself, so both the dependency fetcher
 * (`issue_finder_common.ts`) and the close chokepoint that invalidates its
 * entries (`issue_close_notifier.ts`) read one definition — the notifier sits
 * under `gh_spawn.ts`, which the finder's own import graph reaches, so it
 * cannot import the finder directly. The prefix used to be written out twice,
 * and bumping one spelling left a close invalidating a key nothing wrote.
 *
 * Bumped to `v2` by Issue #2173: the payload now carries `milestone`, and a
 * `v1` entry without it would read as "no milestone" and silently *release* a
 * dependant the cross-milestone hold should keep blocking.
 */ export const ISSUE_STATE_CACHE_PREFIX = "issue_state_v2_";
/**
 * Cache key prefix for one milestone's closed issues, read by milestone number
 * (Issue #3662). The full key is `issues_closed_milestone_<n>`. A close or
 * reopen carries the issue number but not the milestone number, so the close
 * notifier drops every key with this prefix in the repo.
 */ export const CLOSED_MILESTONE_CACHE_PREFIX = "issues_closed_milestone_";
/** Cache key prefix for a referenced issue's body (Issue #1818). */ export const ISSUE_BODY_CACHE_PREFIX = "issue_body_v1_";
/**
 * Cache key prefix for a referenced issue's sub-issues (Issue #1818).
 *
 * Bumped to `v2` by Issue #3325: the payload changed from `number[]` to
 * `SubIssueRef[]` ({repo, number}) so cross-repo children keep their own
 * repo. A `v1` entry cached by the old code and read back by the new code
 * would hand `checkParentBlocked` a bare number with no `repo` string,
 * which throws in `childKey` and fails the parent/child gate open.
 */ export const ISSUE_SUB_ISSUES_CACHE_PREFIX = "issue_sub_issues_v2_";
/**
 * Default cache directory: per-account, under the shared temporary root.
 *
 * @param lookup - Environment reader, injectable for tests.
 */ export function defaultIssueCacheDir(lookup) {
  return lookup === undefined ? sharedTmpStateDir("vibe-issue-cache-deno") : sharedTmpStateDir("vibe-issue-cache-deno", lookup);
}
/**
 * File-backed cache with TTL support.
 */ export class IssueCache {
  cacheDir;
  ttlSeconds;
  /** Wall clock in epoch milliseconds; injectable so tests need no sleeps. */ nowMs;
  /** Memoised result of the one-off directory ownership check. */ privateDirCheck = null;
  stats;
  /**
   * Create a new issue cache.
   *
   * @param cacheDir - Directory to store cache files. Omit it to use the
   *   per-account default under `TMPDIR`. Every directory — supplied or
   *   defaulted, temporary root or work volume — is ownership-checked.
   * @param ttlSeconds - Cache time-to-live in seconds (default: 600 = 10 minutes)
   * @param nowMs - Clock in epoch milliseconds (default `Date.now`); tests
   *   inject one to age entries without sleeping (Issue #2662).
   */ constructor(cacheDir, ttlSeconds = 600, nowMs = Date.now){
    this.cacheDir = cacheDir ?? defaultIssueCacheDir();
    this.ttlSeconds = ttlSeconds;
    this.nowMs = nowMs;
    this.stats = {
      hits: 0,
      misses: 0,
      saved: 0
    };
  }
  /**
   * Whether the backing directory may be used (Issues #1215, #1261).
   *
   * Every directory is created `0700` and ownership-checked, wherever it
   * sits: the shared temporary root is world-writable, and the work-volume
   * path is not private on its own either. A directory another account could
   * have written to disables the cache entirely, so planted entries can never
   * be read back and a poisoned directory is never written to. One left at
   * the umask default by an earlier release is narrowed instead of refused.
   * Checked once per instance; failure is logged, never swallowed.
   */ dirIsUsable() {
    this.privateDirCheck ??= (async ()=>{
      const trust = await hardenStateDir(this.cacheDir, {
        create: true
      });
      if (!trust.trusted) {
        defaultLogger.warn("Issue cache directory is not worker-private — cache disabled " + "(Issue #1215)", {
          cacheDir: this.cacheDir,
          reason: trust.reason ?? "unknown"
        });
      }
      return trust.trusted;
    })();
    return this.privateDirCheck;
  }
  /**
   * Get the cache file path for a given repo and cache key.
   */ getCacheFilePath(repo, cacheKey) {
    const repoKey = repo.replace("/", "_");
    const keySafe = cacheKey.replace(/[\s/]/g, "_");
    return `${this.cacheDir}/${repoKey}_${keySafe}.cache.json`;
  }
  /**
   * Check whether a cache entry is still valid (within TTL).
   */ isValid(entry, ttlSeconds = this.ttlSeconds) {
    const now = Math.floor(this.nowMs() / 1000);
    return now - entry.timestamp < ttlSeconds;
  }
  /**
   * Read cached data if the cache entry is valid.
   *
   * @param repo - Repository in "owner/repo" format
   * @param cacheKey - Cache key string
   * @returns Cached data or null if cache miss/expired
   */ async read(repo, cacheKey, /**
     * `ttlSeconds` overrides the instance TTL for this read (Issue #2409), for
     * an entry whose caller applies its own, stricter freshness rule to the
     * data — a listing that stays valid until something observable changes.
     */ options = {}) {
    if (!await this.dirIsUsable()) {
      this.stats.misses++;
      recordCacheMiss();
      return null;
    }
    const filePath = this.getCacheFilePath(repo, cacheKey);
    try {
      const content = await Deno.readTextFile(filePath);
      const entry = JSON.parse(content);
      if (!this.isValid(entry, options.ttlSeconds)) {
        this.stats.misses++;
        // Issue #1671: distinguish TTL-expired entries from missing ones.
        recordCacheExpired();
        return null;
      }
      this.stats.hits++;
      this.stats.saved++;
      // Issue #1671: increment global telemetry too.
      recordCacheHit();
      return entry.data;
    } catch  {
      this.stats.misses++;
      recordCacheMiss();
      return null;
    }
  }
  /**
   * Write data to cache with current timestamp.
   *
   * The payload is redacted on the way in (Issue #1261): the cached objects
   * are GitHub issue and PR JSON, so a token pasted into a body would
   * otherwise sit on the work volume and be read back into a later prompt.
   * Only string values change, so the document stays parseable.
   *
   * @param repo - Repository in "owner/repo" format
   * @param cacheKey - Cache key string
   * @param data - Data to cache
   */ async write(repo, cacheKey, data) {
    if (!await this.dirIsUsable()) return;
    const filePath = this.getCacheFilePath(repo, cacheKey);
    try {
      const entry = {
        timestamp: Math.floor(this.nowMs() / 1000),
        data: redactJsonStrings(data)
      };
      await Deno.writeTextFile(filePath, JSON.stringify(entry), {
        mode: 0o600
      });
    } catch  {
    // Cache write failures are non-fatal — log and continue
    }
  }
  /**
   * Invalidate a specific cache entry.
   */ async invalidate(repo, cacheKey) {
    const filePath = this.getCacheFilePath(repo, cacheKey);
    try {
      await Deno.remove(filePath);
    } catch  {
    // Already removed or doesn't exist — fine
    }
  }
  /**
   * Invalidate every cache entry for a repository whose key starts with
   * `keyPrefix` (Issue #3662), for a family of keys whose suffix the caller
   * does not know.
   */ async invalidatePrefix(repo, keyPrefix) {
    const repoKey = repo.replace("/", "_");
    const keySafe = keyPrefix.replace(/[\s/]/g, "_");
    const filePrefix = `${repoKey}_${keySafe}`;
    try {
      for await (const entry of Deno.readDir(this.cacheDir)){
        if (entry.name.startsWith(filePrefix) && entry.name.endsWith(".cache.json")) {
          await Deno.remove(`${this.cacheDir}/${entry.name}`);
        }
      }
    } catch  {
    // Directory may not exist — fine
    }
  }
  /**
   * Invalidate all cache entries for a repository.
   */ async invalidateRepo(repo) {
    const repoKey = repo.replace("/", "_");
    try {
      for await (const entry of Deno.readDir(this.cacheDir)){
        if (entry.name.startsWith(`${repoKey}_`) && entry.name.endsWith(".cache.json")) {
          await Deno.remove(`${this.cacheDir}/${entry.name}`);
        }
      }
    } catch  {
    // Directory may not exist — fine
    }
  }
  /**
   * Reset cache statistics.
   */ resetStats() {
    this.stats = {
      hits: 0,
      misses: 0,
      saved: 0
    };
  }
  /**
   * Get current cache statistics.
   */ getStats() {
    return {
      ...this.stats
    };
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9pc3N1ZV9jYWNoZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEZpbGUtYmFja2VkIGlzc3VlIGNhY2hlIHdpdGggVFRMIChJc3N1ZSAjOTEwKS5cbiAqXG4gKiBSZXBsYWNlcyB3b3JrZXIvc2hhcmVkL2lzc3VlX2NhY2hlLnNoIHdpdGggdHlwZS1zYWZlIFR5cGVTY3JpcHQuXG4gKiBDYWNoZXMgR2l0SHViIEFQSSByZXNwb25zZXMgdG8gcmVkdWNlIEFQSSBjYWxsIHZvbHVtZSBhbmQgYXZvaWRcbiAqIHJhdGUgbGltaXRpbmcuXG4gKlxuICogQ2FjaGUgZm9ybWF0OiBKU09OIGZpbGUgd2l0aCB0aW1lc3RhbXAgYW5kIGRhdGEgZmllbGRzLlxuICpcbiAqIElzc3VlICMxMjE1OiB0aGUgZGVmYXVsdCBkaXJlY3RvcnkgbGl2ZXMgdW5kZXIgYSB3b3JsZC13cml0YWJsZSBgVE1QRElSYCxcbiAqIHNvIGl0IGNhcnJpZXMgYSBwZXItYWNjb3VudCBzdWZmaXgsIGlzIGNyZWF0ZWQgYDA3MDBgLCBhbmQgaXNcbiAqIG93bmVyc2hpcC1jaGVja2VkIGJlZm9yZSBhbnkgZW50cnkgaXMgcmVhZCBvciB3cml0dGVuIOKAlCB0aGUgc2FtZSBjb250cm9sXG4gKiBgdGltZWxpbmVfY2FjaGUudHNgIGhhcyBoYWQgc2luY2UgSXNzdWUgIzM3MDkuIFdpdGhvdXQgaXQgYW55IGxvY2FsIGFjY291bnRcbiAqIGNvdWxkIHByZS1jcmVhdGUgdGhlIGRpcmVjdG9yeSBhbmQgcGxhbnQgZW50cmllcyB0aGUgd29ya2VyIHdvdWxkIHJlYWQgYmFja1xuICogYXMgR2l0SHViIEFQSSByZXNwb25zZXMuXG4gKlxuICogSXNzdWUgIzEyNjE6IHRoYXQgY2hlY2sgbm93IGZvbGxvd3MgdGhlIGNhY2hlIHJhdGhlciB0aGFuIHRoZSBsb2NhdGlvbi4gQVxuICogY2FsbGVyLXN1cHBsaWVkIHdvcmstdm9sdW1lIGRpcmVjdG9yeSAoYCR7V09SS19ESVJ9Ly5naC1zY2FuLWNhY2hlYCwgdGhlXG4gKiBwcm9kdWN0aW9uIHBhdGgpIGlzIGhhcmRlbmVkIGFuZCBvd25lcnNoaXAtY2hlY2tlZCB0b28sIGFuZCBldmVyeSBwYXlsb2FkXG4gKiBpcyByZWRhY3RlZCBvbiB0aGUgd2F5IGluIOKAlCB0aGUgY2FjaGVkIEpTT04gY2FycmllcyB1bnRydXN0ZWQgaXNzdWUgYW5kIFBSXG4gKiBib2RpZXMsIHdoaWNoIGFyZSByZWFkIGJhY2sgaW50byBhZ2VudCBwcm9tcHRzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKVxuICovXG5cbmltcG9ydCB7XG4gIHJlY29yZENhY2hlRXhwaXJlZCxcbiAgcmVjb3JkQ2FjaGVIaXQsXG4gIHJlY29yZENhY2hlTWlzcyxcbn0gZnJvbSBcIi4vZ2hfY2FsbF9tZXRyaWNzLnRzXCI7XG5pbXBvcnQgeyBkZWZhdWx0TG9nZ2VyIH0gZnJvbSBcIi4vbG9nZ2VyLnRzXCI7XG5pbXBvcnQgeyBoYXJkZW5TdGF0ZURpciwgc2hhcmVkVG1wU3RhdGVEaXIgfSBmcm9tIFwiLi9wcml2YXRlX2NhY2hlX2Rpci50c1wiO1xuaW1wb3J0IHsgcmVkYWN0SnNvblN0cmluZ3MgfSBmcm9tIFwiLi9yZWRhY3RfanNvbi50c1wiO1xuXG4vKipcbiAqIENhY2hlIGtleSBwcmVmaXggZm9yIGEgcmVmZXJlbmNlZCBpc3N1ZSdzIHN0YXRlIChJc3N1ZSAjMTgxOCkuXG4gKlxuICogTGl2ZXMgaGVyZSwgYmVzaWRlIHRoZSBjYWNoZSBpdHNlbGYsIHNvIGJvdGggdGhlIGRlcGVuZGVuY3kgZmV0Y2hlclxuICogKGBpc3N1ZV9maW5kZXJfY29tbW9uLnRzYCkgYW5kIHRoZSBjbG9zZSBjaG9rZXBvaW50IHRoYXQgaW52YWxpZGF0ZXMgaXRzXG4gKiBlbnRyaWVzIChgaXNzdWVfY2xvc2Vfbm90aWZpZXIudHNgKSByZWFkIG9uZSBkZWZpbml0aW9uIOKAlCB0aGUgbm90aWZpZXIgc2l0c1xuICogdW5kZXIgYGdoX3NwYXduLnRzYCwgd2hpY2ggdGhlIGZpbmRlcidzIG93biBpbXBvcnQgZ3JhcGggcmVhY2hlcywgc28gaXRcbiAqIGNhbm5vdCBpbXBvcnQgdGhlIGZpbmRlciBkaXJlY3RseS4gVGhlIHByZWZpeCB1c2VkIHRvIGJlIHdyaXR0ZW4gb3V0IHR3aWNlLFxuICogYW5kIGJ1bXBpbmcgb25lIHNwZWxsaW5nIGxlZnQgYSBjbG9zZSBpbnZhbGlkYXRpbmcgYSBrZXkgbm90aGluZyB3cm90ZS5cbiAqXG4gKiBCdW1wZWQgdG8gYHYyYCBieSBJc3N1ZSAjMjE3MzogdGhlIHBheWxvYWQgbm93IGNhcnJpZXMgYG1pbGVzdG9uZWAsIGFuZCBhXG4gKiBgdjFgIGVudHJ5IHdpdGhvdXQgaXQgd291bGQgcmVhZCBhcyBcIm5vIG1pbGVzdG9uZVwiIGFuZCBzaWxlbnRseSAqcmVsZWFzZSogYVxuICogZGVwZW5kYW50IHRoZSBjcm9zcy1taWxlc3RvbmUgaG9sZCBzaG91bGQga2VlcCBibG9ja2luZy5cbiAqL1xuZXhwb3J0IGNvbnN0IElTU1VFX1NUQVRFX0NBQ0hFX1BSRUZJWCA9IFwiaXNzdWVfc3RhdGVfdjJfXCI7XG5cbi8qKlxuICogQ2FjaGUga2V5IHByZWZpeCBmb3Igb25lIG1pbGVzdG9uZSdzIGNsb3NlZCBpc3N1ZXMsIHJlYWQgYnkgbWlsZXN0b25lIG51bWJlclxuICogKElzc3VlICMzNjYyKS4gVGhlIGZ1bGwga2V5IGlzIGBpc3N1ZXNfY2xvc2VkX21pbGVzdG9uZV88bj5gLiBBIGNsb3NlIG9yXG4gKiByZW9wZW4gY2FycmllcyB0aGUgaXNzdWUgbnVtYmVyIGJ1dCBub3QgdGhlIG1pbGVzdG9uZSBudW1iZXIsIHNvIHRoZSBjbG9zZVxuICogbm90aWZpZXIgZHJvcHMgZXZlcnkga2V5IHdpdGggdGhpcyBwcmVmaXggaW4gdGhlIHJlcG8uXG4gKi9cbmV4cG9ydCBjb25zdCBDTE9TRURfTUlMRVNUT05FX0NBQ0hFX1BSRUZJWCA9IFwiaXNzdWVzX2Nsb3NlZF9taWxlc3RvbmVfXCI7XG5cbi8qKiBDYWNoZSBrZXkgcHJlZml4IGZvciBhIHJlZmVyZW5jZWQgaXNzdWUncyBib2R5IChJc3N1ZSAjMTgxOCkuICovXG5leHBvcnQgY29uc3QgSVNTVUVfQk9EWV9DQUNIRV9QUkVGSVggPSBcImlzc3VlX2JvZHlfdjFfXCI7XG5cbi8qKlxuICogQ2FjaGUga2V5IHByZWZpeCBmb3IgYSByZWZlcmVuY2VkIGlzc3VlJ3Mgc3ViLWlzc3VlcyAoSXNzdWUgIzE4MTgpLlxuICpcbiAqIEJ1bXBlZCB0byBgdjJgIGJ5IElzc3VlICMzMzI1OiB0aGUgcGF5bG9hZCBjaGFuZ2VkIGZyb20gYG51bWJlcltdYCB0b1xuICogYFN1Yklzc3VlUmVmW11gICh7cmVwbywgbnVtYmVyfSkgc28gY3Jvc3MtcmVwbyBjaGlsZHJlbiBrZWVwIHRoZWlyIG93blxuICogcmVwby4gQSBgdjFgIGVudHJ5IGNhY2hlZCBieSB0aGUgb2xkIGNvZGUgYW5kIHJlYWQgYmFjayBieSB0aGUgbmV3IGNvZGVcbiAqIHdvdWxkIGhhbmQgYGNoZWNrUGFyZW50QmxvY2tlZGAgYSBiYXJlIG51bWJlciB3aXRoIG5vIGByZXBvYCBzdHJpbmcsXG4gKiB3aGljaCB0aHJvd3MgaW4gYGNoaWxkS2V5YCBhbmQgZmFpbHMgdGhlIHBhcmVudC9jaGlsZCBnYXRlIG9wZW4uXG4gKi9cbmV4cG9ydCBjb25zdCBJU1NVRV9TVUJfSVNTVUVTX0NBQ0hFX1BSRUZJWCA9IFwiaXNzdWVfc3ViX2lzc3Vlc192Ml9cIjtcblxuLyoqXG4gKiBEZWZhdWx0IGNhY2hlIGRpcmVjdG9yeTogcGVyLWFjY291bnQsIHVuZGVyIHRoZSBzaGFyZWQgdGVtcG9yYXJ5IHJvb3QuXG4gKlxuICogQHBhcmFtIGxvb2t1cCAtIEVudmlyb25tZW50IHJlYWRlciwgaW5qZWN0YWJsZSBmb3IgdGVzdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0SXNzdWVDYWNoZURpcihcbiAgbG9va3VwPzogKGtleTogc3RyaW5nKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gbG9va3VwID09PSB1bmRlZmluZWRcbiAgICA/IHNoYXJlZFRtcFN0YXRlRGlyKFwidmliZS1pc3N1ZS1jYWNoZS1kZW5vXCIpXG4gICAgOiBzaGFyZWRUbXBTdGF0ZURpcihcInZpYmUtaXNzdWUtY2FjaGUtZGVub1wiLCBsb29rdXApO1xufVxuXG4vKipcbiAqIENhY2hlIGVudHJ5IHN0b3JlZCBvbiBkaXNrLlxuICovXG5pbnRlcmZhY2UgQ2FjaGVFbnRyeSB7XG4gIC8qKiBVbml4IGVwb2NoIHRpbWVzdGFtcCB3aGVuIGNhY2hlZCAqL1xuICB0aW1lc3RhbXA6IG51bWJlcjtcbiAgLyoqIENhY2hlZCBkYXRhIChKU09OLXNlcmlhbGlzYWJsZSkgKi9cbiAgZGF0YTogdW5rbm93bjtcbn1cblxuLyoqXG4gKiBDYWNoZSBzdGF0aXN0aWNzIGZvciBtb25pdG9yaW5nLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIENhY2hlU3RhdHMge1xuICBoaXRzOiBudW1iZXI7XG4gIG1pc3NlczogbnVtYmVyO1xuICBzYXZlZDogbnVtYmVyO1xufVxuXG4vKipcbiAqIEZpbGUtYmFja2VkIGNhY2hlIHdpdGggVFRMIHN1cHBvcnQuXG4gKi9cbmV4cG9ydCBjbGFzcyBJc3N1ZUNhY2hlIHtcbiAgcHJpdmF0ZSByZWFkb25seSBjYWNoZURpcjogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IHR0bFNlY29uZHM6IG51bWJlcjtcbiAgLyoqIFdhbGwgY2xvY2sgaW4gZXBvY2ggbWlsbGlzZWNvbmRzOyBpbmplY3RhYmxlIHNvIHRlc3RzIG5lZWQgbm8gc2xlZXBzLiAqL1xuICBwcml2YXRlIHJlYWRvbmx5IG5vd01zOiAoKSA9PiBudW1iZXI7XG4gIC8qKiBNZW1vaXNlZCByZXN1bHQgb2YgdGhlIG9uZS1vZmYgZGlyZWN0b3J5IG93bmVyc2hpcCBjaGVjay4gKi9cbiAgcHJpdmF0ZSBwcml2YXRlRGlyQ2hlY2s6IFByb21pc2U8Ym9vbGVhbj4gfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBzdGF0czogQ2FjaGVTdGF0cztcblxuICAvKipcbiAgICogQ3JlYXRlIGEgbmV3IGlzc3VlIGNhY2hlLlxuICAgKlxuICAgKiBAcGFyYW0gY2FjaGVEaXIgLSBEaXJlY3RvcnkgdG8gc3RvcmUgY2FjaGUgZmlsZXMuIE9taXQgaXQgdG8gdXNlIHRoZVxuICAgKiAgIHBlci1hY2NvdW50IGRlZmF1bHQgdW5kZXIgYFRNUERJUmAuIEV2ZXJ5IGRpcmVjdG9yeSDigJQgc3VwcGxpZWQgb3JcbiAgICogICBkZWZhdWx0ZWQsIHRlbXBvcmFyeSByb290IG9yIHdvcmsgdm9sdW1lIOKAlCBpcyBvd25lcnNoaXAtY2hlY2tlZC5cbiAgICogQHBhcmFtIHR0bFNlY29uZHMgLSBDYWNoZSB0aW1lLXRvLWxpdmUgaW4gc2Vjb25kcyAoZGVmYXVsdDogNjAwID0gMTAgbWludXRlcylcbiAgICogQHBhcmFtIG5vd01zIC0gQ2xvY2sgaW4gZXBvY2ggbWlsbGlzZWNvbmRzIChkZWZhdWx0IGBEYXRlLm5vd2ApOyB0ZXN0c1xuICAgKiAgIGluamVjdCBvbmUgdG8gYWdlIGVudHJpZXMgd2l0aG91dCBzbGVlcGluZyAoSXNzdWUgIzI2NjIpLlxuICAgKi9cbiAgY29uc3RydWN0b3IoXG4gICAgY2FjaGVEaXI/OiBzdHJpbmcsXG4gICAgdHRsU2Vjb25kcyA9IDYwMCxcbiAgICBub3dNczogKCkgPT4gbnVtYmVyID0gRGF0ZS5ub3csXG4gICkge1xuICAgIHRoaXMuY2FjaGVEaXIgPSBjYWNoZURpciA/PyBkZWZhdWx0SXNzdWVDYWNoZURpcigpO1xuICAgIHRoaXMudHRsU2Vjb25kcyA9IHR0bFNlY29uZHM7XG4gICAgdGhpcy5ub3dNcyA9IG5vd01zO1xuICAgIHRoaXMuc3RhdHMgPSB7IGhpdHM6IDAsIG1pc3NlczogMCwgc2F2ZWQ6IDAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBiYWNraW5nIGRpcmVjdG9yeSBtYXkgYmUgdXNlZCAoSXNzdWVzICMxMjE1LCAjMTI2MSkuXG4gICAqXG4gICAqIEV2ZXJ5IGRpcmVjdG9yeSBpcyBjcmVhdGVkIGAwNzAwYCBhbmQgb3duZXJzaGlwLWNoZWNrZWQsIHdoZXJldmVyIGl0XG4gICAqIHNpdHM6IHRoZSBzaGFyZWQgdGVtcG9yYXJ5IHJvb3QgaXMgd29ybGQtd3JpdGFibGUsIGFuZCB0aGUgd29yay12b2x1bWVcbiAgICogcGF0aCBpcyBub3QgcHJpdmF0ZSBvbiBpdHMgb3duIGVpdGhlci4gQSBkaXJlY3RvcnkgYW5vdGhlciBhY2NvdW50IGNvdWxkXG4gICAqIGhhdmUgd3JpdHRlbiB0byBkaXNhYmxlcyB0aGUgY2FjaGUgZW50aXJlbHksIHNvIHBsYW50ZWQgZW50cmllcyBjYW4gbmV2ZXJcbiAgICogYmUgcmVhZCBiYWNrIGFuZCBhIHBvaXNvbmVkIGRpcmVjdG9yeSBpcyBuZXZlciB3cml0dGVuIHRvLiBPbmUgbGVmdCBhdFxuICAgKiB0aGUgdW1hc2sgZGVmYXVsdCBieSBhbiBlYXJsaWVyIHJlbGVhc2UgaXMgbmFycm93ZWQgaW5zdGVhZCBvZiByZWZ1c2VkLlxuICAgKiBDaGVja2VkIG9uY2UgcGVyIGluc3RhbmNlOyBmYWlsdXJlIGlzIGxvZ2dlZCwgbmV2ZXIgc3dhbGxvd2VkLlxuICAgKi9cbiAgcHJpdmF0ZSBkaXJJc1VzYWJsZSgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICB0aGlzLnByaXZhdGVEaXJDaGVjayA/Pz0gKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHRydXN0ID0gYXdhaXQgaGFyZGVuU3RhdGVEaXIodGhpcy5jYWNoZURpciwgeyBjcmVhdGU6IHRydWUgfSk7XG4gICAgICBpZiAoIXRydXN0LnRydXN0ZWQpIHtcbiAgICAgICAgZGVmYXVsdExvZ2dlci53YXJuKFxuICAgICAgICAgIFwiSXNzdWUgY2FjaGUgZGlyZWN0b3J5IGlzIG5vdCB3b3JrZXItcHJpdmF0ZSDigJQgY2FjaGUgZGlzYWJsZWQgXCIgK1xuICAgICAgICAgICAgXCIoSXNzdWUgIzEyMTUpXCIsXG4gICAgICAgICAgeyBjYWNoZURpcjogdGhpcy5jYWNoZURpciwgcmVhc29uOiB0cnVzdC5yZWFzb24gPz8gXCJ1bmtub3duXCIgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0cnVzdC50cnVzdGVkO1xuICAgIH0pKCk7XG4gICAgcmV0dXJuIHRoaXMucHJpdmF0ZURpckNoZWNrO1xuICB9XG5cbiAgLyoqXG4gICAqIEdldCB0aGUgY2FjaGUgZmlsZSBwYXRoIGZvciBhIGdpdmVuIHJlcG8gYW5kIGNhY2hlIGtleS5cbiAgICovXG4gIHByaXZhdGUgZ2V0Q2FjaGVGaWxlUGF0aChyZXBvOiBzdHJpbmcsIGNhY2hlS2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IHJlcG9LZXkgPSByZXBvLnJlcGxhY2UoXCIvXCIsIFwiX1wiKTtcbiAgICBjb25zdCBrZXlTYWZlID0gY2FjaGVLZXkucmVwbGFjZSgvW1xccy9dL2csIFwiX1wiKTtcbiAgICByZXR1cm4gYCR7dGhpcy5jYWNoZURpcn0vJHtyZXBvS2V5fV8ke2tleVNhZmV9LmNhY2hlLmpzb25gO1xuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrIHdoZXRoZXIgYSBjYWNoZSBlbnRyeSBpcyBzdGlsbCB2YWxpZCAod2l0aGluIFRUTCkuXG4gICAqL1xuICBwcml2YXRlIGlzVmFsaWQoZW50cnk6IENhY2hlRW50cnksIHR0bFNlY29uZHMgPSB0aGlzLnR0bFNlY29uZHMpOiBib29sZWFuIHtcbiAgICBjb25zdCBub3cgPSBNYXRoLmZsb29yKHRoaXMubm93TXMoKSAvIDEwMDApO1xuICAgIHJldHVybiAobm93IC0gZW50cnkudGltZXN0YW1wKSA8IHR0bFNlY29uZHM7XG4gIH1cblxuICAvKipcbiAgICogUmVhZCBjYWNoZWQgZGF0YSBpZiB0aGUgY2FjaGUgZW50cnkgaXMgdmFsaWQuXG4gICAqXG4gICAqIEBwYXJhbSByZXBvIC0gUmVwb3NpdG9yeSBpbiBcIm93bmVyL3JlcG9cIiBmb3JtYXRcbiAgICogQHBhcmFtIGNhY2hlS2V5IC0gQ2FjaGUga2V5IHN0cmluZ1xuICAgKiBAcmV0dXJucyBDYWNoZWQgZGF0YSBvciBudWxsIGlmIGNhY2hlIG1pc3MvZXhwaXJlZFxuICAgKi9cbiAgYXN5bmMgcmVhZDxUPihcbiAgICByZXBvOiBzdHJpbmcsXG4gICAgY2FjaGVLZXk6IHN0cmluZyxcbiAgICAvKipcbiAgICAgKiBgdHRsU2Vjb25kc2Agb3ZlcnJpZGVzIHRoZSBpbnN0YW5jZSBUVEwgZm9yIHRoaXMgcmVhZCAoSXNzdWUgIzI0MDkpLCBmb3JcbiAgICAgKiBhbiBlbnRyeSB3aG9zZSBjYWxsZXIgYXBwbGllcyBpdHMgb3duLCBzdHJpY3RlciBmcmVzaG5lc3MgcnVsZSB0byB0aGVcbiAgICAgKiBkYXRhIOKAlCBhIGxpc3RpbmcgdGhhdCBzdGF5cyB2YWxpZCB1bnRpbCBzb21ldGhpbmcgb2JzZXJ2YWJsZSBjaGFuZ2VzLlxuICAgICAqL1xuICAgIG9wdGlvbnM6IHsgdHRsU2Vjb25kcz86IG51bWJlciB9ID0ge30sXG4gICk6IFByb21pc2U8VCB8IG51bGw+IHtcbiAgICBpZiAoIWF3YWl0IHRoaXMuZGlySXNVc2FibGUoKSkge1xuICAgICAgdGhpcy5zdGF0cy5taXNzZXMrKztcbiAgICAgIHJlY29yZENhY2hlTWlzcygpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICAgIGNvbnN0IGZpbGVQYXRoID0gdGhpcy5nZXRDYWNoZUZpbGVQYXRoKHJlcG8sIGNhY2hlS2V5KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb250ZW50ID0gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoZmlsZVBhdGgpO1xuICAgICAgY29uc3QgZW50cnkgPSBKU09OLnBhcnNlKGNvbnRlbnQpIGFzIENhY2hlRW50cnk7XG5cbiAgICAgIGlmICghdGhpcy5pc1ZhbGlkKGVudHJ5LCBvcHRpb25zLnR0bFNlY29uZHMpKSB7XG4gICAgICAgIHRoaXMuc3RhdHMubWlzc2VzKys7XG4gICAgICAgIC8vIElzc3VlICMxNjcxOiBkaXN0aW5ndWlzaCBUVEwtZXhwaXJlZCBlbnRyaWVzIGZyb20gbWlzc2luZyBvbmVzLlxuICAgICAgICByZWNvcmRDYWNoZUV4cGlyZWQoKTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG5cbiAgICAgIHRoaXMuc3RhdHMuaGl0cysrO1xuICAgICAgdGhpcy5zdGF0cy5zYXZlZCsrO1xuICAgICAgLy8gSXNzdWUgIzE2NzE6IGluY3JlbWVudCBnbG9iYWwgdGVsZW1ldHJ5IHRvby5cbiAgICAgIHJlY29yZENhY2hlSGl0KCk7XG4gICAgICByZXR1cm4gZW50cnkuZGF0YSBhcyBUO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhpcy5zdGF0cy5taXNzZXMrKztcbiAgICAgIHJlY29yZENhY2hlTWlzcygpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFdyaXRlIGRhdGEgdG8gY2FjaGUgd2l0aCBjdXJyZW50IHRpbWVzdGFtcC5cbiAgICpcbiAgICogVGhlIHBheWxvYWQgaXMgcmVkYWN0ZWQgb24gdGhlIHdheSBpbiAoSXNzdWUgIzEyNjEpOiB0aGUgY2FjaGVkIG9iamVjdHNcbiAgICogYXJlIEdpdEh1YiBpc3N1ZSBhbmQgUFIgSlNPTiwgc28gYSB0b2tlbiBwYXN0ZWQgaW50byBhIGJvZHkgd291bGRcbiAgICogb3RoZXJ3aXNlIHNpdCBvbiB0aGUgd29yayB2b2x1bWUgYW5kIGJlIHJlYWQgYmFjayBpbnRvIGEgbGF0ZXIgcHJvbXB0LlxuICAgKiBPbmx5IHN0cmluZyB2YWx1ZXMgY2hhbmdlLCBzbyB0aGUgZG9jdW1lbnQgc3RheXMgcGFyc2VhYmxlLlxuICAgKlxuICAgKiBAcGFyYW0gcmVwbyAtIFJlcG9zaXRvcnkgaW4gXCJvd25lci9yZXBvXCIgZm9ybWF0XG4gICAqIEBwYXJhbSBjYWNoZUtleSAtIENhY2hlIGtleSBzdHJpbmdcbiAgICogQHBhcmFtIGRhdGEgLSBEYXRhIHRvIGNhY2hlXG4gICAqL1xuICBhc3luYyB3cml0ZShyZXBvOiBzdHJpbmcsIGNhY2hlS2V5OiBzdHJpbmcsIGRhdGE6IHVua25vd24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoIWF3YWl0IHRoaXMuZGlySXNVc2FibGUoKSkgcmV0dXJuO1xuICAgIGNvbnN0IGZpbGVQYXRoID0gdGhpcy5nZXRDYWNoZUZpbGVQYXRoKHJlcG8sIGNhY2hlS2V5KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBlbnRyeTogQ2FjaGVFbnRyeSA9IHtcbiAgICAgICAgdGltZXN0YW1wOiBNYXRoLmZsb29yKHRoaXMubm93TXMoKSAvIDEwMDApLFxuICAgICAgICBkYXRhOiByZWRhY3RKc29uU3RyaW5ncyhkYXRhKSxcbiAgICAgIH07XG5cbiAgICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShmaWxlUGF0aCwgSlNPTi5zdHJpbmdpZnkoZW50cnkpLCB7XG4gICAgICAgIG1vZGU6IDBvNjAwLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBDYWNoZSB3cml0ZSBmYWlsdXJlcyBhcmUgbm9uLWZhdGFsIOKAlCBsb2cgYW5kIGNvbnRpbnVlXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEludmFsaWRhdGUgYSBzcGVjaWZpYyBjYWNoZSBlbnRyeS5cbiAgICovXG4gIGFzeW5jIGludmFsaWRhdGUocmVwbzogc3RyaW5nLCBjYWNoZUtleTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgZmlsZVBhdGggPSB0aGlzLmdldENhY2hlRmlsZVBhdGgocmVwbywgY2FjaGVLZXkpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLnJlbW92ZShmaWxlUGF0aCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBBbHJlYWR5IHJlbW92ZWQgb3IgZG9lc24ndCBleGlzdCDigJQgZmluZVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBJbnZhbGlkYXRlIGV2ZXJ5IGNhY2hlIGVudHJ5IGZvciBhIHJlcG9zaXRvcnkgd2hvc2Uga2V5IHN0YXJ0cyB3aXRoXG4gICAqIGBrZXlQcmVmaXhgIChJc3N1ZSAjMzY2MiksIGZvciBhIGZhbWlseSBvZiBrZXlzIHdob3NlIHN1ZmZpeCB0aGUgY2FsbGVyXG4gICAqIGRvZXMgbm90IGtub3cuXG4gICAqL1xuICBhc3luYyBpbnZhbGlkYXRlUHJlZml4KHJlcG86IHN0cmluZywga2V5UHJlZml4OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCByZXBvS2V5ID0gcmVwby5yZXBsYWNlKFwiL1wiLCBcIl9cIik7XG4gICAgY29uc3Qga2V5U2FmZSA9IGtleVByZWZpeC5yZXBsYWNlKC9bXFxzL10vZywgXCJfXCIpO1xuICAgIGNvbnN0IGZpbGVQcmVmaXggPSBgJHtyZXBvS2V5fV8ke2tleVNhZmV9YDtcbiAgICB0cnkge1xuICAgICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIodGhpcy5jYWNoZURpcikpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGVudHJ5Lm5hbWUuc3RhcnRzV2l0aChmaWxlUHJlZml4KSAmJlxuICAgICAgICAgIGVudHJ5Lm5hbWUuZW5kc1dpdGgoXCIuY2FjaGUuanNvblwiKVxuICAgICAgICApIHtcbiAgICAgICAgICBhd2FpdCBEZW5vLnJlbW92ZShgJHt0aGlzLmNhY2hlRGlyfS8ke2VudHJ5Lm5hbWV9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIERpcmVjdG9yeSBtYXkgbm90IGV4aXN0IOKAlCBmaW5lXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEludmFsaWRhdGUgYWxsIGNhY2hlIGVudHJpZXMgZm9yIGEgcmVwb3NpdG9yeS5cbiAgICovXG4gIGFzeW5jIGludmFsaWRhdGVSZXBvKHJlcG86IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHJlcG9LZXkgPSByZXBvLnJlcGxhY2UoXCIvXCIsIFwiX1wiKTtcbiAgICB0cnkge1xuICAgICAgZm9yIGF3YWl0IChjb25zdCBlbnRyeSBvZiBEZW5vLnJlYWREaXIodGhpcy5jYWNoZURpcikpIHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGVudHJ5Lm5hbWUuc3RhcnRzV2l0aChgJHtyZXBvS2V5fV9gKSAmJlxuICAgICAgICAgIGVudHJ5Lm5hbWUuZW5kc1dpdGgoXCIuY2FjaGUuanNvblwiKVxuICAgICAgICApIHtcbiAgICAgICAgICBhd2FpdCBEZW5vLnJlbW92ZShgJHt0aGlzLmNhY2hlRGlyfS8ke2VudHJ5Lm5hbWV9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIERpcmVjdG9yeSBtYXkgbm90IGV4aXN0IOKAlCBmaW5lXG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc2V0IGNhY2hlIHN0YXRpc3RpY3MuXG4gICAqL1xuICByZXNldFN0YXRzKCk6IHZvaWQge1xuICAgIHRoaXMuc3RhdHMgPSB7IGhpdHM6IDAsIG1pc3NlczogMCwgc2F2ZWQ6IDAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgY3VycmVudCBjYWNoZSBzdGF0aXN0aWNzLlxuICAgKi9cbiAgZ2V0U3RhdHMoKTogQ2FjaGVTdGF0cyB7XG4gICAgcmV0dXJuIHsgLi4udGhpcy5zdGF0cyB9O1xuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBdUJDLEdBRUQsU0FDRSxrQkFBa0IsRUFDbEIsY0FBYyxFQUNkLGVBQWUsUUFDVix1QkFBdUI7QUFDOUIsU0FBUyxhQUFhLFFBQVEsY0FBYztBQUM1QyxTQUFTLGNBQWMsRUFBRSxpQkFBaUIsUUFBUSx5QkFBeUI7QUFDM0UsU0FBUyxpQkFBaUIsUUFBUSxtQkFBbUI7QUFFckQ7Ozs7Ozs7Ozs7Ozs7Q0FhQyxHQUNELE9BQU8sTUFBTSwyQkFBMkIsa0JB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
// denoCacheMetadata=4600528031540412849,10662480689254892058