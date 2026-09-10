/**
 * Tests for pr_auto_merge.ts — PR auto-merge management (Issue #915).
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AutoMergeResult,
  classifyAutoMergeFailure,
  enableAutoMerge,
  isBaseProtected,
  isTransientError,
} from "../lib/pr_auto_merge.ts";
import { OPEN_CHILDREN_BLOCK_MARKER } from "../lib/milestone_children_gate.ts";

// --- classifyAutoMergeFailure ---

Deno.test("pr_auto_merge - classifyAutoMergeFailure detects NotAllowed", () => {
  assertEquals(
    classifyAutoMergeFailure("Auto-merge is not allowed for this pull request"),
    AutoMergeResult.NotAllowed,
  );
  assertEquals(
    classifyAutoMergeFailure("not supported for this PR"),
    AutoMergeResult.NotAllowed,
  );
});

Deno.test("pr_auto_merge - classifyAutoMergeFailure detects NotEnabledOnRepo", () => {
  assertEquals(
    classifyAutoMergeFailure("auto-merge is not enabled on this repository"),
    AutoMergeResult.NotEnabledOnRepo,
  );
  assertEquals(
    classifyAutoMergeFailure("Auto-merge is not enabled"),
    AutoMergeResult.NotEnabledOnRepo,
  );
});

Deno.test("pr_auto_merge - classifyAutoMergeFailure returns Failed for unknown errors", () => {
  assertEquals(
    classifyAutoMergeFailure("Something unexpected happened"),
    AutoMergeResult.Failed,
  );
});

Deno.test("pr_auto_merge - classifyAutoMergeFailure handles combined messages correctly", () => {
  // "not allowed" + "is not enabled" should be NotEnabledOnRepo
  assertEquals(
    classifyAutoMergeFailure("Auto-merge is not enabled. Not allowed."),
    AutoMergeResult.NotEnabledOnRepo,
  );
});

// --- isTransientError ---

Deno.test("pr_auto_merge - isTransientError detects HTTP 5xx", () => {
  assertEquals(isTransientError("HTTP 502 Bad Gateway"), true);
  assertEquals(isTransientError("HTTP 503 Service Unavailable"), true);
});

Deno.test("pr_auto_merge - isTransientError detects timeout", () => {
  assertEquals(isTransientError("Connection timed out"), true);
  assertEquals(isTransientError("Request timeout"), true);
});

Deno.test("pr_auto_merge - isTransientError detects rate limit", () => {
  assertEquals(isTransientError("HTTP 429 Too Many Requests"), true);
  assertEquals(isTransientError("rate limit exceeded"), true);
});

Deno.test("pr_auto_merge - isTransientError returns false for permanent errors", () => {
  assertEquals(isTransientError("Not found"), false);
  assertEquals(isTransientError("Unauthorized"), false);
});

// --- enableAutoMerge ---

Deno.test("pr_auto_merge - enableAutoMerge returns Skipped when disabled", async () => {
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1,
    skipAutoMerge: true,
    ghCommandFn: async () => "",
  });
  assertEquals(result.result, AutoMergeResult.Skipped);
});

Deno.test("pr_auto_merge - enableAutoMerge returns Enabled on success", async () => {
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1,
    ghCommandFn: async () => "Enabled auto-merge",
    // A protected base is where GitHub's --auto genuinely waits for checks
    // (Issue #4375); an unprotected one takes the gated direct merge.
    isBaseProtectedFn: async () => true,
  });
  assertEquals(result.result, AutoMergeResult.Enabled);
});

Deno.test("pr_auto_merge - enableAutoMerge returns NotEnabledOnRepo when not enabled", async () => {
  let commentPosted = false;
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1,
    ghCommandFn: async () => {
      throw new Error("auto-merge is not enabled on this repository");
    },
    commentFn: async () => {
      commentPosted = true;
    },
  });
  assertEquals(result.result, AutoMergeResult.NotEnabledOnRepo);
  assertEquals(commentPosted, true);
});

Deno.test("pr_auto_merge - enableAutoMerge returns NotAllowed for unprotected branch", async () => {
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1,
    ghCommandFn: async () => {
      throw new Error("Auto-merge is not allowed for this pull request");
    },
  });
  assertEquals(result.result, AutoMergeResult.NotAllowed);
});

Deno.test("pr_auto_merge - enableAutoMerge retries on transient errors", async () => {
  let attempts = 0;
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1,
    // Issue #4396: the milestone-base gate is exercised in its own tests; here
    // it is stubbed open so the scenario stays about what it was about.
    decideMilestoneBaseFn: async () => ({
      decision: "allow" as const,
      reason: "not-milestone-base" as const,
    }),
    maxRetries: 2,
    retryDelay: 0, // No delay for tests
    ghCommandFn: async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("HTTP 502 Bad Gateway");
      }
      return "Enabled";
    },
  });
  assertEquals(result.result, AutoMergeResult.Enabled);
  assertEquals(attempts, 3);
});

Deno.test("pr_auto_merge - enableAutoMerge returns Failed after max retries", async () => {
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1,
    maxRetries: 1,
    retryDelay: 0,
    ghCommandFn: async () => {
      throw new Error("HTTP 500 Internal Server Error");
    },
  });
  assertEquals(result.result, AutoMergeResult.Failed);
});

// ---------------------------------------------------------------------------
// Milestone open-children merge gate (Issue #3909)
// ---------------------------------------------------------------------------

/** Milestone whose branch name is `milestone/m1` (createMilestoneBranchName). */
const GATE_MILESTONE = { number: 53, title: "M1" };
const GATE_BRANCH = "milestone/m1";
const GATE_PR = 900;

