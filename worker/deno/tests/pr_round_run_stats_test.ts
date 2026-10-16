/**
 * PR-cycle rounds post their run-stats comment on the PR.
 *
 * Before this, only issue-phase runs (and the planning-shaped ones) posted a
 * `## <Phase> run model stats` comment; a `pr_feedback` or `ci_fix` round fed
 * the per-host tier counters and nothing else, so the cost of a send-back was
 * invisible on GitHub. These tests drive the real `processPrFeedback` and
 * `processCiFailure` entry points with stubbed `gh` and agent calls, and
 * assert both directions:
 *
 * - a completed round posts ONE comment on the PR, with the phase heading, the
 *   run-scoped marker, the tokens and an estimated cost line — a round that
 *   pushed nothing included, because it still spent the tokens;
 * - a failing `gh` post never fails the round, a re-post of the same round
 *   within one run is suppressed, and a different round in the same run still
 *   reports its own cost.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
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
import { DEFAULT_CLAUDE_MODEL } from "../lib/config_defaults.ts";
import { ISSUE_RUN_STATS_MARKER } from "../lib/issue_run_stats_comment.ts";
import type { RunStats } from "../lib/run_stats.ts";
import { rtkSeam } from "./support/rtk_seam.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// Every round in this file belongs to the same worker run: the canonical run
// id is generated once per process and reused, exactly as in production.

/** The fleet the PR total is summed over (Issue #1249, finding 12). */
const FLEET = { fleetAuthors: ["vibe-coder-bot"] };

const COST_LINE = "**Estimated cost (USD, estimate only):** ~$";

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

