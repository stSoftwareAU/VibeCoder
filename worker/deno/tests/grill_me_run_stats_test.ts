/**
 * Tests for grill_me_run_stats.ts — grill-me degraded-model detection,
 * label application, and stats posting (Issue #2717).
 *
 * The grill_me phase routes to the same Fable 5 top tier as planning, so a
 * silent Fable→Opus degradation on a grill-me round must be surfaced the same
 * way planning surfaces it (#2646). These tests assert real behaviour:
 *   - a `fable`-served round is NOT degraded and reports nothing;
 *   - an `opus`-served round IS degraded → labels the issue + posts stats;
 *   - a rate-limit `fallbackModel` round IS degraded;
 *   - all GitHub operations are non-fatal.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { GitHubClient, Logger } from "../types.ts";
import type { RunStats } from "../lib/run_stats.ts";
import {
  buildGrillMeInvocations,
  GRILL_ME_PHASE,
  reportGrillMeDegradation,
} from "../lib/grill_me_run_stats.ts";
import { DEGRADED_MODEL_LABEL } from "../lib/planning_degraded_label.ts";
import { buildIssueRunStatsMarker } from "../lib/issue_run_stats_comment.ts";
import { getRunId } from "../lib/run_id.ts";
import {
  setActiveRepoModelEffortOverrides,
  setPhaseModelConfigOverrides,
} from "../lib/claude_executor.ts";
import { emptyEnv } from "./support/env_lookup.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset module-level model resolution so grill_me derives the default tier.
 *
 * The environment half of this reset used to remove `CLAUDE_MODEL_GRILL_ME`
 * and `CLAUDE_MODEL` from the process (Issue #944). Every call below
 * now hands the recorder {@link emptyEnv} instead, so the routing chain sees
 * no operator override without the process being changed underneath the other
 * parallel workers.
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

/** A minimal GitHubClient that records postComment bodies. */
function fakeClient(
  opts: { failComment?: boolean; existingComments?: string[] } = {},
) {
  const comments: Array<{ issue: number; body: string }> = [];
  const ghClient = {
    postComment: (_repo: string, issue: number, body: string) => {
      if (opts.failComment) return Promise.reject(new Error("comment failed"));
      comments.push({ issue, body });
      return Promise.resolve();
    },
    // Backs the one-stats-comment-per-issue guard (Issue #3756).
    // Issue #1249: the cumulative total counts fleet-authored comments only,
    // so the listing carries the author the fleet options below trust.
    getIssueComments: () =>
      Promise.resolve(
        (opts.existingComments ?? []).map((body) => ({
          body,
          author: "vibe-bot",
        })),
      ),
  } as unknown as GitHubClient;
  return { ghClient, comments };
}

// ---------------------------------------------------------------------------
// buildGrillMeInvocations
// ---------------------------------------------------------------------------

Deno.test("buildGrillMeInvocations - tags the single call with the grill_me phase", () => {
  const invs = buildGrillMeInvocations({ runStats: runStats(["fable"]) });
  assertEquals(invs.length, 1);
  assertEquals(invs[0]!.phase, GRILL_ME_PHASE);
  assertEquals(invs[0]!.runStats?.servedModels, ["fable"]);
});

Deno.test("buildGrillMeInvocations - omits absent runStats and fallbackModel", () => {
  const invs = buildGrillMeInvocations({});
  assertEquals(invs.length, 1);
  assertEquals(invs[0]!.runStats, undefined);
  assertEquals(invs[0]!.fallbackModel, undefined);
});

Deno.test("buildGrillMeInvocations - carries the fallbackModel", () => {
  const invs = buildGrillMeInvocations({ fallbackModel: "opus" });
  assertEquals(invs[0]!.fallbackModel, "opus");
});

// ---------------------------------------------------------------------------
// reportGrillMeDegradation — healthy path
// ---------------------------------------------------------------------------

