/**
 * Tests for token_usage.ts — token extraction and cost estimation (Issue #1260).
 *
 * Uses Australian English throughout.
 */

import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  estimateCost,
  estimateCostWithUpperBound,
  extractTokenUsage,
  lookupModelPricing,
  type TokenUsage,
} from "../lib/token_usage.ts";

// =============================================================================
// extractTokenUsage tests
// =============================================================================

Deno.test("token_usage - extractTokenUsage returns null for empty input", () => {
  assertEquals(extractTokenUsage(""), null);
  assertEquals(extractTokenUsage("   "), null);
});

Deno.test("token_usage - extractTokenUsage extracts usage from result line", () => {
  const streamOutput = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
    '{"type":"result","result":"Hello","usage":{"input_tokens":150,"output_tokens":50,"cache_creation_input_tokens":10,"cache_read_input_tokens":80}}',
  ].join("\n");

  const usage = extractTokenUsage(streamOutput);
  assertEquals(usage, {
    inputTokens: 150,
    outputTokens: 50,
    cacheCreationTokens: 10,
    cacheReadTokens: 80,
  });
});

Deno.test("token_usage - extractTokenUsage handles missing cache fields", () => {
  const streamOutput =
    '{"type":"result","result":"OK","usage":{"input_tokens":100,"output_tokens":25}}';

  const usage = extractTokenUsage(streamOutput);
  assertEquals(usage, {
    inputTokens: 100,
    outputTokens: 25,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
});

Deno.test("token_usage - extractTokenUsage returns null when no result line", () => {
  const streamOutput = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
    '{"type":"content_block_stop"}',
  ].join("\n");

  assertEquals(extractTokenUsage(streamOutput), null);
});

Deno.test("token_usage - extractTokenUsage returns null when result has no usage", () => {
  const streamOutput = '{"type":"result","result":"OK"}';
  assertEquals(extractTokenUsage(streamOutput), null);
});

Deno.test("token_usage - extractTokenUsage skips malformed lines gracefully", () => {
  const streamOutput = [
    "not-json-at-all",
    '{"type":"result","result":"OK","usage":{"input_tokens":200,"output_tokens":100,"cache_creation_input_tokens":5,"cache_read_input_tokens":50}}',
  ].join("\n");

  const usage = extractTokenUsage(streamOutput);
  assertEquals(usage?.inputTokens, 200);
  assertEquals(usage?.outputTokens, 100);
});

Deno.test("token_usage - extractTokenUsage handles zero token counts", () => {
  const streamOutput =
    '{"type":"result","result":"","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}';

  const usage = extractTokenUsage(streamOutput);
  assertEquals(usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
});

// =============================================================================
// lookupModelPricing tests
// =============================================================================

Deno.test("token_usage - lookupModelPricing returns pricing for Fable 5 full id (Issue #2619)", () => {
  const pricing = lookupModelPricing("claude-fable-5");
  assertEquals(pricing?.inputPerMillion, 10);
  assertEquals(pricing?.outputPerMillion, 50);
  assertEquals(pricing?.cacheWritePerMillion, 12.50);
  assertEquals(pricing?.cacheReadPerMillion, 1);
});

Deno.test("token_usage - lookupModelPricing returns pricing for bare fable alias (Issue #2619)", () => {
  const pricing = lookupModelPricing("fable");
  assertEquals(pricing?.inputPerMillion, 10);
  assertEquals(pricing?.outputPerMillion, 50);
  assertEquals(pricing?.cacheWritePerMillion, 12.50);
  assertEquals(pricing?.cacheReadPerMillion, 1);
});

Deno.test("token_usage - lookupModelPricing returns pricing for Opus 5 (Issue #3559)", () => {
  const pricing = lookupModelPricing("claude-opus-5");
  assertEquals(pricing?.inputPerMillion, 5);
  assertEquals(pricing?.outputPerMillion, 25);
  assertEquals(pricing?.cacheWritePerMillion, 6.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.50);
});

Deno.test("token_usage - lookupModelPricing tier fallback gives current Opus pricing for unknown 5-family minor (Issue #3559)", () => {
  // A future dated 5-family id with no explicit MODEL_PRICING row must still
  // resolve via the extended minor-version parser rather than dropping to null.
  const pricing = lookupModelPricing("claude-opus-5-1-20260901");
  assertEquals(pricing?.inputPerMillion, 5);
  assertEquals(pricing?.outputPerMillion, 25);
  assertEquals(pricing?.cacheWritePerMillion, 6.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.50);
});

Deno.test("token_usage - lookupModelPricing returns pricing for Opus 4.7", () => {
  const pricing = lookupModelPricing("claude-opus-4-7");
  assertEquals(pricing?.inputPerMillion, 5);
  assertEquals(pricing?.outputPerMillion, 25);
  assertEquals(pricing?.cacheWritePerMillion, 6.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.50);
});

Deno.test("token_usage - lookupModelPricing returns pricing for Opus 4.6", () => {
  const pricing = lookupModelPricing("claude-opus-4-6");
  assertEquals(pricing?.inputPerMillion, 5);
  assertEquals(pricing?.outputPerMillion, 25);
  assertEquals(pricing?.cacheWritePerMillion, 6.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.50);
});

Deno.test("token_usage - lookupModelPricing returns pricing for Opus 4.5", () => {
  const pricing = lookupModelPricing("claude-opus-4-5-20251101");
  assertEquals(pricing?.inputPerMillion, 5);
  assertEquals(pricing?.outputPerMillion, 25);
  assertEquals(pricing?.cacheWritePerMillion, 6.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.50);
});

Deno.test("token_usage - lookupModelPricing returns legacy pricing for Opus 4.0/4.1", () => {
  const opus41 = lookupModelPricing("claude-opus-4-1-20250805");
  assertEquals(opus41?.inputPerMillion, 15);
  assertEquals(opus41?.outputPerMillion, 75);

  const opus40 = lookupModelPricing("claude-opus-4-20250514");
  assertEquals(opus40?.inputPerMillion, 15);
  assertEquals(opus40?.outputPerMillion, 75);
});

Deno.test("token_usage - lookupModelPricing returns pricing for Sonnet 4.6 (Issue #2407)", () => {
  const pricing = lookupModelPricing("claude-sonnet-4-6");
  assertEquals(pricing?.inputPerMillion, 3);
  assertEquals(pricing?.outputPerMillion, 15);
  assertEquals(pricing?.cacheWritePerMillion, 3.75);
  assertEquals(pricing?.cacheReadPerMillion, 0.30);
});

Deno.test("token_usage - lookupModelPricing tier fallback gives current Sonnet pricing for unknown minor (Issue #2407)", () => {
  // An unknown-but-tiered Sonnet id must inherit the current Sonnet rate via
  // the tier-aware fallback rather than returning null.
  const pricing = lookupModelPricing("claude-sonnet-4-9");
  assertEquals(pricing?.inputPerMillion, 3);
  assertEquals(pricing?.outputPerMillion, 15);
  assertEquals(pricing?.cacheWritePerMillion, 3.75);
  assertEquals(pricing?.cacheReadPerMillion, 0.30);
});

Deno.test("token_usage - lookupModelPricing tier fallback gives current Haiku pricing for unknown minor (Issue #2407)", () => {
  // An unknown-but-tiered Haiku id must inherit the current Haiku rate via
  // the tier-aware fallback rather than returning null.
  const pricing = lookupModelPricing("claude-haiku-4-9");
  assertEquals(pricing?.inputPerMillion, 1);
  assertEquals(pricing?.outputPerMillion, 5);
  assertEquals(pricing?.cacheWritePerMillion, 1.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.10);
});

Deno.test("token_usage - lookupModelPricing returns pricing for Haiku 4.5", () => {
  const pricing = lookupModelPricing("claude-haiku-4-5");
  assertEquals(pricing?.inputPerMillion, 1);
  assertEquals(pricing?.outputPerMillion, 5);
  assertEquals(pricing?.cacheWritePerMillion, 1.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.10);
});

Deno.test("token_usage - lookupModelPricing returns pricing for Opus 4.8 (Issue #2389)", () => {
  const pricing = lookupModelPricing("claude-opus-4-8");
  assertEquals(pricing?.inputPerMillion, 5);
  assertEquals(pricing?.outputPerMillion, 25);
  assertEquals(pricing?.cacheWritePerMillion, 6.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.50);
});

Deno.test("token_usage - lookupModelPricing resolves bare 'opus' alias to current Opus pricing (Issue #2389)", () => {
  const pricing = lookupModelPricing("opus");
  assertEquals(pricing?.inputPerMillion, 5);
  assertEquals(pricing?.outputPerMillion, 25);
  assertEquals(pricing?.cacheWritePerMillion, 6.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.50);
});

Deno.test("token_usage - lookupModelPricing resolves bare 'sonnet'/'haiku' aliases (Issue #2389)", () => {
  const sonnet = lookupModelPricing("sonnet");
  assertEquals(sonnet?.inputPerMillion, 3);
  assertEquals(sonnet?.outputPerMillion, 15);

  const haiku = lookupModelPricing("haiku");
  assertEquals(haiku?.inputPerMillion, 1);
  assertEquals(haiku?.outputPerMillion, 5);
});

Deno.test("token_usage - lookupModelPricing tier fallback gives current Opus pricing for unknown minor (Issue #2389)", () => {
  // An unknown-but-tiered id must inherit current Opus pricing via the tier
  // fallback, NOT the legacy $15/$75 row.
  const pricing = lookupModelPricing("claude-opus-4-9");
  assertEquals(pricing?.inputPerMillion, 5);
  assertEquals(pricing?.outputPerMillion, 25);
  assertEquals(pricing?.cacheWritePerMillion, 6.25);
  assertEquals(pricing?.cacheReadPerMillion, 0.50);
});

Deno.test("token_usage - lookupModelPricing tier fallback handles two-digit future minors (Issue #2389)", () => {
  const pricing = lookupModelPricing("claude-opus-4-12-20260601");
  assertEquals(pricing?.inputPerMillion, 5);
  assertEquals(pricing?.outputPerMillion, 25);
});

Deno.test("token_usage - lookupModelPricing keeps legacy pricing for dated Opus 4.0 id (Issue #2389)", () => {
  // The 4.0 release uses a dated id with no minor; it must stay legacy.
  const pricing = lookupModelPricing("claude-opus-4-20250514");
  assertEquals(pricing?.inputPerMillion, 15);
  assertEquals(pricing?.outputPerMillion, 75);
});

Deno.test("token_usage - lookupModelPricing returns null for unknown model", () => {
  assertEquals(lookupModelPricing("gpt-4"), null);
  assertEquals(lookupModelPricing("unknown-model"), null);
});

Deno.test("token_usage - lookupModelPricing is case-insensitive", () => {
  const pricing = lookupModelPricing("Claude-Opus-4-7");
  assertEquals(pricing?.inputPerMillion, 5);
});

// =============================================================================
// estimateCost tests
// =============================================================================

Deno.test("token_usage - estimateCost calculates correct costs for sonnet", () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  };

  const cost = estimateCost(usage, "claude-sonnet-4-6");
  assertEquals(cost?.inputCost, 3);
  assertEquals(cost?.outputCost, 15);
  assertEquals(cost?.cacheWriteCost, 3.75);
  assertEquals(cost?.cacheReadCost, 0.30);
  assertAlmostEquals(cost!.totalCost, 22.05, 0.001);
});

