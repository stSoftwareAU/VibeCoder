/**
 * The owner's role-model decision of 2026-10-22: Opus does the code reviews,
 * Sonnet manages, Haiku executes — and when the provider is Codex each role
 * maps to the similar OpenAI model from the account's catalogue:
 *
 * | Role     | Claude | Codex         |
 * | -------- | ------ | ------------- |
 * | reviewer | opus   | `gpt-6-astra` |
 * | manager  | sonnet | `gpt-6.1-sol` |
 * | executor | haiku  | `gpt-6-luna`  |
 *
 * Asserted on every surface that picks a role's model: the in-run reviewer
 * sub-agents (at both executor tiers), the external orchestrator's role
 * defaults, and the Codex best/standard/fast tiers the phase routing reads.
 *
 * Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildIssueRunAgents,
  HAIKU_SUB_AGENT_GUIDANCE,
  ISSUE_EXECUTOR_AGENT_NAME,
  SPEC_REVIEWER_AGENT_NAME,
  STANDARDS_REVIEWER_AGENT_NAME,
} from "../lib/issue_executor_agents.ts";
import {
  effectiveRoleSelections,
  resolveIssueOrchestration,
} from "../lib/orchestration/role_config.ts";
import {
  CODEX_PHASE_MODEL_DEFAULTS,
  DEFAULT_CLAUDE_MODEL_ISSUE,
  PROVIDER_MODEL_TIERS,
} from "../lib/config_defaults.ts";
import { getContextWindowSize } from "../lib/context_budget.ts";

Deno.test("role models - both in-run reviewers run on Opus at every executor tier", () => {
  for (const subAgentTier of ["sonnet", "haiku"] as const) {
    const agents = buildIssueRunAgents({
      executorSplit: true,
      reviewerAgents: true,
      subAgentTier,
    });
    assert(agents, `expected definitions for the ${subAgentTier} tier`);
    for (
      const name of [SPEC_REVIEWER_AGENT_NAME, STANDARDS_REVIEWER_AGENT_NAME]
    ) {
      const reviewer = agents[name]!;
      assertEquals(
        reviewer.model,
        "opus",
        `${name} on the ${subAgentTier} tier`,
      );
      assertEquals(reviewer.effort, "medium", `${name} effort`);
      assert(
        !reviewer.prompt.includes(HAIKU_SUB_AGENT_GUIDANCE),
        `${name} runs on Opus and must not carry the Haiku guidance`,
      );
    }
  }
});

Deno.test("role models - the manager is Sonnet and the default executor is Haiku", () => {
  assertEquals(DEFAULT_CLAUDE_MODEL_ISSUE, "sonnet");
  const agents = buildIssueRunAgents({
    executorSplit: true,
    reviewerAgents: false,
    subAgentTier: "haiku",
  });
  assertEquals(agents?.[ISSUE_EXECUTOR_AGENT_NAME]?.model, "haiku");
});

Deno.test("role models - the orchestrator's reviewer defaults to its own Opus role, not the manager", () => {
  const roles = effectiveRoleSelections({});
  assertEquals(roles.manager, {
    provider: "claude",
    model: "sonnet",
    effort: "high",
  });
  assertEquals(roles.executor.model, "haiku");
  assertEquals(roles.reviewer, {
    provider: "claude",
    model: "opus",
    effort: "high",
  });
});

Deno.test("role models - a role moved to Codex gets the mapped OpenAI model, not none", () => {
  const roles = effectiveRoleSelections({
    manager: { provider: "codex" },
    executor: { provider: "codex" },
    reviewer: { provider: "codex" },
  });
  assertEquals(roles.manager.provider, "codex");
  assertEquals(roles.manager.model, "gpt-6.1-sol");
  assertEquals(roles.executor.model, "gpt-6-luna");
  assertEquals(roles.reviewer.model, "gpt-6-astra");
  for (const role of Object.values(roles)) {
    assertEquals(role.effort, "high");
  }
});

Deno.test("role models - an explicit role model still wins over the provider default", () => {
  const roles = effectiveRoleSelections({
    reviewer: { provider: "codex", model: "gpt-6-sol" },
  });
  assertEquals(roles.reviewer.model, "gpt-6-sol");
});

Deno.test("role models - Codex tiers map Opus/Sonnet/Haiku to Astra/6.1 Sol/Luna", () => {
  assertEquals(PROVIDER_MODEL_TIERS.codex, {
    best: "gpt-6-astra",
    standard: "gpt-6.1-sol",
    fast: "gpt-6-luna",
  });
  // The phases follow the tiers: the manager phase on the workhorse, the
  // planning-shaped phases on the frontier model, the trivial trio on Luna.
  assertEquals(CODEX_PHASE_MODEL_DEFAULTS["issue"], "gpt-6.1-sol");
  assertEquals(CODEX_PHASE_MODEL_DEFAULTS["planning"], "gpt-6-astra");
  assertEquals(CODEX_PHASE_MODEL_DEFAULTS["health"], "gpt-6-luna");
});

Deno.test("role models - the Codex ids carry their catalogue context windows", () => {
  // From the account's Codex models catalogue (`context_window`).
  assertEquals(getContextWindowSize("gpt-6-astra"), 272_000);
  assertEquals(getContextWindowSize("gpt-6.1-sol"), 500_000);
  assertEquals(getContextWindowSize("gpt-6-luna"), 272_000);
});

Deno.test("automatic issue orchestration follows the selected provider and retains explicit role pins", () => {
  const codex = resolveIssueOrchestration(false, {}, "codex", true);
  assertEquals(codex.externalOrchestration, true);
  const roles = effectiveRoleSelections(codex.effectiveOrchestrationSettings);
  assertEquals(roles.manager.model, "gpt-6.1-sol");
  assertEquals(roles.executor.model, "gpt-6-luna");
  assertEquals(roles.reviewer.model, "gpt-6-astra");
  assert(Object.values(roles).every((role) => role.provider === "codex"));
  const pinned = resolveIssueOrchestration(
    false,
    {
      manager: { model: "sonnet" },
      reviewer: { provider: "claude", model: "opus" },
      maxInvocations: 9,
    },
    "codex",
    true,
  );
  assertEquals(
    pinned.effectiveOrchestrationSettings.manager?.provider,
    "claude",
  );
  assertEquals(
    pinned.effectiveOrchestrationSettings.executor?.provider,
    "codex",
  );
  assertEquals(pinned.effectiveOrchestrationSettings.reviewer?.model, "opus");
  assertEquals(pinned.effectiveOrchestrationSettings.maxInvocations, 9);
  assertEquals(
    resolveIssueOrchestration(false, {}, "claude", true).externalOrchestration,
    false,
  );
  assertEquals(
    resolveIssueOrchestration(false, {}, "codex", false).externalOrchestration,
    false,
  );
});