interface GateStubState {
  /** Open children returned by the milestone issues query. */
  openChildren: { number: number; title: string }[];
  /** Comment bodies already on the summary PR. */
  comments: string[];
  /** `gh pr merge` invocations. */
  merges: number;
  /** Comment bodies posted during the run. */
  posted: string[];
}

/**
 * Build a `gh` stub that answers every call the gate and the merge make,
 * against an in-memory PR whose head is the milestone branch.
 */
function createGateStub(state: GateStubState) {
  return async (args: string[]): Promise<string> => {
    const key = args.join(" ");

    if (key.includes("pr view") && key.includes("headRefName")) {
      return JSON.stringify({ headRefName: GATE_BRANCH });
    }
    if (key.includes("/milestones?state=open")) {
      return JSON.stringify([GATE_MILESTONE]);
    }
    if (key.includes("/issues?milestone=")) {
      return JSON.stringify(state.openChildren);
    }
    if (key.includes("pr list") && key.includes("--base")) {
      return "[]";
    }
    if (key.includes("/comments?per_page=")) {
      // Issue #1249: the dedup read projects the commenter, and only a
      // fleet-authored marker suppresses a repeat comment.
      return JSON.stringify(
        state.comments.map((body) => ({ author: "vibe-bot", body })),
      );
    }
    if (key.includes("pr comment")) {
      const bodyIdx = args.indexOf("--body");
      const body = args[bodyIdx + 1] ?? "";
      state.posted.push(body);
      state.comments.push(body);
      return "";
    }
    if (key.includes("pr merge")) {
      state.merges++;
      return "";
    }
    return "[]";
  };
}

Deno.test("pr_auto_merge - blocks summary-PR auto-merge while milestone has open children", async () => {
  const state: GateStubState = {
    openChildren: [{ number: 3866, title: "Child still open" }],
    comments: [],
    merges: 0,
    posted: [],
  };
  const logs: string[] = [];

  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: GATE_PR,
    headRefName: GATE_BRANCH,
    ghCommandFn: createGateStub(state),
    isBaseProtectedFn: async () => true,
    log: (message) => logs.push(message),
  });

  assertEquals(result.result, AutoMergeResult.BlockedOpenChildren);
  // The irreversible step never ran.
  assertEquals(state.merges, 0);
  // Exactly one explanatory comment, carrying the idempotency marker.
  assertEquals(state.posted.length, 1);
  assertStringIncludes(state.posted[0]!, OPEN_CHILDREN_BLOCK_MARKER);
  assertStringIncludes(state.posted[0]!, "#3866");
  // Observable warning naming milestone, PR and blocking children.
  assertEquals(logs.length, 1);
  assertStringIncludes(logs[0]!, "owner/repo#900");
  assertStringIncludes(logs[0]!, "#53");
  assertStringIncludes(logs[0]!, "#3866");
});

