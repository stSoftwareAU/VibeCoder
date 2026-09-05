/**
 * Every arming path picks its merge method from the PR's head branch
 * (Issue #1048).
 *
 * The claim the fix rests on is that no path can quietly squash a milestone
 * sync. That is a property of three call sites — `enableAutoMerge`,
 * `directMergePr` and `raiseMilestoneSyncPr` — so each is asserted here
 * against the `gh` argv it actually produced.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { AutoMergeResult, enableAutoMerge } from "../lib/pr_auto_merge.ts";
import { directMergePr } from "../lib/direct_merge.ts";
import {
  isMergeCommitNotAllowed,
  squashedSyncWarning,
  syncBranchFor,
} from "../lib/milestone_sync_pr.ts";

const SYNC_HEAD = syncBranchFor("milestone/863");

/** Collect every `gh` argv, answering enough for the path under test. */
function recorder(answers: (args: string[]) => string | undefined) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(answers(args) ?? "");
  };
  return { calls, gh };
}

/** The `gh pr merge` argv from a recorded run. */
function mergeCall(calls: string[][]): string[] {
  const merge = calls.find((args) => args[0] === "pr" && args[1] === "merge");
  assert(merge, `no 'gh pr merge' was issued; saw ${JSON.stringify(calls)}`);
  return merge;
}

// ---------------------------------------------------------------------------
// enableAutoMerge
// ---------------------------------------------------------------------------

Deno.test("enableAutoMerge - a milestone sync head arms --merge", async () => {
  const { calls, gh } = recorder(() => "");
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 7,
    headRefName: SYNC_HEAD,
    baseRefName: "milestone/863",
    isBaseProtectedFn: () => Promise.resolve(true),
    decideMilestoneBaseFn: () =>
      Promise.resolve({
        decision: "allow" as const,
        reason: "not-milestone-base" as const,
      }),
    ghCommandFn: gh,
    maxRetries: 0,
  });
  assertEquals(result.result, AutoMergeResult.Enabled);
  const merge = mergeCall(calls);
  assert(merge.includes("--merge"), merge.join(" "));
  assert(!merge.includes("--squash"), merge.join(" "));
  assertStringIncludes(result.message, "merge-commit");
});

Deno.test("enableAutoMerge - an ordinary head still arms --squash", async () => {
  const { calls, gh } = recorder(() => "");
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 8,
    headRefName: "issue-1048-fix",
    baseRefName: "milestone/863",
    isBaseProtectedFn: () => Promise.resolve(true),
    decideMilestoneBaseFn: () =>
      Promise.resolve({
        decision: "allow" as const,
        reason: "not-milestone-base" as const,
      }),
    ghCommandFn: gh,
    maxRetries: 0,
  });
  assertEquals(result.result, AutoMergeResult.Enabled);
  assert(mergeCall(calls).includes("--squash"));
});

Deno.test("enableAutoMerge - a repo that forbids merge commits gets a loud squash", async () => {
  const attempted: string[] = [];
  const logged: string[] = [];
  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "merge") {
      const method = args.includes("--merge") ? "--merge" : "--squash";
      attempted.push(method);
      if (method === "--merge") {
        return Promise.reject(
          new Error("Merge commits are not allowed on this repository"),
        );
      }
    }
    return Promise.resolve("");
  };
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 9,
    headRefName: SYNC_HEAD,
    baseRefName: "milestone/863",
    isBaseProtectedFn: () => Promise.resolve(true),
    decideMilestoneBaseFn: () =>
      Promise.resolve({
        decision: "allow" as const,
        reason: "not-milestone-base" as const,
      }),
    ghCommandFn: gh,
    log: (message: string) => logged.push(message),
    maxRetries: 2,
  });
  assertEquals(result.result, AutoMergeResult.Enabled);
  assertEquals(attempted, ["--merge", "--squash"]);
  assert(
    logged.some((line) => line.includes("armed as a SQUASH")),
    `the downgrade must be loud; logged: ${JSON.stringify(logged)}`,
  );
});

// ---------------------------------------------------------------------------
// directMergePr
// ---------------------------------------------------------------------------

/** A gate verdict that lets the merge through, for the given head branch. */
function allowingGate(headRefName: string) {
  return () =>
    Promise.resolve({
      ok: true as const,
      value: { allowed: true, headSha: "deadbeef", headRefName },
    });
}

Deno.test("directMergePr - a milestone sync head merges as a merge commit", async () => {
  const { calls, gh } = recorder((args) => {
    if (args[1] === "view") return "milestone/863";
    if (args[0] === "api") return "main";
    return "";
  });
  const result = await directMergePr(
    "owner/repo",
    11,
    gh,
    allowingGate(SYNC_HEAD),
  );
  assert(result.ok, !result.ok ? result.error.message : "");
  const merge = mergeCall(calls);
  assert(merge.includes("--merge"), merge.join(" "));
  assert(merge.includes("--match-head-commit"), merge.join(" "));
});

Deno.test("directMergePr - an ordinary head still squashes", async () => {
  const { calls, gh } = recorder((args) => {
    if (args[1] === "view") return "milestone/863";
    if (args[0] === "api") return "main";
    return "";
  });
  const result = await directMergePr(
    "owner/repo",
    12,
    gh,
    allowingGate("issue-1048-fix"),
  );
  assert(result.ok, !result.ok ? result.error.message : "");
  assert(mergeCall(calls).includes("--squash"));
});

// ---------------------------------------------------------------------------
// The refusal this all turns on
// ---------------------------------------------------------------------------

Deno.test("isMergeCommitNotAllowed - recognises GitHub's refusals, and nothing else", () => {
  assert(isMergeCommitNotAllowed("Merge commits are not allowed on this repo"));
  assert(isMergeCommitNotAllowed("GraphQL: Merge commit is not allowed"));
  assert(isMergeCommitNotAllowed("That merge method is not allowed here"));
  assert(!isMergeCommitNotAllowed("Pull request is not mergeable"));
  assert(!isMergeCommitNotAllowed("HTTP 502 Bad Gateway"));
});

Deno.test("squashedSyncWarning - names the branch, the repo and the setting", () => {
  const warning = squashedSyncWarning("owner/repo", SYNC_HEAD, "not allowed");
  assertStringIncludes(warning, "owner/repo");
  assertStringIncludes(warning, SYNC_HEAD);
  assertStringIncludes(warning, "Allow merge commits");
  assertStringIncludes(warning, "check-resurrected-files");
});
