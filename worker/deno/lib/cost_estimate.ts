/**
 * API cost-estimate formatting for completion comments (Issue #3557).
 *
 * Turns per-run token usage into a compact, clearly-labelled **estimate-only**
 * markdown cost block: model(s) used, per-token-type USD breakdown, and the
 * computed total. Rates come exclusively from {@link estimateCost} /
 * `MODEL_PRICING` in `token_usage.ts` — this module adds no new price source
 * (the pricing table stays the single source of truth).
 *
 * The block is intentionally small ("don't over bake it"): a summary line plus
 * one bullet per model, readable on a phone. When a run mixes models (e.g. a
 * Fable→Opus fallback across invocations) each model is costed separately and
 * the per-model figures are summed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type CostBreakdown,
  estimateCost,
  type TokenUsage,
} from "./token_usage.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A model paired with the token usage attributed to it. */
export interface ModelUsageEntry {
  /** Model identifier the tokens were served by (or requested against). */
  model: string;
  /** Token usage attributed to this model. */
  usage: TokenUsage;
}

/** Per-model estimated cost; `breakdown` is null when pricing is unknown. */
export interface ModelCostEstimate {
  /** Model identifier. */
  model: string;
  /** Token usage attributed to this model. */
  usage: TokenUsage;
  /** Cost breakdown, or null when the model has no pricing row. */
  breakdown: CostBreakdown | null;
}

/** Aggregate estimate for a (possibly mixed-model) run. */
export interface RunCostEstimate {
  /** Per-model estimates in first-seen order. */
  perModel: ModelCostEstimate[];
  /** Sum of totals across models with known pricing (USD). */
  totalCost: number;
  /** True when at least one model with tokens has no pricing row. */
  hasUnknownPricing: boolean;
}

// ---------------------------------------------------------------------------
// Merging & estimation
// ---------------------------------------------------------------------------

function usageIsZero(u: TokenUsage): boolean {
  return u.inputTokens === 0 && u.outputTokens === 0 &&
    u.cacheCreationTokens === 0 && u.cacheReadTokens === 0;
}

/**
 * Merge usage entries that share a model, summing token counts and preserving
 * first-seen order. Entries with an empty model id are dropped (they cannot be
 * priced or labelled).
 *
 * @param entries - Per-invocation (or per-model) usage entries
 * @returns Merged entries, one per distinct model, in first-seen order
 */
export function mergeUsageByModel(
  entries: ModelUsageEntry[],
): ModelUsageEntry[] {
  const order: string[] = [];
  const byModel = new Map<string, TokenUsage>();

  for (const { model, usage } of entries) {
    const key = model.trim();
    if (!key) continue;
    const acc = byModel.get(key);
    if (acc) {
      acc.inputTokens += usage.inputTokens;
      acc.outputTokens += usage.outputTokens;
      acc.cacheCreationTokens += usage.cacheCreationTokens;
      acc.cacheReadTokens += usage.cacheReadTokens;
    } else {
      order.push(key);
      byModel.set(key, { ...usage });
    }
  }

  return order.map((model) => ({ model, usage: byModel.get(model)! }));
}

/**
 * Estimate the cost of a (possibly mixed-model) run.
 *
 * Merges usage by model, prices each via {@link estimateCost}, and sums the
 * known-pricing totals. Models with no pricing row contribute `breakdown: null`
 * and flip {@link RunCostEstimate.hasUnknownPricing} when they carry tokens.
 *
 * @param entries - Per-invocation (or per-model) usage entries
 * @returns The aggregate run cost estimate
 */
export function estimateRunCost(entries: ModelUsageEntry[]): RunCostEstimate {
  const merged = mergeUsageByModel(entries);
  const perModel: ModelCostEstimate[] = [];
  let totalCost = 0;
  let hasUnknownPricing = false;

  for (const { model, usage } of merged) {
    const breakdown = estimateCost(usage, model);
    if (breakdown) {
      totalCost += breakdown.totalCost;
    } else if (!usageIsZero(usage)) {
      hasUnknownPricing = true;
    }
    perModel.push({ model, usage, breakdown });
  }

  return { perModel, totalCost, hasUnknownPricing };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format a USD amount: two decimals at/above $1, four below, so small
 * estimates stay meaningful without noisy trailing zeros on larger ones.
 */
export function formatUsd(n: number): string {
  const decimals = Math.abs(n) >= 1 ? 2 : 4;
  return `$${n.toFixed(decimals)}`;
}

/**
 * Build the estimate-only cost block as markdown bullet lines, ready to splice
 * into an existing stats list.
 *
 * Layout (compact, phone-friendly):
 *   - **Estimated cost (USD, estimate only):** ~$0.1234
 *     - `claude-opus-4-8`: $0.1234 — input $0.05 · output $0.06 · cache write $0.01 · cache read $0.00
 *
 * Returns an empty array when there is nothing worth reporting: no entries, or
 * every entry has zero tokens. When a model's pricing is unknown its sub-bullet
 * shows `pricing unknown` rather than a fabricated figure — a fault is never
 * silently priced at zero (fail-loud, Issue #3234).
 *
 * @param entries - Per-invocation (or per-model) usage entries
 * @returns Markdown bullet lines (possibly empty)
 */
export function formatCostEstimateLines(entries: ModelUsageEntry[]): string[] {
  const estimate = estimateRunCost(entries);
  const priced = estimate.perModel.filter((m) => !usageIsZero(m.usage));
  if (priced.length === 0) return [];

  const suffix = estimate.hasUnknownPricing ? " (partial — see below)" : "";
  const lines = [
    `- **Estimated cost (USD, estimate only):** ~${
      formatUsd(estimate.totalCost)
    }${suffix}`,
  ];

  for (const { model, breakdown } of priced) {
    if (!breakdown) {
      lines.push(`  - \`${model}\`: _pricing unknown_`);
      continue;
    }
    lines.push(
      `  - \`${model}\`: ${formatUsd(breakdown.totalCost)} — input ${
        formatUsd(breakdown.inputCost)
      } · output ${formatUsd(breakdown.outputCost)} · cache write ${
        formatUsd(breakdown.cacheWriteCost)
      } · cache read ${formatUsd(breakdown.cacheReadCost)}`,
    );
  }

  return lines;
}