Deno.test("token_usage - estimateCost calculates correct costs for fable (Issue #2619)", () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  };

  const cost = estimateCost(usage, "claude-fable-5");
  assertEquals(cost?.inputCost, 10);
  assertEquals(cost?.outputCost, 50);
  assertEquals(cost?.cacheWriteCost, 12.50);
  assertEquals(cost?.cacheReadCost, 1);
  assertAlmostEquals(cost!.totalCost, 73.50, 0.001);
});

Deno.test("token_usage - estimateCost returns null for unknown model", () => {
  const usage: TokenUsage = {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  assertEquals(estimateCost(usage, "unknown-model"), null);
});

Deno.test("token_usage - estimateCost handles zero tokens", () => {
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  const cost = estimateCost(usage, "claude-sonnet-4-6");
  assertEquals(cost?.totalCost, 0);
});

Deno.test("token_usage - estimateCost calculates realistic small invocation", () => {
  // A typical small invocation: 5000 input, 500 output tokens
  const usage: TokenUsage = {
    inputTokens: 5000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 3000,
  };

  const cost = estimateCost(usage, "claude-sonnet-4-6");
  // input: 5000/1M * 3 = 0.015
  // output: 500/1M * 15 = 0.0075
  // cache read: 3000/1M * 0.30 = 0.0009
  assertAlmostEquals(cost!.inputCost, 0.015, 0.0001);
  assertAlmostEquals(cost!.outputCost, 0.0075, 0.0001);
  assertAlmostEquals(cost!.cacheReadCost, 0.0009, 0.0001);
  assertAlmostEquals(cost!.totalCost, 0.0234, 0.0001);
});

Deno.test("token_usage - estimateCost prices Opus 4.8 at modern rate, not legacy (Issue #2389)", () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  const cost = estimateCost(usage, "claude-opus-4-8");
  // Modern Opus: input 5 + output 25 = 30. Legacy would be 15 + 75 = 90.
  assertEquals(cost?.inputCost, 5);
  assertEquals(cost?.outputCost, 25);
  assertEquals(cost?.totalCost, 30);
});