Deno.test("pr_auto_merge - merges summary PR when open-children count is zero", async () => {
  const state: GateStubState = {
    openChildren: [],
    comments: [],
    merges: 0,
    posted: [],
  };

  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: GATE_PR,
    headRefName: GATE_BRANCH,
    ghCommandFn: createGateStub(state),
    isBaseProtectedFn: async () => true,
    log: () => {},
  });

  assertEquals(result.result, AutoMergeResult.Enabled);
  assertEquals(state.merges, 1);
  assertEquals(state.posted.length, 0);
});

Deno.test("pr_auto_merge - repeat scan cycle with children still open posts no duplicate comment", async () => {
  const state: GateStubState = {
    openChildren: [{ number: 3866, title: "Child still open" }],
    comments: [],
    merges: 0,
    posted: [],
  };
  const ghFn = createGateStub(state);

  for (let cycle = 0; cycle < 3; cycle++) {
    const result = await enableAutoMerge({
      repo: "owner/repo",
      prNumber: GATE_PR,
      headRefName: GATE_BRANCH,
      ghCommandFn: ghFn,
      log: () => {},
      authorOptions: { fleetAuthors: ["vibe-bot"] },
    });
    assertEquals(result.result, AutoMergeResult.BlockedOpenChildren);
  }

  assertEquals(state.merges, 0);
  assertEquals(state.posted.length, 1);
});

Deno.test("pr_auto_merge - resolves the head branch itself when the caller omits it", async () => {
  const state: GateStubState = {
    openChildren: [{ number: 3866, title: "Child still open" }],
    comments: [],
    merges: 0,
    posted: [],
  };

  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: GATE_PR,
    ghCommandFn: createGateStub(state),
    log: () => {},
  });

  assertEquals(result.result, AutoMergeResult.BlockedOpenChildren);
  assertEquals(state.merges, 0);
});

Deno.test("pr_auto_merge - blocks the merge when the open-children count cannot be read", async () => {
  const state: GateStubState = {
    openChildren: [],
    comments: [],
    merges: 0,
    posted: [],
  };
  const base = createGateStub(state);
  const ghFn = async (args: string[]): Promise<string> => {
    if (args.join(" ").includes("/issues?milestone=")) {
      throw new Error("HTTP 502 Bad Gateway");
    }
    return await base(args);
  };
  const logs: string[] = [];

  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: GATE_PR,
    headRefName: GATE_BRANCH,
    ghCommandFn: ghFn,
    log: (message) => logs.push(message),
  });

  assertEquals(result.result, AutoMergeResult.BlockedOpenChildren);
  assertEquals(state.merges, 0);
  // Unverifiable state is loud, but must not spam the PR thread.
  assertEquals(state.posted.length, 0);
  assertStringIncludes(logs[0]!, "could not be read");
});

Deno.test("pr_auto_merge - an ordinary fix PR is unaffected by the milestone gate", async () => {
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 42,
    headRefName: "issue-3909-block-auto-merge",
    baseRefName: "main",
    isBaseProtectedFn: async () => true,
    ghCommandFn: async (args: string[]) => {
      calls.push(args);
      return "";
    },
  });

  assertEquals(result.result, AutoMergeResult.Enabled);
  // Exactly one gh call — the merge. The gate costs nothing here.
  assertEquals(calls.length, 1);
  assertEquals(calls[0]![1], "merge");
});

// ---------------------------------------------------------------------------
// Issue #4375: an unprotected base never gets a blind `--auto`
// ---------------------------------------------------------------------------

Deno.test("pr_auto_merge - unprotected base: the PR is routed through the gated direct merge and DEFERRED while checks run; `--auto` is never issued (Issue #4375)", async () => {
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 4363,
    // Issue #4396: the milestone-base gate is exercised in its own tests; here
    // it is stubbed open so the scenario stays about what it was about.
    decideMilestoneBaseFn: async () => ({
      decision: "allow" as const,
      reason: "not-milestone-base" as const,
    }),
    baseRefName: "milestone/4290-x",
    isBaseProtectedFn: async () => false,
    ghCommandFn: async (args) => {
      calls.push(args);
      return "";
    },
    directMergeFn: async () => ({
      ok: true,
      value: { merged: false, blocked: "checks_pending" },
    }),
  });
  assertEquals(result.result, AutoMergeResult.Deferred);
  assertEquals(result.message.includes("checks_pending"), true, result.message);
  assertEquals(
    calls.some((a) => a.includes("--auto")),
    false,
    "GitHub's --auto merges immediately on an unprotected base and must not be used",
  );
});

