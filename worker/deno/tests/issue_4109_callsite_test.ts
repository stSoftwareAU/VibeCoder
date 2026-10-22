/**
 * Call-site tests for Issue #4109: a non-Claude provider that cannot carry
 * `--agents` is rerouted to Claude when Claude is enabled.
 *
 * Each changed call site has a test that goes red when that site reverts to
 * the invocation provider:
 *
 *   - execute_phase.ts `workOnIssueExecuteClaude` - the planner's reroute is
 *     applied to the runner and to the recorded assignment.
 *   - execute_claude_phase.ts `runExecuteClaudePhase` - the planner's reroute
 *     reaches the CodeGraph and RTK sinks and the runner.
 *
 * Australian English spelling throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import {
  CLAUDE_PROVIDER_ID,
  setConfiguredAgentProviderId,
  setConfiguredEnabledAgentProviderIds,
} from "../lib/agent_provider.ts";
import { envFrom } from "./support/env_lookup.ts";
import { rtkSeam } from "./support/rtk_seam.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import type { GraftContextResult } from "../lib/graft_context.ts";
import type { IssueAllocationSelection } from "../lib/subscription_allocation_runtime.ts";

const REROUTE_WARNING =
  "rerouting the run to the claude provider (Issue #4109)";

/**
 * Configure a Codex host with Claude enabled alongside it.
 *
 * The installed set is stated through the injected env lookup (`deps.claude.env`
 * / `ExecuteClaudePhaseDeps.env`) so the suite never writes the process
 * environment (Issue #880), and the host's ambient stamp cannot decide the
 * result.
 */
function configureCodexWithClaude(): void {
  configureHost("codex");
}

/**
 * The env lookup stating the installed set `claude,<active>`. The one key,
 * `VIBE_IMAGE_AGENT_PROVIDERS`, is both the container stamp and the
 * installed-set stamp, so it makes `imageAgentProviderIds` return the set.
 */
const hostEnv = (active: string) =>
  envFrom({ VIBE_IMAGE_AGENT_PROVIDERS: `claude,${active}` });

/** Make `active` the host provider, with Claude enabled alongside it. */
function configureHost(active: string): void {
  setConfiguredAgentProviderId(active);
  setConfiguredEnabledAgentProviderIds(["claude", active]);
}

function resetProviderConfig(): void {
  setConfiguredAgentProviderId(undefined);
  setConfiguredEnabledAgentProviderIds(undefined);
}

// ---------------------------------------------------------------------------
// Caller (a): execute_phase.ts workOnIssueExecuteClaude
// ---------------------------------------------------------------------------

