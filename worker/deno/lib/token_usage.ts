/**
 * Token usage extraction and cost estimation (Issue #1260).
 *
 * Parses Claude CLI stream-json output for token usage fields and provides
 * cost estimation based on known model pricing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Token usage extracted from a Claude CLI invocation. */
export interface TokenUsage {
  /** Number of input tokens consumed. */
  inputTokens: number;
  /** Number of output tokens generated. */
  outputTokens: number;
  /** Number of tokens written to the prompt cache. */
  cacheCreationTokens: number;
  /** Number of tokens read from the prompt cache. */
  cacheReadTokens: number;
}

/** Pricing per million tokens for a model tier. */
export interface ModelPricing {
  /** Cost per million input tokens (USD). */
  inputPerMillion: number;
  /** Cost per million output tokens (USD). */
  outputPerMillion: number;
  /** Cost per million cache-write tokens (USD). */
  cacheWritePerMillion: number;
  /** Cost per million cache-read tokens (USD). */
  cacheReadPerMillion: number;
}

/** Cost breakdown for a set of token counts. */
export interface CostBreakdown {
  /** Cost of input tokens (USD). */
  inputCost: number;
  /** Cost of output tokens (USD). */
  outputCost: number;
  /** Cost of cache-write tokens (USD). */
  cacheWriteCost: number;
  /** Cost of cache-read tokens (USD). */
  cacheReadCost: number;
  /** Total cost (USD). */
  totalCost: number;
}

// ---------------------------------------------------------------------------
// Known model pricing (USD per million tokens, as of September 2026)
// ---------------------------------------------------------------------------

// Shared pricing constants — single source of truth so the explicit
// MODEL_PRICING rows and the tier-aware fallback never diverge (Issue #2389).

/**
 * Claude Fable 5.1 — current top tier above Opus (Issue #747).
 *
 * Same input/output rate as Fable 5, with cache reads at a quarter of the
 * Fable 5 rate (0.025× base input rather than the usual 0.1×).
 */
const FABLE_5_1_PRICING: ModelPricing = {
  inputPerMillion: 10,
  outputPerMillion: 50,
  cacheWritePerMillion: 12.50,
  cacheReadPerMillion: 0.25,
};

/**
 * Claude Fable 5 (Issue #2619) — kept as its own row so a run-stats comment
 * for a run served by Fable 5 is still costed at the $1/MTok cache-read rate
 * it was actually billed at (Issue #747).
 */
const FABLE_5_PRICING: ModelPricing = {
  inputPerMillion: 10,
  outputPerMillion: 50,
  cacheWritePerMillion: 12.50,
  cacheReadPerMillion: 1,
};

/** Claude Opus 4.5+ — reduced pricing (Issue #1398). */
const OPUS_PRICING_MODERN: ModelPricing = {
  inputPerMillion: 5,
  outputPerMillion: 25,
  cacheWritePerMillion: 6.25,
  cacheReadPerMillion: 0.50,
};

/** Claude Opus 4.0/4.1 (and Claude 3 Opus) — legacy pricing. */
const OPUS_PRICING_LEGACY: ModelPricing = {
  inputPerMillion: 15,
  outputPerMillion: 75,
  cacheWritePerMillion: 18.75,
  cacheReadPerMillion: 1.50,
};

/**
 * Claude Sonnet 5 — current Sonnet (Issue #747). The $2/$10 launch rate is now
 * the standard price; the scheduled rise to $3/$15 was cancelled.
 */
const SONNET_5_PRICING: ModelPricing = {
  inputPerMillion: 2,
  outputPerMillion: 10,
  cacheWritePerMillion: 2.50,
  cacheReadPerMillion: 0.20,
};

/** Claude Sonnet 4.x pricing (Issue #1400) — dearer than Sonnet 5. */
const SONNET_4_PRICING: ModelPricing = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheWritePerMillion: 3.75,
  cacheReadPerMillion: 0.30,
};

/** Claude Haiku 4.x pricing (Issue #1400, #1398). */
const HAIKU_PRICING: ModelPricing = {
  inputPerMillion: 1,
  outputPerMillion: 5,
  cacheWritePerMillion: 1.25,
  cacheReadPerMillion: 0.10,
};

