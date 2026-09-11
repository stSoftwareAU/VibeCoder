/**
 * Tests for token_usage.ts — token extraction and cost estimation (Issue #1260).
 *
 * Uses Australian English throughout.
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotStrictEquals,
} from "@std/assert";
import {
  estimateCost,
  estimateCostWithUpperBound,
  extractTokenUsage,
  lookupModelPricing,
  MODEL_PRICING,
  type ModelPricing,
  type TokenUsage,
  UNPRICED_UPPER_BOUND_PRICING,
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
  // Fable 5 keeps its $1/MTok cache-read rate so a historical run-stats
  // comment stays accurate after Fable 5.1 landed (Issue #747).
  const pricing = lookupModelPricing("claude-fable-5");
  assertEquals(pricing?.inputPerMillion, 10);
  assertEquals(pricing?.outputPerMillion, 50);
  assertEquals(pricing?.cacheWritePerMillion, 12.50);
  assertEquals(pricing?.cacheReadPerMillion, 1);
});

Deno.test("token_usage - lookupModelPricing returns pricing for a dated Fable 5 id (Issue #747)", () => {
  // A dated 5.0 snapshot must not be captured by the `claude-fable-5-1` row.
  const pricing = lookupModelPricing("claude-fable-5-20260115");
  assertEquals(pricing?.cacheReadPerMillion, 1);
});

Deno.test("token_usage - lookupModelPricing prices Fable 5.1 cache reads at a quarter of Fable 5 (Issue #747)", () => {
  const pricing = lookupModelPricing("claude-fable-5-1");
  assertEquals(pricing?.inputPerMillion, 10);
  assertEquals(pricing?.outputPerMillion, 50);
  assertEquals(pricing?.cacheWritePerMillion, 12.50);
  assertEquals(pricing?.cacheReadPerMillion, 0.25);
});

Deno.test("token_usage - lookupModelPricing prices a dated Fable 5.1 id at the 5.1 rate (Issue #747)", () => {
  const pricing = lookupModelPricing("claude-fable-5-1-20260901");
  assertEquals(pricing?.inputPerMillion, 10);
  assertEquals(pricing?.cacheReadPerMillion, 0.25);
});

Deno.test("token_usage - lookupModelPricing returns pricing for bare fable alias (Issue #2619, #747)", () => {
  // The worker requests the `fable` alias, which the CLI resolves to the
  // latest Fable — Fable 5.1 since 2026-09-01, hence the 5.1 cache-read rate.
  const pricing = lookupModelPricing("fable");
  assertEquals(pricing?.inputPerMillion, 10);
  assertEquals(pricing?.outputPerMillion, 50);
  assertEquals(pricing?.cacheWritePerMillion, 12.50);
  assertEquals(pricing?.cacheReadPerMillion, 0.25);
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

Deno.test("token_usage - lookupModelPricing returns pricing for Sonnet 5 (Issue #747)", () => {
  const pricing = lookupModelPricing("claude-sonnet-5");
  assertEquals(pricing?.inputPerMillion, 2);
  assertEquals(pricing?.outputPerMillion, 10);
  assertEquals(pricing?.cacheWritePerMillion, 2.50);
  assertEquals(pricing?.cacheReadPerMillion, 0.20);
});

Deno.test("token_usage - lookupModelPricing tier fallback gives Sonnet 4.x pricing for unknown 4-family minor (Issue #2407)", () => {
  // An unknown-but-tiered Sonnet 4 id must inherit the 4.x rate via the
  // tier-aware fallback rather than returning null. Sonnet 5 is cheaper and
  // has its own branch (Issue #747), so the 4-family keeps $3/$15 here.
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

Deno.test("token_usage - lookupModelPricing resolves bare 'sonnet'/'haiku' aliases (Issue #2389, #747)", () => {
  // The `sonnet` alias resolves to the latest Sonnet — Sonnet 5, at $2/$10.
  const sonnet = lookupModelPricing("sonnet");
  assertEquals(sonnet?.inputPerMillion, 2);
  assertEquals(sonnet?.outputPerMillion, 10);

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

Deno.test("token_usage - estimateCost prices Fable 5.1 cache reads at $0.25/MTok (Issue #747)", () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  };

  const cost = estimateCost(usage, "claude-fable-5-1");
  assertEquals(cost?.inputCost, 10);
  assertEquals(cost?.outputCost, 50);
  assertEquals(cost?.cacheWriteCost, 12.50);
  assertEquals(cost?.cacheReadCost, 0.25);
  assertAlmostEquals(cost!.totalCost, 72.75, 0.001);
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
// Non-Claude model ids are priced at the vendor's API-equivalent list price
// (Issue #1937, replacing the unpriced treatment of Issue #366 / #1701)
// =============================================================================

/**
 * The eight routable non-Claude ids (`config_defaults.ts`) with the vendor
 * rates read from the pricing pages on 2026-09-11 — the figures the rows
 * themselves cite. Restated here so a silent edit to a row fails the suite.
 */