Deno.test("pr_auto_merge - unprotected base: when the gate is green the PR merges directly (SHA-pinned) (Issue #4375)", async () => {
  let directCalls = 0;
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 7,
    // Issue #4396: the milestone-base gate is exercised in its own tests; here
    // it is stubbed open so the scenario stays about what it was about.
    decideMilestoneBaseFn: async () => ({
      decision: "allow" as const,
      reason: "not-milestone-base" as const,
    }),
    baseRefName: "milestone/x",
    isBaseProtectedFn: async () => false,
    ghCommandFn: async () => "",
    directMergeFn: async () => {
      directCalls++;
      return { ok: true, value: { merged: true } };
    },
  });
  assertEquals(result.result, AutoMergeResult.MergedDirectly);
  assertEquals(directCalls, 1);
});

Deno.test("pr_auto_merge - unknown base protection (lookup failed) is treated as unprotected: gated path, no `--auto` (Issue #4375)", async () => {
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 8,
    baseRefName: "some-branch",
    isBaseProtectedFn: async () => null,
    ghCommandFn: async (args) => {
      calls.push(args);
      return "";
    },
    directMergeFn: async () => ({
      ok: true,
      value: { merged: false, blocked: "head_too_recent" },
    }),
  });
  assertEquals(result.result, AutoMergeResult.Deferred);
  assertEquals(calls.some((a) => a.includes("--auto")), false);
});

