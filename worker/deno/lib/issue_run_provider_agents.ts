/**
 * Issue #4109: settle an issue run's provider and sub-agent switches before spawn.
 *
 * Only the Claude CLI accepts `--agents`; the Issue #4010 guard stays as a backstop.
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

/** Whether Claude is both enabled for this deployment and installed in the image. */
function claudeUsable(selection: EnabledAgentProviderSelection): boolean {
  // The image stamp is checked first: an enabled set naming a provider the
  // image did not install throws, which would crash the run instead of
  // stripping it (Issue #4109).
  const installed = imageAgentProviderIds(selection);
  if (installed !== undefined && !installed.includes(CLAUDE_PROVIDER_ID)) {
    return false;
  }
  return resolveEnabledAgentProviderIds(selection).includes(CLAUDE_PROVIDER_ID);
}

/** Decide the provider and sub-agent switches for one issue run before spawn. */
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
  if (
    probeDescriptorInvocationCapabilities(provider, { quiet: true })
      .carriesSubAgents
  ) {
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
