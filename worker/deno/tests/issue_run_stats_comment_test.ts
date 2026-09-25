/**
 * Tests for issue_run_stats_comment.ts — one cost/model stats comment per run,
 * posted at wrap-up on every worker-handled path (Issues #3756, #797).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BRIEF_STATS_PREFIX,
  buildBriefStatsLine,
  buildGraftStatsLine,
  buildIssueCostTotalLine,
  buildIssueRunStatsComment,
  buildIssueRunStatsMarker,
  buildQualityGateStatsLine,
  buildRtkStatsLine,
  ghIssueCommentLister,
  hasIssueRunStatsComment,
  hasRunStatsCommentForRun,
  ISSUE_RUN_STATS_DISCLAIMER,
  ISSUE_RUN_STATS_MARKER,
  measureIssuePhaseRun,
  postIssueRunStatsComment,
  RTK_STATS_PREFIX,
  sanitiseStatsRunId,
  tallyIssueCost,
} from "../lib/issue_run_stats_comment.ts";
import { formatUsd } from "../lib/cost_estimate.ts";
import type { GraftContextResult } from "../lib/graft_context.ts";
import type { QualityGateAttemptOutcome } from "../lib/issue_run_stats_comment.ts";
import {
  type CodegraphContextResult,
  prepareCodegraphContext,
} from "../lib/codegraph_context.ts";
import { GEMINI_PROVIDER_ID } from "../lib/agent_provider.ts";
import { RTK_OFF, type RtkOutputResult } from "../lib/rtk_output.ts";
import type { BriefRunReport } from "../lib/brief_toolchain.ts";
import { buildDegradationReport } from "../lib/planning_run_stats.ts";
import { buildPhaseInvocations } from "../lib/phase_run_stats.ts";
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
/** The fleet login the tally trusts in these tests (Issue #1249). */
const FLEET_AUTHOR = "vibe-bot";

/** Author-verification inputs, as every tally assertion now needs. */
const FLEET_OPTIONS = { fleetAuthors: [FLEET_AUTHOR] };

function makeGitHubDouble(
  existing: string[] = [],
  author: string = FLEET_AUTHOR,
) {
  const posted: string[] = [];
  return {
    posted,
    getIssueComments: () =>
      Promise.resolve(existing.map((body) => ({ body, author }))),
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

/** Every rendered line starting with `prefix`, in order. */
function linesStartingWith(body: string, prefix: string): string[] {
  return body.split("\n").filter((line) => line.startsWith(prefix));
}

Deno.test("buildIssueRunStatsComment - a split run's counts reach the rendered body (Issue #2344, #2346)", () => {
  const split = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"], {
      executorSplit: {
        advisorEditCalls: 0,
        deniedAdvisorEdits: ["Edit"],
        executorDispatches: 3,
        executorRetasks: 1,
      },
    })],
  });

  assertEquals(linesStartingWith(split, "- split:"), ["- split: on"]);
  assertEquals(linesStartingWith(split, "- executors dispatched:"), [
    "- executors dispatched: 3",
  ]);
  assertEquals(linesStartingWith(split, "- re-tasks issued:"), [
    "- re-tasks issued: 1",
  ]);
  assertEquals(linesStartingWith(split, "- advisor edit calls:"), [
    "- advisor edit calls: 0 (1 denied)",
  ]);
});

Deno.test("buildIssueRunStatsComment - an unsplit run says split: off and nothing more (Issue #2346)", () => {
  const unsplit = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
  });

  // Every implementation comment carries the line, so a control run is
  // separable from a pilot one when the numbers are read.
  assertEquals(linesStartingWith(unsplit, "- split:"), ["- split: off"]);
  assertEquals(unsplit.includes("executors dispatched:"), false);
  assertEquals(unsplit.includes("re-tasks issued:"), false);
  assertEquals(unsplit.includes("advisor edit calls:"), false);
});

Deno.test("buildIssueRunStatsComment - many invocations render exactly one split line (Issue #2346)", () => {
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [
      claudeResult(["claude-opus-4-8"], {
        executorSplit: {
          advisorEditCalls: 1,
          deniedAdvisorEdits: ["Write"],
          executorDispatches: 2,
          executorRetasks: 1,
        },
      }),
      claudeResult(["claude-opus-4-8"], {
        executorSplit: {
          advisorEditCalls: 0,
          deniedAdvisorEdits: [],
          executorDispatches: 3,
          executorRetasks: 0,
        },
      }),
    ],
  });

  assertEquals(linesStartingWith(body, "- split:"), ["- split: on"]);
  assertEquals(linesStartingWith(body, "- executors dispatched:"), [
    "- executors dispatched: 5",
  ]);
  assertEquals(linesStartingWith(body, "- re-tasks issued:"), [
    "- re-tasks issued: 1",
  ]);
  assertEquals(linesStartingWith(body, "- advisor edit calls:"), [
    "- advisor edit calls: 1 (1 denied)",
  ]);
});

