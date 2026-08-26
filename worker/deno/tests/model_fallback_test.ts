/**
 * Tests for the model tier hierarchy and fallback mapping.
 *
 * Issue #1112: Define model tier hierarchy and fallback mapping.
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_MODEL_TOP_TIER,
  getCheaperModel,
  MODEL_FALLBACK_MAP,
} from "../lib/config_defaults.ts";
import {
  attemptModelFallback,
  clearModelLadderWarnings,
  type ModelFallbackResult,
  resolveCurrentModel,
  warnNoModelLadder,
} from "../lib/model_fallback.ts";
import { setActiveRepoModelEffortOverrides } from "../lib/claude_executor.ts";
import { resolveCodexModel } from "../lib/codex_executor.ts";
import { resolveGeminiModel } from "../lib/gemini_executor.ts";
import {
  AGENT_PROVIDER_ENV,
  IMAGE_AGENT_PROVIDERS_ENV,
} from "../lib/agent_provider.ts";

// =============================================================================
// MODEL_FALLBACK_MAP structure
// =============================================================================

Deno.test("model_fallback - MODEL_FALLBACK_MAP maps opus to sonnet", () => {
  assertEquals(MODEL_FALLBACK_MAP["opus"], "sonnet");
});

Deno.test("model_fallback - MODEL_FALLBACK_MAP maps sonnet to haiku", () => {
  assertEquals(MODEL_FALLBACK_MAP["sonnet"], "haiku");
});

Deno.test("model_fallback - MODEL_FALLBACK_MAP maps haiku to null (cheapest)", () => {
  assertEquals(MODEL_FALLBACK_MAP["haiku"], null);
});

// Issue #2619: fable added as the top tier above opus, so the map now has
// four tiers (fable, opus, sonnet, haiku). Updated from three.
Deno.test("model_fallback - MODEL_FALLBACK_MAP has exactly four tiers", () => {
  assertEquals(Object.keys(MODEL_FALLBACK_MAP).length, 4);
});

Deno.test("model_fallback - MODEL_FALLBACK_MAP maps fable to opus (Issue #2619)", () => {
  assertEquals(MODEL_FALLBACK_MAP["fable"], "opus");
});

// =============================================================================
// getCheaperModel — short names
// =============================================================================

Deno.test("model_fallback - getCheaperModel returns opus for fable (Issue #2619)", () => {
  assertEquals(getCheaperModel("fable"), "opus");
});

// Issue #2735: the spec names Opus 4.8 (the single base tier — DEFAULT_CLAUDE_MODEL)
// as the next-best target when Fable is export-control-disabled. Pin the
// fallback target to that named constant rather than a bare string so the
// fable → Opus-4.8 hop cannot silently drift to an older Opus or another tier.
Deno.test("model_fallback - Fable top tier falls back to the Opus base tier (Opus 4.8, Issue #2735)", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_TOP_TIER, "fable");
  assertEquals(DEFAULT_CLAUDE_MODEL, "opus");
  // The fallback resolves the top tier to the base tier the CLI maps to the
  // latest Opus (4.8) — proven via the named constants, not a literal.
  assertEquals(
    getCheaperModel(DEFAULT_CLAUDE_MODEL_TOP_TIER),
    DEFAULT_CLAUDE_MODEL,
  );
});

Deno.test("model_fallback - getCheaperModel returns sonnet for opus", () => {
  assertEquals(getCheaperModel("opus"), "sonnet");
});

Deno.test("model_fallback - getCheaperModel returns haiku for sonnet", () => {
  assertEquals(getCheaperModel("sonnet"), "haiku");
});

Deno.test("model_fallback - getCheaperModel returns null for haiku (no cheaper option)", () => {
  assertEquals(getCheaperModel("haiku"), null);
});

// =============================================================================
// getCheaperModel — full model IDs
// =============================================================================

Deno.test("model_fallback - getCheaperModel handles full fable model ID (Issue #2619)", () => {
  assertEquals(getCheaperModel("claude-fable-5"), "opus");
});

Deno.test("model_fallback - getCheaperModel handles full opus model ID", () => {
  assertEquals(getCheaperModel("claude-opus-4-7"), "sonnet");
});

Deno.test("model_fallback - getCheaperModel handles full sonnet model ID", () => {
  assertEquals(getCheaperModel("claude-sonnet-4-7"), "haiku");
});

Deno.test("model_fallback - getCheaperModel handles full haiku model ID", () => {
  assertEquals(getCheaperModel("claude-haiku-4-7"), null);
});

Deno.test("model_fallback - getCheaperModel handles older sonnet model ID format", () => {
  assertEquals(getCheaperModel("claude-sonnet-4-5-20241022"), "haiku");
});

Deno.test("model_fallback - getCheaperModel handles older opus model ID format", () => {
  assertEquals(getCheaperModel("claude-opus-4-5-20250918"), "sonnet");
});

// =============================================================================
// getCheaperModel — edge cases
// =============================================================================

Deno.test("model_fallback - getCheaperModel returns null for unknown model", () => {
  assertEquals(getCheaperModel("gpt-4"), null);
});

Deno.test("model_fallback - getCheaperModel returns null for empty string", () => {
  assertEquals(getCheaperModel(""), null);
});

Deno.test("model_fallback - getCheaperModel is case-sensitive (uppercase returns null)", () => {
  assertEquals(getCheaperModel("OPUS"), null);
});

// =============================================================================
// Routing-level fallback chain (Issue #2621)
//
// The planning-shaped phases default to fable; a rate-limited fable phase must
// degrade to opus rather than fail. These tests exercise the full chain:
// resolve the phase's default model, then take the cheaper fallback.
// =============================================================================

Deno.test("model_fallback - planning phase resolves to fable then degrades to opus (Issue #2621)", () => {
  const originalModel = Deno.env.get("CLAUDE_MODEL");
  const originalPhase = Deno.env.get("CLAUDE_MODEL_PLANNING");
  Deno.env.delete("CLAUDE_MODEL");
  Deno.env.delete("CLAUDE_MODEL_PLANNING");
  try {
    const current = resolveCurrentModel(undefined, "planning");
    assertEquals(current, "fable");
    const fallback = attemptModelFallback(current, true);
    assertEquals(fallback, { ok: true, cheaperModel: "opus" });
  } finally {
    if (originalModel) Deno.env.set("CLAUDE_MODEL", originalModel);
    else Deno.env.delete("CLAUDE_MODEL");
    if (originalPhase) Deno.env.set("CLAUDE_MODEL_PLANNING", originalPhase);
    else Deno.env.delete("CLAUDE_MODEL_PLANNING");
  }
});

// Confirms resolveCurrentModel delegates to the full buildClaudeModelArgs
// chain — including the per-repo override level (#2625) that the previous
// JSDoc omitted (Issue #2713). Behavioural, not a docstring grep.
Deno.test("model_fallback - resolveCurrentModel honours per-repo override (Issue #2713)", () => {
  const originalModel = Deno.env.get("CLAUDE_MODEL");
  const originalPhase = Deno.env.get("CLAUDE_MODEL_PLANNING");
  Deno.env.delete("CLAUDE_MODEL");
  Deno.env.delete("CLAUDE_MODEL_PLANNING");
  try {
    // Per-repo phase override sits above the phase default in the chain.
    setActiveRepoModelEffortOverrides({
      phaseModelOverrides: { planning: "opus" },
    });
    assertEquals(resolveCurrentModel(undefined, "planning"), "opus");
  } finally {
    setActiveRepoModelEffortOverrides(undefined);
    if (originalModel) Deno.env.set("CLAUDE_MODEL", originalModel);
    else Deno.env.delete("CLAUDE_MODEL");
    if (originalPhase) Deno.env.set("CLAUDE_MODEL_PLANNING", originalPhase);
    else Deno.env.delete("CLAUDE_MODEL_PLANNING");
  }
});

// Issue #2735: a per-repo `claude_model: "fable"` base tier (buildClaudeModelArgs
// step 3) is another way Fable gets requested — for *every* phase, not only the
// per-phase defaults. The unavailable-fallback must cover that path too.
Deno.test("model_fallback - per-repo claude_model:fable base tier resolves to fable then degrades to opus (Issue #2735)", () => {
  const originalModel = Deno.env.get("CLAUDE_MODEL");
  Deno.env.delete("CLAUDE_MODEL");
  try {
    setActiveRepoModelEffortOverrides({ claudeModel: "fable" });
    // Base tier applies to all phases (and phase-less calls).
    assertEquals(resolveCurrentModel(undefined, "issue"), "fable");
    assertEquals(resolveCurrentModel(undefined, undefined), "fable");
    const fallback = attemptModelFallback(
      resolveCurrentModel(undefined, "issue"),
      true,
    );
    assertEquals(fallback, { ok: true, cheaperModel: "opus" });
  } finally {
    setActiveRepoModelEffortOverrides(undefined);
    if (originalModel) Deno.env.set("CLAUDE_MODEL", originalModel);
    else Deno.env.delete("CLAUDE_MODEL");
  }
});

Deno.test("model_fallback - grill_me phase resolves to fable then degrades to opus (Issue #2621)", () => {
  const originalModel = Deno.env.get("CLAUDE_MODEL");
  const originalPhase = Deno.env.get("CLAUDE_MODEL_GRILL_ME");
  Deno.env.delete("CLAUDE_MODEL");
  Deno.env.delete("CLAUDE_MODEL_GRILL_ME");
  try {
    const current = resolveCurrentModel(undefined, "grill_me");
    assertEquals(current, "fable");
    const fallback = attemptModelFallback(current, true);
    assertEquals(fallback, { ok: true, cheaperModel: "opus" });
  } finally {
    if (originalModel) Deno.env.set("CLAUDE_MODEL", originalModel);
    else Deno.env.delete("CLAUDE_MODEL");
    if (originalPhase) Deno.env.set("CLAUDE_MODEL_GRILL_ME", originalPhase);
    else Deno.env.delete("CLAUDE_MODEL_GRILL_ME");
  }
});

// =============================================================================
// Provider-aware fallback (Issue #365)
//
// The fallback used to resolve the current model through the Claude chain and
// take the Claude tier ladder whatever provider was running, so a rate-limited
// Codex or Gemini run reasoned about a Claude model id and reported
// "already-cheapest" for a ladder it never had.
// =============================================================================

/**
 * Run `body` with every provider marked installed, optionally forcing the
 * active one.
 *
 * The image these tests run under installs Claude alone, and
 * `selectAgentProvider` refuses a provider the image did not install, so a
 * Codex/Gemini scenario has to stamp the set it describes.
 */
