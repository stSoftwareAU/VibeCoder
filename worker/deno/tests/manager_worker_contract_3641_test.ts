/**
 * Contract tests for the current Claude manager–worker path (Issue #3641).
 *
 * These pin what the worker hands the Claude CLI on an `issue`-phase run
 * today: the `--agents` definitions and their tiers, tools and denials, the
 * issue-phase defaults, and how each provider's `buildInvocation` treats the
 * `agents` and `settingsJson` fields. A provider-neutral refactor must not
 * change any of it silently, so every assertion here runs the real functions
 * on real data; nothing greps source text.
 *
 * Australian English spelling throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type AgentDefinition,
  type AgentInvocationRequest,
  agentProviderIds,
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import {
  buildIssueRunAgents,
  type IssueRunAgentSwitches,
} from "../lib/issue_executor_agents.ts";
import {
  DEFAULT_CLAUDE_EFFORT_ISSUE,
  DEFAULT_CLAUDE_MODEL_ISSUE,
  OPERATIONAL_DEFAULTS,
} from "../lib/config_defaults.ts";

type AgentSet = Readonly<Record<string, AgentDefinition>>;

/** Every switch on, on the given tier: the fullest run the worker builds. */
function allSwitchesOn(
  subAgentTier: IssueRunAgentSwitches["subAgentTier"],
): IssueRunAgentSwitches {
  return { executorSplit: true, reviewerAgents: true, subAgentTier };
}

/** Build a run's agents, failing the test if the run carries none. */
function runAgents(switches: IssueRunAgentSwitches): AgentSet {
  const agents = buildIssueRunAgents(switches);
  assert(agents !== undefined, "this run is expected to carry --agents");
  return agents;
}

/** The `--agents` fixture: a real output of buildIssueRunAgents on the Haiku tier. */
const AGENTS_FIXTURE: AgentSet = runAgents(allSwitchesOn("haiku"));

/** The `--settings` fixture: a hook payload shaped like the split run's guard. */
const SETTINGS_FIXTURE = '{"hooks":{"PreToolUse":[]}}';

const PROMPT = "Implement the issue.";

/** An env lookup that answers nothing, so routing does not depend on the host. */
const NO_ENV = (_name: string): string | undefined => undefined;

/** A split, Haiku-tier `issue` invocation carrying both new fields. */
const ISSUE_REQUEST: AgentInvocationRequest = {
  prompt: PROMPT,
  phase: "issue",
  env: NO_ENV,
  agents: AGENTS_FIXTURE,
  settingsJson: SETTINGS_FIXTURE,
};

/** Run `fn` with `console.warn` captured; returns its result and the lines. */
function captureWarnings<T>(
  fn: () => T,
): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

Deno.test("#3641 contract — haiku-tier payload pins the agent names, models and efforts", () => {
  const agents = runAgents(allSwitchesOn("haiku"));

  assertEquals(Object.keys(agents), [
    "spec-reviewer",
    "standards-reviewer",
    "executor",
    "explorer",
  ]);
  assertEquals(
    Object.fromEntries(
      Object.entries(agents).map((
        [name, def],
      ) => [name, { model: def.model, effort: def.effort }]),
    ),
    {
      "spec-reviewer": { model: "opus", effort: "medium" },
      "standards-reviewer": { model: "opus", effort: "medium" },
      executor: { model: "haiku", effort: "high" },
      explorer: { model: "haiku", effort: "medium" },
    },
  );
});

Deno.test("#3641 contract — every agent on both tiers denies recursive delegation (Agent)", () => {
  const expectedNames: Record<
    IssueRunAgentSwitches["subAgentTier"],
    string[]
  > = {
    haiku: ["spec-reviewer", "standards-reviewer", "executor", "explorer"],
    sonnet: ["spec-reviewer", "standards-reviewer", "executor"],
  };

  for (const tier of ["haiku", "sonnet"] as const) {
    const agents = runAgents(allSwitchesOn(tier));
    assertEquals(Object.keys(agents), expectedNames[tier]);
    for (const [name, def] of Object.entries(agents)) {
      assert(
        def.disallowedTools?.includes("Agent") === true,
        `${tier} tier: ${name} must deny Agent`,
      );
    }
  }
});

Deno.test("#3641 contract — reviewers and explorer are read-only; the executor keeps Edit, Write and Bash", () => {
  const agents = runAgents(allSwitchesOn("haiku"));

  for (const name of ["spec-reviewer", "standards-reviewer", "explorer"]) {
    const tools = agents[name]?.tools;
    assert(tools !== undefined, `${name} must carry an explicit tool list`);
    for (const tool of ["Edit", "Write", "Bash", "NotebookEdit"]) {
      assertEquals(
        tools.includes(tool),
        false,
        `${name} must not be granted ${tool}`,
      );
    }
  }

  const executorTools = agents.executor?.tools ?? [];
  for (const tool of ["Edit", "Write", "Bash"]) {
    assertEquals(
      executorTools.includes(tool),
      true,
      `the executor must be granted ${tool}`,
    );
  }
});