Deno.test("buildIssueRunStatsComment - a planning-shaped phase carries no split line (Issue #2346)", () => {
  const body = buildIssueRunStatsComment({
    phase: "grill_me",
    claudeResults: [claudeResult(["claude-fable-5"])],
  });

  assertEquals(linesStartingWith(body, "- split:"), []);
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

/**
 * A split run: the Opus advisor and its Sonnet executors share one CLI
 * invocation, so the per-model breakdown is the only record of who spent what.
 * Counter keys are deliberately mixed camelCase/snake_case — the CLI emits the
 * former, the recorded fixtures the latter, and both must parse.
 */
function splitRunResult(): PhaseClaudeResult {
  return {
    runStats: {
      servedModels: ["claude-opus-5", "claude-sonnet-5"],
      requestedModel: "opus",
      wallClockMs: 2_000,
      tokenUsage: {
        inputTokens: 1_500_000,
        outputTokens: 300_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      modelUsage: {
        "claude-opus-5": { inputTokens: 1_000_000, outputTokens: 100_000 },
        "claude-sonnet-5": { input_tokens: 500_000, output_tokens: 200_000 },
      },
      executorSplit: {
        advisorEditCalls: 0,
        deniedAdvisorEdits: [],
        executorDispatches: 2,
        executorRetasks: 0,
      },
    },
  };
}

// Documented per-Mtok prices (docs/MODEL-AND-CACHING.md): Opus 5 $5 in /
// $25 out, Sonnet 5 $2 in / $10 out.
const ADVISOR_COST = 1.0 * 5 + 0.1 * 25; // $7.50
const EXECUTOR_COST = 0.5 * 2 + 0.2 * 10; // $3.00
const SPLIT_RUN_COST = ADVISOR_COST + EXECUTOR_COST; // $10.50

Deno.test("buildIssueRunStatsComment - executor Sonnet spend is priced separately from advisor Opus (Issue #2346)", () => {
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [splitRunResult()],
  });

  assertStringIncludes(
    body,
    "**Served model(s):** `claude-opus-5`, `claude-sonnet-5`",
  );
  // Each served model carries its own token counts...
  assertStringIncludes(
    body,
    "- `claude-opus-5`: input 1,000,000 · output 100,000 · cache write 0 · cache read 0",
  );
  assertStringIncludes(
    body,
    "- `claude-sonnet-5`: input 500,000 · output 200,000 · cache write 0 · cache read 0",
  );
  // ...its own cost line...
  assertStringIncludes(body, `- \`claude-opus-5\`: ${formatUsd(ADVISOR_COST)}`);
  assertStringIncludes(
    body,
    `- \`claude-sonnet-5\`: ${formatUsd(EXECUTOR_COST)}`,
  );
  // ...and the run's estimate is their sum, not the advisor's alone.
  assertStringIncludes(
    body,
    `**Estimated cost (USD, estimate only):** ~${formatUsd(SPLIT_RUN_COST)}`,
  );
  assertEquals(tallyIssueCost([body]).total, SPLIT_RUN_COST);
});

Deno.test("buildIssueRunStatsComment - the issue total sums both split runs' executor spend (Issue #2346)", () => {
  const earlier = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [splitRunResult()],
    runId: "vibe-run-one",
  });
  const later = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [splitRunResult()],
    runId: "vibe-run-two",
    priorComments: [earlier],
  });

  assertStringIncludes(
    later,
    `**Issue total across 2 run-stats comments:** ~${
      formatUsd(SPLIT_RUN_COST * 2)
    }`,
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

Deno.test("tallyIssueCost - covers a non-Claude run through the unchanged regex (Issue #1937)", () => {
  // A Codex run now renders a USD figure on the same heading line, so the
  // issue total includes it: no `pricing unknown` sub-bullet, no `(partial …)`
  // suffix, and the tally regex needs no change to read it.
  const codex = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["gpt-5-codex"])],
    runId: "vibe-run-codex",
  });
  const claude = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-run-claude",
  });

  assertStringIncludes(codex, "`gpt-5-codex`: $");
  assertStringIncludes(codex, " (API-equivalent) — input ");
  assertEquals(codex.includes("pricing unknown"), false);

  const tally = tallyIssueCost([codex, claude]);
  assertEquals(tally.runs, 2);
  assertEquals(tally.partial, false);
  assertEquals(
    tally.total,
    tallyIssueCost([codex]).total + tallyIssueCost([claude]).total,
  );
  assert(tally.total > 0, "the Codex run must contribute a real figure");
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

Deno.test("postIssueRunStatsComment - a split run's posted body carries the split figures and both models' spend (Issue #2346)", async () => {
  const earlier = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [splitRunResult()],
    runId: "vibe-run-one",
  });
  const gh = makeGitHubDouble([earlier]);
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 42,
    phase: "issue",
    claudeResults: [splitRunResult()],
    runId: "vibe-run-two",
    authorOptions: FLEET_OPTIONS,
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
  });

  assertEquals(result.posted, true);
  assertEquals(gh.posted.length, 1);
  const body = gh.posted[0]!;
  assertEquals(linesStartingWith(body, "- split:"), ["- split: on"]);
  assertEquals(linesStartingWith(body, "- executors dispatched:"), [
    "- executors dispatched: 2",
  ]);
  assertStringIncludes(
    body,
    `- \`claude-sonnet-5\`: ${formatUsd(EXECUTOR_COST)}`,
  );
  assertStringIncludes(
    body,
    `**Issue total across 2 run-stats comments:** ~${
      formatUsd(SPLIT_RUN_COST * 2)
    }`,
  );
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
    authorOptions: FLEET_OPTIONS,
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
    authorOptions: FLEET_OPTIONS,
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

