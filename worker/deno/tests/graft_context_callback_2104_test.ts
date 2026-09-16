/**
 * The Graft figures reach the post-run callback context (Issue #2104, part of
 * #2060).
 *
 * The block is **additive and unconditional**: every run carries
 * `graft.enabled` and `graft.status`, with the four figures when the
 * collection reached them. A host that never opted in reports
 * `{ enabled: false, status: "off" }` rather than nothing, so a GRQ-23 run is
 * comparable with every other host in the logs repo instead of being
 * indistinguishable from a worker too old to report. `enabled` states the
 * host's real switch even when the run ended before the collection, so an
 * early exit on a Graft host is never archived as a host that never opted in.
 *
 * The path is exercised rather than asserted a field at a time: `workOnIssue`
 * lifts the collection off the phase state, and the context builder and the
 * document/environment builders publish it. The scan loop's own half of the
 * thread — `withProcessCallbackFacts` onto the terminal run — is covered in
 * `run_core_callbacks_test.ts`, beside the loop harness it needs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssue } from "../lib/issue_worker.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { GraftContextResult } from "../lib/graft_context.ts";
import {
  buildCallbackContextDocument,
  buildCallbackEnv,
  CALLBACK_SCHEMA_VERSION,
  callbackGraftFacts,
  type TerminalIssueRun,
} from "../lib/run_callbacks.ts";
import { buildIssueRunCallbackContext } from "../lib/run_callback_context.ts";

/** A full collection, as an enabled host that built and asked reports it. */
const OK_COLLECTION: GraftContextResult = {
  status: "ok",
  enabled: true,
  buildSeconds: 12.5,
  bundleChars: 4096,
  nodeCount: 820,
  callEdgeCount: 1204,
  // Never published: the bundle is repository source, spent on the prompt.
  bundle: "export function parseIsoDate(raw: string): number {}",
};

/** A collection that failed after the build, with partial figures. */
const FAILED_COLLECTION: GraftContextResult = {
  status: "failed",
  enabled: true,
  buildSeconds: 301,
};

const IDENTITY = { runId: "vibe-2104", host: "GRQ-23" };

function terminalRun(
  overrides: Partial<TerminalIssueRun> = {},
): TerminalIssueRun {
  return {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 2104,
    result: "success",
    startedAtEpochMs: Date.parse("2026-09-16T01:00:00.000Z"),
    finishedAtEpochMs: Date.parse("2026-09-16T01:30:00.000Z"),
    ...overrides,
  };
}

/** The `graft` block a document carries, typed for assertion. */
function graftBlock(
  run: TerminalIssueRun,
): Record<string, unknown> {
  const document = buildCallbackContextDocument(
    buildIssueRunCallbackContext(run, IDENTITY),
    "always",
  );
  return document.graft as Record<string, unknown>;
}

/** The environment a hook receives for one terminal run. */
function hookEnv(run: TerminalIssueRun): Record<string, string> {
  return buildCallbackEnv(
    buildIssueRunCallbackContext(run, IDENTITY),
    "always",
    "/tmp/context.json",
    () => undefined,
  );
}

// ---------------------------------------------------------------------------
// The block itself
// ---------------------------------------------------------------------------

Deno.test("#2104 - an `ok` collection publishes the status and all four figures", () => {
  assertEquals(graftBlock(terminalRun({ graft: OK_COLLECTION })), {
    enabled: true,
    status: "ok",
    buildSeconds: 12.5,
    bundleChars: 4096,
    nodeCount: 820,
    callEdgeCount: 1204,
  });
});

Deno.test("#2104 - the bundle text never reaches a hook", () => {
  const block = graftBlock(terminalRun({ graft: OK_COLLECTION }));
  assert(!("bundle" in block), "the bundle rode into the callback document");
  const env = hookEnv(terminalRun({ graft: OK_COLLECTION }));
  for (const [name, value] of Object.entries(env)) {
    assert(
      !value.includes("parseIsoDate"),
      `${name} carries the Graft bundle text`,
    );
  }
});

Deno.test("#2104 - a `failed` collection reports the figures it reached, not a clean `off`", () => {
  const block = graftBlock(terminalRun({ graft: FAILED_COLLECTION }));
  assertEquals(block, { enabled: true, status: "failed", buildSeconds: 301 });
  assert(!("nodeCount" in block), "a figure it never reached was invented");
});

Deno.test("#2104 - a host with the switch off reports an explicit `off` block", () => {
  assertEquals(
    graftBlock(terminalRun({ graft: { status: "off", enabled: false } })),
    { enabled: false, status: "off" },
  );
});

Deno.test("#2104 - a run that reported no collection at all still carries the block", () => {
  // The comparability rule: no run is allowed to be silent about Graft. This
  // is the last resort — a run that threw before `workOnIssue` could state the
  // switch; an ordinary early exit states it truthfully (see below).
  const run = terminalRun();
  assert(!("graft" in run), "the fixture must supply no collection");
  assertEquals(graftBlock(run), { enabled: false, status: "off" });
});

