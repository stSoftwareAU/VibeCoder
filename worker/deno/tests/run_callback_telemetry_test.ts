/**
 * Tests for the callback token/cost summariser (Issue #806, parent #796).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  callbackTelemetryAbsenceReason,
  summariseCallbackTelemetry,
} from "../lib/run_callback_telemetry.ts";

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

Deno.test("run_callback_telemetry - no invocations is agent_not_invoked (Issue #1948)", () => {
  assertEquals(callbackTelemetryAbsenceReason([]), "agent_not_invoked");
});

Deno.test("run_callback_telemetry - invocations without usage is usage_not_reported (Issue #1948)", () => {
  assertEquals(
    callbackTelemetryAbsenceReason([
      {
        runStats: {
          servedModels: ["claude-sonnet-4-6"],
          requestedModel: "claude-sonnet-4-6",
        },
      },
    ], "claude"),
    "usage_not_reported",
  );
});

Deno.test("run_callback_telemetry - an adapter-less provider is provider_unsupported (Issue #1948)", () => {
  assertEquals(
    callbackTelemetryAbsenceReason([
      {
        runStats: {
          servedModels: ["deepseek-flash"],
          requestedModel: "deepseek-flash",
        },
      },
    ], "deepseek"),
    "provider_unsupported",
  );
});

Deno.test("run_callback_telemetry - reported usage has no absence reason (Issue #1948)", () => {
  assertEquals(
    callbackTelemetryAbsenceReason([
      {
        runStats: {
          servedModels: ["claude-sonnet-4-6"],
          requestedModel: "claude-sonnet-4-6",
          tokenUsage: usage(10, 1),
        },
      },
    ], "claude"),
    undefined,
  );
});

// -- Turns and model attribution (Issue #2100, part of #2060) --

Deno.test("run_callback_telemetry - turns are summed across invocations", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        numTurns: 7,
        tokenUsage: usage(100, 10),
      },
    },
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        numTurns: 5,
        tokenUsage: usage(200, 20),
      },
    },
  ]);
  assertEquals(telemetry?.turns, 12);
});

Deno.test("run_callback_telemetry - no invocation reporting turns omits the field", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(100, 10),
      },
    },
  ]);
  assertEquals(telemetry?.turns, undefined);
  assert(
    !("turns" in (telemetry ?? {})),
    "turns is omitted, never emitted as a zero that reads as 'no turns'",
  );
});

Deno.test("run_callback_telemetry - turns are summed over only the invocations that reported them", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        numTurns: 4,
        tokenUsage: usage(100, 10),
      },
    },
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(200, 20),
      },
    },
  ]);
  assertEquals(telemetry?.turns, 4);
});

Deno.test("run_callback_telemetry - an invocation that reported turns but no usage still contributes them", () => {
  // A run killed after its turn count but before a parseable usage line took
  // those turns; dropping them would under-report the run (Issue #2100).
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        numTurns: 3,
      },
    },
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        numTurns: 6,
        tokenUsage: usage(200, 20),
      },
    },
  ]);
  assertEquals(telemetry?.turns, 9);
  assertEquals(telemetry?.inputTokens, 200);
});

Deno.test("run_callback_telemetry - the model is the served model of the invocation with the most tokens", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["claude-haiku-4-5"],
        requestedModel: "claude-haiku-4-5",
        tokenUsage: usage(100, 10),
      },
    },
    {
      runStats: {
        servedModels: ["claude-opus-4-6"],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(9000, 900, 50, 10),
      },
    },
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(300, 30),
      },
    },
  ]);
  assertEquals(telemetry?.model, "claude-opus-4-6");
});

Deno.test("run_callback_telemetry - the model falls back to the requested one for the dominant invocation", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: [],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(5000, 500),
      },
    },
    {
      runStats: {
        servedModels: ["claude-haiku-4-5"],
        requestedModel: "claude-haiku-4-5",
        tokenUsage: usage(10, 1),
      },
    },
  ]);
  assertEquals(telemetry?.model, "claude-sonnet-4-6");
});

Deno.test("run_callback_telemetry - cache tokens count towards which invocation dominates", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(100, 10),
      },
    },
    {
      runStats: {
        servedModels: ["claude-opus-4-6"],
        requestedModel: "claude-opus-4-6",
        tokenUsage: usage(50, 5, 400, 900),
      },
    },
  ]);
  assertEquals(telemetry?.model, "claude-opus-4-6");
});

Deno.test("run_callback_telemetry - an equal-token tie is broken deterministically by invocation order", () => {
  const equal = [
    {
      runStats: {
        servedModels: ["claude-sonnet-4-6"],
        requestedModel: "claude-sonnet-4-6",
        tokenUsage: usage(100, 10),
      },
    },
    {
      runStats: {
        servedModels: ["claude-opus-4-6"],
        requestedModel: "claude-opus-4-6",
        tokenUsage: usage(100, 10),
      },
    },
  ];
  assertEquals(summariseCallbackTelemetry(equal)?.model, "claude-sonnet-4-6");
  assertEquals(
    summariseCallbackTelemetry([...equal].reverse())?.model,
    "claude-opus-4-6",
  );
});

// -- Effort attribution (Issue #2573) --
//
// The Opus 5.5 effort sweep compares pilot runs against control runs, and a
// per-host counter cannot separate a run made before a pilot host's
// `phase_effort_overrides` change from one made after it. The effort each run
// was actually invoked at is therefore carried per run, on the same dominant
// invocation `model` names — so the two can never describe different calls.

Deno.test("run_callback_telemetry - the effort is the one the dominant invocation ran at", () => {
  const small = usage(100, 10);
  const large = usage(9000, 900);
  const invocation = (effort: string, tokenUsage: typeof small) => ({
    runStats: {
      servedModels: ["claude-opus-5-5"],
      requestedModel: "opus",
      effort,
      tokenUsage,
    },
  });
  // Both directions: whichever invocation dominates names the effort, not
  // whichever came first.
  assertEquals(
    summariseCallbackTelemetry([
      invocation("high", small),
      invocation("medium", large),
    ])?.effort,
    "medium",
  );
  assertEquals(
    summariseCallbackTelemetry([
      invocation("high", large),
      invocation("medium", small),
    ])?.effort,
    "high",
  );
});

Deno.test("run_callback_telemetry - no effort is reported when the dominant invocation recorded none", () => {
  const telemetry = summariseCallbackTelemetry([
    {
      runStats: {
        servedModels: ["claude-opus-5-5"],
        requestedModel: "opus",
        effort: "high",
        tokenUsage: usage(10, 1),
      },
    },
    {
      runStats: {
        servedModels: ["gemini-3-pro"],
        requestedModel: "gemini-3-pro",
        tokenUsage: usage(5000, 500),
      },
    },
  ]);
  assert(telemetry !== undefined);
  assert(
    !("effort" in telemetry),
    "a borrowed effort would attribute the run to an arm it never ran in",
  );
});
