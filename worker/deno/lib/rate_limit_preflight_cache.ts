/**
 * File-backed cache for the GitHub rate-limit pre-flight result (Issue #1675).
 *
 * The pre-flight call (`gh api rate_limit`) is free — it does not consume
 * quota — but it is still a network round-trip executed at the start of
 * every worker process. Because the supervisor respawns the worker
 * frequently, that round-trip dominates the start-up latency when the
 * quota is healthy and never changes.
 *
 * This cache stores the parsed pre-flight result on disk for a short TTL
 * so back-to-back respawns within the window can skip the network call
 * entirely. The cache is deliberately conservative:
 *
 *   - Short TTL (default 90 seconds — within the 1–2 minute window
 *     specified by the issue).
 *   - Never used when the rate-limit signal file is active (the caller
 *     short-circuits before consulting the cache).
 *   - Bypassed automatically when the remaining quota is within 2× the
 *     pre-flight threshold, so we re-check before quota exhaustion.
 *   - Bypassed entirely when the caller passes `noCache=true`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

/** Cache file name. */
const CACHE_FILENAME = ".rate_limit_preflight_cache";

/** Default TTL for cache entries (seconds). */
export const DEFAULT_PREFLIGHT_CACHE_TTL_SECONDS = 90;

/** Persisted cache payload. */
export interface PreflightCacheData {
  /** Unix timestamp (seconds) when the entry was written. */
  timestamp: number;
  /** Quota remaining at the time of the live check. */
  remaining: number;
  /** Total quota limit at the time of the live check. */
  limit: number;
  /** Reset epoch (seconds) reported by GitHub. */
  reset: number;
}

/**
 * Return the path to the pre-flight cache file.
 */
export function rateLimitPreflightCachePath(workDir: string): string {
  return `${workDir}/${CACHE_FILENAME}`;
}

/**
 * Write a pre-flight cache entry.
 *
 * Callers should only write when the live check returned a healthy
 * result that is safe to reuse — see `shouldCachePreflight` for the
 * recommended guard.
 */
export async function writePreflightCache(
  workDir: string,
  data: PreflightCacheData,
): Promise<Result<void>> {
  try {
    await Deno.writeTextFile(
      rateLimitPreflightCachePath(workDir),
      JSON.stringify(data),
    );
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `Failed to write pre-flight cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
}

/**
 * Read a fresh pre-flight cache entry, if available.
 *
 * Returns an error result when the file is missing, malformed, or older
 * than the supplied TTL. Callers treat any error as a cache miss and
 * fall through to the live check.
 */
export async function readPreflightCache(
  workDir: string,
  nowSeconds: () => number,
  ttlSeconds: number = DEFAULT_PREFLIGHT_CACHE_TTL_SECONDS,
): Promise<Result<PreflightCacheData>> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(rateLimitPreflightCachePath(workDir));
  } catch {
    return {
      ok: false,
      error: new Error("pre-flight cache file not found"),
    };
  }

  let parsed: PreflightCacheData;
  try {
    parsed = JSON.parse(raw) as PreflightCacheData;
  } catch (error: unknown) {
    return {
      ok: false,
      error: new Error(
        `pre-flight cache parse failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }

  if (
    typeof parsed.timestamp !== "number" ||
    typeof parsed.remaining !== "number" ||
    typeof parsed.limit !== "number" ||
    typeof parsed.reset !== "number"
  ) {
    return { ok: false, error: new Error("pre-flight cache schema invalid") };
  }

  const age = nowSeconds() - parsed.timestamp;
  if (!Number.isFinite(age) || age < 0 || age > ttlSeconds) {
    return { ok: false, error: new Error("pre-flight cache stale") };
  }

  return { ok: true, value: parsed };
}

/**
 * Decide whether a live pre-flight result should be cached.
 *
 * The rule mirrors the read-side bypass: only cache values that are
 * comfortably above the threshold (at least 2×). Near-threshold values
 * are deliberately not cached so the next iteration always re-checks
 * before quota exhaustion.
 */
export function shouldCachePreflight(
  remaining: number,
  threshold: number,
): boolean {
  return remaining >= threshold * 2;
}