/**
 * Current (latest-tier) pricing per model tier (Issue #2389).
 *
 * Used as the fallback when a bare alias (`opus`/`sonnet`/`haiku`) or an
 * unmatched but tiered id (e.g. a future `claude-opus-4-9`) is looked up,
 * so new minor releases inherit the current rate rather than silently
 * falling through to the oldest/legacy row.
 */
export const TIER_CURRENT_PRICING: ReadonlyMap<string, ModelPricing> = new Map([
  ["fable", FABLE_5_1_PRICING],
  ["opus", OPUS_PRICING_MODERN],
  ["sonnet", SONNET_5_PRICING],
  ["haiku", HAIKU_PRICING],
]);

/**
 * Known pricing tiers for Claude models.
 *
 * These are approximate list prices and may change. The map keys are
 * normalised model name prefixes matched **in order** — more specific
 * prefixes must appear before broader ones (e.g. "claude-opus-4-7"
 * before "claude-opus-4").
 *
 * Source: https://docs.anthropic.com/en/docs/about-claude/pricing
 */
export const MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map([
  // Claude Fable 5.1 — current top tier (Issue #747). Must precede the
  // `claude-fable-5` row: prefixes are matched in order, and every released
  // Fable 5 snapshot id carries a `2026…` date suffix, so no Fable 5 id can
  // be captured by the `claude-fable-5-1` prefix.
  ["claude-fable-5-1", FABLE_5_1_PRICING],
  // Claude Fable 5 — the previous top tier (Issue #2619)
  ["claude-fable-5", FABLE_5_PRICING],
  // Claude Opus 5 — same reduced price point as Opus 4.8 (Issue #3559)
  ["claude-opus-5", OPUS_PRICING_MODERN],
  // Claude Opus 4.5+ — reduced pricing (Issue #1398, #2389)
  ["claude-opus-4-8", OPUS_PRICING_MODERN],
  ["claude-opus-4-7", OPUS_PRICING_MODERN],
  ["claude-opus-4-6", OPUS_PRICING_MODERN],
  ["claude-opus-4-5", OPUS_PRICING_MODERN],
  // Claude Opus 4.0/4.1 — legacy pricing
  ["claude-opus-4", OPUS_PRICING_LEGACY],
  // Claude Sonnet 5 is the current Sonnet and is cheaper than the 4.x line
  // (Issue #747); the broader claude-sonnet-4 prefix catches dated 4.0/4.1/4.2
  // ids that share the 4.x rate (Issue #2407).
  ["claude-sonnet-5", SONNET_5_PRICING],
  ["claude-sonnet-4-6", SONNET_4_PRICING],
  ["claude-sonnet-4", SONNET_4_PRICING],
  // Claude Haiku 4.5 (Issue #1398) — current Haiku
  ["claude-haiku-4-5", HAIKU_PRICING],
  // Legacy models
  ["claude-3-5-sonnet", SONNET_4_PRICING],
  ["claude-3-5-haiku", {
    inputPerMillion: 0.80,
    outputPerMillion: 4,
    cacheWritePerMillion: 1,
    cacheReadPerMillion: 0.08,
  }],
  ["claude-3-opus", OPUS_PRICING_LEGACY],
]);

/**
 * Conservative upper bound applied to an unrecognised model id (Issue #3870).
 *
 * Each rate is the dearest of every known row, so an invocation whose model id
 * is missing from the pricing table — the `"default"` sentinel, or any id newer
 * than this table — is over-estimated rather than counted as `$0`. The daily
 * spend ceiling then guards a budget that is never smaller than the real one.
 * Derived from the tables so a new (dearer) tier raises the bound automatically.
 */
