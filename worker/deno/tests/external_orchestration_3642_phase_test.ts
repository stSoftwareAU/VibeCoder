/**
 * The external orchestration gate's call site in the standalone issue phase
 * (Issue #3642).
 *
 * With `externalOrchestration` on, the phase must not build any `--agents`
 * definition, must not resolve the native executor split, and must send the
 * run through the orchestration dependency instead of `runClaudeWithRetry`.
 * With no orchestrator wired it must fail closed, never fall back to the
 * native path. With the switch off, the invocation is what it was before.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  resetAutomaticProviderState,
  setAutomaticProviderRoutingActive,
} from "../lib/provider_auto_state.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  type ExternalIssueRunInput,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import { ISSUE_EXECUTOR_AGENT_NAME } from "../lib/issue_executor_agents.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";

/** What one phase run handed its dependencies. */
interface Observed {
  nativeRunOptions?: RunClaudeOptions;
  externalInput?: ExternalIssueRunInput;
  logs: string[];
}

function createDeps(
  observed: Observed,
  withExternal: boolean,
): ExecuteClaudePhaseDeps {
  const deps: ExecuteClaudePhaseDeps = {
    runClaudeWithRetry: (options: RunClaudeOptions) => {
      observed.nativeRunOptions = options;
      return Promise.resolve({
        ok: true as const,
        value: { exitCode: 0, output: "native", timedOut: false },
      });
    },
    buildIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "sys", prompt: "user" },
      }),
    buildCachedIssuePrompt: (() =>
      Promise.resolve({
        ok: true as const,
        value: {
          systemPrompt: "sys",
          prompt: "---BEGIN UNTRUSTED---\nissue body\n---END UNTRUSTED---",
          promptSha: "a".repeat(64),
          cacheHit: false,
        },
      })) as never,
    validateRepoState: () =>
      Promise.resolve({
        ok: true,
        value: { valid: true, actions: [], warnings: [] },
      }),
    findExistingPrForBranch: () =>
      Promise.resolve({ ok: false, error: new Error("No PR found") }),
    retargetPrToMilestone: () => Promise.resolve({ ok: true, value: "ok" }),
    finalisePr: () => Promise.resolve({ ok: true, value: "ok" }),
    ensureIssueClosedIfPrMerged: () =>
      Promise.resolve({ ok: true, value: undefined }),
    runGitCommand: () => Promise.resolve({ ok: true, value: "" }),
    recordHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    clearHeartbeat: () => Promise.resolve({ ok: true, value: undefined }),
    getPromptsCommit: () => Promise.resolve({ ok: true, value: "abc1234" }),
    log: (message: string) => observed.logs.push(message),
  };
  if (withExternal) {
    deps.runExternalOrchestratedIssueRun = (input: ExternalIssueRunInput) => {
      observed.externalInput = input;
      return Promise.resolve({
        ok: true as const,
        value: { exitCode: 0, output: "orchestrated", timedOut: false },
      });
    };
  }
  return deps;
}

function options(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 3642,
    issueTitle: "External orchestration gate",
    issueBody: "Route the run.",
    issueLabels: "enhancement",
    githubUser: "bot-user",
    branchName: "issue-3642-external-orchestration",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/external-orchestration-3642",
    includeRecentActivity: false,
    includeCodebaseMap: false,
    ...overrides,
  };
}

async function observeRun(
  overrides: Partial<ExecuteClaudePhaseOptions>,
  withExternal: boolean,
): Promise<Observed> {
  const observed: Observed = { logs: [] };
  await runExecuteClaudePhase(
    options(overrides),
    createDeps(observed, withExternal),
  );
  return observed;
}

Deno.test("external orchestration - the switch on routes the run to the orchestrator and not the native call (Issue #3642)", async () => {
  const observed = await observeRun({ externalOrchestration: true }, true);

  assertEquals(
    observed.nativeRunOptions,
    undefined,
    "the single native Claude call must not run on the external path",
  );
  const input = observed.externalInput;
  assert(input, "the orchestrator must receive the run");
  assertEquals(input.issueNumber, 3642);
  assertEquals(input.branch, "issue-3642-external-orchestration");
  assertEquals(input.workspaceDir, "/tmp/external-orchestration-3642/repo");
  // The gate puts its checkpoints beside this work volume, under this repo.
  assertEquals(input.workDir, "/tmp/external-orchestration-3642");
  assertEquals(input.repo, "owner/repo");
  assertEquals(input.claudeOptions.agents, undefined);
  assertEquals(input.claudeOptions.issueExecutorSplit, undefined);
  assertEquals(input.settings, {});
});

