/**
 * Tests for quorum_run_stats.ts — plan-off degraded-model detection, label
 * application and stats posting (Issue #4434).
 *
 * Both Quorum phases became Fable-preferring in Issue #4429, so a plan-off
 * served on Opus @ `max` during a Fable outage must leave the same
 * `degraded-model` label and stats comment the six single-call phases post.
 * These tests assert real behaviour through the real recorder:
 *   - a `fable`-served plan-off is not degraded and reports nothing;
 *   - a rerouted invocation — draft *or* judgement — is degraded → one label,
 *     one comment, covering all three invocations;
 *   - an Opus-served round and a rate-limit fallback are degraded too;
 *   - every GitHub operation is non-fatal.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GitHubClient, Logger } from "../types.ts";
import type { RunStats } from "../lib/run_stats.ts";
import type { QuorumModelObservation } from "../lib/quorum_orchestrator.ts";
import {
  buildQuorumClaudeResults,
  QUORUM_STATS_PHASE,
  reportQuorumDegradation,
} from "../lib/quorum_run_stats.ts";
import { DEGRADED_MODEL_LABEL } from "../lib/planning_degraded_label.ts";
import { FABLE_PREFLIGHT_DEGRADED_REASON } from "../lib/fable_routing.ts";
import {
  setActiveRepoModelEffortOverrides,
  setPhaseModelConfigOverrides,
} from "../lib/claude_executor.ts";
import { emptyEnv } from "./support/env_lookup.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset module-level model resolution so quorum derives the default tier.
 *
 * The environment half of this reset used to remove `CLAUDE_MODEL_QUORUM`
 * and `CLAUDE_MODEL` from the process (Issue #944). Every call below now
 * hands the recorder {@link emptyEnv} through its new `env` seam, so the
 * routing chain sees no operator override without the process the other
 * parallel workers share being changed underneath them.
 */
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
    effort: "high",
    wallClockMs: 1000,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    ...extra,
  };
}

/** One drafting observation. */
function draft(
  position: "A" | "B",
  fields: Partial<QuorumModelObservation> = {},
): QuorumModelObservation {
  return {
    phase: "quorum",
    role: "planner",
    position,
    providerId: position === "A" ? "alpha" : "bravo",
    ...fields,
  };
}

