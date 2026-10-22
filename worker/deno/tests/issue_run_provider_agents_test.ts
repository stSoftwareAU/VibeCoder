/**
 * Issue run provider planning (Issue #4109).
 *
 * A non-Claude provider cannot carry `--agents`, so an issue run that asks
 * for sub-agents must be rerouted to Claude when Claude is enabled, or start
 * with the sub-agent switches stripped when it is not.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type EnabledAgentProviderSelection,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import { buildIssueRunAgents } from "../lib/issue_executor_agents.ts";
import { planIssueRunProvider } from "../lib/issue_run_provider_agents.ts";
import { createLogger } from "../lib/logger.ts";

const NON_CLAUDE_PROVIDERS = ["codex", "gemini", "deepseek"];

/** An enabled set naming `active` and the listed providers, with no image. */
function selectionFor(
  active: string,
  enabled: string[],
): EnabledAgentProviderSelection {
  return {
    configured: active,
    configuredProviders: enabled,
    env: () => undefined,
  };
}

Deno.test("issue run provider - Claude with sub-agents is left unchanged (Issue #4109)", () => {
  const lines: string[] = [];
  const plan = planIssueRunProvider({
    provider: resolveAgentProvider("claude"),
    executorSplit: true,
    reviewerAgents: false,
    subAgentTier: "haiku",
    selection: selectionFor("claude", ["claude"]),
    logger: createLogger({ write: (line) => lines.push(line) }),
  });

  assertEquals(plan.outcome, "unchanged");
  assertEquals(plan.provider.id, "claude");
  assertEquals(plan.executorSplit, true);
  assertEquals(plan.subAgentTier, "haiku");
  assertEquals(lines.length, 0, "an unchanged run logs nothing");
});

Deno.test("issue run provider - a non-Claude provider with Claude enabled is rerouted to Claude (Issue #4109)", () => {
  for (const id of NON_CLAUDE_PROVIDERS) {
    const lines: string[] = [];
    const plan = planIssueRunProvider({
      provider: resolveAgentProvider(id),
      executorSplit: true,
      reviewerAgents: false,
      subAgentTier: "haiku",
      selection: selectionFor(id, [id, "claude"]),
      logger: createLogger({ write: (line) => lines.push(line) }),
    });

    assertEquals(plan.outcome, "rerouted-to-claude", id);
    assertEquals(plan.provider.id, "claude", id);
    assertEquals(plan.executorSplit, true, id);
    assertEquals(plan.subAgentTier, "haiku", id);
    assertEquals(lines.length, 1, `${id} logs one reroute warning`);
    assert(lines[0]!.includes(id), `${id} named in the warning`);
    assert(lines[0]!.includes("#4109"), `${id} warning cites #4109`);
  }
});

Deno.test("issue run provider - a non-Claude provider with Claude not enabled has its sub-agents stripped (Issue #4109)", () => {
  for (const id of NON_CLAUDE_PROVIDERS) {
    const lines: string[] = [];
    const plan = planIssueRunProvider({
      provider: resolveAgentProvider(id),
      executorSplit: true,
      reviewerAgents: true,
      subAgentTier: "haiku",
      selection: selectionFor(id, [id]),
      logger: createLogger({ write: (line) => lines.push(line) }),
    });

    assertEquals(plan.outcome, "agents-stripped", id);
    assertEquals(plan.provider.id, id, id);
    assertEquals(plan.executorSplit, false, id);
    assertEquals(plan.reviewerAgents, false, id);
    assertEquals(plan.subAgentTier, "sonnet", id);
    assertEquals(lines.length, 1, `${id} logs one strip warning`);
    assert(lines[0]!.includes(id), `${id} named in the warning`);
    assert(lines[0]!.includes("#4109"), `${id} warning cites #4109`);
  }
});

Deno.test("issue run provider - a stripped codex run carries no --agents, so the #4010 guard has nothing to refuse (Issue #4109)", () => {
  const plan = planIssueRunProvider({
    provider: resolveAgentProvider("codex"),
    executorSplit: true,
    reviewerAgents: false,
    subAgentTier: "haiku",
    selection: selectionFor("codex", ["codex"]),
    logger: createLogger({ write: () => {} }),
  });

  assertEquals(
    buildIssueRunAgents({
      executorSplit: plan.executorSplit,
      reviewerAgents: plan.reviewerAgents,
      subAgentTier: plan.subAgentTier,
    }),
    undefined,
  );
});

Deno.test("issue run provider - a run asking for no sub-agent switches is left unchanged (Issue #4109)", () => {
  const lines: string[] = [];
  const plan = planIssueRunProvider({
    provider: resolveAgentProvider("codex"),
    executorSplit: false,
    reviewerAgents: false,
    subAgentTier: "sonnet",
    selection: selectionFor("codex", ["codex"]),
    logger: createLogger({ write: (line) => lines.push(line) }),
  });

  assertEquals(plan.outcome, "unchanged");
  assertEquals(plan.provider.id, "codex");
  assertEquals(plan.executorSplit, false);
  assertEquals(plan.reviewerAgents, false);
  assertEquals(plan.subAgentTier, "sonnet");
  assertEquals(lines.length, 0, "an unchanged run logs nothing");
});

Deno.test("issue run provider - a provider whose argv carries --agents is left unchanged even without Claude (Issue #4109)", () => {
  const lines: string[] = [];
  const carrying = {
    ...resolveAgentProvider("codex"),
    buildInvocation: () => ["exec", "--agents", "{}"],
  };
  const plan = planIssueRunProvider({
    provider: carrying,
    executorSplit: true,
    reviewerAgents: false,
    subAgentTier: "haiku",
    selection: selectionFor("codex", ["codex"]),
    logger: createLogger({ write: (line) => lines.push(line) }),
  });

  assertEquals(plan.outcome, "unchanged");
  assertEquals(plan.provider, carrying);
  assertEquals(plan.executorSplit, true);
  assertEquals(plan.subAgentTier, "haiku");
  assertEquals(lines.length, 0, "an unchanged run logs nothing");
});

Deno.test("issue run provider - Claude not enabled strips sub-agents with no image stamp (Issue #4109)", () => {
  const lines: string[] = [];
  const plan = planIssueRunProvider({
    provider: resolveAgentProvider("codex"),
    executorSplit: true,
    reviewerAgents: false,
    subAgentTier: "haiku",
    selection: selectionFor("codex", ["codex"]),
    logger: createLogger({ write: (line) => lines.push(line) }),
  });

  assertEquals(plan.outcome, "agents-stripped");
  assertEquals(plan.provider.id, "codex");
  assertEquals(plan.executorSplit, false);
  assertEquals(lines.length, 1, "one strip warning");
});

Deno.test("issue run provider - Claude enabled with no image stamp reroutes the run (Issue #4109)", () => {
  const lines: string[] = [];
  const plan = planIssueRunProvider({
    provider: resolveAgentProvider("codex"),
    executorSplit: true,
    reviewerAgents: false,
    subAgentTier: "haiku",
    selection: selectionFor("codex", ["codex", "claude"]),
    logger: createLogger({ write: (line) => lines.push(line) }),
  });

  assertEquals(plan.outcome, "rerouted-to-claude");
  assertEquals(plan.provider.id, "claude");
  assertEquals(lines.length, 1, "one reroute warning");
});
