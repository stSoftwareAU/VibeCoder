/**
 * The post-run callback contract is additive (Issues #2039, #2041).
 *
 * On 2026-09-11 the worker raised `schemaVersion` from 1 to 2 for a change
 * that only **added** fields. Every deployed hook did what the contract told
 * it to — refuse a version it did not know — and every host in the fleet lost
 * every callback on every issue until a human reinstalled the extension on
 * each one. The version number is not the contract; the fields are. This
 * test pins the fields schema 1 promised, so removing or renaming one fails
 * here, in review, rather than in the fleet.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildCallbackContextDocument,
  buildCallbackEnv,
  CALLBACK_SCHEMA_VERSION,
  type IssueRunCallbackContext,
} from "../lib/run_callbacks.ts";

/** Every scalar schema 1 exported, as documented in docs/CALLBACKS.md at 1.2.0. */
const SCHEMA_1_ENV = [
  "VIBECODER_CALLBACK_SCHEMA_VERSION",
  "VIBECODER_CALLBACK_EVENT",
  "VIBECODER_CALLBACK_CONTEXT",
  "VIBECODER_RUN_ID",
  "VIBECODER_RESULT",
  "VIBECODER_REPOSITORY",
  "VIBECODER_ISSUE_NUMBER",
  "VIBECODER_HOST",
  "VIBECODER_WORKER_NAME",
  "VIBECODER_PROVIDER",
  "VIBECODER_SESSION_ID",
  "VIBECODER_SESSION_LOG_PATH",
  "VIBECODER_STARTED_AT",
  "VIBECODER_FINISHED_AT",
  "VIBECODER_DURATION_SECONDS",
  "VIBECODER_EXIT_CODE",
  "VIBECODER_INPUT_TOKENS",
  "VIBECODER_OUTPUT_TOKENS",
  "VIBECODER_CACHE_CREATION_TOKENS",
  "VIBECODER_CACHE_READ_TOKENS",
  "VIBECODER_ESTIMATED_COST_USD",
] as const;

/** Every document field schema 1 exported, with the type a hook parsed. */
const SCHEMA_1_DOCUMENT: Record<string, "string" | "number" | "object"> = {
  schemaVersion: "number",
  event: "string",
  runId: "string",
  result: "string",
  repository: "string",
  issueNumber: "number",
  host: "string",
  workerName: "string",
  provider: "string",
  sessionId: "string",
  sessionLogPath: "string",
  startedAt: "string",
  finishedAt: "string",
  durationSeconds: "number",
  exitCode: "number",
  telemetry: "object",
};

const SCHEMA_1_TELEMETRY = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "estimatedCostUsd",
] as const;

/**
 * Every scalar schema 2 added (Issues #1947, #1948, #1955) — pinned for the
 * same reason as the schema 1 set above.
 */
const SCHEMA_2_ENV = [
  "VIBECODER_TELEMETRY_ABSENT_REASON",
  "VIBECODER_SESSION_LOG_ABSENT_REASON",
  "VIBECODER_OUTCOME_KIND",
  "VIBECODER_OUTCOME_CATEGORY",
  "VIBECODER_OUTCOME_PHASE",
  "VIBECODER_OUTCOME_FAILURE_CLASS",
  "VIBECODER_PR_NUMBER",
] as const;

/**
 * The fields added since schema 2 without a version bump (Issue #2100) —
 * additive, so they are present only when the run supplied them.
 */
const ADDITIVE_ENV = [
  "VIBECODER_MODE",
  "VIBECODER_TURNS",
  "VIBECODER_MODEL",
] as const;

/** A run that has every optional fact, so every field is exercised. */
const FULL_CONTEXT: IssueRunCallbackContext = {
  runId: "vibe-mtk92vcu-ebcc11",
  result: "success",
  repository: "stSoftwareAU/GRQ-AutoTrader",
  issueNumber: 266,
  host: "GRQ-23",
  workerName: "fleet-a",
  provider: "claude",
  sessionId: "0f1c8a2e-3d3f-4c1a-9c4e-6c2f2c6e8a11",
  sessionLogPath: "/home/vibe/logs/agent-vibe-mtk92vcu-ebcc11-266.jsonl",
  startedAt: "2026-09-12T18:00:00.000Z",
  finishedAt: "2026-09-12T18:31:12.000Z",
  durationSeconds: 1872,
  exitCode: 0,
  mode: "work-on",
  telemetry: {
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationTokens: 90,
    cacheReadTokens: 20,
    estimatedCostUsd: 0.42,
    turns: 34,
    model: "claude-opus-4-6",
  },
  outcome: { kind: "pr", prNumber: 267, phase: "completion" },
};

