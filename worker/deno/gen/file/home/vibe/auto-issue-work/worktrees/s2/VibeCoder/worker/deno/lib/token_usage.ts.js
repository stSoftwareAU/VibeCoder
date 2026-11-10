/**
 * Token usage extraction and cost estimation (Issue #1260).
 *
 * Parses Claude CLI stream-json output for token usage fields and provides
 * cost estimation based on known model pricing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ // ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** Token usage extracted from a Claude CLI invocation. */ // ---------------------------------------------------------------------------
// Known model pricing (USD per million tokens, as of September 2026)
// ---------------------------------------------------------------------------
// Shared pricing constants — single source of truth so the explicit
// MODEL_PRICING rows and the tier-aware fallback never diverge (Issue #2389).
/**
 * Claude Fable 5.1 — current top tier above Opus (Issue #747).
 *
 * Same input/output rate as Fable 5, with cache reads at a quarter of the
 * Fable 5 rate (0.025× base input rather than the usual 0.1×).
 */ const FABLE_5_1_PRICING = {
  inputPerMillion: 10,
  outputPerMillion: 50,
  cacheWritePerMillion: 12.50,
  cacheReadPerMillion: 0.25
};
/**
 * Claude Fable 5 (Issue #2619) — kept as its own row so a run-stats comment
 * for a run served by Fable 5 is still costed at the $1/MTok cache-read rate
 * it was actually billed at (Issue #747).
 */ const FABLE_5_PRICING = {
  inputPerMillion: 10,
  outputPerMillion: 50,
  cacheWritePerMillion: 12.50,
  cacheReadPerMillion: 1
};
/**
 * Claude Opus 5.5 — current top tier, replacing Fable (Issue #2543).
 *
 * Cheaper than Opus 5.0-5.4/4.5+ on every rate, and cache hits/refreshes are
 * priced at 0.05x the base input rate rather than the usual 0.1x.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing, checked
 * 2026-09-23.
 */ const OPUS_5_5_PRICING = {
  inputPerMillion: 4,
  outputPerMillion: 20,
  cacheWritePerMillion: 5,
  cacheReadPerMillion: 0.20
};
/** Claude Opus 4.5-5.4 — reduced pricing (Issue #1398). */ const OPUS_PRICING_MODERN = {
  inputPerMillion: 5,
  outputPerMillion: 25,
  cacheWritePerMillion: 6.25,
  cacheReadPerMillion: 0.50
};
/** Claude Opus 4.0/4.1 (and Claude 3 Opus) — legacy pricing. */ const OPUS_PRICING_LEGACY = {
  inputPerMillion: 15,
  outputPerMillion: 75,
  cacheWritePerMillion: 18.75,
  cacheReadPerMillion: 1.50
};
/**
 * Claude Sonnet 5 — current Sonnet (Issue #747).
 *
 * $2/$10 looks like the expired introductory rate and is not. Anthropic's
 * pricing page (https://platform.claude.com/docs/en/about-claude/pricing)
 * carries a note beside the table: the launch rate, announced as introductory
 * through 2026-08-31, "is now the standard price", and "the previously
 * scheduled increase to $3/$15 per million input/output tokens on
 * September 1, 2026 will not occur". Checked 2026-09-02.
 */ const SONNET_5_PRICING = {
  inputPerMillion: 2,
  outputPerMillion: 10,
  cacheWritePerMillion: 2.50,
  cacheReadPerMillion: 0.20
};
/** Claude Sonnet 4.x pricing (Issue #1400) — dearer than Sonnet 5. */ const SONNET_4_PRICING = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheWritePerMillion: 3.75,
  cacheReadPerMillion: 0.30
};
/**
 * Claude Haiku 4.x pricing (Issue #1400, #1398) — flat, with no prompt-size
 * band. Also the bare `haiku` alias's rate: at or above Haiku 5.5's upper band
 * on every component, so it bounds both generations (Issue #3399).
 */ const HAIKU_PRICING = {
  inputPerMillion: 1,
  outputPerMillion: 5,
  cacheWritePerMillion: 1.25,
  cacheReadPerMillion: 0.10
};
/**
 * Claude Haiku 5.5 — banded by prompt size per request (Issue #3399). The
 * row's rates are the >100k band; `lowerBand` carries the ≤100k rates,
 * a tenth of Haiku 4.5's.
 */ const HAIKU_5_5_PRICING = {
  inputPerMillion: 0.50,
  outputPerMillion: 2.50,
  cacheWritePerMillion: 0.625,
  cacheReadPerMillion: 0.05,
  lowerBand: {
    maxPromptTokens: 100_000,
    inputPerMillion: 0.10,
    outputPerMillion: 0.50,
    cacheWritePerMillion: 0.125,
    cacheReadPerMillion: 0.01
  }
};
// ---------------------------------------------------------------------------
// Non-Claude API-equivalent list prices (Issue #1937)
// ---------------------------------------------------------------------------
//
// The worker routes to Codex, Gemini and DeepSeek on a fixed-price
// subscription, so none of these rows is a bill (Issue #1923). Each is the
// vendor's published API list price for the same tokens, so a run on one of
// these ids renders a USD figure — labelled `(API-equivalent)` on its
// run-stats sub-bullet — instead of falling through to
// UNPRICED_UPPER_BOUND_PRICING. This replaces the Issue #1701 decision to
// leave the Codex ids unpriced.
//
// `cacheWritePerMillion` is 0 for every row below: none of these three
// vendors bills a per-token cache write the way Anthropic does (Codex reports
// no cache-write counter at all, and Gemini's explicit-cache storage is
// charged hourly, which is not modelled). `cacheReadPerMillion` is the
// vendor's cached-input rate.
//
// Each id keeps its own row even where two currently share a rate, so a
// divergence at the vendor is a one-row edit and the ordered prefix walk in
// `lookupModelPricing` is provably reaching the specific row (pinned by
// `token_usage_test.ts`).
/**
 * OpenAI `gpt-5-codex` — the Codex top tier.
 *
 * Source: https://developers.openai.com/api/docs/models/gpt-5-codex
 * ($1.25 input / $0.125 cached input / $10.00 output per MTok), checked on
 * 2026-09-11. The model is current, not deprecated; its snapshot is updated
 * in place by OpenAI.
 */ const GPT_5_CODEX_PRICING = {
  inputPerMillion: 1.25,
  outputPerMillion: 10,
  cacheWritePerMillion: 0,
  cacheReadPerMillion: 0.125,
  apiEquivalent: true
};
/**
 * OpenAI `gpt-5-mini` — the Codex cheap tier.
 *
 * Source: https://developers.openai.com/api/docs/pricing ($0.25 input /
 * $0.025 cached input / $2.00 output per MTok), checked on 2026-09-11.
 */ const GPT_5_MINI_PRICING = {
  inputPerMillion: 0.25,
  outputPerMillion: 2,
  cacheWritePerMillion: 0,
  cacheReadPerMillion: 0.025,
  apiEquivalent: true
};
/**
 * OpenAI `gpt-5` — the Codex base tier.
 *
 * Source: https://developers.openai.com/api/docs/pricing ($1.25 input /
 * $0.125 cached input / $10.00 output per MTok), checked on 2026-09-11.
 */ const GPT_5_PRICING = {
  inputPerMillion: 1.25,
  outputPerMillion: 10,
  cacheWritePerMillion: 0,
  cacheReadPerMillion: 0.125,
  apiEquivalent: true
};
/**
 * Google `gemini-2.5-pro` — the Gemini top tier.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing, checked on
 * 2026-09-11. Basis: the paid tier's **≤200k prompt-token** band ($1.25
 * input / $0.125 context-cache read / $10.00 output per MTok); prompts above
 * 200k tokens bill at $2.50 / $0.25 / $15.00, which this row does not model.
 * Thinking tokens are billed as output ("Output price (including thinking
 * tokens)"), so they need no separate rate.
 */ const GEMINI_2_5_PRO_PRICING = {
  inputPerMillion: 1.25,
  outputPerMillion: 10,
  cacheWritePerMillion: 0,
  cacheReadPerMillion: 0.125,
  apiEquivalent: true
};
/**
 * Google `gemini-2.5-flash-lite` — the Gemini cheap tier.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing, checked on
 * 2026-09-11. Basis: the text/image/video rate ($0.10 input / $0.01
 * context-cache read / $0.40 output per MTok); the dearer audio input rate
 * ($0.30) is not modelled. Thinking tokens are billed as output.
 */ const GEMINI_2_5_FLASH_LITE_PRICING = {
  inputPerMillion: 0.10,
  outputPerMillion: 0.40,
  cacheWritePerMillion: 0,
  cacheReadPerMillion: 0.01,
  apiEquivalent: true
};
/**
 * Google `gemini-2.5-flash` — the Gemini base tier.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing, checked on
 * 2026-09-11. Basis: the text/image/video rate ($0.30 input / $0.03
 * context-cache read / $2.50 output per MTok); the dearer audio input rate
 * ($1.00) is not modelled. Thinking tokens are billed as output.
 */ const GEMINI_2_5_FLASH_PRICING = {
  inputPerMillion: 0.30,
  outputPerMillion: 2.50,
  cacheWritePerMillion: 0,
  cacheReadPerMillion: 0.03,
  apiEquivalent: true
};
/**
 * DeepSeek `deepseek-v4-pro` — the DeepSeek top tier.
 *
 * Source: https://api-docs.deepseek.com/quick_start/pricing, checked on
 * 2026-09-14. Basis: the **standard-hours (peak)** `deepseek-v4-pro` rate
 * ($1.32 cache-miss input / $0.044 cache-hit input / $3.96 output per MTok),
 * with **no off-peak discount** applied — off-peak is half price, so this row
 * never under-states.
 *
 * The vendor retired `deepseek-chat` / `deepseek-reasoner`, the ids the
 * worker used to route here (Issue #1941); the page now names
 * `deepseek-v4-pro` and `deepseek-flash` as the published ids, with V4 Pro
 * service continuing after 2026-09-14 at unchanged billing. The retired ids
 * keep no rows: a historical credit log that still names one prices at the
 * conservative {@link UNPRICED_UPPER_BOUND_PRICING} instead, which over-states
 * rather than fabricating a rate the vendor no longer publishes.
 */ const DEEPSEEK_V4_PRO_PRICING = {
  inputPerMillion: 1.32,
  outputPerMillion: 3.96,
  cacheWritePerMillion: 0,
  cacheReadPerMillion: 0.044,
  apiEquivalent: true
};
/**
 * DeepSeek `deepseek-flash` — the DeepSeek base tier.
 *
 * Source: https://api-docs.deepseek.com/quick_start/pricing, checked on
 * 2026-09-14. Basis: the **standard-hours (peak)** `deepseek-flash` rate
 * ($0.30 cache-miss input / $0.006 cache-hit input / $1.20 output per MTok),
 * with **no off-peak discount** applied — the same peak-rate basis as the
 * `deepseek-v4-pro` row above.
 */ const DEEPSEEK_FLASH_PRICING = {
  inputPerMillion: 0.30,
  outputPerMillion: 1.20,
  cacheWritePerMillion: 0,
  cacheReadPerMillion: 0.006,
  apiEquivalent: true
};
/**
 * Current (latest-tier) pricing per model tier (Issue #2389).
 *
 * Used as the fallback when a bare alias (`opus`/`sonnet`/`haiku`) or an
 * unmatched but tiered id (e.g. a future `claude-opus-4-9`) is looked up,
 * so new minor releases inherit the current rate rather than silently
 * falling through to the oldest/legacy row.
 */ export const TIER_CURRENT_PRICING = new Map([
  [
    "fable",
    FABLE_5_1_PRICING
  ],
  [
    "opus",
    OPUS_5_5_PRICING
  ],
  [
    "sonnet",
    SONNET_5_PRICING
  ],
  // Not Haiku 5.5's row, though `haiku` now serves Haiku 5.5 (Issue #3400):
  // the credit log records the requested alias, not the served model, so the
  // alias keeps the flat 4.x rate that bounds both generations (Issue #3399).
  [
    "haiku",
    HAIKU_PRICING
  ]
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
 */ export const MODEL_PRICING = new Map([
  // Claude Fable 5.1 — current top tier (Issue #747). Listed before the
  // broader `claude-fable-5` key per the more-specific-first rule above.
  // `lookupModelPricing` classifies every `claude-fable-…` id by version
  // before it reaches this map, so only a prefix walk over the rows sees the
  // order. Every released Fable 5 snapshot id carries a `2026…` date suffix,
  // so no Fable 5 id is captured by the 5.1 key. Pinned by
  // `batch_api_fable_pricing_test.ts`.
  [
    "claude-fable-5-1",
    FABLE_5_1_PRICING
  ],
  // Claude Fable 5 — the previous top tier (Issue #2619)
  [
    "claude-fable-5",
    FABLE_5_PRICING
  ],
  // Claude Opus 5.5 — current top tier, cheaper than Opus 5.0-5.4 (Issue
  // #2543). Listed before the broader `claude-opus-5` key per the
  // more-specific-first rule above.
  [
    "claude-opus-5-5",
    OPUS_5_5_PRICING
  ],
  // Claude Opus 5.0-5.4 — same reduced price point as Opus 4.8 (Issue #3559)
  [
    "claude-opus-5",
    OPUS_PRICING_MODERN
  ],
  // Claude Opus 4.5+ — reduced pricing (Issue #1398, #2389)
  [
    "claude-opus-4-8",
    OPUS_PRICING_MODERN
  ],
  [
    "claude-opus-4-7",
    OPUS_PRICING_MODERN
  ],
  [
    "claude-opus-4-6",
    OPUS_PRICING_MODERN
  ],
  [
    "claude-opus-4-5",
    OPUS_PRICING_MODERN
  ],
  // Claude Opus 4.0/4.1 — legacy pricing
  [
    "claude-opus-4",
    OPUS_PRICING_LEGACY
  ],
  // Claude Sonnet 5 is cheaper than the 4.x line (Issue #747); the broader claude-sonnet-4 prefix catches dated 4.0/4.1/4.2
  // ids that share the 4.x rate (Issue #2407).
  // Claude Sonnet 5.5 — same $2/$10 rate, half of Opus 5.5 (Issue #2812).
  // Listed before claude-sonnet-5 so first-match lookup names it explicitly.
  [
    "claude-sonnet-5-5",
    SONNET_5_PRICING
  ],
  [
    "claude-sonnet-5",
    SONNET_5_PRICING
  ],
  [
    "claude-sonnet-4-6",
    SONNET_4_PRICING
  ],
  [
    "claude-sonnet-4",
    SONNET_4_PRICING
  ],
  // Claude Haiku 5.5 — banded by prompt size (Issue #3399)
  [
    "claude-haiku-5-5",
    HAIKU_5_5_PRICING
  ],
  // Claude Haiku 4.5 (Issue #1398) — flat rate
  [
    "claude-haiku-4-5",
    HAIKU_PRICING
  ],
  // Legacy models
  [
    "claude-3-5-sonnet",
    SONNET_4_PRICING
  ],
  [
    "claude-3-5-haiku",
    {
      inputPerMillion: 0.80,
      outputPerMillion: 4,
      cacheWritePerMillion: 1,
      cacheReadPerMillion: 0.08
    }
  ],
  [
    "claude-3-opus",
    OPUS_PRICING_LEGACY
  ],
  // Non-Claude ids are priced at the vendor's **API-equivalent list price**
  // (Issue #1937, #1923, #1930) — every one of these providers runs on a
  // fixed-price subscription, so the figure is what the tokens would have
  // cost on that vendor's API and never a bill. `formatCostEstimateLines`
  // says so on the run-stats sub-bullet it renders, reading
  // `apiEquivalent` off the row. This replaces the Issue #1701 decision to
  // leave the Codex ids unpriced and charged at
  // UNPRICED_UPPER_BOUND_PRICING.
  //
  // Order matters: `lookupModelPricing` walks these rows with `startsWith`
  // and takes the first match, so each id's own row must precede any broader
  // prefix (`gpt-5-codex` and `gpt-5-mini` before `gpt-5`,
  // `gemini-2.5-flash-lite` before `gemini-2.5-flash`). Pinned by
  // `token_usage_test.ts`.
  //
  // The `gpt-5` key also captures a dotted future id (`gpt-5.2`,
  // `gpt-5.3-codex`), which OpenAI prices dearer than `gpt-5` — such an id
  // costs at the `gpt-5` rate rather than at its own, so a run on one would
  // be under-stated until it gets a row of its own.
  //
  // The Codex tiers now route to `gpt-6-astra`, `gpt-6.1-sol` and
  // `gpt-6-luna` (owner decision 2026-10-22, `config_defaults.ts`), which
  // have no published API price yet. They stay unpriced on purpose — charged
  // at UNPRICED_UPPER_BOUND_PRICING and listed as unpriced (Issue #3870) —
  // rather than given a guessed row; add each row once its price is known.
  [
    "gpt-5-codex",
    GPT_5_CODEX_PRICING
  ],
  [
    "gpt-5-mini",
    GPT_5_MINI_PRICING
  ],
  [
    "gpt-5",
    GPT_5_PRICING
  ],
  [
    "gemini-2.5-pro",
    GEMINI_2_5_PRO_PRICING
  ],
  [
    "gemini-2.5-flash-lite",
    GEMINI_2_5_FLASH_LITE_PRICING
  ],
  [
    "gemini-2.5-flash",
    GEMINI_2_5_FLASH_PRICING
  ],
  [
    "deepseek-v4-pro",
    DEEPSEEK_V4_PRO_PRICING
  ],
  [
    "deepseek-flash",
    DEEPSEEK_FLASH_PRICING
  ]
]);
/**
 * Conservative upper bound applied to an unrecognised model id (Issue #3870).
 *
 * Each rate is the dearest of every known row, so an invocation whose model id
 * is missing from the pricing table — the `"default"` sentinel, or any id newer
 * than this table — is over-estimated rather than counted as `$0`. The daily
 * spend ceiling then guards a budget that is never smaller than the real one.
 * Derived from the tables so a new (dearer) tier raises the bound automatically.
 */ export const UNPRICED_UPPER_BOUND_PRICING = (()=>{
  const rows = [
    ...TIER_CURRENT_PRICING.values(),
    ...MODEL_PRICING.values()
  ];
  return {
    inputPerMillion: Math.max(...rows.map((r)=>r.inputPerMillion)),
    outputPerMillion: Math.max(...rows.map((r)=>r.outputPerMillion)),
    cacheWritePerMillion: Math.max(...rows.map((r)=>r.cacheWritePerMillion)),
    cacheReadPerMillion: Math.max(...rows.map((r)=>r.cacheReadPerMillion))
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
 */ export function extractTokenUsage(rawStreamOutput) {
  if (!rawStreamOutput.trim()) return null;
  const lines = rawStreamOutput.split("\n").filter((l)=>l.trim());
  // Scan from the end — the result line is typically last
  for(let i = lines.length - 1; i >= 0; i--){
    const line = lines[i];
    // Quick pre-check to avoid parsing every line
    if (!line.includes('"result"') || !line.includes('"usage"')) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "result" && parsed.usage) {
        return {
          inputTokens: typeof parsed.usage.input_tokens === "number" ? parsed.usage.input_tokens : 0,
          outputTokens: typeof parsed.usage.output_tokens === "number" ? parsed.usage.output_tokens : 0,
          cacheCreationTokens: typeof parsed.usage.cache_creation_input_tokens === "number" ? parsed.usage.cache_creation_input_tokens : 0,
          cacheReadTokens: typeof parsed.usage.cache_read_input_tokens === "number" ? parsed.usage.cache_read_input_tokens : 0
        };
      }
    } catch  {
      continue;
    }
  }
  return null;
}
/**
 * Every tier alias, in descending capability order. The single source of
 * truth for "is this string a tier?" — callers that accept a tier from an
 * untrusted surface (e.g. an idle-task wrapper body, Issue #4010) allowlist
 * against this rather than passing an arbitrary string to `--model`.
 */ export const MODEL_TIERS = [
  "fable",
  "opus",
  "sonnet",
  "haiku"
];
/** Type guard: whether `value` is exactly one of the {@link MODEL_TIERS}. */ export function isModelTier(value) {
  return MODEL_TIERS.includes(value);
}
/** Minor version at/above which Opus uses the modern (4.5+) reduced pricing. */ const OPUS_MODERN_MIN_MINOR = 5;
/** Major version at/above which Opus can carry the cheaper 5.5 rate. */ const OPUS_5_5_MIN_MAJOR = 5;
/** Minor version at/above which Opus 5 uses the cheaper 5.5 rate. */ const OPUS_5_5_MIN_MINOR = 5;
/** Major version at/above which Fable can carry the cheaper cache-read rate. */ const FABLE_CHEAP_CACHE_MIN_MAJOR = 5;
/** Minor version at/above which Fable 5 uses the cheaper 5.1 cache-read rate. */ const FABLE_CHEAP_CACHE_MIN_MINOR = 1;
/** Major version at/above which Sonnet uses the cheaper Sonnet 5 rate. */ const SONNET_MODERN_MIN_MAJOR = 5;
/** Major version at/above which Haiku can carry the banded 5.5 rate. */ const HAIKU_5_5_MIN_MAJOR = 5;
/** Minor version at/above which Haiku 5 uses the banded 5.5 rate. */ const HAIKU_5_5_MIN_MINOR = 5;
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
 * Exported for `current_models.ts` (Issue #1362), which compares a served id
 * against the tier's current model — the same parse, so it must not be a second
 * copy that can drift from this one.
 *
 * @param model - Lowercased model identifier
 */ export function parseClaudeModernVersion(model) {
  const match = model.match(/^claude-(fable|opus|sonnet|haiku)-([45])(?:-(\d+))?/);
  if (!match) return null;
  const tier = match[1];
  const major = Number(match[2]);
  const group = match[3];
  const minor = group && group.length <= 2 ? Number(group) : 0;
  return {
    tier,
    major,
    minor
  };
}
/**
 * Look up pricing for a model name.
 *
 * Resolution order (Issue #2389):
 *   1. Bare tier alias (`fable`/`opus`/`sonnet`/`haiku`) → current tier
 *      pricing, so an alias always costs at the latest model of its tier.
 *   2. Claude 4/5 family id → classify by version so future minors
 *      inherit the modern reduced pricing instead of the legacy row.
 *   3. Explicit prefix match for the remaining (legacy 3-x) models.
 *
 * Returns null if no matching pricing is found.
 *
 * @param model - Model identifier or alias (e.g. "opus", "claude-opus-4-8")
 * @returns Model pricing or null
 */ export function lookupModelPricing(model) {
  const normalised = model.toLowerCase();
  // 1. Bare tier alias → current pricing for that tier.
  const alias = TIER_CURRENT_PRICING.get(normalised);
  if (alias) return alias;
  // 2. Claude 4/5 family — classify by version, so a minor release the table
  //    has never seen is priced by its own generation rather than by whichever
  //    row happens to match its prefix. Opus 5+ and Opus 4.5+ share the modern
  //    reduced rate and only Opus 4.0/4.1 are legacy (Issue #3559); Fable 5.1+
  //    reads cache at a quarter of the Fable 5 rate and Sonnet 5 is cheaper
  //    than the Sonnet 4.x line (Issue #747). Haiku 5.5+ is banded by
  //    prompt size and every earlier Haiku is flat (Issue #3399).
  const parsed = parseClaudeModernVersion(normalised);
  if (parsed) {
    if (parsed.tier === "opus") {
      // Both halves matter: the cheaper 5.5 rate arrived with Opus 5.5, so a
      // `claude-opus-4-5` must not inherit it on minor alone (Issue #2543).
      if (parsed.major >= OPUS_5_5_MIN_MAJOR && parsed.minor >= OPUS_5_5_MIN_MINOR) {
        return OPUS_5_5_PRICING;
      }
      const modern = parsed.major >= 5 || parsed.minor >= OPUS_MODERN_MIN_MINOR;
      return modern ? OPUS_PRICING_MODERN : OPUS_PRICING_LEGACY;
    }
    if (parsed.tier === "fable") {
      // Both halves matter: the cheap cache-read rate arrived with 5.1, so a
      // hypothetical `claude-fable-4-1` must not inherit it on minor alone.
      const cheapCache = parsed.major >= FABLE_CHEAP_CACHE_MIN_MAJOR && parsed.minor >= FABLE_CHEAP_CACHE_MIN_MINOR;
      return cheapCache ? FABLE_5_1_PRICING : FABLE_5_PRICING;
    }
    if (parsed.tier === "sonnet") {
      return parsed.major >= SONNET_MODERN_MIN_MAJOR ? SONNET_5_PRICING : SONNET_4_PRICING;
    }
    // Both halves matter, as for Opus: the band arrived with Haiku 5.5.
    return parsed.major >= HAIKU_5_5_MIN_MAJOR && parsed.minor >= HAIKU_5_5_MIN_MINOR ? HAIKU_5_5_PRICING : HAIKU_PRICING;
  }
  // 3. Explicit prefix match for everything else (legacy 3-x models).
  for (const [prefix, pricing] of MODEL_PRICING){
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
 * @param options - Whether `usage` is one request's (see {@link CostEstimateOptions})
 * @returns Cost breakdown or null if model pricing is unknown
 */ export function estimateCost(usage, model, options = {}) {
  const pricing = lookupModelPricing(model);
  if (!pricing) return null;
  return costFor(usage, pricing, options);
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
 * @param options - Whether `usage` is one request's (see {@link CostEstimateOptions})
 * @returns The cost and whether real pricing was found
 */ export function estimateCostWithUpperBound(usage, model, options = {}) {
  const pricing = lookupModelPricing(model);
  return {
    cost: costFor(usage, pricing ?? UNPRICED_UPPER_BOUND_PRICING, options),
    priced: pricing !== null
  };
}
/**
 * The rates that apply to `usage`: a banded row's lower band when `usage` is
 * one request whose prompt fits it, otherwise the row's own (upper) rates.
 */ function ratesFor(usage, pricing, options) {
  const band = pricing.lowerBand;
  if (!band || !options.singleRequest) return pricing;
  const prompt = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  return prompt <= band.maxPromptTokens ? band : pricing;
}
/** Apply a pricing row to a set of token counts. */ function costFor(usage, row, options = {}) {
  const pricing = ratesFor(usage, row, options);
  const inputCost = usage.inputTokens / 1_000_000 * pricing.inputPerMillion;
  const outputCost = usage.outputTokens / 1_000_000 * pricing.outputPerMillion;
  const cacheWriteCost = usage.cacheCreationTokens / 1_000_000 * pricing.cacheWritePerMillion;
  const cacheReadCost = usage.cacheReadTokens / 1_000_000 * pricing.cacheReadPerMillion;
  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi90b2tlbl91c2FnZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRva2VuIHVzYWdlIGV4dHJhY3Rpb24gYW5kIGNvc3QgZXN0aW1hdGlvbiAoSXNzdWUgIzEyNjApLlxuICpcbiAqIFBhcnNlcyBDbGF1ZGUgQ0xJIHN0cmVhbS1qc29uIG91dHB1dCBmb3IgdG9rZW4gdXNhZ2UgZmllbGRzIGFuZCBwcm92aWRlc1xuICogY29zdCBlc3RpbWF0aW9uIGJhc2VkIG9uIGtub3duIG1vZGVsIHByaWNpbmcuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBUeXBlc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBUb2tlbiB1c2FnZSBleHRyYWN0ZWQgZnJvbSBhIENsYXVkZSBDTEkgaW52b2NhdGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9rZW5Vc2FnZSB7XG4gIC8qKiBOdW1iZXIgb2YgaW5wdXQgdG9rZW5zIGNvbnN1bWVkLiAqL1xuICBpbnB1dFRva2VuczogbnVtYmVyO1xuICAvKiogTnVtYmVyIG9mIG91dHB1dCB0b2tlbnMgZ2VuZXJhdGVkLiAqL1xuICBvdXRwdXRUb2tlbnM6IG51bWJlcjtcbiAgLyoqIE51bWJlciBvZiB0b2tlbnMgd3JpdHRlbiB0byB0aGUgcHJvbXB0IGNhY2hlLiAqL1xuICBjYWNoZUNyZWF0aW9uVG9rZW5zOiBudW1iZXI7XG4gIC8qKiBOdW1iZXIgb2YgdG9rZW5zIHJlYWQgZnJvbSB0aGUgcHJvbXB0IGNhY2hlLiAqL1xuICBjYWNoZVJlYWRUb2tlbnM6IG51bWJlcjtcbn1cblxuLyoqIFByaWNpbmcgcGVyIG1pbGxpb24gdG9rZW5zIGZvciBhIG1vZGVsIHRpZXIuICovXG5leHBvcnQgaW50ZXJmYWNlIE1vZGVsUHJpY2luZyB7XG4gIC8qKiBDb3N0IHBlciBtaWxsaW9uIGlucHV0IHRva2VucyAoVVNEKS4gKi9cbiAgaW5wdXRQZXJNaWxsaW9uOiBudW1iZXI7XG4gIC8qKiBDb3N0IHBlciBtaWxsaW9uIG91dHB1dCB0b2tlbnMgKFVTRCkuICovXG4gIG91dHB1dFBlck1pbGxpb246IG51bWJlcjtcbiAgLyoqIENvc3QgcGVyIG1pbGxpb24gY2FjaGUtd3JpdGUgdG9rZW5zIChVU0QpLiAqL1xuICBjYWNoZVdyaXRlUGVyTWlsbGlvbjogbnVtYmVyO1xuICAvKiogQ29zdCBwZXIgbWlsbGlvbiBjYWNoZS1yZWFkIHRva2VucyAoVVNEKS4gKi9cbiAgY2FjaGVSZWFkUGVyTWlsbGlvbjogbnVtYmVyO1xuICAvKipcbiAgICogUHJlc2VudCAoYW5kIGFsd2F5cyBgdHJ1ZWApIHdoZW4gdGhlIHJvdyBpcyB0aGUgdmVuZG9yJ3MgKipBUEktZXF1aXZhbGVudFxuICAgKiBsaXN0IHByaWNlKiogcmF0aGVyIHRoYW4gYSByYXRlIHRoZSBmbGVldCBpcyBiaWxsZWQgKElzc3VlICMxOTM3KS5cbiAgICpcbiAgICogRXZlcnkgbm9uLUNsYXVkZSBwcm92aWRlciBydW5zIG9uIGEgZml4ZWQtcHJpY2Ugc3Vic2NyaXB0aW9uIChJc3N1ZVxuICAgKiAjMTkyMyksIHNvIGl0cyBwZXItdG9rZW4gZmlndXJlIGlzIHdoYXQgdGhlIHNhbWUgdG9rZW5zIHdvdWxkIGhhdmUgY29zdFxuICAgKiBvbiB0aGF0IHZlbmRvcidzIEFQSSDigJQgbmV2ZXIgYSBiaWxsLiBSZW5kZXJlcnMgcmVhZCB0aGlzIG1hcmtlciBvZmYgdGhlXG4gICAqIHJvdyByYXRoZXIgdGhhbiBzbmlmZmluZyB0aGUgbW9kZWwgaWQ6IGBmb3JtYXRDb3N0RXN0aW1hdGVMaW5lc2AgcmVjZWl2ZXNcbiAgICogb25seSBge21vZGVsLCB1c2FnZX1gIGFuZCBuZXZlciBzZWVzIGEgcHJvdmlkZXIgaWQuIENsYXVkZSByb3dzIGNhcnJ5IG5vXG4gICAqIG1hcmtlci5cbiAgICovXG4gIGFwaUVxdWl2YWxlbnQ/OiB0cnVlO1xuICAvKipcbiAgICogQSBjaGVhcGVyIGJhbmQgZm9yIHJlcXVlc3RzIHdob3NlIHByb21wdCDigJQgaW5wdXQgcGx1cyBjYWNoZS13cml0ZSBwbHVzXG4gICAqIGNhY2hlLXJlYWQgdG9rZW5zIOKAlCBpcyBhdCBtb3N0IGBtYXhQcm9tcHRUb2tlbnNgIChJc3N1ZSAjMzM5OSkuIFRoZVxuICAgKiByb3cncyBvd24gcmF0ZXMgYXJlIHRoZSBkZWFyZXIgYmFuZCBhYm92ZSBpdCwgc28gYSBjYWxsZXIgdGhhdCBjYW5ub3RcbiAgICogc2VlIG9uZSByZXF1ZXN0J3MgcHJvbXB0IHNpemUgKHJ1biB0b3RhbHMpIGlzIGNvc3RlZCBhdCB0aGUgdXBwZXIgYmFuZFxuICAgKiBhbmQgbmV2ZXIgdW5kZXItc3RhdGVzLlxuICAgKi9cbiAgbG93ZXJCYW5kPzogUHJpY2luZ0JhbmQ7XG59XG5cbi8qKiBUaGUgcmF0ZXMgb2YgYSBwcm9tcHQtc2l6ZSBiYW5kIGJlbG93IGEgcm93J3Mgb3duIHJhdGVzIChJc3N1ZSAjMzM5OSkuICovXG5leHBvcnQgaW50ZXJmYWNlIFByaWNpbmdCYW5kIHtcbiAgLyoqIExhcmdlc3QgcHJvbXB0LCBpbiB0b2tlbnMsIHRoYXQgb25lIHJlcXVlc3QgbWF5IGNhcnJ5IGluIHRoaXMgYmFuZC4gKi9cbiAgbWF4UHJvbXB0VG9rZW5zOiBudW1iZXI7XG4gIC8qKiBDb3N0IHBlciBtaWxsaW9uIGlucHV0IHRva2VucyAoVVNEKS4gKi9cbiAgaW5wdXRQZXJNaWxsaW9uOiBudW1iZXI7XG4gIC8qKiBDb3N0IHBlciBtaWxsaW9uIG91dHB1dCB0b2tlbnMgKFVTRCkuICovXG4gIG91dHB1dFBlck1pbGxpb246IG51bWJlcjtcbiAgLyoqIENvc3QgcGVyIG1pbGxpb24gY2FjaGUtd3JpdGUgdG9rZW5zIChVU0QpLiAqL1xuICBjYWNoZVdyaXRlUGVyTWlsbGlvbjogbnVtYmVyO1xuICAvKiogQ29zdCBwZXIgbWlsbGlvbiBjYWNoZS1yZWFkIHRva2VucyAoVVNEKS4gKi9cbiAgY2FjaGVSZWFkUGVyTWlsbGlvbjogbnVtYmVyO1xufVxuXG4vKiogQ29zdCBicmVha2Rvd24gZm9yIGEgc2V0IG9mIHRva2VuIGNvdW50cy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29zdEJyZWFrZG93biB7XG4gIC8qKiBDb3N0IG9mIGlucHV0IHRva2VucyAoVVNEKS4gKi9cbiAgaW5wdXRDb3N0OiBudW1iZXI7XG4gIC8qKiBDb3N0IG9mIG91dHB1dCB0b2tlbnMgKFVTRCkuICovXG4gIG91dHB1dENvc3Q6IG51bWJlcjtcbiAgLyoqIENvc3Qgb2YgY2FjaGUtd3JpdGUgdG9rZW5zIChVU0QpLiAqL1xuICBjYWNoZVdyaXRlQ29zdDogbnVtYmVyO1xuICAvKiogQ29zdCBvZiBjYWNoZS1yZWFkIHRva2VucyAoVVNEKS4gKi9cbiAgY2FjaGVSZWFkQ29zdDogbnVtYmVyO1xuICAvKiogVG90YWwgY29zdCAoVVNEKS4gKi9cbiAgdG90YWxDb3N0OiBudW1iZXI7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gS25vd24gbW9kZWwgcHJpY2luZyAoVVNEIHBlciBtaWxsaW9uIHRva2VucywgYXMgb2YgU2VwdGVtYmVyIDIwMjYpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLy8gU2hhcmVkIHByaWNpbmcgY29uc3RhbnRzIOKAlCBzaW5nbGUgc291cmNlIG9mIHRydXRoIHNvIHRoZSBleHBsaWNpdFxuLy8gTU9ERUxfUFJJQ0lORyByb3dzIGFuZCB0aGUgdGllci1hd2FyZSBmYWxsYmFjayBuZXZlciBkaXZlcmdlIChJc3N1ZSAjMjM4OSkuXG5cbi8qKlxuICogQ2xhdWRlIEZhYmxlIDUuMSDigJQgY3VycmVudCB0b3AgdGllciBhYm92ZSBPcHVzIChJc3N1ZSAjNzQ3KS5cbiAqXG4gKiBTYW1lIGlucHV0L291dHB1dCByYXRlIGFzIEZhYmxlIDUsIHdpdGggY2FjaGUgcmVhZHMgYXQgYSBxdWFydGVyIG9mIHRoZVxuICogRmFibGUgNSByYXRlICgwLjAyNcOXIGJhc2UgaW5wdXQgcmF0aGVyIHRoYW4gdGhlIHVzdWFsIDAuMcOXKS5cbiAqL1xuY29uc3QgRkFCTEVfNV8xX1BSSUNJTkc6IE1vZGVsUHJpY2luZyA9IHtcbiAgaW5wdXRQZXJNaWxsaW9uOiAxMCxcbiAgb3V0cHV0UGVyTWlsbGlvbjogNTAsXG4gIGNhY2hlV3JpdGVQZXJNaWxsaW9uOiAxMi41MCxcbiAgY2FjaGVSZWFkUGVyTWlsbGlvbjogMC4yNSxcbn07XG5cbi8qKlxuICogQ2xhdWRlIEZhYmxlIDUgKElzc3VlICMyNjE5KSDigJQga2VwdCBhcyBpdHMgb3duIHJvdyBzbyBhIHJ1bi1zdGF0cyBjb21tZW50XG4gKiBmb3IgYSBydW4gc2VydmVkIGJ5IEZhYmxlIDUgaXMgc3RpbGwgY29zdGVkIGF0IHRoZSAkMS9NVG9rIGNhY2hlLXJlYWQgcmF0ZVxuICogaXQgd2FzIGFjdHVhbGx5IGJpbGxlZCBhdCAoSXNzdWUgIzc0NykuXG4gKi9cbmNvbnN0IEZBQkxFXzVfUFJJQ0lORzogTW9kZWxQcmljaW5nID0ge1xuICBpbnB1dFBlck1pbGxpb246IDEwLFxuICBvdXRwdXRQZXJNaWxsaW9uOiA1MCxcbiAgY2FjaGVXcml0ZVBlck1pbGxpb246IDEyLjUwLFxuICBjYWNoZVJlYWRQZXJNaWxsaW9uOiAxLFxufTtcblxuLyoqXG4gKiBDbGF1ZGUgT3B1cyA1LjUg4oCUIGN1cnJlbnQgdG9wIHRpZXIsIHJlcGxhY2luZyBGYWJsZSAoSXNzdWUgIzI1NDMpLlxuICpcbiAqIENoZWFwZXIgdGhhbiBPcHVzIDUuMC01LjQvNC41KyBvbiBldmVyeSByYXRlLCBhbmQgY2FjaGUgaGl0cy9yZWZyZXNoZXMgYXJlXG4gKiBwcmljZWQgYXQgMC4wNXggdGhlIGJhc2UgaW5wdXQgcmF0ZSByYXRoZXIgdGhhbiB0aGUgdXN1YWwgMC4xeC5cbiAqIFNvdXJjZTogaHR0cHM6Ly9wbGF0Zm9ybS5jbGF1ZGUuY29tL2RvY3MvZW4vYWJvdXQtY2xhdWRlL3ByaWNpbmcsIGNoZWNrZWRcbiAqIDIwMjYtMDktMjMuXG4gKi9cbmNvbnN0IE9QVVNfNV81X1BSSUNJTkc6IE1vZGVsUHJpY2luZyA9IHtcbiAgaW5wdXRQZXJNaWxsaW9uOiA0LFxuICBvdXRwdXRQZXJNaWxsaW9uOiAyMCxcbiAgY2FjaGVXcml0ZVBlck1pbGxpb246IDUsXG4gIGNhY2hlUmVhZFBlck1pbGxpb246IDAuMjAsXG59O1xuXG4vKiogQ2xhdWRlIE9wdXMgNC41LTUuNCDigJQgcmVkdWNlZCBwcmljaW5nIChJc3N1ZSAjMTM5OCkuICovXG5jb25zdCBPUFVTX1BSSUNJTkdfTU9ERVJOOiBNb2RlbFByaWNpbmcgPSB7XG4gIGlucHV0UGVyTWlsbGlvbjogNSxcbiAgb3V0cHV0UGVyTWlsbGlvbjogMjUsXG4gIGNhY2hlV3JpdGVQZXJNaWxsaW9uOiA2LjI1LFxuICBjYWNoZVJlYWRQZXJNaWxsaW9uOiAwLjUwLFxufTtcblxuLyoqIENsYXVkZSBPcHVzIDQuMC80LjEgKGFuZCBDbGF1ZGUgMyBPcHVzKSDigJQgbGVnYWN5IHByaWNpbmcuICovXG5jb25zdCBPUFVTX1BSSUNJTkdfTEVHQUNZOiBNb2RlbFByaWNpbmcgPSB7XG4gIGlucHV0UGVyTWlsbGlvbjogMTUsXG4gIG91dHB1dFBlck1pbGxpb246IDc1LFxuICBjYWNoZVdyaXRlUGVyTWlsbGlvbjogMTguNzUsXG4gIGNhY2hlUmVhZFBlck1pbGxpb246IDEuNTAsXG59O1xuXG4vKipcbiAqIENsYXVkZSBTb25uZXQgNSDigJQgY3VycmVudCBTb25uZXQgKElzc3VlICM3NDcpLlxuICpcbiAqICQyLyQxMCBsb29rcyBsaWtlIHRoZSBleHBpcmVkIGludHJvZHVjdG9yeSByYXRlIGFuZCBpcyBub3QuIEFudGhyb3BpYydzXG4gKiBwcmljaW5nIHBhZ2UgKGh0dHBzOi8vcGxhdGZvcm0uY2xhdWRlLmNvbS9kb2NzL2VuL2Fib3V0LWNsYXVkZS9wcmljaW5nKVxuICogY2FycmllcyBhIG5vdGUgYmVzaWRlIHRoZSB0YWJsZTogdGhlIGxhdW5jaCByYXRlLCBhbm5vdW5jZWQgYXMgaW50cm9kdWN0b3J5XG4gKiB0aHJvdWdoIDIwMjYtMDgtMzEsIFwiaXMgbm93IHRoZSBzdGFuZGFyZCBwcmljZVwiLCBhbmQgXCJ0aGUgcHJldmlvdXNseVxuICogc2NoZWR1bGVkIGluY3JlYXNlIHRvICQzLyQxNSBwZXIgbWlsbGlvbiBpbnB1dC9vdXRwdXQgdG9rZW5zIG9uXG4gKiBTZXB0ZW1iZXIgMSwgMjAyNiB3aWxsIG5vdCBvY2N1clwiLiBDaGVja2VkIDIwMjYtMDktMDIuXG4gKi9cbmNvbnN0IFNPTk5FVF81X1BSSUNJTkc6IE1vZGVsUHJpY2luZyA9IHtcbiAgaW5wdXRQZXJNaWxsaW9uOiAyLFxuICBvdXRwdXRQZXJNaWxsaW9uOiAxMCxcbiAgY2FjaGVXcml0ZVBlck1pbGxpb246IDIuNTAsXG4gIGNhY2hlUmVhZFBlck1pbGxpb246IDAuMjAsXG59O1xuXG4vKiogQ2xhdWRlIFNvbm5ldCA0LnggcHJpY2luZyAoSXNzdWUgIzE0MDApIOKAlCBkZWFyZXIgdGhhbiBTb25uZXQgNS4gKi9cbmNvbnN0IFNPTk5FVF80X1BSSUNJTkc6IE1vZGVsUHJpY2luZyA9IHtcbiAgaW5wdXRQZXJNaWxsaW9uOiAzLFxuICBvdXRwdXRQZXJNaWxsaW9uOiAxNSxcbiAgY2FjaGVXcml0ZVBlck1pbGxpb246IDMuNzUsXG4gIGNhY2hlUmVhZFBlck1pbGxpb246IDAuMzAsXG59O1xuXG4vKipcbiAqIENsYXVkZSBIYWlrdSA0LnggcHJpY2luZyAoSXNzdWUgIzE0MDAsICMxMzk4KSDigJQgZmxhdCwgd2l0aCBubyBwcm9tcHQtc2l6ZVxuICogYmFuZC4gQWxzbyB0aGUgYmFyZSBgaGFpa3VgIGFsaWFzJ3MgcmF0ZTogYXQgb3IgYWJvdmUgSGFpa3UgNS41J3MgdXBwZXIgYmFuZFxuICogb24gZXZlcnkgY29tcG9uZW50LCBzbyBpdCBib3VuZHMgYm90aCBnZW5lcmF0aW9ucyAoSXNzdWUgIzMzOTkpLlxuICovXG5jb25zdCBIQUlLVV9QUklDSU5HOiBNb2RlbFByaWNpbmcgPSB7XG4gIGlucHV0UGVyTWlsbGlvbjogMSxcbiAgb3V0cHV0UGVyTWlsbGlvbjogNSxcbiAgY2FjaGVXcml0ZVBlck1pbGxpb246IDEuMjUsXG4gIGNhY2hlUmVhZFBlck1pbGxpb246IDAuMTAsXG59O1xuXG4vKipcbiAqIENsYXVkZSBIYWlrdSA1LjUg4oCUIGJhbmRlZCBieSBwcm9tcHQgc2l6ZSBwZXIgcmVxdWVzdCAoSXNzdWUgIzMzOTkpLiBUaGVcbiAqIHJvdydzIHJhdGVzIGFyZSB0aGUgPjEwMGsgYmFuZDsgYGxvd2VyQmFuZGAgY2FycmllcyB0aGUg4omkMTAwayByYXRlcyxcbiAqIGEgdGVudGggb2YgSGFpa3UgNC41J3MuXG4gKi9cbmNvbnN0IEhBSUtVXzVfNV9QUklDSU5HOiBNb2RlbFByaWNpbmcgPSB7XG4gIGlucHV0UGVyTWlsbGlvbjogMC41MCxcbiAgb3V0cHV0UGVyTWlsbGlvbjogMi41MCxcbiAgY2FjaGVXcml0ZVBlck1pbGxpb246IDAuNjI1LFxuICBjYWNoZVJlYWRQZXJNaWxsaW9uOiAwLjA1LFxuICBsb3dlckJhbmQ6IHtcbiAgICBtYXhQcm9tcHRUb2tlbnM6IDEwMF8wMDAsXG4gICAgaW5wdXRQZXJNaWxsaW9uOiAwLjEwLFxuICAgIG91dHB1dFBlck1pbGxpb246IDAuNTAsXG4gICAgY2FjaGVXcml0ZVBlck1pbGxpb246IDAuMTI1LFxuICAgIGNhY2hlUmVhZFBlck1pbGxpb246IDAuMDEsXG4gIH0sXG59O1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE5vbi1DbGF1ZGUgQVBJLWVxdWl2YWxlbnQgbGlzdCBwcmljZXMgKElzc3VlICMxOTM3KVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vL1xuLy8gVGhlIHdvcmtlciByb3V0ZXMgdG8gQ29kZXgsIEdlbWluaSBhbmQgRGVlcFNlZWsgb24gYSBmaXhlZC1wcmljZVxuLy8gc3Vic2NyaXB0aW9uLCBzbyBub25lIG9mIHRoZXNlIHJvd3MgaXMgYSBiaWxsIChJc3N1ZSAjMTkyMykuIEVhY2ggaXMgdGhlXG4vLyB2ZW5kb3IncyBwdWJsaXNoZWQgQVBJIGxpc3QgcHJpY2UgZm9yIHRoZSBzYW1lIHRva2Vucywgc28gYSBydW4gb24gb25lIG9mXG4vLyB0aGVzZSBpZHMgcmVuZGVycyBhIFVTRCBmaWd1cmUg4oCUIGxhYmVsbGVkIGAoQVBJLWVxdWl2YWxlbnQpYCBvbiBpdHNcbi8vIHJ1bi1zdGF0cyBzdWItYnVsbGV0IOKAlCBpbnN0ZWFkIG9mIGZhbGxpbmcgdGhyb3VnaCB0b1xuLy8gVU5QUklDRURfVVBQRVJfQk9VTkRfUFJJQ0lORy4gVGhpcyByZXBsYWNlcyB0aGUgSXNzdWUgIzE3MDEgZGVjaXNpb24gdG9cbi8vIGxlYXZlIHRoZSBDb2RleCBpZHMgdW5wcmljZWQuXG4vL1xuLy8gYGNhY2hlV3JpdGVQZXJNaWxsaW9uYCBpcyAwIGZvciBldmVyeSByb3cgYmVsb3c6IG5vbmUgb2YgdGhlc2UgdGhyZWVcbi8vIHZlbmRvcnMgYmlsbHMgYSBwZXItdG9rZW4gY2FjaGUgd3JpdGUgdGhlIHdheSBBbnRocm9waWMgZG9lcyAoQ29kZXggcmVwb3J0c1xuLy8gbm8gY2FjaGUtd3JpdGUgY291bnRlciBhdCBhbGwsIGFuZCBHZW1pbmkncyBleHBsaWNpdC1jYWNoZSBzdG9yYWdlIGlzXG4vLyBjaGFyZ2VkIGhvdXJseSwgd2hpY2ggaXMgbm90IG1vZGVsbGVkKS4gYGNhY2hlUmVhZFBlck1pbGxpb25gIGlzIHRoZVxuLy8gdmVuZG9yJ3MgY2FjaGVkLWlucHV0IHJhdGUuXG4vL1xuLy8gRWFjaCBpZCBrZWVwcyBpdHMgb3duIHJvdyBldmVuIHdoZXJlIHR3byBjdXJyZW50bHkgc2hhcmUgYSByYXRlLCBzbyBhXG4vLyBkaXZlcmdlbmNlIGF0IHRoZSB2ZW5kb3IgaXMgYSBvbmUtcm93IGVkaXQgYW5kIHRoZSBvcmRlcmVkIHByZWZpeCB3YWxrIGluXG4vLyBgbG9va3VwTW9kZWxQcmljaW5nYCBpcyBwcm92YWJseSByZWFjaGluZyB0aGUgc3BlY2lmaWMgcm93IChwaW5uZWQgYnlcbi8vIGB0b2tlbl91c2FnZV90ZXN0LnRzYCkuXG5cbi8qKlxuICogT3BlbkFJIGBncHQtNS1jb2RleGAg4oCUIHRoZSBDb2RleCB0b3AgdGllci5cbiAqXG4gKiBTb3VyY2U6IGh0dHBzOi8vZGV2ZWxvcGVycy5vcGVuYWkuY29tL2FwaS9kb2NzL21vZGVscy9ncHQtNS1jb2RleFxuICogKCQxLjI1IGlucHV0IC8gJDAuMTI1IGNhY2hlZCBpbnB1dCAvICQxMC4wMCBvdXRwdXQgcGVyIE1Ub2spLCBjaGVja2VkIG9uXG4gKiAyMDI2LTA5LTExLiBUaGUgbW9kZWwgaXMgY3VycmVudCwgbm90IGRlcHJlY2F0ZWQ7IGl0cyBzbmFwc2hvdCBpcyB1cGRhdGVkXG4gKiBpbiBwbGFjZSBieSBPcGVuQUkuXG4gKi9cbmNvbnN0IEdQVF81X0NPREVYX1BSSUNJTkc6IE1vZGVsUHJpY2luZyA9IHtcbiAgaW5wdXRQZXJNaWxsaW9uOiAxLjI1LFxuICBvdXRwdXRQZXJNaWxsaW9uOiAxMCxcbiAgY2FjaGVXcml0ZVBlck1pbGxpb246IDAsXG4gIGNhY2hlUmVhZFBlck1pbGxpb246IDAuMTI1LFxuICBhcGlFcXVpdmFsZW50OiB0cnVlLFxufTtcblxuLyoqXG4gKiBPcGVuQUkgYGdwdC01LW1pbmlgIOKAlCB0aGUgQ29kZXggY2hlYXAgdGllci5cbiAqXG4gKiBTb3VyY2U6IGh0dHBzOi8vZGV2ZWxvcGVycy5vcGVuYWkuY29tL2FwaS9kb2NzL3ByaWNpbmcgKCQwLjI1IGlucHV0IC9cbiAqICQwLjAyNSBjYWNoZWQgaW5wdXQgLyAkMi4wMCBvdXRwdXQgcGVyIE1Ub2spLCBjaGVja2VkIG9uIDIwMjYtMDktMTEuXG4gKi9cbmNvbnN0IEdQVF81X01JTklfUFJJQ0lORzogTW9kZWxQcmljaW5nID0ge1xuICBpbnB1dFBlck1pbGxpb246IDAuMjUsXG4gIG91dHB1dFBlck1pbGxpb246IDIsXG4gIGNhY2hlV3JpdGVQZXJNaWxsaW9uOiAwLFxuICBjYWNoZVJlYWRQZXJNaWxsaW9uOiAwLjAyNSxcbiAgYXBpRXF1aXZhbGVudDogdHJ1ZSxcbn07XG5cbi8qKlxuICogT3BlbkFJIGBncHQtNWAg4oCUIHRoZSBDb2RleCBiYXNlIHRpZXIuXG4gKlxuICogU291cmNlOiBodHRwczovL2RldmVsb3BlcnMub3BlbmFpLmNvbS9hcGkvZG9jcy9wcmljaW5nICgkMS4yNSBpbnB1dCAvXG4gKiAkMC4xMjUgY2FjaGVkIGlucHV0IC8gJDEwLjAwIG91dHB1dCBwZXIgTVRvayksIGNoZWNrZWQgb24gMjAyNi0wOS0xMS5cbiAqL1xuY29uc3QgR1BUXzVfUFJJQ0lORzogTW9kZWxQcmljaW5nID0ge1xuICBpbnB1dFBlck1pbGxpb246IDEuMjUsXG4gIG91dHB1dFBlck1pbGxpb246IDEwLFxuICBjYWNoZVdyaXRlUGVyTWlsbGlvbjogMCxcbiAgY2FjaGVSZWFkUGVyTWlsbGlvbjogMC4xMjUsXG4gIGFwaUVxdWl2YWxlbnQ6IHRydWUsXG59O1xuXG4vKipcbiAqIEdvb2dsZSBgZ2VtaW5pLTIuNS1wcm9gIOKAlCB0aGUgR2VtaW5pIHRvcCB0aWVyLlxuICpcbiAqIFNvdXJjZTogaHR0cHM6Ly9haS5nb29nbGUuZGV2L2dlbWluaS1hcGkvZG9jcy9wcmljaW5nLCBjaGVja2VkIG9uXG4gKiAyMDI2LTA5LTExLiBCYXNpczogdGhlIHBhaWQgdGllcidzICoq4omkMjAwayBwcm9tcHQtdG9rZW4qKiBiYW5kICgkMS4yNVxuICogaW5wdXQgLyAkMC4xMjUgY29udGV4dC1jYWNoZSByZWFkIC8gJDEwLjAwIG91dHB1dCBwZXIgTVRvayk7IHByb21wdHMgYWJvdmVcbiAqIDIwMGsgdG9rZW5zIGJpbGwgYXQgJDIuNTAgLyAkMC4yNSAvICQxNS4wMCwgd2hpY2ggdGhpcyByb3cgZG9lcyBub3QgbW9kZWwuXG4gKiBUaGlua2luZyB0b2tlbnMgYXJlIGJpbGxlZCBhcyBvdXRwdXQgKFwiT3V0cHV0IHByaWNlIChpbmNsdWRpbmcgdGhpbmtpbmdcbiAqIHRva2VucylcIiksIHNvIHRoZXkgbmVlZCBubyBzZXBhcmF0ZSByYXRlLlxuICovXG5jb25zdCBHRU1JTklfMl81X1BST19QUklDSU5HOiBNb2RlbFByaWNpbmcgPSB7XG4gIGlucHV0UGVyTWlsbGlvbjogMS4yNSxcbiAgb3V0cHV0UGVyTWlsbGlvbjogMTAsXG4gIGNhY2hlV3JpdGVQZXJNaWxsaW9uOiAwLFxuICBjYWNoZVJlYWRQZXJNaWxsaW9uOiAwLjEyNSxcbiAgYXBpRXF1aXZhbGVudDogdHJ1ZSxcbn07XG5cbi8qKlxuICogR29vZ2xlIGBnZW1pbmktMi41LWZsYXNoLWxpdGVgIOKAlCB0aGUgR2VtaW5pIGNoZWFwIHRpZXIuXG4gKlxuICogU291cmNlOiBodHRwczovL2FpLmdvb2dsZS5kZXYvZ2VtaW5pLWFwaS9kb2NzL3ByaWNpbmcsIGNoZWNrZWQgb25cbiAqIDIwMjYtMDktMTEuIEJhc2lzOiB0aGUgdGV4dC9pbWFnZS92aWRlbyByYXRlICgkMC4xMCBpbnB1dCAvICQwLjAxXG4gKiBjb250ZXh0LWNhY2hlIHJlYWQgLyAkMC40MCBvdXRwdXQgcGVyIE1Ub2spOyB0aGUgZGVhcmVyIGF1ZGlvIGlucHV0IHJhdGVcbiAqICgkMC4zMCkgaXMgbm90IG1vZGVsbGVkLiBUaGlua2luZyB0b2tlbnMgYXJlIGJpbGxlZCBhcyBvdXRwdXQuXG4gKi9cbmNvbnN0IEdFTUlOSV8yXzVfRkxBU0hfTElURV9QUklDSU5HOiBNb2RlbFByaWNpbmcgPSB7XG4gIGlucHV0UGVyTWlsbGlvbjogMC4xMCxcbiAgb3V0cHV0UGVyTWlsbGlvbjogMC40MCxcbiAgY2FjaGVXcml0ZVBlck1pbGxpb246IDAsXG4gIGNhY2hlUmVhZFBlck1pbGxpb246IDAuMDEsXG4gIGFwaUVxdWl2YWxlbnQ6IHRydWUsXG59O1xuXG4vKipcbiAqIEdvb2dsZSBgZ2VtaW5pLTIuNS1mbGFzaGAg4oCUIHRoZSBHZW1pbmkgYmFzZSB0aWVyLlxuICpcbiAqIFNvdXJjZTogaHR0cHM6Ly9haS5nb29nbGUuZGV2L2dlbWluaS1hcGkvZG9jcy9wcmljaW5nLCBjaGVja2VkIG9uXG4gKiAyMDI2LTA5LTExLiBCYXNpczogdGhlIHRleHQvaW1hZ2UvdmlkZW8gcmF0ZSAoJDAuMzAgaW5wdXQgLyAkMC4wM1xuICogY29udGV4dC1jYWNoZSByZWFkIC8gJDIuNTAgb3V0cHV0IHBlciBNVG9rKTsgdGhlIGRlYXJlciBhdWRpbyBpbnB1dCByYXRlXG4gKiAoJDEuMDApIGlzIG5vdCBtb2RlbGxlZC4gVGhpbmtpbmcgdG9rZW5zIGFyZSBiaWxsZWQgYXMgb3V0cHV0LlxuICovXG5jb25zdCBHRU1JTklfMl81X0ZMQVNIX1BSSUNJTkc6IE1vZGVsUHJpY2luZyA9IHtcbiAgaW5wdXRQZXJNaWxsaW9uOiAwLjMwLFxuICBvdXRwdXRQZXJNaWxsaW9uOiAyLjUwLFxuICBjYWNoZVdyaXRlUGVyTWlsbGlvbjogMCxcbiAgY2FjaGVSZWFkUGVyTWlsbGlvbjogMC4wMyxcbiAgYXBpRXF1aXZhbGVudDogdHJ1ZSxcbn07XG5cbi8qKlxuICogRGVlcFNlZWsgYGRlZXBzZWVrLXY0LXByb2Ag4oCUIHRoZSBEZWVwU2VlayB0b3AgdGllci5cbiAqXG4gKiBTb3VyY2U6IGh0dHBzOi8vYXBpLWRvY3MuZGVlcHNlZWsuY29tL3F1aWNrX3N0YXJ0L3ByaWNpbmcsIGNoZWNrZWQgb25cbiAqIDIwMjYtMDktMTQuIEJhc2lzOiB0aGUgKipzdGFuZGFyZC1ob3VycyAocGVhaykqKiBgZGVlcHNlZWstdjQtcHJvYCByYXRlXG4gKiAoJDEuMzIgY2FjaGUtbWlzcyBpbnB1dCAvICQwLjA0NCBjYWNoZS1oaXQgaW5wdXQgLyAkMy45NiBvdXRwdXQgcGVyIE1Ub2spLFxuICogd2l0aCAqKm5vIG9mZi1wZWFrIGRpc2NvdW50KiogYXBwbGllZCDigJQgb2ZmLXBlYWsgaXMgaGFsZiBwcmljZSwgc28gdGhpcyByb3dcbiAqIG5ldmVyIHVuZGVyLXN0YXRlcy5cbiAqXG4gKiBUaGUgdmVuZG9yIHJldGlyZWQgYGRlZXBzZWVrLWNoYXRgIC8gYGRlZXBzZWVrLXJlYXNvbmVyYCwgdGhlIGlkcyB0aGVcbiAqIHdvcmtlciB1c2VkIHRvIHJvdXRlIGhlcmUgKElzc3VlICMxOTQxKTsgdGhlIHBhZ2Ugbm93IG5hbWVzXG4gKiBgZGVlcHNlZWstdjQtcHJvYCBhbmQgYGRlZXBzZWVrLWZsYXNoYCBhcyB0aGUgcHVibGlzaGVkIGlkcywgd2l0aCBWNCBQcm9cbiAqIHNlcnZpY2UgY29udGludWluZyBhZnRlciAyMDI2LTA5LTE0IGF0IHVuY2hhbmdlZCBiaWxsaW5nLiBUaGUgcmV0aXJlZCBpZHNcbiAqIGtlZXAgbm8gcm93czogYSBoaXN0b3JpY2FsIGNyZWRpdCBsb2cgdGhhdCBzdGlsbCBuYW1lcyBvbmUgcHJpY2VzIGF0IHRoZVxuICogY29uc2VydmF0aXZlIHtAbGluayBVTlBSSUNFRF9VUFBFUl9CT1VORF9QUklDSU5HfSBpbnN0ZWFkLCB3aGljaCBvdmVyLXN0YXRlc1xuICogcmF0aGVyIHRoYW4gZmFicmljYXRpbmcgYSByYXRlIHRoZSB2ZW5kb3Igbm8gbG9uZ2VyIHB1Ymxpc2hlcy5cbiAqL1xuY29uc3QgREVFUFNFRUtfVjRfUFJPX1BSSUNJTkc6IE1vZGVsUHJpY2luZyA9IHtcbiAgaW5wdXRQZXJNaWxsaW9uOiAxLjMyLFxuICBvdXRwdXRQZXJNaWxsaW9uOiAzLjk2LFxuICBjYWNoZVdyaXRlUGVyTWlsbGlvbjogMCxcbiAgY2FjaGVSZWFkUGVyTWlsbGlvbjogMC4wNDQsXG4gIGFwaUVxdWl2YWxlbnQ6IHRydWUsXG59O1xuXG4vKipcbiAqIERlZXBTZWVrIGBkZWVwc2Vlay1mbGFzaGAg4oCUIHRoZSBEZWVwU2VlayBiYXNlIHRpZXIuXG4gKlxuICogU291cmNlOiBodHRwczovL2FwaS1kb2NzLmRlZXBzZWVrLmNvbS9xdWlja19zdGFydC9wcmljaW5nLCBjaGVja2VkIG9uXG4gKiAyMDI2LTA5LTE0LiBCYXNpczogdGhlICoqc3RhbmRhcmQtaG91cnMgKHBlYWspKiogYGRlZXBzZWVrLWZsYXNoYCByYXRlXG4gKiAoJDAuMzAgY2FjaGUtbWlzcyBpbnB1dCAvICQwLjAwNiBjYWNoZS1oaXQgaW5wdXQgLyAkMS4yMCBvdXRwdXQgcGVyIE1Ub2spLFxuICogd2l0aCAqKm5vIG9mZi1wZWFrIGRpc2NvdW50KiogYXBwbGllZCDigJQgdGhlIHNhbWUgcGVhay1yYXRlIGJhc2lzIGFzIHRoZVxuICogYGRlZXBzZWVrLXY0LXByb2Agcm93IGFib3ZlLlxuICovXG5jb25zdCBERUVQU0VFS19GTEFTSF9QUklDSU5HOiBNb2RlbFByaWNpbmcgPSB7XG4gIGlucHV0UGVyTWlsbGlvbjogMC4zMCxcbiAgb3V0cHV0UGVyTWlsbGlvbjogMS4yMCxcbiAgY2FjaGVXcml0ZVBlck1pbGxpb246IDAsXG4gIGNhY2hlUmVhZFBlck1pbGxpb246IDAuMDA2LFxuICBhcGlFcXVpdmFsZW50OiB0cnVlLFxufTtcblxuLyoqXG4gKiBDdXJyZW50IChsYXRlc3QtdGllcikgcHJpY2luZyBwZXIgbW9kZWwgdGllciAoSXNzdWUgIzIzODkpLlxuICpcbiAqIFVzZWQgYXMgdGhlIGZhbGxiYWNrIHdoZW4gYSBiYXJlIGFsaWFzIChgb3B1c2AvYHNvbm5ldGAvYGhhaWt1YCkgb3IgYW5cbiAqIHVubWF0Y2hlZCBidXQgdGllcmVkIGlkIChlLmcuIGEgZnV0dXJlIGBjbGF1ZGUtb3B1cy00LTlgKSBpcyBsb29rZWQgdXAsXG4gKiBzbyBuZXcgbWlub3IgcmVsZWFzZXMgaW5oZXJpdCB0aGUgY3VycmVudCByYXRlIHJhdGhlciB0aGFuIHNpbGVudGx5XG4gKiBmYWxsaW5nIHRocm91Z2ggdG8gdGhlIG9sZGVzdC9sZWdhY3kgcm93LlxuICovXG5leHBvcnQgY29uc3QgVElFUl9DVVJSRU5UX1BSSUNJTkc6IFJlYWRvbmx5TWFwPHN0cmluZywgTW9kZWxQcmljaW5nPiA9IG5ldyBNYXAoW1xuICBbXCJmYWJsZVwiLCBGQUJMRV81XzFfUFJJQ0lOR10sXG4gIFtcIm9wdXNcIiwgT1BVU181XzVfUFJJQ0lOR10sXG4gIFtcInNvbm5ldFwiLCBTT05ORVRfNV9QUklDSU5HXSxcbiAgLy8gTm90IEhhaWt1IDUuNSdzIHJvdywgdGhvdWdoIGBoYWlrdWAgbm93IHNlcnZlcyBIYWlrdSA1LjUgKElzc3VlICMzNDAwKTpcbiAgLy8gdGhlIGNyZWRpdCBsb2cgcmVjb3JkcyB0aGUgcmVxdWVzdGVkIGFsaWFzLCBub3QgdGhlIHNlcnZlZCBtb2RlbCwgc28gdGhlXG4gIC8vIGFsaWFzIGtlZXBzIHRoZSBmbGF0IDQueCByYXRlIHRoYXQgYm91bmRzIGJvdGggZ2VuZXJhdGlvbnMgKElzc3VlICMzMzk5KS5cbiAgW1wiaGFpa3VcIiwgSEFJS1VfUFJJQ0lOR10sXG5dKTtcblxuLyoqXG4gKiBLbm93biBwcmljaW5nIHRpZXJzIGZvciBDbGF1ZGUgbW9kZWxzLlxuICpcbiAqIFRoZXNlIGFyZSBhcHByb3hpbWF0ZSBsaXN0IHByaWNlcyBhbmQgbWF5IGNoYW5nZS4gVGhlIG1hcCBrZXlzIGFyZVxuICogbm9ybWFsaXNlZCBtb2RlbCBuYW1lIHByZWZpeGVzIG1hdGNoZWQgKippbiBvcmRlcioqIOKAlCBtb3JlIHNwZWNpZmljXG4gKiBwcmVmaXhlcyBtdXN0IGFwcGVhciBiZWZvcmUgYnJvYWRlciBvbmVzIChlLmcuIFwiY2xhdWRlLW9wdXMtNC03XCJcbiAqIGJlZm9yZSBcImNsYXVkZS1vcHVzLTRcIikuXG4gKlxuICogU291cmNlOiBodHRwczovL2RvY3MuYW50aHJvcGljLmNvbS9lbi9kb2NzL2Fib3V0LWNsYXVkZS9wcmljaW5nXG4gKi9cbmV4cG9ydCBjb25zdCBNT0RFTF9QUklDSU5HOiBSZWFkb25seU1hcDxzdHJpbmcsIE1vZGVsUHJpY2luZz4gPSBuZXcgTWFwKFtcbiAgLy8gQ2xhdWRlIEZhYmxlIDUuMSDigJQgY3VycmVudCB0b3AgdGllciAoSXNzdWUgIzc0NykuIExpc3RlZCBiZWZvcmUgdGhlXG4gIC8vIGJyb2FkZXIgYGNsYXVkZS1mYWJsZS01YCBrZXkgcGVyIHRoZSBtb3JlLXNwZWNpZmljLWZpcnN0IHJ1bGUgYWJvdmUuXG4gIC8vIGBsb29rdXBNb2RlbFByaWNpbmdgIGNsYXNzaWZpZXMgZXZlcnkgYGNsYXVkZS1mYWJsZS3igKZgIGlkIGJ5IHZlcnNpb25cbiAgLy8gYmVmb3JlIGl0IHJlYWNoZXMgdGhpcyBtYXAsIHNvIG9ubHkgYSBwcmVmaXggd2FsayBvdmVyIHRoZSByb3dzIHNlZXMgdGhlXG4gIC8vIG9yZGVyLiBFdmVyeSByZWxlYXNlZCBGYWJsZSA1IHNuYXBzaG90IGlkIGNhcnJpZXMgYSBgMjAyNuKApmAgZGF0ZSBzdWZmaXgsXG4gIC8vIHNvIG5vIEZhYmxlIDUgaWQgaXMgY2FwdHVyZWQgYnkgdGhlIDUuMSBrZXkuIFBpbm5lZCBieVxuICAvLyBgYmF0Y2hfYXBpX2ZhYmxlX3ByaWNpbmdfdGVzdC50c2AuXG4gIFtcImNsYXVkZS1mYWJsZS01LTFcIiwgRkFCTEVfNV8xX1BSSUNJTkddLFxuICAvLyBDbGF1ZGUgRmFibGUgNSDigJQgdGhlIHByZXZpb3VzIHRvcCB0aWVyIChJc3N1ZSAjMjYxOSlcbiAgW1wiY2xhdWRlLWZhYmxlLTVcIiwgRkFCTEVfNV9QUklDSU5HXSxcbiAgLy8gQ2xhdWRlIE9wdXMgNS41IOKAlCBjdXJyZW50IHRvcCB0aWVyLCBjaGVhcGVyIHRoYW4gT3B1cyA1LjAtNS40IChJc3N1ZVxuICAvLyAjMjU0MykuIExpc3RlZCBiZWZvcmUgdGhlIGJyb2FkZXIgYGNsYXVkZS1vcHVzLTVgIGtleSBwZXIgdGhlXG4gIC8vIG1vcmUtc3BlY2lmaWMtZmlyc3QgcnVsZSBhYm92ZS5cbiAgW1wiY2xhdWRlLW9wdXMtNS01XCIsIE9QVVNfNV81X1BSSUNJTkddLFxuICAvLyBDbGF1ZGUgT3B1cyA1LjAtNS40IOKAlCBzYW1lIHJlZHVjZWQgcHJpY2UgcG9pbnQgYXMgT3B1cyA0LjggKElzc3VlICMzNTU5KVxuICBbXCJjbGF1ZGUtb3B1cy01XCIsIE9QVVNfUFJJQ0lOR19NT0RFUk5dLFxuICAvLyBDbGF1ZGUgT3B1cyA0LjUrIOKAlCByZWR1Y2VkIHByaWNpbmcgKElzc3VlICMxMzk4LCAjMjM4OSlcbiAgW1wiY2xhdWRlLW9wdXMtNC04XCIsIE9QVVNfUFJJQ0lOR19NT0RFUk5dLFxuICBbXCJjbGF1ZGUtb3B1cy00LTdcIiwgT1BVU19QUklDSU5HX01PREVSTl0sXG4gIFtcImNsYXVkZS1vcHVzLTQtNlwiLCBPUFVTX1BSSUNJTkdfTU9ERVJOXSxcbiAgW1wiY2xhdWRlLW9wdXMtNC01XCIsIE9QVVNfUFJJQ0lOR19NT0RFUk5dLFxuICAvLyBDbGF1ZGUgT3B1cyA0LjAvNC4xIOKAlCBsZWdhY3kgcHJpY2luZ1xuICBbXCJjbGF1ZGUtb3B1cy00XCIsIE9QVVNfUFJJQ0lOR19MRUdBQ1ldLFxuICAvLyBDbGF1ZGUgU29ubmV0IDUgaXMgY2hlYXBlciB0aGFuIHRoZSA0LnggbGluZSAoSXNzdWUgIzc0Nyk7IHRoZSBicm9hZGVyIGNsYXVkZS1zb25uZXQtNCBwcmVmaXggY2F0Y2hlcyBkYXRlZCA0LjAvNC4xLzQuMlxuICAvLyBpZHMgdGhhdCBzaGFyZSB0aGUgNC54IHJhdGUgKElzc3VlICMyNDA3KS5cbiAgLy8gQ2xhdWRlIFNvbm5ldCA1LjUg4oCUIHNhbWUgJDIvJDEwIHJhdGUsIGhhbGYgb2YgT3B1cyA1LjUgKElzc3VlICMyODEyKS5cbiAgLy8gTGlzdGVkIGJlZm9yZSBjbGF1ZGUtc29ubmV0LTUgc28gZmlyc3QtbWF0Y2ggbG9va3VwIG5hbWVzIGl0IGV4cGxpY2l0bHkuXG4gIFtcImNsYXVkZS1zb25uZXQtNS01XCIsIFNPTk5FVF81X1BSSUNJTkddLFxuICBbXCJjbGF1ZGUtc29ubmV0LTVcIiwgU09OTkVUXzVfUFJJQ0lOR10sXG4gIFtcImNsYXVkZS1zb25uZXQtNC02XCIsIFNPTk5FVF80X1BSSUNJTkddLFxuICBbXCJjbGF1ZGUtc29ubmV0LTRcIiwgU09OTkVUXzRfUFJJQ0lOR10sXG4gIC8vIENsYXVkZSBIYWlrdSA1LjUg4oCUIGJhbmRlZCBieSBwcm9tcHQgc2l6ZSAoSXNzdWUgIzMzOTkpXG4gIFtcImNsYXVkZS1oYWlrdS01LTVcIiwgSEFJS1VfNV81X1BSSUNJTkddLFxuICAvLyBDbGF1ZGUgSGFpa3UgNC41IChJc3N1ZSAjMTM5OCkg4oCUIGZsYXQgcmF0ZVxuICBbXCJjbGF1ZGUtaGFpa3UtNC01XCIsIEhBSUtVX1BSSUNJTkddLFxuICAvLyBMZWdhY3kgbW9kZWxzXG4gIFtcImNsYXVkZS0zLTUtc29ubmV0XCIsIFNPTk5FVF80X1BSSUNJTkddLFxuICBbXCJjbGF1ZGUtMy01LWhhaWt1XCIsIHtcbiAgICBpbnB1dFBlck1pbGxpb246IDAuODAsXG4gICAgb3V0cHV0UGVyTWlsbGlvbjogNCxcbiAgICBjYWNoZVdyaXRlUGVyTWlsbGlvbjogMSxcbiAgICBjYWNoZVJlYWRQZXJNaWxsaW9uOiAwLjA4LFxuICB9XSxcbiAgW1wiY2xhdWRlLTMtb3B1c1wiLCBPUFVTX1BSSUNJTkdfTEVHQUNZXSxcbiAgLy8gTm9uLUNsYXVkZSBpZHMgYXJlIHByaWNlZCBhdCB0aGUgdmVuZG9yJ3MgKipBUEktZXF1aXZhbGVudCBsaXN0IHByaWNlKipcbiAgLy8gKElzc3VlICMxOTM3LCAjMTkyMywgIzE5MzApIOKAlCBldmVyeSBvbmUgb2YgdGhlc2UgcHJvdmlkZXJzIHJ1bnMgb24gYVxuICAvLyBmaXhlZC1wcmljZSBzdWJzY3JpcHRpb24sIHNvIHRoZSBmaWd1cmUgaXMgd2hhdCB0aGUgdG9rZW5zIHdvdWxkIGhhdmVcbiAgLy8gY29zdCBvbiB0aGF0IHZlbmRvcidzIEFQSSBhbmQgbmV2ZXIgYSBiaWxsLiBgZm9ybWF0Q29zdEVzdGltYXRlTGluZXNgXG4gIC8vIHNheXMgc28gb24gdGhlIHJ1bi1zdGF0cyBzdWItYnVsbGV0IGl0IHJlbmRlcnMsIHJlYWRpbmdcbiAgLy8gYGFwaUVxdWl2YWxlbnRgIG9mZiB0aGUgcm93LiBUaGlzIHJlcGxhY2VzIHRoZSBJc3N1ZSAjMTcwMSBkZWNpc2lvbiB0b1xuICAvLyBsZWF2ZSB0aGUgQ29kZXggaWRzIHVucHJpY2VkIGFuZCBjaGFyZ2VkIGF0XG4gIC8vIFVOUFJJQ0VEX1VQUEVSX0JPVU5EX1BSSUNJTkcuXG4gIC8vXG4gIC8vIE9yZGVyIG1hdHRlcnM6IGBsb29rdXBNb2RlbFByaWNpbmdgIHdhbGtzIHRoZXNlIHJvd3Mgd2l0aCBgc3RhcnRzV2l0aGBcbiAgLy8gYW5kIHRha2VzIHRoZSBmaXJzdCBtYXRjaCwgc28gZWFjaCBpZCdzIG93biByb3cgbXVzdCBwcmVjZWRlIGFueSBicm9hZGVyXG4gIC8vIHByZWZpeCAoYGdwdC01LWNvZGV4YCBhbmQgYGdwdC01LW1pbmlgIGJlZm9yZSBgZ3B0LTVgLFxuICAvLyBgZ2VtaW5pLTIuNS1mbGFzaC1saXRlYCBiZWZvcmUgYGdlbWluaS0yLjUtZmxhc2hgKS4gUGlubmVkIGJ5XG4gIC8vIGB0b2tlbl91c2FnZV90ZXN0LnRzYC5cbiAgLy9cbiAgLy8gVGhlIGBncHQtNWAga2V5IGFsc28gY2FwdHVyZXMgYSBkb3R0ZWQgZnV0dXJlIGlkIChgZ3B0LTUuMmAsXG4gIC8vIGBncHQtNS4zLWNvZGV4YCksIHdoaWNoIE9wZW5BSSBwcmljZXMgZGVhcmVyIHRoYW4gYGdwdC01YCDigJQgc3VjaCBhbiBpZFxuICAvLyBjb3N0cyBhdCB0aGUgYGdwdC01YCByYXRlIHJhdGhlciB0aGFuIGF0IGl0cyBvd24sIHNvIGEgcnVuIG9uIG9uZSB3b3VsZFxuICAvLyBiZSB1bmRlci1zdGF0ZWQgdW50aWwgaXQgZ2V0cyBhIHJvdyBvZiBpdHMgb3duLlxuICAvL1xuICAvLyBUaGUgQ29kZXggdGllcnMgbm93IHJvdXRlIHRvIGBncHQtNi1hc3RyYWAsIGBncHQtNi4xLXNvbGAgYW5kXG4gIC8vIGBncHQtNi1sdW5hYCAob3duZXIgZGVjaXNpb24gMjAyNi0xMC0yMiwgYGNvbmZpZ19kZWZhdWx0cy50c2ApLCB3aGljaFxuICAvLyBoYXZlIG5vIHB1Ymxpc2hlZCBBUEkgcHJpY2UgeWV0LiBUaGV5IHN0YXkgdW5wcmljZWQgb24gcHVycG9zZSDigJQgY2hhcmdlZFxuICAvLyBhdCBVTlBSSUNFRF9VUFBFUl9CT1VORF9QUklDSU5HIGFuZCBsaXN0ZWQgYXMgdW5wcmljZWQgKElzc3VlICMzODcwKSDigJRcbiAgLy8gcmF0aGVyIHRoYW4gZ2l2ZW4gYSBndWVzc2VkIHJvdzsgYWRkIGVhY2ggcm93IG9uY2UgaXRzIHByaWNlIGlzIGtub3duLlxuICBbXCJncHQtNS1jb2RleFwiLCBHUFRfNV9DT0RFWF9QUklDSU5HXSxcbiAgW1wiZ3B0LTUtbWluaVwiLCBHUFRfNV9NSU5JX1BSSUNJTkddLFxuICBbXCJncHQtNVwiLCBHUFRfNV9QUklDSU5HXSxcbiAgW1wiZ2VtaW5pLTIuNS1wcm9cIiwgR0VNSU5JXzJfNV9QUk9fUFJJQ0lOR10sXG4gIFtcImdlbWluaS0yLjUtZmxhc2gtbGl0ZVwiLCBHRU1JTklfMl81X0ZMQVNIX0xJVEVfUFJJQ0lOR10sXG4gIFtcImdlbWluaS0yLjUtZmxhc2hcIiwgR0VNSU5JXzJfNV9GTEFTSF9QUklDSU5HXSxcbiAgW1wiZGVlcHNlZWstdjQtcHJvXCIsIERFRVBTRUVLX1Y0X1BST19QUklDSU5HXSxcbiAgW1wiZGVlcHNlZWstZmxhc2hcIiwgREVFUFNFRUtfRkxBU0hfUFJJQ0lOR10sXG5dKTtcblxuLyoqXG4gKiBDb25zZXJ2YXRpdmUgdXBwZXIgYm91bmQgYXBwbGllZCB0byBhbiB1bnJlY29nbmlzZWQgbW9kZWwgaWQgKElzc3VlICMzODcwKS5cbiAqXG4gKiBFYWNoIHJhdGUgaXMgdGhlIGRlYXJlc3Qgb2YgZXZlcnkga25vd24gcm93LCBzbyBhbiBpbnZvY2F0aW9uIHdob3NlIG1vZGVsIGlkXG4gKiBpcyBtaXNzaW5nIGZyb20gdGhlIHByaWNpbmcgdGFibGUg4oCUIHRoZSBgXCJkZWZhdWx0XCJgIHNlbnRpbmVsLCBvciBhbnkgaWQgbmV3ZXJcbiAqIHRoYW4gdGhpcyB0YWJsZSDigJQgaXMgb3Zlci1lc3RpbWF0ZWQgcmF0aGVyIHRoYW4gY291bnRlZCBhcyBgJDBgLiBUaGUgZGFpbHlcbiAqIHNwZW5kIGNlaWxpbmcgdGhlbiBndWFyZHMgYSBidWRnZXQgdGhhdCBpcyBuZXZlciBzbWFsbGVyIHRoYW4gdGhlIHJlYWwgb25lLlxuICogRGVyaXZlZCBmcm9tIHRoZSB0YWJsZXMgc28gYSBuZXcgKGRlYXJlcikgdGllciByYWlzZXMgdGhlIGJvdW5kIGF1dG9tYXRpY2FsbHkuXG4gKi9cbmV4cG9ydCBjb25zdCBVTlBSSUNFRF9VUFBFUl9CT1VORF9QUklDSU5HOiBNb2RlbFByaWNpbmcgPSAoKCkgPT4ge1xuICBjb25zdCByb3dzID0gWy4uLlRJRVJfQ1VSUkVOVF9QUklDSU5HLnZhbHVlcygpLCAuLi5NT0RFTF9QUklDSU5HLnZhbHVlcygpXTtcbiAgcmV0dXJuIHtcbiAgICBpbnB1dFBlck1pbGxpb246IE1hdGgubWF4KC4uLnJvd3MubWFwKChyKSA9PiByLmlucHV0UGVyTWlsbGlvbikpLFxuICAgIG91dHB1dFBlck1pbGxpb246IE1hdGgubWF4KC4uLnJvd3MubWFwKChyKSA9PiByLm91dHB1dFBlck1pbGxpb24pKSxcbiAgICBjYWNoZVdyaXRlUGVyTWlsbGlvbjogTWF0aC5tYXgoLi4ucm93cy5tYXAoKHIpID0+IHIuY2FjaGVXcml0ZVBlck1pbGxpb24pKSxcbiAgICBjYWNoZVJlYWRQZXJNaWxsaW9uOiBNYXRoLm1heCguLi5yb3dzLm1hcCgocikgPT4gci5jYWNoZVJlYWRQZXJNaWxsaW9uKSksXG4gIH07XG59KSgpO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFRva2VuIGV4dHJhY3Rpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIEV4dHJhY3QgdG9rZW4gdXNhZ2UgZnJvbSBDbGF1ZGUgQ0xJIHN0cmVhbS1qc29uIG91dHB1dC5cbiAqXG4gKiBTY2FucyB0aGUgTkRKU09OIGxpbmVzIGZvciBhIGByZXN1bHRgIG1lc3NhZ2UgdHlwZSB0aGF0IGNvbnRhaW5zIGFcbiAqIGB1c2FnZWAgb2JqZWN0IHdpdGggdG9rZW4gY291bnRzLiBSZXR1cm5zIG51bGwgaWYgbm8gdXNhZ2UgZGF0YSBpcyBmb3VuZC5cbiAqXG4gKiBAcGFyYW0gcmF3U3RyZWFtT3V0cHV0IC0gUmF3IHN0cmVhbS1qc29uIG91dHB1dCBmcm9tIENsYXVkZSBDTElcbiAqIEByZXR1cm5zIFRva2VuIHVzYWdlIG9yIG51bGwgaWYgbm90IGZvdW5kXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0VG9rZW5Vc2FnZShyYXdTdHJlYW1PdXRwdXQ6IHN0cmluZyk6IFRva2VuVXNhZ2UgfCBudWxsIHtcbiAgaWYgKCFyYXdTdHJlYW1PdXRwdXQudHJpbSgpKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBsaW5lcyA9IHJhd1N0cmVhbU91dHB1dC5zcGxpdChcIlxcblwiKS5maWx0ZXIoKGwpID0+IGwudHJpbSgpKTtcblxuICAvLyBTY2FuIGZyb20gdGhlIGVuZCDigJQgdGhlIHJlc3VsdCBsaW5lIGlzIHR5cGljYWxseSBsYXN0XG4gIGZvciAobGV0IGkgPSBsaW5lcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXSE7XG5cbiAgICAvLyBRdWljayBwcmUtY2hlY2sgdG8gYXZvaWQgcGFyc2luZyBldmVyeSBsaW5lXG4gICAgaWYgKCFsaW5lLmluY2x1ZGVzKCdcInJlc3VsdFwiJykgfHwgIWxpbmUuaW5jbHVkZXMoJ1widXNhZ2VcIicpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgICAgIGlmIChwYXJzZWQudHlwZSA9PT0gXCJyZXN1bHRcIiAmJiBwYXJzZWQudXNhZ2UpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBpbnB1dFRva2VuczogdHlwZW9mIHBhcnNlZC51c2FnZS5pbnB1dF90b2tlbnMgPT09IFwibnVtYmVyXCJcbiAgICAgICAgICAgID8gcGFyc2VkLnVzYWdlLmlucHV0X3Rva2Vuc1xuICAgICAgICAgICAgOiAwLFxuICAgICAgICAgIG91dHB1dFRva2VuczogdHlwZW9mIHBhcnNlZC51c2FnZS5vdXRwdXRfdG9rZW5zID09PSBcIm51bWJlclwiXG4gICAgICAgICAgICA/IHBhcnNlZC51c2FnZS5vdXRwdXRfdG9rZW5zXG4gICAgICAgICAgICA6IDAsXG4gICAgICAgICAgY2FjaGVDcmVhdGlvblRva2VuczpcbiAgICAgICAgICAgIHR5cGVvZiBwYXJzZWQudXNhZ2UuY2FjaGVfY3JlYXRpb25faW5wdXRfdG9rZW5zID09PSBcIm51bWJlclwiXG4gICAgICAgICAgICAgID8gcGFyc2VkLnVzYWdlLmNhY2hlX2NyZWF0aW9uX2lucHV0X3Rva2Vuc1xuICAgICAgICAgICAgICA6IDAsXG4gICAgICAgICAgY2FjaGVSZWFkVG9rZW5zOlxuICAgICAgICAgICAgdHlwZW9mIHBhcnNlZC51c2FnZS5jYWNoZV9yZWFkX2lucHV0X3Rva2VucyA9PT0gXCJudW1iZXJcIlxuICAgICAgICAgICAgICA/IHBhcnNlZC51c2FnZS5jYWNoZV9yZWFkX2lucHV0X3Rva2Vuc1xuICAgICAgICAgICAgICA6IDAsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBTa2lwIHVucGFyc2VhYmxlIGxpbmVzXG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDb3N0IGVzdGltYXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogTW9kZWwgdGllciBuYW1lLiAqL1xuZXhwb3J0IHR5cGUgTW9kZWxUaWVyID0gXCJmYWJsZVwiIHwgXCJvcHVzXCIgfCBcInNvbm5ldFwiIHwgXCJoYWlrdVwiO1xuXG4vKipcbiAqIEV2ZXJ5IHRpZXIgYWxpYXMsIGluIGRlc2NlbmRpbmcgY2FwYWJpbGl0eSBvcmRlci4gVGhlIHNpbmdsZSBzb3VyY2Ugb2ZcbiAqIHRydXRoIGZvciBcImlzIHRoaXMgc3RyaW5nIGEgdGllcj9cIiDigJQgY2FsbGVycyB0aGF0IGFjY2VwdCBhIHRpZXIgZnJvbSBhblxuICogdW50cnVzdGVkIHN1cmZhY2UgKGUuZy4gYW4gaWRsZS10YXNrIHdyYXBwZXIgYm9keSwgSXNzdWUgIzQwMTApIGFsbG93bGlzdFxuICogYWdhaW5zdCB0aGlzIHJhdGhlciB0aGFuIHBhc3NpbmcgYW4gYXJiaXRyYXJ5IHN0cmluZyB0byBgLS1tb2RlbGAuXG4gKi9cbmV4cG9ydCBjb25zdCBNT0RFTF9USUVSUzogcmVhZG9ubHkgTW9kZWxUaWVyW10gPSBbXG4gIFwiZmFibGVcIixcbiAgXCJvcHVzXCIsXG4gIFwic29ubmV0XCIsXG4gIFwiaGFpa3VcIixcbl07XG5cbi8qKiBUeXBlIGd1YXJkOiB3aGV0aGVyIGB2YWx1ZWAgaXMgZXhhY3RseSBvbmUgb2YgdGhlIHtAbGluayBNT0RFTF9USUVSU30uICovXG5leHBvcnQgZnVuY3Rpb24gaXNNb2RlbFRpZXIodmFsdWU6IHN0cmluZyk6IHZhbHVlIGlzIE1vZGVsVGllciB7XG4gIHJldHVybiAoTU9ERUxfVElFUlMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHZhbHVlKTtcbn1cblxuLyoqIE1pbm9yIHZlcnNpb24gYXQvYWJvdmUgd2hpY2ggT3B1cyB1c2VzIHRoZSBtb2Rlcm4gKDQuNSspIHJlZHVjZWQgcHJpY2luZy4gKi9cbmNvbnN0IE9QVVNfTU9ERVJOX01JTl9NSU5PUiA9IDU7XG5cbi8qKiBNYWpvciB2ZXJzaW9uIGF0L2Fib3ZlIHdoaWNoIE9wdXMgY2FuIGNhcnJ5IHRoZSBjaGVhcGVyIDUuNSByYXRlLiAqL1xuY29uc3QgT1BVU181XzVfTUlOX01BSk9SID0gNTtcblxuLyoqIE1pbm9yIHZlcnNpb24gYXQvYWJvdmUgd2hpY2ggT3B1cyA1IHVzZXMgdGhlIGNoZWFwZXIgNS41IHJhdGUuICovXG5jb25zdCBPUFVTXzVfNV9NSU5fTUlOT1IgPSA1O1xuXG4vKiogTWFqb3IgdmVyc2lvbiBhdC9hYm92ZSB3aGljaCBGYWJsZSBjYW4gY2FycnkgdGhlIGNoZWFwZXIgY2FjaGUtcmVhZCByYXRlLiAqL1xuY29uc3QgRkFCTEVfQ0hFQVBfQ0FDSEVfTUlOX01BSk9SID0gNTtcblxuLyoqIE1pbm9yIHZlcnNpb24gYXQvYWJvdmUgd2hpY2ggRmFibGUgNSB1c2VzIHRoZSBjaGVhcGVyIDUuMSBjYWNoZS1yZWFkIHJhdGUuICovXG5jb25zdCBGQUJMRV9DSEVBUF9DQUNIRV9NSU5fTUlOT1IgPSAxO1xuXG4vKiogTWFqb3IgdmVyc2lvbiBhdC9hYm92ZSB3aGljaCBTb25uZXQgdXNlcyB0aGUgY2hlYXBlciBTb25uZXQgNSByYXRlLiAqL1xuY29uc3QgU09OTkVUX01PREVSTl9NSU5fTUFKT1IgPSA1O1xuXG4vKiogTWFqb3IgdmVyc2lvbiBhdC9hYm92ZSB3aGljaCBIYWlrdSBjYW4gY2FycnkgdGhlIGJhbmRlZCA1LjUgcmF0ZS4gKi9cbmNvbnN0IEhBSUtVXzVfNV9NSU5fTUFKT1IgPSA1O1xuXG4vKiogTWlub3IgdmVyc2lvbiBhdC9hYm92ZSB3aGljaCBIYWlrdSA1IHVzZXMgdGhlIGJhbmRlZCA1LjUgcmF0ZS4gKi9cbmNvbnN0IEhBSUtVXzVfNV9NSU5fTUlOT1IgPSA1O1xuXG4vKipcbiAqIFBhcnNlIHRoZSBtYWpvci9taW5vciB2ZXJzaW9uIG9mIGEgbW9kZXJuICg0IG9yIDUgZmFtaWx5KSBDbGF1ZGUgaWQuXG4gKlxuICogTWF0Y2hlcyBgY2xhdWRlLTx0aWVyPi08bWFqb3I+YCAobWFqb3IgNCBvciA1KSBvcHRpb25hbGx5IGZvbGxvd2VkIGJ5XG4gKiBgLTxtaW5vcj5gIGFuZC9vciBhIHJlbGVhc2UgZGF0ZS4gQSB0cmFpbGluZyBncm91cCBvZiAzKyBkaWdpdHMgaXMgdHJlYXRlZFxuICogYXMgYSByZWxlYXNlIGRhdGUgKGUuZy4gYDIwMjUwNTE0YCksIG5vdCBhIG1pbm9yIHZlcnNpb24sIHNvIGEgYmFyZSBvciBkYXRlZFxuICogYGNsYXVkZS1vcHVzLTRgIGlkIHJlc29sdmVzIHRvIG1pbm9yIDAuIEV4dGVuZGVkIHRvIHRoZSA1LWZhbWlseSAoSXNzdWVcbiAqICMzNTU5KSBhbmQgdG8gdGhlIGBmYWJsZWAgdGllciAoSXNzdWUgIzc0Nykgc28gZnV0dXJlIGRhdGVkIGlkcyBzdGlsbFxuICogcmVzb2x2ZSByYXRoZXIgdGhhbiBkcm9wcGluZyB0byBhIG51bGwgY29zdC4gUmV0dXJucyBudWxsIGZvciBpZHMgb3V0c2lkZVxuICogdGhlIDQvNSBmYW1pbGllcy5cbiAqXG4gKiBFeHBvcnRlZCBmb3IgYGN1cnJlbnRfbW9kZWxzLnRzYCAoSXNzdWUgIzEzNjIpLCB3aGljaCBjb21wYXJlcyBhIHNlcnZlZCBpZFxuICogYWdhaW5zdCB0aGUgdGllcidzIGN1cnJlbnQgbW9kZWwg4oCUIHRoZSBzYW1lIHBhcnNlLCBzbyBpdCBtdXN0IG5vdCBiZSBhIHNlY29uZFxuICogY29weSB0aGF0IGNhbiBkcmlmdCBmcm9tIHRoaXMgb25lLlxuICpcbiAqIEBwYXJhbSBtb2RlbCAtIExvd2VyY2FzZWQgbW9kZWwgaWRlbnRpZmllclxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDbGF1ZGVNb2Rlcm5WZXJzaW9uKFxuICBtb2RlbDogc3RyaW5nLFxuKTogeyB0aWVyOiBNb2RlbFRpZXI7IG1ham9yOiBudW1iZXI7IG1pbm9yOiBudW1iZXIgfSB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IG1vZGVsLm1hdGNoKFxuICAgIC9eY2xhdWRlLShmYWJsZXxvcHVzfHNvbm5ldHxoYWlrdSktKFs0NV0pKD86LShcXGQrKSk/LyxcbiAgKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHRpZXIgPSBtYXRjaFsxXSBhcyBNb2RlbFRpZXI7XG4gIGNvbnN0IG1ham9yID0gTnVtYmVyKG1hdGNoWzJdKTtcbiAgY29uc3QgZ3JvdXAgPSBtYXRjaFszXTtcbiAgY29uc3QgbWlub3IgPSBncm91cCAmJiBncm91cC5sZW5ndGggPD0gMiA/IE51bWJlcihncm91cCkgOiAwO1xuICByZXR1cm4geyB0aWVyLCBtYWpvciwgbWlub3IgfTtcbn1cblxuLyoqXG4gKiBMb29rIHVwIHByaWNpbmcgZm9yIGEgbW9kZWwgbmFtZS5cbiAqXG4gKiBSZXNvbHV0aW9uIG9yZGVyIChJc3N1ZSAjMjM4OSk6XG4gKiAgIDEuIEJhcmUgdGllciBhbGlhcyAoYGZhYmxlYC9gb3B1c2AvYHNvbm5ldGAvYGhhaWt1YCkg4oaSIGN1cnJlbnQgdGllclxuICogICAgICBwcmljaW5nLCBzbyBhbiBhbGlhcyBhbHdheXMgY29zdHMgYXQgdGhlIGxhdGVzdCBtb2RlbCBvZiBpdHMgdGllci5cbiAqICAgMi4gQ2xhdWRlIDQvNSBmYW1pbHkgaWQg4oaSIGNsYXNzaWZ5IGJ5IHZlcnNpb24gc28gZnV0dXJlIG1pbm9yc1xuICogICAgICBpbmhlcml0IHRoZSBtb2Rlcm4gcmVkdWNlZCBwcmljaW5nIGluc3RlYWQgb2YgdGhlIGxlZ2FjeSByb3cuXG4gKiAgIDMuIEV4cGxpY2l0IHByZWZpeCBtYXRjaCBmb3IgdGhlIHJlbWFpbmluZyAobGVnYWN5IDMteCkgbW9kZWxzLlxuICpcbiAqIFJldHVybnMgbnVsbCBpZiBubyBtYXRjaGluZyBwcmljaW5nIGlzIGZvdW5kLlxuICpcbiAqIEBwYXJhbSBtb2RlbCAtIE1vZGVsIGlkZW50aWZpZXIgb3IgYWxpYXMgKGUuZy4gXCJvcHVzXCIsIFwiY2xhdWRlLW9wdXMtNC04XCIpXG4gKiBAcmV0dXJucyBNb2RlbCBwcmljaW5nIG9yIG51bGxcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvb2t1cE1vZGVsUHJpY2luZyhtb2RlbDogc3RyaW5nKTogTW9kZWxQcmljaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG5vcm1hbGlzZWQgPSBtb2RlbC50b0xvd2VyQ2FzZSgpO1xuXG4gIC8vIDEuIEJhcmUgdGllciBhbGlhcyDihpIgY3VycmVudCBwcmljaW5nIGZvciB0aGF0IHRpZXIuXG4gIGNvbnN0IGFsaWFzID0gVElFUl9DVVJSRU5UX1BSSUNJTkcuZ2V0KG5vcm1hbGlzZWQpO1xuICBpZiAoYWxpYXMpIHJldHVybiBhbGlhcztcblxuICAvLyAyLiBDbGF1ZGUgNC81IGZhbWlseSDigJQgY2xhc3NpZnkgYnkgdmVyc2lvbiwgc28gYSBtaW5vciByZWxlYXNlIHRoZSB0YWJsZVxuICAvLyAgICBoYXMgbmV2ZXIgc2VlbiBpcyBwcmljZWQgYnkgaXRzIG93biBnZW5lcmF0aW9uIHJhdGhlciB0aGFuIGJ5IHdoaWNoZXZlclxuICAvLyAgICByb3cgaGFwcGVucyB0byBtYXRjaCBpdHMgcHJlZml4LiBPcHVzIDUrIGFuZCBPcHVzIDQuNSsgc2hhcmUgdGhlIG1vZGVyblxuICAvLyAgICByZWR1Y2VkIHJhdGUgYW5kIG9ubHkgT3B1cyA0LjAvNC4xIGFyZSBsZWdhY3kgKElzc3VlICMzNTU5KTsgRmFibGUgNS4xK1xuICAvLyAgICByZWFkcyBjYWNoZSBhdCBhIHF1YXJ0ZXIgb2YgdGhlIEZhYmxlIDUgcmF0ZSBhbmQgU29ubmV0IDUgaXMgY2hlYXBlclxuICAvLyAgICB0aGFuIHRoZSBTb25uZXQgNC54IGxpbmUgKElzc3VlICM3NDcpLiBIYWlrdSA1LjUrIGlzIGJhbmRlZCBieVxuICAvLyAgICBwcm9tcHQgc2l6ZSBhbmQgZXZlcnkgZWFybGllciBIYWlrdSBpcyBmbGF0IChJc3N1ZSAjMzM5OSkuXG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlQ2xhdWRlTW9kZXJuVmVyc2lvbihub3JtYWxpc2VkKTtcbiAgaWYgKHBhcnNlZCkge1xuICAgIGlmIChwYXJzZWQudGllciA9PT0gXCJvcHVzXCIpIHtcbiAgICAgIC8vIEJvdGggaGFsdmVzIG1hdHRlcjogdGhlIGNoZWFwZXIgNS41IHJhdGUgYXJyaXZlZCB3aXRoIE9wdXMgNS41LCBzbyBhXG4gICAgICAvLyBgY2xhdWRlLW9wdXMtNC01YCBtdXN0IG5vdCBpbmhlcml0IGl0IG9uIG1pbm9yIGFsb25lIChJc3N1ZSAjMjU0MykuXG4gICAgICBpZiAoXG4gICAgICAgIHBhcnNlZC5tYWpvciA+PSBPUFVTXzVfNV9NSU5fTUFKT1IgJiZcbiAgICAgICAgcGFyc2VkLm1pbm9yID49IE9QVVNfNV81X01JTl9NSU5PUlxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiBPUFVTXzVfNV9QUklDSU5HO1xuICAgICAgfVxuICAgICAgY29uc3QgbW9kZXJuID0gcGFyc2VkLm1ham9yID49IDUgfHwgcGFyc2VkLm1pbm9yID49IE9QVVNfTU9ERVJOX01JTl9NSU5PUjtcbiAgICAgIHJldHVybiBtb2Rlcm4gPyBPUFVTX1BSSUNJTkdfTU9ERVJOIDogT1BVU19QUklDSU5HX0xFR0FDWTtcbiAgICB9XG4gICAgaWYgKHBhcnNlZC50aWVyID09PSBcImZhYmxlXCIpIHtcbiAgICAgIC8vIEJvdGggaGFsdmVzIG1hdHRlcjogdGhlIGNoZWFwIGNhY2hlLXJlYWQgcmF0ZSBhcnJpdmVkIHdpdGggNS4xLCBzbyBhXG4gICAgICAvLyBoeXBvdGhldGljYWwgYGNsYXVkZS1mYWJsZS00LTFgIG11c3Qgbm90IGluaGVyaXQgaXQgb24gbWlub3IgYWxvbmUuXG4gICAgICBjb25zdCBjaGVhcENhY2hlID0gcGFyc2VkLm1ham9yID49IEZBQkxFX0NIRUFQX0NBQ0hFX01JTl9NQUpPUiAmJlxuICAgICAgICBwYXJzZWQubWlub3IgPj0gRkFCTEVfQ0hFQVBfQ0FDSEVfTUlOX01JTk9SO1xuICAgICAgcmV0dXJuIGNoZWFwQ2FjaGUgPyBGQUJMRV81XzFfUFJJQ0lORyA6IEZBQkxFXzVfUFJJQ0lORztcbiAgICB9XG4gICAgaWYgKHBhcnNlZC50aWVyID09PSBcInNvbm5ldFwiKSB7XG4gICAgICByZXR1cm4gcGFyc2VkLm1ham9yID49IFNPTk5FVF9NT0RFUk5fTUlOX01BSk9SXG4gICAgICAgID8gU09OTkVUXzVfUFJJQ0lOR1xuICAgICAgICA6IFNPTk5FVF80X1BSSUNJTkc7XG4gICAgfVxuICAgIC8vIEJvdGggaGFsdmVzIG1hdHRlciwgYXMgZm9yIE9wdXM6IHRoZSBiYW5kIGFycml2ZWQgd2l0aCBIYWlrdSA1LjUuXG4gICAgcmV0dXJuIHBhcnNlZC5tYWpvciA+PSBIQUlLVV81XzVfTUlOX01BSk9SICYmXG4gICAgICAgIHBhcnNlZC5taW5vciA+PSBIQUlLVV81XzVfTUlOX01JTk9SXG4gICAgICA/IEhBSUtVXzVfNV9QUklDSU5HXG4gICAgICA6IEhBSUtVX1BSSUNJTkc7XG4gIH1cblxuICAvLyAzLiBFeHBsaWNpdCBwcmVmaXggbWF0Y2ggZm9yIGV2ZXJ5dGhpbmcgZWxzZSAobGVnYWN5IDMteCBtb2RlbHMpLlxuICBmb3IgKGNvbnN0IFtwcmVmaXgsIHByaWNpbmddIG9mIE1PREVMX1BSSUNJTkcpIHtcbiAgICBpZiAobm9ybWFsaXNlZC5zdGFydHNXaXRoKHByZWZpeCkpIHtcbiAgICAgIHJldHVybiBwcmljaW5nO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIEhvdyB0aGUgdG9rZW4gY291bnRzIGhhbmRlZCB0byBhIGNvc3QgZXN0aW1hdGUgd2VyZSBnYXRoZXJlZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29zdEVzdGltYXRlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBgdHJ1ZWAgd2hlbiB0aGUgY291bnRzIGFyZSAqKm9uZSByZXF1ZXN0J3MqKiwgc28gaXRzIHByb21wdCBzaXplIHBpY2tzIGFcbiAgICogYmFuZGVkIHJvdydzIGJhbmQgKElzc3VlICMzMzk5KS4gT21pdHRlZCwgdGhlIGNvdW50cyBhcmUgdGFrZW4gYXMgcnVuXG4gICAqIHRvdGFscywgd2hpY2ggc2F5IG5vdGhpbmcgYWJvdXQgYW55IG9uZSByZXF1ZXN0J3MgcHJvbXB0LCBhbmQgYSBiYW5kZWRcbiAgICogcm93IGlzIGNvc3RlZCBhdCBpdHMgdXBwZXIgYmFuZCDigJQgdGhlIGNvbnNlcnZhdGl2ZSBjaG9pY2UuXG4gICAqL1xuICBzaW5nbGVSZXF1ZXN0PzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBFc3RpbWF0ZSB0aGUgY29zdCBvZiBhIHNldCBvZiB0b2tlbiBjb3VudHMgZm9yIGEgZ2l2ZW4gbW9kZWwuXG4gKlxuICogQHBhcmFtIHVzYWdlIC0gVG9rZW4gdXNhZ2UgY291bnRzXG4gKiBAcGFyYW0gbW9kZWwgLSBNb2RlbCBpZGVudGlmaWVyIGZvciBwcmljaW5nIGxvb2t1cFxuICogQHBhcmFtIG9wdGlvbnMgLSBXaGV0aGVyIGB1c2FnZWAgaXMgb25lIHJlcXVlc3QncyAoc2VlIHtAbGluayBDb3N0RXN0aW1hdGVPcHRpb25zfSlcbiAqIEByZXR1cm5zIENvc3QgYnJlYWtkb3duIG9yIG51bGwgaWYgbW9kZWwgcHJpY2luZyBpcyB1bmtub3duXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlc3RpbWF0ZUNvc3QoXG4gIHVzYWdlOiBUb2tlblVzYWdlLFxuICBtb2RlbDogc3RyaW5nLFxuICBvcHRpb25zOiBDb3N0RXN0aW1hdGVPcHRpb25zID0ge30sXG4pOiBDb3N0QnJlYWtkb3duIHwgbnVsbCB7XG4gIGNvbnN0IHByaWNpbmcgPSBsb29rdXBNb2RlbFByaWNpbmcobW9kZWwpO1xuICBpZiAoIXByaWNpbmcpIHJldHVybiBudWxsO1xuICByZXR1cm4gY29zdEZvcih1c2FnZSwgcHJpY2luZywgb3B0aW9ucyk7XG59XG5cbi8qKiBBIGNvc3QgZXN0aW1hdGUgcGx1cyB3aGV0aGVyIGl0IGNhbWUgZnJvbSBhIHJlYWwgcHJpY2luZyByb3cuICovXG5leHBvcnQgaW50ZXJmYWNlIEJvdW5kZWRDb3N0RXN0aW1hdGUge1xuICAvKiogVGhlIGVzdGltYXRlZCBjb3N0LiAqL1xuICBjb3N0OiBDb3N0QnJlYWtkb3duO1xuICAvKiogVHJ1ZSB3aGVuIHRoZSBtb2RlbCBpZCBtYXRjaGVkIGEgcHJpY2luZyByb3c7IGZhbHNlIHdoZW4gYm91bmRlZC4gKi9cbiAgcHJpY2VkOiBib29sZWFuO1xufVxuXG4vKipcbiAqIEVzdGltYXRlIGNvc3QsIGZhbGxpbmcgYmFjayB0byBhIGNvbnNlcnZhdGl2ZSB1cHBlciBib3VuZCAoSXNzdWUgIzM4NzApLlxuICpcbiAqIEFuIHVucmVjb2duaXNlZCBtb2RlbCBpZCBpcyBjaGFyZ2VkIGF0IHtAbGluayBVTlBSSUNFRF9VUFBFUl9CT1VORF9QUklDSU5HfVxuICogcmF0aGVyIHRoYW4gZHJvcHBlZCwgc28gc3BlbmQgZ3VhcmRzIG92ZXItZXN0aW1hdGUgaW5zdGVhZCBvZiBzaWxlbnRseVxuICogbWVhc3VyaW5nIGAkMGAuIENhbGxlcnMgdXNlIGBwcmljZWRgIHRvIHN1cmZhY2UgdGhlIHN1YnN0aXR1dGlvbiDigJQgdGhlXG4gKiBib3VuZGVkIGZpZ3VyZSBtdXN0IG5ldmVyIGJlIHByZXNlbnRlZCBhcyBhbiBleGFjdCBjb3N0LlxuICpcbiAqIEBwYXJhbSB1c2FnZSAtIFRva2VuIHVzYWdlIGNvdW50c1xuICogQHBhcmFtIG1vZGVsIC0gTW9kZWwgaWRlbnRpZmllciBmb3IgcHJpY2luZyBsb29rdXBcbiAqIEBwYXJhbSBvcHRpb25zIC0gV2hldGhlciBgdXNhZ2VgIGlzIG9uZSByZXF1ZXN0J3MgKHNlZSB7QGxpbmsgQ29zdEVzdGltYXRlT3B0aW9uc30pXG4gKiBAcmV0dXJucyBUaGUgY29zdCBhbmQgd2hldGhlciByZWFsIHByaWNpbmcgd2FzIGZvdW5kXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlc3RpbWF0ZUNvc3RXaXRoVXBwZXJCb3VuZChcbiAgdXNhZ2U6IFRva2VuVXNhZ2UsXG4gIG1vZGVsOiBzdHJpbmcsXG4gIG9wdGlvbnM6IENvc3RFc3RpbWF0ZU9wdGlvbnMgPSB7fSxcbik6IEJvdW5kZWRDb3N0RXN0aW1hdGUge1xuICBjb25zdCBwcmljaW5nID0gbG9va3VwTW9kZWxQcmljaW5nKG1vZGVsKTtcbiAgcmV0dXJuIHtcbiAgICBjb3N0OiBjb3N0Rm9yKHVzYWdlLCBwcmljaW5nID8/IFVOUFJJQ0VEX1VQUEVSX0JPVU5EX1BSSUNJTkcsIG9wdGlvbnMpLFxuICAgIHByaWNlZDogcHJpY2luZyAhPT0gbnVsbCxcbiAgfTtcbn1cblxuLyoqXG4gKiBUaGUgcmF0ZXMgdGhhdCBhcHBseSB0byBgdXNhZ2VgOiBhIGJhbmRlZCByb3cncyBsb3dlciBiYW5kIHdoZW4gYHVzYWdlYCBpc1xuICogb25lIHJlcXVlc3Qgd2hvc2UgcHJvbXB0IGZpdHMgaXQsIG90aGVyd2lzZSB0aGUgcm93J3Mgb3duICh1cHBlcikgcmF0ZXMuXG4gKi9cbmZ1bmN0aW9uIHJhdGVzRm9yKFxuICB1c2FnZTogVG9rZW5Vc2FnZSxcbiAgcHJpY2luZzogTW9kZWxQcmljaW5nLFxuICBvcHRpb25zOiBDb3N0RXN0aW1hdGVPcHRpb25zLFxuKTogTW9kZWxQcmljaW5nIHwgUHJpY2luZ0JhbmQge1xuICBjb25zdCBiYW5kID0gcHJpY2luZy5sb3dlckJhbmQ7XG4gIGlmICghYmFuZCB8fCAhb3B0aW9ucy5zaW5nbGVSZXF1ZXN0KSByZXR1cm4gcHJpY2luZztcbiAgY29uc3QgcHJvbXB0ID0gdXNhZ2UuaW5wdXRUb2tlbnMgKyB1c2FnZS5jYWNoZUNyZWF0aW9uVG9rZW5zICtcbiAgICB1c2FnZS5jYWNoZVJlYWRUb2tlbnM7XG4gIHJldHVybiBwcm9tcHQgPD0gYmFuZC5tYXhQcm9tcHRUb2tlbnMgPyBiYW5kIDogcHJpY2luZztcbn1cblxuLyoqIEFwcGx5IGEgcHJpY2luZyByb3cgdG8gYSBzZXQgb2YgdG9rZW4gY291bnRzLiAqL1xuZnVuY3Rpb24gY29zdEZvcihcbiAgdXNhZ2U6IFRva2VuVXNhZ2UsXG4gIHJvdzogTW9kZWxQcmljaW5nLFxuICBvcHRpb25zOiBDb3N0RXN0aW1hdGVPcHRpb25zID0ge30sXG4pOiBDb3N0QnJlYWtkb3duIHtcbiAgY29uc3QgcHJpY2luZyA9IHJhdGVzRm9yKHVzYWdlLCByb3csIG9wdGlvbnMpO1xuICBjb25zdCBpbnB1dENvc3QgPSAodXNhZ2UuaW5wdXRUb2tlbnMgLyAxXzAwMF8wMDApICogcHJpY2luZy5pbnB1dFBlck1pbGxpb247XG4gIGNvbnN0IG91dHB1dENvc3QgPSAodXNhZ2Uub3V0cHV0VG9rZW5zIC8gMV8wMDBfMDAwKSAqXG4gICAgcHJpY2luZy5vdXRwdXRQZXJNaWxsaW9uO1xuICBjb25zdCBjYWNoZVdyaXRlQ29zdCA9ICh1c2FnZS5jYWNoZUNyZWF0aW9uVG9rZW5zIC8gMV8wMDBfMDAwKSAqXG4gICAgcHJpY2luZy5jYWNoZVdyaXRlUGVyTWlsbGlvbjtcbiAgY29uc3QgY2FjaGVSZWFkQ29zdCA9ICh1c2FnZS5jYWNoZVJlYWRUb2tlbnMgLyAxXzAwMF8wMDApICpcbiAgICBwcmljaW5nLmNhY2hlUmVhZFBlck1pbGxpb247XG5cbiAgcmV0dXJuIHtcbiAgICBpbnB1dENvc3QsXG4gICAgb3V0cHV0Q29zdCxcbiAgICBjYWNoZVdyaXRlQ29zdCxcbiAgICBjYWNoZVJlYWRDb3N0LFxuICAgIHRvdGFsQ29zdDogaW5wdXRDb3N0ICsgb3V0cHV0Q29zdCArIGNhY2hlV3JpdGVDb3N0ICsgY2FjaGVSZWFkQ29zdCxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7OztDQU9DLEdBRUQsOEVBQThFO0FBQzlFLFFBQVE7QUFDUiw4RUFBOEU7QUFFOUUsd0RBQXdELEdBd0V4RCw4RUFBOEU7QUFDOUUscUVBQXFFO0FBQ3JFLDhFQUE4RTtBQUU5RSxvRUFBb0U7QUFDcEUsOEVBQThFO0FBRTlFOzs7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
// denoCacheMetadata=10750314973649924140,10058062838835930354