/**
 * Tests for the Spec and Standards reviewer sub-agents (Issue #2575).
 *
 * Every `issue` run whose body states acceptance criteria dispatches two
 * reviewer sub-agents before writing the PR summary. With no definition they
 * inherit the advisor's model and effort — Opus at `high` for two extra
 * contexts on every run. These tests pin the named definitions that replace
 * that inheritance, the argv that carries them, the prompt that names them,
 * and the deterministic spawn caps every Claude child now runs under.
 *
 * Both directions are asserted: the reviewers ride a run whose
 * `issue_reviewer_agents` key is on, whether or not the executor split is,
 * and neither the reviewers nor the executor ride a run whose switch is off.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIssueRunAgents,
  ISSUE_EXECUTOR_AGENT_NAME,
  ISSUE_REVIEWER_DISALLOWED_TOOLS,
  ISSUE_REVIEWER_TOOLS,
  SPEC_REVIEWER_AGENT_NAME,
  SPEC_REVIEWER_EFFORT,
  SPEC_REVIEWER_MODEL,
  STANDARDS_REVIEWER_AGENT_NAME,
  STANDARDS_REVIEWER_EFFORT,
  STANDARDS_REVIEWER_MODEL,
} from "../lib/issue_executor_agents.ts";
import {
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import {
  buildClaudeChildEnv,
  CLAUDE_SUBAGENT_CAP_ENV,
} from "../lib/claude_env.ts";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const REVIEWERS = [SPEC_REVIEWER_AGENT_NAME, STANDARDS_REVIEWER_AGENT_NAME];

/** Tools that can change the checkout or run commands — never a reviewer's. */
const WRITE_OR_EXEC_TOOLS = ["Edit", "Write", "Bash", "NotebookEdit", "Agent"];

// ---------------------------------------------------------------------------
// The definitions
// ---------------------------------------------------------------------------

/** The reviewer definitions alone — the key on, the split off. */
function reviewersOnly() {
  const agents = buildIssueRunAgents({
    executorSplit: false,
    reviewerAgents: true,
  });
  assert(agents, "the reviewer key on must build definitions");
  return agents;
}

Deno.test("issue reviewers - both reviewers are defined whether or not the split is on", () => {
  for (const executorSplit of [false, true]) {
    const agents = buildIssueRunAgents({ executorSplit, reviewerAgents: true });
    for (const name of REVIEWERS) {
      assert(agents?.[name], `${name} missing with split=${executorSplit}`);
    }
  }
});

Deno.test("issue reviewers - each switch adds exactly its own definitions", () => {
  assertEquals(
    buildIssueRunAgents({ executorSplit: false, reviewerAgents: false }),
    undefined,
    "both off emits no --agents at all",
  );
  assertEquals(Object.keys(reviewersOnly()).sort(), [...REVIEWERS].sort());
  assertEquals(
    Object.keys(
      buildIssueRunAgents({ executorSplit: true, reviewerAgents: false }) ??
        {},
    ),
    [ISSUE_EXECUTOR_AGENT_NAME],
  );
  assertEquals(
    Object.keys(
      buildIssueRunAgents({ executorSplit: true, reviewerAgents: true }) ?? {},
    ).sort(),
    [...REVIEWERS, ISSUE_EXECUTOR_AGENT_NAME].sort(),
  );
});

Deno.test("issue reviewers - the reviewer key is off by default", () => {
  assertEquals(buildDefaultWorkerConfig().issueReviewerAgents, false);
});

Deno.test("issue reviewers - each reviewer names an explicit model and effort below the advisor's", () => {
  const agents = reviewersOnly();
  const spec = agents[SPEC_REVIEWER_AGENT_NAME]!;
  const standards = agents[STANDARDS_REVIEWER_AGENT_NAME]!;

  assertEquals(spec.model, "sonnet");
  assertEquals(spec.model, SPEC_REVIEWER_MODEL);
  assertEquals(spec.effort, "medium");
  assertEquals(spec.effort, SPEC_REVIEWER_EFFORT);

  assertEquals(standards.model, "sonnet");
  assertEquals(standards.model, STANDARDS_REVIEWER_MODEL);
  assertEquals(standards.effort, "low");
  assertEquals(standards.effort, STANDARDS_REVIEWER_EFFORT);

  for (const def of [spec, standards]) {
    assert(def.model !== "inherit" && def.model !== "opus");
    assert(def.effort !== "high" && def.effort !== "xhigh");
  }
});