function withProviders(
  body: () => void,
  activeId?: string,
): void {
  const originalImage = Deno.env.get(IMAGE_AGENT_PROVIDERS_ENV);
  const originalActive = Deno.env.get(AGENT_PROVIDER_ENV);
  Deno.env.set(IMAGE_AGENT_PROVIDERS_ENV, "claude,codex,gemini");
  if (activeId) Deno.env.set(AGENT_PROVIDER_ENV, activeId);
  try {
    body();
  } finally {
    if (originalImage) Deno.env.set(IMAGE_AGENT_PROVIDERS_ENV, originalImage);
    else Deno.env.delete(IMAGE_AGENT_PROVIDERS_ENV);
    if (originalActive) Deno.env.set(AGENT_PROVIDER_ENV, originalActive);
    else Deno.env.delete(AGENT_PROVIDER_ENV);
  }
}

Deno.test("model_fallback - resolveCurrentModel uses the Codex chain under Codex (Issue #365)", () => {
  withProviders(() => {
    const resolved = resolveCurrentModel(undefined, "issue", "codex");
    assertEquals(resolved, resolveCodexModel("issue"));
    // The bug: the Claude chain answered for every provider.
    assertEquals(
      resolved === resolveCurrentModel(undefined, "issue", "claude"),
      false,
    );
  });
});

