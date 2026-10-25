/**
 * Regression tests for the worker label allowlist guard at the two call
 * sites that previously bypassed it (Issue #13).
 *
 * `assertWorkerCanApplyLabel` used to be reachable only via
 * `addLabelToIssue`. `escalateToHuman` (`needs_human_escalation.ts`) reached
 * the labels API directly through `ghClient.addLabel`. (The second path,
 * `ghClientFromCommandFn` in `label_clarification.ts`, went with the
 * clarification hand-off in Issue #4298.)
 *
 * These tests drive the call site with a forbidden label and assert the
 * mutation never reaches GitHub, plus happy-path tests proving the
 * allowlisted `needs-human` label still applies.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { escalateToHuman } from "../lib/needs_human_escalation.ts";
import type { GitHubClient, Logger } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
}

interface RecordingClient {
  client: GitHubClient;
  addedLabels: string[];
  postedBodies: string[];
}

function makeRecordingClient(): RecordingClient {
  const addedLabels: string[] = [];
  const postedBodies: string[] = [];
  const client: GitHubClient = {
    getIssue: () => Promise.reject(new Error("stub: getIssue not used")),
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_repo: string, _n: number, label: string) => {
      addedLabels.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_repo: string, _n: number, body: string) => {
      postedBodies.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
  return { client, addedLabels, postedBodies };
}

// ---------------------------------------------------------------------------
// escalateToHuman — needs_human_escalation.ts
// ---------------------------------------------------------------------------

Deno.test("escalateToHuman - refuses a label outside the worker allowlist", async () => {
  const { client, addedLabels, postedBodies } = makeRecordingClient();
  const ensuredLabels: string[] = [];
  const refusals: string[] = [];

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 42 },
    // A reserved pickup label — the class the guard exists to block.
    needsHumanLabel: "top-priority",
    reason: "test",
    nextStep: "test",
    deps: {
      github: {
        ensureLabelExists: (_repo, name) => {
          ensuredLabels.push(name);
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
      labelGuardLogFn: (line: string) => refusals.push(line),
    },
    logger: makeSilentLogger(),
  });

  // The mutation never reached GitHub — neither the add nor the create.
  assertEquals(addedLabels, []);
  assertEquals(ensuredLabels, []);
  // The refusal is loud: a [SECURITY] audit line was emitted.
  assertEquals(refusals.length, 1);
  assertEquals(refusals[0]!.includes("[WORKER_LABEL_REFUSED]"), true);
  assertEquals(refusals[0]!.includes("top-priority"), true);
  // The escalation comment still posts — the human-visible signal survives.
  assertEquals(postedBodies.length, 1);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.labelAdded, false);
    assertEquals(result.value.commentPosted, true);
  }
});

Deno.test("escalateToHuman - still applies the allowlisted needs-human label", async () => {
  const { client, addedLabels, postedBodies } = makeRecordingClient();
  const ensuredLabels: string[] = [];

  const result = await escalateToHuman({
    ghClient: client,
    repo: "org/repo",
    target: { kind: "issue", number: 7 },
    needsHumanLabel: "needs-human",
    reason: "test",
    nextStep: "test",
    deps: {
      github: {
        ensureLabelExists: (_repo, name) => {
          ensuredLabels.push(name);
          return Promise.resolve({ ok: true, value: undefined });
        },
      },
    },
    logger: makeSilentLogger(),
  });

  assertEquals(addedLabels, ["needs-human"]);
  assertEquals(ensuredLabels, ["needs-human"]);
  assertEquals(postedBodies.length, 1);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.labelAdded, true);
});
