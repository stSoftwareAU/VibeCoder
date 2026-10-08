/**
 * The issue-executor split in the main-loop execute phase (Issue #2342, part
 * of #2320).
 *
 * The fleet's own issue runs go through this path, so a split wired only on
 * the standalone command path would leave the key inert on every run that
 * matters. These cases hold both directions of the key here: on, the
 * invocation carries the Sonnet executor definitions; off — the default — it
 * carries none, and the argv is what the worker has always built.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import { workOnIssueExecuteClaude } from "../lib/phases/execute_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import {
  EXPLORER_AGENT_NAME,
  ISSUE_EXECUTOR_AGENT_NAME,
  SPEC_REVIEWER_AGENT_NAME,
  STANDARDS_REVIEWER_AGENT_NAME,
} from "../lib/issue_executor_agents.ts";
import type { AgentDefinition } from "../lib/agent_provider.ts";
import type { IssueSubAgentTier } from "../types.ts";

/** Run the phase with the given host and per-repo key, and report the argv options. */
async function runPhase(
  hostEnabled: boolean,
  repoValue?: boolean,
  reviewerAgents = false,
  tierOptions: {
    hostTier?: IssueSubAgentTier;
    repoTier?: unknown;
    logs?: string[];
  } = {},
): Promise<Record<string, unknown> | undefined> {
  const config = buildDefaultWorkerConfig();
  config.issueExecutorSplit = hostEnabled;
  config.issueReviewerAgents = reviewerAgents;
  if (tierOptions.hostTier !== undefined) {
    config.issueSubAgentTier = tierOptions.hostTier;
  }
  if (repoValue !== undefined || tierOptions.repoTier !== undefined) {
    config.repoConfig = {
      "org/repo": {
        ...(repoValue !== undefined ? { issueExecutorSplit: repoValue } : {}),
        ...(tierOptions.repoTier !== undefined
          ? { issueSubAgentTier: tierOptions.repoTier }
          : {}),
      },
    };
  }
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 2342,
    issueTitle: "Pass --agents executor definitions",
    issueBody: "Do the thing.",
    issueLabels: ["enhancement"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-2342-pass-agents",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/issue-executor-split-2342-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  const runOptions: Record<string, unknown>[] = [];
  const logs = tierOptions.logs;

  const deps = createMockDeps({
    claude: {
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
    ...(logs
      ? {
        logger: {
          info: (message: string) => {
            logs.push(message);
          },
          warn: (message: string) => {
            logs.push(message);
          },
        },
      }
      : {}),
  });

  await workOnIssueExecuteClaude(ctx, state, deps);
  return runOptions[0];
}

/** Read the executor definition off a recorded invocation, if it carried one. */
function executorOf(
  options: Record<string, unknown> | undefined,
): AgentDefinition | undefined {
  const agents = options?.agents as
    | Record<string, AgentDefinition>
    | undefined;
  return agents?.[ISSUE_EXECUTOR_AGENT_NAME];
}

Deno.test("execute_phase - the key off hands the agent no sub-agent definitions (Issue #2342)", async () => {
  const options = await runPhase(false);

  assertEquals(
    options?.agents,
    undefined,
    "an unconfigured host builds exactly the invocation it always has",
  );
});

Deno.test("execute_phase - the host-wide key on carries the Sonnet executor (Issue #2342)", async () => {
  const executor = executorOf(await runPhase(true));

  assert(executor, "the split run must carry the executor definition");
  assertEquals(executor.model, "sonnet");
  assertEquals(executor.effort, "medium");
  assertEquals(executor.tools, [
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
    "Bash",
  ]);
  assertEquals(executor.disallowedTools, ["Agent"]);
});

Deno.test("execute_phase - a per-repo false beats a host-wide true (Issue #2342)", async () => {
  const options = await runPhase(true, false);
  assertEquals(options?.agents, undefined);
});

Deno.test("execute_phase - a per-repo true beats a host-wide off (Issue #2342)", async () => {
  const executor = executorOf(await runPhase(false, true));
  assert(executor, "the repository's own opt-in stands on its own");
  assertEquals(executor.model, "sonnet");
});

Deno.test("execute_phase - a split run also asks the agent runner to enforce advisor edits (Issue #2344)", async () => {
  // One decision, two effects: the executors, and the hook that keeps every
  // `Edit`/`Write` inside them.
  assertEquals((await runPhase(true))?.issueExecutorSplit, true);
  assertEquals(
    (await runPhase(false))?.issueExecutorSplit,
    undefined,
    "a key-off run configures no hook and parses no counts",
  );
});

/**
 * The same key reaches the prompt build (Issue #2343).
 *
 * The argv and the prompt are resolved from one boolean, so a run cannot be
 * handed executors without the advisor/executor block that tells it to use
 * them. Recorded here beside the argv cases because the two must agree.
 */
async function promptSplitFlag(
  hostEnabled: boolean,
): Promise<unknown> {
  const config = buildDefaultWorkerConfig();
  config.issueExecutorSplit = hostEnabled;
  const ctx: IssueContext = {
    repo: "org/repo",
    issueNumber: 2343,
    issueTitle: "Advisor/executor instructions",
    issueBody: "Do the thing.",
    issueLabels: ["enhancement"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state: PhaseState = {
    branchName: "issue-2343-advisor-executor",
    baseBranch: "main",
    defaultBranch: "main",
    repoPath: "/tmp/issue-executor-split-2343-repo",
    clarityStatus: "assessed_clear",
    claudeOutput: "",
    executeStartTime: Date.now(),
    baselineQualityPassed: true,
    baselineQualityOutput: "",
  };
  let promptOptions: Record<string, unknown> | undefined;

  const deps = createMockDeps({
    infrastructure: {
      buildPrompt: ((options: Record<string, unknown>) => {
        promptOptions = options;
        return Promise.resolve({
          ok: true,
          value: { systemPrompt: "sys", prompt: "user" },
        });
      }) as never,
    },
    pr: {
      findExistingPrForIssue: (() =>
        Promise.resolve({ ok: true, value: null })) as never,
    },
  });

  await workOnIssueExecuteClaude(ctx, state, deps);
  return promptOptions?.issueExecutorSplit;
}

Deno.test("execute_phase - the key reaches the prompt build as well as the argv (Issue #2343)", async () => {
  assertEquals(await promptSplitFlag(true), true);
  assertEquals(await promptSplitFlag(false), false);
});

// ---------------------------------------------------------------------------
// The reviewer sub-agents (Issue #2575)
// ---------------------------------------------------------------------------

Deno.test("execute_phase - issue_reviewer_agents on carries both reviewer definitions and no executor (Issue #2575)", async () => {
  const options = await runPhase(false, undefined, true);
  const agents = options?.agents as
    | Record<string, AgentDefinition>
    | undefined;

  assert(agents, "the reviewer run must carry sub-agent definitions");
  assertEquals(
    Object.keys(agents).sort(),
    [SPEC_REVIEWER_AGENT_NAME, STANDARDS_REVIEWER_AGENT_NAME].sort(),
  );
  for (const def of Object.values(agents)) {
    assertEquals(def.model, "sonnet");
    assertEquals(def.tools, ["Read", "Grep", "Glob"]);
    assertEquals(def.disallowedTools, ["Agent"]);
  }
  assertEquals(options?.issueExecutorSplit, undefined);
});

Deno.test("execute_phase - reviewers and the split together carry all three definitions (Issue #2575)", async () => {
  const options = await runPhase(true, undefined, true);
  const agents = options?.agents as Record<string, AgentDefinition>;

  assertEquals(
    Object.keys(agents).sort(),
    [
      ISSUE_EXECUTOR_AGENT_NAME,
      SPEC_REVIEWER_AGENT_NAME,
      STANDARDS_REVIEWER_AGENT_NAME,
    ].sort(),
  );
});

// ---------------------------------------------------------------------------
// The sub-agent tier (Issue #3402)
// ---------------------------------------------------------------------------

Deno.test("execute_phase - a haiku host tier carries the haiku executor, haiku standards reviewer, sonnet spec reviewer and an explorer (Issue #3402)", async () => {
  const options = await runPhase(true, undefined, true, {
    hostTier: "haiku",
  });
  const agents = options?.agents as Record<string, AgentDefinition>;

  assert(agents, "a haiku-tier run must carry sub-agent definitions");
  assertEquals(
    Object.keys(agents).sort(),
    [
      ISSUE_EXECUTOR_AGENT_NAME,
      SPEC_REVIEWER_AGENT_NAME,
      STANDARDS_REVIEWER_AGENT_NAME,
      EXPLORER_AGENT_NAME,
    ].sort(),
  );
  assertEquals(agents[ISSUE_EXECUTOR_AGENT_NAME]!.model, "haiku");
  assertEquals(agents[ISSUE_EXECUTOR_AGENT_NAME]!.effort, "high");
  assertEquals(agents[STANDARDS_REVIEWER_AGENT_NAME]!.model, "haiku");
  assertEquals(agents[STANDARDS_REVIEWER_AGENT_NAME]!.effort, "medium");
  assertEquals(agents[SPEC_REVIEWER_AGENT_NAME]!.model, "sonnet");
  assertEquals(agents[SPEC_REVIEWER_AGENT_NAME]!.effort, "medium");
});

Deno.test("execute_phase - a default config carries no explorer and a sonnet executor (Issue #3402)", async () => {
  const executor = executorOf(await runPhase(true));
  assert(executor, "the split run carries the executor");
  assertEquals(executor.model, "sonnet");
  assertEquals(executor.effort, "medium");

  const options = await runPhase(true);
  const agents = options?.agents as Record<string, AgentDefinition>;
  assertEquals(
    Object.keys(agents).includes(EXPLORER_AGENT_NAME),
    false,
    "the default tier carries no explorer",
  );
});

Deno.test("execute_phase - a repo tier of sonnet beats a host-wide haiku (Issue #3402)", async () => {
  const options = await runPhase(true, undefined, false, {
    hostTier: "haiku",
    repoTier: "sonnet",
  });
  const agents = options?.agents as Record<string, AgentDefinition>;

  assertEquals(
    Object.keys(agents),
    [ISSUE_EXECUTOR_AGENT_NAME],
    "the repo's sonnet override drops the explorer",
  );
  assertEquals(agents[ISSUE_EXECUTOR_AGENT_NAME]!.model, "sonnet");
});

Deno.test("execute_phase - the resolved tier is logged exactly once (Issue #3402)", async () => {
  const haikuLogs: string[] = [];
  await runPhase(false, undefined, false, {
    hostTier: "haiku",
    logs: haikuLogs,
  });
  const haikuTierLogs = haikuLogs.filter((m) =>
    m.includes("Issue sub-agent tier resolved to")
  );
  assertEquals(haikuTierLogs.length, 1, "logged exactly once per run");
  assert(
    haikuTierLogs[0]!.includes("Issue sub-agent tier resolved to 'haiku'"),
  );

  const sonnetLogs: string[] = [];
  await runPhase(false, undefined, false, { logs: sonnetLogs });
  const sonnetTierLogs = sonnetLogs.filter((m) =>
    m.includes("Issue sub-agent tier resolved to")
  );
  assertEquals(sonnetTierLogs.length, 1, "logged exactly once per run");
  assert(
    sonnetTierLogs[0]!.includes("Issue sub-agent tier resolved to 'sonnet'"),
  );
});
