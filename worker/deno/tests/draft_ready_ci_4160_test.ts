/**
 * A draft continuation is armed for auto-merge only once its ready-for-review
 * CI has started (Issue #4160).
 *
 * Draft PRs skip CI (Issue #4152), and GitHub counts a skipped required check
 * as passing. Arming auto-merge straight after `gh pr ready` could therefore
 * merge on the draft's skipped checks before the ready-for-review run
 * registers. `markReadyAndAwaitCi` marks the PR ready and reports `true` only
 * once a check run that was not on the head commit before, and was not
 * skipped, appears.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { markReadyAndAwaitCi } from "../lib/draft_continuation_pr.ts";

const REPO = "stSoftwareAU/VibeCoder";
const SHA = "abc123";

interface Run {
  id: number;
  conclusion: string | null;
}

/** A gh stub: check runs before `pr ready`, then the given polls after it. */
function ghStub(before: Run[], polls: Run[][]) {
  const calls: string[][] = [];
  let ready = false;
  let poll = 0;
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({ headRefOid: SHA }));
    }
    if (args[0] === "pr" && args[1] === "ready") {
      ready = true;
      return Promise.resolve("");
    }
    if (args[0] === "api" && args[1]?.includes(`/commits/${SHA}/check-runs`)) {
      const runs = ready ? polls[Math.min(poll++, polls.length - 1)] : before;
      return Promise.resolve(JSON.stringify(runs));
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  return { gh, calls };
}

const noSleep = () => Promise.resolve();

Deno.test("#4160 - waits for a new, non-skipped check run before reporting CI started", async () => {
  const skipped = [{ id: 1, conclusion: "skipped" }];
  const { gh, calls } = ghStub(skipped, [
    skipped,
    skipped,
    [...skipped, { id: 2, conclusion: null }],
  ]);
  const started = await markReadyAndAwaitCi({
    repo: REPO,
    prNumber: 7,
    gh,
    sleep: noSleep,
    log: () => {},
  });
  assert(started);
  assert(calls.some((c) => c[0] === "pr" && c[1] === "ready"));
  assertEquals(
    calls.filter((c) => c[0] === "api").length,
    4,
    "one snapshot before ready, then polls until the new run appears",
  );
});

Deno.test("#4160 - the draft's own skipped or earlier check runs never count as CI started", async () => {
  const before = [
    { id: 1, conclusion: "skipped" },
    { id: 2, conclusion: "success" },
  ];
  const { gh } = ghStub(before, [[...before, {
    id: 3,
    conclusion: "skipped",
  }]]);
  const started = await markReadyAndAwaitCi({
    repo: REPO,
    prNumber: 7,
    gh,
    sleep: noSleep,
    log: () => {},
    timeoutMs: 30_000,
    pollMs: 10_000,
  });
  assertFalse(started, "an old success and a new skipped run are not CI");
});

Deno.test("#4160 - no CI within the bound reports false, so auto-merge is left for the sweep", async () => {
  const logs: string[] = [];
  const { gh, calls } = ghStub([], [[]]);
  const started = await markReadyAndAwaitCi({
    repo: REPO,
    prNumber: 7,
    gh,
    sleep: noSleep,
    log: (m) => logs.push(m),
    timeoutMs: 30_000,
    pollMs: 10_000,
  });
  assertFalse(started);
  assertEquals(
    calls.filter((c) => c[0] === "api").length,
    5,
    "one snapshot, then polls at 0, 10, 20 and 30 s",
  );
  assert(logs.some((m) => m.includes("not armed")));
});

Deno.test("#4160 - a failed gh pr ready reports false and never polls", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "view") {
      return Promise.resolve(JSON.stringify({ headRefOid: SHA }));
    }
    if (args[1] === "ready") return Promise.reject(new Error("HTTP 502"));
    return Promise.resolve("[]");
  };
  const started = await markReadyAndAwaitCi({
    repo: REPO,
    prNumber: 7,
    gh,
    sleep: noSleep,
    log: () => {},
  });
  assertFalse(started);
  assertEquals(calls.filter((c) => c[0] === "api").length, 1);
});

Deno.test("#4160 - an unreadable check-run list still marks the PR ready, but never arms", async () => {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "view") return Promise.reject(new Error("HTTP 502"));
    return Promise.resolve("");
  };
  const started = await markReadyAndAwaitCi({
    repo: REPO,
    prNumber: 7,
    gh,
    sleep: noSleep,
    log: () => {},
  });
  assertFalse(started);
  assert(calls.some((c) => c[0] === "pr" && c[1] === "ready"));
});
