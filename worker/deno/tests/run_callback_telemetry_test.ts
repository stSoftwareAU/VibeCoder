/**
 * Tests for the callback token/cost summariser (Issue #806, parent #796).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { summariseCallbackTelemetry } from "../lib/run_callback_telemetry.ts";

function usage(input: number, output: number, create = 0, read = 0) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: create,
    cacheReadTokens: read,
  };
}

Deno.test("run_callback_telemetry - no invocations report nothing", () => {
  assertEquals(summariseCallbackTelemetry([]), undefined);
});

Deno.test("run_callback_telemetry - invocations without usage report nothing", () => {
  assertEquals(
    summariseCallbackTelemetry([
      {},
      { runStats: { servedModels: [], requestedModel: "claude-sonnet-4-6" } },
    ]),
    undefined,
  );
});

Deno.test("run_callback_telemetry - token counts are summed across invocations", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(100, 10, 5, 1),
      },
    },
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(200, 20, 6, 2),
      },
    },
  ]);
  assertEquals(telemetry?.inputTokens, 300);
  assertEquals(telemetry?.outputTokens, 30);
  assertEquals(telemetry?.cacheCreationTokens, 11);
  assertEquals(telemetry?.cacheReadTokens, 3);
});

Deno.test("run_callback_telemetry - a priced run reports an estimated cost", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(1_000_000, 1_000_000),
      },
    },
  ]);
  assert(
    (telemetry?.estimatedCostUsd ?? 0) > 0,
    `expected a positive estimate, got ${telemetry?.estimatedCostUsd}`,
  );
});

Deno.test("run_callback_telemetry - an unpriced model reports tokens but no cost", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["some-unknown-model-9000"],
        requestedModel: "some-unknown-model-9000",
        tokenUsage: usage(500, 50),
      },
    },
  ]);
  assertEquals(telemetry?.inputTokens, 500);
  assertEquals(telemetry?.estimatedCostUsd, undefined);
});

Deno.test("run_callback_telemetry - usage falls back to the requested model when none was served", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: [],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(1_000_000, 0),
      },
    },
  ]);
  assert(
    (telemetry?.estimatedCostUsd ?? 0) > 0,
    "the requested model is priced when the API reported no served model",
  );
});