/** The judging observation. */
function judge(
  fields: Partial<QuorumModelObservation> = {},
): QuorumModelObservation {
  return {
    phase: "quorum_judge",
    role: "judge",
    providerId: "judgy",
    ...fields,
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

/** A minimal GitHubClient that records postComment bodies. */
function fakeClient(opts: { failComment?: boolean } = {}) {
  const comments: Array<{ issue: number; body: string }> = [];
  const ghClient = {
    postComment: (_repo: string, issue: number, body: string) => {
      if (opts.failComment) return Promise.reject(new Error("comment failed"));
      comments.push({ issue, body });
      return Promise.resolve();
    },
    getIssueComments: () => Promise.resolve([]),
  } as unknown as GitHubClient;
  return { ghClient, comments };
}

// ---------------------------------------------------------------------------
// buildQuorumClaudeResults
// ---------------------------------------------------------------------------

Deno.test("buildQuorumClaudeResults - carries one entry per invocation", () => {
  const results = buildQuorumClaudeResults([
    draft("A", { runStats: runStats(["fable"]) }),
    draft("B", { runStats: runStats(["opus"]) }),
    judge({ runStats: runStats(["fable"]) }),
  ]);

  assertEquals(results.length, 3);
  assertEquals(results[1]!.runStats?.servedModels, ["opus"]);
});

Deno.test("buildQuorumClaudeResults - omits fields the runner did not report", () => {
  const results = buildQuorumClaudeResults([draft("A")]);
  assertEquals(results.length, 1);
  assertEquals(results[0]!.runStats, undefined);
  assertEquals(results[0]!.fallbackModel, undefined);
  assertEquals(results[0]!.preflightDegraded, undefined);
});

Deno.test("buildQuorumClaudeResults - keeps the pre-flight reroute flag and its reason", () => {
  const results = buildQuorumClaudeResults([
    judge({
      preflightDegraded: true,
      preflightDegradedReason: FABLE_PREFLIGHT_DEGRADED_REASON,
    }),
  ]);
  assertEquals(results[0]!.preflightDegraded, true);
  assertEquals(
    results[0]!.preflightDegradedReason,
    FABLE_PREFLIGHT_DEGRADED_REASON,
  );
});

Deno.test("quorum stats - the whole plan-off is judged under the drafting phase", () => {
  assertEquals(QUORUM_STATS_PHASE, "quorum");
});

// ---------------------------------------------------------------------------
// reportQuorumDegradation — healthy path
// ---------------------------------------------------------------------------

Deno.test("reportQuorumDegradation - a fable-served plan-off is not degraded and stays quiet", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportQuorumDegradation({
    repo: "owner/repo",
    issueNumber: 4434,
    observations: [
      draft("A", { runStats: runStats(["claude-fable-5-20250101"]) }),
      draft("B", { runStats: runStats(["claude-fable-5-20250101"]) }),
      judge({ runStats: runStats(["claude-fable-5-20250101"]) }),
    ],
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assertEquals(verdict.degraded, false);
  assertEquals(addLabelCalls.length, 0);
  assertEquals(comments.length, 0, "a healthy plan-off adds no second comment");
});

Deno.test("reportQuorumDegradation - a run with no observations reports nothing", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportQuorumDegradation({
    repo: "owner/repo",
    issueNumber: 4434,
    observations: [],
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assertEquals(verdict.degraded, false);
  assertEquals(addLabelCalls.length, 0);
  assertEquals(comments.length, 0);
});

// ---------------------------------------------------------------------------
// reportQuorumDegradation — degraded paths
// ---------------------------------------------------------------------------

Deno.test("reportQuorumDegradation - a rerouted draft labels the issue and posts the round's stats", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportQuorumDegradation({
    repo: "owner/repo",
    issueNumber: 77,
    observations: [
      // Served fable (matches expected) but explicitly rerouted — the flag is
      // the only observable signal for a pre-flight Fable→Opus substitution.
      draft("A", {
        runStats: runStats(["claude-opus-4-8"], { effort: "max" }),
        preflightDegraded: true,
        preflightDegradedReason: FABLE_PREFLIGHT_DEGRADED_REASON,
      }),
      draft("B", { runStats: runStats(["claude-opus-4-8"]) }),
      judge({ runStats: runStats(["claude-opus-4-8"]) }),
    ],
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded, "a pre-flight reroute must be degraded");
  assertStringIncludes(verdict.reason ?? "", "pre-flight");

  // One label on the plan-off issue — not one per agent.
  assertEquals(addLabelCalls.length, 1);
  assertEquals(addLabelCalls[0]!.issue, 77);
  assertEquals(addLabelCalls[0]!.label, DEGRADED_MODEL_LABEL);

  // One comment, covering all three invocations.
  assertEquals(comments.length, 1);
  assertStringIncludes(comments[0]!.body, "## Quorum run model stats");
  assertStringIncludes(comments[0]!.body, "**Quorum invocations:** 3");
  assertStringIncludes(comments[0]!.body, "claude-opus-4-8");
  assertStringIncludes(comments[0]!.body, "Degraded:");
});

Deno.test("reportQuorumDegradation - a rerouted judgement is degraded too", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportQuorumDegradation({
    repo: "owner/repo",
    issueNumber: 78,
    observations: [
      draft("A", { runStats: runStats(["claude-fable-5-20250101"]) }),
      draft("B", { runStats: runStats(["claude-fable-5-20250101"]) }),
      judge({
        runStats: runStats(["claude-fable-5-20250101"]),
        preflightDegraded: true,
        preflightDegradedReason: FABLE_PREFLIGHT_DEGRADED_REASON,
      }),
    ],
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded, "a rerouted judgement degrades the plan-off");
  assertEquals(addLabelCalls.length, 1);
  assertEquals(comments.length, 1);
});

Deno.test("reportQuorumDegradation - an opus-served plan-off is degraded", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportQuorumDegradation({
    repo: "owner/repo",
    issueNumber: 79,
    observations: [
      draft("A", { runStats: runStats(["claude-opus-4-8"]) }),
      draft("B", { runStats: runStats(["claude-opus-4-8"]) }),
    ],
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded, "opus served when fable expected must be degraded");
  assertEquals(addLabelCalls.length, 1);
  assertEquals(comments.length, 1);
  assertStringIncludes(comments[0]!.body, "**Quorum invocations:** 2");
});

Deno.test("reportQuorumDegradation - a rate-limit fallbackModel is degraded", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportQuorumDegradation({
    repo: "owner/repo",
    issueNumber: 80,
    observations: [
      draft("A", { runStats: runStats(["fable"]) }),
      draft("B", { runStats: runStats(["fable"]), fallbackModel: "opus" }),
    ],
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded);
  assertStringIncludes(verdict.reason ?? "", "rate-limit fallback");
  assertEquals(addLabelCalls.length, 1);
  assertEquals(comments.length, 1);
});

// ---------------------------------------------------------------------------
// Non-fatal GitHub failures
// ---------------------------------------------------------------------------

Deno.test("reportQuorumDegradation - a comment failure is non-fatal and still labels", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient } = fakeClient({ failComment: true });
  const { logger, warnings } = recordingLogger();

  const verdict = await reportQuorumDegradation({
    repo: "owner/repo",
    issueNumber: 81,
    observations: [draft("A", { runStats: runStats(["claude-opus-4-8"]) })],
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded);
  assertEquals(addLabelCalls.length, 1);
  assert(
    warnings.some((w) => w.includes("stats comment")),
    `expected a non-fatal comment warning, got ${JSON.stringify(warnings)}`,
  );
});

Deno.test("reportQuorumDegradation - a label failure is non-fatal; the stats still post", async () => {
  resetModelResolution();
  const { ghCommandFn } = fakeGh({ failAdd: true });
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportQuorumDegradation({
    repo: "owner/repo",
    issueNumber: 82,
    observations: [draft("A", { runStats: runStats(["claude-opus-4-8"]) })],
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded);
  assertEquals(comments.length, 1);
});
