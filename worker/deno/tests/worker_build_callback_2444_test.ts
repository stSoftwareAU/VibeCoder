/**
 * The worker's version and commit reach every callback context (Issue #2444).
 *
 * A run record could not say which worker code produced it. Each host pulls
 * `main` at its own launch, so for an hour after a merge the fleet is a mix of
 * old and new code and no archive can sort its runs before/after a change.
 * These two facts close that gap: they are **additive** — `schemaVersion` does
 * not move — and they appear on `success`, `failure`, `always` and the
 * host-failure event alike.
 *
 * Two boundaries are load-bearing and are asserted here rather than assumed:
 *
 * - **Read once, never per run.** The build identity comes from a process-wide
 *   memo over the environment stamp and `deno.json`; no run spawns `git`.
 * - **Omitted, never guessed.** A value that cannot be read — blank, or the
 *   `unknown` sentinel — produces no field and no scalar, and the callback
 *   still runs.
 *
 * The pinned field set that makes a later removal fail in review lives in
 * `callback_schema_compat_test.ts`; this file covers behaviour.
 *
 * Nothing is spawned and nothing sleeps.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildCallbackContextDocument,
  buildCallbackEnv,
  CALLBACK_SCHEMA_VERSION,
  type IssueRunCallbackContext,
  type TerminalIssueRun,
} from "../lib/run_callbacks.ts";
import { type CallbackEvent } from "../lib/run_callbacks_config.ts";
import { buildIssueRunCallbackContext } from "../lib/run_callback_context.ts";
import {
  buildHostFailureDocument,
  buildHostFailureEnv,
  type HostFailurePayload,
} from "../lib/host_failure_hook.ts";
import {
  resetWorkerBuildInfoOnce,
  workerBuildFacts,
  type WorkerBuildInfo,
  workerBuildInfoOnce,
} from "../lib/worker_build_info.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const RUN: TerminalIssueRun = {
  repo: "stSoftwareAU/VibeCoder",
  issueNumber: 2444,
  result: "success",
  startedAtEpochMs: Date.UTC(2026, 8, 20, 5, 0, 0),
  finishedAtEpochMs: Date.UTC(2026, 8, 20, 5, 5, 0),
};

const IDENTITY = { runId: "vibe-2444", host: "GRQ-23" };

function context(
  overrides: Partial<IssueRunCallbackContext> = {},
): IssueRunCallbackContext {
  return {
    runId: "vibe-2444",
    result: "success",
    repository: "stSoftwareAU/VibeCoder",
    issueNumber: 2444,
    host: "GRQ-23",
    startedAt: "2026-09-20T05:00:00.000Z",
    finishedAt: "2026-09-20T05:05:00.000Z",
    durationSeconds: 300,
    exitCode: 0,
    ...overrides,
  };
}

function payload(
  overrides: Partial<HostFailurePayload> = {},
): HostFailurePayload {
  return {
    host: "GRQ-23",
    condition: "launcher",
    phase: "container_start",
    consecutiveFailures: 3,
    streakStartedAt: "2026-09-20T04:00:00.000Z",
    delivery: { kind: "first", count: 1 },
    attempt: 1,
    ...overrides,
  };
}

Deno.test("#2444 - a readable build identity becomes both facts", () => {
  const info: WorkerBuildInfo = { version: "1.4.2", commit: COMMIT };
  assertEquals(workerBuildFacts(info), {
    version: "1.4.2",
    commit: COMMIT,
  });
});

Deno.test("#2444 - an unreadable value is omitted, never guessed", () => {
  // `unknown` is the sentinel the stamp degrades to, and blank is what an
  // unstamped environment yields: neither is a fact about the running code.
  assertEquals(workerBuildFacts({ version: "unknown", commit: "unknown" }), {});
  assertEquals(workerBuildFacts({ version: "  ", commit: "" }), {});
  assertEquals(workerBuildFacts({ version: "1.4.2", commit: "unknown" }), {
    version: "1.4.2",
  });
  assertEquals(workerBuildFacts({ version: "unknown", commit: COMMIT }), {
    commit: COMMIT,
  });
});

Deno.test("#2444 - the dirty marker survives into the fact", () => {
  const facts = workerBuildFacts({
    version: "1.4.2",
    commit: `${COMMIT}-dirty`,
  });
  assertEquals(facts.commit, `${COMMIT}-dirty`);
});

Deno.test("#2444 - the build identity is resolved once, not per run", () => {
  resetWorkerBuildInfoOnce();
  let resolutions = 0;
  const resolve = (): WorkerBuildInfo => {
    resolutions += 1;
    return { version: "1.4.2", commit: COMMIT };
  };
  const first = workerBuildInfoOnce(resolve);
  const second = workerBuildInfoOnce(resolve);
  const third = workerBuildInfoOnce(resolve);
  assertEquals(resolutions, 1, "the identity was resolved more than once");
  assertEquals(first, second);
  assertEquals(second, third);
  resetWorkerBuildInfoOnce();
});

Deno.test("#2444 - the context builder carries the facts it is given", () => {
  const built = buildIssueRunCallbackContext(RUN, IDENTITY, {
    transcriptEnabled: () => false,
    buildFacts: () => ({ version: "1.4.2", commit: COMMIT }),
  });
  assertEquals(built.workerVersion, "1.4.2");
  assertEquals(built.workerCommit, COMMIT);
});

Deno.test("#2444 - the context omits what the build could not supply", () => {
  const built = buildIssueRunCallbackContext(RUN, IDENTITY, {
    transcriptEnabled: () => false,
    buildFacts: () => ({}),
  });
  assert(!("workerVersion" in built), "workerVersion was emitted empty");
  assert(!("workerCommit" in built), "workerCommit was emitted empty");
});

Deno.test("#2444 - every run event publishes the facts", () => {
  const events: CallbackEvent[] = ["success", "failure", "always"];
  for (const event of events) {
    const document = buildCallbackContextDocument(
      context({ workerVersion: "1.4.2", workerCommit: COMMIT }),
      event,
    );
    assertEquals(document.workerVersion, "1.4.2", `${event} lost the version`);
    assertEquals(document.workerCommit, COMMIT, `${event} lost the commit`);

    const env = buildCallbackEnv(
      context({ workerVersion: "1.4.2", workerCommit: COMMIT }),
      event,
      "/tmp/context.json",
      () => undefined,
    );
    assertEquals(env.VIBECODER_WORKER_VERSION, "1.4.2");
    assertEquals(env.VIBECODER_WORKER_COMMIT, COMMIT);
  }
});

Deno.test("#2444 - a run without the facts emits no key and no scalar", () => {
  const document = buildCallbackContextDocument(context(), "always");
  assert(!("workerVersion" in document), "an empty version was emitted");
  assert(!("workerCommit" in document), "an empty commit was emitted");
  // The rest of the document is unchanged, so a hook still runs on a host
  // whose build could not be read.
  assertEquals(document.schemaVersion, CALLBACK_SCHEMA_VERSION);
  assertEquals(document.runId, "vibe-2444");

  const env = buildCallbackEnv(
    context(),
    "always",
    "/tmp/context.json",
    () => undefined,
  );
  assertEquals(env.VIBECODER_WORKER_VERSION, undefined);
  assertEquals(env.VIBECODER_WORKER_COMMIT, undefined);
  assertEquals(env.VIBECODER_RUN_ID, "vibe-2444");
});

Deno.test("#2444 - the host-failure event carries the same two facts", () => {
  const facts = { version: "1.4.2", commit: COMMIT };
  const document = buildHostFailureDocument(payload(), facts);
  assertEquals(document.event, "host_failure");
  assertEquals(document.schemaVersion, CALLBACK_SCHEMA_VERSION);
  assertEquals(document.workerVersion, "1.4.2");
  assertEquals(document.workerCommit, COMMIT);

  const env = buildHostFailureEnv(
    payload(),
    "/tmp/context.json",
    () => undefined,
    facts,
  );
  assertEquals(env.VIBECODER_WORKER_VERSION, "1.4.2");
  assertEquals(env.VIBECODER_WORKER_COMMIT, COMMIT);
});

Deno.test("#2444 - the host-failure event omits what it cannot read", () => {
  const document = buildHostFailureDocument(payload(), {});
  assert(!("workerVersion" in document), "an empty version was emitted");
  assert(!("workerCommit" in document), "an empty commit was emitted");
  assertEquals(document.host, "GRQ-23");

  const env = buildHostFailureEnv(
    payload(),
    "/tmp/context.json",
    () => undefined,
    {},
  );
  assertEquals(env.VIBECODER_WORKER_VERSION, undefined);
  assertEquals(env.VIBECODER_WORKER_COMMIT, undefined);
  assertEquals(env.VIBECODER_HOST, "GRQ-23");
});

Deno.test("#2444 - the addition never moves the schema version", () => {
  assertEquals(CALLBACK_SCHEMA_VERSION, 2);
  const document = buildCallbackContextDocument(
    context({ workerVersion: "1.4.2", workerCommit: COMMIT }),
    "always",
  );
  assertEquals(document.schemaVersion, 2);
  // The blocks that landed before this one stay where a deployed hook reads
  // them: `rtk` then `codegraph` before it (Issues #2386, #2162), with the
  // `brief` block (Issue #2603) appended after them.
  assertEquals(Object.keys(document).at(-1), "brief");
  assertEquals(Object.keys(document).at(-2), "rtk");
  assertEquals(Object.keys(document).at(-3), "codegraph");
});
