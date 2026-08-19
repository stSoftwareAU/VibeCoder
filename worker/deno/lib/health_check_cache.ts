/**
 * Health check caching for Claude CLI and GitHub auth (Issue #635, #906).
 *
 * Health checks (Claude CLI, GitHub auth) are expensive — they invoke external
 * commands with timeouts. This module caches the result of a successful health
 * check for a configurable TTL (default 5 minutes) so that repeated checks
 * within the same scan cycle do not add overhead.
 *
 * Cache is file-based: a single file per check type containing the Unix
 * timestamp of the last successful check. On failure the cache is invalidated
 * so the next call always re-checks.
 *
 * Migrated from worker/shared/health_check_cache.sh (Issue #906).
 */

import type { Result } from "../types.ts";
import { atomicWriteSync } from "./file_utils.ts";

/** Default cache TTL in seconds (15 minutes for multi-worker deployments, Issue #1070). */
export const DEFAULT_HEALTH_CACHE_TTL = 900;

/**
 * Return the cache file path for a given check type.
 *
 * @param workDir - Directory for cache files
 * @param checkType - Identifier for the health check (e.g., "claude", "gh_auth")
 * @returns Absolute file path
 */
export function healthCacheFilePath(
  workDir: string,
  checkType: string,
): string {
  return `${workDir}/.health_cache_${checkType}`;
}

/**
 * Check whether a cached health check is still fresh.
 *
 * Reads the Unix timestamp from the cache file and compares it against
 * the current time. Returns ok:true if the cache is within TTL.
 *
 * @param workDir - Directory containing cache files
 * @param checkType - Identifier for the health check
 * @param ttlSeconds - TTL in seconds (default: DEFAULT_HEALTH_CACHE_TTL)
 * @param nowFn - Injectable time source (default: Date.now)
 * @returns Result with true if cache is valid, false if expired/missing
 */
export function isHealthCacheValid(
  workDir: string,
  checkType: string,
  ttlSeconds: number = DEFAULT_HEALTH_CACHE_TTL,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Result<boolean> {
  const cacheFile = healthCacheFilePath(workDir, checkType);

  let content: string;
  try {
    content = Deno.readTextFileSync(cacheFile).trim();
  } catch {
    return { ok: true, value: false };
  }

  if (!content || !/^\d+$/.test(content)) {
    return { ok: true, value: false };
  }

  const cachedTime = parseInt(content, 10);
  const now = nowFn();
  const elapsed = now - cachedTime;

  return { ok: true, value: elapsed < ttlSeconds };
}

/**
 * Record that a health check passed.
 *
 * Writes the current Unix timestamp to the cache file so subsequent
 * calls to isHealthCacheValid will return true until the TTL expires.
 *
 * @param workDir - Directory for cache files
 * @param checkType - Identifier for the health check
 * @param nowFn - Injectable time source (default: Date.now)
 * @returns Result indicating success or failure
 */
export function recordHealthCheckSuccess(
  workDir: string,
  checkType: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Result<void> {
  return atomicWriteSync({
    targetFile: healthCacheFilePath(workDir, checkType),
    content: String(nowFn()),
  });
}

// ---------------------------------------------------------------------------
// Value-bearing Fable-availability cache (Issue #3230)
// ---------------------------------------------------------------------------

/**
 * Check type (cache-file suffix) for the Fable-availability probe.
 *
 * The cache file is `.health_cache_fable`, sharing the same directory and TTL
 * as the boolean Claude/GitHub health caches.
 */
export const FABLE_CHECK_TYPE = "fable";

/** A concrete Fable-availability verdict. */
export type FableAvailability = "available" | "unavailable";

/**
 * The result of reading the Fable-availability cache: a fresh verdict, or
 * `"unknown"` when the cache is missing, expired, or malformed.
 *
 * Callers treat `"unknown"` as optimistic ("assume available") and rely on the
 * mid-run fallback (#2720/#2724) to self-correct — a stale `available` costs at
 * most one wasted first call.
 */
export type FableCacheRead = FableAvailability | "unknown";

/** Matches a value-bearing Fable cache line: `<unix-seconds> <verdict>`. */
const FABLE_CACHE_LINE_RE = /^(\d+)\s+(available|unavailable)$/;

/**
 * Read the cached Fable-availability verdict, honouring the TTL.
 *
 * Unlike the boolean caches (a bare timestamp = "healthy"), the Fable cache
 * persists a *negative* result for the full TTL so the worker does not re-probe
 * Fable on every phase. A missing, expired, or malformed file returns
 * `"unknown"` — never a spurious verdict.
 *
 * @param workDir - Directory containing cache files
 * @param ttlSeconds - TTL in seconds (default: DEFAULT_HEALTH_CACHE_TTL)
 * @param nowFn - Injectable time source (default: Date.now)
 * @returns `"available"`, `"unavailable"`, or `"unknown"`
 */
export function readFableAvailability(
  workDir: string,
  ttlSeconds: number = DEFAULT_HEALTH_CACHE_TTL,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): FableCacheRead {
  const cacheFile = healthCacheFilePath(workDir, FABLE_CHECK_TYPE);

  let content: string;
  try {
    content = Deno.readTextFileSync(cacheFile).trim();
  } catch {
    return "unknown";
  }

  const match = FABLE_CACHE_LINE_RE.exec(content);
  if (!match) {
    return "unknown";
  }

  const cachedTime = parseInt(match[1]!, 10);
  const verdict = match[2] as FableAvailability;
  const elapsed = nowFn() - cachedTime;

  return elapsed < ttlSeconds ? verdict : "unknown";
}

/**
 * Record a Fable-availability verdict, persisted for the TTL.
 *
 * Writes `<unix-seconds> available` or `<unix-seconds> unavailable` atomically
 * (temp file + rename), so both a positive and a negative verdict survive for
 * the full TTL window.
 *
 * @param workDir - Directory for cache files
 * @param available - Whether Fable was reachable
 * @param nowFn - Injectable time source (default: Date.now)
 * @returns Result indicating success or failure
 */
export function recordFableAvailability(
  workDir: string,
  available: boolean,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Result<void> {
  return atomicWriteSync({
    targetFile: healthCacheFilePath(workDir, FABLE_CHECK_TYPE),
    content: `${nowFn()} ${available ? "available" : "unavailable"}`,
  });
}

/**
 * Invalidate (remove) the cache file for a health check.
 *
 * Called after a health check failure so the next call always re-checks
 * rather than returning a stale success.
 *
 * @param workDir - Directory for cache files
 * @param checkType - Identifier for the health check
 * @returns Result indicating success or failure
 */
export function invalidateHealthCache(
  workDir: string,
  checkType: string,
): Result<void> {
  const cacheFile = healthCacheFilePath(workDir, checkType);

  try {
    Deno.removeSync(cacheFile);
  } catch (err) {
    // File not found is fine — already invalidated
    if (!(err instanceof Deno.errors.NotFound)) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  return { ok: true, value: undefined };
}
