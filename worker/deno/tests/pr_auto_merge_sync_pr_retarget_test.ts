/**
 * The arming chokepoint refuses a retargeted milestone sync PR (Issue #1967).
 *
 * When `delete_branch_on_merge` removes a milestone branch, GitHub retargets
 * the open PRs pointing at it to the default branch rather than closing them
 * — approvals and auto-merge arming intact. VibeCoder#1957 reached `main`
 * that way, its diff reverting the milestone's own work, and only an
 * unrelated red shard stopped it merging.
 *
 * `enableAutoMerge` is the single door every arming path goes through — the
 * priority 1.65 sweep, the PR-maintenance scan, the CI-fix re-arm and
 * `pr_manager` — so the refusal lives there: closed, never merged, with the
 * reason posted on the PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AutoMergeResult,
  enableAutoMerge,
  type EnableAutoMergeOptions,
} from "../lib/pr_auto_merge.ts";

const REPO = "org/repo";
const SYNC_HEAD = "sync/milestone-scan-issues-20260906";

interface Sink {
  armed: number[];
  closed: number[];
  comments: string[];
}

/** Options around one PR, recording what the chokepoint does to it. */
function optionsFor(
  pr: { headRefName: string; baseRefName: string },
  sink: Sink,
  overrides: Partial<EnableAutoMergeOptions> = {},
): EnableAutoMergeOptions {
  return {
    repo: REPO,
    prNumber: 1957,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    log: () => {},
    // A protected base keeps the ordinary path on `gh pr merge --auto`
    // rather than the gated direct merge.
    isBaseProtectedFn: () => Promise.resolve(true),
    getDefaultBranchFn: () => Promise.resolve({ ok: true, value: "main" }),
    ghCommandFn: (args: string[]) => {
      const key = args.join(" ");
      if (key.includes("isCrossRepository")) return Promise.resolve("false");
      if (key.startsWith("pr merge")) {
        sink.armed.push(Number(args[2]));
        return Promise.resolve("");
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
    ...overrides,
  };
}

function sink(): Sink {
  return { armed: [], closed: [], comments: [] };
}

Deno.test("enableAutoMerge - a sync PR retargeted onto the default branch is closed, never merged (Issue #1967)", async () => {
  const s = sink();
  const result = await enableAutoMerge(
    optionsFor({ headRefName: SYNC_HEAD, baseRefName: "main" }, s),
  );

  assertEquals(result.result, AutoMergeResult.ClosedRetargetedSync);
  assertEquals(s.closed, [1957]);
  assertEquals(s.armed, []);
  assertEquals(s.comments.length, 1);
  assertStringIncludes(s.comments[0] ?? "", "main");
  assertStringIncludes(s.comments[0] ?? "", "closed and never merged");
});

Deno.test("enableAutoMerge - a sync PR still targeting its milestone branch is armed as before (Issue #1967)", async () => {
  const s = sink();
  const result = await enableAutoMerge(
    optionsFor(
      { headRefName: SYNC_HEAD, baseRefName: "milestone/scan-issues-20260906" },
      s,
    ),
  );

  assertEquals(result.result, AutoMergeResult.Enabled);
  assertEquals(s.closed, []);
  assertEquals(s.armed, [1957]);
});

Deno.test("enableAutoMerge - an ordinary PR into the default branch is untouched (Issue #1967)", async () => {
  const s = sink();
  const result = await enableAutoMerge(
    optionsFor({ headRefName: "issue-1959-fix", baseRefName: "main" }, s),
  );

  assertEquals(result.result, AutoMergeResult.Enabled);
  assertEquals(s.closed, []);
  assertEquals(s.armed, [1957]);
});

Deno.test("enableAutoMerge - a sync-shaped head on a fork is a claim, not evidence, and is left alone (Issue #1967, #1249)", async () => {
  const s = sink();
  const warnings: string[] = [];
  const result = await enableAutoMerge(
    optionsFor({ headRefName: SYNC_HEAD, baseRefName: "main" }, s, {
      log: (message: string) => warnings.push(message),
      ghCommandFn: (args: string[]) => {
        const key = args.join(" ");
        if (key.includes("isCrossRepository")) return Promise.resolve("true");
        if (key.startsWith("pr merge")) {
          s.armed.push(Number(args[2]));
          return Promise.resolve("");
        }
        if (key.startsWith("pr close")) {
          s.closed.push(Number(args[2]));
          return Promise.resolve("");
        }
        return Promise.resolve("[]");
      },
    }),
  );

  // Closing a PR is destructive, and a fork names its own branches.
  assertEquals(s.closed, []);
  assertEquals(result.result, AutoMergeResult.Enabled);
  assert(warnings.some((w) => w.includes("fork")));
});

Deno.test("enableAutoMerge - an unreadable default branch neither closes nor arms a sync-shaped head (Issue #1967)", async () => {
  const s = sink();
  const result = await enableAutoMerge(
    optionsFor({ headRefName: SYNC_HEAD, baseRefName: "main" }, s, {
      getDefaultBranchFn: () =>
        Promise.resolve({ ok: false, error: new Error("502 Bad Gateway") }),
    }),
  );

  assertEquals(result.result, AutoMergeResult.Deferred);
  assertEquals(result.deferral, "sync-base-unreadable");
  assertEquals(s.closed, []);
  assertEquals(s.armed, []);
});

Deno.test("enableAutoMerge - a close that GitHub refuses fails loud rather than arming (Issue #1967)", async () => {
  const s = sink();
  const result = await enableAutoMerge(
    optionsFor({ headRefName: SYNC_HEAD, baseRefName: "main" }, s, {
      ghCommandFn: (args: string[]) => {
        const key = args.join(" ");
        if (key.includes("isCrossRepository")) return Promise.resolve("false");
        if (key.startsWith("pr close")) {
          return Promise.reject(new Error("422 Unprocessable Entity"));
        }
        if (key.startsWith("pr merge")) {
          s.armed.push(Number(args[2]));
          return Promise.resolve("");
        }
        return Promise.resolve("[]");
      },
    }),
  );

  assertEquals(result.result, AutoMergeResult.Failed);
  assertEquals(s.armed, []);
  assertStringIncludes(result.message, "still");
});
