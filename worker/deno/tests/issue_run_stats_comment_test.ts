/**
 * Tests for issue_run_stats_comment.ts — one cost/model stats comment per
 * issue, posted at wrap-up on every worker-handled path (Issue #3756).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIssueRunStatsComment,
  ghIssueCommentLister,
  hasIssueRunStatsComment,
  ISSUE_RUN_STATS_DISCLAIMER,
  ISSUE_RUN_STATS_MARKER,
  postIssueRunStatsComment,
} from "../lib/issue_run_stats_comment.ts";
import type { PhaseClaudeResult } from "../lib/phase_run_stats.ts";
import type { RunStats } from "../lib/run_stats.ts";
import type { Logger } from "../types.ts";
import {
  type PhaseState,
  recordClaudeRunStats,
} from "../lib/issue_worker_types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

function claudeResult(
  served: string[],
  extra?: Partial<RunStats>,
): PhaseClaudeResult {
  return {
    runStats: {
      servedModels: served,
      requestedModel: "opus",
      wallClockMs: 2_000,
      tokenUsage: {
        inputTokens: 1_000,
        outputTokens: 2_000,
        cacheCreationTokens: 100,
        cacheReadTokens: 50,
      },
      ...extra,
    },
  };
}

/** Minimal in-memory GitHub double recording posted comment bodies. */
function makeGitHubDouble(existing: string[] = []) {
  const posted: string[] = [];
  return {
    posted,
    getIssueComments: () => Promise.resolve(existing.map((body) => ({ body }))),
    postComment: (_r: string, _i: number, body: string) => {
      posted.push(body);
      return Promise.resolve();
    },
  };
}

// ============================================================================
// buildIssueRunStatsComment
// ============================================================================

Deno.test("buildIssueRunStatsComment - renders the shared stats format", () => {
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
  });

  assertStringIncludes(body, "run model stats");
  assertStringIncludes(body, "**Served model(s):** `claude-opus-4-8`");
  assertStringIncludes(body, "**Tokens:**");
  assertStringIncludes(body, "Estimated cost (USD, estimate only)");
});

Deno.test("buildIssueRunStatsComment - carries marker and disclaimer", () => {
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
  });

  assertStringIncludes(body, ISSUE_RUN_STATS_MARKER);
  assertStringIncludes(body, ISSUE_RUN_STATS_DISCLAIMER);
  assertStringIncludes(body, "not included");
});

Deno.test("buildIssueRunStatsComment - heading names the phase", () => {
  const body = buildIssueRunStatsComment({
    phase: "grill_me",
    claudeResults: [claudeResult(["claude-fable-5"])],
  });

  assertStringIncludes(body, "## Grill-me run model stats");
});

Deno.test("buildIssueRunStatsComment - aggregates multiple invocations", () => {
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [
      claudeResult(["claude-opus-4-8"]),
      claudeResult(["claude-opus-4-8"]),
    ],
  });

  assertStringIncludes(body, "**Issue invocations:** 2");
  // Tokens are summed across both invocations (2 × 1,000 input).
  assertStringIncludes(body, "input 2,000");
});

Deno.test("buildIssueRunStatsComment - empty when no invocation produced stats", () => {
  assertEquals(
    buildIssueRunStatsComment({ phase: "issue", claudeResults: [] }),
    "",
  );
  assertEquals(
    buildIssueRunStatsComment({ phase: "issue", claudeResults: [{}] }),
    "",
  );
});

Deno.test("buildIssueRunStatsComment - surfaces a degraded run", () => {
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [{
      ...claudeResult(["claude-haiku-4-5"]),
      fallbackModel: "claude-haiku-4-5",
    }],
  });

  assertStringIncludes(body, "**Degraded:** ⚠️ yes");
});

// ============================================================================
// hasIssueRunStatsComment
// ============================================================================

Deno.test("hasIssueRunStatsComment - detects the hidden marker", () => {
  assertEquals(
    hasIssueRunStatsComment([`${ISSUE_RUN_STATS_MARKER}\nanything`]),
    true,
  );
});

Deno.test("hasIssueRunStatsComment - detects the legacy planning comment", () => {
  // The pre-#3756 planning comment carries no marker, only the heading.
  assertEquals(
    hasIssueRunStatsComment([
      "## Planning run model stats\n\n- **Requested model:** `fable`",
    ]),
    true,
  );
});

Deno.test("hasIssueRunStatsComment - false for unrelated comments", () => {
  assertEquals(hasIssueRunStatsComment([]), false);
  assertEquals(
    hasIssueRunStatsComment([
      "## Summary\n\nRaised PR #12.",
      "Talking about run model stats in prose is not a heading.",
    ]),
    false,
  );
});

// ============================================================================
// postIssueRunStatsComment
// ============================================================================

Deno.test("postIssueRunStatsComment - posts once when the issue has none", async () => {
  const gh = makeGitHubDouble([]);
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 42,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
  });

  assertEquals(result.posted, true);
  assertEquals(gh.posted.length, 1);
  assertStringIncludes(gh.posted[0]!, ISSUE_RUN_STATS_MARKER);
});