Deno.test("ghIssueCommentLister - reads bodies and authors from gh issue view", async () => {
  let seen: string[] = [];
  const list = ghIssueCommentLister((args) => {
    seen = args;
    return Promise.resolve(
      JSON.stringify({
        comments: [
          { body: "one", author: { login: "vibe-bot" } },
          { body: "two" },
        ],
      }),
    );
  });

  // Issue #1249: the author rides along, and a comment without one is null
  // rather than absent — the tally must be able to tell "unknown" apart.
  assertEquals(await list("org/repo", 5), [
    { body: "one", author: "vibe-bot" },
    { body: "two", author: null },
  ]);
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

// ============================================================================
// Graft figures on the run-stats comment (Issue #2105, part of #2060)
// ============================================================================

/** A full `ok` collection, with every figure the collector gathers. */
const GRAFT_OK: GraftContextResult = {
  status: "ok",
  enabled: true,
  buildSeconds: 47,
  bundleChars: 7_874,
  nodeCount: 19_714,
  callEdgeCount: 22_908,
};

/** The Graft line from a comment body, or `undefined` when there is none. */
function graftLineOf(body: string): string | undefined {
  return body.split("\n").find((line) => line.startsWith("- **Graft:**"));
}

Deno.test("buildGraftStatsLine - reports every figure an ok collection gathered", () => {
  assertEquals(
    buildGraftStatsLine(GRAFT_OK),
    "- **Graft:** ok — build 47 s, bundle 7,874 chars, 19,714 nodes, 22,908 call edges",
  );
});

Deno.test("buildGraftStatsLine - a failed collection reports the figures it reached", () => {
  // The build timed out, so only the build seconds exist.
  assertEquals(
    buildGraftStatsLine({
      status: "failed",
      enabled: true,
      buildSeconds: 300,
    }),
    "- **Graft:** failed — build 300 s",
  );
  // Nothing was reached at all — the status alone, never a half-rendered line.
  assertEquals(
    buildGraftStatsLine({ status: "failed", enabled: true }),
    "- **Graft:** failed",
  );
});

Deno.test("buildGraftStatsLine - the host switch being off is stated, not omitted", () => {
  assertEquals(
    buildGraftStatsLine({ status: "off", enabled: false }),
    "- **Graft:** off",
  );
});

Deno.test("buildGraftStatsLine - the query tally joins the figures once the tools were handed over (Issue #2314)", () => {
  assertEquals(
    buildGraftStatsLine({ ...GRAFT_OK, queries: 1234 }),
    "- **Graft:** ok — build 47 s, bundle 7,874 chars, 19,714 nodes, 22,908 call edges, 1,234 queries",
  );
  // A tally of none is a measurement, and a run with no tally says nothing.
  assertEquals(
    buildGraftStatsLine({ status: "ok", enabled: true, queries: 0 }),
    "- **Graft:** ok — 0 queries",
  );
});

Deno.test("buildGraftStatsLine - renders no line without an outcome", () => {
  assertEquals(buildGraftStatsLine(undefined), "");
});

Deno.test("buildGraftStatsLine - fractional and unusable figures stay readable", () => {
  assertEquals(
    buildGraftStatsLine({
      status: "ok",
      enabled: true,
      buildSeconds: 12.345,
      bundleChars: Number.NaN,
      nodeCount: 1_000,
    }),
    "- **Graft:** ok — build 12.3 s, 1,000 nodes",
  );
});

Deno.test("buildGraftStatsLine - an unrecognised status cannot inject markdown", () => {
  assertEquals(
    buildGraftStatsLine({
      status: "**evil**\n- injected" as GraftContextResult["status"],
      enabled: true,
    }),
    "- **Graft:** unknown",
  );
});

Deno.test("buildIssueRunStatsComment - carries the Graft line inside the stats block", () => {
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-graft-1",
    graft: GRAFT_OK,
  });

  assertStringIncludes(body, buildGraftStatsLine(GRAFT_OK));
  // Rendered as a bullet of the stats list, ahead of the disclaimer.
  assert(
    body.indexOf("- **Graft:**") < body.indexOf(ISSUE_RUN_STATS_DISCLAIMER),
  );
});

Deno.test("buildIssueRunStatsComment - the Graft line leaves the cost tally alone", () => {
  const withoutGraft = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-graft-2",
  });
  const withGraft = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-graft-2",
    graft: GRAFT_OK,
  });

  assertEquals(tallyIssueCost([withGraft]), tallyIssueCost([withoutGraft]));
  assertEquals(tallyIssueCost([withGraft]).partial, false);

  // And the cumulative line across runs is the same with the figures present.
  const later = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-graft-3",
    priorComments: [withGraft],
    graft: GRAFT_OK,
  });
  const laterWithout = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-graft-3",
    priorComments: [withoutGraft],
  });
  assertEquals(
    laterWithout.split("\n").find((l) => l.includes("Issue total across")),
    later.split("\n").find((l) => l.includes("Issue total across")),
  );
});

Deno.test("buildIssueRunStatsComment - a comment built without the argument is byte-identical", () => {
  const args = {
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-graft-4",
  };
  const body = buildIssueRunStatsComment(args);

  assertEquals(body, buildIssueRunStatsComment({ ...args, graft: undefined }));
  assertEquals(graftLineOf(body), undefined);
});

Deno.test("postIssueRunStatsComment - posts the Graft figures with the run's costs", async () => {
  const gh = makeGitHubDouble();

  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 2105,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: gh.getIssueComments,
    postComment: gh.postComment,
    logger: makeLogger(),
    authorOptions: FLEET_OPTIONS,
    graft: { status: "failed", enabled: true, buildSeconds: 300 },
  });

  assertEquals(result.posted, true);
  assertEquals(gh.posted.length, 1);
  assertEquals(graftLineOf(gh.posted[0]!), "- **Graft:** failed — build 300 s");
});

// ============================================================================
// CodeGraph line (Issue #2161)
// ============================================================================

/** The comment's CodeGraph line, or `undefined` when it carries none. */
function codegraphLineOf(body: string): string | undefined {
  return body.split("\n").find((line) => line.startsWith("- **CodeGraph:**"));
}

/** A stats comment for a run whose CodeGraph step produced `codegraph`. */
function commentWithCodegraph(
  codegraph: CodegraphContextResult,
  priorComments?: readonly string[],
): string {
  return buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-codegraph-run",
    codegraph,
    ...(priorComments ? { priorComments } : {}),
  });
}