Deno.test("pr_auto_merge - isBaseProtected reads the effective branch rules: required_status_checks → protected; none → not; lookup error → null (Issue #4375)", async () => {
  assertEquals(
    await isBaseProtected(
      "o/r",
      "Develop",
      async () => "pull_request,required_status_checks,deletion",
    ),
    true,
  );
  assertEquals(
    await isBaseProtected("o/r", "milestone/x", async () => ""),
    false,
  );
  assertEquals(
    await isBaseProtected("o/r", "milestone/x", async () => {
      throw new Error("HTTP 404");
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Issue #4396: a PR bound for a rolled-up milestone branch is retargeted at
// the default branch, never merged into the orphan branch
// ---------------------------------------------------------------------------

Deno.test("pr_auto_merge - a base whose rollup already merged: comment once, retarget at the default branch, no merge (Issue #4396)", async () => {
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 3371,
    baseRefName: "milestone/clean-up",
    isBaseProtectedFn: async () => false,
    directMergeFn: async () => {
      throw new Error("must not merge into the orphan branch");
    },
    getDefaultBranchFn: async () => ({ ok: true, value: "Develop" }),
    decideMilestoneBaseFn: async () => ({
      decision: "block",
      reason: "rollup-merged",
      milestoneBranch: "milestone/clean-up",
      rollupPrNumber: 3125,
      detail:
        "rollup PR #3125 (milestone/clean-up → Develop) merged at 2026-06-30T02:27:52Z",
    }),
    ghCommandFn: async (args) => {
      calls.push(args);
      if (args[0] === "api" && args.join(" ").includes("/comments")) return "";
      return "";
    },
    authorOptions: { fleetAuthors: ["vibe-bot"] },
  });
  assertEquals(result.result, AutoMergeResult.RetargetedToDefault);
  assert(result.message.includes("#3125"), result.message);
  const comment = calls.find((c) => c[0] === "pr" && c[1] === "comment");
  assert(comment, "an explanatory comment is posted");
  assert(comment.join(" ").includes("rollup PR #3125"));
  const edit = calls.find((c) => c[0] === "pr" && c[1] === "edit");
  assertEquals(edit?.slice(-2), ["--base", "Develop"]);
  assert(
    !calls.some((c) => c[0] === "pr" && c[1] === "merge"),
    "no --auto merge issued",
  );
});

Deno.test("pr_auto_merge - the retarget comment is posted once (marker de-dup) (Issue #4396)", async () => {
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 3371,
    baseRefName: "milestone/clean-up",
    getDefaultBranchFn: async () => ({ ok: true, value: "Develop" }),
    decideMilestoneBaseFn: async () => ({
      decision: "block",
      reason: "milestone-closed",
      milestoneBranch: "milestone/clean-up",
      milestoneNumber: 7,
      detail: 'milestone #7 "Clean up" is closed',
    }),
    ghCommandFn: async (args) => {
      calls.push(args);
      if (args[0] === "api" && args.join(" ").includes("/comments")) {
        // Issue #1249: fleet-authored, so the marker genuinely de-duplicates.
        return JSON.stringify([
          { author: "vibe-bot", body: "earlier" },
          {
            author: "vibe-bot",
            body: "<!-- milestone-rollup-merged-retarget -->\nalready said",
          },
        ]);
      }
      return "";
    },
    authorOptions: { fleetAuthors: ["vibe-bot"] },
  });
  assertEquals(result.result, AutoMergeResult.RetargetedToDefault);
  assert(
    !calls.some((c) => c[0] === "pr" && c[1] === "comment"),
    "no second comment",
  );
  assert(
    calls.some((c) => c[0] === "pr" && c[1] === "edit"),
    "still retargeted",
  );
});

// ---------------------------------------------------------------------------
// Issue #1779: a child never merges into a milestone branch that is behind
// the default branch
// ---------------------------------------------------------------------------

import { _resetMilestoneBehindMemo } from "../lib/milestone_children_gate.ts";
import { logAutoMergeOutcome } from "../lib/pr_auto_merge.ts";
import type { LogContext, Logger } from "../types.ts";

/** gh stub for a healthy, open milestone whose branch is `behindBy` behind. */
function ghForBehindMilestone(
  behindBy: number,
  calls: string[][],
): (args: string[]) => Promise<string> {
  return async (args: string[]): Promise<string> => {
    calls.push(args);
    const key = args.join(" ");
    if (key.includes("/compare/")) return `${behindBy}\n`;
    if (key.includes("pr list") && key.includes("--head")) return "[]";
    if (key.includes("/milestones?state=all")) {
      return JSON.stringify([{ number: 9, title: "Sync", state: "open" }]);
    }
    return "";
  };
}

Deno.test("pr_auto_merge - a milestone base behind the default branch is DEFERRED: no `--auto`, no direct merge, no comment (Issue #1779)", async () => {
  _resetMilestoneBehindMemo();
  const calls: string[][] = [];
  let directMerges = 0;
  let comments = 0;
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1779,
    headRefName: "issue-1779-child",
    baseRefName: "milestone/1730-sync",
    getDefaultBranchFn: () =>
      Promise.resolve({ ok: true as const, value: "Develop" }),
    ghCommandFn: ghForBehindMilestone(3, calls),
    commentFn: async () => {
      comments++;
    },
    directMergeFn: async () => {
      directMerges++;
      return { ok: true as const, value: { merged: true } };
    },
  });

  assertEquals(result.result, AutoMergeResult.Deferred);
  assertStringIncludes(result.message, "milestone behind default branch");
  assertStringIncludes(result.message, "(3 commits)");
  assertEquals(directMerges, 0, "a behind milestone base must not be merged");
  assertEquals(comments, 0, "the deferral is silent on the PR");
  assertEquals(
    calls.some((a) => a[0] === "pr" && a[1] === "merge"),
    false,
    "`gh pr merge` must not run for a behind milestone base",
  );
  assertEquals(
    calls.some((a) => a.includes("--auto")),
    false,
    "GitHub auto-merge must not be armed for a behind milestone base",
  );
  assertEquals(
    calls.some((a) => a.includes("--add-label")),
    false,
    "the deferral applies no label",
  );
});

Deno.test("pr_auto_merge - a milestone base level with the default branch still arms auto-merge (Issue #1779)", async () => {
  _resetMilestoneBehindMemo();
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1780,
    headRefName: "issue-1780-child",
    baseRefName: "milestone/1730-sync",
    getDefaultBranchFn: () =>
      Promise.resolve({ ok: true as const, value: "Develop" }),
    isBaseProtectedFn: async () => true,
    ghCommandFn: ghForBehindMilestone(0, calls),
  });

  assertEquals(result.result, AutoMergeResult.Enabled);
  assertEquals(
    calls.some((a) => a.includes("--auto")),
    true,
    "a synced milestone base is armed exactly as before",
  );
});

