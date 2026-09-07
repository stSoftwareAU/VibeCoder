/**
 * Tests for current_models.ts — the worker's current-generation model
 * reference and the previous-generation comparison (Issue #1362).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  CURRENT_TIER_MODELS,
  previousGenerationOf,
} from "../lib/current_models.ts";
import { lookupModelPricing } from "../lib/token_usage.ts";

// ---------------------------------------------------------------------------
// previousGenerationOf
// ---------------------------------------------------------------------------

Deno.test("previousGenerationOf - Fable 5 is a previous generation of Fable 5.1 (Issue #1362)", () => {
  assertEquals(previousGenerationOf("claude-fable-5"), {
    tier: "fable",
    current: "claude-fable-5-1",
  });
});

Deno.test("previousGenerationOf - a dated Fable 5 id is still a previous generation (Issue #1362)", () => {
  // The date suffix is not a minor version, so `claude-fable-5-20260101`
  // resolves to 5.0 and is stale against the current 5.1.
  assertEquals(
    previousGenerationOf("claude-fable-5-20260101")?.current,
    "claude-fable-5-1",
  );
});

Deno.test("previousGenerationOf - case and surrounding whitespace do not matter (Issue #1362)", () => {
  assertEquals(
    previousGenerationOf("  Claude-Fable-5  ")?.current,
    "claude-fable-5-1",
  );
});

Deno.test("previousGenerationOf - the current model is not previous-generation (Issue #1362)", () => {
  assertEquals(previousGenerationOf("claude-fable-5-1"), undefined);
  assertEquals(previousGenerationOf("claude-fable-5-1-20260901"), undefined);
});

Deno.test("previousGenerationOf - a newer generation than the reference is not stale (Issue #1362)", () => {
  // A Fable 5.2 the reference has never seen must not be flagged: the worker's
  // reference lags a release, it does not lead it.
  assertEquals(previousGenerationOf("claude-fable-5-2"), undefined);
});

Deno.test("previousGenerationOf - untracked tiers are never flagged (Issue #1362)", () => {
  assertEquals(previousGenerationOf("claude-opus-4-8"), undefined);
  assertEquals(previousGenerationOf("claude-sonnet-4-6"), undefined);
  assertEquals(previousGenerationOf("claude-haiku-4-5"), undefined);
});

Deno.test("previousGenerationOf - a bare tier alias carries no generation (Issue #1362)", () => {
  // The alias always means "the latest of that tier", so it can never be stale.
  assertEquals(previousGenerationOf("fable"), undefined);
});

Deno.test("previousGenerationOf - unparseable and empty ids are not flagged (Issue #1362)", () => {
  assertEquals(previousGenerationOf(""), undefined);
  assertEquals(previousGenerationOf("   "), undefined);
  assertEquals(previousGenerationOf("deepseek-reasoner"), undefined);
  assertEquals(previousGenerationOf("claude-3-opus"), undefined);
});

// ---------------------------------------------------------------------------
// CURRENT_TIER_MODELS — the worker-maintained reference itself
// ---------------------------------------------------------------------------

Deno.test("CURRENT_TIER_MODELS - Fable's current model is Fable 5.1 (Issue #1362, #747)", () => {
  assertEquals(CURRENT_TIER_MODELS.get("fable"), "claude-fable-5-1");
});

Deno.test("CURRENT_TIER_MODELS - every row names a priced model of its own tier (Issue #1362)", () => {
  // Guards a typo'd row: a current-model id that no pricing row recognises, or
  // that belongs to a different tier, would silently flag every run degraded.
  for (const [tier, model] of CURRENT_TIER_MODELS) {
    assertEquals(
      model.startsWith(`claude-${tier}-`),
      true,
      `${model} is not an id of the ${tier} tier`,
    );
    assertEquals(
      lookupModelPricing(model) !== null,
      true,
      `${model} has no pricing row`,
    );
    assertEquals(
      previousGenerationOf(model),
      undefined,
      `${model} must not be stale against itself`,
    );
  }
});
