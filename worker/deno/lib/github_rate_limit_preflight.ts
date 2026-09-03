/**
 * Pre-flight GitHub rate-limit check.
 *
 * Called at the start of the worker main loop. Uses `gh api rate_limit`,
 * which is a free call (does not consume quota) and works even when the
 * quota is already exhausted. If the primary GraphQL quota is below a
 * safe threshold, writes the shared rate-limit signal file so subsequent
 * respawns can short-circuit without burning API calls through init and
 * priority dispatch.
 *
 * Motivation: prior to this check, a quota-exhausted worker would run
 * full initialisation (git reset, auth check, stuck-issue recovery,
 * priorities 1–1.72) before hitting the rate-limit error at priority
 * 1.75 — ~10+ wasted gh calls every ~2 minutes while the supervisor
 * respawned it. See also Issue #1523 (graceful main-loop exit).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  isRateLimitActive,
  writeRateLimitSignal,
} from "./rate_limit_signal.ts";
import {
  DEFAULT_PREFLIGHT_CACHE_TTL_SECONDS,
  readPreflightCache,
  shouldCachePreflight,
  writePreflightCache,
} from "./rate_limit_preflight_cache.ts";

/** Minimum GraphQL primary-quota remaining before we treat the worker as safe to proceed. */
export const DEFAULT_PREFLIGHT_THRESHOLD = 50;

/** Maximum wait written into the signal when the reset timestamp is missing/past. */
const MAX_FALLBACK_WAIT_SECONDS = 3600;

/** Minimum wait written into the signal when rate-limited (gives the supervisor a real backoff). */
const MIN_WAIT_SECONDS = 60;

/** Outcome of the pre-flight check. */
export interface PreflightOutcome {
  /** Whether the worker should halt (rate-limited or signal already active). */
  rateLimited: boolean;
  /** Seconds remaining in the wait window when rateLimited=true. */
  remainingSeconds: number;
  /** Human-readable reason, suitable for logging. */
  message: string;
}

/** Dependency injection for testing. */
export interface PreflightDeps {
  /** Working directory where the signal file lives. */
  workDir: string;
  /**
   * Run `gh api rate_limit` and return the raw JSON string.
   * Production implementation should use runGhCommandRaw (no retry —
   * this call must never block init on transient failures).
   */
  runGhRateLimit: () => Promise<string>;
  /** Current Unix time in seconds (injectable for tests). */
  nowSeconds: () => number;
  /** Log sink. */
  log: (message: string) => void;
  /** Threshold below which we treat the worker as rate-limited (default: 50). */
  threshold?: number;
  /**
   * When true, the file-backed cache is bypassed entirely — every call
   * performs a fresh `gh api rate_limit` request (Issue #1675). The cache
   * is also bypassed automatically when the rate-limit signal file is
   * active or when the cached quota is within 2× the threshold.
   */
  noCache?: boolean;
  /**
   * TTL for cached pre-flight results, in seconds. Defaults to
   * {@link DEFAULT_PREFLIGHT_CACHE_TTL_SECONDS} (90s) — short enough that
   * the worker re-checks well within GitHub's hourly reset window, long
   * enough to skip the round-trip across back-to-back respawns.
   */
  cacheTtlSeconds?: number;
}

interface RateLimitResource {
  limit: number;
  used: number;
  remaining: number;
  reset: number;
}

interface RateLimitResponse {
  resources?: {
    graphql?: RateLimitResource;
    core?: RateLimitResource;
  };
}

/**
 * Parse the `gh api rate_limit` JSON payload.
 *
 * Returns the GraphQL resource (falling back to core if GraphQL is
 * missing — older GitHub Enterprise installations may not expose
 * graphql under resources).
 */
function parseRateLimitResponse(
  raw: string,
): Result<RateLimitResource> {
  try {
    const parsed = JSON.parse(raw) as RateLimitResponse;
    const resource = parsed.resources?.graphql ?? parsed.resources?.core;
    if (
      !resource ||
      typeof resource.remaining !== "number" ||
      typeof resource.reset !== "number"
    ) {
      return {
        ok: false,
        error: new Error("rate_limit response missing resources.graphql/core"),
      };
    }
    return { ok: true, value: resource };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: new Error(`rate_limit JSON parse failed: ${msg}`),
    };
  }
}

/**
 * Compute the backoff wait (seconds) from a reset timestamp.
 *
 * Uses the reset epoch from GitHub's response when it's in the future;
 * falls back to MAX_FALLBACK_WAIT_SECONDS when the reset is already in
 * the past (clock skew or unexpected payload). Always enforces a
 * MIN_WAIT_SECONDS floor so the supervisor has a chance to idle.
 */
