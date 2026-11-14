/**
 * Call-site wiring of the TokenEconomizer plugin on the implementation spawn
 * (Issue #4956).
 *
 * The plugin reaches the Claude child through two call sites:
 *
 *   - `executeClaudeBody` in lib/phases/execute_phase.ts, the fleet path.
 *   - `executeClaudePhaseBody` in lib/execute_claude_phase.ts, the standalone
 *     command.
 *
 * Each calls `tokenEconomizerSpawnOptions` with `runKind: "implementation"`,
 * spreads the result into the options it hands to `runClaudeWithRetry`, and
 * skips the launch on an external orchestration. The standalone path also
 * skips it when no `tokenEconomizer` option is given.
 *
 * Every test drives the real entry point with a fake `runClaudeWithRetry` that
 * records the options it was called with, so reverting the spread or either
 * guard turns the matching test red.
 *
 * The enabled-path tests hand the launch a plugin directory through the
 * `tokenEconomizerPluginDir` seam: the vendored plugin where it is installed,
 * else a temporary fixture holding only the manifest. So every test runs
 * everywhere, CI included.
 *
 * Australian English throughout (behaviour, recognised, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { executeClaudePhaseCommand } from "../commands/execute_claude_phase.ts";
import { join } from "node:path";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { CLAUDE_PROVIDER_ID } from "../lib/agent_provider.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { TOKEN_ECONOMIZER_PLUGIN_DIR } from "../lib/token_economizer_plugin.ts";
import type { TokenEconomizerConfig, WorkerConfig } from "../types.ts";
import { rtkSeam } from "./support/rtk_seam.ts";

/** Whether the vendored plugin's manifest is installed here. */
const REAL_PLUGIN_PRESENT = ((): boolean => {
  try {
    return Deno.statSync(
      join(TOKEN_ECONOMIZER_PLUGIN_DIR, ".claude-plugin", "plugin.json"),
    ).isFile;
  } catch {
    return false;
  }
})();

/**
 * Runs `fn` with a plugin directory: the vendored plugin when installed, else a
 * temporary fixture holding a minimal manifest, removed afterwards.
 */
async function withPluginDir<T>(
  fn: (pluginDir: string) => Promise<T>,
): Promise<T> {
  if (REAL_PLUGIN_PRESENT) return await fn(TOKEN_ECONOMIZER_PLUGIN_DIR);
  const pluginDir = await Deno.makeTempDir({ prefix: "te_plugin_fixture_" });
  try {
    await Deno.mkdir(join(pluginDir, ".claude-plugin"));
    await Deno.writeTextFile(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "tokeneconomizer-fixture" }),
    );
    return await fn(pluginDir);
  } finally {
    await Deno.remove(pluginDir, { recursive: true }).catch(() => {});
  }
}

/** A host block that is switched on. */
function enabledBlock(): TokenEconomizerConfig {
  return { ...buildDefaultWorkerConfig().tokenEconomizer, enabled: true };
}

/** The same block switched off. */
function disabledBlock(): TokenEconomizerConfig {
  return { ...buildDefaultWorkerConfig().tokenEconomizer, enabled: false };
}

