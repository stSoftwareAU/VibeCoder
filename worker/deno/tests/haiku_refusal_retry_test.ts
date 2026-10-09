/**
 * Safety-refusal policy for issue runs (Issue #3406): a refusal is never
 * reported as success or "no changes"; a Haiku refusal on the haiku tier
 * re-runs the execute phase once on sonnet, anything else fails the run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  createMockDeps,
  mockGitHubClient,
} from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { EXPLORER_AGENT_NAME } from "../lib/issue_executor_agents.ts";
import { buildRunStats } from "../lib/run_stats.ts";
import { detectFailureCategory } from "../lib/failure_diagnosis.ts";
import type { PhaseClaudeResult } from "../lib/phase_run_stats.ts";
import {
  type AgentRefusalOutcome,
  buildAgentRefusalLine,
  buildRefusalFailureReason,
  decideRefusalAction,
  REFUSAL_RETRY_TIER,
  refusalsRecordedSince,
} from "../lib/haiku_refusal_retry.ts";
import type { IssueSubAgentTier } from "../types.ts";

const assistant = (model: string) =>
  JSON.stringify({
    type: "assistant",
    message: {
      model,
      content: [{ type: "text", text: "working" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
const refusalEvent = (model: string, category: string) =>
  JSON.stringify({
    type: "system",
    subtype: "model_refusal_no_fallback",
    original_model: model,
    request_id: null,
    api_refusal_category: category,
    content: "The model declined this request.",
    uuid: "u1",
    session_id: "s1",
  });
const resultLine = JSON.stringify({
  type: "result",
  subtype: "success",
  num_turns: 2,
  duration_ms: 10,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const HAIKU_REFUSAL = [
  assistant("claude-opus-5-5"),
  assistant("claude-haiku-5-5"),
  refusalEvent("claude-haiku-5-5", "cyber"),
  resultLine,
].join("\n");
const SONNET_REFUSAL = [
  assistant("claude-opus-5-5"),
  assistant("claude-sonnet-5-5"),
  refusalEvent("claude-sonnet-5-5", "frontier_llm"),
  resultLine,
].join("\n");
const OPUS_REFUSAL = [
  assistant("claude-opus-5-5"),
  refusalEvent("claude-opus-5-5", "cyber"),
  resultLine,
].join("\n");
const CLEAN = [
  assistant("claude-opus-5-5"),
  assistant("claude-haiku-5-5"),
  resultLine,
].join("\n");

/** One scripted agent invocation. */
type Scripted = { stream: string; timedOut?: boolean };

interface Harness {
  result: Awaited<ReturnType<typeof workOnIssueExecuteClaude>>;
  state: PhaseState;
  invocations: Record<string, unknown>[];
  comments: string[];
}

