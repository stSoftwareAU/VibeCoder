/**
 * Every arming path picks its merge method from the PR's head branch
 * (Issue #1048).
 *
 * The claim the fix rests on is that no path can quietly squash a milestone
 * sync. That is a property of three call sites — `enableAutoMerge`,
 * `directMergePr` and `raiseMilestoneSyncPr` — so each is asserted here
 * against the `gh` argv it actually produced.
 *
 * A milestone-fix head whose head merges the default branch takes `--merge` on
 * `enableAutoMerge` and `directMergePr` too (Issue #3596; creation arming is
 * covered in `worker/deno/tests/milestone_fix_pr_test.ts`).
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

/**
 * A `gh` stub whose `pr view --json isCrossRepository` answers "same repo".
 *
 * Since Issue #1249 the merge-commit deviation needs that evidence, so a test
 * exercising a genuine fleet sync has to supply it.
 */
function sameRepoHead(args: string[]): string {
  return args.join(" ").includes("isCrossRepository") ? "false" : "";
}

Deno.test("enableAutoMerge - a milestone sync head arms --merge", async () => {
  const { calls, gh } = recorder(sameRepoHead);
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
    // A genuine fleet sync: the head lives in this repository (Issue #1249).
    return Promise.resolve(sameRepoHead(args));
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
// Milestone-fix heads (Issue #3596)
// ---------------------------------------------------------------------------

const FIX_HEAD = "milestone-fix/863/pr-40-takeover-abc";
const FIX_BASE = "milestone/863";

/**
 * A `gh` stub for a milestone-fix head (Issue #3596).
 *
 * It answers what `milestoneFixMergeMethod` reads — the default branch, the
 * merge base of the head with it, and the milestone branch's comparison with
 * that base (`status`) — plus the `isCrossRepository` and base reads the
 * arming paths make. `mergeRefusal` rejects only a `--merge` attempt, so a test
 * can tell a refused merge commit from a squash fallback; `compareError` fails
 * the merge-base read.
 */
function fixGh(
  status: string,
  options: {
    crossRepository?: boolean;
    mergeRefusal?: string;
    compareError?: Error;
    /** The PR's base as `pr view` reports it; defaults to the milestone. */
    base?: string;
  } = {},
) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.join(" ").includes("isCrossRepository")) {
      return Promise.resolve(options.crossRepository ? "true" : "false");
    }
    if (args[0] === "pr" && args[1] === "merge") {
      if (args.includes("--merge") && options.mergeRefusal) {
        return Promise.reject(new Error(options.mergeRefusal));
      }
      return Promise.resolve("");
    }
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(options.base ?? FIX_BASE);
    }
    if (args.includes(".default_branch")) return Promise.resolve("main");
    if (args.includes(".merge_base_commit.sha")) {
      return options.compareError
        ? Promise.reject(options.compareError)
        : Promise.resolve("a".repeat(40));
    }
    if (args.includes(".status")) return Promise.resolve(status);
    return Promise.resolve("");
  };
  return { calls, gh };
}

/** The merge method each `gh pr merge` call in a run named, in order. */
function mergeAttempts(calls: string[][]): string[] {
  return calls
    .filter((args) => args[0] === "pr" && args[1] === "merge")
    .flatMap((args) =>
      args.filter((arg) => arg === "--merge" || arg === "--squash")
    );
}

/** The `gh api` calls that read a comparison between two refs. */
function compareCalls(calls: string[][]): string[][] {
  return calls.filter((args) =>
    args[0] === "api" && args[1]?.includes("/compare/")
  );
}

type EnableAutoMergeOptions = Parameters<typeof enableAutoMerge>[0];

