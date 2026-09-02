/**
 * Tests for issue_run_stats_comment.ts — one cost/model stats comment per run,
 * posted at wrap-up on every worker-handled path (Issues #3756, #797).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIssueCostTotalLine,
  buildIssueRunStatsComment,
  buildIssueRunStatsMarker,
  ghIssueCommentLister,
  hasIssueRunStatsComment,
  hasRunStatsCommentForRun,
  ISSUE_RUN_STATS_DISCLAIMER,
  ISSUE_RUN_STATS_MARKER,
  postIssueRunStatsComment,
  sanitiseStatsRunId,
  tallyIssueCost,
} from "../lib/issue_run_stats_comment.ts";
import { formatUsd } from "../lib/cost_estimate.ts";
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
    runId: "vibe-abc-123456",
  });

  assertStringIncludes(body, ISSUE_RUN_STATS_MARKER);
  assertStringIncludes(body, buildIssueRunStatsMarker("vibe-abc-123456"));
  assertStringIncludes(body, ISSUE_RUN_STATS_DISCLAIMER);
  assertStringIncludes(body, "not included");
});

Deno.test("buildIssueRunStatsComment - marker is run-scoped (Issue #797)", () => {
  const first = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-run-one",
  });
  const second = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-run-two",
  });

  assertStringIncludes(first, 'run="vibe-run-one"');
  assertStringIncludes(second, 'run="vibe-run-two"');
  assertEquals(hasRunStatsCommentForRun([first], "vibe-run-two"), false);
  assertEquals(hasRunStatsCommentForRun([first], "vibe-run-one"), true);
});

Deno.test("buildIssueRunStatsComment - adds the cumulative issue total from the second comment on", () => {
  const earlier = buildIssueRunStatsComment({
    phase: "grill_me",
    claudeResults: [claudeResult(["claude-fable-5"])],
    runId: "vibe-run-one",
  });
  // The first comment on an issue carries no total — its own figure is it.
  assertEquals(earlier.includes("Issue total across"), false);

  const later = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-run-two",
    priorComments: [earlier],
  });

  // The rendered total is this run plus the earlier one, not just this run.
  const expected = tallyIssueCost([earlier]).total +
    tallyIssueCost([later]).total;
  assertStringIncludes(
    later,
    `**Issue total across 2 run-stats comments:** ~${formatUsd(expected)}`,
  );

  // A third run tallies both prior comments without double-counting the
  // cumulative line the second one carries.
  const third = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-run-three",
    priorComments: [earlier, later],
  });
  assertStringIncludes(
    third,
    "**Issue total across 3 run-stats comments:** ~$",
  );
  assertEquals(
    tallyIssueCost([earlier, later, third]).total,
    expected + tallyIssueCost([third]).total,
  );
});

Deno.test("sanitiseStatsRunId - a run id can never break out of the marker", () => {
  const marker = buildIssueRunStatsMarker('evil" --><script>x</script>');
  assertEquals(
    marker,
    '<!-- vibe-issue-run-stats run="evil----script-x-script-" -->',
  );
  // Neither the attribute quote nor the comment terminator survives.
  assertEquals(marker.split('"').length, 3);
  assertEquals(marker.indexOf("-->"), marker.length - 3);
  assertEquals(sanitiseStatsRunId("   "), "unknown");
  assertEquals(
    sanitiseStatsRunId("vibe-lkz3p9x-1a2b3c"),
    "vibe-lkz3p9x-1a2b3c",
  );
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
    hasIssueRunStatsComment([
      `${buildIssueRunStatsMarker("vibe-run-one")}\nanything`,
    ]),
    true,
  );
});

// ============================================================================
// tallyIssueCost / buildIssueCostTotalLine
// ============================================================================

Deno.test("tallyIssueCost - sums the run totals across stats comments", () => {
  const tally = tallyIssueCost([
    "## Grill-me run model stats\n- **Estimated cost (USD, estimate only):** ~$1.34",
    "## Issue run model stats\n- **Estimated cost (USD, estimate only):** ~$12.50",
  ]);

  assertEquals(tally.runs, 2);
  assertEquals(tally.total, 13.84);
  assertEquals(tally.partial, false);
  assertStringIncludes(
    buildIssueCostTotalLine(tally),
    "**Issue total across 2 run-stats comments:** ~$13.84",
  );
});

Deno.test("tallyIssueCost - ignores comments that are not run stats", () => {
  const tally = tallyIssueCost([
    "Quoting a cost line in prose: - **Estimated cost (USD, estimate only):** ~$99.00",
    "## Issue run model stats\n- **Estimated cost (USD, estimate only):** ~$2.00",
  ]);

  assertEquals(tally.runs, 1);
  assertEquals(tally.total, 2);
  assertEquals(buildIssueCostTotalLine(tally), "");
});

Deno.test("tallyIssueCost - an unpriced or partial run makes the total partial, never silently low", () => {
  const unpriced = tallyIssueCost([
    "## Issue run model stats\n- **Tokens:** input 10",
    "## Issue run model stats\n- **Estimated cost (USD, estimate only):** ~$2.00",
  ]);
  assertEquals(unpriced.partial, true);
  assertEquals(unpriced.total, 2);
  assertStringIncludes(buildIssueCostTotalLine(unpriced), "(partial");

  const partial = tallyIssueCost([
    "## Issue run model stats\n- **Estimated cost (USD, estimate only):** ~$1.00 (partial — see below)",
    "## Issue run model stats\n- **Estimated cost (USD, estimate only):** ~$2.00",
  ]);
  assertEquals(partial.partial, true);
  assertEquals(partial.total, 3);
});

Deno.test("tallyIssueCost - parses thousands separators", () => {
  const tally = tallyIssueCost([
    "## Issue run model stats\n- **Estimated cost (USD, estimate only):** ~$1,234.56",
  ]);
  assertEquals(tally.total, 1234.56);
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
    runId: "vibe-run-one",
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
  });

  assertEquals(result.posted, true);
  assertEquals(gh.posted.length, 1);
  assertStringIncludes(gh.posted[0]!, buildIssueRunStatsMarker("vibe-run-one"));
});

Deno.test("postIssueRunStatsComment - skips when this run already posted", async () => {
  // Business-logic change (Issue #797): the guard is run-scoped, so what it
  // suppresses is a *repeat* post inside one run, not the next run's costs.
  const gh = makeGitHubDouble([
    `${buildIssueRunStatsMarker("vibe-run-one")}\n## Issue run model stats`,
  ]);
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 42,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-run-one",
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
  });

  assertEquals(result.posted, false);
  assertEquals(result.reason, "already_posted");
  assertEquals(gh.posted.length, 0);
});

Deno.test("postIssueRunStatsComment - an earlier run's comment no longer hides this run's cost (Issue #797)", async () => {
  // Reproduces issue #762: a cheap grill-me round posted first and, under the
  // old issue-scoped guard, the work-on run that completed the issue reported
  // nothing at all.
  const grillMe = buildIssueRunStatsComment({
    phase: "grill_me",
    claudeResults: [claudeResult(["claude-fable-5"])],
    runId: "vibe-run-one",
  });
  const gh = makeGitHubDouble([grillMe]);

  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 762,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-run-two",
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
  });

  assertEquals(result.posted, true);
  assertEquals(gh.posted.length, 1);
  assertStringIncludes(gh.posted[0]!, "## Issue run model stats");
  assertStringIncludes(gh.posted[0]!, "Estimated cost (USD, estimate only)");
  assertStringIncludes(gh.posted[0]!, "**Issue total across 2 run-stats");
});

Deno.test("postIssueRunStatsComment - a legacy planning stats comment does not suppress this run", async () => {
  // The pre-#3756 planning comment carries no run marker, so it counts toward
  // the issue total but never blocks a later run's own figures (Issue #797).
  const gh = makeGitHubDouble([
    "## Planning run model stats\n\n- **Estimated cost (USD, estimate only):** ~$0.50\n- **Degraded:** no",
  ]);
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 7,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-run-two",
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
  });

  assertEquals(result.posted, true);
  assertStringIncludes(gh.posted[0]!, "**Issue total across 2 run-stats");
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
    runId: "vibe-run-one",
    getIssueComments: ghIssueCommentLister(() =>
      Promise.resolve(
        JSON.stringify({
          comments: [{
            body: `${buildIssueRunStatsMarker("vibe-run-one")}\nold`,
          }],
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
