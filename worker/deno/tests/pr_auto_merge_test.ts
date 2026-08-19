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
      return state.comments.join("\n");
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
        return "earlier\n<!-- milestone-rollup-merged-retarget -->\nalready said";
      }
      return "";
    },
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
