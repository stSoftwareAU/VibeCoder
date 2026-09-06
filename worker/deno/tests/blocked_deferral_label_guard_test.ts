/**
 * Tests for the worker-label guard on the deferral fallback
 * (Issue #1219, SEC-1219-02).
 *
 * `deferBlockedIssue` records `Depends on owner/repo#N` in the issue body, and
 * falls back to the `blocked` label when that edit fails. That fallback called
 * `ghClient.addLabel` directly — the labels API, not `addLabelToIssue` — so it
 * was the one label write in `worker/deno/lib/` that reached GitHub without
 * passing `assertWorkerCanApplyLabel`, and `blocked` was on neither the
 * worker's positive allowlist nor its forbidden list.
 *
 * Fail direction, stated explicitly:
 *   - `the blocked label the deferral applies is on the worker allowlist`
 *     FAILS against the unfixed code (`blocked` was absent from
 *     `WORKER_APPLIABLE_LABEL_LITERALS`, so `isWorkerAppliableLabel` returned
 *     false while the worker applied it anyway) and PASSES after the fix.
 *   - the two behavioural tests below pin the fallback either side of the new
 *     guard, so wiring the guard in cannot silently remove the label.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { BLOCKED_LABEL, deferBlockedIssue } from "../lib/blocked_deferral.ts";
import {
  assertWorkerCanApplyLabel,
  isWorkerAppliableLabel,
} from "../lib/worker_label_guard.ts";
import type { BlockedOutcome } from "../lib/blocked_outcome.ts";
import type { GitHubClient, GitHubIssue, Logger } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 94;

const BLOCKED: BlockedOutcome = {
  dependency: { repo: "stSoftwareAU/NEAT-AI", number: 7 },
  dependencies: [{ repo: "stSoftwareAU/NEAT-AI", number: 7 }],
  reason: "The rule bodies have not landed yet.",
};

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

interface Calls {
  addLabel: string[];
  ensured: string[];
}

/**
 * A client whose `editIssue` always throws, so the deferral falls through to
 * the label branch — the branch the guard now covers.
 */
function makeClient(calls: Calls): GitHubClient {
  const issue: GitHubIssue = {
    number: ISSUE,
    title: "Validate every trained creature",
    body: "Original body.",
    labels: ["work-on"],
    author: "human",
    assignees: ["testbot"],
    createdAt: "",
    updatedAt: "",
  };
  const client: GitHubClient = {
    getIssue: () => Promise.resolve(issue),
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_r, _i, label) => {
      calls.addLabel.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.reject(new Error("body edit refused")),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
  return client;
}

async function runDeferral(
  calls: Calls,
  guardLines: string[],
): Promise<string> {
  const result = await deferBlockedIssue({
    ghClient: makeClient(calls),
    repo: REPO,
    issueNumber: ISSUE,
    githubUser: "testbot",
    blocked: BLOCKED,
    outputSnippet: "blocked",
    logger: SILENT_LOGGER,
    deps: {
      releaseClaim: () => Promise.resolve(true),
      ensureLabelExists: (_r, label) => {
        calls.ensured.push(label);
        return Promise.resolve({ ok: true as const, value: undefined });
      },
      labelGuardLogFn: (line) => guardLines.push(line),
    },
  });
  return result.recorded;
}

Deno.test("the blocked label the deferral applies is on the worker allowlist", () => {
  // The regression assertion. Before the fix the worker applied `blocked`
  // while the allowlist said it could not, so the guard invariant was false.
  assert(
    isWorkerAppliableLabel(BLOCKED_LABEL),
    `${BLOCKED_LABEL} must be on the worker allowlist — the deferral applies it`,
  );
  const guard = assertWorkerCanApplyLabel(BLOCKED_LABEL, {
    caller: "test",
    logFn: () => {},
  });
  assertEquals(guard.ok, true);
});

Deno.test("deferBlockedIssue - applies the blocked label when the body edit fails", async () => {
  const calls: Calls = { addLabel: [], ensured: [] };
  const guardLines: string[] = [];
  const recorded = await runDeferral(calls, guardLines);

  assertEquals(recorded, "label");
  assertEquals(calls.addLabel, [BLOCKED_LABEL]);
  assertEquals(calls.ensured, [BLOCKED_LABEL]);
  // The guard passed, so it emitted no refusal line.
  assertEquals(guardLines, []);
});

Deno.test("deferBlockedIssue - applies no label outside the worker allowlist", async () => {
  const calls: Calls = { addLabel: [], ensured: [] };
  await runDeferral(calls, []);

  for (const label of [...calls.addLabel, ...calls.ensured]) {
    assert(
      isWorkerAppliableLabel(label),
      `deferBlockedIssue applied '${label}', which the worker may not apply`,
    );
  }
});
