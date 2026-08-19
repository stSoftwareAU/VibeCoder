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
  resolveCurrentModel,
} from "../lib/model_fallback.ts";
import { setActiveRepoModelEffortOverrides } from "../lib/claude_executor.ts";

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
