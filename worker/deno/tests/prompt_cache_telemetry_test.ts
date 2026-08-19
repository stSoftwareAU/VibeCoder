/**
 * Tests for Anthropic prompt-cache hit-rate telemetry (Issue #4282).
 *
 * Covers the rate computation itself and the three surfaces it is aggregated
 * into: the run stats, the run-stats comment, and the daily credit summary.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CACHE_HIT_RATE_FLOOR,
  cacheHitRateWarning,
  computeCacheHitRate,
  formatCacheHitRate,
  isCacheHitRateRegressed,
} from "../lib/prompt_cache_telemetry.ts";
import { aggregateRunStats, type RunStats } from "../lib/run_stats.ts";
import { buildPlanningStatsSection } from "../lib/planning_run_stats.ts";
import {
  formatSummary,
  getDailySummary,
  logInvocation,
} from "../lib/credit_tracker.ts";
import type { TokenUsage } from "../lib/token_usage.ts";

function usage(
  input: number,
  output: number,
  write: number,
  read: number,
): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: write,
    cacheReadTokens: read,
  };
}

// ---------------------------------------------------------------------------
// computeCacheHitRate
// ---------------------------------------------------------------------------

Deno.test("computeCacheHitRate - reports the cached share of prompt tokens", () => {
  const rate = computeCacheHitRate(usage(1_000, 5_000, 1_000, 8_000));
  assertEquals(rate.promptTokens, 10_000);
  assertEquals(rate.hitRate, 0.8);
  assertEquals(rate.measured, true);
});

Deno.test("computeCacheHitRate - output tokens never affect the rate", () => {
  const withOutput = computeCacheHitRate(usage(1_000, 900_000, 0, 9_000));
  const withoutOutput = computeCacheHitRate(usage(1_000, 0, 0, 9_000));
  assertEquals(withOutput.hitRate, withoutOutput.hitRate);
});

Deno.test("computeCacheHitRate - sums a list of invocations", () => {
  const rate = computeCacheHitRate([
    usage(1_000, 10, 4_000, 0),
    usage(1_000, 10, 0, 14_000),
  ]);
  assertEquals(rate.promptTokens, 20_000);
  assertEquals(rate.cacheReadTokens, 14_000);
  assertEquals(rate.hitRate, 0.7);
});

Deno.test("computeCacheHitRate - no usage is 'not measured', never a zero rate", () => {
  const empty = computeCacheHitRate(undefined);
  assertEquals(empty.measured, false);
  assertEquals(empty.hitRate, 0);
  assertEquals(formatCacheHitRate(empty), "not measured");
  assertEquals(isCacheHitRateRegressed(empty), false);
  assertEquals(computeCacheHitRate([]).measured, false);
  assertEquals(computeCacheHitRate(usage(0, 0, 0, 0)).measured, false);
});

Deno.test("computeCacheHitRate - a fully uncached prompt rates zero", () => {
  const rate = computeCacheHitRate(usage(80_000, 2_000, 0, 0));
  assertEquals(rate.hitRate, 0);
  assertEquals(rate.measured, true);
});

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

Deno.test("isCacheHitRateRegressed - flags a large sample below the floor", () => {
  const rate = computeCacheHitRate(usage(80_000, 1_000, 0, 20_000));
  assert(rate.hitRate < CACHE_HIT_RATE_FLOOR);
  assertEquals(isCacheHitRateRegressed(rate), true);
  const warning = cacheHitRateWarning(rate, "owner/repo");
  assert(warning, "a regression must produce a warning");
  assertStringIncludes(warning, "owner/repo");
  assertStringIncludes(warning, "volatile token");
});

Deno.test("isCacheHitRateRegressed - a small sample is not a regression", () => {
  // The first turn of any session writes the cache rather than reading it.
  const rate = computeCacheHitRate(usage(1_200, 400, 900, 0));
  assertEquals(rate.hitRate, 0);
  assertEquals(isCacheHitRateRegressed(rate), false);
  assertEquals(cacheHitRateWarning(rate, "owner/repo"), undefined);
});

Deno.test("isCacheHitRateRegressed - a healthy rate is not flagged", () => {
  const rate = computeCacheHitRate(usage(10_000, 1_000, 10_000, 180_000));
  assertEquals(isCacheHitRateRegressed(rate), false);
  assertEquals(cacheHitRateWarning(rate, "owner/repo"), undefined);
});

Deno.test("formatCacheHitRate - renders percentage and token split", () => {
  const text = formatCacheHitRate(
    computeCacheHitRate(usage(1_000, 0, 1_000, 8_000)),
  );
  assertStringIncludes(text, "80.0%");
  assertStringIncludes(text, "read 8,000");
  assertStringIncludes(text, "write 1,000");
  assertStringIncludes(text, "uncached 1,000");
});

// ---------------------------------------------------------------------------
// Aggregation into the run stats (Issue #2647)
// ---------------------------------------------------------------------------

function runStats(tokenUsage: TokenUsage): RunStats {
  return {
    servedModels: ["claude-opus-4-8"],
    requestedModel: "claude-opus-4-8",
    effort: "high",
    tokenUsage,
    numTurns: 12,
    durationMs: 1_000,
    wallClockMs: 1_000,
  };
}

Deno.test("aggregateRunStats - carries the cache hit rate for the cycle", () => {
  const agg = aggregateRunStats([
    runStats(usage(1_000, 100, 4_000, 0)),
    runStats(usage(1_000, 100, 0, 14_000)),
  ]);
  assertEquals(agg.cacheHitRate.promptTokens, 20_000);
  assertEquals(agg.cacheHitRate.hitRate, 0.7);
});

Deno.test("aggregateRunStats - an empty cycle reports an unmeasured rate", () => {
  assertEquals(aggregateRunStats([]).cacheHitRate.measured, false);
});

Deno.test("run-stats section - reports the prompt-cache hit rate", () => {
  const section = buildPlanningStatsSection({
    invocations: [
      {
        phase: "planning",
        runStats: runStats(usage(2_000, 500, 8_000, 90_000)),
      },
    ],
    expectedModel: "claude-opus-4-8",
    verdict: { degraded: false, indeterminate: false, reason: "" },
  });
  assertStringIncludes(section, "Prompt cache:");
  assertStringIncludes(section, "90.0%");
});

Deno.test("run-stats section - omits the hit rate when no tokens were reported", () => {
  const noTokens: RunStats = {
    servedModels: ["claude-opus-4-8"],
    requestedModel: "claude-opus-4-8",
    wallClockMs: 500,
  };
  const section = buildPlanningStatsSection({
    invocations: [
      { phase: "planning", runStats: noTokens },
    ],
    expectedModel: "claude-opus-4-8",
    verdict: { degraded: false, indeterminate: false, reason: "" },
  });
  assertEquals(section.includes("Prompt cache:"), false);
});

// ---------------------------------------------------------------------------
// Aggregation into the credit log (Issue #1074)
// ---------------------------------------------------------------------------

async function withLogDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-cache-telemetry-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("credit summary - aggregates the day's prompt-cache hit rate", async () => {
  await withLogDir(async (logDir) => {
    const date = new Date().toISOString().slice(0, 10);
    for (
      const entry of [
        usage(5_000, 500, 20_000, 0),
        usage(5_000, 500, 0, 170_000),
      ]
    ) {
      await logInvocation({
        logDir,
        workerName: "worker-1",
        phase: "issue",
        repo: "owner/repo",
        model: "claude-opus-4-8",
        tokenUsage: entry,
      });
    }

    const summary = await getDailySummary({ logDir, date });
    assert(summary.ok, "summary must be produced");
    const rate = summary.value.promptCacheHitRate;
    assert(rate, "the summary must carry a hit rate");
    assertEquals(rate.promptTokens, 200_000);
    assertEquals(rate.hitRate, 0.85);

    const text = formatSummary(summary.value);
    assertStringIncludes(text, "Prompt cache hit rate:");
    assertStringIncludes(text, "85.0%");
    // Healthy rate — no regression warning.
    assertEquals(text.includes("below the 50% floor"), false);
  });
});

Deno.test("credit summary - warns when the day's hit rate regresses", async () => {
  await withLogDir(async (logDir) => {
    const date = new Date().toISOString().slice(0, 10);
    await logInvocation({
      logDir,
      workerName: "worker-1",
      phase: "issue",
      repo: "owner/repo",
      model: "claude-opus-4-8",
      tokenUsage: usage(180_000, 2_000, 0, 20_000),
    });

    const summary = await getDailySummary({ logDir, date });
    assert(summary.ok, "summary must be produced");
    const text = formatSummary(summary.value);
    assertStringIncludes(text, "Prompt cache hit rate:");
    assertStringIncludes(text, "below the 50% floor");
  });
});
