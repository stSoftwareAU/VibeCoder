/**
 * Issue-phase safety-refusal policy (Issue #3406): a refusal must never be
 * reported as success or "no changes". A Haiku refusal on the `haiku` tier
 * re-runs the execute phase once on `sonnet`; anything else fails the run.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { IssueSubAgentTier } from "../types.ts";
import { type AgentRefusal, isHaikuModel } from "./agent_refusal.ts";
import { sanitiseModelId } from "./issue_sub_agent_degradation.ts";
import type { PhaseClaudeResult } from "./phase_run_stats.ts";

/** The tier the one refusal retry runs on (Issue #3406). */
export const REFUSAL_RETRY_TIER: IssueSubAgentTier = "sonnet";

/** What the execute phase does about the refusals an attempt recorded. */
export type RefusalAction = "none" | "retry-on-sonnet" | "fail";

/**
 * Decide what to do about an attempt's refusals.
 *
 * @returns `none` without refusals; `retry-on-sonnet` for a first Haiku
 *   refusal on the haiku tier; otherwise `fail`
 */
export function decideRefusalAction(args: {
  tier: IssueSubAgentTier;
  refusals: readonly AgentRefusal[];
  alreadyRetried: boolean;
}): RefusalAction {
  if (args.refusals.length === 0) return "none";
  if (
    args.tier === "haiku" && !args.alreadyRetried &&
    args.refusals.some((r) => isHaikuModel(r.model))
  ) {
    return "retry-on-sonnet";
  }
  return "fail";
}

/** A safety refusal the execute phase saw and what its one retry did. */
export interface AgentRefusalOutcome {
  /** Tier the refused attempt ran on. */
  tier: IssueSubAgentTier;
  /** That attempt's refusals. */
  refusals: AgentRefusal[];
  /**
   * "ran" = the sonnet retry started but its own verdict is not yet known
   * (e.g. it ended in a timeout failure).
   */
  retry: "not-retried" | "ran" | "succeeded" | "refused";
  /** The retry's refusals, when `retry` is "refused". */
  retryRefusals?: AgentRefusal[];
}

/** Refusals recorded by the results from index `from` onwards. */
export function refusalsRecordedSince(
  results: readonly PhaseClaudeResult[] | undefined,
  from: number,
): AgentRefusal[] {
  return (results ?? []).slice(from).flatMap((r) => r.runStats?.refusals ?? []);
}

/** Render a refusal list as `` `cyber` from `claude-haiku-5-5` ``, joined. */
function describeRefusals(refusals: readonly AgentRefusal[]): string {
  return refusals
    .map((r) =>
      `\`${sanitiseModelId(r.category)}\` from \`${sanitiseModelId(r.model)}\``
    )
    .join(", ");
}

/**
 * The failure reason for a refused run. Worker-authored and free of the
 * words `detectFailureCategory` keys off, so it never reads as infrastructure.
 */
export function buildRefusalFailureReason(
  outcome: AgentRefusalOutcome,
): string {
  const first = describeRefusals(outcome.refusals);
  if (outcome.retry === "not-retried") {
    return `Agent safety refusal on the \`${outcome.tier}\` sub-agent tier — ${first}; not retried, so the run fails rather than reporting success or no changes (Issue #3406)`;
  }
  return `Agent safety refusal on the \`haiku\` sub-agent tier — ${first}; the one retry on the \`${REFUSAL_RETRY_TIER}\` tier also refused — ${
    describeRefusals(outcome.retryRefusals ?? [])
  } — so the run fails rather than reporting success or no changes (Issue #3406)`;
}

/** The run-stats bullet for a refusal; `""` when there was none. */
export function buildAgentRefusalLine(outcome?: AgentRefusalOutcome): string {
  if (!outcome) return "";
  const retryTier = `\`${REFUSAL_RETRY_TIER}\``;
  let result: string;
  switch (outcome.retry) {
    case "not-retried":
      result = "not retried; the run failed";
      break;
    case "ran":
      result = `a retry ran on the ${retryTier} tier`;
      break;
    case "succeeded":
      result =
        `a retry ran on the ${retryTier} tier and finished without a refusal`;
      break;
    case "refused":
      result = `a retry ran on the ${retryTier} tier and also refused (${
        describeRefusals(outcome.retryRefusals ?? [])
      }); the run failed`;
      break;
  }
  return `- **Safety refusal:** ${
    describeRefusals(outcome.refusals)
  } on the \`${outcome.tier}\` sub-agent tier — ${result}`;
}