Deno.test("pr_auto_merge - the behind deferral is recorded by logAutoMergeOutcome (Issue #1779)", async () => {
  _resetMilestoneBehindMemo();
  const lines: Array<{ level: string; message: string }> = [];
  const unused = () => {};
  const logger = {
    info: (message: string, _c?: LogContext) =>
      void lines.push({ level: "info", message }),
    warn: (message: string, _c?: LogContext) =>
      void lines.push({ level: "warn", message }),
    error: unused,
    debug: unused,
    security: unused,
    skipReason: unused,
    timing: unused,
    scanSummary: unused,
    workerSummary: unused,
  } as unknown as Logger;

  const outcome = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1781,
    headRefName: "issue-1781-child",
    baseRefName: "milestone/1730-sync",
    getDefaultBranchFn: () =>
      Promise.resolve({ ok: true as const, value: "Develop" }),
    ghCommandFn: ghForBehindMilestone(2, []),
  });
  logAutoMergeOutcome(logger, "owner/repo", 1781, outcome);

  assertEquals(lines.length, 1);
  assertStringIncludes(
    lines[0]!.message,
    "deferred: milestone behind default branch (2 commits)",
  );
});

Deno.test("pr_auto_merge - two children of one behind milestone cost ONE compare call (Issue #1779)", async () => {
  _resetMilestoneBehindMemo();
  const calls: string[][] = [];
  const gh = ghForBehindMilestone(5, calls);
  for (const prNumber of [1, 2]) {
    const result = await enableAutoMerge({
      repo: "owner/repo",
      prNumber,
      headRefName: `issue-${prNumber}-child`,
      baseRefName: "milestone/1730-sync",
      getDefaultBranchFn: () =>
        Promise.resolve({ ok: true as const, value: "Develop" }),
      ghCommandFn: gh,
    });
    assertEquals(result.result, AutoMergeResult.Deferred);
  }
  assertEquals(
    calls.filter((a) => a.join(" ").includes("/compare/")).length,
    1,
    "the milestone compare is memoised across the sweep",
  );
});

Deno.test("pr_auto_merge - a default-branch base makes no milestone compare call (Issue #1779)", async () => {
  _resetMilestoneBehindMemo();
  const calls: string[][] = [];
  await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 3,
    headRefName: "issue-3-child",
    baseRefName: "Develop",
    isBaseProtectedFn: async () => true,
    ghCommandFn: ghForBehindMilestone(9, calls),
  });
  assertEquals(
    calls.some((a) => a.join(" ").includes("/compare/")),
    false,
    "a non-milestone base costs no extra call",
  );
});

Deno.test("pr_auto_merge - the gate seam still governs: an injected behind decision defers without any gh call (Issue #1779)", async () => {
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 4,
    headRefName: "issue-4-child",
    baseRefName: "milestone/1730-sync",
    decideMilestoneBaseFn: () =>
      Promise.resolve({
        decision: "defer" as const,
        reason: "milestone-behind" as const,
        milestoneBranch: "milestone/1730-sync",
        behindBy: 1,
        detail: "milestone/1730-sync is 1 commit behind Develop",
      }),
    ghCommandFn: async (args: string[]) => {
      calls.push(args);
      return "";
    },
  });
  assertEquals(result.result, AutoMergeResult.Deferred);
  assertStringIncludes(result.message, "(1 commit)");
  assertEquals(calls.length, 0);
});

Deno.test("pr_auto_merge - the milestone sync PR is still armed while its base is behind (Issue #1779)", async () => {
  _resetMilestoneBehindMemo();
  const calls: string[][] = [];
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1782,
    headRefName: "sync/milestone-1730-sync",
    baseRefName: "milestone/1730-sync",
    getDefaultBranchFn: () =>
      Promise.resolve({ ok: true as const, value: "Develop" }),
    isBaseProtectedFn: async () => true,
    ghCommandFn: ghForBehindMilestone(6, calls),
  });

  assertEquals(
    result.result,
    AutoMergeResult.Enabled,
    "deferring the sync PR for being behind would deadlock the milestone",
  );
  assertEquals(calls.some((a) => a.includes("--auto")), true);
});

Deno.test("pr_auto_merge - a behind deferral names itself so callers do not escalate it (Issue #1779)", async () => {
  _resetMilestoneBehindMemo();
  const result = await enableAutoMerge({
    repo: "owner/repo",
    prNumber: 1783,
    headRefName: "issue-1783-child",
    baseRefName: "milestone/1730-sync",
    getDefaultBranchFn: () =>
      Promise.resolve({ ok: true as const, value: "Develop" }),
    ghCommandFn: ghForBehindMilestone(3, []),
  });
  assertEquals(result.result, AutoMergeResult.Deferred);
  assertEquals(result.deferral, "milestone-behind");
});
