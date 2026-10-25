/**
 * Shared context-budget guard for the Claude execution phases (Issue #3713).
 *
 * `checkContextBudget` used to be purely observational, so an issue that
 * never converged was bounded only by wall-clock while `loop.sh` restarted
 * the worker forever. This module holds the two pieces both execution
 * phases need to enforce the hard ceiling consistently:
 *
 * 1. `buildContextComponents` — one assembly of the prompt component
 *    breakdown, so both phases measure the same thing.
 * 2. `handOffOversizedIssueToPlanning` — what happens when the prompt still
 *    does not fit after the phase trimmed the comment and CI-log history.
 *
 * The ceiling never hands the issue to a human (Issue #4298). It used to add
 * `needs-human` and ask a person to split the issue or trim its thread; both
 * are work the worker can do. A phase first retries with the history trimmed,
 * and an issue that still does not fit goes through the same planning hand-off
 * the `vibe-needs-planning` marker uses, which splits it into sub-issues.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  type ContextBudgetResult,
  type ContextComponent,
  estimateComponentTokens,
} from "./context_budget.ts";
import {
  handOffToPlanning,
  hasPriorPlanningHandoffOnThread,
  type PlanningHandoffResult,
} from "./planning_handoff.ts";
import { PLANNING_HANDOFF_ANCHOR } from "./planning_handoff_trust.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";

/** Raw prompt texts measured by the budget guard. */
export interface ContextBudgetComponentTexts {
  /** Static system prompt (coding guidelines). Omitted when empty. */
  systemPrompt?: string;
  /** Dynamic user prompt assembled for this issue. */
  userPrompt: string;
  /** Issue body as sent to the model. */
  issueBody: string;
  /** Per-repo custom instructions. Omitted when empty. */
  customInstructions?: string;
  /** Recent repository activity summary. Omitted when empty. */
  recentActivity?: string;
  /** CI failure log context. Omitted when empty. */
  ciFailureContext?: string;
}

/**
 * Build the prompt component breakdown for a budget check.
 *
 * `system`, `dynamic` and `issue` are always present (a zero-token entry
 * still records that the component was measured); optional components are
 * included only when non-empty.
 */
export function buildContextComponents(
  texts: ContextBudgetComponentTexts,
): ContextComponent[] {
  const components: ContextComponent[] = [];

  if (texts.systemPrompt) {
    components.push({
      name: "system",
      tokens: estimateComponentTokens(texts.systemPrompt),
    });
  }
  components.push({
    name: "dynamic",
    tokens: estimateComponentTokens(texts.userPrompt),
  });
  components.push({
    name: "issue",
    tokens: estimateComponentTokens(texts.issueBody),
  });
  if (texts.customInstructions) {
    components.push({
      name: "custom_instructions",
      tokens: estimateComponentTokens(texts.customInstructions),
    });
  }
  if (texts.recentActivity) {
    components.push({
      name: "recent_activity",
      tokens: estimateComponentTokens(texts.recentActivity),
    });
  }
  if (texts.ciFailureContext) {
    components.push({
      name: "ci_failure_log",
      tokens: estimateComponentTokens(texts.ciFailureContext),
    });
  }

  return components;
}

/**
 * Explain why the ceiling stopped the phase.
 *
 * Names the largest component, so the planning hand-off comment and the run
 * log both say what made the prompt too big.
 */
export function buildContextBudgetEscalationReason(
  result: ContextBudgetResult,
): string {
  const reason = result.blockReason ??
    `Context usage (${result.usagePercent.toFixed(1)}%) reached the hard ` +
      `ceiling.`;

  const largest = result.components.reduce<ContextComponent | undefined>(
    (max, c) => (!max || c.tokens > max.tokens ? c : max),
    undefined,
  );
  const largestNote = largest
    ? ` Largest component: \`${largest.name}\` at ${largest.tokens.toLocaleString()} tokens.`
    : "";

  return `${reason} The worker stopped before invoking Claude rather than ` +
    `sending a prompt the model would truncate, even with the comment and ` +
    `CI-log history trimmed.${largestNote}`;
}

/** Options for {@link handOffOversizedIssueToPlanning}. */
export interface OversizedIssueHandoff {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  githubUser: string;
  issueLabels: readonly string[];
  /** {@link buildContextBudgetEscalationReason} for the blocked check. */
  reason: string;
  logger: Logger;
  ensureLabelExists?: (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
}

/**
 * Send an issue whose prompt cannot fit the window to planning (Issue #4298).
 *
 * Reuses the `vibe-needs-planning` hand-off (Issue #2688) and its two trust
 * conditions: the `work-on` anchor that lets label security trust the
 * worker's own `planning`, and no earlier hand-off on the thread. When either
 * fails, nothing is applied and `applied: false` is returned, so the phase
 * fails and the issue walks the normal `failed-once` ladder — it is never
 * handed to a human.
 */
export async function handOffOversizedIssueToPlanning(
  opts: OversizedIssueHandoff,
): Promise<PlanningHandoffResult> {
  const { ghClient, repo, issueNumber, logger } = opts;
  if (!opts.issueLabels.includes(PLANNING_HANDOFF_ANCHOR)) {
    logger.warn(
      `Context budget ceiling: no \`${PLANNING_HANDOFF_ANCHOR}\` anchor, so ` +
        "the planning hand-off is not trusted — retrying instead",
      { repo, issueNumber },
    );
    return { applied: false };
  }
  const repeat = await hasPriorPlanningHandoffOnThread({
    ghClient,
    repo,
    issueNumber,
    fallbackComments: "",
    logger,
  });
  if (repeat) {
    logger.warn(
      "Context budget ceiling: the issue was already handed to planning " +
        "once — retrying instead",
      { repo, issueNumber },
    );
    return { applied: false };
  }
  return await handOffToPlanning({
    ghClient,
    repo,
    issueNumber,
    githubUser: opts.githubUser,
    reason: opts.reason,
    outputSnippet: "",
    logger,
    ...(opts.ensureLabelExists
      ? { deps: { ensureLabelExists: opts.ensureLabelExists } }
      : {}),
  });
}