export const UNPRICED_UPPER_BOUND_PRICING: ModelPricing = (() => {
  const rows = [...TIER_CURRENT_PRICING.values(), ...MODEL_PRICING.values()];
  return {
    inputPerMillion: Math.max(...rows.map((r) => r.inputPerMillion)),
    outputPerMillion: Math.max(...rows.map((r) => r.outputPerMillion)),
    cacheWritePerMillion: Math.max(...rows.map((r) => r.cacheWritePerMillion)),
    cacheReadPerMillion: Math.max(...rows.map((r) => r.cacheReadPerMillion)),
  };
})();

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extract token usage from Claude CLI stream-json output.
 *
 * Scans the NDJSON lines for a `result` message type that contains a
 * `usage` object with token counts. Returns null if no usage data is found.
 *
 * @param rawStreamOutput - Raw stream-json output from Claude CLI
 * @returns Token usage or null if not found
 */
export function extractTokenUsage(rawStreamOutput: string): TokenUsage | null {
  if (!rawStreamOutput.trim()) return null;

  const lines = rawStreamOutput.split("\n").filter((l) => l.trim());

  // Scan from the end — the result line is typically last
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;

    // Quick pre-check to avoid parsing every line
    if (!line.includes('"result"') || !line.includes('"usage"')) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "result" && parsed.usage) {
        return {
          inputTokens: typeof parsed.usage.input_tokens === "number"
            ? parsed.usage.input_tokens
            : 0,
          outputTokens: typeof parsed.usage.output_tokens === "number"
            ? parsed.usage.output_tokens
            : 0,
          cacheCreationTokens:
            typeof parsed.usage.cache_creation_input_tokens === "number"
              ? parsed.usage.cache_creation_input_tokens
              : 0,
          cacheReadTokens:
            typeof parsed.usage.cache_read_input_tokens === "number"
              ? parsed.usage.cache_read_input_tokens
              : 0,
        };
      }
    } catch {
      // Skip unparseable lines
      continue;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** Model tier name. */
export type ModelTier = "fable" | "opus" | "sonnet" | "haiku";

/**
 * Every tier alias, in descending capability order. The single source of
 * truth for "is this string a tier?" — callers that accept a tier from an
 * untrusted surface (e.g. an idle-task wrapper body, Issue #4010) allowlist
 * against this rather than passing an arbitrary string to `--model`.
 */
export const MODEL_TIERS: readonly ModelTier[] = [
  "fable",
  "opus",
  "sonnet",
  "haiku",
];

/** Type guard: whether `value` is exactly one of the {@link MODEL_TIERS}. */
export function isModelTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

/** Minor version at/above which Opus uses the modern (4.5+) reduced pricing. */
const OPUS_MODERN_MIN_MINOR = 5;

/** Minor version at/above which Fable 5 uses the cheaper 5.1 cache-read rate. */
const FABLE_CHEAP_CACHE_MIN_MINOR = 1;

/** Major version at/above which Sonnet uses the cheaper Sonnet 5 rate. */
const SONNET_MODERN_MIN_MAJOR = 5;

/**
 * Parse the major/minor version of a modern (4 or 5 family) Claude id.
 *
 * Matches `claude-<tier>-<major>` (major 4 or 5) optionally followed by
 * `-<minor>` and/or a release date. A trailing group of 3+ digits is treated
 * as a release date (e.g. `20250514`), not a minor version, so a bare or dated
 * `claude-opus-4` id resolves to minor 0. Extended to the 5-family (Issue
 * #3559) and to the `fable` tier (Issue #747) so future dated ids still
 * resolve rather than dropping to a null cost. Returns null for ids outside
 * the 4/5 families.
 *
 * @param model - Lowercased model identifier
 */
function parseClaudeModernVersion(
  model: string,
): { tier: ModelTier; major: number; minor: number } | null {
  const match = model.match(
    /^claude-(fable|opus|sonnet|haiku)-([45])(?:-(\d+))?/,
  );
  if (!match) return null;
  const tier = match[1] as ModelTier;
  const major = Number(match[2]);
  const group = match[3];
  const minor = group && group.length <= 2 ? Number(group) : 0;
  return { tier, major, minor };
}

/**
 * Look up pricing for a model name.
 *
 * Resolution order (Issue #2389):
 *   1. Bare tier alias (`opus`/`sonnet`/`haiku`) → current tier pricing.
 *   2. Claude 4/5 family id → classify by version so future minors
 *      inherit the modern reduced pricing instead of the legacy row.
 *   3. Explicit prefix match for the remaining (legacy 3-x) models.
 *
 * Returns null if no matching pricing is found.
 *
 * @param model - Model identifier or alias (e.g. "opus", "claude-opus-4-8")
 * @returns Model pricing or null
 */
export function lookupModelPricing(model: string): ModelPricing | null {
  const normalised = model.toLowerCase();

  // 1. Bare tier alias → current pricing for that tier.
  const alias = TIER_CURRENT_PRICING.get(normalised);
  if (alias) return alias;

  // 2. Claude 4/5 family — classify by version, so a minor release the table
  //    has never seen is priced by its own generation rather than by whichever
  //    row happens to match its prefix. Opus 5+ and Opus 4.5+ share the modern
  //    reduced rate and only Opus 4.0/4.1 are legacy (Issue #3559); Fable 5.1+
  //    reads cache at a quarter of the Fable 5 rate and Sonnet 5 is cheaper
  //    than the Sonnet 4.x line (Issue #747). Haiku uses a single rate.
  const parsed = parseClaudeModernVersion(normalised);
  if (parsed) {
    if (parsed.tier === "opus") {
      const modern = parsed.major >= 5 || parsed.minor >= OPUS_MODERN_MIN_MINOR;
      return modern ? OPUS_PRICING_MODERN : OPUS_PRICING_LEGACY;
    }
    if (parsed.tier === "fable") {
      return parsed.minor >= FABLE_CHEAP_CACHE_MIN_MINOR
        ? FABLE_5_1_PRICING
        : FABLE_5_PRICING;
    }
    if (parsed.tier === "sonnet") {
      return parsed.major >= SONNET_MODERN_MIN_MAJOR
        ? SONNET_5_PRICING
        : SONNET_4_PRICING;
    }
    return TIER_CURRENT_PRICING.get(parsed.tier) ?? null;
  }

  // 3. Explicit prefix match for everything else (legacy 3-x models).
  for (const [prefix, pricing] of MODEL_PRICING) {
    if (normalised.startsWith(prefix)) {
      return pricing;
    }
  }
  return null;
}

/**
 * Estimate the cost of a set of token counts for a given model.
 *
 * @param usage - Token usage counts
 * @param model - Model identifier for pricing lookup
 * @returns Cost breakdown or null if model pricing is unknown
 */
export function estimateCost(
  usage: TokenUsage,
  model: string,
): CostBreakdown | null {
  const pricing = lookupModelPricing(model);
  if (!pricing) return null;
  return costFor(usage, pricing);
}

/** A cost estimate plus whether it came from a real pricing row. */
export interface BoundedCostEstimate {
  /** The estimated cost. */
  cost: CostBreakdown;
  /** True when the model id matched a pricing row; false when bounded. */
  priced: boolean;
}

/**
 * Estimate cost, falling back to a conservative upper bound (Issue #3870).
 *
 * An unrecognised model id is charged at {@link UNPRICED_UPPER_BOUND_PRICING}
 * rather than dropped, so spend guards over-estimate instead of silently
 * measuring `$0`. Callers use `priced` to surface the substitution — the
 * bounded figure must never be presented as an exact cost.
 *
 * @param usage - Token usage counts
 * @param model - Model identifier for pricing lookup
 * @returns The cost and whether real pricing was found
 */
export function estimateCostWithUpperBound(
  usage: TokenUsage,
  model: string,
): BoundedCostEstimate {
  const pricing = lookupModelPricing(model);
  return {
    cost: costFor(usage, pricing ?? UNPRICED_UPPER_BOUND_PRICING),
    priced: pricing !== null,
  };
}

/** Apply a pricing row to a set of token counts. */
function costFor(usage: TokenUsage, pricing: ModelPricing): CostBreakdown {
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) *
    pricing.outputPerMillion;
  const cacheWriteCost = (usage.cacheCreationTokens / 1_000_000) *
    pricing.cacheWritePerMillion;
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) *
    pricing.cacheReadPerMillion;

  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
  };
}
