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

import { assert, assertEquals } from "@std/assert";
import {
  buildIssueExecutorAgents,
  ISSUE_EXECUTOR_AGENT_NAME,
  ISSUE_EXECUTOR_DISALLOWED_TOOLS,
  ISSUE_EXECUTOR_EFFORT,
  ISSUE_EXECUTOR_MODEL,
  ISSUE_EXECUTOR_TOOLS,
} from "../lib/issue_executor_agents.ts";

Deno.test("issue_executor_agents - defines exactly one executor sub-agent", () => {
  const agents = buildIssueExecutorAgents();
  assertEquals(Object.keys(agents), [ISSUE_EXECUTOR_AGENT_NAME]);
});

Deno.test("issue_executor_agents - the executor runs on the Sonnet tier at medium effort", () => {
  const executor = buildIssueExecutorAgents()[ISSUE_EXECUTOR_AGENT_NAME]!;

  // The alias, not a pinned id: every Claude default in this worker is a tier
  // alias, so the CLI resolves the current Sonnet from its own table.
  assertEquals(executor.model, "sonnet");
  assertEquals(executor.model, ISSUE_EXECUTOR_MODEL);
  assertEquals(executor.effort, "medium");
  assertEquals(executor.effort, ISSUE_EXECUTOR_EFFORT);
});

Deno.test("issue_executor_agents - the executor carries exactly the six edit-and-test tools", () => {
  const executor = buildIssueExecutorAgents()[ISSUE_EXECUTOR_AGENT_NAME]!;

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
  const executor = buildIssueExecutorAgents()[ISSUE_EXECUTOR_AGENT_NAME]!;

  assertEquals(executor.disallowedTools, ["Agent"]);
  assertEquals(executor.disallowedTools, ISSUE_EXECUTOR_DISALLOWED_TOOLS);
  assertEquals(
    executor.tools?.includes("Agent"),
    false,
    "the granted tool set does not hand back what the denial removes",
  );
});

Deno.test("issue_executor_agents - the executor prompt states its two jobs: make the edits, run the covering tests", () => {
  const executor = buildIssueExecutorAgents()[ISSUE_EXECUTOR_AGENT_NAME]!;
  const prompt = executor.prompt.toLowerCase();

  assert(prompt.includes("edit"), `prompt must name the edits: ${prompt}`);
  assert(prompt.includes("test"), `prompt must name the tests: ${prompt}`);
  assert(
    executor.description.length > 0,
    "the CLI routes work by the description, so it cannot be empty",
  );
});

Deno.test("issue_executor_agents - the definitions survive JSON round-tripping into the CLI flag", () => {
  // The flag value is JSON on the command line; a field that does not
  // serialise is a field the CLI never sees.
  const parsed = JSON.parse(JSON.stringify(buildIssueExecutorAgents()));
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