// Behaviour change (Issue #3756): a healthy round no longer stays completely
// silent — it posts the issue's single cost/model stats comment. The "no
// label" half of the original assertion is unchanged.
Deno.test("reportGrillMeDegradation - fable-served round is not degraded; no label, one stats comment", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportGrillMeDegradation({
    repo: "owner/repo",
    issueNumber: 5,
    claudeResult: { runStats: runStats(["claude-fable-5-20250101"]) },
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assertEquals(verdict.degraded, false);
  assertEquals(addLabelCalls.length, 0);
  assertEquals(comments.length, 1);
  assertStringIncludes(comments[0]!.body, "## Grill-me run model stats");
  assertStringIncludes(comments[0]!.body, "Estimate only");
});

Deno.test("reportGrillMeDegradation - healthy round posts at most one stats comment per run", async () => {
  resetModelResolution();
  const { ghCommandFn } = fakeGh();
  const { ghClient, comments } = fakeClient({
    existingComments: [
      `${
        buildIssueRunStatsMarker(getRunId())
      }\n## Grill-me run model stats\n\n- **Degraded:** no`,
    ],
  });
  const { logger } = recordingLogger();

  await reportGrillMeDegradation({
    repo: "owner/repo",
    issueNumber: 5,
    claudeResult: { runStats: runStats(["claude-fable-5-20250101"]) },
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assertEquals(comments.length, 0);
});

Deno.test("reportGrillMeDegradation - an earlier round's stats comment does not hide this round's cost (Issue #797)", async () => {
  resetModelResolution();
  const { ghCommandFn } = fakeGh();
  const { ghClient, comments } = fakeClient({
    existingComments: [
      "## Grill-me run model stats\n\n- **Estimated cost (USD, estimate only):** ~$1.34",
    ],
  });
  const { logger } = recordingLogger();

  await reportGrillMeDegradation({
    repo: "owner/repo",
    issueNumber: 5,
    claudeResult: { runStats: runStats(["claude-fable-5-20250101"]) },
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
    authorOptions: { fleetAuthors: ["vibe-bot"] },
  });

  assertEquals(comments.length, 1);
  assertStringIncludes(comments[0]!.body, "## Grill-me run model stats");
  assertStringIncludes(comments[0]!.body, "Issue total across 2 run-stats");
});

// ---------------------------------------------------------------------------
// reportGrillMeDegradation — degraded paths
// ---------------------------------------------------------------------------

Deno.test("reportGrillMeDegradation - opus-served round is degraded; labels the issue + posts stats", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportGrillMeDegradation({
    repo: "owner/repo",
    issueNumber: 9,
    claudeResult: { runStats: runStats(["claude-opus-4-8"]) },
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded, "opus served when fable expected must be degraded");
  // Only the grill-me issue is labelled — no sub-issues on a grill-me round.
  assertEquals(addLabelCalls.length, 1);
  assertEquals(addLabelCalls[0]!.issue, 9);
  assertEquals(addLabelCalls[0]!.label, DEGRADED_MODEL_LABEL);
  // The stats block is posted as the visible explanation.
  assertEquals(comments.length, 1);
  assertEquals(comments[0]!.issue, 9);
  assertStringIncludes(comments[0]!.body, "## Grill-me run model stats");
  assertStringIncludes(comments[0]!.body, "claude-opus-4-8");
  assertStringIncludes(comments[0]!.body, "Degraded:");
});

Deno.test("reportGrillMeDegradation - explicit pre-flight flag is degraded even when served matches expected (Issue #3232)", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportGrillMeDegradation({
    repo: "owner/repo",
    issueNumber: 21,
    // Served fable (matches expected), but the pre-flight reroute flag is set.
    claudeResult: {
      runStats: runStats(["claude-fable-5-20250101"]),
      preflightDegraded: true,
      preflightDegradedReason: "fable-unavailable (pre-flight health probe)",
    },
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded, "explicit pre-flight flag must force degraded");
  assertStringIncludes(verdict.reason ?? "", "pre-flight");
  assertEquals(addLabelCalls.length, 1);
  assertEquals(comments.length, 1);
});

Deno.test("reportGrillMeDegradation - rate-limit fallbackModel round is degraded", async () => {
  resetModelResolution();
  const { ghCommandFn, addLabelCalls } = fakeGh();
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  const verdict = await reportGrillMeDegradation({
    repo: "owner/repo",
    issueNumber: 11,
    claudeResult: { runStats: runStats(["fable"]), fallbackModel: "opus" },
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded);
  assertStringIncludes(verdict.reason ?? "", "fallback");
  assertEquals(addLabelCalls.length, 1);
  assertEquals(comments.length, 1);
});

// ---------------------------------------------------------------------------
// Non-fatal behaviour
// ---------------------------------------------------------------------------

Deno.test("reportGrillMeDegradation - comment failure is non-fatal", async () => {
  resetModelResolution();
  const { ghCommandFn } = fakeGh();
  const { ghClient } = fakeClient({ failComment: true });
  const { logger, warnings } = recordingLogger();

  // Must not throw despite the comment failure.
  const verdict = await reportGrillMeDegradation({
    repo: "owner/repo",
    issueNumber: 3,
    claudeResult: { runStats: runStats(["claude-opus-4-8"]) },
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded);
  assert(
    warnings.some((w) => w.includes("Failed to post grill-me stats comment")),
    "expected a non-fatal comment-failure warning",
  );
});

Deno.test("reportGrillMeDegradation - label failure is non-fatal", async () => {
  resetModelResolution();
  const { ghCommandFn } = fakeGh({ failAdd: true });
  const { ghClient, comments } = fakeClient();
  const { logger } = recordingLogger();

  // Must not throw despite the add-label failure; stats still post.
  const verdict = await reportGrillMeDegradation({
    repo: "owner/repo",
    issueNumber: 4,
    claudeResult: { runStats: runStats(["claude-opus-4-8"]) },
    ghClient,
    runGhCommand: ghCommandFn,
    logger,
    cacheDir: Deno.makeTempDirSync(),
    env: emptyEnv,
  });

  assert(verdict.degraded);
  assertEquals(comments.length, 1);
});