Deno.test("codegraph line - an indexed run reports every figure it gathered", () => {
  const body = commentWithCodegraph({
    status: "ok",
    enabled: true,
    indexSeconds: 1.8,
    nodeCount: 4120,
    relationshipCount: 9870,
    queries: 14,
  });

  assertEquals(
    codegraphLineOf(body),
    "- **CodeGraph:** ok — index 1.8 s, 4,120 nodes, 9,870 relationships, 14 queries",
  );
});

Deno.test("codegraph line - omits queries when the tally reported none", () => {
  const body = commentWithCodegraph({
    status: "ok",
    enabled: true,
    indexSeconds: 12,
    nodeCount: 4120,
    relationshipCount: 9870,
  });

  assertEquals(
    codegraphLineOf(body),
    "- **CodeGraph:** ok — index 12 s, 4,120 nodes, 9,870 relationships",
  );
});

Deno.test("codegraph line - a failed run still reports the figures it reached", () => {
  const body = commentWithCodegraph({
    status: "failed",
    enabled: true,
    indexSeconds: 300,
  });

  assertEquals(codegraphLineOf(body), "- **CodeGraph:** failed — index 300 s");
});

Deno.test("codegraph line - a failure with no figures reports the status alone", () => {
  const body = commentWithCodegraph({ status: "failed", enabled: true });

  assertEquals(codegraphLineOf(body), "- **CodeGraph:** failed");
});

Deno.test("codegraph line - a Gemini-routed run names the unsupported provider", async () => {
  // Driven from the real preparation step rather than a hand-made result, so
  // the line's `(gemini)` and the only status-producing path stay pinned
  // together: a second excluded provider fails this test instead of silently
  // publishing the wrong provider name.
  const codegraph = await prepareCodegraphContext({
    repoDir: "/tmp/not-read-on-this-path",
    enabled: true,
    providerId: GEMINI_PROVIDER_ID,
    logger: { warn: () => {} },
  });

  assertEquals(codegraph.status, "unsupported");
  assertEquals(
    codegraphLineOf(commentWithCodegraph(codegraph)),
    "- **CodeGraph:** unsupported (gemini)",
  );
});

Deno.test("codegraph line - a host with the switch off says so", () => {
  const body = commentWithCodegraph({ status: "off", enabled: false });

  assertEquals(codegraphLineOf(body), "- **CodeGraph:** off");
});

Deno.test("codegraph line - the cost tally and total line ignore it", () => {
  const figures: CodegraphContextResult = {
    status: "ok",
    enabled: true,
    indexSeconds: 1.8,
    nodeCount: 4120,
    relationshipCount: 9870,
    queries: 14,
  };
  const withLine = commentWithCodegraph(figures);
  const without = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-codegraph-run",
  });

  // Same run, same spend: the CodeGraph figures must not move the tally.
  assertEquals(tallyIssueCost([withLine]), tallyIssueCost([without]));
  assertEquals(tallyIssueCost([withLine]).partial, false);

  // …nor the cumulative total, which is summed from those same tallies.
  const prior = commentWithCodegraph(figures);
  const second = commentWithCodegraph(figures, [prior]);
  assertStringIncludes(
    second,
    `**Issue total across 2 run-stats comments:** ~${
      formatUsd(tallyIssueCost([prior]).total + tallyIssueCost([second]).total)
    }`,
  );
});

Deno.test("codegraph line - a comment built without the argument is unchanged", () => {
  const claudeResults = [claudeResult(["claude-opus-4-8"])];
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults,
    runId: "vibe-codegraph-run",
  });

  // Byte-for-byte the comment this function renders without the trial: the
  // marker, the shared section, the implementation run's split line (Issue
  // #2346 — every implementation comment carries one), then the disclaimer.
  const { section } = buildDegradationReport({
    invocations: claudeResults.flatMap((r) =>
      buildPhaseInvocations("issue", r)
    ),
    phase: "issue",
  });
  assertEquals(
    body,
    `${
      buildIssueRunStatsMarker("vibe-codegraph-run")
    }\n${section}\n- split: off\n\n${ISSUE_RUN_STATS_DISCLAIMER}`,
  );
  assertEquals(codegraphLineOf(body), undefined);
  assertEquals(body.includes("CodeGraph"), false);
});

Deno.test("codegraph line - the line sits inside the stats block, above the disclaimer", () => {
  const body = commentWithCodegraph({
    status: "ok",
    enabled: true,
    indexSeconds: 1.8,
    nodeCount: 4120,
    relationshipCount: 9870,
    queries: 14,
  });

  const codegraphAt = body.indexOf("- **CodeGraph:**");
  assert(codegraphAt > body.indexOf("- **Degraded:**"));
  assert(codegraphAt < body.indexOf(ISSUE_RUN_STATS_DISCLAIMER));
});

Deno.test("postIssueRunStatsComment - posts this run's CodeGraph figures", async () => {
  const github = makeGitHubDouble();

  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 2161,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: github.getIssueComments,
    postComment: github.postComment,
    logger: makeLogger(),
    authorOptions: FLEET_OPTIONS,
    codegraph: {
      status: "ok",
      enabled: true,
      indexSeconds: 2.5,
      nodeCount: 1000,
      relationshipCount: 2000,
      queries: 3,
    },
  });

  assertEquals(result.posted, true);
  assertEquals(github.posted.length, 1);
  assertEquals(
    codegraphLineOf(github.posted[0] ?? ""),
    "- **CodeGraph:** ok — index 2.5 s, 1,000 nodes, 2,000 relationships, 3 queries",
  );
});

