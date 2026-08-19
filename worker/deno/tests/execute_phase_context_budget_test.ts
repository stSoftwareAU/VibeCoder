/**
 * Tests for the hard context-budget ceiling in the live execute phase
 * (`lib/phases/execute_phase.ts`, Issue #3713).
 *
 * Before this change the budget check was purely observational, so an issue
 * whose prompt kept growing was bounded only by wall-clock while `loop.sh`
 * restarted the worker forever. The phase must now stop *before* the billed
 * Claude invocation and hand the issue to a human.
 */

import { assert, assertEquals } from "@std/assert";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import type { GitHubClient, WorkerConfig } from "../types.ts";

interface StubGhCalls {
  addLabel: Array<{ label: string }>;
  postComment: Array<{ body: string }>;
}

function makeStubGhClient(calls: StubGhCalls): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub: getIssue not implemented");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_repo, _issueNumber, label) => {
      calls.addLabel.push({ label });
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_repo, _issueNumber, body) => {
      calls.postComment.push({ body });
      return Promise.resolve(undefined);
    },
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

function makeConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  return { ...buildDefaultWorkerConfig(), ...overrides };
}

function makeContext(config: WorkerConfig): IssueContext {
  return {
    repo: "org/repo",
    issueNumber: 42,
    issueTitle: "Non-converging issue",
    issueBody: "B".repeat(4000),
    issueLabels: [],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
}

function makeState(): PhaseState {
  return {
    branchName: "issue-42-non-converging",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/test-repo",
    clarityStatus: "not_assessed",
    claudeOutput: "",
    executeStartTime: 0,
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
}

Deno.test(
  "execute_phase - context budget ceiling stops the phase before invoking Claude (Issue #3713)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    // A 0.01% ceiling on a 1M window blocks any realistic prompt.
    const config = makeConfig({ contextBudgetBlockPercent: 0.01 });
    const ctx = makeContext(config);
    const state = makeState();

    let claudeCalls = 0;
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: {
        runClaudeWithRetry: (() => {
          claudeCalls++;
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as never,
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(result.status, "early_exit");
    assertEquals(
      (result as { reason: string }).reason,
      "context_budget_exceeded",
    );
    assertEquals(claudeCalls, 0, "no billed invocation past the ceiling");
    assert(
      calls.addLabel.some((c) => c.label === config.needsHumanLabel),
      "issue marked for human triage",
    );
    assertEquals(calls.postComment.length, 1, "escalation comment posted");
    assert(
      calls.postComment[0]!.body.includes("Context budget ceiling reached"),
      "comment explains why the phase stopped",
    );
    assert(
      calls.postComment[0]!.body.includes("Next step:"),
      "comment tells the human what to do next",
    );
  },
);

Deno.test(
  "execute_phase - a prompt under the ceiling still runs Claude (Issue #3713)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    const ctx = makeContext(makeConfig());
    const state = makeState();

    let claudeCalls = 0;
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: {
        runClaudeWithRetry: (() => {
          claudeCalls++;
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as never,
      },
      git: {
        runGitCommand: (() =>
          Promise.resolve({
            ok: true,
            value: { stdout: "M src/main.ts", stderr: "", exitCode: 0 },
          })) as never,
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(claudeCalls, 1);
    assertEquals(calls.addLabel.length, 0, "no escalation under the ceiling");
  },
);

Deno.test(
  "execute_phase - a zero ceiling restores warn-only behaviour (Issue #3713)",
  async () => {
    const calls: StubGhCalls = { addLabel: [], postComment: [] };
    const ctx = makeContext(makeConfig({ contextBudgetBlockPercent: 0 }));
    const state = makeState();

    let claudeCalls = 0;
    const deps = createMockDeps({
      github: { createClient: () => makeStubGhClient(calls) },
      claude: {
        runClaudeWithRetry: (() => {
          claudeCalls++;
          return Promise.resolve({
            ok: true,
            value: { output: "done", exitCode: 0, timedOut: false },
          });
        }) as never,
      },
      git: {
        runGitCommand: (() =>
          Promise.resolve({
            ok: true,
            value: { stdout: "M src/main.ts", stderr: "", exitCode: 0 },
          })) as never,
      },
    });

    const result = await workOnIssueExecuteClaude(ctx, state, deps);

    assertEquals(result.status, "continue");
    assertEquals(claudeCalls, 1);
    assertEquals(calls.addLabel.length, 0);
  },
);
