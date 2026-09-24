/**
 * The issue-executor split's call site in the standalone issue phase
 * (Issue #2342, part of #2320).
 *
 * The phase must hand the runner `--agents` definitions only when the
 * `issue_executor_split` key resolves on for this repository, and hand it
 * nothing at all otherwise — an absent value is what keeps a run that did not
 * opt in byte-for-byte the invocation the worker builds today.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ExecuteClaudePhaseDeps,
  type ExecuteClaudePhaseOptions,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import {
  ISSUE_EXECUTOR_AGENT_NAME,
  SPEC_REVIEWER_AGENT_NAME,
  STANDARDS_REVIEWER_AGENT_NAME,
} from "../lib/issue_executor_agents.ts";
import type { RunClaudeOptions } from "../lib/claude_runner.ts";

/** What one phase run handed the runner and the prompt builder. */
interface Observed {
  runOptions?: RunClaudeOptions;
  /** The options the prompt build was given (Issue #2343). */
  promptOptions?: Record<string, unknown>;
}

function createDeps(observed: Observed): ExecuteClaudePhaseDeps {
  return {
    runClaudeWithRetry: (options: RunClaudeOptions) => {
      observed.runOptions = options;
      return Promise.resolve({
        ok: true as const,
        value: { exitCode: 0, output: "done", timedOut: false },
      });
    },
    buildIssuePrompt: () =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "sys", prompt: "user" },
      }),
    buildCachedIssuePrompt: ((options: Record<string, unknown>) => {
      observed.promptOptions = options;
      return Promise.resolve({
        ok: true as const,
        value: {
          systemPrompt: "sys",
          prompt: "---BEGIN UNTRUSTED---\nissue body\n---END UNTRUSTED---",
          promptSha: "a".repeat(64),
          cacheHit: false,
        },
      });
    }) as never,
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

function options(
  overrides: Partial<ExecuteClaudePhaseOptions> = {},
): ExecuteClaudePhaseOptions {
  return {
    repo: "owner/repo",
    issueNumber: 2342,
    issueTitle: "Pass --agents executor definitions",
    issueBody: "Do the thing.",
    issueLabels: "enhancement",
    githubUser: "bot-user",
    branchName: "issue-2342-pass-agents",
    baseBranch: "main",
    milestoneBranch: "",
    clarityStatus: "clear",
    workDir: "/tmp/issue-executor-split-2342",
    includeRecentActivity: false,
    includeCodebaseMap: false,
    ...overrides,
  };
}

/** Run the phase with the given options and report what the runner was given. */
async function runWith(
  overrides: Partial<ExecuteClaudePhaseOptions>,
): Promise<RunClaudeOptions | undefined> {
  return (await observeRun(overrides)).runOptions;
}

/** Run the phase and report everything it handed its dependencies. */
async function observeRun(
  overrides: Partial<ExecuteClaudePhaseOptions>,
): Promise<Observed> {
  const observed: Observed = {};
  await runExecuteClaudePhase(options(overrides), createDeps(observed));
  return observed;
}

Deno.test("execute_claude_phase - the key off hands the runner no sub-agent definitions (Issue #2342)", async () => {
  const runOptions = await runWith({});

  assertEquals(
    runOptions?.agents,
    undefined,
    "an unconfigured host builds exactly the invocation it always has",
  );
});

Deno.test("execute_claude_phase - the host-wide key on hands the runner the Sonnet executor (Issue #2342)", async () => {
  const runOptions = await runWith({ issueExecutorSplit: true });

  const agents = runOptions?.agents;
  assert(agents, "the split run must carry sub-agent definitions");
  assertEquals(Object.keys(agents), [ISSUE_EXECUTOR_AGENT_NAME]);
  const executor = agents[ISSUE_EXECUTOR_AGENT_NAME]!;
  assertEquals(executor.model, "sonnet");
  assertEquals(executor.effort, "medium");
  assertEquals(executor.disallowedTools, ["Agent"]);
});

Deno.test("execute_claude_phase - a per-repo false beats a host-wide true (Issue #2342)", async () => {
  const runOptions = await runWith({
    issueExecutorSplit: true,
    repoConfigs: { "owner/repo": { issueExecutorSplit: false } },
  });

  assertEquals(runOptions?.agents, undefined);
});

Deno.test("execute_claude_phase - a per-repo true beats a host-wide off (Issue #2342)", async () => {
  const runOptions = await runWith({
    repoConfigs: { "owner/repo": { issueExecutorSplit: true } },
  });

  assert(runOptions?.agents, "the repository's own opt-in stands on its own");
  assertEquals(Object.keys(runOptions.agents), [ISSUE_EXECUTOR_AGENT_NAME]);
});

Deno.test("execute_claude_phase - a split run also asks the runner to enforce advisor edits (Issue #2344)", async () => {
  // The guard and the executors are the same decision: a run carrying
  // executors must also carry the hook that keeps the edits inside them.
  const on = await runWith({ issueExecutorSplit: true });
  assertEquals(on?.issueExecutorSplit, true);

  const off = await runWith({});
  assertEquals(
    off?.issueExecutorSplit,
    undefined,
    "a key-off run configures no hook and parses no counts",
  );
});

Deno.test("execute_claude_phase - the key reaches the prompt build as well as the argv (Issue #2343)", async () => {
  // One boolean decides both, so a run cannot carry executors without the
  // advisor/executor block that tells it to use them.
  const on = await observeRun({ issueExecutorSplit: true });
  assertEquals(on.promptOptions?.issueExecutorSplit, true);
  assert(on.runOptions?.agents, "the same run carries the definitions");

  const off = await observeRun({});
  assertEquals(off.promptOptions?.issueExecutorSplit, false);
  assertEquals(off.runOptions?.agents, undefined);
});

// ---------------------------------------------------------------------------
// The reviewer sub-agents (Issue #2575)
// ---------------------------------------------------------------------------

Deno.test("execute_claude_phase - issue_reviewer_agents on hands the runner both reviewers and no executor (Issue #2575)", async () => {
  const runOptions = await runWith({ issueReviewerAgents: true });

  const agents = runOptions?.agents;
  assert(agents, "the reviewer run must carry sub-agent definitions");
  assertEquals(
    Object.keys(agents).sort(),
    [SPEC_REVIEWER_AGENT_NAME, STANDARDS_REVIEWER_AGENT_NAME].sort(),
  );
  assertEquals(agents[SPEC_REVIEWER_AGENT_NAME]!.effort, "medium");
  assertEquals(agents[STANDARDS_REVIEWER_AGENT_NAME]!.effort, "low");
  assertEquals(
    runOptions?.issueExecutorSplit,
    undefined,
    "reviewers alone configure no advisor edit guard",
  );
});

Deno.test("execute_claude_phase - reviewers and the split together carry all three definitions (Issue #2575)", async () => {
  const runOptions = await runWith({
    issueExecutorSplit: true,
    issueReviewerAgents: true,
  });

  assertEquals(
    Object.keys(runOptions?.agents ?? {}).sort(),
    [
      ISSUE_EXECUTOR_AGENT_NAME,
      SPEC_REVIEWER_AGENT_NAME,
      STANDARDS_REVIEWER_AGENT_NAME,
    ].sort(),
  );
  assertEquals(runOptions?.issueExecutorSplit, true);
});
