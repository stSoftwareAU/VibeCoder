/**
 * Tests for model fallback on rate limit in runClaudeWithRetry (Issue #1113).
 *
 * Tests the pure functions that drive the fallback decision logic:
 *   - resolveCurrentModel: determines which model is in use
 *   - attemptModelFallback: determines the next cheaper model
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  attemptModelFallback,
  type ModelFallbackResult,
  resolveCurrentModel,
} from "../lib/model_fallback.ts";

// ---------------------------------------------------------------------------
// resolveCurrentModel — determines which model is in use
// ---------------------------------------------------------------------------

Deno.test("resolveCurrentModel - returns explicit model option when provided", () => {
  const result = resolveCurrentModel("sonnet", undefined);
  assertEquals(result, "sonnet");
});

Deno.test("resolveCurrentModel - returns phase default when no explicit model", () => {
  const original = Deno.env.get("CLAUDE_MODEL");
  const originalPhase = Deno.env.get("CLAUDE_MODEL_HEALTH");
  Deno.env.delete("CLAUDE_MODEL");
  Deno.env.delete("CLAUDE_MODEL_HEALTH");
  try {
    const result = resolveCurrentModel(undefined, "health");
    assertEquals(result, "haiku"); // health phase defaults to haiku
  } finally {
    if (original) Deno.env.set("CLAUDE_MODEL", original);
    else Deno.env.delete("CLAUDE_MODEL");
    if (originalPhase) Deno.env.set("CLAUDE_MODEL_HEALTH", originalPhase);
    else Deno.env.delete("CLAUDE_MODEL_HEALTH");
  }
});

Deno.test("resolveCurrentModel - returns CLAUDE_MODEL env var when no phase", () => {
  const original = Deno.env.get("CLAUDE_MODEL");
  Deno.env.set("CLAUDE_MODEL", "opus");
  try {
    const result = resolveCurrentModel(undefined, undefined);
    assertEquals(result, "opus");
  } finally {
    if (original) {
      Deno.env.set("CLAUDE_MODEL", original);
    } else {
      Deno.env.delete("CLAUDE_MODEL");
    }
  }
});

Deno.test("resolveCurrentModel - returns empty string when no model info available", () => {
  const original = Deno.env.get("CLAUDE_MODEL");
  Deno.env.delete("CLAUDE_MODEL");
  try {
    const result = resolveCurrentModel(undefined, undefined);
    assertEquals(result, "");
  } finally {
    if (original) Deno.env.set("CLAUDE_MODEL", original);
    else Deno.env.delete("CLAUDE_MODEL");
  }
});

Deno.test("resolveCurrentModel - explicit model takes priority over phase", () => {
  const result = resolveCurrentModel("opus", "health");
  assertEquals(result, "opus"); // explicit model, not haiku from health phase
});

// ---------------------------------------------------------------------------
// attemptModelFallback — determines the next cheaper model
// ---------------------------------------------------------------------------

Deno.test("attemptModelFallback - opus falls back to sonnet", () => {
  const result = attemptModelFallback("opus", true);
  const expected: ModelFallbackResult = { ok: true, cheaperModel: "sonnet" };
  assertEquals(result, expected);
});

Deno.test("attemptModelFallback - sonnet falls back to haiku", () => {
  const result = attemptModelFallback("sonnet", true);
  const expected: ModelFallbackResult = { ok: true, cheaperModel: "haiku" };
  assertEquals(result, expected);
});

Deno.test("attemptModelFallback - haiku has no cheaper option", () => {
  const result = attemptModelFallback("haiku", true);
  const expected: ModelFallbackResult = {
    ok: false,
    reason: "already-cheapest",
  };
  assertEquals(result, expected);
});

Deno.test("attemptModelFallback - returns disabled when fallback is off", () => {
  const result = attemptModelFallback("opus", false);
  const expected: ModelFallbackResult = { ok: false, reason: "disabled" };
  assertEquals(result, expected);
});

Deno.test("attemptModelFallback - unrecognised model has no fallback", () => {
  const result = attemptModelFallback("unknown-model", true);
  const expected: ModelFallbackResult = {
    ok: false,
    reason: "already-cheapest",
  };
  assertEquals(result, expected);
});

Deno.test("attemptModelFallback - empty model string has no fallback", () => {
  const result = attemptModelFallback("", true);
  const expected: ModelFallbackResult = {
    ok: false,
    reason: "already-cheapest",
  };
  assertEquals(result, expected);
});

Deno.test("attemptModelFallback - full model ID opus falls back to sonnet", () => {
  const result = attemptModelFallback("claude-opus-4-7", true);
  const expected: ModelFallbackResult = { ok: true, cheaperModel: "sonnet" };
  assertEquals(result, expected);
});

Deno.test("attemptModelFallback - full model ID sonnet falls back to haiku", () => {
  const result = attemptModelFallback("claude-sonnet-4-7", true);
  const expected: ModelFallbackResult = { ok: true, cheaperModel: "haiku" };
  assertEquals(result, expected);
});

Deno.test("attemptModelFallback - full model ID haiku has no cheaper option", () => {
  const result = attemptModelFallback("claude-haiku-4-7", true);
  const expected: ModelFallbackResult = {
    ok: false,
    reason: "already-cheapest",
  };
  assertEquals(result, expected);
});

// ---------------------------------------------------------------------------
// ClaudeRunResult fallbackModel field — type compile test
// ---------------------------------------------------------------------------

Deno.test("ClaudeRunResult - fallbackModel field is optional and compiles", () => {
  // Verify the type exists and can include the fallbackModel field
  const withFallback: import("../lib/claude_runner.ts").ClaudeRunResult = {
    exitCode: 0,
    output: "test",
    timedOut: false,
    fallbackModel: "sonnet",
  };
  assertEquals(withFallback.fallbackModel, "sonnet");

  const withoutFallback: import("../lib/claude_runner.ts").ClaudeRunResult = {
    exitCode: 0,
    output: "test",
    timedOut: false,
  };
  assertEquals(withoutFallback.fallbackModel, undefined);
});

// ---------------------------------------------------------------------------
// enableModelFallback config — verify default
// ---------------------------------------------------------------------------

Deno.test("config defaults - enableModelFallback defaults to true", async () => {
  const { OPERATIONAL_DEFAULTS } = await import("../lib/config_defaults.ts");
  assertEquals(OPERATIONAL_DEFAULTS.enableModelFallback, true);
});

Deno.test("config defaults - buildDefaultWorkerConfig includes enableModelFallback", async () => {
  const { buildDefaultWorkerConfig } = await import(
    "../lib/config_defaults.ts"
  );
  const config = buildDefaultWorkerConfig();
  assertEquals(config.enableModelFallback, true);
});

Deno.test("config defaults - buildDefaultWorkerConfig respects enableModelFallback override", async () => {
  const { buildDefaultWorkerConfig } = await import(
    "../lib/config_defaults.ts"
  );
  const config = buildDefaultWorkerConfig({ enableModelFallback: false });
  assertEquals(config.enableModelFallback, false);
});

// ---------------------------------------------------------------------------
// RunClaudeOptions — enableModelFallback type compile test
// ---------------------------------------------------------------------------

Deno.test("RunClaudeOptions - enableModelFallback field compiles", () => {
  const _options: import("../lib/claude_runner.ts").RunClaudeOptions = {
    prompt: "test",
    enableModelFallback: false,
  };
  assertEquals(_options.enableModelFallback, false);
});
