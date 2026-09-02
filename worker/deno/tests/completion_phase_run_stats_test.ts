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
          author: "someone",
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
