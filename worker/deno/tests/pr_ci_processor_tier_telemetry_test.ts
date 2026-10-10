/**
 * Per-tier CI-fix telemetry (Issue #3404).
 *
 * Drives the real `processCiFailure` entry point: a run in which the agent ran
 * records ONE run for the tier named in the PR body's marker, priced from
 * every invocation; a run that never reached the agent records nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
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
    ? { runs: t.ciFixRunsHaiku, usd: t.ciFixUsdHaiku }
    : { runs: t.ciFixRunsSonnet, usd: t.ciFixUsdSonnet };
}

const ANNOTATIONS: CheckAnnotation[] = [
  { path: "tests/main_test.ts", start_line: 42, message: "Assertion failed" },
];

async function runCiFix(options: {
  body: BodyAnswer;
  prState?: string;
  /** Fail every git command, so the PR branch cannot be prepared. */
  gitFails?: boolean;
  /** One entry per agent invocation; two drives the post-quality retry. */
  stats: (RunStats | undefined)[];
}): Promise<{ invocations: number }> {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-ci-3404-" });
  let invocations = 0;
  try {
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() => {
        const runStats = options.stats[invocations++];
        return Promise.resolve({
          ok: true,
          value: {
            output: "Fixed CI",
            exitCode: 0,
            timedOut: false,
            ...(runStats ? { runStats } : {}),
          },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
      prepareRtkRun: rtkSeam([]).prepare,
    };
    const retry = options.stats.length > 1;
    const deps = createMockDeps({
      claude: mockClaude,
      github: {
        runGhCommand: ghFor(options.body, options.prState),
      } as Partial<GitHubDeps>,
      git: {
        runGitCommand: ((args: string[]) =>
          Promise.resolve({
            ok: true,
            value: {
              code: options.gitFails ? 128 : 0,
              stdout: args[0] === "status" && retry ? " M src/broken.ts\n" : "",
              stderr: "",
            },
          })) as unknown as GitDeps["runGitCommand"],
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
    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      codegraphContextEnabled: false,
      rtkOutputEnabled: false,
      ...(retry
        ? {
          qualityGateFn: () =>
            Promise.resolve({
              action: "failed_fixable" as const,
              qualityOutput: "deno check failed",
              retryPrompt: "./quality.sh failing:\ndeno check failed",
            }),
        }
        : {}),
      verifyPushFn: () =>
        Promise.resolve({
          landed: true,
          localSha: "f".repeat(40),
          remoteSha: "f".repeat(40),
          reason: "verified in test",
        }),
    };
    await processCiFailure({
      repo: "org/repo",
      prNumber: 42,
      branchName: "issue-42-fix-bug",
      checkRunId: "67890",
      checkName: "CI / test",
      encodedAnnotations: btoa(JSON.stringify(ANNOTATIONS)),
    }, processorDeps);
    return { invocations };
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

const NAME = "pr_ci_processor tier telemetry";

Deno.test(`${NAME} - a haiku PR records one haiku run priced from its stats (Issue #3404)`, async () => {
  resetFleetTelemetry();
  const stats = statsWith(200_000, 50_000);
  const { invocations } = await runCiFix({
    body: bodyWithTier("haiku"),
    stats: [stats],
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
  await runCiFix({ body: { body: "Fixes #7" }, stats: [stats] });
  const sonnet = telemetryFor("sonnet");
  assertEquals(sonnet.runs, 1);
  assertEquals(sonnet.usd, estimatePhaseRunUsd([stats], DEFAULT_CLAUDE_MODEL));
  assertEquals(telemetryFor("haiku"), { runs: 0, usd: 0 });
});

Deno.test(`${NAME} - an unreadable body records nothing (Issue #3404)`, async () => {
  resetFleetTelemetry();
  const { invocations } = await runCiFix({
    body: { throws: true },
    stats: [statsWith(100_000, 10_000)],
  });
  assertEquals(invocations, 1, "the agent did run");
  assertEquals(telemetryFor("sonnet"), { runs: 0, usd: 0 });
  assertEquals(telemetryFor("haiku"), { runs: 0, usd: 0 });
});

Deno.test(`${NAME} - the post-quality retry is the same run, its USD summed (Issue #3404)`, async () => {
  resetFleetTelemetry();
  const first = statsWith(200_000, 50_000);
  const second = statsWith(80_000, 20_000);
  const { invocations } = await runCiFix({
    body: bodyWithTier("haiku"),
    stats: [first, second],
  });
  assertEquals(invocations, 2, "the retry must have run");
  const haiku = telemetryFor("haiku");
  assertEquals(haiku.runs, 1);
  assertEquals(
    haiku.usd,
    estimatePhaseRunUsd([first, second], DEFAULT_CLAUDE_MODEL),
  );
  assert(haiku.usd > estimatePhaseRunUsd([first], DEFAULT_CLAUDE_MODEL));
});

Deno.test(`${NAME} - a PR closed before the agent runs records nothing (Issue #3404)`, async () => {
  resetFleetTelemetry();
  const { invocations } = await runCiFix({
    body: bodyWithTier("haiku"),
    prState: "CLOSED",
    stats: [statsWith(100_000, 10_000)],
  });
  assertEquals(invocations, 0);
  assertEquals(telemetryFor("haiku"), { runs: 0, usd: 0 });
  assertEquals(telemetryFor("sonnet"), { runs: 0, usd: 0 });
});

Deno.test(`${NAME} - a run that fails before the agent is invoked records nothing (Issue #3404)`, async () => {
  resetFleetTelemetry();
  // The claim and heartbeat succeed, then the PR branch cannot be checked
  // out, so the run ends without ever reaching the agent.
  const { invocations } = await runCiFix({
    body: bodyWithTier("haiku"),
    gitFails: true,
    stats: [statsWith(100_000, 10_000)],
  });
  assertEquals(invocations, 0, "the agent must not have been invoked");
  assertEquals(telemetryFor("haiku"), { runs: 0, usd: 0 });
  assertEquals(telemetryFor("sonnet"), { runs: 0, usd: 0 });
});