/** Priceable stats for one invocation, served the default model. */
function stats(): RunStats {
  return {
    servedModels: [DEFAULT_CLAUDE_MODEL],
    requestedModel: DEFAULT_CLAUDE_MODEL,
    tokenUsage: {
      inputTokens: 120_000,
      outputTokens: 30_000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    wallClockMs: 1000,
  };
}

/**
 * A PR thread the `gh` stub reads and writes: `gh pr comment` appends to it,
 * `gh pr view --json comments` lists it — so a second round sees the first
 * round's comment exactly as GitHub would show it.
 */
interface PrThread {
  comments: string[];
  /** Fail every `gh pr comment` that carries a run-stats body. */
  failStatsPost?: boolean;
  /** Run-stats posts attempted, whether or not they landed. */
  statsPostAttempts?: number;
}

function isStatsBody(body: string): boolean {
  return body.includes("run model stats");
}

function ghFor(thread: PrThread) {
  return (args: string[]): Promise<string> => {
    if (isPrLiveStateRead(args)) {
      return Promise.resolve(
        `{"autoMergeRequest":null,"mergeStateStatus":"DIRTY","mergeable":"CONFLICTING","state":"OPEN"}`,
      );
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("comments")) {
      return Promise.resolve(JSON.stringify({
        comments: thread.comments.map((body) => ({
          body,
          author: { login: "vibe-coder-bot" },
        })),
      }));
    }
    if (args[0] === "pr" && args[1] === "view" && args.includes("body")) {
      return Promise.resolve(JSON.stringify({ body: "Fixes #7" }));
    }
    if (args[0] === "pr" && args[1] === "comment") {
      const body = args[args.indexOf("--body") + 1] ?? "";
      if (isStatsBody(body)) {
        thread.statsPostAttempts = (thread.statsPostAttempts ?? 0) + 1;
      }
      if (thread.failStatsPost && isStatsBody(body)) {
        return Promise.reject(new Error("gh: HTTP 502"));
      }
      thread.comments.push(body);
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
}

function statsComments(thread: PrThread): string[] {
  return thread.comments.filter(isStatsBody);
}

function agentStub(output: string): Partial<ClaudeDeps> {
  return {
    runClaudeWithRetry: (() =>
      Promise.resolve({
        ok: true,
        value: { output, exitCode: 0, timedOut: false, runStats: stats() },
      })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    prepareRtkRun: rtkSeam([]).prepare,
  };
}

const VERIFIED_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

function pushOutcome(commitsPushed: number) {
  return (() =>
    Promise.resolve({
      ok: true,
      value: {
        committedNewChanges: commitsPushed > 0,
        commitsPushed,
        finalUnpushedCount: 0,
      },
    })) as unknown as GitDeps["commitAndPushPending"];
}

async function runFeedback(
  thread: PrThread,
  options: { commentId?: string; commitsPushed?: number } = {},
) {
  const deps = createMockDeps({
    claude: agentStub("Fixed the typo"),
    github: { runGhCommand: ghFor(thread) } as Partial<GitHubDeps>,
    git: { commitAndPushPending: pushOutcome(options.commitsPushed ?? 1) },
  });
  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    workDir: "/tmp/pr-round-stats-feedback-clone",
    workRoot: "/tmp/pr-round-stats-feedback-work",
    rtkOutputEnabled: false,
    codegraphContextEnabled: false,
    claimAuthorOptions: FLEET,
    verifyPushFn: VERIFIED_PUSH,
  };
  return await processPrFeedback({
    repo: "org/repo",
    prNumber: 42,
    branchName: "issue-42-fix-bug",
    commentType: "review",
    commentId: options.commentId ?? "123",
    commentBody: "Please fix the typo on line 10",
  }, processorDeps);
}

const ANNOTATIONS: CheckAnnotation[] = [
  { path: "tests/main_test.ts", start_line: 42, message: "Assertion failed" },
];

async function runCiFix(thread: PrThread, checkRunId = "67890") {
  const tmpDir = await Deno.makeTempDir({ prefix: "vibe-ci-round-stats-" });
  try {
    const deps = createMockDeps({
      claude: agentStub("Fixed CI"),
      github: { runGhCommand: ghFor(thread) } as Partial<GitHubDeps>,
      git: {
        runGitCommand: (() =>
          Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          })) as unknown as GitDeps["runGitCommand"],
        commitAndPushPending: pushOutcome(1),
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
      fleetLogins: FLEET.fleetAuthors,
      verifyPushFn: VERIFIED_PUSH,
    };
    return await processCiFailure({
      repo: "org/repo",
      prNumber: 42,
      branchName: "issue-42-fix-bug",
      checkRunId,
      checkName: "CI / test",
      encodedAnnotations: btoa(JSON.stringify(ANNOTATIONS)),
    }, processorDeps);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

/** The shape every PR-round stats comment must carry. */
function assertRoundStatsComment(
  body: string | undefined,
  heading: string,
): asserts body is string {
  assert(body !== undefined, `no ${heading} run-stats comment was posted`);
  assertStringIncludes(body, ISSUE_RUN_STATS_MARKER);
  assertStringIncludes(body, `## ${heading} run model stats`);
  assertStringIncludes(body, `\`${DEFAULT_CLAUDE_MODEL}\``);
  assertStringIncludes(body, "- **Tokens:** input 120,000 · output 30,000");
  assertStringIncludes(body, COST_LINE);
  assertStringIncludes(body, "_Estimate only");
  assert(
    !body.includes("Issue total"),
    "a PR comment must never call its tally an issue total",
  );
}

const NAME = "PR round run stats";

Deno.test(`${NAME} - a pr_feedback round posts its stats comment on the PR`, async () => {
  const thread: PrThread = { comments: [] };
  const result = await runFeedback(thread);
  assert(result.ok);
  const posted = statsComments(thread);
  assertEquals(posted.length, 1);
  assertRoundStatsComment(posted[0], "Pr-feedback");
});

Deno.test(`${NAME} - a pr_feedback round that pushed nothing still reports what it spent`, async () => {
  const thread: PrThread = { comments: [] };
  const result = await runFeedback(thread, { commitsPushed: 0 });
  assert(result.ok);
  assertEquals(result.value.changesPushed, false);
  const posted = statsComments(thread);
  assertEquals(posted.length, 1);
  assertRoundStatsComment(posted[0], "Pr-feedback");
});

Deno.test(`${NAME} - a ci_fix round posts its stats comment on the PR`, async () => {
  const thread: PrThread = { comments: [] };
  const result = await runCiFix(thread);
  assert(result.ok, result.ok ? "" : result.error.message);
  const posted = statsComments(thread);
  assertEquals(posted.length, 1);
  assertRoundStatsComment(posted[0], "Ci-fix");
});

Deno.test(`${NAME} - a failing gh post never fails the round`, async () => {
  const feedbackThread: PrThread = { comments: [], failStatsPost: true };
  const feedback = await runFeedback(feedbackThread);
  assert(feedback.ok, "the feedback round must not fail on a stats post");
  assertEquals(statsComments(feedbackThread).length, 0);
  assertEquals(feedbackThread.statsPostAttempts, 1, "the post was attempted");

  const ciThread: PrThread = { comments: [], failStatsPost: true };
  const ci = await runCiFix(ciThread);
  assert(ci.ok, "the CI-fix round must not fail on a stats post");
  assertEquals(statsComments(ciThread).length, 0);
  assertEquals(ciThread.statsPostAttempts, 1, "the post was attempted");
});

Deno.test(`${NAME} - a re-post of the same round within one run is suppressed`, async () => {
  const thread: PrThread = { comments: [] };
  await runFeedback(thread, { commentId: "555" });
  await runFeedback(thread, { commentId: "555" });
  assertEquals(statsComments(thread).length, 1);

  await runCiFix(thread, "777");
  await runCiFix(thread, "777");
  assertEquals(statsComments(thread).length, 2);
});

Deno.test(`${NAME} - a second round in the same run reports its own cost and the PR total`, async () => {
  const thread: PrThread = { comments: [] };
  await runFeedback(thread, { commentId: "901" });
  await runCiFix(thread, "902");
  const posted = statsComments(thread);
  assertEquals(posted.length, 2, "every round's spend must stay visible");
  const second = posted[1];
  assertRoundStatsComment(second, "Ci-fix");
  assertStringIncludes(second, "- **PR total across 2 run-stats comments:**");
});
