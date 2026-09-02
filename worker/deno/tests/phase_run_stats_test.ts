/**
 * Tests for phase_run_stats.ts — phase-parametric degraded-model detection,
 * label application, and stats posting for the four newly-promoted reactive
 * planning-shaped phases (refinement, revision, question, clarification) plus
 * the explicit pre-flight reroute signal (Issue #3232).
 *
 * These tests assert real behaviour via the shared recorder:
 *   - a `fable`-served round (expected fable) is NOT degraded → no label, and
 *     one cost/model stats comment per issue (Issue #3756 — healthy rounds used
 *     to post nothing at all);
 *   - an `opus`-served round when fable is expected IS degraded → labels + posts;
 *   - the explicit pre-flight `preflightDegraded` flag IS degraded even when the
 *     served model matches the expected (fable) model;
 *   - a rate-limit `fallbackModel` round IS degraded;
 *   - all GitHub operations are non-fatal.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Logger } from "../types.ts";
import type { RunStats } from "../lib/run_stats.ts";
import {
  buildPhaseInvocations,
  type PhaseClaudeResult,
  reportPhaseDegradation,
} from "../lib/phase_run_stats.ts";
import { DEGRADED_MODEL_LABEL } from "../lib/planning_degraded_label.ts";
import { buildIssueRunStatsMarker } from "../lib/issue_run_stats_comment.ts";
import { getRunId } from "../lib/run_id.ts";
import {
  setActiveRepoModelEffortOverrides,
  setPhaseModelConfigOverrides,
} from "../lib/claude_executor.ts";

/** The four newly-promoted reactive phases plus their expected stats heading. */
const PROMOTED_PHASES: Array<{ phase: string; heading: string }> = [
  { phase: "refinement", heading: "## Refinement run model stats" },
  { phase: "revision", heading: "## Revision run model stats" },
  { phase: "question", heading: "## Question run model stats" },
  { phase: "clarification", heading: "## Clarification run model stats" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pin every promoted phase's expected model to `fable` for the duration of a
 * test, mirroring the post-config world where these phases prefer the top tier.
 * (The config default is still `opus` on this branch — Issue #3232 wires the
 * machinery; the config flip is a sibling #3217 sub-issue.)
 */
function pinPhasesToFable(): void {
  setPhaseModelConfigOverrides({
    refinement: "fable",
    revision: "fable",
    question: "fable",
    clarification: "fable",
  });
  setActiveRepoModelEffortOverrides(undefined);
  for (const v of ["CLAUDE_MODEL", "CLAUDE_MODEL_REFINEMENT"]) {
    Deno.env.delete(v);
  }
}

function resetModelResolution(): void {
  setPhaseModelConfigOverrides({});
  setActiveRepoModelEffortOverrides(undefined);
}

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  const logger: Logger = {
    info: noop,
    warn: (msg: string) => warnings.push(msg),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, warnings };
}

function runStats(served: string[], extra?: Partial<RunStats>): RunStats {
  return {
    servedModels: served,
    requestedModel: "fable",
    wallClockMs: 1000,
    ...extra,
  };
}

/** A gh runner that records add-label calls; succeeds by default. */
function fakeGh(opts: { failAdd?: boolean } = {}) {
  const addLabelCalls: Array<{ issue: number; label: string }> = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");
    const labelArg = args.find((a) => a.startsWith("labels[]="));
    if (labelArg) {
      const idx = args.findIndex((a) => /\/issues\/\d+\/labels$/.test(a));
      const issue = idx >= 0
        ? parseInt(args[idx]!.match(/\/issues\/(\d+)\/labels$/)![1]!, 10)
        : -1;
      if (opts.failAdd) return Promise.reject(new Error("add failed"));
      addLabelCalls.push({ issue, label: labelArg.replace("labels[]=", "") });
      return Promise.resolve("");
    }
    if (args[0] === "issue" && args[1] === "edit") {
      const issue = parseInt(args[2]!, 10);
      const li = args.findIndex((a) => a === "--add-label");
      const label = li >= 0 ? args[li + 1]! : "";
      if (opts.failAdd) return Promise.reject(new Error("add failed"));
      addLabelCalls.push({ issue, label });
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
  return { ghCommandFn, addLabelCalls };
}

/** A postComment recorder; can be made to fail. */
function fakePost(opts: { failComment?: boolean } = {}) {
  const comments: Array<{ issue: number; body: string }> = [];
  const postComment = (
    _repo: string,
    issue: number,
    body: string,
  ): Promise<void> => {
    if (opts.failComment) return Promise.reject(new Error("comment failed"));
    comments.push({ issue, body });
    return Promise.resolve();
  };
  return { postComment, comments };
}

// ---------------------------------------------------------------------------
// buildPhaseInvocations
// ---------------------------------------------------------------------------

Deno.test("buildPhaseInvocations - tags the single call with the given phase", () => {
  const invs = buildPhaseInvocations("refinement", {
    runStats: runStats(["fable"]),
  });
  assertEquals(invs.length, 1);
  assertEquals(invs[0]!.phase, "refinement");
  assertEquals(invs[0]!.runStats?.servedModels, ["fable"]);
});

Deno.test("buildPhaseInvocations - omits absent optional fields", () => {
  const invs = buildPhaseInvocations("revision", {});
  assertEquals(invs.length, 1);
  assertEquals(invs[0]!.runStats, undefined);
  assertEquals(invs[0]!.fallbackModel, undefined);
  assertEquals(invs[0]!.preflightDegraded, undefined);
});

Deno.test("buildPhaseInvocations - carries the explicit pre-flight flag + reason", () => {
  const invs = buildPhaseInvocations("question", {
    runStats: runStats(["fable"]),
    preflightDegraded: true,
    preflightDegradedReason: "fable-unavailable (pre-flight health probe)",
  });
  assertEquals(invs[0]!.preflightDegraded, true);
  assertEquals(
    invs[0]!.preflightDegradedReason,
    "fable-unavailable (pre-flight health probe)",
  );
});

// ---------------------------------------------------------------------------
// Healthy path — no label, but one cost/model stats comment per issue
//
// Behaviour change (Issue #3756): a healthy round used to report NOTHING, so
// most issues the Vibe Coder wrapped up carried no cost indication. It now
// posts the stats block once per issue. The `no label` half of the original
// assertion is unchanged; the `no comment` half is deliberately replaced by
// the one-comment-per-issue assertions below.
// ---------------------------------------------------------------------------

for (const { phase, heading } of PROMOTED_PHASES) {
  Deno.test(`reportPhaseDegradation - ${phase}: healthy round posts stats once, no label`, async () => {
    pinPhasesToFable();
    const { ghCommandFn, addLabelCalls } = fakeGh();
    const { postComment, comments } = fakePost();
    const { logger } = recordingLogger();

    const verdict = await reportPhaseDegradation({
      phase,
      repo: "owner/repo",
      issueNumber: 5,
      claudeResult: { runStats: runStats(["claude-fable-5-20250101"]) },
      postComment,
      runGhCommand: ghCommandFn,
      logger,
      cacheDir: Deno.makeTempDirSync(),
      listIssueComments: () => Promise.resolve([]),
    });

    resetModelResolution();
    assertEquals(verdict.degraded, false);
    assertEquals(addLabelCalls.length, 0);
    assertEquals(comments.length, 1);
    assertStringIncludes(comments[0]!.body, heading);
    assertStringIncludes(comments[0]!.body, "Estimate only");
  });

  Deno.test(`reportPhaseDegradation - ${phase}: healthy round skips a second stats comment for the same run`, async () => {
    pinPhasesToFable();
    const { ghCommandFn, addLabelCalls } = fakeGh();
    const { postComment, comments } = fakePost();
    const { logger } = recordingLogger();

    const verdict = await reportPhaseDegradation({
      phase,
      repo: "owner/repo",
      issueNumber: 5,
      claudeResult: { runStats: runStats(["claude-fable-5-20250101"]) },
      postComment,
      runGhCommand: ghCommandFn,
      logger,
      cacheDir: Deno.makeTempDirSync(),
      // This run already posted its stats comment.
      listIssueComments: () =>
        Promise.resolve([{
          body: `${buildIssueRunStatsMarker(getRunId())}\n## Run model stats`,
        }]),
    });

    resetModelResolution();
    assertEquals(verdict.degraded, false);
    assertEquals(addLabelCalls.length, 0);
    assertEquals(comments.length, 0);
  });

  Deno.test(`reportPhaseDegradation - ${phase}: an earlier run's stats comment does not suppress this run (Issue #797)`, async () => {
    pinPhasesToFable();
    const { ghCommandFn } = fakeGh();
    const { postComment, comments } = fakePost();
    const { logger } = recordingLogger();

    await reportPhaseDegradation({
      phase,
      repo: "owner/repo",
      issueNumber: 5,
      claudeResult: { runStats: runStats(["claude-fable-5-20250101"]) },
      postComment,
      runGhCommand: ghCommandFn,
      logger,
      cacheDir: Deno.makeTempDirSync(),
      // The planning path reported an earlier, different run.
      listIssueComments: () =>
        Promise.resolve([{
          body:
            "## Planning run model stats\n\n- **Estimated cost (USD, estimate only):** ~$0.50",
        }]),
    });

    resetModelResolution();
    assertEquals(comments.length, 1);
    assertStringIncludes(comments[0]!.body, heading);
    assertStringIncludes(comments[0]!.body, "Issue total across 2 run-stats");
  });
}

// ---------------------------------------------------------------------------
// Degraded by served-model mismatch
// ---------------------------------------------------------------------------

for (const { phase, heading } of PROMOTED_PHASES) {
  Deno.test(`reportPhaseDegradation - ${phase}: opus-served round is degraded → labels issue + posts stats`, async () => {
    pinPhasesToFable();
    const { ghCommandFn, addLabelCalls } = fakeGh();
    const { postComment, comments } = fakePost();
    const { logger } = recordingLogger();

    const verdict = await reportPhaseDegradation({
      phase,
      repo: "owner/repo",
      issueNumber: 9,
      claudeResult: { runStats: runStats(["claude-opus-4-8"]) },
      postComment,
      runGhCommand: ghCommandFn,
      logger,
      cacheDir: Deno.makeTempDirSync(),
    });

    resetModelResolution();
    assert(verdict.degraded, "opus when fable expected must be degraded");
    assertEquals(addLabelCalls.length, 1);
    assertEquals(addLabelCalls[0]!.issue, 9);
    assertEquals(addLabelCalls[0]!.label, DEGRADED_MODEL_LABEL);
    assertEquals(comments.length, 1);
    assertEquals(comments[0]!.issue, 9);
    assertStringIncludes(comments[0]!.body, heading);
    assertStringIncludes(comments[0]!.body, "claude-opus-4-8");
    assertStringIncludes(comments[0]!.body, "Degraded:");
  });
}

// ---------------------------------------------------------------------------
// Degraded by the explicit pre-flight flag (served model matches expected)
// ---------------------------------------------------------------------------

for (const { phase, heading } of PROMOTED_PHASES) {
  Deno.test(`reportPhaseDegradation - ${phase}: explicit pre-flight flag is degraded even when served matches expected`, async () => {
    pinPhasesToFable();
    const { ghCommandFn, addLabelCalls } = fakeGh();
    const { postComment, comments } = fakePost();
    const { logger } = recordingLogger();

    const verdict = await reportPhaseDegradation({
      phase,
      repo: "owner/repo",
      issueNumber: 12,
      // Served model matches the expected fable tier, yet the reroute flag is set.
      claudeResult: {
        runStats: runStats(["claude-fable-5-20250101"]),
        preflightDegraded: true,
        preflightDegradedReason: "fable-unavailable (pre-flight health probe)",
      },
      postComment,
      runGhCommand: ghCommandFn,
      logger,
      cacheDir: Deno.makeTempDirSync(),
    });

    resetModelResolution();
    assert(verdict.degraded, "explicit pre-flight flag must force degraded");
    assertStringIncludes(verdict.reason ?? "", "pre-flight");
    assertEquals(addLabelCalls.length, 1);
    assertEquals(addLabelCalls[0]!.label, DEGRADED_MODEL_LABEL);
    assertEquals(comments.length, 1);
    assertStringIncludes(comments[0]!.body, heading);
  });
}

// ---------------------------------------------------------------------------
// Degraded by rate-limit fallbackModel
// ---------------------------------------------------------------------------

Deno.test("reportPhaseDegradation - rate-limit fallbackModel round is degraded", async () => {
  pinPhasesToFable();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { postComment, comments } = fakePost();
  const { logger } = recordingLogger();

  const verdict = await reportPhaseDegradation({
    phase: "refinement",
    repo: "owner/repo",
    issueNumber: 11,
    claudeResult: { runStats: runStats(["fable"]), fallbackModel: "opus" },
    postComment,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
  });

  resetModelResolution();
  assert(verdict.degraded);
  assertStringIncludes(verdict.reason ?? "", "fallback");
  assertEquals(addLabelCalls.length, 1);
  assertEquals(comments.length, 1);
});

// ---------------------------------------------------------------------------
// Non-fatal behaviour
// ---------------------------------------------------------------------------

Deno.test("reportPhaseDegradation - comment failure is non-fatal", async () => {
  pinPhasesToFable();
  const { ghCommandFn } = fakeGh();
  const { postComment } = fakePost({ failComment: true });
  const { logger, warnings } = recordingLogger();

  const verdict = await reportPhaseDegradation({
    phase: "revision",
    repo: "owner/repo",
    issueNumber: 3,
    claudeResult: { runStats: runStats(["claude-opus-4-8"]) },
    postComment,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
  });

  resetModelResolution();
  assert(verdict.degraded);
  assert(
    warnings.some((w) => w.includes("Failed to post revision stats comment")),
    "expected a non-fatal comment-failure warning",
  );
});

Deno.test("reportPhaseDegradation - label failure is non-fatal; stats still post", async () => {
  pinPhasesToFable();
  const { ghCommandFn } = fakeGh({ failAdd: true });
  const { postComment, comments } = fakePost();
  const { logger } = recordingLogger();

  const verdict = await reportPhaseDegradation({
    phase: "question",
    repo: "owner/repo",
    issueNumber: 4,
    claudeResult: { runStats: runStats(["claude-opus-4-8"]) },
    postComment,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
  });

  resetModelResolution();
  assert(verdict.degraded);
  assertEquals(comments.length, 1);
});

// ---------------------------------------------------------------------------
// PhaseClaudeResult typing sanity — an all-empty result never flags
// ---------------------------------------------------------------------------

Deno.test("reportPhaseDegradation - a run with no stats and no flags is silent", async () => {
  pinPhasesToFable();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { postComment, comments } = fakePost();
  const { logger } = recordingLogger();

  const empty: PhaseClaudeResult = {};
  const verdict = await reportPhaseDegradation({
    phase: "clarification",
    repo: "owner/repo",
    issueNumber: 7,
    claudeResult: empty,
    postComment,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
  });

  resetModelResolution();
  assertEquals(verdict.degraded, false);
  assertEquals(addLabelCalls.length, 0);
  assertEquals(comments.length, 0);
});
