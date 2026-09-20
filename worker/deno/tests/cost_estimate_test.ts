/**
 * Tests for cost_estimate.ts — API cost-estimate formatting (Issue #3557).
 *
 * Uses Australian English throughout.
 */

import {
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  attributeUsageByModel,
  estimateRunCost,
  formatCostEstimateLines,
  formatUsd,
  mergeUsageByModel,
} from "../lib/cost_estimate.ts";
import type { TokenUsage } from "../lib/token_usage.ts";

function usage(
  input: number,
  output: number,
  cacheWrite = 0,
  cacheRead = 0,
): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
  };
}

// =============================================================================
// formatUsd
// =============================================================================

Deno.test("cost_estimate - formatUsd uses 2dp at/above $1", () => {
  assertEquals(formatUsd(1), "$1.00");
  assertEquals(formatUsd(12.3456), "$12.35");
});

Deno.test("cost_estimate - formatUsd uses 4dp below $1 for small estimates", () => {
  assertEquals(formatUsd(0.1234), "$0.1234");
  assertEquals(formatUsd(0), "$0.0000");
});

// =============================================================================
// mergeUsageByModel
// =============================================================================

Deno.test("cost_estimate - mergeUsageByModel sums same-model entries in first-seen order", () => {
  const merged = mergeUsageByModel([
    { model: "claude-opus-4-8", usage: usage(100, 10) },
    { model: "claude-fable-5", usage: usage(5, 5) },
    { model: "claude-opus-4-8", usage: usage(50, 20) },
  ]);

  assertEquals(merged.length, 2);
  assertEquals(merged[0]!.model, "claude-opus-4-8");
  assertEquals(merged[0]!.usage, usage(150, 30));
  assertEquals(merged[1]!.model, "claude-fable-5");
});

Deno.test("cost_estimate - mergeUsageByModel drops empty model ids", () => {
  const merged = mergeUsageByModel([
    { model: "  ", usage: usage(100, 10) },
    { model: "claude-opus-4-8", usage: usage(1, 1) },
  ]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0]!.model, "claude-opus-4-8");
});

Deno.test("cost_estimate - mergeUsageByModel does not mutate inputs", () => {
  const first = { model: "claude-opus-4-8", usage: usage(100, 10) };
  mergeUsageByModel([first, { model: "claude-opus-4-8", usage: usage(5, 5) }]);
  assertEquals(first.usage, usage(100, 10));
});

// =============================================================================
// estimateRunCost
// =============================================================================

Deno.test("cost_estimate - estimateRunCost sums per-model known pricing", () => {
  // 1M input on sonnet = $3; 1M output on sonnet = $15.
  const result = estimateRunCost([
    { model: "claude-sonnet-4-6", usage: usage(1_000_000, 1_000_000) },
  ]);
  assertEquals(result.perModel.length, 1);
  assertAlmostEquals(result.totalCost, 18, 0.001);
  assertEquals(result.hasUnknownPricing, false);
});

Deno.test("cost_estimate - estimateRunCost costs mixed models separately (Fable→Opus)", () => {
  const result = estimateRunCost([
    { model: "claude-fable-5", usage: usage(1_000_000, 0) }, // $10
    { model: "claude-opus-4-8", usage: usage(1_000_000, 0) }, // $5
  ]);
  assertEquals(result.perModel.length, 2);
  assertAlmostEquals(result.totalCost, 15, 0.001);
});

Deno.test("cost_estimate - estimateRunCost flags unknown pricing but does not fabricate a total", () => {
  const result = estimateRunCost([
    { model: "mystery-model", usage: usage(1_000_000, 0) },
  ]);
  assertEquals(result.hasUnknownPricing, true);
  assertEquals(result.totalCost, 0);
  assertEquals(result.perModel[0]!.breakdown, null);
});

Deno.test("cost_estimate - estimateRunCost ignores unknown pricing when tokens are zero", () => {
  const result = estimateRunCost([
    { model: "mystery-model", usage: usage(0, 0) },
  ]);
  assertEquals(result.hasUnknownPricing, false);
});

// =============================================================================
// formatCostEstimateLines
// =============================================================================

Deno.test("cost_estimate - formatCostEstimateLines returns empty for no entries", () => {
  assertEquals(formatCostEstimateLines([]), []);
});

Deno.test("cost_estimate - formatCostEstimateLines returns empty when all usage is zero", () => {
  assertEquals(
    formatCostEstimateLines([{ model: "claude-opus-4-8", usage: usage(0, 0) }]),
    [],
  );
});