Deno.test("issue reviewers - reviewers are read-only and cannot spawn sub-agents", () => {
  const agents = reviewersOnly();
  assertEquals(ISSUE_REVIEWER_TOOLS, ["Read", "Grep", "Glob"]);
  assertEquals(ISSUE_REVIEWER_DISALLOWED_TOOLS, ["Agent"]);
  for (const name of REVIEWERS) {
    const def = agents[name]!;
    assertEquals(def.tools, ISSUE_REVIEWER_TOOLS);
    assertEquals(def.disallowedTools, ["Agent"]);
    for (const tool of WRITE_OR_EXEC_TOOLS) {
      assertEquals(
        def.tools?.includes(tool),
        false,
        `${name} must not be granted ${tool}`,
      );
    }
    assert(def.description.trim().length > 0);
    assert(def.prompt.trim().length > 0);
  }
});

Deno.test("issue reviewers - the Standards brief limits violation to documented, material departures", () => {
  const prompt = reviewersOnly()[STANDARDS_REVIEWER_AGENT_NAME]!
    .prompt.toLowerCase();
  assertStringIncludes(prompt, "documented");
  assertStringIncludes(
    prompt,
    "correctness, security or the stated requirements",
  );
  assertStringIncludes(prompt, "optional");
});

Deno.test("issue reviewers - the Spec brief keeps the three questions and the independent context", () => {
  const prompt = reviewersOnly()[SPEC_REVIEWER_AGENT_NAME]!
    .prompt.toLowerCase();
  assertStringIncludes(prompt, "missing or partial");
  assertStringIncludes(prompt, "not asked for");
  assertStringIncludes(prompt, "implemented wrongly");
  assertStringIncludes(prompt, "unrequested");
});

// ---------------------------------------------------------------------------
// The argv
// ---------------------------------------------------------------------------

Deno.test("issue reviewers - an issue run's Claude argv carries both reviewer definitions", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const args = claude.buildInvocation({
    prompt: "PROMPT",
    phase: "issue",
    agents: reviewersOnly(),
  });
  const idx = args.indexOf("--agents");
  assert(idx >= 0, `expected --agents in ${args.join(" ")}`);
  const parsed = JSON.parse(args[idx + 1]!);
  for (const name of REVIEWERS) {
    assert(parsed[name], `${name} missing from --agents`);
    assert(typeof parsed[name].model === "string");
    assert(typeof parsed[name].effort === "string");
    assertEquals(parsed[name].tools, ["Read", "Grep", "Glob"]);
    assertEquals(parsed[name].disallowedTools, ["Agent"]);
  }
  assertEquals(parsed[ISSUE_EXECUTOR_AGENT_NAME], undefined);
});

// ---------------------------------------------------------------------------
// The spawn caps
// ---------------------------------------------------------------------------

Deno.test("issue reviewers - every Claude child carries the deterministic sub-agent caps", () => {
  assertEquals(CLAUDE_SUBAGENT_CAP_ENV, {
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4",
  });
  const child = buildClaudeChildEnv({ PATH: "/usr/bin" });
  assertEquals(child["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"], "1");
  assertEquals(child["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"], "4");
});

Deno.test("issue reviewers - an explicit cap in the parent environment wins", () => {
  const child = buildClaudeChildEnv({
    PATH: "/usr/bin",
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2",
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "8",
  });
  assertEquals(child["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"], "2");
  assertEquals(child["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"], "8");
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

async function reviewSection(): Promise<string> {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  if (!result.ok) throw new Error("issue failed to load");
  const text = result.value;
  const start = text.indexOf("## Independent Review Before the PR");
  const end = text.indexOf("\n## ", start + 1);
  assert(start > -1 && end > start, "review section not found");
  return text.slice(start, end);
}

Deno.test("issue reviewers - the issue prompt dispatches the reviewers by agent name", async () => {
  const section = await reviewSection();
  assertStringIncludes(section, `subagent_type: "${SPEC_REVIEWER_AGENT_NAME}"`);
  assertStringIncludes(
    section,
    `subagent_type: "${STANDARDS_REVIEWER_AGENT_NAME}"`,
  );
});

Deno.test("issue reviewers - the prompt's Standards brief limits violation to documented, material departures", async () => {
  const section = (await reviewSection()).toLowerCase();
  assertStringIncludes(section, "documented standard");
  assertStringIncludes(
    section,
    "correctness, security or the stated requirements",
  );
});