Deno.test("postIssueRunStatsComment - CodeGraph figures alone are not something to report", async () => {
  const github = makeGitHubDouble();

  // No invocation produced stats, so there is no comment to carry the line —
  // the trial must not manufacture a stats comment out of an index alone.
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 2161,
    phase: "issue",
    claudeResults: [],
    getIssueComments: github.getIssueComments,
    postComment: github.postComment,
    logger: makeLogger(),
    authorOptions: FLEET_OPTIONS,
    codegraph: { status: "ok", enabled: true, nodeCount: 5, queries: 1 },
  });

  assertEquals(result, { posted: false, reason: "no_stats" });
  assertEquals(github.posted.length, 0);
});

// ============================================================================
// Quality-gate attempt line (Issue #2345)
// ============================================================================

/** The comment's quality-gate line, or `undefined` when it carries none. */
function qualityGateLineOf(body: string): string | undefined {
  return body.split("\n").find((line) => line.startsWith("- quality gate:"));
}

/** A stats comment for an implementation run whose gate did `qualityGate`. */
function commentWithQualityGate(
  qualityGate: QualityGateAttemptOutcome,
  phase = "issue",
): string {
  return buildIssueRunStatsComment({
    phase,
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-gate-run",
    qualityGate,
  });
}

Deno.test("quality-gate line - a gate that passed first time reports attempt 1", () => {
  const body = commentWithQualityGate({ status: "passed", attempt: 1 });

  assertEquals(qualityGateLineOf(body), "- quality gate: passed on attempt 1");
  assertStringIncludes(body, "quality gate: passed on attempt 1");
});

Deno.test("quality-gate line - a gate that passed after remediation reports attempt 2", () => {
  const body = commentWithQualityGate({ status: "passed", attempt: 2 });

  assertEquals(qualityGateLineOf(body), "- quality gate: passed on attempt 2");
});

Deno.test("quality-gate line - a gate that never passed reads failed", () => {
  const body = commentWithQualityGate({ status: "failed" });

  assertEquals(qualityGateLineOf(body), "- quality gate: failed");
  assertEquals(body.includes("passed on attempt"), false);
});

Deno.test("buildQualityGateStatsLine - renders no line without an outcome", () => {
  assertEquals(buildQualityGateStatsLine(undefined), "");
});

Deno.test("quality-gate line - a phase with no quality gate is byte-for-byte unchanged", () => {
  const claudeResults = [claudeResult(["claude-opus-4-8"])];
  const body = buildIssueRunStatsComment({
    phase: "grill_me",
    claudeResults,
    runId: "vibe-gate-run",
  });

  // Exactly the comment this function rendered before the line existed: the
  // marker, the shared section, then the disclaimer — nothing between.
  const { section } = buildDegradationReport({
    invocations: claudeResults.flatMap((r) =>
      buildPhaseInvocations("grill_me", r)
    ),
    phase: "grill_me",
  });
  assertEquals(
    body,
    `${
      buildIssueRunStatsMarker("vibe-gate-run")
    }\n${section}\n\n${ISSUE_RUN_STATS_DISCLAIMER}`,
  );
  assertEquals(qualityGateLineOf(body), undefined);
  assertEquals(body.includes("quality gate"), false);
});

Deno.test("quality-gate line - sits inside the stats block, above the disclaimer", () => {
  const body = commentWithQualityGate({ status: "passed", attempt: 2 });

  const gateAt = body.indexOf("- quality gate:");
  assert(gateAt > body.indexOf("- **Degraded:**"));
  assert(gateAt < body.indexOf(ISSUE_RUN_STATS_DISCLAIMER));
});

Deno.test("quality-gate line - the cost tally and total line ignore it", () => {
  const withLine = commentWithQualityGate({ status: "passed", attempt: 1 });
  const without = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-gate-run",
  });

  assertEquals(tallyIssueCost([withLine]), tallyIssueCost([without]));
  assertEquals(tallyIssueCost([withLine]).partial, false);
});

Deno.test("postIssueRunStatsComment - posts the gate outcome with the run's costs", async () => {
  const github = makeGitHubDouble();

  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 2345,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: github.getIssueComments,
    postComment: github.postComment,
    logger: makeLogger(),
    authorOptions: FLEET_OPTIONS,
    qualityGate: { status: "passed", attempt: 2 },
  });

  assertEquals(result.posted, true);
  assertEquals(
    qualityGateLineOf(github.posted[0] ?? ""),
    "- quality gate: passed on attempt 2",
  );
});

Deno.test("postIssueRunStatsComment - a gate outcome alone is not something to report", async () => {
  const github = makeGitHubDouble();

  // No invocation produced stats, so there is no comment to carry the line —
  // the gate outcome must not manufacture a stats comment of its own.
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 2345,
    phase: "issue",
    claudeResults: [],
    getIssueComments: github.getIssueComments,
    postComment: github.postComment,
    logger: makeLogger(),
    authorOptions: FLEET_OPTIONS,
    qualityGate: { status: "passed", attempt: 1 },
  });

  assertEquals(result, { posted: false, reason: "no_stats" });
  assertEquals(github.posted.length, 0);
});

// ============================================================================
// RTK line (Issue #2385)
// ============================================================================

/** Every RTK line the comment carries — exactly one is the contract. */
function rtkLinesOf(body: string): string[] {
  return body.split("\n").filter((line) => line.startsWith("- **RTK:**"));
}

/** A stats comment for a run whose RTK preparation produced `rtk`. */
function commentWithRtk(
  rtk: RtkOutputResult,
  extra?: {
    priorComments?: readonly string[];
    codegraph?: CodegraphContextResult;
  },
): string {
  return buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-rtk-run",
    rtk,
    ...(extra?.priorComments ? { priorComments: extra.priorComments } : {}),
    ...(extra?.codegraph ? { codegraph: extra.codegraph } : {}),
  });
}

Deno.test("rtk line - the prefix is the fixed `- **RTK:**` bullet", () => {
  assertEquals(RTK_STATS_PREFIX, "- **RTK:**");
});