Deno.test("external orchestration - the switch on builds no --agents even with the split and reviewers on (Issue #3642)", async () => {
  const observed = await observeRun(
    {
      externalOrchestration: true,
      issueExecutorSplit: true,
      issueReviewerAgents: true,
    },
    true,
  );

  const claudeOptions = observed.externalInput?.claudeOptions;
  assert(claudeOptions, "the orchestrator must receive the Claude options");
  assertEquals(claudeOptions.agents, undefined);
  assertEquals(claudeOptions.issueExecutorSplit, undefined);
  assertEquals(
    observed.logs.some((line) => line.includes(`${ISSUE_EXECUTOR_AGENT_NAME}`)),
    false,
    "no executor definition may be announced on the external path",
  );
});

Deno.test("external orchestration - the switch on passes the validated settings through (Issue #3642)", async () => {
  const settings = {
    manager: { provider: "claude" as const, model: "opus" },
    maxInvocations: 4,
  };
  const observed = await observeRun(
    { externalOrchestration: true, externalOrchestrationSettings: settings },
    true,
  );

  assertEquals(observed.externalInput?.settings, settings);
});

Deno.test("external orchestration - the switch on with no orchestrator wired fails closed (Issue #3642)", async () => {
  const observed: Observed = { logs: [] };
  const result = await runExecuteClaudePhase(
    options({ externalOrchestration: true, issueExecutorSplit: true }),
    createDeps(observed, false),
  );

  assertEquals(
    observed.nativeRunOptions,
    undefined,
    "a missing orchestrator must not fall back to the native run",
  );
  assertEquals(result.action, "failure");
  assertEquals(result.failureType, "execution_error");
  assertStringIncludes(
    result.failureMessage ?? "",
    "no orchestrator is wired (Issue #3642)",
  );
});

Deno.test("external orchestration - the switch off keeps the native call and its sub-agents (Issue #3642)", async () => {
  const observed = await observeRun(
    { externalOrchestration: false, issueExecutorSplit: true },
    true,
  );

  assertEquals(observed.externalInput, undefined);
  const runOptions = observed.nativeRunOptions;
  assert(runOptions, "the native run must still happen when the switch is off");
  const agents = runOptions.agents;
  assert(agents, "the split run must still carry its sub-agent definitions");
  assertEquals(Object.keys(agents), [ISSUE_EXECUTOR_AGENT_NAME]);
});

Deno.test("external orchestration - the switch absent is the same as off (Issue #3642)", async () => {
  const observed = await observeRun({}, true);

  assertEquals(observed.externalInput, undefined);
  assert(observed.nativeRunOptions, "the native run must still happen");
  assertEquals(observed.nativeRunOptions.agents, undefined);
});

Deno.test("automatic Codex issue phase keeps all roles on Codex without native sub-agent definitions", async () => {
  setAutomaticProviderRoutingActive(true);
  try {
    const observed = await observeRun({
      agentProvider: "codex",
      issueExecutorSplit: true,
      issueReviewerAgents: true,
    }, true);
    assertEquals(observed.nativeRunOptions, undefined);
    assert(observed.externalInput);
    assertEquals(observed.externalInput.claudeOptions.agents, undefined);
    assertEquals(
      observed.externalInput.claudeOptions.issueExecutorSplit,
      undefined,
    );
    assertEquals(observed.externalInput.settings.manager?.model, "gpt-6.1-sol");
    assertEquals(observed.externalInput.settings.executor?.model, "gpt-6-luna");
    assertEquals(
      observed.externalInput.settings.reviewer?.model,
      "gpt-6-astra",
    );
  } finally {
    resetAutomaticProviderState();
  }
});