function executePhaseFixture(logs: string[]) {
  const config = buildDefaultWorkerConfig();
  config.issueExecutorSplit = true;
  config.issueSubAgentTier = "sonnet";
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 4109,
    issueTitle: "Reroute sub-agent runs",
    issueBody: "Do the thing.",
    issueLabels: ["enhancement"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-4109-reroute",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/issue-4109-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  return { ctx, state, logs };
}

Deno.test("execute_phase - a run asked for sub-agents on codex is rerouted to claude at the runner (Issue #4109)", async () => {
  configureCodexWithClaude();
  try {
    const logs: string[] = [];
    const runOptions: Record<string, unknown>[] = [];
    const { ctx, state } = executePhaseFixture(logs);
    const deps = createMockDeps({
      claude: {
        env: hostEnv("codex"),
        runClaudeWithRetry: ((options: Record<string, unknown>) => {
          runOptions.push(options);
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      logger: {
        info: (message: string) => {
          logs.push(message);
        },
        warn: (message: string) => {
          logs.push(message);
        },
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(runOptions.length >= 1, true, "the agent must be invoked");
    assertEquals(
      runOptions[0]?.agentProvider,
      CLAUDE_PROVIDER_ID,
      "the runner must receive the rerouted provider, not codex",
    );
    assert(
      logs.some((line) => line.includes(REROUTE_WARNING)),
      `expected the reroute warning, saw: ${JSON.stringify(logs)}`,
    );
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_phase - the rerouted provider is recorded on the run assignment (Issue #4109)", async () => {
  configureCodexWithClaude();
  try {
    const logs: string[] = [];
    const requests: Record<string, unknown>[] = [];
    const { ctx, state } = executePhaseFixture(logs);
    const deps = createMockDeps({
      claude: {
        env: hostEnv("codex"),
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          })) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      infrastructure: {
        recordIssueAssignment: ((request: Record<string, unknown>) => {
          requests.push(request);
          return Promise.resolve({
            assignmentId: "assignment-4109",
            cohort: "unassigned",
            reused: false,
          });
        }) as never,
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(requests.length >= 1, true, "an assignment must be recorded");
    assertStringIncludes(
      JSON.stringify(requests[0]),
      `"${CLAUDE_PROVIDER_ID}"`,
      "the assignment must name the rerouted provider",
    );
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_phase - a non-external allocation plans the claude provider (Issue #4109)", async () => {
  configureCodexWithClaude();
  try {
    const logs: string[] = [];
    const runOptions: Record<string, unknown>[] = [];
    const { ctx, state } = executePhaseFixture(logs);
    const allocation: IssueAllocationSelection = {
      cohort: "control",
      external: false,
      settings: {} as IssueAllocationSelection["settings"],
    };
    const deps = createMockDeps({
      infrastructure: {
        resolveIssueAllocation: (() => Promise.resolve(allocation)) as never,
      },
      claude: {
        env: hostEnv("codex"),
        runClaudeWithRetry: ((options: Record<string, unknown>) => {
          runOptions.push(options);
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      logger: {
        info: (message: string) => {
          logs.push(message);
        },
        warn: (message: string) => {
          logs.push(message);
        },
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(runOptions.length >= 1, true, "the agent must be invoked");
    assertEquals(
      runOptions[0]?.agentProvider,
      CLAUDE_PROVIDER_ID,
      "the runner must receive the claude provider for a non-external allocation",
    );
    assertEquals(
      logs.some((line) => line.includes(REROUTE_WARNING)),
      false,
      "a non-external allocation plans claude, which carries sub-agents, so no reroute is logged",
    );
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_phase - with claude not enabled the run starts on codex without sub-agents (Issue #4109)", async () => {
  setConfiguredAgentProviderId("codex");
  setConfiguredEnabledAgentProviderIds(["codex"]);
  try {
    const logs: string[] = [];
    const runOptions: Record<string, unknown>[] = [];
    const { ctx, state } = executePhaseFixture(logs);
    const deps = createMockDeps({
      claude: {
        env: envFrom({ VIBE_IMAGE_AGENT_PROVIDERS: "codex" }),
        runClaudeWithRetry: ((options: Record<string, unknown>) => {
          runOptions.push(options);
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      logger: {
        info: (message: string) => {
          logs.push(message);
        },
        warn: (message: string) => {
          logs.push(message);
        },
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(runOptions.length >= 1, true, "the agent must be invoked");
    assertEquals(
      runOptions[0]?.agents,
      undefined,
      "a stripped run must carry no --agents definitions",
    );
    assert(
      logs.some((line) => line.includes("starting the run without sub-agents")),
      `expected the strip warning, saw: ${JSON.stringify(logs)}`,
    );
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_phase - an external-orchestration run is not planned, so nothing is rerouted (Issue #4109)", async () => {
  configureCodexWithClaude();
  try {
    const logs: string[] = [];
    const { ctx, state } = executePhaseFixture(logs);
    ctx.config.externalOrchestration = true;
    const deps = createMockDeps({
      claude: {
        env: hostEnv("codex"),
        runOrchestratedIssueRun: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          })) as never,
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          })) as never,
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
      logger: {
        info: (message: string) => {
          logs.push(message);
        },
        warn: (message: string) => {
          logs.push(message);
        },
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(
      logs.some((line) => line.includes("(Issue #4109)")),
      false,
      "external orchestration builds no --agents, so the planner stays out",
    );
  } finally {
    resetProviderConfig();
  }
});

// ---------------------------------------------------------------------------
// Caller (b): execute_claude_phase.ts runExecuteClaudePhase
// ---------------------------------------------------------------------------

function claudePhaseOptions(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 4109,
    issueTitle: "Reroute sub-agent runs",
    issueBody: "Do the thing.",
    issueLabels: "enhancement",
    githubUser: "bot-user",
    branchName: "issue-4109-reroute",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/issue-4109-work",
    includeRecentActivity: false,
    includeCodebaseMap: false,
    agentProvider: "codex",
    issueExecutorSplit: true,
    rtkOutputEnabled: true,
    ...overrides,
  } as ExecuteClaudePhaseOptions;
}

interface ClaudePhaseObserved {
  runOptions?: RunClaudeOptions;
  codegraphProviderIds: string[];
  logs: string[];
}

function claudePhaseDeps(
  observed: ClaudePhaseObserved,
  rtk: ReturnType<typeof rtkSeam>,
  active: string,
): ExecuteClaudePhaseDeps {
  return {
    env: hostEnv(active),
    runClaudeWithRetry: (options: RunClaudeOptions) => {
      observed.runOptions = options;
      return Promise.resolve({
        ok: true as const,
        value: { exitCode: 0, output: "done", timedOut: false },
      });
    },
    prepareRtkRun: rtk.prepare,
    prepareCodegraphContext: (options: Record<string, unknown>) => {
      observed.codegraphProviderIds.push(String(options.providerId ?? ""));
      return Promise.resolve({
        enabled: false,
        status: "off" as const,
        queries: 0,
      });
    },
    buildIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "sys", prompt: "user" },
      }),
    buildCachedIssuePrompt: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          systemPrompt: "sys",
          prompt: "---BEGIN UNTRUSTED---\nissue body\n---END UNTRUSTED---",
          promptSha: "a".repeat(64),
          cacheHit: false,
        },
      }),
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
    log: (message: string) => {
      observed.logs.push(message);
    },
  } as unknown as ExecuteClaudePhaseDeps;
}

Deno.test("execute_claude_phase - the rtk sink receives the rerouted provider (Issue #4109)", async () => {
  configureCodexWithClaude();
  try {
    const observed: ClaudePhaseObserved = {
      codegraphProviderIds: [],
      logs: [],
    };
    const rtk = rtkSeam([]);

    await runExecuteClaudePhase(
      claudePhaseOptions(),
      claudePhaseDeps(observed, rtk, "codex"),
    );

    assertEquals(
      rtk.prepared[0]?.providerId,
      CLAUDE_PROVIDER_ID,
      "the RTK sink must see the rerouted provider, not codex",
    );
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_claude_phase - the codegraph sink receives the rerouted provider (Issue #4109)", async () => {
  configureCodexWithClaude();
  try {
    const observed: ClaudePhaseObserved = {
      codegraphProviderIds: [],
      logs: [],
    };
    const rtk = rtkSeam([]);

    await runExecuteClaudePhase(
      claudePhaseOptions({ codegraphContextEnabled: true } as never),
      claudePhaseDeps(observed, rtk, "codex"),
    );

    assert(
      observed.codegraphProviderIds.length >= 1,
      "the codegraph sink must be reached",
    );
    assertEquals(
      observed.codegraphProviderIds[0],
      CLAUDE_PROVIDER_ID,
      "the CodeGraph sink must see the rerouted provider, not codex",
    );
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_claude_phase - the graft sink receives the rerouted provider (Issue #4109)", async () => {
  // Gemini has no MCP transport, so a gemini run is never handed graft. The
  // planner reroutes it to Claude, which takes the graft MCP server.
  configureHost("gemini");
  try {
    const observed: ClaudePhaseObserved = {
      codegraphProviderIds: [],
      logs: [],
    };
    const rtk = rtkSeam([]);
    const graftContext: GraftContextResult = {
      status: "ok",
      enabled: true,
      graphDir: "/tmp/issue-4109-work/.graft",
    };

    await runExecuteClaudePhase(
      claudePhaseOptions({
        agentProvider: "gemini",
        graftContextEnabled: true,
      }),
      {
        ...claudePhaseDeps(observed, rtk, "gemini"),
        collectGraftContext: () => Promise.resolve(graftContext),
      },
    );

    assert(
      observed.logs.some((line) =>
        line.includes("handed to the agent as MCP server")
      ),
      `the graft sink must hand the rerouted run its MCP server, saw: ${
        JSON.stringify(observed.logs)
      }`,
    );
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_claude_phase - the runner receives the rerouted provider (Issue #4109)", async () => {
  configureCodexWithClaude();
  try {
    const observed: ClaudePhaseObserved = {
      codegraphProviderIds: [],
      logs: [],
    };
    const rtk = rtkSeam([]);

    await runExecuteClaudePhase(
      claudePhaseOptions(),
      claudePhaseDeps(observed, rtk, "codex"),
    );

    assertEquals(
      observed.runOptions?.agentProvider,
      CLAUDE_PROVIDER_ID,
      "the runner must receive the rerouted provider, not codex",
    );
  } finally {
    resetProviderConfig();
  }
});