Deno.test("rtk line - ok reports the saved tokens with a thousands separator", () => {
  const rtk: RtkOutputResult = {
    status: "ok",
    enabled: true,
    savedTokens: 12340,
  };

  assertEquals(buildRtkStatsLine(rtk), "- **RTK:** ok — 12,340 tokens saved");
  assertEquals(rtkLinesOf(commentWithRtk(rtk)), [
    "- **RTK:** ok — 12,340 tokens saved",
  ]);
});

Deno.test("rtk line - ok below a thousand carries no separator", () => {
  assertEquals(
    buildRtkStatsLine({ status: "ok", enabled: true, savedTokens: 987 }),
    "- **RTK:** ok — 987 tokens saved",
  );
});

Deno.test("rtk line - ok with a zero delta still reports the figure", () => {
  // Zero is a measurement (the hook ran and saved nothing), not an absence.
  assertEquals(
    buildRtkStatsLine({ status: "ok", enabled: true, savedTokens: 0 }),
    "- **RTK:** ok — 0 tokens saved",
  );
});

Deno.test("rtk line - ok with no saved-token figure reports the status alone", () => {
  const rtk: RtkOutputResult = { status: "ok", enabled: true };

  assertEquals(buildRtkStatsLine(rtk), "- **RTK:** ok");
  assertEquals(rtkLinesOf(commentWithRtk(rtk)), ["- **RTK:** ok"]);
});

Deno.test("rtk line - a failed preparation says so", () => {
  const rtk: RtkOutputResult = { status: "failed", enabled: true };

  assertEquals(buildRtkStatsLine(rtk), "- **RTK:** failed");
  assertEquals(rtkLinesOf(commentWithRtk(rtk)), ["- **RTK:** failed"]);
});

Deno.test("rtk line - a host with the switch off says so", () => {
  assertEquals(buildRtkStatsLine(RTK_OFF), "- **RTK:** off");
  assertEquals(rtkLinesOf(commentWithRtk(RTK_OFF)), ["- **RTK:** off"]);
});

Deno.test("rtk line - unsupported names the provider", () => {
  const rtk: RtkOutputResult = {
    status: "unsupported",
    enabled: true,
    provider: GEMINI_PROVIDER_ID,
  };

  assertEquals(buildRtkStatsLine(rtk), "- **RTK:** unsupported (gemini)");
  assertEquals(rtkLinesOf(commentWithRtk(rtk)), [
    "- **RTK:** unsupported (gemini)",
  ]);
  // The name comes from the result, not a constant: another provider reads so.
  assertEquals(
    buildRtkStatsLine({ ...rtk, provider: "deepseek" }),
    "- **RTK:** unsupported (deepseek)",
  );
});

Deno.test("rtk line - unsupported with no resolved provider reports the status alone", () => {
  assertEquals(
    buildRtkStatsLine({ status: "unsupported", enabled: true }),
    "- **RTK:** unsupported",
  );
});

Deno.test("rtk line - only an ok run reports a saved-token figure", () => {
  // A figure beside `failed` or `off` would read as a saving the hook never
  // made; a provider beside anything but `unsupported` names nothing.
  assertEquals(
    buildRtkStatsLine({ status: "failed", enabled: true, savedTokens: 50 }),
    "- **RTK:** failed",
  );
  assertEquals(
    buildRtkStatsLine({ status: "ok", enabled: true, provider: "gemini" }),
    "- **RTK:** ok",
  );
});

Deno.test("rtk line - sits after the CodeGraph line and before the issue total", () => {
  const prior = commentWithRtk({ status: "ok", enabled: true });
  const body = commentWithRtk(
    { status: "ok", enabled: true, savedTokens: 12340 },
    {
      priorComments: [prior],
      codegraph: { status: "ok", enabled: true, indexSeconds: 1.8 },
    },
  );

  const lines = body.split("\n");
  const codegraphAt = lines.findIndex((l) => l.startsWith("- **CodeGraph:**"));
  const rtkAt = lines.findIndex((l) => l.startsWith(RTK_STATS_PREFIX));
  const totalAt = lines.findIndex((l) => l.includes("**Issue total across"));
  assert(codegraphAt >= 0 && rtkAt >= 0 && totalAt >= 0, body);
  // The `issue` phase's always-on split line (Issue #2346) sits between
  // CodeGraph and RTK; nothing else does, and nothing sits between RTK and
  // the total.
  assertEquals(rtkAt, codegraphAt + 2);
  assertEquals(totalAt, rtkAt + 1);
  assert(body.indexOf(RTK_STATS_PREFIX) > body.indexOf("- **Degraded:**"));
  assert(
    body.indexOf(RTK_STATS_PREFIX) < body.indexOf(ISSUE_RUN_STATS_DISCLAIMER),
  );
});

Deno.test("rtk line - the cost tally and total line ignore it", () => {
  const rtk: RtkOutputResult = {
    status: "ok",
    enabled: true,
    savedTokens: 12340,
  };
  const withLine = commentWithRtk(rtk);
  const without = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-rtk-run",
  });

  // Same run, same spend: the saved-token figure must not move the tally.
  assert(tallyIssueCost([without]).total > 0, "the fixture must carry a cost");
  assertEquals(tallyIssueCost([withLine]), tallyIssueCost([without]));
  assertEquals(tallyIssueCost([withLine]).partial, false);
  // The parser takes the first cost-shaped line, so a run that reported no
  // cost is where a mis-parsed RTK line would surface: the saved tokens must
  // read as "no figure" (partial), never as that run's spend.
  assertEquals(
    tallyIssueCost([
      `## Issue run model stats\n${buildRtkStatsLine(rtk)}`,
    ]),
    { runs: 1, total: 0, partial: true },
  );

  // …nor the cumulative total, which is summed from those same tallies.
  const second = commentWithRtk(rtk, { priorComments: [withLine] });
  assertStringIncludes(
    second,
    `**Issue total across 2 run-stats comments:** ~${
      formatUsd(tallyIssueCost([without]).total * 2)
    }`,
  );
});