/** Run the execute phase over a scripted sequence of agent streams. */
async function run(
  tier: IssueSubAgentTier,
  script: Scripted[],
  withChanges = true,
): Promise<Harness> {
  const config = buildDefaultWorkerConfig();
  config.issueSubAgentTier = tier;
  config.infraRetryBackoffMs = 0;
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 3406,
    issueTitle: "Refusal",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-3406-refusal",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/haiku-refusal-3406-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const invocations: Record<string, unknown>[] = [];
  const comments: string[] = [];
  const deps = createMockDeps({
    claude: {
      runClaudeWithRetry: ((options: Record<string, unknown>) => {
        const step = script[Math.min(invocations.length, script.length - 1)]!;
        invocations.push(options);
        return Promise.resolve({
          ok: true,
          value: {
            output: step.stream,
            exitCode: step.timedOut ? 124 : 0,
            timedOut: step.timedOut === true,
            runStats: buildRunStats(step.stream, {
              requestedModel: "opus",
              wallClockMs: 1,
            }),
          },
        });
      }) as never,
    },
    git: {
      runGitCommand: ((args: string[]) =>
        Promise.resolve({
          ok: true,
          value: {
            code: 0,
            stdout: withChanges && args[0] === "diff" ? " a.ts | 1 +" : "",
            stderr: "",
          },
        })) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
    github: {
      createClient: () => ({
        ...mockGitHubClient(),
        postComment: (_r: string, _i: number, body: string) => {
          comments.push(body);
          return Promise.resolve(undefined);
        },
      }),
    },
  });
  const result = await workOnIssueExecuteClaude(ctx, state, deps);
  return { result, state, invocations, comments };
}

const onHaikuTier = (options: Record<string, unknown> | undefined) =>
  (options?.agents as Record<string, unknown> | undefined)
    ?.[EXPLORER_AGENT_NAME] !== undefined;

const reasonOf = (r: Harness["result"]) =>
  r.status === "failure" ? r.reason : "";

Deno.test("fixtures - the refusal streams carry the refusals the tests expect", () => {
  assertEquals(
    buildRunStats(HAIKU_REFUSAL, { requestedModel: "opus", wallClockMs: 1 })
      .refusals,
    [{ model: "claude-haiku-5-5", category: "cyber" }],
  );
  assertEquals(
    buildRunStats(CLEAN, { requestedModel: "opus", wallClockMs: 1 }).refusals,
    undefined,
  );
});

Deno.test("execute - a haiku-tier Haiku refusal retries once on sonnet and a clean retry continues (Issue #3406)", async () => {
  const h = await run("haiku", [{ stream: HAIKU_REFUSAL }, { stream: CLEAN }]);

  assertEquals(h.invocations.length, 2);
  assert(onHaikuTier(h.invocations[0]), "first attempt runs on haiku");
  assert(!onHaikuTier(h.invocations[1]), "retry runs on sonnet");
  assertEquals(h.result.status, "continue");
  assertEquals(h.state.agentRefusal, {
    tier: "haiku",
    retry: "succeeded",
    refusals: [{ model: "claude-haiku-5-5", category: "cyber" }],
  });
});

Deno.test("execute - a second refusal on the sonnet retry fails the run with no third attempt (Issue #3406)", async () => {
  const h = await run("haiku", [
    { stream: HAIKU_REFUSAL },
    { stream: SONNET_REFUSAL },
  ]);

  assertEquals(h.invocations.length, 2);
  assertEquals(h.result.status, "failure");
  const reason = reasonOf(h.result);
  assertStringIncludes(reason, "cyber");
  assertStringIncludes(reason, "frontier_llm");
  assert(
    !["timeout", "killed", "rate_limit", "zero_output"].includes(
      detectFailureCategory(reason),
    ),
    `reason must not classify as infrastructure: ${
      detectFailureCategory(reason)
    }`,
  );
  assertEquals(h.state.agentRefusal?.retry, "refused");
  const stats = h.comments.find((c) => c.includes("Safety refusal"));
  assert(stats, "expected a run-stats comment naming the refusal");
  assertStringIncludes(stats, "also refused");
});

Deno.test("execute - a sonnet-tier refusal fails at once without a retry (Issue #3406)", async () => {
  const h = await run("sonnet", [{ stream: SONNET_REFUSAL }, {
    stream: CLEAN,
  }]);

  assertEquals(h.invocations.length, 1);
  assertEquals(h.result.status, "failure");
  assertEquals(h.state.agentRefusal?.retry, "not-retried");
  const stats = h.comments.find((c) => c.includes("Safety refusal"));
  assert(stats, "expected a run-stats comment naming the refusal");
  assertStringIncludes(stats, "frontier_llm");
});

Deno.test("execute - a non-Haiku refusal on the haiku tier is not retried (Issue #3406)", async () => {
  const h = await run("haiku", [{ stream: OPUS_REFUSAL }, { stream: CLEAN }]);

  assertEquals(h.invocations.length, 1);
  assertEquals(h.result.status, "failure");
  assertEquals(h.state.agentRefusal?.retry, "not-retried");
});

for (const tier of ["haiku", "sonnet"] as const) {
  Deno.test(`execute - no refusal on the ${tier} tier runs once, unchanged, with no extra comment (Issue #3406)`, async () => {
    const h = await run(tier, [{ stream: CLEAN }]);

    assertEquals(h.invocations.length, 1);
    assertEquals(h.result, { status: "continue" });
    assertEquals(h.state.agentRefusal, undefined);
    assertEquals(h.comments.length, 0);
  });
}

Deno.test("execute - a refusal on an attempt that ended no_changes fails instead of exiting early (Issue #3406)", async () => {
  const h = await run("sonnet", [{ stream: SONNET_REFUSAL }], false);

  assertEquals(h.invocations.length, 1);
  assertEquals(h.result.status, "failure");
  assertEquals(h.state.agentRefusal?.retry, "not-retried");
});

Deno.test("execute - a no_changes attempt with no refusal still exits early (Issue #3406)", async () => {
  const h = await run("sonnet", [{ stream: CLEAN }], false);

  assertEquals(h.result, { status: "early_exit", reason: "no_changes" });
});

Deno.test("execute - the infrastructure retry after a sonnet retry stays on the sonnet tier (Issue #3406)", async () => {
  const h = await run("haiku", [
    { stream: HAIKU_REFUSAL },
    { stream: "", timedOut: true },
    { stream: CLEAN },
  ]);

  assertEquals(h.invocations.length, 3);
  assert(onHaikuTier(h.invocations[0]));
  assert(!onHaikuTier(h.invocations[1]));
  assert(!onHaikuTier(h.invocations[2]), "the #1550 retry keeps sonnet");
  assertEquals(h.result.status, "continue");
  assertEquals(h.state.agentRefusal?.retry, "succeeded");
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

const cyberHaiku = { model: "claude-haiku-5-5", category: "cyber" };
const llmSonnet = { model: "claude-sonnet-5-5", category: "frontier_llm" };

Deno.test("decideRefusalAction - none, retry-on-sonnet and fail", () => {
  assertEquals(
    decideRefusalAction({ tier: "haiku", refusals: [], alreadyRetried: false }),
    "none",
  );
  assertEquals(
    decideRefusalAction({
      tier: "haiku",
      refusals: [cyberHaiku],
      alreadyRetried: false,
    }),
    "retry-on-sonnet",
  );
  assertEquals(
    decideRefusalAction({
      tier: "haiku",
      refusals: [cyberHaiku],
      alreadyRetried: true,
    }),
    "fail",
  );
  assertEquals(
    decideRefusalAction({
      tier: "sonnet",
      refusals: [cyberHaiku],
      alreadyRetried: false,
    }),
    "fail",
  );
  assertEquals(
    decideRefusalAction({
      tier: "haiku",
      refusals: [llmSonnet],
      alreadyRetried: false,
    }),
    "fail",
  );
  assertEquals(REFUSAL_RETRY_TIER, "sonnet");
});

Deno.test("buildAgentRefusalLine - renders all four retry outcomes and nothing for none", () => {
  assertEquals(buildAgentRefusalLine(undefined), "");
  const base = { tier: "haiku" as const, refusals: [cyberHaiku] };
  assertEquals(
    buildAgentRefusalLine({ ...base, retry: "not-retried" }),
    "- **Safety refusal:** `cyber` from `claude-haiku-5-5` on the `haiku` sub-agent tier — not retried; the run failed",
  );
  assertEquals(
    buildAgentRefusalLine({ ...base, retry: "ran" }),
    "- **Safety refusal:** `cyber` from `claude-haiku-5-5` on the `haiku` sub-agent tier — a retry ran on the `sonnet` tier",
  );
  assertEquals(
    buildAgentRefusalLine({ ...base, retry: "succeeded" }),
    "- **Safety refusal:** `cyber` from `claude-haiku-5-5` on the `haiku` sub-agent tier — a retry ran on the `sonnet` tier and finished without a refusal",
  );
  assertEquals(
    buildAgentRefusalLine({
      ...base,
      retry: "refused",
      retryRefusals: [llmSonnet],
    }),
    "- **Safety refusal:** `cyber` from `claude-haiku-5-5` on the `haiku` sub-agent tier — a retry ran on the `sonnet` tier and also refused (`frontier_llm` from `claude-sonnet-5-5`); the run failed",
  );
});

Deno.test("buildRefusalFailureReason - names both refusals and avoids infrastructure wording", () => {
  const notRetried: AgentRefusalOutcome = {
    tier: "sonnet",
    refusals: [llmSonnet, cyberHaiku],
    retry: "not-retried",
  };
  const refused: AgentRefusalOutcome = {
    tier: "haiku",
    refusals: [cyberHaiku],
    retry: "refused",
    retryRefusals: [llmSonnet],
  };
  const a = buildRefusalFailureReason(notRetried);
  assertStringIncludes(a, "`sonnet` sub-agent tier");
  assertStringIncludes(
    a,
    "`frontier_llm` from `claude-sonnet-5-5`, `cyber` from `claude-haiku-5-5`",
  );
  assertStringIncludes(a, "not retried");
  const b = buildRefusalFailureReason(refused);
  assertStringIncludes(b, "`cyber` from `claude-haiku-5-5`");
  assertStringIncludes(
    b,
    "also refused — `frontier_llm` from `claude-sonnet-5-5`",
  );
  for (const text of [a, b]) {
    assertStringIncludes(text, "Issue #3406");
    assert(
      !/timeout|timed out|rate limit|usage limit|SIGKILL|SIGTERM|zero output|interrupted/i
        .test(text),
    );
  }
});

Deno.test("refusalsRecordedSince - flattens only the results from the index on", () => {
  const stats = (refusals?: typeof cyberHaiku[]): PhaseClaudeResult => ({
    runStats: {
      servedModels: [],
      requestedModel: "opus",
      wallClockMs: 1,
      ...(refusals ? { refusals } : {}),
    },
  });
  const results = [stats([cyberHaiku]), stats(), stats([llmSonnet]), {}];
  assertEquals(refusalsRecordedSince(results, 0), [cyberHaiku, llmSonnet]);
  assertEquals(refusalsRecordedSince(results, 1), [llmSonnet]);
  assertEquals(refusalsRecordedSince(results, 4), []);
  assertEquals(refusalsRecordedSince(undefined, 0), []);
});
