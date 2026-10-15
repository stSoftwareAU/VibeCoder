/**
 * Tests for subtractModelUsage (follow-up to Issue #3603).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { subtractModelUsage } from "../lib/model_usage_scope.ts";

const counters = (output: number, cacheRead = 0) => ({
  inputTokens: 10,
  outputTokens: output,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: cacheRead,
});

Deno.test("subtractModelUsage - keeps only the models this invocation moved", () => {
  const baseline = {
    "claude-opus-5-5": counters(1_000, 5_000),
    "claude-sonnet-5": counters(3_056_999),
  };
  const current = {
    "claude-opus-5-5": { ...counters(1_400, 9_000), inputTokens: 25 },
    "claude-sonnet-5": counters(3_056_999),
    "claude-sonnet-5-5": counters(300),
  };
  assertEquals(subtractModelUsage(current, baseline), {
    "claude-opus-5-5": {
      inputTokens: 15,
      outputTokens: 400,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 4_000,
    },
    "claude-sonnet-5-5": counters(300),
  });
});

Deno.test("subtractModelUsage - reads the snake_case spelling on either side", () => {
  const baseline = {
    "claude-opus-5-5": { input_tokens: 10, output_tokens: 100 },
  };
  const current = {
    "claude-opus-5-5": { input_tokens: 10, output_tokens: 150 },
  };
  assertEquals(subtractModelUsage(current, baseline), {
    "claude-opus-5-5": {
      inputTokens: 0,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  });
});

Deno.test("subtractModelUsage - totals that went backwards are not this invocation's", () => {
  const baseline = { "claude-opus-5-5": counters(1_000) };
  assertEquals(
    subtractModelUsage({ "claude-opus-5-5": counters(400) }, baseline),
    undefined,
  );
  // A model the baseline had and the result lost: the totals were reset.
  assertEquals(
    subtractModelUsage({ "claude-sonnet-5-5": counters(400) }, baseline),
    undefined,
  );
});

Deno.test("subtractModelUsage - an unreadable side withholds the breakdown", () => {
  assertEquals(
    subtractModelUsage({ "claude-opus-5-5": counters(1) }, {
      "claude-opus-5-5": { outputTokens: "lots" },
    }),
    undefined,
  );
});
