import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import { resolveOrchestrationSettings } from "../lib/orchestration/role_config.ts";
import { agentProviderById } from "../lib/agent_provider.ts";
import { runOrchestratedIssueRun } from "../lib/orchestration/issue_run_gate.ts";
import { preflightRole } from "../lib/orchestration/preflight.ts";
import { buildOverridesOnly } from "../setup/config_setup.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";

Deno.test("role settings layer repository fields over the host and clear foreign model defaults", () => {
  assertEquals(
    resolveOrchestrationSettings({
      manager: { provider: "claude", model: "sonnet", effort: "high" },
      executor: { provider: "claude", model: "haiku", effort: "high" },
      reviewer: { provider: "claude", model: "opus" },
    }, {
      manager: {
        provider: "codex",
        model: "gpt-6-astra",
        cli_adapter: "codex",
      },
      executor: { effort: "medium" },
    }),
    {
      manager: { provider: "codex", model: "gpt-6-astra", cliAdapter: "codex" },
      executor: { provider: "claude", model: "haiku", effort: "medium" },
      reviewer: { provider: "claude", model: "opus" },
    },
  );
});

async function withConfig(
  value: unknown,
  run: (path: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/config.json`;
    await Deno.writeTextFile(path, JSON.stringify(value));
    await run(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("role configuration loads host and repository selections and supports config-only rollback", async () => {
  await withConfig({
    allowed_authors: ["operator"],
    repos: ["org/repo"],
    agent_providers: ["claude", "codex"],
    external_orchestration: true,
    external_orchestration_settings: {
      manager: { provider: "claude", model: "sonnet" },
      executor: {
        provider: "codex",
        model: "gpt-6.1-sol",
        cli_adapter: "codex",
      },
      reviewer: { provider: "claude", model: "opus" },
    },
    repo_config: {
      "org/repo": {
        external_orchestration: false,
        external_orchestration_settings: { manager: { effort: "medium" } },
      },
    },
  }, async (path) => {
    const config = await loadConfig(path, { env: () => undefined });
    assertEquals(config.externalOrchestration, true);
    assertEquals(config.repoConfig?.["org/repo"]?.externalOrchestration, false);
    const settings = resolveOrchestrationSettings(
      config.externalOrchestrationSettings,
      config.repoConfig?.["org/repo"]?.externalOrchestrationSettings,
    );
    assertEquals(settings.manager, {
      provider: "claude",
      model: "sonnet",
      effort: "medium",
    });
    assertEquals(settings.executor?.cliAdapter, "codex");
    assertEquals(settings.reviewer?.model, "opus");
  });
});

Deno.test("role configuration refuses malformed repository overrides and disabled providers", async () => {
  for (
    const settings of [
      { manager: { effort: "typo" } },
      { reviewer: { provider: "codex" } },
      { executor: { provider: "claude", cli_adapter: "codex" } },
      { executor: { surprising: true } },
    ]
  ) {
    await withConfig({
      allowed_authors: ["operator"],
      repos: ["org/repo"],
      repo_config: {
        "org/repo": {
          external_orchestration: true,
          external_orchestration_settings: settings,
        },
      },
    }, async (path) => {
      const error = await assertRejects(
        () => loadConfig(path, { env: () => undefined }),
        Error,
      );
      assertStringIncludes(error.message, "orchestration");
    });
  }
});

Deno.test("orchestrated Codex roles use enforced sandboxes and disable further delegation", () => {
  const provider = agentProviderById("codex")!;
  for (const role of ["manager", "executor", "reviewer"] as const) {
    const argv = provider.buildInvocation({
      prompt: "brief",
      orchestrationRole: role,
    });
    assertEquals(
      argv.includes("--dangerously-bypass-approvals-and-sandbox"),
      false,
    );
    assertEquals(
      argv[argv.indexOf("--sandbox") + 1],
      role === "executor" ? "workspace-write" : "read-only",
    );
    assertEquals(argv.includes("features.multi_agent=false"), true);
    assertEquals(argv.includes('approval_policy="never"'), true);
  }
  assertEquals(
    provider.buildInvocation({ prompt: "legacy" }).includes(
      "--dangerously-bypass-approvals-and-sandbox",
    ),
    true,
  );
});

Deno.test("role dispatch supports same-provider and mixed-provider pairings with independent review", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt" }),
    );
    for (
      const [manager, executor] of [["claude", "claude"], ["codex", "codex"], [
        "claude",
        "codex",
      ], ["codex", "claude"]]
    ) {
      const calls: RunClaudeOptions[] = [];
      const checked: string[] = [];
      const result = await runOrchestratedIssueRun({
        claudeOptions: {
          prompt: "brief",
          cwd: dir,
          sessionResumeState: {
            sessionId: "foreign-context",
            phaseCount: 2,
          } as never,
        },
        retryOptions: {},
        workDir: dir,
        workspaceDir: dir,
        repo: "org/repo",
        issueNumber: 3643,
        branch: "role-config",
        brief: "implement requirements",
        settings: {
          manager: { provider: manager, model: "manager-model" },
          executor: { provider: executor, model: "executor-model" },
          reviewer: { provider: "claude", model: "opus" },
        },
      }, {
        stateDir: `${dir}/state`,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token", CODEX_HOME: dir },
        preflight: async (selection) => {
          checked.push(selection.provider);
        },
        runClaudeWithRetry: async (options) => {
          calls.push(options);
          return {
            ok: true,
            value: { exitCode: 0, output: "done", timedOut: false },
          };
        },
      });
      assertEquals(result.ok, true);
      assertEquals(checked, [manager, executor, "claude"]);
      assertEquals(calls.map((call) => call.agentProvider), [
        manager,
        executor,
        "claude",
      ]);
      assertEquals(calls.map((call) => call.model), [
        "manager-model",
        "executor-model",
        "opus",
      ]);
      assertEquals(calls.map((call) => call.lifecycleRole), [
        "manager",
        "executor",
        "reviewer",
      ]);
      assertEquals(
        calls.every((call) =>
          call.sessionResumeState === undefined && call.agents === undefined &&
          call.enableModelFallback === false
        ),
        true,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("subscription and missing CLI preflights fail before a paid invocation", async () => {
  await assertRejects(
    () => preflightRole({ provider: "claude" }, "/tmp", {}),
    Error,
    "requires a fixed-price subscription",
  );
  await assertRejects(
    () =>
      preflightRole({ provider: "claude" }, "/tmp", {
        CLAUDE_CODE_OAUTH_TOKEN: "test-token",
        PATH: "/nonexistent-role-cli",
      }),
    Error,
    "CLI is not runnable",
  );
});

Deno.test("setup preserves explicit role selections and rollback settings", () => {
  const input = {
    external_orchestration: false,
    external_orchestration_settings: {
      reviewer: { provider: "claude", model: "opus" },
    },
    repo_config: { "org/repo": { external_orchestration: true } },
  };
  const output = buildOverridesOnly(input);
  assertEquals(output.external_orchestration, false);
  assertEquals(
    output.external_orchestration_settings,
    input.external_orchestration_settings,
  );
  assertEquals(output.repo_config, input.repo_config);
});

Deno.test("main loop enacts repository role settings, records the treatment and rolls back to native dispatch", async () => {
  const config = buildDefaultWorkerConfig({ includeCodebaseMap: false });
  config.externalOrchestration = true;
  config.externalOrchestrationSettings = {
    executor: { provider: "codex", model: "worker-model" },
  };
  config.repoConfig = {
    "org/repo": {
      externalOrchestrationSettings: {
        reviewer: { provider: "claude", model: "opus" },
      },
    },
  };
  const ctx = {
    repo: "org/repo",
    issueNumber: 3643,
    issueTitle: "Independent roles",
    issueBody: "Implement roles",
    issueComments: "",
    issueLabels: [],
    githubUser: "testbot",
    config,
  };
  const state = (): PhaseState => ({
    branchName: "issue-3643-role-config",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/role-config-fixture",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  });
  let external = 0;
  let native = 0;
  let treatment: unknown;
  const deps = createMockDeps({
    claude: {
      runOrchestratedIssueRun: async (input) => {
        external++;
        assertEquals(input.settings.executor?.model, "worker-model");
        assertEquals(input.settings.reviewer?.model, "opus");
        assertEquals(input.claudeOptions.agents, undefined);
        return {
          ok: true,
          value: { exitCode: 0, output: "done", timedOut: false },
        };
      },
      runClaudeWithRetry: async () => {
        native++;
        return {
          ok: true,
          value: { exitCode: 0, output: "done", timedOut: false },
        };
      },
    },
    infrastructure: {
      recordIssueAssignment: async (input) => {
        treatment = input.roles;
        return {
          assignmentId: "00000000-0000-4000-8000-000000000000",
          cohort: "unassigned",
          reused: false,
        };
      },
    },
    pr: { findExistingPrForIssue: async () => ({ ok: true, value: "" }) },
  });
  await workOnIssueExecuteClaude(ctx, state(), deps);
  assertEquals(external, 1);
  assertEquals(native, 0);
  assertEquals(treatment, [
    { role: "manager", provider: "claude", model: "sonnet", effort: "high" },
    // Moved to Codex, the executor takes Codex's executor default effort;
    // its explicit model still wins (owner decision 2026-10-22).
    {
      role: "executor",
      provider: "codex",
      model: "worker-model",
      effort: "high",
    },
    { role: "reviewer", provider: "claude", model: "opus", effort: "high" },
  ]);
  config.repoConfig["org/repo"]!.externalOrchestration = false;
  await workOnIssueExecuteClaude(ctx, state(), deps);
  assertEquals(external, 1);
  assertEquals(native, 1);
});
