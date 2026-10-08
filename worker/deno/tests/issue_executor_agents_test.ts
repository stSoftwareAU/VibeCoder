/**
 * Tests for issue_executor_agents.ts — the Sonnet executor sub-agent
 * definitions a split `issue`-phase run hands the Claude CLI (Issue #2342,
 * part of #2320).
 *
 * The definition is what makes the split cheaper than today's single-model
 * routing, so every field it turns on is pinned here: lose the model and the
 * executors silently inherit the advisor's tier; lose the `Agent` denial and
 * a bounded two-tier run becomes an unbounded tree of sub-agents.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIssueExecutorAgents,
  buildIssueExplorerAgents,
  EXPLORER_AGENT_NAME,
  EXPLORER_DISALLOWED_TOOLS,
  EXPLORER_EFFORT,
  EXPLORER_MODEL,
  EXPLORER_TOOLS,
  HAIKU_ISSUE_EXECUTOR_EFFORT,
  HAIKU_ISSUE_EXECUTOR_MODEL,
  HAIKU_SUB_AGENT_GUIDANCE,
  ISSUE_EXECUTOR_AGENT_NAME,
  ISSUE_EXECUTOR_DISALLOWED_TOOLS,
  ISSUE_EXECUTOR_EFFORT,
  ISSUE_EXECUTOR_MODEL,
  ISSUE_EXECUTOR_TOOLS,
} from "../lib/issue_executor_agents.ts";

Deno.test("issue_executor_agents - defines exactly one executor sub-agent", () => {
  const agents = buildIssueExecutorAgents("sonnet");
  assertEquals(Object.keys(agents), [ISSUE_EXECUTOR_AGENT_NAME]);
});

Deno.test("issue_executor_agents - the executor runs on the Sonnet tier at medium effort", () => {
  const executor = buildIssueExecutorAgents(
    "sonnet",
  )[ISSUE_EXECUTOR_AGENT_NAME]!;

  // The alias, not a pinned id: every Claude default in this worker is a tier
  // alias, so the CLI resolves the current Sonnet from its own table.
  assertEquals(executor.model, "sonnet");
  assertEquals(executor.model, ISSUE_EXECUTOR_MODEL);
  assertEquals(executor.effort, "medium");
  assertEquals(executor.effort, ISSUE_EXECUTOR_EFFORT);
});

Deno.test("issue_executor_agents - the executor carries exactly the six edit-and-test tools", () => {
  const executor = buildIssueExecutorAgents(
    "sonnet",
  )[ISSUE_EXECUTOR_AGENT_NAME]!;

  assertEquals(executor.tools, [
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
    "Bash",
  ]);
  assertEquals(executor.tools, ISSUE_EXECUTOR_TOOLS);
});

Deno.test("issue_executor_agents - the executor cannot spawn further sub-agents", () => {
  const executor = buildIssueExecutorAgents(
    "sonnet",
  )[ISSUE_EXECUTOR_AGENT_NAME]!;

  assertEquals(executor.disallowedTools, ["Agent"]);
  assertEquals(executor.disallowedTools, ISSUE_EXECUTOR_DISALLOWED_TOOLS);
  assertEquals(
    executor.tools?.includes("Agent"),
    false,
    "the granted tool set does not hand back what the denial removes",
  );
});

Deno.test("issue_executor_agents - the CLI's two required fields are populated", () => {
  // `description` is what the CLI routes work by and `prompt` is what the
  // sub-agent runs on; an empty either is an agent the CLI cannot use.
  const executor = buildIssueExecutorAgents(
    "sonnet",
  )[ISSUE_EXECUTOR_AGENT_NAME]!;

  assert(
    executor.description.trim().length > 0,
    "the CLI routes work by the description, so it cannot be empty",
  );
  assert(
    executor.prompt.trim().length > 0,
    "a sub-agent with no system prompt has nothing to run on",
  );
});

Deno.test("issue_executor_agents - the definitions survive JSON round-tripping into the CLI flag", () => {
  // The flag value is JSON on the command line; a field that does not
  // serialise is a field the CLI never sees.
  const parsed = JSON.parse(JSON.stringify(buildIssueExecutorAgents("sonnet")));
  const executor = parsed[ISSUE_EXECUTOR_AGENT_NAME];

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
  assertEquals(typeof executor.prompt, "string");
});

// ---------------------------------------------------------------------------
// Issue #3402 — the Haiku tier
// ---------------------------------------------------------------------------

Deno.test("issue_executor_agents - the Haiku-tier executor runs on haiku at high effort", () => {
  const executor = buildIssueExecutorAgents(
    "haiku",
  )[ISSUE_EXECUTOR_AGENT_NAME]!;

  assertEquals(executor.model, "haiku");
  assertEquals(executor.model, HAIKU_ISSUE_EXECUTOR_MODEL);
  assertEquals(executor.effort, "high");
  assertEquals(executor.effort, HAIKU_ISSUE_EXECUTOR_EFFORT);
});

Deno.test("issue_executor_agents - the Haiku-tier executor keeps the same six tools and Agent denial", () => {
  const sonnet = buildIssueExecutorAgents("sonnet")[ISSUE_EXECUTOR_AGENT_NAME]!;
  const haiku = buildIssueExecutorAgents("haiku")[ISSUE_EXECUTOR_AGENT_NAME]!;

  assertEquals(haiku.tools, sonnet.tools);
  assertEquals(haiku.tools, [
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
    "Bash",
  ]);
  assertEquals(haiku.disallowedTools, ["Agent"]);
});

Deno.test("issue_executor_agents - the Haiku-tier executor prompt ends with the Haiku guidance; the Sonnet one does not", () => {
  const sonnet = buildIssueExecutorAgents("sonnet")[ISSUE_EXECUTOR_AGENT_NAME]!;
  const haiku = buildIssueExecutorAgents("haiku")[ISSUE_EXECUTOR_AGENT_NAME]!;

  assert(
    haiku.prompt.endsWith(HAIKU_SUB_AGENT_GUIDANCE),
    "the Haiku-tier executor prompt must end with the Haiku guidance",
  );
  assert(
    !sonnet.prompt.includes("Haiku guidance"),
    "the Sonnet-tier executor prompt must not carry Haiku guidance",
  );
});

Deno.test("issue_executor_agents - the explorer is read-only, denies Agent, and runs on haiku at medium effort", () => {
  const explorer = buildIssueExplorerAgents()[EXPLORER_AGENT_NAME]!;

  assertEquals(explorer.tools, ["Read", "Grep", "Glob"]);
  assertEquals(explorer.tools, EXPLORER_TOOLS);
  for (const tool of ["Edit", "Write", "Bash", "NotebookEdit", "Agent"]) {
    assertEquals(
      explorer.tools?.includes(tool),
      false,
      `the explorer must not be granted ${tool}`,
    );
  }
  assertEquals(explorer.disallowedTools, ["Agent"]);
  assertEquals(explorer.disallowedTools, EXPLORER_DISALLOWED_TOOLS);
  assertEquals(explorer.model, "haiku");
  assertEquals(explorer.model, EXPLORER_MODEL);
  assertEquals(explorer.effort, "medium");
  assertEquals(explorer.effort, EXPLORER_EFFORT);
  assertStringIncludes(
    explorer.description.toLowerCase(),
    "read-only codebase lookups",
  );
  assertStringIncludes(explorer.prompt, HAIKU_SUB_AGENT_GUIDANCE);
});