Deno.test("rtk line - a comment built without the argument is unchanged", () => {
  const claudeResults = [claudeResult(["claude-opus-4-8"])];
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults,
    runId: "vibe-rtk-run",
  });

  // Byte-for-byte the comment this function rendered before the RTK line
  // existed — modulo the `issue` phase's own always-on split line (Issue
  // #2346), which every implementation run carries regardless of RTK.
  const { section } = buildDegradationReport({
    invocations: claudeResults.flatMap((r) =>
      buildPhaseInvocations("issue", r)
    ),
    phase: "issue",
  });
  assertEquals(
    body,
    `${
      buildIssueRunStatsMarker("vibe-rtk-run")
    }\n${section}\n- split: off\n\n${ISSUE_RUN_STATS_DISCLAIMER}`,
  );
  assertEquals(body.includes("RTK"), false);
});

Deno.test("rtk line - adding it changes nothing else in the comment", () => {
  const withLine = commentWithRtk(RTK_OFF);
  const without = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-rtk-run",
  });

  assertEquals(
    withLine.split("\n").filter((l) => !l.startsWith(RTK_STATS_PREFIX)),
    without.split("\n"),
  );
});

Deno.test("postIssueRunStatsComment - posts exactly one RTK line", async () => {
  const github = makeGitHubDouble();

  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 2385,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: github.getIssueComments,
    postComment: github.postComment,
    logger: makeLogger(),
    authorOptions: FLEET_OPTIONS,
    rtk: { status: "ok", enabled: true, savedTokens: 4321 },
  });

  assertEquals(result.posted, true);
  assertEquals(github.posted.length, 1);
  assertEquals(rtkLinesOf(github.posted[0] ?? ""), [
    "- **RTK:** ok — 4,321 tokens saved",
  ]);
});

Deno.test("postIssueRunStatsComment - posts `off` on a host without the switch", async () => {
  const github = makeGitHubDouble();

  await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 2385,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: github.getIssueComments,
    postComment: github.postComment,
    logger: makeLogger(),
    authorOptions: FLEET_OPTIONS,
    rtk: RTK_OFF,
  });

  assertEquals(rtkLinesOf(github.posted[0] ?? ""), ["- **RTK:** off"]);
});

Deno.test("postIssueRunStatsComment - an RTK status alone is not something to report", async () => {
  const github = makeGitHubDouble();

  // No invocation produced stats, so there is no comment to carry the line.
  const result = await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 2385,
    phase: "issue",
    claudeResults: [],
    getIssueComments: github.getIssueComments,
    postComment: github.postComment,
    logger: makeLogger(),
    authorOptions: FLEET_OPTIONS,
    rtk: { status: "ok", enabled: true, savedTokens: 99 },
  });

  assertEquals(result, { posted: false, reason: "no_stats" });
  assertEquals(github.posted.length, 0);
});

// ---------------------------------------------------------------------------
// measureIssuePhaseRun (Issue #2347)
// ---------------------------------------------------------------------------

/** The estimated-cost figure the rendered comment reports, as a number. */
function renderedCostUsd(body: string): number {
  const match = body.match(
    /\*\*Estimated cost \(USD, estimate only\):\*\* ~\$([0-9.]+)/,
  );
  assert(match, `no estimated cost line in:\n${body}`);
  return Number(match[1]);
}

Deno.test("measureIssuePhaseRun - a non-implementation phase is not measured", () => {
  assertEquals(
    measureIssuePhaseRun({
      phase: "grill_me",
      claudeResults: [claudeResult(["claude-opus-5"])],
    }),
    undefined,
  );
});

Deno.test("measureIssuePhaseRun - a run no invocation produced stats for is not measured", () => {
  // The same runs `postIssueRunStatsComment` answers `no_stats` for: there is
  // no comment, so there are no figures to record and no run to count.
  assertEquals(
    measureIssuePhaseRun({ phase: "issue", claudeResults: [{}] }),
    undefined,
  );
  assertEquals(
    measureIssuePhaseRun({ phase: "issue", claudeResults: [] }),
    undefined,
  );
});

Deno.test("measureIssuePhaseRun - the spend is the figure the comment renders", () => {
  const claudeResults = [claudeResult(["claude-opus-5"])];
  const figures = measureIssuePhaseRun({ phase: "issue", claudeResults });
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults,
    runId: "vibe-measure-1",
  });

  assert(figures);
  assertEquals(formatUsd(figures.usd ?? -1), formatUsd(renderedCostUsd(body)));
});

Deno.test("measureIssuePhaseRun - an invocation with no served model is priced as the comment prices it", () => {
  // The divergent case: with no served model both the comment and the recorder
  // must fall back to the *expected* model of the phase's routing chain. The
  // requested model here is deliberately a different, cheaper tier, so pricing
  // off it instead would report a figure the comment never showed — on exactly
  // the runs whose price is least certain.
  const claudeResults = [claudeResult([], { requestedModel: "haiku" })];
  const figures = measureIssuePhaseRun({ phase: "issue", claudeResults });
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults,
    runId: "vibe-measure-2",
  });

  assert(figures);
  assertEquals(formatUsd(figures.usd ?? -1), formatUsd(renderedCostUsd(body)));
});

