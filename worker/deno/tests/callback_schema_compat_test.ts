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
import type { RtkOutputResult } from "../lib/rtk_output.ts";

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
  "VIBECODER_EFFORT",
] as const;

/**
 * The Graft figures added without a version bump (Issue #2104) — present
 * only when the collection actually reached them.
 */
const GRAFT_FIGURE_ENV = [
  "VIBECODER_GRAFT_BUILD_SECONDS",
  "VIBECODER_GRAFT_BUNDLE_CHARS",
  "VIBECODER_GRAFT_NODE_COUNT",
  "VIBECODER_GRAFT_CALL_EDGE_COUNT",
] as const;

/**
 * The worker build identity added without a version bump (Issue #2444) —
 * present only when the running worker's version and commit could be read.
 */
const WORKER_BUILD_ENV = [
  "VIBECODER_WORKER_VERSION",
  "VIBECODER_WORKER_COMMIT",
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
  workerVersion: "1.4.2",
  workerCommit: "0123456789abcdef0123456789abcdef01234567",
  mode: "work-on",
  telemetry: {
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationTokens: 90,
    cacheReadTokens: 20,
    estimatedCostUsd: 0.42,
    turns: 34,
    model: "claude-opus-4-6",
    effort: "high",
  },
  outcome: { kind: "pr", prNumber: 267, phase: "completion" },
  graft: {
    enabled: true,
    status: "ok",
    buildSeconds: 12.5,
    bundleChars: 4096,
    nodeCount: 820,
    callEdgeCount: 1204,
  },
  codegraph: {
    enabled: true,
    status: "ok",
    indexSeconds: 42.5,
    nodeCount: 18_412,
    relationshipCount: 51_903,
    queries: 7,
  },
  rtk: { enabled: true, status: "ok", savedTokens: 12_840 },
};

