/**
 * The billed result a result-carrying agent error holds (Issue #5029).
 *
 * A turn-cap stop ({@link AgentTurnLimitError}) and a refused split run
 * ({@link UnfinishedIssueExecutorError}) both end an invocation that already
 * ran and was billed. Each error carries that invocation's result, so its
 * provider, served model, token usage and tool tallies can be recorded the way
 * a successful invocation's are. Any other error carries no result, and
 * nothing is invented for it: its usage stays unavailable.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { ClaudeRunResult } from "./claude_runner.ts";
import { AgentTurnLimitError } from "./claude_turn_limit.ts";
import { UnfinishedIssueExecutorError } from "./issue_executor_enforcement.ts";

/** The billed invocation result `error` carries, or undefined when it has none. */
export function billedResultOfError(
  error: unknown,
): ClaudeRunResult | undefined {
  if (
    error instanceof AgentTurnLimitError ||
    error instanceof UnfinishedIssueExecutorError
  ) {
    return error.executionResult;
  }
  return undefined;
}
