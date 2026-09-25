/**
 * Tests for the cost/model run-stats comment posted at PR-raise time by
 * `workOnIssueCompletion` (Issue #3756).
 *
 * A `work-on` issue is auto-closed by its merged PR with no worker attached, so
 * PR-raise is the last point the worker can report what the run cost. The
 * completion phase posts the issue's single stats comment there, using the
 * invocations the execute phase recorded on `PhaseState.claudeRunStats`.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubClient, GitHubComment } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  buildIssueRunStatsMarker,
  ISSUE_RUN_STATS_MARKER,
} from "../lib/issue_run_stats_comment.ts";
import {
  getFleetTelemetry,
  resetFleetTelemetry,
} from "../lib/fleet_telemetry.ts";
import { formatUsd } from "../lib/cost_estimate.ts";
import { getRunId } from "../lib/run_id.ts";
import type { PhaseClaudeResult } from "../lib/phase_run_stats.ts";

interface RecordedComment {
  repo: string;
  issueNumber: number;
  body: string;
}

function makeStubClient(
  comments: RecordedComment[],
  existing: string[] = [],
): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () =>
      Promise.resolve(
        existing.map((body, id) => ({
          id,
          body,
          // Issue #1249: the cumulative total counts fleet-authored comments
          // only, so the prior comment is attributed to this worker.
          author: "testbot",
          createdAt: "2026-01-01T00:00:00Z",
          reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
        })) as GitHubComment[],
      ),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: (repo, issueNumber, body) => {
      comments.push({ repo, issueNumber, body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

function makeContext(): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 3756,
    issueTitle: "Post cost/model run stats when any issue is closed",
    issueBody: "",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config: buildDefaultWorkerConfig(),
  };
}

function claudeRun(served: string[]): PhaseClaudeResult {
  return {
    runStats: {
      servedModels: served,
      requestedModel: "opus",
      wallClockMs: 5_000,
      numTurns: 12,
      tokenUsage: {
        inputTokens: 4_000,
        outputTokens: 8_000,
        cacheCreationTokens: 500,
        cacheReadTokens: 250,
      },
    },
  };
}

function makeState(overrides?: Partial<PhaseState>): PhaseState {
  return {
    branchName: "issue-3756-run-stats",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
    ...overrides,
  };
}

function makeDeps(comments: RecordedComment[], existing: string[] = []) {
  return createMockDeps({
    github: {
      createClient: () => makeStubClient(comments, existing),
      runGhCommand: () =>
        Promise.resolve("https://github.com/org/repo/pull/42"),
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("No PR found") }),
    },
  });
}

/** The stats comment posted on the issue (not the PR thread). */
function statsCommentOn(
  comments: RecordedComment[],
  issueNumber: number,
): RecordedComment | undefined {
  return comments.find((c) =>
    c.issueNumber === issueNumber &&
    c.body.includes(ISSUE_RUN_STATS_MARKER)
  );
}

// =============================================================================

Deno.test("completion - posts the run stats comment on the issue after the PR is raised", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeRunStats: [claudeRun(["claude-opus-4-8"])] });
  const comments: RecordedComment[] = [];

  const result = await workOnIssueCompletion(ctx, state, makeDeps(comments));

  assertEquals(result.status, "continue");
  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertStringIncludes(stats.body, "## Issue run model stats");
  assertStringIncludes(stats.body, "`claude-opus-4-8`");
  assertStringIncludes(stats.body, "Estimated cost (USD, estimate only)");
  assertStringIncludes(stats.body, "Estimate only");
});

Deno.test("completion - aggregates every recorded execute invocation", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [
      claudeRun(["claude-opus-4-8"]),
      claudeRun(["claude-opus-4-8"]),
    ],
  });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertStringIncludes(stats.body, "**Issue invocations:** 2");
  assertStringIncludes(stats.body, "input 8,000");
});

Deno.test("completion - reports the run's Graft figures beside the costs (Issue #2105)", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [claudeRun(["claude-opus-4-8"])],
    graftContext: {
      status: "ok",
      enabled: true,
      buildSeconds: 47,
      bundleChars: 7_874,
      nodeCount: 19_714,
      callEdgeCount: 22_908,
    },
  });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertStringIncludes(
    stats.body,
    "- **Graft:** ok — build 47 s, bundle 7,874 chars, 19,714 nodes, 22,908 call edges",
  );
});

Deno.test("completion - a run that never reached the collection carries no Graft line", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeRunStats: [claudeRun(["claude-opus-4-8"])] });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertEquals(stats.body.includes("**Graft:**"), false);
});

Deno.test("completion - posts no stats comment when Claude never ran", async () => {
  const ctx = makeContext();
  const state = makeState();
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  assertEquals(statsCommentOn(comments, ctx.issueNumber), undefined);
});