Deno.test("model_fallback - resolveCurrentModel uses the Gemini chain under Gemini (Issue #365)", () => {
  withProviders(() => {
    const resolved = resolveCurrentModel(undefined, "planning", "gemini");
    assertEquals(resolved, resolveGeminiModel("planning"));
    assertEquals(
      resolved === resolveCurrentModel(undefined, "planning", "claude"),
      false,
    );
  });
});

Deno.test("model_fallback - resolveCurrentModel follows the active provider from the environment (Issue #365)", () => {
  withProviders(() => {
    assertEquals(
      resolveCurrentModel(undefined, "issue"),
      resolveCodexModel("issue"),
    );
  }, "codex");
});

Deno.test("model_fallback - an explicit model still wins under any provider (Issue #365)", () => {
  withProviders(() => {
    assertEquals(
      resolveCurrentModel("gpt-5.1-codex", "issue", "codex"),
      "gpt-5.1-codex",
    );
    assertEquals(resolveCurrentModel("opus", "issue", "claude"), "opus");
  });
});

Deno.test("model_fallback - Codex reports no-ladder-for-provider, not already-cheapest (Issue #365)", () => {
  withProviders(() => {
    const result = attemptModelFallback(
      resolveCurrentModel(undefined, "issue", "codex"),
      true,
      "codex",
    );
    const expected: ModelFallbackResult = {
      ok: false,
      reason: "no-ladder-for-provider",
      provider: "codex",
    };
    assertEquals(result, expected);
  });
});

