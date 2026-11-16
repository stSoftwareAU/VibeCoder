/**
 * Tests that a billed execute invocation which ends in a typed failure is
 * still recorded on the run totals (Issue #5029).
 *
 * A turn-capped run (Issue #4949) and a refused split run (Issue #5048) are
 * released as `interrupted`, but both were billed. Their error carries the
 * invocation's result, and the phase now records it exactly as the success
 * path records its own, so the completion phase's cost comment and the run
 * callback report what the run spent. An error with no result records nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  EXECUTOR_UNFINISHED_HEADING,
  TURN_LIMIT_REASON_PREFIX,
  workOnIssueExecuteClaude,
} from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  UNFINISHED_ISSUE_EXECUTOR_MESSAGE,
  UnfinishedIssueExecutorError,
} from "../lib/issue_executor_enforcement.ts";
import { AgentTurnLimitError } from "../lib/claude_turn_limit.ts";
import type { GraftContextResult } from "../lib/graft_context.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { WorkerConfig } from "../types.ts";

const ISSUE = 5029;
const BRANCH = "issue-5029-billed-failure-stats";

function runStatsOf(
  tokenUsage = {
    inputTokens: 1200,
    outputTokens: 340,
    cacheCreationTokens: 50,
    cacheReadTokens: 9000,
  },
  toolCallCounts: Record<string, number> = {
    mcp__graft__graft_find_code: 3,
    Bash: 2,
  },
) {
  return {
    servedModels: ["claude-sonnet-4-6"],
    requestedModel: "sonnet",
    wallClockMs: 1_535_000,
    tokenUsage,
    toolCallCounts,
  };
}

const FIRST_USAGE = runStatsOf().tokenUsage;
const SECOND_USAGE = {
  inputTokens: 2500,
  outputTokens: 610,
  cacheCreationTokens: 75,
  cacheReadTokens: 14_000,
};

function resultWith(
  output: string,
  stats?: ReturnType<typeof runStatsOf>,
  extra: Record<string, unknown> = {},
) {
  return {
    output,
    exitCode: 0,
    timedOut: false,
    provider: "claude",
    ...(stats ? { runStats: stats } : {}),
    ...extra,
  };
}

function makeConfig(): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), infraRetryBackoffMs: 10 };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: ISSUE,
    issueTitle: "Record the billed invocation of a failed run",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: Error };

interface Run {
  result: Awaited<ReturnType<typeof workOnIssueExecuteClaude>>;
  state: PhaseState;
  invocations: number;
  commits: string[];
}

/** Drive one execute whose agent invocations answer `outcomes` in order. */
async function run(options: {
  outcomes: Outcome[];
  graft?: GraftContextResult;
}): Promise<Run> {
  const repoPath = await Deno.makeTempDir({ prefix: "billed_5029_" });
  const commits: string[] = [];
  let invocations = 0;
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    const state: PhaseState = {
      branchName: BRANCH,
      baseBranch: "main",
      defaultBranch: "main",
      repoPath,
      clarityStatus: "assessed_clear",
      claudeOutput: "",
      executeStartTime: Date.now() - 10_000,
      executeStartHeadSha: "abc123",
      baselineQualityPassed: true,
      baselineQualityOutput: "",
    };
    const ok = (stdout: string) =>
      Promise.resolve({ ok: true, value: { code: 0, stdout, stderr: "" } });
    const deps = createMockDeps({
      claude: {
        runClaudeWithRetry: (() => {
          const outcome = options.outcomes[
            Math.min(invocations, options.outcomes.length - 1)
          ];
          invocations++;
          return Promise.resolve(outcome);
        }) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      ...(options.graft
        ? {
          infrastructure: {
            collectGraftContext: (() =>
              Promise.resolve({ ...options.graft })) as never,
          },
        }
        : {}),
      git: {
        runGitCommand: ((args: string[]) => {
          if (args[0] === "status") return ok(" M worker/deno/lib/parser.ts");
          if (args[0] === "rev-list" && args[1] === "--count") return ok("2\n");
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            return ok("abc123\n");
          }
          if (args[0] === "log") return ok("wip: earlier snapshot\n");
          if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
            return ok(`${BRANCH}\n`);
          }
          return ok("");
        }) as never,
        commitAndPushPending: ((_branch: string, message: string) => {
          commits.push(message);
          return Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: true,
              commitsPushed: 1,
              finalUnpushedCount: 0,
              finalUnpushedSource: "remote-head" as const,
            },
          });
        }) as never,
      },
    });
    const result = await workOnIssueExecuteClaude(
      makeContext(makeConfig()),
      state,
      deps,
    );
    return { result, state, invocations, commits };
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

function categoryOf(result: Run["result"]) {
  return "category" in result ? result.category : undefined;
}

function reasonOf(result: Run["result"]): string {
  return "reason" in result ? result.reason ?? "" : "";
}

function refusal(executionResult?: unknown): Outcome {
  return {
    ok: false,
    error: new UnfinishedIssueExecutorError(
      UNFINISHED_ISSUE_EXECUTOR_MESSAGE,
      executionResult as never,
    ),
  };
}