Deno.test("measureIssuePhaseRun - duration sums the invocations and the split is the comment's own rule", () => {
  const figures = measureIssuePhaseRun({
    phase: "issue",
    claudeResults: [
      claudeResult(["claude-opus-5"], { durationMs: 90_000 }),
      claudeResult(["claude-opus-5"], { durationMs: 30_000 }),
    ],
  });

  assert(figures);
  assertEquals(figures.durationSeconds, 120);
  // No invocation recorded an executor split, so the comment renders
  // `split: off` and the recorder reports the same.
  assertEquals(figures.split, false);
});

Deno.test("measureIssuePhaseRun - only a gate that passed carries its attempt", () => {
  const claudeResults = [claudeResult(["claude-opus-5"])];

  assertEquals(
    measureIssuePhaseRun({
      phase: "issue",
      claudeResults,
      qualityGate: { status: "passed", attempt: 2 },
    })?.gatePassedOnAttempt,
    2,
  );
  assertEquals(
    measureIssuePhaseRun({
      phase: "issue",
      claudeResults,
      qualityGate: { status: "failed" },
    })?.gatePassedOnAttempt,
    undefined,
  );
  assertEquals(
    measureIssuePhaseRun({ phase: "issue", claudeResults })
      ?.gatePassedOnAttempt,
    undefined,
  );
});

// ============================================================================
// Brief line (Issue #2603, part of #2581)
// ============================================================================

/** Every Brief line the comment carries. */
function briefLinesOf(body: string): string[] {
  return body.split("\n").filter((line) => line.startsWith(BRIEF_STATS_PREFIX));
}

/** A stats comment for a run whose codebase map reported `brief`. */
function commentWithBrief(brief: BriefRunReport): string {
  return buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-brief-run",
    rtk: RTK_OFF,
    brief,
  });
}

Deno.test("brief line - the prefix is the fixed `- **Brief:**` bullet", () => {
  assertEquals(BRIEF_STATS_PREFIX, "- **Brief:**");
});

Deno.test("brief line - ok reports the seconds brief took", () => {
  const brief: BriefRunReport = { enabled: true, status: "ok", seconds: 1.25 };
  assertEquals(buildBriefStatsLine(brief), "- **Brief:** ok (1.25s)");
  assertEquals(briefLinesOf(commentWithBrief(brief)), [
    "- **Brief:** ok (1.25s)",
  ]);
});

Deno.test("brief line - a cache hit says cached, not a time", () => {
  assertEquals(
    buildBriefStatsLine({
      enabled: true,
      status: "ok",
      seconds: 0,
      cached: true,
    }),
    "- **Brief:** ok (cached)",
  );
});

Deno.test("brief line - failed carries the reason", () => {
  assertEquals(
    buildBriefStatsLine({
      enabled: true,
      status: "failed",
      reason: "brief exited with code 2: boom",
    }),
    "- **Brief:** failed — `brief exited with code 2: boom`",
  );
});

Deno.test("brief line - a reason cannot break out of its code span", () => {
  const line = buildBriefStatsLine({
    enabled: true,
    status: "failed",
    reason: "bad `@someone` <b>x</b>\nnext",
  });
  assertEquals(line, "- **Brief:** failed — `bad '@someone' <b>x</b> next`");
});

Deno.test("brief line - switched on with no Cargo.toml says off and why", () => {
  assertEquals(
    buildBriefStatsLine({
      enabled: true,
      status: "off",
      reason: "no Cargo.toml",
    }),
    "- **Brief:** off — no Cargo.toml",
  );
  assertEquals(
    buildBriefStatsLine({ enabled: true, status: "off" }),
    "- **Brief:** off",
  );
});

Deno.test("brief line - no line at all when the switch is off", () => {
  const brief: BriefRunReport = { enabled: false, status: "off" };
  assertEquals(buildBriefStatsLine(brief), undefined);
  const without = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-brief-run",
    rtk: RTK_OFF,
  });
  // Byte-identical to today's comment.
  assertEquals(commentWithBrief(brief), without);
});

Deno.test("brief line - sits after the RTK line and before the issue total", () => {
  const prior = commentWithBrief({ enabled: true, status: "ok", seconds: 1 });
  const body = buildIssueRunStatsComment({
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    runId: "vibe-brief-run",
    priorComments: [prior],
    rtk: RTK_OFF,
    brief: { enabled: true, status: "ok", seconds: 2 },
  });
  const lines = body.split("\n");
  const rtkAt = lines.findIndex((l) => l.startsWith(RTK_STATS_PREFIX));
  const briefAt = lines.findIndex((l) => l.startsWith(BRIEF_STATS_PREFIX));
  const totalAt = lines.findIndex((l) => l.includes("**Issue total across"));
  assertEquals(briefAt, rtkAt + 1);
  assertEquals(totalAt, briefAt + 1);
  // The seconds figure never reads as spend.
  assertEquals(
    tallyIssueCost([prior]),
    tallyIssueCost([
      buildIssueRunStatsComment({
        phase: "issue",
        claudeResults: [claudeResult(["claude-opus-4-8"])],
        runId: "vibe-brief-run",
        rtk: RTK_OFF,
      }),
    ]),
  );
});

Deno.test("postIssueRunStatsComment - posts the Brief line", async () => {
  const github = makeGitHubDouble();

  await postIssueRunStatsComment({
    repo: "org/repo",
    issueNumber: 2603,
    phase: "issue",
    claudeResults: [claudeResult(["claude-opus-4-8"])],
    getIssueComments: github.getIssueComments,
    postComment: github.postComment,
    logger: makeLogger(),
    authorOptions: FLEET_OPTIONS,
    brief: { enabled: true, status: "failed", reason: "brief timed out" },
  });

  assertEquals(briefLinesOf(github.posted[0] ?? ""), [
    "- **Brief:** failed — `brief timed out`",
  ]);
});
