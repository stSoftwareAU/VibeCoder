/**
 * Plan the provider and sub-agent switches for one issue run (Issue #4109).
 *
 * `buildIssueRunAgents` emits `--agents` definitions for the issue run, but
 * only the Claude CLI accepts that flag. A run that asks a non-Claude provider
 * for sub-agents would spawn a CLI that drops the flag and then stall until
 * the Issue #4010 guard refuses it. This planner decides before spawn: keep
 * the run as configured when its provider carries the agents, reroute to
 * Claude when Claude is enabled and installed, otherwise strip the sub-agent
 * switches so the run starts without them. The #4010 guard stays as a
 * backstop.
 *
 * Australian English spelling throughout (behaviour, organisation, licence).
 */

import {
  type AgentProviderDescriptor,
  CLAUDE_PROVIDER_ID,
  type EnabledAgentProviderSelection,
  imageAgentProviderIds,
  resolveAgentProvider,
  resolveEnabledAgentProviderIds,
} from "./agent_provider.ts";
import { buildIssueRunAgents } from "./issue_executor_agents.ts";
import { probeDescriptorInvocationCapabilities } from "./provider_feasibility.ts";
import { createLogger } from "./logger.ts";
import type { IssueSubAgentTier, Logger } from "../types.ts";

/** The tier a stripped run falls back to; it carries no sub-agent switches. */
const STRIPPED_SUB_AGENT_TIER: IssueSubAgentTier = "sonnet";

/** What {@link planIssueRunProvider} did to the run. */
export type IssueRunProviderOutcome =
  | "unchanged"
  | "rerouted-to-claude"
  | "agents-stripped";

/** The inputs one issue run's provider decision reads. */
export interface IssueRunProviderPlanInput {
  /** The provider the run would otherwise use. */
  provider: AgentProviderDescriptor;
  /** Whether the issue-executor split is on for this run. */
  executorSplit: boolean;
  /** Whether the reviewer sub-agents are on for this run. */
  reviewerAgents: boolean;
  /** The sub-agent tier `resolveIssueSubAgentTier` resolved for this run. */
  subAgentTier: IssueSubAgentTier;
  /** Enabled-set and install inputs; omit for the process environment. */
  selection?: EnabledAgentProviderSelection;
  /** Where the reroute or strip warning goes; omit for the default logger. */
  logger?: Logger;
}

/** The provider and switches the run spawns with, after the plan. */
export interface IssueRunProviderPlan {
  /** The provider the run spawns with. */
  provider: AgentProviderDescriptor;
  /** Whether the issue-executor split is on for the spawned run. */
  executorSplit: boolean;
  /** Whether the reviewer sub-agents are on for the spawned run. */
  reviewerAgents: boolean;
  /** The sub-agent tier the spawned run carries. */
  subAgentTier: IssueSubAgentTier;
  /** How the plan changed the run. */
  outcome: IssueRunProviderOutcome;
}

/**
 * Whether Claude is both enabled for this deployment and installed in the image.
 *
 * @param selection - Enabled-set and install inputs.
 * @returns True when a run can be rerouted to Claude.
 */
function claudeUsable(selection: EnabledAgentProviderSelection): boolean {
  const enabled = resolveEnabledAgentProviderIds(selection).includes(
    CLAUDE_PROVIDER_ID,
  );
  const installed = imageAgentProviderIds(selection);
  return enabled &&
    (installed === undefined || installed.includes(CLAUDE_PROVIDER_ID));
}

/**
 * Decide the provider and sub-agent switches for one issue run before spawn.
 *
 * @param input - The run's provider, switches and tier, with the selection.
 * @returns The provider and switches the run spawns with.
 */
export function planIssueRunProvider(
  input: IssueRunProviderPlanInput,
): IssueRunProviderPlan {
  const { provider, executorSplit, reviewerAgents, subAgentTier } = input;
  const unchanged: IssueRunProviderPlan = {
    provider,
    executorSplit,
    reviewerAgents,
    subAgentTier,
    outcome: "unchanged",
  };
  const agentsWanted = buildIssueRunAgents({
    executorSplit,
    reviewerAgents,
    subAgentTier,
  }) !== undefined;
  if (!agentsWanted) return unchanged;
  if (probeDescriptorInvocationCapabilities(provider).carriesSubAgents) {
    return unchanged;
  }

  const selection = input.selection ?? {};
  const logger = input.logger ?? createLogger();
  if (claudeUsable(selection)) {
    logger.warn(
      `Issue run asked the ${provider.id} provider for sub-agents it cannot ` +
        `carry; rerouting the run to the ${CLAUDE_PROVIDER_ID} provider (Issue #4109)`,
    );
    return {
      ...unchanged,
      provider: resolveAgentProvider(CLAUDE_PROVIDER_ID),
      outcome: "rerouted-to-claude",
    };
  }

  logger.warn(
    `Issue run asked the ${provider.id} provider for sub-agents it cannot ` +
      `carry and ${CLAUDE_PROVIDER_ID} is not enabled; starting the run without ` +
      `sub-agents (Issue #4109)`,
  );
  return {
    provider,
    executorSplit: false,
    reviewerAgents: false,
    subAgentTier: STRIPPED_SUB_AGENT_TIER,
    outcome: "agents-stripped",
  };
}
