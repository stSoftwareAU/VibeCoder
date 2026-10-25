/**
 * The main-loop issue run must honour `repo_config.<repo>.agent_provider`
 * (Issue #4346).
 *
 * The pin binds when the invocation names no provider of its own, and it is
 * what the runner, the RTK sink and the run assignment receive. A non-external
 * subscription allocation and a #4109 reroute name a provider for this
 * invocation, so they win over the pin. With no pin, the runner is not handed
 * a provider and keeps the host's active one.
 *
 * Uses Australian English throughout (behaviour, colour).
 */

import { assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import {
  setConfiguredAgentProviderId,
  setConfiguredEnabledAgentProviderIds,
} from "../lib/agent_provider.ts";
import { envFrom } from "./support/env_lookup.ts";
import type { IssueAllocationSelection } from "../lib/subscription_allocation_runtime.ts";
import type { WorkerConfig } from "../types.ts";

/** Image stamp that installs Claude beside DeepSeek, and nothing ambient. */
const hostEnv = envFrom({
  VIBE_IMAGE_AGENT_PROVIDERS: "claude,deepseek",
});

/** A Claude host that also has DeepSeek installed. */
function configureClaudeHost(): void {
  setConfiguredAgentProviderId("claude");
  setConfiguredEnabledAgentProviderIds(["claude", "deepseek"]);
}

function resetProviderConfig(): void {
  setConfiguredAgentProviderId(undefined);
  setConfiguredEnabledAgentProviderIds(undefined);
}

/** Switches that ask for no `--agents`, so a non-Claude pin is not rerouted. */
function withoutSubAgents(config: WorkerConfig): void {
  config.issueExecutorSplit = false;
  config.issueReviewerAgents = false;
  config.issueSubAgentTier = "sonnet";
}

function fixture(
  config: WorkerConfig,
): { ctx: IssueContext; state: PhaseState } {
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 4346,
    issueTitle: "Honour the provider pin",
    issueBody: "Do the thing.",
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-4346-provider-pin",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/issue-4346-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  return { ctx, state };
}

interface ObservedRun {
  agentProvider: unknown;
  rtkSelector: unknown;
  assignmentProvider: string | undefined;
}

/** Run one issue and capture the provider the runner, RTK and assignment saw. */
async function observe(
  config: WorkerConfig,
  allocation?: IssueAllocationSelection,
): Promise<ObservedRun> {
  const { ctx, state } = fixture(config);
  const runOptions: Record<string, unknown>[] = [];
  const rtkSelectors: unknown[] = [];
  const assignmentProviders: Array<string | undefined> = [];
  const deps = createMockDeps({
    infrastructure: {
      ...(allocation
        ? {
          resolveIssueAllocation: (() => Promise.resolve(allocation)) as never,
        }
        : {}),
      recordIssueAssignment: ((request: {
        roles: Array<{ role: string; provider: string }>;
      }) => {
        assignmentProviders.push(
          request.roles.find((role) => role.role === "manager")?.provider,
        );
        return Promise.resolve({
          assignmentId: "assignment-4346",
          cohort: allocation?.cohort ?? "unassigned",
          reused: false,
        });
      }) as never,
    },
    claude: {
      env: hostEnv,
      rtkProviderId: ((selector: unknown) => {
        rtkSelectors.push(selector);
        return typeof selector === "string" ? selector : "claude";
      }) as never,
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
  });

  await workOnIssueExecuteClaude(ctx, state, deps);

  assertEquals(runOptions.length >= 1, true, "the runner must be invoked");
  return {
    agentProvider: runOptions[0]?.agentProvider,
    rtkSelector: rtkSelectors[0],
    assignmentProvider: assignmentProviders[0],
  };
}

Deno.test("execute_phase - a pinned repo's issue run reaches the runner with the pinned provider (Issue #4346)", async () => {
  configureClaudeHost();
  try {
    const config = buildDefaultWorkerConfig();
    withoutSubAgents(config);
    config.repoConfig = { "org/repo": { agentProvider: "deepseek" } };

    const observed = await observe(config);

    assertEquals(observed.agentProvider, "deepseek");
    assertEquals(observed.rtkSelector, "deepseek");
    assertEquals(observed.assignmentProvider, "deepseek");
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_phase - a non-external allocation still forces claude over the repo pin (Issue #4346)", async () => {
  configureClaudeHost();
  try {
    const config = buildDefaultWorkerConfig();
    withoutSubAgents(config);
    config.repoConfig = { "org/repo": { agentProvider: "deepseek" } };
    const allocation: IssueAllocationSelection = {
      cohort: "control",
      external: false,
      settings: {} as IssueAllocationSelection["settings"],
    };

    const observed = await observe(config, allocation);

    assertEquals(observed.agentProvider, "claude");
    assertEquals(observed.rtkSelector, "claude");
    assertEquals(observed.assignmentProvider, "claude");
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_phase - a sub-agent reroute still names claude over the repo pin (Issue #4346)", async () => {
  configureClaudeHost();
  try {
    const config = buildDefaultWorkerConfig();
    config.issueExecutorSplit = true;
    config.issueReviewerAgents = true;
    config.issueSubAgentTier = "sonnet";
    config.repoConfig = { "org/repo": { agentProvider: "deepseek" } };

    const observed = await observe(config);

    assertEquals(observed.agentProvider, "claude");
    assertEquals(observed.rtkSelector, "claude");
    assertEquals(observed.assignmentProvider, "claude");
  } finally {
    resetProviderConfig();
  }
});

Deno.test("execute_phase - an issue run with no repo pin leaves the runner provider unset (Issue #4346)", async () => {
  configureClaudeHost();
  try {
    const config = buildDefaultWorkerConfig();
    withoutSubAgents(config);

    const observed = await observe(config);

    assertEquals(observed.agentProvider, undefined);
    assertEquals(observed.rtkSelector, undefined);
    assertEquals(observed.assignmentProvider, "claude");
  } finally {
    resetProviderConfig();
  }
});
