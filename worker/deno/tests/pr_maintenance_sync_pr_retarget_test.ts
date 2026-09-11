/**
 * The auto-merge scan refuses a retargeted milestone sync PR (Issue #1967).
 *
 * When `delete_branch_on_merge` removes a milestone branch, GitHub retargets
 * the open PRs pointing at it to the default branch rather than closing them
 * — approvals and auto-merge arming intact. VibeCoder#1957 reached `main`
 * that way, its diff reverting the milestone's own work, and only an
 * unrelated red shard stopped it merging.
 *
 * This is the last line of defence: whatever else missed it, the scan that
 * arms auto-merge must close such a PR instead, and say why on the PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type AutoMergeOptions,
  ensureAutoMergeOnOpenPrs,
} from "../lib/pr_maintenance.ts";
import type { Logger } from "../types.ts";

function silentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

interface Sink {
  armed: number[];
  closed: number[];
  comments: string[];
}

/** Options wired around one open PR, recording what the scan does to it. */
function optionsFor(pr: Record<string, unknown>, sink: Sink): AutoMergeOptions {
  return {
    githubUser: "testbot",
    repos: ["org/repo"],
    logger: silentLogger(),
    isRepoAllowed: () => true,
    isAuthorisedCommenter: () => true,
    ghCommandFn: (args: string[]) => {
      const key = args.join(" ");
      if (key.startsWith("pr list")) {
        return Promise.resolve(JSON.stringify([pr]));
      }
      if (key.startsWith("pr comment")) {
        sink.comments.push(args[args.indexOf("--body") + 1] ?? "");
        return Promise.resolve("");
      }
      if (key.startsWith("pr close")) {
        sink.closed.push(Number(args[2]));
        return Promise.resolve("");
      }
      return Promise.resolve("[]");
    },
    getRepoConfig: () => "",
    getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "main" }),
    enableAutoMergeFn: (_repo: string, prNumber: number) => {
      sink.armed.push(prNumber);
      return Promise.resolve({ result: "enabled", message: "OK" });
    },
  };
}

const RETARGETED = {
  number: 1957,
  headRefName: "sync/milestone-scan-issues-20260906",
  baseRefName: "main",
  author: { login: "testbot" },
  autoMergeRequest: { mergeMethod: "MERGE" },
};

Deno.test("ensureAutoMergeOnOpenPrs - a sync PR retargeted onto the default branch is closed, never merged (Issue #1967)", async () => {
  const sink: Sink = { armed: [], closed: [], comments: [] };
  const result = await ensureAutoMergeOnOpenPrs(optionsFor(RETARGETED, sink));

  assertEquals(result.ok, true);
  assertEquals(sink.closed, [1957]);
  assertEquals(sink.armed, []);
  assert(sink.comments.length === 1, "the refusal must be posted on the PR");
  assertStringIncludes(sink.comments[0] ?? "", "main");
  assertStringIncludes(sink.comments[0] ?? "", "closed and never merged");
});

Deno.test("ensureAutoMergeOnOpenPrs - a sync PR still targeting its milestone branch is armed as before (Issue #1967)", async () => {
  const sink: Sink = { armed: [], closed: [], comments: [] };
  const result = await ensureAutoMergeOnOpenPrs(optionsFor({
    ...RETARGETED,
    baseRefName: "milestone/scan-issues-20260906",
    autoMergeRequest: null,
  }, sink));

  assertEquals(result.ok, true);
  assertEquals(sink.closed, []);
  assertEquals(sink.armed, [1957]);
});

Deno.test("ensureAutoMergeOnOpenPrs - an ordinary PR into the default branch is untouched (Issue #1967)", async () => {
  const sink: Sink = { armed: [], closed: [], comments: [] };
  const result = await ensureAutoMergeOnOpenPrs(optionsFor({
    number: 1959,
    headRefName: "issue-1959-fix",
    baseRefName: "main",
    author: { login: "testbot" },
    autoMergeRequest: null,
  }, sink));

  assertEquals(result.ok, true);
  assertEquals(sink.closed, []);
  assertEquals(sink.armed, [1959]);
});

Deno.test("ensureAutoMergeOnOpenPrs - a sync-shaped head from outside the fleet is left alone (Issue #1967)", async () => {
  const sink: Sink = { armed: [], closed: [], comments: [] };
  const result = await ensureAutoMergeOnOpenPrs(optionsFor({
    ...RETARGETED,
    author: { login: "dependabot[bot]" },
    autoMergeRequest: null,
  }, sink));

  assertEquals(result.ok, true);
  // Closing a PR is destructive: only the fleet's own sync PRs are ours
  // to retire on the strength of a branch name.
  assertEquals(sink.closed, []);
  assertEquals(sink.armed, [1957]);
});

Deno.test("ensureAutoMergeOnOpenPrs - an unresolvable default branch closes nothing (Issue #1967)", async () => {
  const sink: Sink = { armed: [], closed: [], comments: [] };
  const options = optionsFor({ ...RETARGETED, autoMergeRequest: null }, sink);
  const result = await ensureAutoMergeOnOpenPrs({
    ...options,
    getDefaultBranchFn: () =>
      Promise.resolve({ ok: false, error: new Error("502 Bad Gateway") }),
  });

  assertEquals(result.ok, true);
  assertEquals(sink.closed, []);
});
