/**
 * Anthropic prompt-cache hit-rate telemetry (Issue #4282).
 *
 * The API reports, per invocation, how many prompt tokens were read from the
 * server-side cache (`cacheReadTokens`), how many were written into it
 * (`cacheCreationTokens`), and how many were charged as plain input
 * (`inputTokens`). Those three are the whole prompt; the share served from
 * cache is the hit rate.
 *
 * This is distinct from the worker's own disk prompt cache (Issue #1272), whose
 * hit/miss is logged per run as `Prompt cache: … status=hit`. That one measures
 * whether the worker re-assembled the prompt string; this one measures whether
 * Anthropic re-read the prefix at ~10% of the input price.
 *
 * A hit rate that falls is the observable symptom of a volatile token entering
 * the stable prefix, so it is aggregated into the run stats and the credit
 * summary rather than left to be inferred from the bill.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { TokenUsage } from "./token_usage.ts";

/** Prompt-cache effectiveness for one or more invocations. */
export interface CacheHitRate {
  /** Prompt tokens served from the cache. */
  cacheReadTokens: number;
  /** Prompt tokens written into the cache (charged at the write rate). */
  cacheCreationTokens: number;
  /** Prompt tokens charged as uncached input. */
  uncachedInputTokens: number;
  /** All prompt tokens: read + write + uncached input. */
  promptTokens: number;
  /** Share of prompt tokens served from cache, 0–1 (0 when nothing measured). */
  hitRate: number;
  /** Whether any prompt tokens were seen at all. */
  measured: boolean;
}

/**
 * Hit rate below which the prefix is treated as having regressed.
 *
 * A healthy run re-reads a large static prefix on every turn, so the cached
 * share dominates. Half the prompt arriving uncached means the prefix is no
 * longer stable — the exact regression this telemetry exists to catch.
 */
export const CACHE_HIT_RATE_FLOOR = 0.5;

/**
 * Prompt tokens required before a low hit rate counts as a regression.
 *
 * The first turn of any session necessarily writes the cache rather than
 * reading it, and short Haiku phases never reach the cacheable minimum at all.
 * Judging those as regressions would cry wolf, so the floor only applies once
 * a run has accumulated a meaningful prompt volume.
 */
export const CACHE_HIT_RATE_MIN_TOKENS = 50_000;

/** Sum the prompt-token fields of the supplied usage records. */
function sumUsage(
  usage: TokenUsage | readonly TokenUsage[] | undefined,
): { read: number; write: number; input: number } {
  const list = usage === undefined
    ? []
    : Array.isArray(usage)
    ? usage as readonly TokenUsage[]
    : [usage as TokenUsage];

  let read = 0;
  let write = 0;
  let input = 0;
  for (const entry of list) {
    if (!entry) continue;
    read += entry.cacheReadTokens ?? 0;
    write += entry.cacheCreationTokens ?? 0;
    input += entry.inputTokens ?? 0;
  }
  return { read, write, input };
}

/**
 * Compute the prompt-cache hit rate for one invocation or a set of them.
 *
 * Output tokens are excluded — they are generated, never cached, and including
 * them would dilute the rate with something the prefix cannot influence.
 *
 * @param usage - Token usage for one invocation, or several to aggregate
 * @returns The hit rate, with `measured: false` when no prompt tokens were seen
 */
export function computeCacheHitRate(
  usage: TokenUsage | readonly TokenUsage[] | undefined,
): CacheHitRate {
  const { read, write, input } = sumUsage(usage);
  const promptTokens = read + write + input;
  return {
    cacheReadTokens: read,
    cacheCreationTokens: write,
    uncachedInputTokens: input,
    promptTokens,
    hitRate: promptTokens > 0 ? read / promptTokens : 0,
    measured: promptTokens > 0,
  };
}

/**
 * Report whether the hit rate has regressed below {@link CACHE_HIT_RATE_FLOOR}.
 *
 * Only meaningful once {@link CACHE_HIT_RATE_MIN_TOKENS} prompt tokens have
 * been seen; smaller samples return false rather than a false alarm.
 *
 * @param rate - A computed hit rate
 * @returns True when the sample is large enough and the rate is below the floor
 */
export function isCacheHitRateRegressed(rate: CacheHitRate): boolean {
  return rate.measured &&
    rate.promptTokens >= CACHE_HIT_RATE_MIN_TOKENS &&
    rate.hitRate < CACHE_HIT_RATE_FLOOR;
}

/**
 * Render a hit rate as a single human-readable line.
 *
 * @param rate - A computed hit rate
 * @returns e.g. `"87.4% (read 1,200,000 · write 40,000 · uncached 132,000)"`,
 *   or `"not measured"` when no prompt tokens were reported
 */
export function formatCacheHitRate(rate: CacheHitRate): string {
  if (!rate.measured) return "not measured";
  const pct = (rate.hitRate * 100).toFixed(1);
  return `${pct}% (read ${rate.cacheReadTokens.toLocaleString()} · write ${rate.cacheCreationTokens.toLocaleString()} · uncached ${rate.uncachedInputTokens.toLocaleString()})`;
}

/**
 * Build the operator-facing warning for a regressed hit rate.
 *
 * Returns undefined when there is nothing to warn about, so callers can log
 * unconditionally with `if (msg) logger.warn(msg)`.
 *
 * @param rate - A computed hit rate
 * @param context - What the rate covers (e.g. a repo, a date, a phase)
 * @returns The warning text, or undefined when the rate is healthy
 */
export function cacheHitRateWarning(
  rate: CacheHitRate,
  context: string,
): string | undefined {
  if (!isCacheHitRateRegressed(rate)) return undefined;
  return `Prompt-cache hit rate for ${context} is ${
    formatCacheHitRate(rate)
  } — below the ${
    (CACHE_HIT_RATE_FLOOR * 100).toFixed(0)
  }% floor. A volatile token (timestamp, run id, reordered prefix section) has ` +
    `most likely entered the stable prompt prefix.`;
}