/** The same run with every additive field of Issue #2100 unsupplied. */
const WITHOUT_ADDITIVE: IssueRunCallbackContext = (() => {
  const { mode: _mode, telemetry, ...rest } = FULL_CONTEXT;
  const { turns: _turns, model: _model, ...leanTelemetry } = telemetry ?? {};
  return { ...rest, telemetry: leanTelemetry };
})();

Deno.test(
  "#2039 - every schema 1 environment scalar is still exported, so a hook written against 1 keeps reading",
  () => {
    const env = buildCallbackEnv(
      FULL_CONTEXT,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    const missing = SCHEMA_1_ENV.filter((name) => env[name] === undefined);
    assertEquals(missing, [], "schema 1 scalars no longer exported");
    for (const name of SCHEMA_1_ENV) {
      assert(env[name]!.length > 0, `${name} is exported empty`);
    }
    assertEquals(
      env.VIBECODER_CALLBACK_SCHEMA_VERSION,
      String(CALLBACK_SCHEMA_VERSION),
    );
  },
);

Deno.test(
  "#2039 - every schema 1 document field is still present with the type a hook parsed",
  () => {
    const document = buildCallbackContextDocument(FULL_CONTEXT, "always");
    for (const [field, type] of Object.entries(SCHEMA_1_DOCUMENT)) {
      assertEquals(
        typeof document[field],
        type,
        `document.${field} is no longer a ${type}`,
      );
    }
    const telemetry = document.telemetry as Record<string, unknown>;
    for (const field of SCHEMA_1_TELEMETRY) {
      assertEquals(
        typeof telemetry[field],
        "number",
        `telemetry.${field} is no longer a number`,
      );
    }
    assertEquals(document.schemaVersion, CALLBACK_SCHEMA_VERSION);
  },
);

Deno.test(
  "#2039 - the schema version is a positive integer a hook can compare numerically",
  () => {
    assert(Number.isInteger(CALLBACK_SCHEMA_VERSION));
    assert(CALLBACK_SCHEMA_VERSION >= 2, "the series never goes backwards");
  },
);

Deno.test(
  "#2039 - every schema 2 environment scalar is still exported (Issues #1947 #1948)",
  () => {
    const env = buildCallbackEnv(
      {
        ...FULL_CONTEXT,
        sessionLogAbsentReason: "tee_disabled",
        telemetryAbsentReason: "usage_not_reported",
        // A no-PR outcome, so `category` and `failureClass` are exercised
        // too — a `pr` outcome carries neither.
        outcome: {
          kind: "no_pr",
          category: "quality_check",
          phase: "quality_gate",
          failureClass: "gate_failed",
          prNumber: 267,
        },
      },
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    const missing = SCHEMA_2_ENV.filter((name) => env[name] === undefined);
    assertEquals(missing, [], "schema 2 scalars no longer exported");
  },
);

Deno.test(
  "#2100 - mode, telemetry.turns and telemetry.model are emitted when the run supplied them",
  () => {
    const document = buildCallbackContextDocument(FULL_CONTEXT, "always");
    assertEquals(document.mode, "work-on");
    const telemetry = document.telemetry as Record<string, unknown>;
    assertEquals(telemetry.turns, 34);
    assertEquals(telemetry.model, "claude-opus-4-6");

    const env = buildCallbackEnv(
      FULL_CONTEXT,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(env.VIBECODER_MODE, "work-on");
    assertEquals(env.VIBECODER_TURNS, "34");
    assertEquals(env.VIBECODER_MODEL, "claude-opus-4-6");
  },
);

Deno.test(
  "#2100 - the additive fields are omitted, not emitted empty, when unset",
  () => {
    const document = buildCallbackContextDocument(WITHOUT_ADDITIVE, "always");
    assert(!("mode" in document), "mode is emitted when the run had none");
    const telemetry = document.telemetry as Record<string, unknown>;
    assert(!("turns" in telemetry), "turns is emitted when none was reported");
    assert(!("model" in telemetry), "model is emitted when none was resolved");

    const env = buildCallbackEnv(
      WITHOUT_ADDITIVE,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    for (const name of ADDITIVE_ENV) {
      assertEquals(env[name], undefined, `${name} exported without a value`);
    }
  },
);

Deno.test(
  "#2100 - adding the three fields left schemaVersion and every earlier field alone",
  () => {
    // The scar of Issues #2039/#2041: an additive change must not bump the
    // version, and must not disturb what a deployed hook already reads.
    assertEquals(CALLBACK_SCHEMA_VERSION, 2);
    const document = buildCallbackContextDocument(FULL_CONTEXT, "always");
    for (const [field, type] of Object.entries(SCHEMA_1_DOCUMENT)) {
      assertEquals(typeof document[field], type, `document.${field} moved`);
    }
    const env = buildCallbackEnv(
      FULL_CONTEXT,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    const missing = SCHEMA_1_ENV.filter((name) => env[name] === undefined);
    assertEquals(missing, [], "an additive change dropped a schema 1 scalar");
  },
);