/** Runs `fn` on a fresh temp work directory, removing it afterwards. */
async function withWorkDir<T>(fn: (workDir: string) => Promise<T>): Promise<T> {
  const workDir = await Deno.makeTempDir({ prefix: "te_callsites_" });
  try {
    return await fn(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}

/**
 * Asserts every recorded `runClaudeWithRetry` call carries the launch: the
 * plugin directory and the `TE_TOOLPRUNE=off` variable.
 */
function assertEveryCallLaunched(
  calls: RunClaudeOptions[],
  pluginDir: string,
  label: string,
): void {
  assert(calls.length > 0, `${label}: runClaudeWithRetry was never called`);
  calls.forEach((call, index) => {
    const launch = call.tokenEconomizer;
    assert(
      launch !== undefined,
      `${label}: call ${index} carries no tokenEconomizer`,
    );
    assertEquals(
      launch.pluginDir,
      pluginDir,
      `${label}: call ${index} pluginDir`,
    );
    assertEquals(
      launch.env.TE_TOOLPRUNE,
      "off",
      `${label}: call ${index} TE_TOOLPRUNE`,
    );
  });
}

/** Asserts no recorded `runClaudeWithRetry` call carries a `tokenEconomizer` key. */
function assertNoCallLaunched(calls: RunClaudeOptions[], label: string): void {
  assert(calls.length > 0, `${label}: runClaudeWithRetry was never called`);
  calls.forEach((call, index) => {
    assertEquals(
      Object.hasOwn(call, "tokenEconomizer"),
      false,
      `${label}: call ${index} must carry no tokenEconomizer key`,
    );
  });
}

// ---------------------------------------------------------------------------
// Standalone command: executeClaudePhaseBody (lib/execute_claude_phase.ts)
// ---------------------------------------------------------------------------

/**
 * The phase's dependencies. `runClaudeWithRetry` records its options into
 * `calls`, and so does the external orchestrator, which receives the same
 * implementation options as `claudeOptions`.
 */
function standaloneDeps(
  calls: RunClaudeOptions[],
  pluginDir?: string,
): ExecuteClaudePhaseDeps {
  return {
    ...(pluginDir === undefined ? {} : { tokenEconomizerPluginDir: pluginDir }),
    runClaudeWithRetry: (options: RunClaudeOptions) => {
      calls.push(options);
      return Promise.resolve({
        ok: true as const,
        value: { exitCode: 0, output: "done", timedOut: false },
      });
    },
    runExternalOrchestratedIssueRun: (input) => {
      calls.push(input.claudeOptions);
      return Promise.resolve({
        ok: true as const,
        value: { exitCode: 0, output: "done", timedOut: false },
      });
    },
    prepareRtkRun: rtkSeam([]).prepare,
    prepareCodegraphContext: () =>
      Promise.resolve({
        enabled: false,
        status: "off" as const,
        queries: 0,
      }),
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
    log: () => {},
  };
}

/** The standalone options for one run in `workDir`, with `overrides` applied. */
function standaloneOptions(
  workDir: string,
  overrides: Partial<ExecuteClaudePhaseOptions>,
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 4956,
    issueTitle: "Load TokenEconomizer into the Claude implementation",
    issueBody: "Wire the plugin.",
    issueLabels: "enhancement",
    githubUser: "bot-user",
    branchName: "issue-4956-load-tokeneconomizer",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir,
    includeRecentActivity: false,
    includeCodebaseMap: false,
    agentProvider: CLAUDE_PROVIDER_ID,
    ...overrides,
  };
}

/** Runs the standalone implementation phase and returns what `runClaudeWithRetry` saw. */
async function runStandalone(
  workDir: string,
  overrides: Partial<ExecuteClaudePhaseOptions>,
  pluginDir?: string,
): Promise<RunClaudeOptions[]> {
  const calls: RunClaudeOptions[] = [];
  await runExecuteClaudePhase(
    standaloneOptions(workDir, overrides),
    standaloneDeps(calls, pluginDir),
  );
  return calls;
}

Deno.test({
  name:
    "standalone implementation - an enabled host hands runClaudeWithRetry the plugin directory and TE_TOOLPRUNE=off (Issue #4956)",
  async fn() {
    await withPluginDir((pluginDir) =>
      withWorkDir(async (workDir) => {
        const calls = await runStandalone(workDir, {
          tokenEconomizer: enabledBlock(),
        }, pluginDir);
        assertEveryCallLaunched(calls, pluginDir, "standalone enabled");
      })
    );
  },
});

Deno.test("standalone implementation - an absent tokenEconomizer option passes no tokenEconomizer key (Issue #4956)", async () => {
  await withWorkDir(async (workDir) => {
    const calls = await runStandalone(workDir, {});
    assertNoCallLaunched(calls, "standalone absent");
  });
});

Deno.test("standalone implementation - a disabled tokenEconomizer block passes no tokenEconomizer key (Issue #4956)", async () => {
  await withWorkDir(async (workDir) => {
    const calls = await runStandalone(workDir, {
      tokenEconomizer: disabledBlock(),
    });
    assertNoCallLaunched(calls, "standalone disabled");
  });
});

Deno.test({
  name:
    "standalone implementation - external orchestration passes no tokenEconomizer key, though the same enabled host launches off it (Issue #4956)",
  async fn() {
    await withPluginDir((pluginDir) =>
      withWorkDir(async (workDir) => {
        // Positive control: the same enabled host, not orchestrated, does launch.
        // Without it the absence below could come from a launch that never resolved.
        const control = await runStandalone(workDir, {
          tokenEconomizer: enabledBlock(),
          externalOrchestration: false,
        }, pluginDir);
        assertEveryCallLaunched(control, pluginDir, "standalone control");

        const calls = await runStandalone(workDir, {
          tokenEconomizer: enabledBlock(),
          externalOrchestration: true,
        }, pluginDir);
        assertNoCallLaunched(calls, "standalone external orchestration");
      })
    );
  },
});

// ---------------------------------------------------------------------------
// Fleet path: executeClaudeBody (lib/phases/execute_phase.ts)
// ---------------------------------------------------------------------------

/**
 * Runs the fleet implementation phase for `config` in `workDir` and returns
 * what `runClaudeWithRetry` saw.
 */
async function runFleet(
  workDir: string,
  block: TokenEconomizerConfig,
  externalOrchestration: boolean,
  pluginDir?: string,
): Promise<RunClaudeOptions[]> {
  const config: WorkerConfig = buildDefaultWorkerConfig();
  config.workDir = workDir;
  config.tokenEconomizer = block;
  config.externalOrchestration = externalOrchestration;
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 4956,
    issueTitle: "Load TokenEconomizer into the Claude implementation",
    issueBody: "Wire the plugin.",
    issueLabels: ["enhancement"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-4956-load-tokeneconomizer",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: join(workDir, "repo"),
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const calls: RunClaudeOptions[] = [];
  const deps = createMockDeps({
    claude: {
      ...(pluginDir === undefined
        ? {}
        : { tokenEconomizerPluginDir: pluginDir }),
      runClaudeWithRetry: ((options: RunClaudeOptions) => {
        calls.push(options);
        return Promise.resolve({
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        });
      }) as never,
      prepareRtkRun: rtkSeam([]).prepare as never,
      // The external path hands the same implementation options to the
      // orchestrator as `claudeOptions`, so the recorder reads them from there.
      runOrchestratedIssueRun:
        ((input: { claudeOptions: RunClaudeOptions }) => {
          calls.push(input.claudeOptions);
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
  });
  await workOnIssueExecuteClaude(ctx, state, deps);
  return calls;
}

Deno.test({
  name:
    "fleet implementation - an enabled host hands runClaudeWithRetry the plugin directory and TE_TOOLPRUNE=off (Issue #4956)",
  async fn() {
    await withPluginDir((pluginDir) =>
      withWorkDir(async (workDir) => {
        const calls = await runFleet(workDir, enabledBlock(), false, pluginDir);
        assertEveryCallLaunched(calls, pluginDir, "fleet enabled");
      })
    );
  },
});

Deno.test("fleet implementation - a disabled tokenEconomizer block passes no tokenEconomizer key (Issue #4956)", async () => {
  await withWorkDir(async (workDir) => {
    const calls = await runFleet(workDir, disabledBlock(), false);
    assertNoCallLaunched(calls, "fleet disabled");
  });
});

Deno.test({
  name:
    "fleet implementation - external orchestration passes no tokenEconomizer key, though the same enabled host launches off it (Issue #4956)",
  async fn() {
    await withPluginDir((pluginDir) =>
      withWorkDir(async (workDir) => {
        // Positive control: the same enabled host, not orchestrated, does launch.
        const control = await runFleet(
          workDir,
          enabledBlock(),
          false,
          pluginDir,
        );
        assertEveryCallLaunched(control, pluginDir, "fleet control");

        const calls = await runFleet(workDir, enabledBlock(), true, pluginDir);
        assertNoCallLaunched(calls, "fleet external orchestration");
      })
    );
  },
});

for (const enabled of [false, true]) {
  Deno.test({
    name: `execute-claude-phase command carries the ${
      enabled ? "enabled" : "disabled"
    } host block to the agent (Issue #4956)`,
    async fn() {
      await withPluginDir((pluginDir) =>
        withWorkDir(async (workDir) => {
          const calls: RunClaudeOptions[] = [];
          await executeClaudePhaseCommand.execute(
            {
              repo: "owner/repo",
              "issue-number": 4956,
              "branch-name": "issue-4956",
              "base-branch": "main",
            },
            buildDefaultWorkerConfig({
              workDir,
              includeRecentActivity: false,
              includeCodebaseMap: false,
              tokenEconomizer: { ...enabledBlock(), enabled },
            }),
            standaloneDeps(calls, pluginDir),
          );
          if (enabled) {
            assertEveryCallLaunched(calls, pluginDir, "command enabled");
          } else assertNoCallLaunched(calls, "command disabled");
        })
      );
    },
  });
}