Deno.test("cost_estimate - formatCostEstimateLines renders a labelled estimate block", () => {
  const lines = formatCostEstimateLines([
    { model: "claude-opus-4-8", usage: usage(1_000_000, 1_000_000) },
  ]);
  const text = lines.join("\n");
  // Summary line: currency, estimate label, total.
  assertStringIncludes(text, "Estimated cost (USD, estimate only):");
  // Per-model breakdown across all four token types.
  assertStringIncludes(text, "`claude-opus-4-8`");
  assertStringIncludes(text, "input");
  assertStringIncludes(text, "output");
  assertStringIncludes(text, "cache write");
  assertStringIncludes(text, "cache read");
});

Deno.test("cost_estimate - formatCostEstimateLines lists each model on a mixed run", () => {
  const lines = formatCostEstimateLines([
    { model: "claude-fable-5", usage: usage(1_000_000, 0) },
    { model: "claude-opus-4-8", usage: usage(1_000_000, 0) },
  ]);
  const text = lines.join("\n");
  assertStringIncludes(text, "`claude-fable-5`");
  assertStringIncludes(text, "`claude-opus-4-8`");
});

Deno.test("cost_estimate - formatCostEstimateLines marks unknown pricing rather than $0", () => {
  const lines = formatCostEstimateLines([
    { model: "mystery-model", usage: usage(1_000_000, 0) },
  ]);
  const text = lines.join("\n");
  assertStringIncludes(text, "pricing unknown");
  assertStringIncludes(text, "partial");
});

// =============================================================================
// API-equivalent labelling for non-Claude rows (Issue #1937)
// =============================================================================

Deno.test("cost_estimate - a Codex sub-bullet is labelled API-equivalent with an unbilled cache-write column", () => {
  const lines = formatCostEstimateLines([
    // 1M input · 1M output · 1M cached input on gpt-5-codex:
    // $1.25 + $10.00 + $0.125 = $11.375.
    { model: "gpt-5-codex", usage: usage(1_000_000, 1_000_000, 0, 1_000_000) },
  ]);

  assertEquals(lines.length, 2);
  assertEquals(
    lines[0],
    "- **Estimated cost (USD, estimate only):** ~$11.38",
  );
  assertEquals(
    lines[1],
    "  - `gpt-5-codex`: $11.38 (API-equivalent) — input $1.25 · output $10.00 · cache write $0.0000 · cache read $0.1250",
  );
  // No vendor bills a per-token cache write, and the column is still rendered.
  assertStringIncludes(lines[1]!, "cache write $0.0000");
  assertStringIncludes(lines[1]!, " (API-equivalent) — input ");
});

Deno.test("cost_estimate - Gemini and DeepSeek sub-bullets carry the API-equivalent label", () => {
  for (const model of ["gemini-2.5-pro", "deepseek-flash"]) {
    const lines = formatCostEstimateLines([
      { model, usage: usage(1_000_000, 1_000_000) },
    ]);
    assertStringIncludes(lines[1]!, `\`${model}\``);
    assertStringIncludes(lines[1]!, " (API-equivalent) — input ");
    assertStringIncludes(lines[1]!, "cache write $0.0000");
  }
});

Deno.test("cost_estimate - a Claude sub-bullet is byte-for-byte unchanged (no label leaks onto it)", () => {
  const lines = formatCostEstimateLines([
    { model: "claude-opus-4-8", usage: usage(1_000_000, 1_000_000) },
  ]);

  assertEquals(lines, [
    "- **Estimated cost (USD, estimate only):** ~$30.00",
    "  - `claude-opus-4-8`: $30.00 — input $5.00 · output $25.00 · cache write $0.0000 · cache read $0.0000",
  ]);
});

Deno.test("cost_estimate - a mixed Claude + Codex run sums both with no partial suffix", () => {
  const lines = formatCostEstimateLines([
    { model: "claude-opus-4-8", usage: usage(1_000_000, 0) }, // $5.00
    { model: "gpt-5-codex", usage: usage(1_000_000, 0) }, // $1.25
  ]);
  const text = lines.join("\n");

  assertEquals(lines[0], "- **Estimated cost (USD, estimate only):** ~$6.25");
  assertEquals(text.includes("(partial"), false);
  assertStringIncludes(text, "  - `claude-opus-4-8`: $5.00 — input $5.00");
  assertStringIncludes(
    text,
    "  - `gpt-5-codex`: $1.25 (API-equivalent) — input $1.25",
  );
});

Deno.test("cost_estimate - estimateRunCost reports the basis of each matched row", () => {
  const result = estimateRunCost([
    { model: "claude-opus-4-8", usage: usage(1_000, 1_000) },
    { model: "gemini-2.5-flash", usage: usage(1_000, 1_000) },
    { model: "mystery-model", usage: usage(1_000, 1_000) },
  ]);

  assertEquals(result.perModel[0]!.apiEquivalent, false);
  assertEquals(result.perModel[1]!.apiEquivalent, true);
  // An unpriced id has no row, so it has no basis to claim either.
  assertEquals(result.perModel[2]!.apiEquivalent, false);
});

