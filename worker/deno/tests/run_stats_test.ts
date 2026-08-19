/**
 * Tests for run_stats.ts — per-run Claude generation stats (Issue #2647).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import {
  aggregateRunStats,
  buildRunStats,
  extractRunStats,
  type RunStats,
} from "../lib/run_stats.ts";

// =============================================================================
// extractRunStats — served models
// =============================================================================

Deno.test("run_stats - collects distinct served models from assistant lines", () => {
  const stream = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"a"}]}}',
    '{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"b"}]}}',
    '{"type":"result","result":"done","usage":{"input_tokens":10,"output_tokens":5}}',
  ].join("\n");

  const stats = extractRunStats(stream);
  assertEquals(stats.servedModels, ["claude-fable-5"]);
});

Deno.test("run_stats - records a served model different from the requested one", () => {
  // A run where the API served a downgraded model versus what was requested.
  const stream = [
    '{"type":"assistant","message":{"model":"claude-fable-5","content":[]}}',
    '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[]}}',
    '{"type":"result","result":"done"}',
  ].join("\n");

  const parsed = extractRunStats(stream);
  assertEquals(parsed.servedModels, ["claude-fable-5", "claude-opus-4-8"]);

  const stats = buildRunStats(stream, {
    requestedModel: "claude-fable-5",
    wallClockMs: 1000,
  });
  // The served list reveals the mismatch against the requested model.
  assertEquals(stats.requestedModel, "claude-fable-5");
  assertEquals(stats.servedModels.includes("claude-opus-4-8"), true);
});

// =============================================================================
// extractRunStats — result-line extras
// =============================================================================

Deno.test("run_stats - reads num_turns, duration_ms and modelUsage from result line", () => {
  const stream = [
    '{"type":"assistant","message":{"model":"claude-fable-5","content":[]}}',
    '{"type":"result","result":"done","num_turns":7,"duration_ms":4200,' +
    '"modelUsage":{"claude-fable-5":{"input_tokens":10}},' +
    '"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":1,"cache_read_input_tokens":2}}',
  ].join("\n");

  const stats = extractRunStats(stream);
  assertEquals(stats.numTurns, 7);
  assertEquals(stats.durationMs, 4200);
  assertEquals(stats.modelUsage, { "claude-fable-5": { input_tokens: 10 } });
  assertEquals(stats.tokenUsage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 1,
    cacheReadTokens: 2,
  });
});

Deno.test("run_stats - result line without optional fields omits them silently", () => {
  // Older CLI: a result line with no num_turns/duration_ms/modelUsage.
  const stream = [
    '{"type":"assistant","message":{"model":"claude-fable-5","content":[]}}',
    '{"type":"result","result":"done","usage":{"input_tokens":3,"output_tokens":1}}',
  ].join("\n");

  const stats = extractRunStats(stream);
  assertEquals(stats.numTurns, undefined);
  assertEquals(stats.durationMs, undefined);
  assertEquals(stats.modelUsage, undefined);
  // Token usage is still present.
  assertEquals(stats.tokenUsage?.inputTokens, 3);
});

// =============================================================================
// extractRunStats — graceful degradation
// =============================================================================

Deno.test("run_stats - no result line degrades gracefully", () => {
  const stream =
    '{"type":"assistant","message":{"model":"claude-fable-5","content":[]}}';

  const stats = extractRunStats(stream);
  assertEquals(stats.servedModels, ["claude-fable-5"]);
  assertEquals(stats.tokenUsage, undefined);
  assertEquals(stats.numTurns, undefined);
  assertEquals(stats.durationMs, undefined);
});

Deno.test("run_stats - malformed JSON lines are skipped without throwing", () => {
  const stream = [
    "not-json-at-all {model}",
    '{"type":"assistant","message":{"model":"claude-fable-5",}}', // trailing comma
    '{"type":"assistant","message":{"model":"claude-opus-4-8","content":[]}}',
    '{"type":"result","result":"done","num_turns":2}',
  ].join("\n");

  const stats = extractRunStats(stream);
  // Only the well-formed assistant line is captured.
  assertEquals(stats.servedModels, ["claude-opus-4-8"]);
  assertEquals(stats.numTurns, 2);
});

Deno.test("run_stats - empty output yields empty served models and no extras", () => {
  for (const empty of ["", "   ", "\n\n"]) {
    const stats = extractRunStats(empty);
    assertEquals(stats.servedModels, []);
    assertEquals(stats.tokenUsage, undefined);
    assertEquals(stats.numTurns, undefined);
    assertEquals(stats.durationMs, undefined);
  }
});

// =============================================================================
// buildRunStats — assembling the full object
// =============================================================================

Deno.test("run_stats - buildRunStats prefers result duration over wall-clock", () => {
  const stream = [
    '{"type":"assistant","message":{"model":"claude-fable-5","content":[]}}',
    '{"type":"result","result":"done","duration_ms":1234}',
  ].join("\n");

  const stats = buildRunStats(stream, {
    requestedModel: "claude-fable-5",
    effort: "high",
    wallClockMs: 9999,
  });

  const expected: RunStats = {
    servedModels: ["claude-fable-5"],
    requestedModel: "claude-fable-5",
    effort: "high",
    durationMs: 1234,
    wallClockMs: 9999,
  };
  assertEquals(stats, expected);
});

Deno.test("run_stats - buildRunStats falls back to wall-clock when no result duration", () => {
  const stream =
    '{"type":"assistant","message":{"model":"claude-fable-5","content":[]}}';

  const stats = buildRunStats(stream, {
    requestedModel: "claude-fable-5",
    wallClockMs: 2500,
  });

  assertEquals(stats.durationMs, 2500);
  assertEquals(stats.wallClockMs, 2500);
  assertEquals(stats.effort, undefined);
});

Deno.test("run_stats - buildRunStats passes effort through verbatim (e.g. xhigh)", () => {
  const stream =
    '{"type":"assistant","message":{"model":"claude-fable-5","content":[]}}';

  const stats = buildRunStats(stream, {
    requestedModel: "claude-fable-5",
    effort: "xhigh",
    wallClockMs: 100,
  });
  assertEquals(stats.effort, "xhigh");
});

Deno.test("run_stats - buildRunStats on empty output still returns a stats object", () => {
  const stats = buildRunStats("", {
    requestedModel: "default",
    wallClockMs: 42,
  });
  assertEquals(stats.servedModels, []);
  assertEquals(stats.requestedModel, "default");
  assertEquals(stats.durationMs, 42);
  assertEquals(stats.wallClockMs, 42);
});

// =============================================================================
// aggregateRunStats — rolling up multiple plan-generating calls (Issue #2653)
// =============================================================================

Deno.test("run_stats - aggregateRunStats sums tokens, turns and durations", () => {
  const a: RunStats = {
    servedModels: ["claude-fable-5"],
    requestedModel: "claude-fable-5",
    effort: "high",
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 5,
      cacheReadTokens: 50,
    },
    numTurns: 3,
    durationMs: 1000,
    wallClockMs: 1100,
  };
  const b: RunStats = {
    servedModels: ["claude-fable-5"],
    requestedModel: "claude-fable-5",
    effort: "high",
    tokenUsage: {
      inputTokens: 40,
      outputTokens: 10,
      cacheCreationTokens: 1,
      cacheReadTokens: 30,
    },
    numTurns: 2,
    durationMs: 500,
    wallClockMs: 600,
  };

  const agg = aggregateRunStats([a, b]);
  assertEquals(agg.callCount, 2);
  assertEquals(agg.servedModels, ["claude-fable-5"]);
  assertEquals(agg.requestedModels, ["claude-fable-5"]);
  assertEquals(agg.efforts, ["high"]);
  assertEquals(agg.tokenUsage, {
    inputTokens: 140,
    outputTokens: 30,
    cacheCreationTokens: 6,
    cacheReadTokens: 80,
  });
  assertEquals(agg.numTurns, 5);
  assertEquals(agg.durationMs, 1500);
  assertEquals(agg.wallClockMs, 1700);
});

Deno.test("run_stats - aggregateRunStats unions distinct served/requested models and efforts", () => {
  const a: RunStats = {
    servedModels: ["claude-fable-5"],
    requestedModel: "claude-fable-5",
    effort: "high",
    durationMs: 10,
    wallClockMs: 10,
  };
  const b: RunStats = {
    // A retry that the API served on a downgraded tier at a different effort.
    servedModels: ["claude-fable-5", "claude-opus-4-8"],
    requestedModel: "claude-opus-4-8",
    effort: "medium",
    durationMs: 20,
    wallClockMs: 20,
  };

  const agg = aggregateRunStats([a, b]);
  assertEquals(agg.servedModels, ["claude-fable-5", "claude-opus-4-8"]);
  assertEquals(agg.requestedModels, ["claude-fable-5", "claude-opus-4-8"]);
  assertEquals(agg.efforts, ["high", "medium"]);
});

Deno.test("run_stats - aggregateRunStats leaves numTurns undefined when no call reported it", () => {
  const a: RunStats = {
    servedModels: ["claude-fable-5"],
    requestedModel: "claude-fable-5",
    durationMs: 10,
    wallClockMs: 10,
  };
  const agg = aggregateRunStats([a]);
  assertEquals(agg.numTurns, undefined);
  // Token usage still present as a zeroed object when no call reported it.
  assertEquals(agg.tokenUsage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
});

Deno.test("run_stats - aggregateRunStats on empty list yields a zeroed aggregate", () => {
  const agg = aggregateRunStats([]);
  assertEquals(agg.callCount, 0);
  assertEquals(agg.servedModels, []);
  assertEquals(agg.requestedModels, []);
  assertEquals(agg.efforts, []);
  assertEquals(agg.numTurns, undefined);
  assertEquals(agg.durationMs, 0);
  assertEquals(agg.wallClockMs, 0);
});