Deno.test("execute_phase #5029 - each refused split invocation, retry included, is recorded once", async () => {
  const r = await run({
    outcomes: [
      refusal(resultWith("first", runStatsOf(FIRST_USAGE))),
      refusal(resultWith("second", runStatsOf(SECOND_USAGE))),
    ],
  });
  assertEquals(r.invocations, 2);
  const entries = r.state.claudeRunStats ?? [];
  assertEquals(entries.length, 2);
  assertEquals(entries[0]!.runStats?.tokenUsage, FIRST_USAGE);
  assertEquals(entries[1]!.runStats?.tokenUsage, SECOND_USAGE);
  assertEquals(categoryOf(r.result), "interrupted");
  assertStringIncludes(reasonOf(r.result), EXECUTOR_UNFINISHED_HEADING);
  assert(r.commits.length >= 1, "the preserving commit is still made");
});

Deno.test("execute_phase #5029 - a turn-capped run is recorded once and not retried", async () => {
  const r = await run({
    outcomes: [{
      ok: false,
      error: new AgentTurnLimitError(
        "error_max_turns",
        resultWith("capped", runStatsOf(FIRST_USAGE)) as never,
      ),
    }],
  });
  assertEquals(r.invocations, 1);
  const entries = r.state.claudeRunStats ?? [];
  assertEquals(entries.length, 1);
  assertEquals(entries[0]!.runStats?.tokenUsage, FIRST_USAGE);
  assertEquals(entries[0]!.runStats?.servedModels, ["claude-sonnet-4-6"]);
  assertEquals(categoryOf(r.result), "interrupted");
  assert(reasonOf(r.result).startsWith(TURN_LIMIT_REASON_PREFIX));
});

Deno.test("execute_phase #5029 - a typed error whose result has no usage records an entry with no runStats", async () => {
  const r = await run({ outcomes: [refusal(resultWith("no usage"))] });
  assertEquals(r.invocations, 2);
  const entries = r.state.claudeRunStats ?? [];
  assertEquals(entries.length, r.invocations);
  for (const entry of entries) assertEquals(entry.runStats, undefined);
  assertEquals(categoryOf(r.result), "interrupted");
});

Deno.test("execute_phase #5029 - a plain Error records nothing and stays internal_error", async () => {
  const r = await run({
    outcomes: [{ ok: false, error: new Error("spawn failed") }],
  });
  assertEquals((r.state.claudeRunStats ?? []).length, 0);
  assertEquals(categoryOf(r.result), "internal_error");
});

Deno.test("execute_phase #5029 - a credential switch then a refusal records the exhausted and the refused invocations once each", async () => {
  const r = await run({
    outcomes: [
      {
        ok: true,
        value: resultWith("window ran out", runStatsOf(FIRST_USAGE), {
          exitCode: 2,
          usageLimit: { waitSeconds: 600 },
        }),
      },
      refusal(resultWith("refused", runStatsOf(SECOND_USAGE))),
      refusal(resultWith("refused", runStatsOf(SECOND_USAGE))),
    ],
  });
  const entries = r.state.claudeRunStats ?? [];
  // Invocation 1 (exhausted, switch loop), 2 (refused) and the #1550 retry's
  // own refused invocation: the exhausted one is not recorded twice.
  assertEquals(entries[0]!.runStats?.tokenUsage, FIRST_USAGE);
  assertEquals(entries[1]!.runStats?.tokenUsage, SECOND_USAGE);
  assertEquals(entries.length, r.invocations);
  assertEquals(
    entries.filter((e) => e.runStats?.tokenUsage === undefined).length,
    0,
  );
});

Deno.test("execute_phase #5029 - a normal success records exactly one entry", async () => {
  const r = await run({
    outcomes: [{
      ok: true,
      value: resultWith("done", runStatsOf(FIRST_USAGE)),
    }],
  });
  assertEquals(r.invocations, 1);
  const entries = r.state.claudeRunStats ?? [];
  assertEquals(entries.length, 1);
  assertEquals(entries[0]!.runStats?.tokenUsage, FIRST_USAGE);
});

Deno.test("execute_phase #5029 - a refused invocation's and its retry's Graft calls each reach the run's tally once", async () => {
  const r = await run({
    graft: {
      status: "ok",
      enabled: true,
      buildSeconds: 2.2,
      bundleChars: 52,
      nodeCount: 820,
      callEdgeCount: 1204,
      bundle: "export function parseIsoDate(raw: string): number {}",
      graphDir: "/tmp/graft-5029/repo/.git/graft",
    },
    outcomes: [
      refusal(
        resultWith(
          "first",
          runStatsOf(FIRST_USAGE, { mcp__graft__graft_find_code: 3 }),
        ),
      ),
      refusal(
        resultWith(
          "retry",
          runStatsOf(SECOND_USAGE, { mcp__graft__graft_find_code: 4 }),
        ),
      ),
    ],
  });
  assertEquals(r.invocations, 2);
  assertEquals(categoryOf(r.result), "interrupted");
  assertEquals(r.state.graftContext?.queries, 7);
});