/** The options the sync tests above use, for a milestone-fix head. */
function fixArmOptions(
  prNumber: number,
  gh: (args: string[]) => Promise<string>,
  extra: Partial<EnableAutoMergeOptions> = {},
): EnableAutoMergeOptions {
  return {
    repo: "owner/repo",
    prNumber,
    headRefName: FIX_HEAD,
    baseRefName: FIX_BASE,
    isBaseProtectedFn: () => Promise.resolve(true),
    decideMilestoneBaseFn: () =>
      Promise.resolve({
        decision: "allow" as const,
        reason: "not-milestone-base" as const,
      }),
    ghCommandFn: gh,
    maxRetries: 0,
    ...extra,
  };
}

Deno.test("enableAutoMerge - a milestone-fix head that merges the default branch arms --merge (Issue #3596)", async () => {
  const { calls, gh } = fixGh("ahead");
  const result = await enableAutoMerge(fixArmOptions(40, gh));
  assertEquals(result.result, AutoMergeResult.Enabled);
  const merge = mergeCall(calls);
  assert(merge.includes("--merge"), merge.join(" "));
  assert(!merge.includes("--squash"), merge.join(" "));
});

Deno.test("enableAutoMerge - a milestone-fix head behind the default branch arms --squash (Issue #3596)", async () => {
  const { calls, gh } = fixGh("behind");
  const result = await enableAutoMerge(fixArmOptions(41, gh));
  assertEquals(result.result, AutoMergeResult.Enabled);
  assert(mergeCall(calls).includes("--squash"));
});

Deno.test("enableAutoMerge - a milestone-fix --merge the repo refuses is not armed, never squashed (Issue #3596)", async () => {
  const logged: string[] = [];
  const { calls, gh } = fixGh("ahead", {
    mergeRefusal: "Merge commits are not allowed on this repository",
  });
  const result = await enableAutoMerge(
    fixArmOptions(42, gh, {
      maxRetries: 2,
      log: (message: string) => logged.push(message),
    }),
  );
  assertEquals(result.result, AutoMergeResult.Failed);
  assertEquals(mergeAttempts(calls), ["--merge"]);
  assert(
    logged.some((line) => line.includes("NOT squashed")),
    `the refusal must be logged; logged: ${JSON.stringify(logged)}`,
  );
  assertStringIncludes(result.message, "Allow merge commits");
});

Deno.test("enableAutoMerge - a milestone-fix head whose method cannot be read is not armed (Issue #3596)", async () => {
  const { calls, gh } = fixGh("ahead", {
    compareError: new Error("HTTP 502"),
  });
  const result = await enableAutoMerge(fixArmOptions(43, gh));
  assertEquals(result.result, AutoMergeResult.Failed);
  assertStringIncludes(result.message, "HTTP 502");
  assertStringIncludes(result.message, "Issue #3596");
  assertEquals(mergeAttempts(calls), []);
});

Deno.test("enableAutoMerge - a fork milestone-fix head keeps --squash and reads no comparison (Issue #3596)", async () => {
  const { calls, gh } = fixGh("ahead", { crossRepository: true });
  const result = await enableAutoMerge(fixArmOptions(44, gh));
  assertEquals(result.result, AutoMergeResult.Enabled);
  assert(mergeCall(calls).includes("--squash"));
  assertEquals(compareCalls(calls), []);
});

// ---------------------------------------------------------------------------
// directMergePr
// ---------------------------------------------------------------------------

/**
 * A gate verdict that lets the merge through, for the given head branch.
 *
 * `headIsSameRepository` defaults to true — the sync branch the fleet pushed
 * into this repository. Since Issue #1249 the merge-commit deviation is
 * refused for a fork head, so a caller testing that path passes `false`.
 *
 * `baseRefName` is the PR's base; a milestone-fix head needs it to be a
 * milestone branch before its merge method is read (Issue #3596). Omitted, the
 * gate reports no base, as the existing callers expect.
 */