// =============================================================================
// attributeUsageByModel (Issue #2346)
// =============================================================================

Deno.test("cost_estimate - attributeUsageByModel falls back to one entry without a breakdown", () => {
  assertEquals(
    attributeUsageByModel(usage(1_000, 500), undefined, "claude-opus-5"),
    [{ model: "claude-opus-5", usage: usage(1_000, 500) }],
  );
  // An unusable breakdown is not a silent zero — the whole run still prices.
  assertEquals(
    attributeUsageByModel(usage(1_000, 500), { "claude-opus-5": 7 }, "opus"),
    [{ model: "opus", usage: usage(1_000, 500) }],
  );
});

Deno.test("cost_estimate - attributeUsageByModel reads camelCase and snake_case counters", () => {
  const entries = attributeUsageByModel(
    usage(1_500_000, 300_000),
    {
      "claude-opus-5": { inputTokens: 1_000_000, outputTokens: 100_000 },
      "claude-sonnet-5": { input_tokens: 500_000, output_tokens: 200_000 },
    },
    "claude-opus-5",
  );

  assertEquals(entries, [
    { model: "claude-opus-5", usage: usage(1_000_000, 100_000) },
    { model: "claude-sonnet-5", usage: usage(500_000, 200_000) },
  ]);
});

Deno.test("cost_estimate - attributeUsageByModel attributes any shortfall rather than losing it", () => {
  const entries = attributeUsageByModel(
    usage(1_000, 400, 60, 20),
    { "claude-sonnet-5": { input_tokens: 600, output_tokens: 400 } },
    "claude-opus-5",
  );

  // The un-attributed remainder lands on the fallback model, so the summed
  // entries can never under-report the run's own totals.
  assertEquals(entries, [
    { model: "claude-sonnet-5", usage: usage(600, 400) },
    { model: "claude-opus-5", usage: usage(400, 0, 60, 20) },
  ]);
});

Deno.test("cost_estimate - attributeUsageByModel omits an all-zero residual", () => {
  const entries = attributeUsageByModel(
    usage(1_000, 400),
    {
      "claude-opus-5": { input_tokens: 400, output_tokens: 400 },
      "claude-sonnet-5": { input_tokens: 600 },
    },
    "claude-opus-5",
  );
  // Fully attributed, so no residual entry is appended.
  assertEquals(entries, [
    { model: "claude-opus-5", usage: usage(400, 400) },
    { model: "claude-sonnet-5", usage: usage(600, 0) },
  ]);
});

Deno.test("cost_estimate - attributeUsageByModel discards a breakdown claiming more than the run recorded", () => {
  // Trusting it would charge 999 input tokens against a 100-token run, and
  // over-report the pilot's spend and the issue's cumulative total with it.
  assertEquals(
    attributeUsageByModel(
      usage(100, 0),
      { "claude-sonnet-5": { input_tokens: 999 } },
      "claude-opus-5",
    ),
    [{ model: "claude-opus-5", usage: usage(100, 0) }],
  );
});

Deno.test("cost_estimate - attributeUsageByModel never fabricates a zero for an unusable counter", () => {
  // A counter that is present but not a number is a fault, not a zero: the
  // breakdown is discarded whole rather than silently pricing 0 output tokens.
  assertEquals(
    attributeUsageByModel(
      usage(1_000, 500),
      { "claude-sonnet-5": { input_tokens: 1_000, output_tokens: "500" } },
      "claude-opus-5",
    ),
    [{ model: "claude-opus-5", usage: usage(1_000, 500) }],
  );
  // A negative count is equally a fault.
  assertEquals(
    attributeUsageByModel(
      usage(1_000, 500),
      { "claude-sonnet-5": { input_tokens: -1 } },
      "claude-opus-5",
    ),
    [{ model: "claude-opus-5", usage: usage(1_000, 500) }],
  );
  // One unusable entry condemns the breakdown — its siblings' tokens must not
  // be re-attributed to the fallback model at the wrong rate.
  assertEquals(
    attributeUsageByModel(
      usage(1_000, 500),
      {
        "claude-opus-5": { input_tokens: 400, output_tokens: 500 },
        "claude-sonnet-5": 7,
      },
      "claude-opus-5",
    ),
    [{ model: "claude-opus-5", usage: usage(1_000, 500) }],
  );
  // An omitted counter, by contrast, is a genuine zero.
  assertEquals(
    attributeUsageByModel(
      usage(600, 0),
      { "claude-sonnet-5": { input_tokens: 600 } },
      "claude-opus-5",
    ),
    [{ model: "claude-sonnet-5", usage: usage(600, 0) }],
  );
});
