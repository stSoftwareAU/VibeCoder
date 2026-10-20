import { assert, assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { PhaseState } from "../lib/issue_worker_types.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";
import {
  AllocationAdmissionError,
  type IssueAllocationSelection,
} from "../lib/subscription_allocation_runtime.ts";
import type { IssueAssignmentInput } from "../lib/issue_assignment.ts";

async function run(selection: IssueAllocationSelection | Error) {
  const config = buildDefaultWorkerConfig({
    includeCodebaseMap: false,
    claudeModel: "opus",
    issueSubAgentTier: "sonnet",
  });
  const ctx = {
    config,
    repo: "org/repo",
    issueNumber: 3646,
    issueTitle: "Allocate",
    issueBody: "Use the trial",
    issueComments: "",
    issueLabels: [],
    githubUser: "worker",
  };
  const state: PhaseState = {
    branchName: "issue-3646-allocation",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/allocation-phase",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  let native: RunClaudeOptions | undefined;
  let external: unknown;
  let assignment: IssueAssignmentInput | undefined;
  const deps = createMockDeps({
    infrastructure: {
      resolveIssueAllocation: async () => {
        if (selection instanceof Error) throw selection;
        return selection;
      },
      recordIssueAssignment: async (input) => {
        assignment = input;
        return {
          assignmentId: "00000000-0000-4000-8000-000000000001",
          cohort: input.cohort ?? "unassigned",
          reused: false,
        };
      },
    },
    claude: {
      runClaudeWithRetry: async (options) => {
        native = options;
        return {
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        };
      },
      runOrchestratedIssueRun: async (input) => {
        external = input.settings;
        return {
          ok: true,
          value: { output: "done", exitCode: 0, timedOut: false },
        };
      },
    },
    pr: { findExistingPrForIssue: async () => ({ ok: true, value: "" }) },
  });
  const result = await workOnIssueExecuteClaude(ctx, state, deps);
  return { result, native, external, assignment };
}

Deno.test("allocation control keeps native Claude Sonnet/Haiku and records the assigned cohort", async () => {
  const observed = await run({
    cohort: "sonnet-haiku",
    external: false,
    settings: {},
  });
  assertEquals(observed.external, undefined);
  assertEquals(observed.native?.agentProvider, "claude");
  assertEquals(observed.native?.model, "sonnet");
  assertEquals(observed.native?.enableModelFallback, false);
  assertEquals(observed.native?.agents?.executor?.model, "haiku");
  assertEquals(observed.assignment?.cohort, "sonnet-haiku");
  assertEquals(
    observed.assignment?.roles.find((role) => role.role === "manager")?.model,
    "sonnet",
  );
});

Deno.test("allocation candidates use independent role dispatch and keep attribution", async () => {
  const settings = {
    manager: { provider: "codex", model: "gpt-5" },
    executor: { provider: "claude", model: "haiku" },
    reviewer: { provider: "claude", model: "opus" },
  };
  const observed = await run({ cohort: "candidate", external: true, settings });
  assertEquals(observed.native, undefined);
  assertEquals(observed.external, settings);
  assertEquals(observed.assignment?.cohort, "candidate");
  assertEquals(
    observed.assignment?.roles.find((role) => role.role === "manager")
      ?.provider,
    "codex",
  );
});

Deno.test("allocation refusal is declared before invocation and cannot be reclassified by quoted text", async () => {
  const bad = await run(new Error("SIGKILL rate limit timeout"));
  assert(bad.result.status === "failure");
  assertEquals(bad.result.category, "repo_config");
  assertEquals(bad.native, undefined);
  assertEquals(bad.external, undefined);
  assertEquals(bad.assignment, undefined);
  const unavailable = await run(new AllocationAdmissionError());
  assert(unavailable.result.status === "failure");
  assertEquals(unavailable.result.category, "rate_limit");
  assertEquals(unavailable.native, undefined);
});
