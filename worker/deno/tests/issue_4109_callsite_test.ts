/**
 * Call-site tests for Issue #4109: a non-Claude provider that cannot carry
 * `--agents` is rerouted to Claude when Claude is enabled. A repository pin
 * is stripped and kept (Issue #4346); these tests cover an unpinned host
 * provider.
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
import {
  createDefaultDeps,
  createMockDeps,
} from "../lib/issue_worker_wiring.ts";
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
  setRunProviderOverride,
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

Deno.test("execute_phase - the graft sink receives the rerouted provider on a gemini host (Issue #4109)", async () => {
  // Gemini has no MCP transport, so a gemini run is never handed graft. The
  // planner reroutes it to Claude, which takes the graft MCP server.
  configureHost("gemini");
  try {
    const logs: string[] = [];
    const { ctx, state } = executePhaseFixture(logs);
    const graftContext: GraftContextResult = {
      status: "ok",
      enabled: true,
      graphDir: "/tmp/issue-4109-work/.graft",
    };
    const deps = createMockDeps({
      infrastructure: {
        collectGraftContext: (() => Promise.resolve(graftContext)) as never,
      },
      claude: {
        env: hostEnv("gemini"),
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

    assert(
      logs.some((line) => line.includes("handed to the agent as MCP server")),
      `the graft sink must hand the rerouted run its MCP server, saw: ${
        JSON.stringify(logs)
      }`,
    );
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_phase - the rtk and codegraph sinks receive the rerouted provider (Issue #4109)", async () => {
  configureCodexWithClaude();
  try {
    const logs: string[] = [];
    const { ctx, state } = executePhaseFixture(logs);
    const rtkProviderIds: Array<string | undefined> = [];
    const codegraphProviderIds: string[] = [];
    ctx.config.codegraphContext.enabled = true;
    const deps = createMockDeps({
      claude: {
        env: hostEnv("codex"),
        rtkProviderId: ((selector: string | undefined) => {
          rtkProviderIds.push(selector);
          return selector;
        }) as never,
        prepareCodegraphContext: ((options: { providerId: string }) => {
          codegraphProviderIds.push(options.providerId);
          return Promise.resolve({ status: "failed", enabled: true });
        }) as never,
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
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(rtkProviderIds[0], CLAUDE_PROVIDER_ID);
    assertEquals(codegraphProviderIds[0], CLAUDE_PROVIDER_ID);
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_phase - auth errors are classified with the rerouted provider (Issue #4109)", async () => {
  configureCodexWithClaude();
  try {
    const logs: string[] = [];
    const { ctx, state } = executePhaseFixture(logs);
    const classifiedWith: Array<string | undefined> = [];
    const deps = createMockDeps({
      claude: {
        env: hostEnv("codex"),
        isClaudeAuthError: ((_output: string, providerId?: string) => {
          classifiedWith.push(providerId);
          return true;
        }) as never,
        runClaudeWithRetry: (() =>
          Promise.resolve({
            ok: true,
            value: { output: "boom", exitCode: 1, timedOut: false },
          })) as never,
      },
      git: {
        runGitCommand: () =>
          Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "", stderr: "" },
          }),
      },
      pr: {
        findExistingPrForIssue: (() =>
          Promise.resolve({ ok: true, value: null })) as never,
      },
    });

    await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(
      classifiedWith[0],
      CLAUDE_PROVIDER_ID,
      "a rerouted run's output must be classified by claude, not codex",
    );
  } finally {
    resetProviderConfig();
  }
});

Deno.test("createDefaultDeps - isClaudeAuthError classifies with the named provider (Issue #4109)", () => {
  const { isClaudeAuthError } = createDefaultDeps().claude;
  // A phrase only codex's classifier matches: it is an auth error when codex
  // is named, and not when claude is, whatever the host's active provider.
  const codexOnly = "Please run codex login";
  assertEquals(isClaudeAuthError(codexOnly, "codex"), true);
  assertEquals(isClaudeAuthError(codexOnly, CLAUDE_PROVIDER_ID), false);
  // Claude's own phrasing is still classified by claude when it is named.
  assertEquals(isClaudeAuthError("not logged in", CLAUDE_PROVIDER_ID), true);
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

Deno.test("execute_phase - a health-gate fallback run is stripped on codex, not rerouted to the exhausted claude pool (Issue #4109)", async () => {
  configureCodexWithClaude();
  setRunProviderOverride("codex");
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
    assert(
      runOptions[0]?.agentProvider !== CLAUDE_PROVIDER_ID,
      "the runner must not receive the exhausted claude provider",
    );
    assertEquals(runOptions[0]?.agents, undefined);
    assert(
      logs.some((line) => line.includes("starting the run without sub-agents")),
      `expected the strip warning, saw: ${JSON.stringify(logs)}`,
    );
    assert(!logs.some((line) => line.includes(REROUTE_WARNING)));
  } finally {
    setRunProviderOverride(undefined);
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

Deno.test("execute_claude_phase - a health-gate fallback run reaches the runner stripped, not as claude (Issue #4109)", async () => {
  configureCodexWithClaude();
  setRunProviderOverride("codex");
  try {
    const observed: ClaudePhaseObserved = {
      codegraphProviderIds: [],
      logs: [],
    };

    await runExecuteClaudePhase(
      claudePhaseOptions(),
      claudePhaseDeps(observed, rtkSeam([]), "codex"),
    );

    const run = observed.runOptions;
    assert(run, "the fallback run must reach the runner");
    assert(
      run.agentProvider !== CLAUDE_PROVIDER_ID,
      "the runner must not receive the exhausted claude provider",
    );
    assertEquals(run.agents, undefined);
  } finally {
    setRunProviderOverride(undefined);
    resetProviderConfig();
  }
});

Deno.test("execute_claude_phase - claude not enabled strips agents and disables the split (Issue #4109)", async () => {
  // Codex is the run's provider, Claude is not enabled, and the run asks for
  // the executor split, so it would carry `--agents`. The planner cannot
  // reroute, so it strips the sub-agents instead of letting the runner refuse
  // after the timeout (the planner's `agents-stripped` outcome).
  //
  // Positive control (same fixture, Claude enabled): the planner reroutes to
  // Claude and the run still carries `--agents` with the split on. The reroute
  // itself is also covered by "the runner receives the rerouted provider"
  // above; the control here proves the fixture is not vacuous.
  setConfiguredAgentProviderId("codex");
  setConfiguredEnabledAgentProviderIds(["codex"]);
  try {
    const stripped: ClaudePhaseObserved = {
      codegraphProviderIds: [],
      logs: [],
    };
    await runExecuteClaudePhase(
      claudePhaseOptions(),
      {
        ...claudePhaseDeps(stripped, rtkSeam([]), "codex"),
        env: envFrom({ VIBE_IMAGE_AGENT_PROVIDERS: "codex" }),
      },
    );

    const strippedRun = stripped.runOptions;
    assert(strippedRun, "the stripped run must reach the runner");
    assertEquals(
      strippedRun.agents,
      undefined,
      "a stripped run must carry no --agents definitions",
    );
    assert(
      !strippedRun.issueExecutorSplit,
      `a stripped run must not carry the executor split, saw: ${strippedRun.issueExecutorSplit}`,
    );
    assertEquals(
      strippedRun.agentProvider,
      "codex",
      "a stripped run must stay on codex, not be rerouted",
    );
    assert(
      stripped.logs.some((line) =>
        line.includes(
          "asked the codex provider for sub-agents it cannot carry and claude is not enabled; starting the run without sub-agents",
        )
      ),
      `expected the strip warning naming the cause, saw: ${
        JSON.stringify(stripped.logs)
      }`,
    );
    assertEquals(
      stripped.logs.some((line) => line.includes(REROUTE_WARNING)),
      false,
      "a stripped run must not log a reroute",
    );

    configureCodexWithClaude();
    const control: ClaudePhaseObserved = {
      codegraphProviderIds: [],
      logs: [],
    };
    await runExecuteClaudePhase(
      claudePhaseOptions(),
      claudePhaseDeps(control, rtkSeam([]), "codex"),
    );

    const controlRun = control.runOptions;
    assert(
      controlRun?.agents,
      "the Claude-enabled control must carry --agents",
    );
    assertEquals(
      controlRun.issueExecutorSplit,
      true,
      "the Claude-enabled control must carry the executor split",
    );
    assertEquals(
      controlRun.agentProvider,
      CLAUDE_PROVIDER_ID,
      "the Claude-enabled control must be rerouted to claude",
    );
    assert(
      control.logs.some((line) => line.includes(REROUTE_WARNING)),
      `the Claude-enabled control must log the reroute, saw: ${
        JSON.stringify(control.logs)
      }`,
    );
  } finally {
    resetProviderConfig();
  }
});