function computeWaitSeconds(resetEpoch: number, nowEpoch: number): number {
  const delta = resetEpoch - nowEpoch;
  if (!Number.isFinite(delta) || delta <= 0) {
    return MAX_FALLBACK_WAIT_SECONDS;
  }
  return Math.max(
    MIN_WAIT_SECONDS,
    Math.min(MAX_FALLBACK_WAIT_SECONDS, Math.ceil(delta)),
  );
}

/**
 * Check GitHub's primary GraphQL rate limit before the worker proceeds.
 *
 * Behaviour:
 *   1. If the shared signal file is already active, return rateLimited=true
 *      immediately (no gh call — the previous worker already told us).
 *   2. Otherwise consult the file-backed cache (Issue #1675):
 *      - Cache hit and remaining ≥ 2× threshold → return cached result
 *        without a network call.
 *      - Cache miss, stale, or near-threshold → fall through to the live
 *        check.
 *      - When `noCache=true`, the cache step is skipped entirely.
 *   3. Live check via `gh api rate_limit`:
 *      - Parse failure or gh failure: fail-open (return rateLimited=false,
 *        log a warning). Refusing to start the worker because we can't
 *        check the quota would be worse than proceeding.
 *      - Remaining below threshold: write the signal file with a backoff
 *        derived from the reset timestamp, return rateLimited=true.
 *      - Remaining at or above threshold: return rateLimited=false. The
 *        result is written to the cache when it is comfortably above the
 *        threshold.
 */
export async function preflightGitHubRateLimit(
  deps: PreflightDeps,
): Promise<PreflightOutcome> {
  const threshold = deps.threshold ?? DEFAULT_PREFLIGHT_THRESHOLD;
  const cacheTtl = deps.cacheTtlSeconds ?? DEFAULT_PREFLIGHT_CACHE_TTL_SECONDS;

  // Step 1: existing signal short-circuit. Always bypass cache here —
  // an active signal means a previous worker already detected exhaustion.
  const existing = await isRateLimitActive(deps.workDir, deps.nowSeconds);
  if (existing.ok && existing.value.active) {
    return {
      rateLimited: true,
      remainingSeconds: existing.value.remainingSeconds,
      message:
        `Rate-limit signal still active (${existing.value.remainingSeconds}s remaining)`,
    };
  }

  // Step 2: try the cache when the caller has not explicitly disabled it.
  if (!deps.noCache) {
    const cached = await readPreflightCache(
      deps.workDir,
      deps.nowSeconds,
      cacheTtl,
    );
    if (cached.ok && cached.value.remaining >= threshold * 2) {
      return {
        rateLimited: false,
        remainingSeconds: 0,
        message:
          `GraphQL quota healthy (cached): ${cached.value.remaining}/${cached.value.limit} remaining`,
      };
    }
  }

  // Step 3: live check via gh.
  let raw: string;
  try {
    raw = await deps.runGhRateLimit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(
      `Pre-flight rate_limit check failed — proceeding without it: ${msg}`,
    );
    return {
      rateLimited: false,
      remainingSeconds: 0,
      message: `pre-flight check failed: ${msg}`,
    };
  }

  const parsed = parseRateLimitResponse(raw);
  if (!parsed.ok) {
    deps.log(
      `Pre-flight rate_limit parse failed — proceeding without it: ${parsed.error.message}`,
    );
    return {
      rateLimited: false,
      remainingSeconds: 0,
      message: parsed.error.message,
    };
  }

  const { remaining, reset, limit } = parsed.value;
  if (remaining >= threshold) {
    // Persist healthy results when comfortably above the threshold so
    // subsequent respawns can short-circuit without the round-trip
    // (Issue #1675). Near-threshold values are deliberately not cached
    // so the next iteration always re-checks before quota exhaustion.
    if (shouldCachePreflight(remaining, threshold)) {
      const cacheWrite = await writePreflightCache(deps.workDir, {
        timestamp: deps.nowSeconds(),
        remaining,
        limit,
        reset,
      });
      if (!cacheWrite.ok) {
        deps.log(
          `Pre-flight cache write failed (continuing): ${cacheWrite.error.message}`,
        );
      }
    }
    return {
      rateLimited: false,
      remainingSeconds: 0,
      message: `GraphQL quota healthy: ${remaining}/${limit} remaining`,
    };
  }

  // Rate-limited: record signal for siblings/respawns.
  const now = deps.nowSeconds();
  const waitSeconds = computeWaitSeconds(reset, now);
  const writeResult = await writeRateLimitSignal(
    deps.workDir,
    waitSeconds,
    undefined,
    "github",
  );
  if (!writeResult.ok) {
    deps.log(
      `Pre-flight detected rate limit but signal write failed: ${writeResult.error.message}`,
    );
  }

  return {
    rateLimited: true,
    remainingSeconds: waitSeconds,
    message:
      `GraphQL quota low: ${remaining}/${limit} remaining, reset in ${waitSeconds}s`,
  };
}