const API_EQUIVALENT_ROWS: ReadonlyArray<[string, ModelPricing]> = [
  ["gpt-5-codex", {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheWritePerMillion: 0,
    cacheReadPerMillion: 0.125,
    apiEquivalent: true,
  }],
  ["gpt-5-mini", {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
    cacheWritePerMillion: 0,
    cacheReadPerMillion: 0.025,
    apiEquivalent: true,
  }],
  ["gpt-5", {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheWritePerMillion: 0,
    cacheReadPerMillion: 0.125,
    apiEquivalent: true,
  }],
  ["gemini-2.5-pro", {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
    cacheWritePerMillion: 0,
    cacheReadPerMillion: 0.125,
    apiEquivalent: true,
  }],
  ["gemini-2.5-flash-lite", {
    inputPerMillion: 0.10,
    outputPerMillion: 0.40,
    cacheWritePerMillion: 0,
    cacheReadPerMillion: 0.01,
    apiEquivalent: true,
  }],
  ["gemini-2.5-flash", {
    inputPerMillion: 0.30,
    outputPerMillion: 2.50,
    cacheWritePerMillion: 0,
    cacheReadPerMillion: 0.03,
    apiEquivalent: true,
  }],
  ["deepseek-reasoner", {
    inputPerMillion: 0.30,
    outputPerMillion: 1.20,
    cacheWritePerMillion: 0,
    cacheReadPerMillion: 0.006,
    apiEquivalent: true,
  }],
  ["deepseek-chat", {
    inputPerMillion: 0.30,
    outputPerMillion: 1.20,
    cacheWritePerMillion: 0,
    cacheReadPerMillion: 0.006,
    apiEquivalent: true,
  }],
];

Deno.test("token_usage - each routable non-Claude id resolves to its own priced row (Issue #1937)", () => {
  const seen: ModelPricing[] = [];
  for (const [id, expected] of API_EQUIVALENT_ROWS) {
    const row = lookupModelPricing(id);
    assert(row, `${id} must resolve to a pricing row`);
    assertEquals(row, expected, `${id} must carry its vendor rates`);
    // Distinct row objects, so an id is never served by another id's row —
    // two ids that share a rate today can diverge with a one-row edit.
    for (const other of seen) assertNotStrictEquals(row, other);
    seen.push(row);
  }
  assertEquals(seen.length, 8);
});

Deno.test("token_usage - the ordered prefix walk reaches the specific row, not a broader one (Issue #1937)", () => {
  const gpt5 = lookupModelPricing("gpt-5");
  // `gpt-5-codex` currently shares gpt-5's rate, so only identity proves the
  // codex row is reached rather than shadowed by the broader `gpt-5` prefix.
  assertNotStrictEquals(lookupModelPricing("gpt-5-codex"), gpt5);
  assertNotStrictEquals(lookupModelPricing("gpt-5-mini"), gpt5);
  assertEquals(lookupModelPricing("gpt-5-mini")?.outputPerMillion, 2);

  const flash = lookupModelPricing("gemini-2.5-flash");
  assertNotStrictEquals(lookupModelPricing("gemini-2.5-flash-lite"), flash);
  assertEquals(
    lookupModelPricing("gemini-2.5-flash-lite")?.inputPerMillion,
    0.10,
  );
  assertEquals(flash?.inputPerMillion, 0.30);

  assertNotStrictEquals(
    lookupModelPricing("deepseek-reasoner"),
    lookupModelPricing("deepseek-chat"),
  );
});

Deno.test("token_usage - a dated/suffixed non-Claude id still prices from its row (Issue #1937)", () => {
  // The walk is a prefix match, so a vendor snapshot suffix resolves too.
  assertEquals(
    lookupModelPricing("gpt-5-codex-2026-09-01")?.outputPerMillion,
    10,
  );
  assertEquals(
    lookupModelPricing("GEMINI-2.5-PRO")?.inputPerMillion,
    1.25,
  );
});