Deno.test("#2104 - the environment exports the status pair and the four figures", () => {
  const env = hookEnv(terminalRun({ graft: OK_COLLECTION }));
  assertEquals(env.VIBECODER_GRAFT_ENABLED, "true");
  assertEquals(env.VIBECODER_GRAFT_STATUS, "ok");
  assertEquals(env.VIBECODER_GRAFT_BUILD_SECONDS, "12.5");
  assertEquals(env.VIBECODER_GRAFT_BUNDLE_CHARS, "4096");
  assertEquals(env.VIBECODER_GRAFT_NODE_COUNT, "820");
  assertEquals(env.VIBECODER_GRAFT_CALL_EDGE_COUNT, "1204");
});

Deno.test("#2104 - the four figures are omitted, not exported empty, when unreached", () => {
  const env = hookEnv(terminalRun());
  assertEquals(env.VIBECODER_GRAFT_ENABLED, "false");
  assertEquals(env.VIBECODER_GRAFT_STATUS, "off");
  for (
    const name of [
      "VIBECODER_GRAFT_BUILD_SECONDS",
      "VIBECODER_GRAFT_BUNDLE_CHARS",
      "VIBECODER_GRAFT_NODE_COUNT",
      "VIBECODER_GRAFT_CALL_EDGE_COUNT",
    ]
  ) {
    assertEquals(env[name], undefined, `${name} exported without a figure`);
  }
});

Deno.test("#2104 - adding the block left the schema version alone", () => {
  // The scar of Issues #2039/#2041: additive changes never bump the version.
  assertEquals(CALLBACK_SCHEMA_VERSION, 2);
  const document = buildCallbackContextDocument(
    buildIssueRunCallbackContext(
      terminalRun({ graft: OK_COLLECTION }),
      IDENTITY,
    ),
    "always",
  );
  assertEquals(document.schemaVersion, 2);
});

Deno.test("#2104 - callbackGraftFacts copies the figures it is given and invents none", () => {
  assertEquals(
    callbackGraftFacts({ enabled: true, status: "ok", nodeCount: 0 }),
    {
      enabled: true,
      status: "ok",
      // Nought is a figure, not an absence: a graph with no nodes is reportable.
      nodeCount: 0,
    },
  );
});

// ---------------------------------------------------------------------------
// The wiring that fills it
// ---------------------------------------------------------------------------

Deno.test("#2104 - workOnIssue lifts the run's collection onto its result", async () => {
  const deps = createMockDeps({
    infrastructure: {
      collectGraftContext: () => Promise.resolve(OK_COLLECTION),
    },
  });
  const result = await workOnIssue({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 2104,
    issueTitle: "Record the Graft figures",
    issueBody: "Every run reports what the collection did.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  }, deps);

  assertEquals(result.graftContext?.status, "ok");
  assertEquals(result.graftContext?.nodeCount, 820);
  assert(
    !("bundle" in (result.graftContext ?? {})),
    "the bundle must be dropped before the outcome is recorded",
  );
});

Deno.test("#2104 - a run that ended before the collection states the host's real switch", async () => {
  // The fabricated-`false` trap: a Graft host whose run was refused the claim
  // never reaches the collection, and archiving it as `enabled: false` would
  // make it indistinguishable from a host that never opted in — the exact
  // comparison the block exists for.
  const config = buildDefaultWorkerConfig();
  config.graftContext = { ...config.graftContext, enabled: true };
  const deps = createMockDeps({
    issues: {
      claimIssue: () =>
        Promise.resolve({
          ok: true,
          value: { claimed: false, reason: "already_assigned" as const },
        }),
    },
  });

  const result = await workOnIssue({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 2104,
    issueTitle: "Record the Graft figures",
    issueBody: "The claim was refused, so the collection never ran.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  }, deps);

  assertEquals(result.graftContext, { status: "off", enabled: true });
  assertEquals(
    graftBlock(terminalRun({ graft: result.graftContext })),
    { enabled: true, status: "off" },
  );
});

Deno.test("#2104 - a host with the switch off reports `enabled: false` on the same path", async () => {
  const deps = createMockDeps({
    issues: {
      claimIssue: () =>
        Promise.resolve({
          ok: true,
          value: { claimed: false, reason: "already_assigned" as const },
        }),
    },
  });

  const result = await workOnIssue({
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 2104,
    issueTitle: "Record the Graft figures",
    issueBody: "The switch is off, so nothing was attempted.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    // Graft is off by default, so this is the fleet's ordinary host.
    config: buildDefaultWorkerConfig(),
  }, deps);

  assertEquals(result.graftContext, { status: "off", enabled: false });
});
