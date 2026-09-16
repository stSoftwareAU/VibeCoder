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
import type { CodegraphContextResult } from "../lib/codegraph_context.ts";

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
  telemetry: {
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationTokens: 90,
    cacheReadTokens: 20,
    estimatedCostUsd: 0.42,
  },
  outcome: { kind: "pr", prNumber: 267, phase: "completion" },
  codegraph: {
    enabled: true,
    status: "ok",
    indexSeconds: 42.5,
    nodeCount: 18_412,
    relationshipCount: 51_903,
    queries: 7,
  },
};

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

// ---------------------------------------------------------------------------
// The additive `codegraph` block (Issue #2162, part of #2145)
// ---------------------------------------------------------------------------

/** One run's CodeGraph step, as the trial's four statuses report it. */
const CODEGRAPH_CASES: Array<
  {
    name: string;
    codegraph?: CodegraphContextResult;
    expected: Record<string, unknown>;
  }
> = [
  {
    name: "ok",
    codegraph: {
      enabled: true,
      status: "ok",
      indexSeconds: 42.5,
      nodeCount: 18_412,
      relationshipCount: 51_903,
      queries: 7,
    },
    expected: {
      enabled: true,
      status: "ok",
      indexSeconds: 42.5,
      nodeCount: 18_412,
      relationshipCount: 51_903,
      queries: 7,
    },
  },
  {
    name: "failed with the partial figures it did gather",
    codegraph: { enabled: true, status: "failed", indexSeconds: 12 },
    expected: { enabled: true, status: "failed", indexSeconds: 12 },
  },
  {
    name: "unsupported",
    codegraph: { enabled: true, status: "unsupported" },
    expected: { enabled: true, status: "unsupported" },
  },
  {
    name: "off",
    codegraph: { enabled: false, status: "off" },
    expected: { enabled: false, status: "off" },
  },
];

Deno.test(
  "#2162 - the codegraph block carries the run's figures for every status, omitting what was never gathered",
  () => {
    for (const testCase of CODEGRAPH_CASES) {
      const document = buildCallbackContextDocument(
        { ...FULL_CONTEXT, codegraph: testCase.codegraph },
        "always",
      );
      assertEquals(
        document.codegraph,
        testCase.expected,
        `the ${testCase.name} run published the wrong codegraph block`,
      );
    }
  },
);

Deno.test(
  "#2162 - a run that reported no CodeGraph step is explicitly off, never absent",
  () => {
    const context = { ...FULL_CONTEXT };
    delete context.codegraph;
    const document = buildCallbackContextDocument(context, "always");
    assertEquals(document.codegraph, { enabled: false, status: "off" });
  },
);

Deno.test(
  "#2162 - the codegraph scalars are exported, the numeric ones only when the run has them",
  () => {
    const full = buildCallbackEnv(
      { ...FULL_CONTEXT, codegraph: CODEGRAPH_CASES[0]!.codegraph },
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(full.VIBECODER_CODEGRAPH_ENABLED, "true");
    assertEquals(full.VIBECODER_CODEGRAPH_STATUS, "ok");
    assertEquals(full.VIBECODER_CODEGRAPH_INDEX_SECONDS, "42.5");
    assertEquals(full.VIBECODER_CODEGRAPH_NODE_COUNT, "18412");
    assertEquals(full.VIBECODER_CODEGRAPH_RELATIONSHIP_COUNT, "51903");
    assertEquals(full.VIBECODER_CODEGRAPH_QUERIES, "7");

    const off = buildCallbackEnv(
      { ...FULL_CONTEXT, codegraph: { enabled: false, status: "off" } },
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(off.VIBECODER_CODEGRAPH_ENABLED, "false");
    assertEquals(off.VIBECODER_CODEGRAPH_STATUS, "off");
    assertEquals(off.VIBECODER_CODEGRAPH_INDEX_SECONDS, undefined);
    assertEquals(off.VIBECODER_CODEGRAPH_NODE_COUNT, undefined);
    assertEquals(off.VIBECODER_CODEGRAPH_RELATIONSHIP_COUNT, undefined);
    assertEquals(off.VIBECODER_CODEGRAPH_QUERIES, undefined);
  },
);

Deno.test(
  "#2162 - the block is additive: the schema version and every schema 1 field are untouched",
  () => {
    const document = buildCallbackContextDocument(FULL_CONTEXT, "always");
    assertEquals(document.schemaVersion, 2);
    for (const [field, type] of Object.entries(SCHEMA_1_DOCUMENT)) {
      assertEquals(typeof document[field], type);
    }
    const env = buildCallbackEnv(
      FULL_CONTEXT,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    for (const name of SCHEMA_1_ENV) {
      assert(env[name] !== undefined, `${name} is no longer exported`);
    }
  },
);