Deno.test("token_usage - the API-equivalent marker sits on every non-Claude row and no Claude row (Issue #1937)", () => {
  let nonClaude = 0;
  for (const [key, row] of MODEL_PRICING) {
    if (key.startsWith("claude")) {
      assertEquals(
        row.apiEquivalent,
        undefined,
        `${key} is a billed Claude rate and must carry no marker`,
      );
      continue;
    }
    nonClaude++;
    assertEquals(
      row.apiEquivalent,
      true,
      `${key} is an API-equivalent list price and must be marked`,
    );
  }
  assertEquals(nonClaude, 8);
});

Deno.test("token_usage - the unpriced upper bound is unchanged by the new rows (Issue #1937)", () => {
  // The four values as they stood before the non-Claude rows were added —
  // the dearest Claude row (legacy Opus). Pinned so a vendor rate that would
  // raise the derived bound is caught rather than landing silently.
  assertEquals(UNPRICED_UPPER_BOUND_PRICING, {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheWritePerMillion: 18.75,
    cacheReadPerMillion: 1.50,
  });

  for (const [id, row] of API_EQUIVALENT_ROWS) {
    assert(
      row.inputPerMillion <= UNPRICED_UPPER_BOUND_PRICING.inputPerMillion,
      `${id} input rate must stay under the bound`,
    );
    assert(
      row.outputPerMillion <= UNPRICED_UPPER_BOUND_PRICING.outputPerMillion,
      `${id} output rate must stay under the bound`,
    );
    assert(
      row.cacheWritePerMillion <=
        UNPRICED_UPPER_BOUND_PRICING.cacheWritePerMillion,
      `${id} cache-write rate must stay under the bound`,
    );
    assert(
      row.cacheReadPerMillion <=
        UNPRICED_UPPER_BOUND_PRICING.cacheReadPerMillion,
      `${id} cache-read rate must stay under the bound`,
    );
  }
});

Deno.test("token_usage - a priced non-Claude id costs its row rate, not the bound (Issue #1937)", () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 500_000,
    cacheReadTokens: 1_000_000,
  };

  for (const [id, expected] of API_EQUIVALENT_ROWS) {
    const estimate = estimateCostWithUpperBound(usage, id);
    assertEquals(estimate.priced, true, `${id} must read as priced`);
    const rowTotal = expected.inputPerMillion + expected.outputPerMillion +
      0.5 * expected.cacheWritePerMillion + expected.cacheReadPerMillion;
    assertAlmostEquals(estimate.cost.totalCost, rowTotal, 1e-9);
    // Cache writes are not billed by any of these vendors.
    assertEquals(estimate.cost.cacheWriteCost, 0);
  }
});

Deno.test("token_usage - a non-Claude id outside the table is still unpriced and bounded (Issue #1937)", () => {
  const usage: TokenUsage = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  for (const model of ["gpt-4.1", "gemini-3-pro", "deepseek-v5"]) {
    assertEquals(lookupModelPricing(model), null, `${model} must be unpriced`);
    const estimate = estimateCostWithUpperBound(usage, model);
    assertEquals(estimate.priced, false, `${model} must read as unpriced`);
    // The tokens carry a visible upper-bound cost rather than a silent $0.
    assertAlmostEquals(
      estimate.cost.totalCost,
      UNPRICED_UPPER_BOUND_PRICING.inputPerMillion +
        UNPRICED_UPPER_BOUND_PRICING.outputPerMillion,
      1e-9,
    );
  }
});

Deno.test("token_usage - estimateCost prices a Codex run from its row (Issue #1937)", () => {
  // 200k input + 50k output on gpt-5-codex: 0.2 * 1.25 + 0.05 * 10.
  const cost = estimateCost({
    inputTokens: 200_000,
    outputTokens: 50_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 400_000,
  }, "gpt-5-codex");
  assert(cost);
  assertAlmostEquals(cost.inputCost, 0.25, 1e-9);
  assertAlmostEquals(cost.outputCost, 0.5, 1e-9);
  assertAlmostEquals(cost.cacheWriteCost, 0, 1e-9);
  assertAlmostEquals(cost.cacheReadCost, 0.05, 1e-9);
  assertAlmostEquals(cost.totalCost, 0.8, 1e-9);
});
