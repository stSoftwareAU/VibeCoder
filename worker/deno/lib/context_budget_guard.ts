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
 * 2. The escalation copy — a single wording for the `needs-human` hand-off
 *    that fires when the ceiling blocks a phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import {
  type ContextBudgetResult,
  type ContextComponent,
  estimateComponentTokens,
} from "./context_budget.ts";

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

/** What a human must do when the ceiling blocks a phase. */
export const CONTEXT_BUDGET_NEXT_STEP =
  "Shrink what this issue drags into the prompt — split it into smaller " +
  "issues, trim the issue body, or cut the CI log / comment history it " +
  "pulls in — then remove `needs-human` and re-apply `work-on`. Raising " +
  "`context_budget_block_percent` only defers the truncation; it does not " +
  "make the prompt fit.";

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
 * Build the `**Why:**` line for the `needs-human` escalation.
 *
 * Names the largest component so the human can see what to trim.
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
    `sending a prompt the model would truncate, so this issue cannot make ` +
    `progress on its own.${largestNote}`;
}
