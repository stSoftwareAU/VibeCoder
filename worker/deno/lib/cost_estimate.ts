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
  lookupModelPricing,
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
  /**
   * True when the matched row is the vendor's API-equivalent list price rather
   * than a billed rate (Issue #1937) — read off `ModelPricing.apiEquivalent`,
   * never sniffed from the model id.
   */
  apiEquivalent: boolean;
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
 * Read a token counter under either accepted spelling.
 *
 * An **absent** counter is a genuine zero — the API omits a bucket it never
 * filled. A counter that is *present* but not a finite non-negative number is
 * a fault, and reporting it as zero would put a fabricated count where a real
 * one belongs (the failure Issue #366 established for Gemini usage), so it
 * returns `undefined` and the caller discards the whole breakdown.
 *
 * The two spellings are the two that are actually produced: the Claude CLI's
 * `modelUsage` entries are camelCase, while the recorded stream fixtures carry
 * the result line's snake_case. No other alias is invented here.
 */
function readCounter(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): number | undefined {
  for (const key of [camel, snake]) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
    return undefined;
  }
  return 0;
}

/** Parse one `modelUsage` entry, or `undefined` when it is not usable. */
function readModelUsageEntry(
  model: string,
  raw: unknown,
): ModelUsageEntry | undefined {
  const key = model.trim();
  if (!key || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const inputTokens = readCounter(record, "inputTokens", "input_tokens");
  const outputTokens = readCounter(record, "outputTokens", "output_tokens");
  const cacheCreationTokens = readCounter(
    record,
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
  );
  const cacheReadTokens = readCounter(
    record,
    "cacheReadInputTokens",
    "cache_read_input_tokens",
  );
  if (
    inputTokens === undefined || outputTokens === undefined ||
    cacheCreationTokens === undefined || cacheReadTokens === undefined
  ) {
    return undefined;
  }
  return {
    model: key,
    usage: {
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    },
  };
}

/**
 * Read a run's per-model `modelUsage` breakdown into usage entries, in
 * first-seen order. Returns `undefined` when the breakdown is absent, empty, or
 * any entry is unreadable (not an object, or a counter that is present but not
 * a non-negative number), so a partly-readable breakdown is never trusted in
 * part.
 */
export function readModelUsageBreakdown(
  modelUsage: Record<string, unknown> | undefined,
): ModelUsageEntry[] | undefined {
  const raw = Object.entries(modelUsage ?? {});
  if (raw.length === 0) return undefined;
  const entries: ModelUsageEntry[] = [];
  for (const [model, value] of raw) {
    const entry = readModelUsageEntry(model, value);
    if (!entry) return undefined;
    entries.push(entry);
  }
  return entries;
}

/**
 * Split a run's total token usage across the models that actually served it
 * (Issue #2346).
 *
 * A split run's advisor (Opus) and its executor sub-agents (Sonnet) share one
 * CLI invocation, so `RunStats.modelUsage` is the only record of who spent
 * what. Attributing the whole invocation to its first served model prices the
 * executors' Sonnet tokens at Opus rates and leaves Sonnet with no cost line at
 * all.
 *
 * **The breakdown is trusted when every entry reads cleanly.** On a split run
 * the CLI's result `usage` covers only the main session (or is all zero) while
 * `modelUsage` covers every model that served the run, sub-agents included
 * (Issue #3603), so a breakdown larger than the totals is expected, not a
 * fault. Models keep their first-seen order, and any per-counter shortfall of
 * the breakdown against the totals goes on `fallbackModel` as a residual entry,
 * so the entries never under-report the run. A counter where the breakdown
 * exceeds the totals contributes no residual. An absent, empty or unreadable
 * breakdown attributes the whole run to `fallbackModel`.
 *
 * @param tokenUsage - The invocation's recorded totals
 * @param modelUsage - Per-model breakdown as recorded on the run stats
 * @param fallbackModel - Model to attribute unbroken-down usage to
 * @returns Per-model usage entries in first-seen order
 */
export function attributeUsageByModel(
  tokenUsage: TokenUsage,
  modelUsage: Record<string, unknown> | undefined,
  fallbackModel: string,
): ModelUsageEntry[] {
  const whole: ModelUsageEntry[] = [{
    model: fallbackModel,
    usage: tokenUsage,
  }];
  const entries = readModelUsageBreakdown(modelUsage);
  if (!entries) return whole;

  const residual: TokenUsage = {
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    cacheCreationTokens: tokenUsage.cacheCreationTokens,
    cacheReadTokens: tokenUsage.cacheReadTokens,
  };
  for (const { usage } of entries) {
    residual.inputTokens -= usage.inputTokens;
    residual.outputTokens -= usage.outputTokens;
    residual.cacheCreationTokens -= usage.cacheCreationTokens;
    residual.cacheReadTokens -= usage.cacheReadTokens;
  }
  residual.inputTokens = Math.max(0, residual.inputTokens);
  residual.outputTokens = Math.max(0, residual.outputTokens);
  residual.cacheCreationTokens = Math.max(0, residual.cacheCreationTokens);
  residual.cacheReadTokens = Math.max(0, residual.cacheReadTokens);

  if (!usageIsZero(residual)) {
    return [...entries, { model: fallbackModel, usage: residual }];
  }
  return entries;
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
    const pricing = lookupModelPricing(model);
    const breakdown = estimateCost(usage, model);
    if (breakdown) {
      totalCost += breakdown.totalCost;
    } else if (!usageIsZero(usage)) {
      hasUnknownPricing = true;
    }
    perModel.push({
      model,
      usage,
      breakdown,
      apiEquivalent: pricing?.apiEquivalent === true,
    });
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
 *     - `gpt-5-codex`: $0.0021 (API-equivalent) — input $0.0013 · output $0.0008 · cache write $0.0000 · cache read $0.0000
 *
 * A row priced at the vendor's API-equivalent list price rather than a billed
 * rate carries an `(API-equivalent)` label after its per-model total (Issue
 * #1937); Claude sub-bullets, the heading line and the `(partial — see below)`
 * suffix are unchanged. The four columns are identical for every provider — a
 * column the vendor does not bill renders `$0.0000` through {@link formatUsd}
 * rather than being dropped, so the breakdown always reconciles.
 *
 * Returns an empty array when there is nothing worth reporting: no entries, or
 * every entry has zero tokens. When a model's pricing is unknown its sub-bullet
 * shows `pricing unknown` rather than a fabricated figure — a fault is never
 * silently priced at zero (fail-loud, Issue #3234).
 *
 * With `options.subAgentsNotCosted` (a multi-model run that recorded no usable
 * per-model usage, Issue #3603) the heading carries the same
 * `(partial — see below)` suffix and a closing `sub-agents: not costed`
 * sub-bullet states that only the main session is priced. When nothing is
 * priced the option yields a single not-costed heading line instead of an empty
 * array.
 *
 * @param entries - Per-invocation (or per-model) usage entries
 * @param options - `subAgentsNotCosted` flags that sub-agent usage is missing
 * @returns Markdown bullet lines (possibly empty)
 */
export function formatCostEstimateLines(
  entries: ModelUsageEntry[],
  options: { subAgentsNotCosted?: boolean } = {},
): string[] {
  const estimate = estimateRunCost(entries);
  const priced = estimate.perModel.filter((m) => !usageIsZero(m.usage));
  const notCosted = options.subAgentsNotCosted === true;
  if (priced.length === 0) {
    return notCosted
      ? [
        "- **Estimated cost (USD, estimate only):** sub-agents: not costed — the run served more than one model but recorded no usable per-model usage",
      ]
      : [];
  }

  const suffix = estimate.hasUnknownPricing || notCosted
    ? " (partial — see below)"
    : "";
  const lines = [
    `- **Estimated cost (USD, estimate only):** ~${
      formatUsd(estimate.totalCost)
    }${suffix}`,
  ];

  for (const { model, breakdown, apiEquivalent } of priced) {
    if (!breakdown) {
      lines.push(`  - \`${model}\`: _pricing unknown_`);
      continue;
    }
    const basis = apiEquivalent ? " (API-equivalent)" : "";
    lines.push(
      `  - \`${model}\`: ${formatUsd(breakdown.totalCost)}${basis} — input ${
        formatUsd(breakdown.inputCost)
      } · output ${formatUsd(breakdown.outputCost)} · cache write ${
        formatUsd(breakdown.cacheWriteCost)
      } · cache read ${formatUsd(breakdown.cacheReadCost)}`,
    );
  }

  if (notCosted) {
    lines.push(
      "  - sub-agents: not costed — the run served more than one model but recorded no usable per-model usage, so only the main session is priced",
    );
  }

  return lines;
}