Deno.test("#3641 contract — issue-phase switch defaults are split on, tier haiku, reviewers on", () => {
  assertEquals(OPERATIONAL_DEFAULTS.issueExecutorSplit, true);
  assertEquals(OPERATIONAL_DEFAULTS.issueSubAgentTier, "haiku");
  assertEquals(OPERATIONAL_DEFAULTS.issueReviewerAgents, true);
});

Deno.test("#3641 contract — manager issue-phase defaults are sonnet at high effort", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_ISSUE, "sonnet");
  assertEquals(DEFAULT_CLAUDE_EFFORT_ISSUE, "high");
});

Deno.test("#3641 contract — all switches off: undefined on sonnet, explorer-only on haiku", () => {
  assertEquals(
    buildIssueRunAgents({
      executorSplit: false,
      reviewerAgents: false,
      subAgentTier: "sonnet",
    }),
    undefined,
  );
  assertEquals(
    Object.keys(
      runAgents({
        executorSplit: false,
        reviewerAgents: false,
        subAgentTier: "haiku",
      }),
    ),
    ["explorer"],
  );
});

Deno.test("#3641 contract — Claude emits --agents (parseable, carries executor) and --settings", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const argv = claude.buildInvocation(ISSUE_REQUEST);

  const agentsAt = argv.indexOf("--agents");
  assert(agentsAt >= 0, "Claude must emit --agents for agents it is given");
  const parsed: Record<string, unknown> = JSON.parse(
    argv[agentsAt + 1] ?? "null",
  );
  assert("executor" in parsed, "the executor definition must reach the CLI");
  assertEquals(
    parsed,
    JSON.parse(JSON.stringify(AGENTS_FIXTURE)),
  );

  const settingsAt = argv.indexOf("--settings");
  assert(settingsAt >= 0, "Claude must emit --settings for settingsJson");
  assertEquals(argv[settingsAt + 1], SETTINGS_FIXTURE);
});

Deno.test("#3641 contract — DeepSeek strips --agents and --settings and warns once per invocation", () => {
  const deepseek = resolveAgentProvider(DEEPSEEK_PROVIDER_ID);

  const { result: argv, warnings } = captureWarnings(() =>
    deepseek.buildInvocation(ISSUE_REQUEST)
  );
  assertEquals(argv.includes("--agents"), false);
  assertEquals(argv.includes("--settings"), false);
  // The effort warning may also fire for phase "issue"; only the agents
  // warning is counted here.
  const agentWarnings = warnings.filter((w) => w.includes("--agents"));
  assertEquals(agentWarnings.length, 1);
  assertStringIncludes(
    agentWarnings[0] ?? "",
    "cannot resolve the Anthropic model tiers",
  );

  // Without agents there is nothing to warn about. Phase-less, so no effort
  // warning can fire either.
  const quiet = captureWarnings(() =>
    deepseek.buildInvocation({
      prompt: PROMPT,
      env: NO_ENV,
      settingsJson: SETTINGS_FIXTURE,
    })
  );
  assertEquals(quiet.result.includes("--agents"), false);
  assertEquals(quiet.result.includes("--settings"), false);
  assertEquals(quiet.warnings, []);
});

// This pins the silent drop at the descriptor's `buildInvocation` layer, which
// is recorded as a gap in docs/MANAGER-WORKER-CONTRACT.md. The native split
// path is no longer silent: the issue-run planner reroutes or strips such a run
// before spawn (lib/issue_run_provider_agents.ts), and `runClaudeWithTimeoutBody`
// refuses loudly as a backstop when a run carries `agents` but the argv lacks
// `--agents` (Issue #4010).
// That refusal has its own regression test in claude_runner_test.ts; this test
// still holds because it calls `buildInvocation` directly, where the drop
// remains the descriptor's contract.
Deno.test("#3641 contract — Codex and Gemini drop agents and settings silently at buildInvocation (descriptor layer)", () => {
  for (const id of [CODEX_PROVIDER_ID, GEMINI_PROVIDER_ID]) {
    const provider = resolveAgentProvider(id);
    const { result: argv, warnings } = captureWarnings(() =>
      provider.buildInvocation(ISSUE_REQUEST)
    );

    assertEquals(
      argv.includes("--agents"),
      false,
      `${id} must not take --agents`,
    );
    assertEquals(
      argv.includes("--settings"),
      false,
      `${id} must not take --settings`,
    );
    assertEquals(
      argv.some((arg) => arg.includes(JSON.stringify(AGENTS_FIXTURE))),
      false,
      `${id} must not carry the agents JSON anywhere in argv`,
    );
    assertEquals(
      argv.some((arg) => arg.includes(SETTINGS_FIXTURE)),
      false,
      `${id} must not carry the settings JSON anywhere in argv`,
    );
    // The effort notice is a separate, existing warning; only the agents and
    // settings drop is pinned as silent here.
    assertEquals(
      warnings.filter((w) => /agent|settings/i.test(w)),
      [],
      `${id} drops agents and settings silently, with no warning about either`,
    );
  }
});

Deno.test("#3641 contract — the provider registry holds exactly claude, codex, gemini and deepseek", () => {
  assertEquals(
    [...agentProviderIds()].sort(),
    ["claude", "codex", "deepseek", "gemini"],
  );
});