/** The same run with every additive field of Issue #2100 unsupplied. */
const WITHOUT_ADDITIVE: IssueRunCallbackContext = (() => {
  const { mode: _mode, graft: _graft, telemetry, ...rest } = FULL_CONTEXT;
  const {
    turns: _turns,
    model: _model,
    effort: _effort,
    ...leanTelemetry
  } = telemetry ?? {};
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
  "#2573 - telemetry.effort is emitted beside the model it was run with, and omitted when unset",
  () => {
    const document = buildCallbackContextDocument(FULL_CONTEXT, "always");
    const telemetry = document.telemetry as Record<string, unknown>;
    assertEquals(telemetry.effort, "high");
    const env = buildCallbackEnv(
      FULL_CONTEXT,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(env.VIBECODER_EFFORT, "high");

    const lean = buildCallbackContextDocument(WITHOUT_ADDITIVE, "always");
    const leanTelemetry = lean.telemetry as Record<string, unknown>;
    assert(!("effort" in leanTelemetry), "effort is emitted when none was run");
    // An additive field, like #2100's: the version must not move for it.
    assertEquals(CALLBACK_SCHEMA_VERSION, 2);
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

Deno.test(
  "#2104 - every run carries the Graft block, whatever the collection did",
  () => {
    // The point of the block is comparability: `ok`, `failed` and `off` all
    // report `enabled` and `status`, so a host is never silent about Graft.
    const shapes: Array<[IssueRunCallbackContext["graft"], boolean, string]> = [
      [{ enabled: true, status: "ok", nodeCount: 820 }, true, "ok"],
      [{ enabled: true, status: "failed", buildSeconds: 301 }, true, "failed"],
      [{ enabled: false, status: "off" }, false, "off"],
      // A run that ended before the collection reports the `off` block too.
      [undefined, false, "off"],
    ];
    for (const [graft, enabled, status] of shapes) {
      const document = buildCallbackContextDocument(
        { ...FULL_CONTEXT, ...(graft ? { graft } : { graft: undefined }) },
        "always",
      );
      const block = document.graft as Record<string, unknown>;
      assertEquals(typeof block, "object", `graft missing for ${status}`);
      assertEquals(block.enabled, enabled, `graft.enabled wrong for ${status}`);
      assertEquals(block.status, status, `graft.status wrong for ${status}`);

      const env = buildCallbackEnv(
        { ...FULL_CONTEXT, ...(graft ? { graft } : { graft: undefined }) },
        "always",
        "/tmp/context.json",
        () => undefined,
      );
      assertEquals(env.VIBECODER_GRAFT_ENABLED, String(enabled));
      assertEquals(env.VIBECODER_GRAFT_STATUS, status);
    }
  },
);

Deno.test(
  "#2104 - the four Graft figures travel when reached and are omitted when not",
  () => {
    const document = buildCallbackContextDocument(FULL_CONTEXT, "always");
    assertEquals(document.graft, {
      enabled: true,
      status: "ok",
      buildSeconds: 12.5,
      bundleChars: 4096,
      nodeCount: 820,
      callEdgeCount: 1204,
    });
    const env = buildCallbackEnv(
      FULL_CONTEXT,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(env.VIBECODER_GRAFT_BUILD_SECONDS, "12.5");
    assertEquals(env.VIBECODER_GRAFT_BUNDLE_CHARS, "4096");
    assertEquals(env.VIBECODER_GRAFT_NODE_COUNT, "820");
    assertEquals(env.VIBECODER_GRAFT_CALL_EDGE_COUNT, "1204");

    const lean = buildCallbackEnv(
      WITHOUT_ADDITIVE,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    for (const name of GRAFT_FIGURE_ENV) {
      assertEquals(lean[name], undefined, `${name} exported without a figure`);
    }
  },
);

Deno.test(
  "#2104 - the Graft block left schemaVersion and every earlier field alone",
  () => {
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
    assertEquals(missing, [], "the Graft block dropped an earlier scalar");
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
  {
    // A genuine zero is a figure, not an absence: an index of zero nodes and
    // an index whose counts were never read must not publish the same block.
    name: "ok with zero figures",
    codegraph: {
      enabled: true,
      status: "ok",
      indexSeconds: 0,
      nodeCount: 0,
      relationshipCount: 0,
      queries: 0,
    },
    expected: {
      enabled: true,
      status: "ok",
      indexSeconds: 0,
      nodeCount: 0,
      relationshipCount: 0,
      queries: 0,
    },
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

    // Zero is exported, never dropped: "0 queries" is a measurement of the
    // trial, and an omitted scalar would read as "this run never reported".
    const zero = buildCallbackEnv(
      {
        ...FULL_CONTEXT,
        codegraph: { enabled: true, status: "ok", nodeCount: 0, queries: 0 },
      },
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(zero.VIBECODER_CODEGRAPH_NODE_COUNT, "0");
    assertEquals(zero.VIBECODER_CODEGRAPH_QUERIES, "0");
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

// ---------------------------------------------------------------------------
// The additive `rtk` block (Issue #2386, part of #2328)
// ---------------------------------------------------------------------------

/** One run's RTK preparation, as the trial's four statuses report it. */
const RTK_CASES: Array<
  { name: string; rtk: RtkOutputResult; expected: Record<string, unknown> }
> = [
  {
    name: "ok",
    rtk: { enabled: true, status: "ok", savedTokens: 12_840 },
    expected: { enabled: true, status: "ok", savedTokens: 12_840 },
  },
  {
    // The hook was installed but the second gain read failed: no figure.
    name: "ok with no gain figure",
    rtk: { enabled: true, status: "ok" },
    expected: { enabled: true, status: "ok" },
  },
  {
    name: "failed",
    rtk: { enabled: true, status: "failed" },
    expected: { enabled: true, status: "failed" },
  },
  {
    // `provider` is the run-stats line's detail, not part of this block.
    name: "unsupported",
    rtk: { enabled: true, status: "unsupported", provider: "codex" },
    expected: { enabled: true, status: "unsupported" },
  },
  {
    name: "off",
    rtk: { enabled: false, status: "off" },
    expected: { enabled: false, status: "off" },
  },
  {
    // A measured zero is a figure; only an unread store is omitted.
    name: "ok with nothing saved",
    rtk: { enabled: true, status: "ok", savedTokens: 0 },
    expected: { enabled: true, status: "ok", savedTokens: 0 },
  },
];

Deno.test(
  "#2386 - the rtk block carries enabled and status for every status, and savedTokens only when read",
  () => {
    for (const testCase of RTK_CASES) {
      const document = buildCallbackContextDocument(
        { ...FULL_CONTEXT, rtk: testCase.rtk },
        "always",
      );
      assertEquals(
        document.rtk,
        testCase.expected,
        `the ${testCase.name} run published the wrong rtk block`,
      );
    }
  },
);

Deno.test(
  "#2386 - a run that reported no RTK preparation is explicitly off, never absent",
  () => {
    const context: IssueRunCallbackContext = { ...FULL_CONTEXT };
    delete context.rtk;
    const document = buildCallbackContextDocument(context, "always");
    assertEquals(document.rtk, { enabled: false, status: "off" });
  },
);

Deno.test(
  "#2386 - the rtk scalars are exported, the saved-token figure only when the run has it",
  () => {
    const full = buildCallbackEnv(
      FULL_CONTEXT,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(full.VIBECODER_RTK_ENABLED, "true");
    assertEquals(full.VIBECODER_RTK_STATUS, "ok");
    assertEquals(full.VIBECODER_RTK_SAVED_TOKENS, "12840");

    // Omitted entirely: not blank, and not a zero standing in for "unknown".
    for (const testCase of RTK_CASES) {
      if (testCase.rtk.savedTokens !== undefined) continue;
      const env = buildCallbackEnv(
        { ...FULL_CONTEXT, rtk: testCase.rtk },
        "always",
        "/tmp/context.json",
        () => undefined,
      );
      assertEquals(env.VIBECODER_RTK_ENABLED, String(testCase.rtk.enabled));
      assertEquals(env.VIBECODER_RTK_STATUS, testCase.rtk.status);
      assert(
        !("VIBECODER_RTK_SAVED_TOKENS" in env),
        `the ${testCase.name} run exported a saved-token figure it never read`,
      );
    }

    // A run that supplied nothing still exports the two constant scalars.
    const bare: IssueRunCallbackContext = { ...FULL_CONTEXT };
    delete bare.rtk;
    const absent = buildCallbackEnv(
      bare,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(absent.VIBECODER_RTK_ENABLED, "false");
    assertEquals(absent.VIBECODER_RTK_STATUS, "off");
    assert(!("VIBECODER_RTK_SAVED_TOKENS" in absent));

    // A measured zero is a real figure and must not be dropped as falsy.
    const zero = buildCallbackEnv(
      { ...FULL_CONTEXT, rtk: { enabled: true, status: "ok", savedTokens: 0 } },
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(zero.VIBECODER_RTK_SAVED_TOKENS, "0");
  },
);

Deno.test(
  "#2386 - the block is additive: the schema version and every earlier field and scalar are untouched",
  () => {
    assertEquals(CALLBACK_SCHEMA_VERSION, 2);
    const document = buildCallbackContextDocument(FULL_CONTEXT, "always");
    assertEquals(document.schemaVersion, 2);
    for (const [field, type] of Object.entries(SCHEMA_1_DOCUMENT)) {
      assertEquals(typeof document[field], type, `document.${field} moved`);
    }
    // The blocks that landed before this one read exactly as they did.
    assertEquals(document.graft, FULL_CONTEXT.graft);
    assertEquals(document.codegraph, FULL_CONTEXT.codegraph);
    // Appended after every earlier key, so a consumer that reads the document
    // in order sees nothing it knew move.
    assertEquals(Object.keys(document).at(-1), "rtk");
    assertEquals(Object.keys(document).at(-2), "codegraph");

    const env = buildCallbackEnv(
      FULL_CONTEXT,
      "always",
      "/tmp/context.json",
      () => undefined,
    );
    const earlier = [
      ...SCHEMA_1_ENV,
      ...ADDITIVE_ENV,
      ...GRAFT_FIGURE_ENV,
      "VIBECODER_GRAFT_ENABLED",
      "VIBECODER_GRAFT_STATUS",
      "VIBECODER_CODEGRAPH_ENABLED",
      "VIBECODER_CODEGRAPH_STATUS",
      "VIBECODER_CODEGRAPH_INDEX_SECONDS",
      "VIBECODER_CODEGRAPH_NODE_COUNT",
      "VIBECODER_CODEGRAPH_RELATIONSHIP_COUNT",
      "VIBECODER_CODEGRAPH_QUERIES",
    ];
    for (const name of earlier) {
      assert(env[name] !== undefined, `${name} is no longer exported`);
    }
  },
);

// --- The additive workerVersion/workerCommit fields (Issue #2444) ---

Deno.test(
  "callback schema compat — workerVersion and workerCommit are carried in the document and exported as scalars when the build could be read",
  () => {
    const document = buildCallbackContextDocument(FULL_CONTEXT, "success");

    assertEquals(document.workerVersion, "1.4.2");
    assertEquals(
      document.workerCommit,
      "0123456789abcdef0123456789abcdef01234567",
    );

    const env = buildCallbackEnv(
      FULL_CONTEXT,
      "success",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(env.VIBECODER_WORKER_VERSION, "1.4.2");
    assertEquals(
      env.VIBECODER_WORKER_COMMIT,
      "0123456789abcdef0123456789abcdef01234567",
    );
  },
);

Deno.test(
  "callback schema compat — workerVersion and workerCommit are omitted, not blank, when the build could not be read",
  () => {
    // Context without worker build fields
    const contextWithoutBuild = {
      ...FULL_CONTEXT,
      workerVersion: undefined,
      workerCommit: undefined,
    };

    const document = buildCallbackContextDocument(
      contextWithoutBuild,
      "failure",
    );
    assert(!("workerVersion" in document), "workerVersion should be omitted");
    assert(!("workerCommit" in document), "workerCommit should be omitted");

    const env = buildCallbackEnv(
      contextWithoutBuild,
      "failure",
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(env.VIBECODER_WORKER_VERSION, undefined);
    assertEquals(env.VIBECODER_WORKER_COMMIT, undefined);
  },
);

Deno.test(
  "#2444 — the addition is additive: schema version, key order and every earlier field and scalar are unaffected",
  () => {
    const document = buildCallbackContextDocument(FULL_CONTEXT, "always");

    // Schema version unchanged
    assertEquals(CALLBACK_SCHEMA_VERSION, 2);
    assertEquals(document.schemaVersion, 2);

    // Key order: rtk at -1, codegraph at -2, confirming no earlier key moved
    assertEquals(Object.keys(document).at(-1), "rtk");
    assertEquals(Object.keys(document).at(-2), "codegraph");

    // Every field from SCHEMA_1_DOCUMENT retains its type
    for (const [field, type] of Object.entries(SCHEMA_1_DOCUMENT)) {
      assertEquals(
        typeof document[field as keyof typeof document],
        type,
        `document.${field} is no longer a ${type}`,
      );
    }

    // Every pinned scalar is still exported
    const env = buildCallbackEnv(
      FULL_CONTEXT,
      "always",
      "/tmp/context.json",
      () => undefined,
    );

    // Verify SCHEMA_1 scalars are still there (unconditional)
    for (const name of SCHEMA_1_ENV) {
      assert(
        env[name] !== undefined,
        `SCHEMA_1 scalar ${name} is no longer exported`,
      );
    }
    // Verify ADDITIVE_ENV scalars are still there (FULL_CONTEXT has these fields)
    for (const name of ADDITIVE_ENV) {
      assert(
        env[name] !== undefined,
        `ADDITIVE scalar ${name} is no longer exported`,
      );
    }
    // Verify GRAFT_FIGURE_ENV scalars are still there (FULL_CONTEXT has graft)
    for (const name of GRAFT_FIGURE_ENV) {
      assert(
        env[name] !== undefined,
        `GRAFT scalar ${name} is no longer exported`,
      );
    }
    // Verify graft enabled/status scalars are still there
    assert(env.VIBECODER_GRAFT_ENABLED !== undefined);
    assert(env.VIBECODER_GRAFT_STATUS !== undefined);
    // Verify codegraph scalars are still there
    assert(env.VIBECODER_CODEGRAPH_ENABLED !== undefined);
    assert(env.VIBECODER_CODEGRAPH_STATUS !== undefined);
    assert(env.VIBECODER_CODEGRAPH_INDEX_SECONDS !== undefined);
    assert(env.VIBECODER_CODEGRAPH_NODE_COUNT !== undefined);
    assert(env.VIBECODER_CODEGRAPH_RELATIONSHIP_COUNT !== undefined);
    assert(env.VIBECODER_CODEGRAPH_QUERIES !== undefined);
    // Verify worker build scalars are there (FULL_CONTEXT has these fields)
    for (const name of WORKER_BUILD_ENV) {
      assert(
        env[name] !== undefined,
        `WORKER_BUILD scalar ${name} is no longer exported`,
      );
    }
  },
);