function allowingGate(
  headRefName: string,
  headIsSameRepository = true,
  baseRefName?: string,
) {
  return () =>
    Promise.resolve({
      ok: true as const,
      value: {
        allowed: true,
        headSha: "deadbeef",
        headRefName,
        headIsSameRepository,
        baseRefName,
      },
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

Deno.test("directMergePr - a milestone-fix head that merges the default branch merges as a merge commit, pinned to the gated head (Issue #3596)", async () => {
  const { calls, gh } = fixGh("ahead");
  const result = await directMergePr(
    "owner/repo",
    45,
    gh,
    allowingGate(FIX_HEAD, true, FIX_BASE),
  );
  assert(result.ok, !result.ok ? result.error.message : "");
  const merge = mergeCall(calls);
  assert(merge.includes("--merge"), merge.join(" "));
  assert(!merge.includes("--squash"), merge.join(" "));
  assert(merge.includes("--match-head-commit"), merge.join(" "));
  const mergeBaseRead = compareCalls(calls).find((args) =>
    args.includes(".merge_base_commit.sha")
  );
  assert(mergeBaseRead, "the merge base was never read");
  assert(
    mergeBaseRead[1]?.endsWith("...deadbeef"),
    `the merge base was read from the wrong path: ${mergeBaseRead[1]}`,
  );
});

Deno.test("directMergePr - a milestone-fix head that is behind the default branch squashes (Issue #3596)", async () => {
  const { calls, gh } = fixGh("behind");
  const result = await directMergePr(
    "owner/repo",
    46,
    gh,
    allowingGate(FIX_HEAD, true, FIX_BASE),
  );
  assert(result.ok, !result.ok ? result.error.message : "");
  assert(mergeCall(calls).includes("--squash"));
});

Deno.test("directMergePr - a milestone-fix --merge the repo refuses fails loudly and is never squashed (Issue #3596)", async () => {
  const { calls, gh } = fixGh("ahead", {
    mergeRefusal: "Merge commits are not allowed on this repository",
  });
  const result = await directMergePr(
    "owner/repo",
    47,
    gh,
    allowingGate(FIX_HEAD, true, FIX_BASE),
  );
  assert(!result.ok, "a refused merge commit must not report success");
  assertStringIncludes(result.error.message, "NOT squashed");
  assertEquals(mergeAttempts(calls), ["--merge"]);
});

Deno.test("directMergePr - a milestone-fix head whose method cannot be read is refused, not merged (Issue #3596)", async () => {
  const { calls, gh } = fixGh("ahead", {
    compareError: new Error("HTTP 502"),
  });
  const result = await directMergePr(
    "owner/repo",
    48,
    gh,
    allowingGate(FIX_HEAD, true, FIX_BASE),
  );
  assert(!result.ok, "an unreadable method must not merge");
  assertStringIncludes(result.error.message, "Issue #3596");
  assertEquals(mergeAttempts(calls), []);
});

Deno.test("directMergePr - a fork milestone-fix head keeps --squash and reads no comparison (Issue #3596)", async () => {
  const { calls, gh } = fixGh("ahead");
  const result = await directMergePr(
    "owner/repo",
    49,
    gh,
    allowingGate(FIX_HEAD, false, FIX_BASE),
  );
  assert(result.ok, !result.ok ? result.error.message : "");
  const merge = mergeCall(calls);
  assert(merge.includes("--squash"), merge.join(" "));
  assert(!merge.includes("--merge"), merge.join(" "));
  assertEquals(compareCalls(calls), []);
});

Deno.test("directMergePr - a same-repository milestone-fix head on a non-milestone base squashes and reads no comparison (Issue #3596)", async () => {
  const { calls, gh } = fixGh("ahead", { base: "release/x" });
  const result = await directMergePr(
    "owner/repo",
    50,
    gh,
    allowingGate(FIX_HEAD, true, "release/x"),
  );
  assert(result.ok, !result.ok ? result.error.message : "");
  const merge = mergeCall(calls);
  assert(merge.includes("--squash"), merge.join(" "));
  assert(!merge.includes("--merge"), merge.join(" "));
  assertEquals(compareCalls(calls), []);
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
