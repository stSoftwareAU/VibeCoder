/**
 * Per-tier PR-feedback telemetry (Issue #3404).
 *
 * Drives the real `processPrFeedback` entry point: a run in which the agent ran
 * records ONE run for the tier named in the PR body's marker, priced from
 * every invocation; a run that never reached the agent records nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import type { IssueSubAgentTier } from "../types.ts";
import { buildSubAgentTierMarker } from "../lib/pr_body.ts";
import { estimatePhaseRunUsd } from "../lib/phase_run_usd.ts";
import { DEFAULT_CLAUDE_MODEL } from "../lib/config_defaults.ts";
import {
  getFleetTelemetry,
  resetFleetTelemetry,
} from "../lib/fleet_telemetry.ts";
import type { RunStats } from "../lib/run_stats.ts";
import { rtkSeam } from "./support/rtk_seam.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/** Run stats carrying token usage, so the invocation is priceable. */
function statsWith(inputTokens: number, outputTokens: number): RunStats {
  return {
    servedModels: [],
    requestedModel: DEFAULT_CLAUDE_MODEL,
    tokenUsage: {
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    wallClockMs: 1000,
  };
}

/** What the PR body read answers: a body, or a throw. */
type BodyAnswer = { body: string } | { throws: true };

function bodyWithTier(tier: IssueSubAgentTier): BodyAnswer {
  return { body: `Fixes #7\n\n${buildSubAgentTierMarker(tier)}\n` };
}

function ghFor(body: BodyAnswer, prState = "OPEN") {
  return (args: string[]): Promise<string> => {
    if (isPrLiveStateRead(args)) {
      return Promise.resolve(
        `{"autoMergeRequest":null,"mergeStateStatus":"DIRTY","mergeable":"CONFLICTING","state":"${prState}"}`,
      );
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("body")) {
      return "throws" in body
        ? Promise.reject(new Error("gh: HTTP 502"))
        : Promise.resolve(JSON.stringify({ body: body.body }));
    }
    return Promise.resolve("");
  };
}

function telemetryFor(tier: IssueSubAgentTier) {
  const t = getFleetTelemetry();
  return tier === "haiku"
    ? { runs: t.prFeedbackRunsHaiku, usd: t.prFeedbackUsdHaiku }
    : { runs: t.prFeedbackRunsSonnet, usd: t.prFeedbackUsdSonnet };
}

async function runFeedback(options: {
  body: BodyAnswer;
  prState?: string;
  /** Fail every git command, so the PR branch cannot be prepared. */
  gitFails?: boolean;
  stats: RunStats | undefined;
}): Promise<{ invocations: number }> {
  let invocations = 0;
  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: (() => {
      invocations++;
      return Promise.resolve({
        ok: true,
        value: {
          output: "Fixed the typo",
          exitCode: 0,
          timedOut: false,
          ...(options.stats ? { runStats: options.stats } : {}),
        },
      });
    }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    prepareRtkRun: rtkSeam([]).prepare,
  };
  const deps = createMockDeps({
    claude: mockClaude,
    github: {
      runGhCommand: ghFor(options.body, options.prState),
    } as Partial<GitHubDeps>,
    git: {
      ...(options.gitFails
        ? {
          runGitCommand: (() =>
            Promise.resolve({
              ok: true,
              value: { code: 128, stdout: "", stderr: "fatal: no checkout" },
            })) as unknown as GitDeps["runGitCommand"],
        }
        : {}),
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: false,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
    },
  });
  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/tier-3404-feedback-clone",
    workRoot: "/tmp/tier-3404-feedback-work",
    rtkOutputEnabled: false,
    codegraphContextEnabled: false,
    verifyPushFn: () =>
      Promise.resolve({
        landed: true,
        localSha: "f".repeat(40),
        remoteSha: "f".repeat(40),
        reason: "verified in test",
      }),
  };
  await processPrFeedback({
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    commentType: "review",
    commentId: "123",
    commentBody: "Please fix the typo on line 10",
  }, processorDeps);
  return { invocations };
}

const NAME = "pr_feedback_processor tier telemetry";

Deno.test(`${NAME} - a haiku PR records one haiku run priced from its stats (Issue #3404)`, async () => {
  resetFleetTelemetry();
  const stats = statsWith(200_000, 50_000);
  const { invocations } = await runFeedback({
    body: bodyWithTier("haiku"),
    stats,
  });
  assertEquals(invocations, 1);
  const haiku = telemetryFor("haiku");
  assertEquals(haiku.runs, 1);
  assert(haiku.usd > 0);
  assertEquals(
    haiku.usd,
    estimatePhaseRunUsd([stats], DEFAULT_CLAUDE_MODEL),
  );
  assertEquals(telemetryFor("sonnet"), { runs: 0, usd: 0 });
});

Deno.test(`${NAME} - a body with no marker is a sonnet PR (Issue #3404)`, async () => {
  resetFleetTelemetry();
  const stats = statsWith(100_000, 10_000);
  await runFeedback({ body: { body: "Fixes #7" }, stats });
  const sonnet = telemetryFor("sonnet");
  assertEquals(sonnet.runs, 1);
  assertEquals(sonnet.usd, estimatePhaseRunUsd([stats], DEFAULT_CLAUDE_MODEL));
  assertEquals(telemetryFor("haiku"), { runs: 0, usd: 0 });
});

Deno.test(`${NAME} - an unreadable body records nothing (Issue #3404)`, async () => {
  resetFleetTelemetry();
  const { invocations } = await runFeedback({
    body: { throws: true },
    stats: statsWith(100_000, 10_000),
  });
  assertEquals(invocations, 1, "the agent did run");
  assertEquals(telemetryFor("sonnet"), { runs: 0, usd: 0 });
  assertEquals(telemetryFor("haiku"), { runs: 0, usd: 0 });
});

Deno.test(`${NAME} - a PR closed before the agent runs records nothing (Issue #3404)`, async () => {
  resetFleetTelemetry();
  const { invocations } = await runFeedback({
    body: bodyWithTier("haiku"),
    prState: "CLOSED",
    stats: statsWith(100_000, 10_000),
  });
  assertEquals(invocations, 0);
  assertEquals(telemetryFor("haiku"), { runs: 0, usd: 0 });
  assertEquals(telemetryFor("sonnet"), { runs: 0, usd: 0 });
});

Deno.test(`${NAME} - a run that fails before the agent is invoked records nothing (Issue #3404)`, async () => {
  resetFleetTelemetry();
  // The claim and heartbeat succeed, then the PR branch cannot be checked
  // out, so the run ends without ever reaching the agent.
  const { invocations } = await runFeedback({
    body: bodyWithTier("haiku"),
    gitFails: true,
    stats: statsWith(100_000, 10_000),
  });
  assertEquals(invocations, 0, "the agent must not have been invoked");
  assertEquals(telemetryFor("haiku"), { runs: 0, usd: 0 });
  assertEquals(telemetryFor("sonnet"), { runs: 0, usd: 0 });
});