Deno.test("model_fallback - Gemini reports no-ladder-for-provider, not already-cheapest (Issue #365)", () => {
  withProviders(() => {
    const result = attemptModelFallback(
      resolveCurrentModel(undefined, "planning", "gemini"),
      true,
      "gemini",
    );
    const expected: ModelFallbackResult = {
      ok: false,
      reason: "no-ladder-for-provider",
      provider: "gemini",
    };
    assertEquals(result, expected);
  });
});

Deno.test("model_fallback - disabled still beats the missing ladder (Issue #365)", () => {
  withProviders(() => {
    const result = attemptModelFallback("gpt-5.1-codex", false, "codex");
    assertEquals(result, { ok: false, reason: "disabled" });
  });
});

// Regression guard: the Claude path keeps its existing reasons exactly.
Deno.test("model_fallback - Claude reasons are unchanged by the provider seam (Issue #365)", () => {
  assertEquals(attemptModelFallback("opus", true, "claude"), {
    ok: true,
    cheaperModel: "sonnet",
  });
  assertEquals(attemptModelFallback("haiku", true, "claude"), {
    ok: false,
    reason: "already-cheapest",
  });
  assertEquals(attemptModelFallback("gpt-5.1-codex", true, "claude"), {
    ok: false,
    reason: "already-cheapest",
  });
});

Deno.test("model_fallback - the missing ladder is warned about once, naming the provider (Issue #365)", () => {
  clearModelLadderWarnings();
  const captured: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    withProviders(() => {
      const result = attemptModelFallback("gpt-5.1-codex", true, "codex");
      warnNoModelLadder(result, "gpt-5.1-codex");
      // A rate-limited run reaches the same branch on every retry: still once.
      warnNoModelLadder(result, "gpt-5.1-codex");
    });
  } finally {
    console.warn = originalWarn;
    clearModelLadderWarnings();
  }

  assertEquals(captured.length, 1);
  assertEquals(captured[0]!.includes("codex"), true);
  assertEquals(captured[0]!.includes("gpt-5.1-codex"), true);
});

Deno.test("model_fallback - warnNoModelLadder is silent for every other outcome (Issue #365)", () => {
  clearModelLadderWarnings();
  const captured: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    warnNoModelLadder({ ok: true, cheaperModel: "sonnet" }, "opus");
    warnNoModelLadder({ ok: false, reason: "already-cheapest" }, "haiku");
    warnNoModelLadder({ ok: false, reason: "disabled" }, "opus");
  } finally {
    console.warn = originalWarn;
    clearModelLadderWarnings();
  }

  assertEquals(captured.length, 0);
});

Deno.test("model_fallback - the warning goes to the run logger when one is supplied (Issue #365)", () => {
  clearModelLadderWarnings();
  const messages: string[] = [];
  try {
    withProviders(() => {
      const result = attemptModelFallback("gemini-3-pro", true, "gemini");
      warnNoModelLadder(result, "gemini-3-pro", {
        warn: (message: string) => messages.push(message),
      });
    });
  } finally {
    clearModelLadderWarnings();
  }

  assertEquals(messages.length, 1);
  assertEquals(messages[0]!.includes("gemini"), true);
});