Deno.test("postIssueRunStatsComment - skips when a stats comment already exists", async () => {
  const gh = makeGitHubDouble([
    `${ISSUE_RUN_STATS_MARKER}\n## Issue run model stats`,
  ]);
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 42,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
  });

  assertEquals(result.posted, false);
  assertEquals(result.reason, "already_posted");
  assertEquals(gh.posted.length, 0);
});

Deno.test("postIssueRunStatsComment - skips when the planning path already posted", async () => {
  const gh = makeGitHubDouble([
    "## Planning run model stats\n\n- **Degraded:** no",
  ]);
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 7,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
  });

  assertEquals(result.posted, false);
  assertEquals(result.reason, "already_posted");
  assertEquals(gh.posted.length, 0);
});

Deno.test("postIssueRunStatsComment - posts nothing when there are no stats", async () => {
  const gh = makeGitHubDouble([]);
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 42,
    phase: "issue",
    claudeResults: [],
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
  });

  assertEquals(result.posted, false);
  assertEquals(result.reason, "no_stats");
  assertEquals(gh.posted.length, 0);
});

// ============================================================================
// ghIssueCommentLister
// ============================================================================

Deno.test("ghIssueCommentLister - reads bodies from gh issue view", async () => {
  let seen: string[] = [];
  const list = ghIssueCommentLister((args) => {
    seen = args;
    return Promise.resolve(
      JSON.stringify({ comments: [{ body: "one" }, { body: "two" }] }),
    );
  });

  assertEquals(await list("org/repo", 5), [{ body: "one" }, { body: "two" }]);
  assertEquals(seen, [
    "issue",
    "view",
    "5",
    "--repo",
    "org/repo",
    "--json",
    "comments",
  ]);
});

Deno.test("ghIssueCommentLister - throws rather than reporting an empty thread", async () => {
  // Fail loud (Issue #3234): a failed lookup must not read as "no comments",
  // which would let a duplicate stats comment through.
  const onGarbage = ghIssueCommentLister(() => Promise.resolve("not json"));
  let threw = false;
  try {
    await onGarbage("org/repo", 5);
  } catch {
    threw = true;
  }
  assert(threw, "malformed gh output must throw");

  const onMissingKey = ghIssueCommentLister(() => Promise.resolve("{}"));
  threw = false;
  try {
    await onMissingKey("org/repo", 5);
  } catch {
    threw = true;
  }
  assert(threw, "a response with no `comments` array must throw");
});

Deno.test("ghIssueCommentLister - backs the duplicate guard end to end", async () => {
  const posted: string[] = [];
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 5,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: ghIssueCommentLister(() =>
      Promise.resolve(
        JSON.stringify({
          comments: [{ body: `${ISSUE_RUN_STATS_MARKER}\nold` }],
        }),
      )
    ),
    postComment: (_r, _i, b) => {
      posted.push(b);
      return Promise.resolve();
    },
    logger: makeLogger(),
  });

  assertEquals(result.reason, "already_posted");
  assertEquals(posted.length, 0);
});

Deno.test("postIssueRunStatsComment - reports a GitHub failure without throwing", async () => {
  const warnings: string[] = [];
  const logger = { ...makeLogger(), warn: (m: string) => warnings.push(m) };

  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 42,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: () => Promise.resolve([]),
    postComment: () => Promise.reject(new Error("gh exploded")),
    logger,
  });

  assertEquals(result.posted, false);
  assertEquals(result.reason, "error");
  assert(warnings.some((w) => w.includes("Failed to post issue run stats")));
});

// ============================================================================
// recordClaudeRunStats — execute-phase capture for the work-on path
// ============================================================================

Deno.test("recordClaudeRunStats - accumulates invocations across retries", () => {
  const state = {
    branchName: "",
    baseBranch: "",
    defaultBranch: "",
    repoPath: "",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  } as PhaseState;

  recordClaudeRunStats(state, claudeResult(["claude-opus-4-8"]));
  recordClaudeRunStats(state, claudeResult(["claude-haiku-4-5"]));

  assertEquals(state.claudeRunStats?.length, 2);
  assertEquals(state.claudeRunStats?.[1]?.runStats?.servedModels, [
    "claude-haiku-4-5",
  ]);
});

Deno.test("recordClaudeRunStats - keeps degradation signals, drops absent fields", () => {
  const state = { claudeRunStats: [] } as unknown as PhaseState;

  recordClaudeRunStats(state, {
    ...claudeResult(["claude-haiku-4-5"]),
    fallbackModel: "claude-haiku-4-5",
    preflightDegraded: true,
    preflightDegradedReason: "fable unavailable",
  });

  const entry = state.claudeRunStats![0]!;
  assertEquals(entry.fallbackModel, "claude-haiku-4-5");
  assertEquals(entry.preflightDegraded, true);
  assertEquals(entry.preflightDegradedReason, "fable unavailable");

  recordClaudeRunStats(state, {});
  assertEquals(Object.keys(state.claudeRunStats![1]!).length, 0);
});
