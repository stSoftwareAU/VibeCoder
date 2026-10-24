/**
 * Production planner for a worker-gate split (Issue #4130).
 *
 * The model is asked for a JSON breakdown with write and shell tools
 * disabled, so it cannot mark a pull request ready or arm auto-merge.
 * The worker files the sub-issues itself. Unit tests stub
 * {@link planWorkerGateSplitWithModel}'s `complete` callback, or stub
 * `planWorkerGateSplit` on the failure handler, and never call this.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  runClaudeWithRetry,
  SUMMARISE_DISALLOWED_TOOLS,
} from "./claude_runner.ts";
import type { RunClaudeOptions } from "./claude_runner.ts";
import {
  planWorkerGateSplitWithModel,
  type WorkerGatePlan,
  type WorkerGateSplitSeed,
} from "./worker_gate_split.ts";

/**
 * Tools the planning call must not have. Shell and edit tools would let
 * the model mark a pull request ready or arm auto-merge while the gate
 * is still failing.
 */
export const WORKER_GATE_PLAN_DISALLOWED_TOOLS: readonly string[] = [
  ...SUMMARISE_DISALLOWED_TOOLS,
  "Read",
  "Grep",
  "Glob",
];

/** The model invocation for one split. Pure: it does not run the model. */
export function workerGatePlanInvocation(
  prompt: string,
  issueNumber: number,
): RunClaudeOptions {
  return {
    prompt,
    systemPrompt:
      "You break one blocked issue into pull-request-sized parts. " +
      "Reply with JSON only. Each part title must differ from the parent " +
      "issue title. Do not change files, open pull requests, " +
      "mark a pull request ready, or arm auto-merge.",
    timeoutSeconds: 300,
    phase: "planning",
    issueNumber,
    disallowedTools: [...WORKER_GATE_PLAN_DISALLOWED_TOOLS],
  };
}

/**
 * Planning step bound into the worker. Calls the model. Tests do not
 * call this; they inject their own planner.
 */
export function defaultPlanWorkerGateSplit(
  seed: WorkerGateSplitSeed,
): Promise<WorkerGatePlan> {
  return planWorkerGateSplitWithModel(seed, async (prompt) => {
    const result = await runClaudeWithRetry(
      workerGatePlanInvocation(prompt, seed.parentIssueNumber),
    );
    if (!result.ok) throw result.error;
    if (result.value.exitCode !== 0) {
      throw new Error(
        `worker-gate planning exited ${result.value.exitCode}`,
      );
    }
    return result.value.output;
  });
}