Deno.test("token_usage - budget fallback does not trip prematurely for Opus 4.8 run (Issue #2389)", () => {
  // Regression: the inflated legacy estimate (~3x) used to feed the
  // budget-exceeded guard, downgrading opus -> sonnet earlier than intended.
  // Under a representative per-run budget, the correctly-priced Opus 4.8 run
  // stays within budget, whereas the legacy mis-price would have exceeded it.
  const usage: TokenUsage = {
    inputTokens: 2_000_000,
    outputTokens: 400_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  const representativeBudget = 25; // USD per run

  const modernCost = estimateCost(usage, "claude-opus-4-8");
  // input 2M*5 = 10, output 0.4M*25 = 10 => 20 < 25 (within budget).
  assertEquals(modernCost?.totalCost, 20);
  assertEquals(modernCost!.totalCost < representativeBudget, true);

  // The legacy rate would have been 2M*15 + 0.4M*75 = 30 + 30 = 60 > 25.
  const legacyCost = estimateCost(usage, "claude-opus-4-20250514");
  assertEquals(legacyCost!.totalCost > representativeBudget, true);
});

// =============================================================================
// Non-Claude model ids are unpriced, not free (Issue #366)
// =============================================================================

Deno.test("token_usage - non-Claude model ids have no pricing row", () => {
  assertEquals(lookupModelPricing("gpt-5-codex"), null);
  assertEquals(lookupModelPricing("gemini-2.5-pro"), null);
});

Deno.test("token_usage - non-Claude ids are charged at the unpriced upper bound", () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  for (const model of ["gpt-5-codex", "gemini-2.5-pro"]) {
    const estimate = estimateCostWithUpperBound(usage, model);
    assertEquals(estimate.priced, false, `${model} must read as unpriced`);
    // The tokens carry a visible upper-bound cost rather than a silent $0.
    assertEquals(estimate.cost.totalCost > 0, true);
  }
});