Deno.test("completion - skips when this run already posted its stats comment", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeRunStats: [claudeRun(["claude-opus-4-8"])] });
  const comments: RecordedComment[] = [];
  const deps = makeDeps(comments, [
    `${buildIssueRunStatsMarker(getRunId())}\n## Issue run model stats`,
  ]);

  await workOnIssueCompletion(ctx, state, deps);

  assertEquals(statsCommentOn(comments, ctx.issueNumber), undefined);
});

Deno.test("completion - reports this run's cost even when an earlier run already posted (Issue #797)", async () => {
  // Issue #762's shape: a cheap grill-me round reported first, and the run that
  // actually completed the issue must still say what it cost.
  const ctx = makeContext();
  const state = makeState({ claudeRunStats: [claudeRun(["claude-opus-4-8"])] });
  const comments: RecordedComment[] = [];
  const deps = makeDeps(comments, [
    "## Grill-me run model stats\n\n- **Estimated cost (USD, estimate only):** ~$1.34",
  ]);

  await workOnIssueCompletion(ctx, state, deps);

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected this run's stats comment on the issue");
  assertStringIncludes(stats.body, "## Issue run model stats");
  assertStringIncludes(stats.body, "Issue total across 2 run-stats comments");
});

Deno.test("completion - reports the deadline-extension counters in the stats comment (Issue #4298)", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [{
      ...claudeRun(["claude-opus-4-8"]),
      extensions: {
        granted: 4,
        extendedSeconds: 2040,
        baseTimeoutSeconds: 3600,
        finalDeadlineSeconds: 5640,
        elapsedSeconds: 5640,
      },
    }],
  });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertStringIncludes(
    stats.body,
    "**Deadline extensions:** 4 (+2040s beyond the 3600s budget)",
  );
});

Deno.test("completion - an unextended run reports no extension counters (Issue #4298)", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeRunStats: [claudeRun(["claude-opus-4-8"])] });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assert(
    !stats.body.includes("Deadline extensions"),
    `an unextended run must not mention extensions: ${stats.body}`,
  );
});

Deno.test("completion - reports the run's CodeGraph figures in the stats comment (Issue #2161)", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [claudeRun(["claude-opus-4-8"])],
    codegraphContext: {
      status: "ok",
      enabled: true,
      indexSeconds: 1.8,
      nodeCount: 4120,
      relationshipCount: 9870,
      queries: 14,
    },
  });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertStringIncludes(
    stats.body,
    "- **CodeGraph:** ok — index 1.8 s, 4,120 nodes, 9,870 relationships, 14 queries",
  );
  // The figures are reported beside the spend, never counted as spend.
  assertStringIncludes(stats.body, "Estimated cost (USD, estimate only)");
});

Deno.test("completion - a failed CodeGraph step is reported, not hidden (Issue #2161)", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [claudeRun(["claude-opus-4-8"])],
    codegraphContext: { status: "failed", enabled: true, indexSeconds: 300 },
  });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertStringIncludes(stats.body, "- **CodeGraph:** failed — index 300 s");
});

Deno.test("completion - reports the attempt the quality gate passed on (Issue #2345)", async () => {
  for (const attempt of [1, 2]) {
    const ctx = makeContext();
    const state = makeState({
      claudeRunStats: [claudeRun(["claude-opus-4-8"])],
      qualityGateOutcome: { status: "passed", attempt },
    });
    const comments: RecordedComment[] = [];

    await workOnIssueCompletion(ctx, state, makeDeps(comments));

    const stats = statsCommentOn(comments, ctx.issueNumber);
    assert(stats, "expected a run-stats comment on the issue");
    assertStringIncludes(
      stats.body,
      `- quality gate: passed on attempt ${attempt}`,
    );
  }
});

Deno.test("completion - a gate that never passed is reported as failed (Issue #2345)", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [claudeRun(["claude-opus-4-8"])],
    qualityGateOutcome: { status: "failed" },
  });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertStringIncludes(stats.body, "- quality gate: failed");
});

Deno.test("completion - a run that never reached the gate mentions none (Issue #2345)", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeRunStats: [claudeRun(["claude-opus-4-8"])] });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assert(
    !stats.body.includes("quality gate"),
    `a run without the gate must not mention it: ${stats.body}`,
  );
});

Deno.test("completion - a run with no CodeGraph step mentions none (Issue #2161)", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeRunStats: [claudeRun(["claude-opus-4-8"])] });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assert(
    !stats.body.includes("CodeGraph"),
    `a run without the step must not mention it: ${stats.body}`,
  );
});

// --- fleet telemetry (Issue #2347) -------------------------------------

/** The cost line's figure, as the comment renders it. */
function renderedCost(body: string): string | undefined {
  return body.match(/Estimated cost \(USD, estimate only\):\*\*\s*~(\$[\d.,]+)/)
    ?.[1];
}

Deno.test("completion - records the run in fleet telemetry with the figures the comment reports (Issue #2347)", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [{
      runStats: {
        ...claudeRun(["claude-opus-4-8"]).runStats!,
        durationMs: 930_000,
        executorSplit: {
          advisorEditCalls: 0,
          deniedAdvisorEdits: [],
          executorDispatches: 3,
          executorRetasks: 1,
        },
      },
    }],
    qualityGateOutcome: { status: "passed", attempt: 1 },
  });
  const comments: RecordedComment[] = [];

  resetFleetTelemetry();
  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  const snapshot = getFleetTelemetry();
  assertEquals(snapshot.issuePhaseRuns, 1);
  assertEquals(snapshot.issuePhaseSplitRuns, 1);
  assertEquals(snapshot.issuePhaseFirstAttemptGatePasses, 1);
  assertEquals(snapshot.issuePhaseDurationSeconds, 930);
  // The recorded spend is the figure the comment itself reports, not a second
  // estimate that could drift from it.
  assertEquals(formatUsd(snapshot.issuePhaseUsd), renderedCost(stats.body));
});

Deno.test("completion - a gate that passed on attempt 2 counts a run but no first-attempt pass (Issue #2347)", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [claudeRun(["claude-opus-4-8"])],
    qualityGateOutcome: { status: "passed", attempt: 2 },
  });

  resetFleetTelemetry();
  await workOnIssueCompletion(ctx, state, makeDeps([]));

  const snapshot = getFleetTelemetry();
  assertEquals(snapshot.issuePhaseRuns, 1);
  assertEquals(snapshot.issuePhaseFirstAttemptGatePasses, 0);
  // An unsplit run is recorded as a control run, never as a pilot one.
  assertEquals(snapshot.issuePhaseSplitRuns, 0);
});

Deno.test("completion - a run already counted is not counted twice (Issue #2347)", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeRunStats: [claudeRun(["claude-opus-4-8"])] });
  const deps = makeDeps([], [
    `${buildIssueRunStatsMarker(getRunId())}\n## Issue run model stats`,
  ]);

  resetFleetTelemetry();
  await workOnIssueCompletion(ctx, state, deps);

  assertEquals(getFleetTelemetry().issuePhaseRuns, 0);
});

Deno.test("completion - a run where Claude never ran records no issue-phase run (Issue #2347)", async () => {
  const ctx = makeContext();

  resetFleetTelemetry();
  await workOnIssueCompletion(ctx, makeState(), makeDeps([]));

  assertEquals(getFleetTelemetry().issuePhaseRuns, 0);
});

Deno.test("completion - reports the run's RTK status in the stats comment (Issue #2385)", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [claudeRun(["claude-opus-4-8"])],
    codegraphContext: { status: "failed", enabled: true, indexSeconds: 300 },
    rtkOutput: { status: "ok", enabled: true, savedTokens: 12340 },
  });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertEquals(
    stats.body.split("\n").filter((line) => line.startsWith("- **RTK:**")),
    ["- **RTK:** ok — 12,340 tokens saved"],
  );
  // Beside the CodeGraph line, and never counted as spend.
  assertStringIncludes(stats.body, "- **CodeGraph:** failed — index 300 s");
  assertStringIncludes(stats.body, "Estimated cost (USD, estimate only)");
});

Deno.test("completion - a host with RTK off still reports the line (Issue #2385)", async () => {
  const ctx = makeContext();
  const state = makeState({
    claudeRunStats: [claudeRun(["claude-opus-4-8"])],
    rtkOutput: { status: "off", enabled: false },
  });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assertStringIncludes(stats.body, "- **RTK:** off");
});

Deno.test("completion - a run that never reached the RTK preparation mentions none (Issue #2385)", async () => {
  const ctx = makeContext();
  const state = makeState({ claudeRunStats: [claudeRun(["claude-opus-4-8"])] });
  const comments: RecordedComment[] = [];

  await workOnIssueCompletion(ctx, state, makeDeps(comments));

  const stats = statsCommentOn(comments, ctx.issueNumber);
  assert(stats, "expected a run-stats comment on the issue");
  assert(
    !stats.body.includes("RTK"),
    `a run without the preparation must not mention it: ${stats.body}`,
  );
});

Deno.test("completion - reports the run's Brief status in the stats comment (Issue #2603)", async () => {
  for (
    const [brief, expected] of [
      [{ enabled: true, status: "ok", seconds: 3 }, ["- **Brief:** ok (3s)"]],
      [{ enabled: false, status: "off" }, []],
    ] as const
  ) {
    const ctx = makeContext();
    const state = makeState({
      claudeRunStats: [claudeRun(["claude-opus-4-8"])],
      brief: { ...brief },
    });
    const comments: RecordedComment[] = [];

    await workOnIssueCompletion(ctx, state, makeDeps(comments));

    const stats = statsCommentOn(comments, ctx.issueNumber);
    assert(stats, "expected a run-stats comment on the issue");
    assertEquals(
      stats.body.split("\n").filter((l) => l.startsWith("- **Brief:**")),
      [...expected],
    );
  }
});
