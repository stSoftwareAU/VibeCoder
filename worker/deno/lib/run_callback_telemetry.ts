/**
 * Token and cost telemetry for the post-run callback context (Issue #806,
 * parent #796).
 *
 * One issue run makes several agent invocations, each with its own served
 * model. This module sums their token usage and prices it through the same
 * `estimateRunCost()` the per-run stats comment uses, so a callback and the
 * comment can never disagree about what a run cost.
 *
 * Absent rather than zero: a run whose invocations reported no parseable
 * usage yields `undefined`, and a run whose models have no pricing row yields
 * token counts with no `estimatedCostUsd`. An implied zero would read as
 * "this run was free".
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { estimateRunCost, type ModelUsageEntry } from "./cost_estimate.ts";
import type { CallbackRunTelemetry } from "./run_callbacks.ts";

/** The per-invocation stats this summariser reads. */
export interface TelemetrySource {
  runStats?: {
    servedModels: string[];
    requestedModel: string;
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
    };
  };
}

/**
 * Sum one run's invocations into the callback telemetry, or `undefined` when
 * no invocation reported usage the worker could parse.
 */
export function summariseCallbackTelemetry(
  invocations: readonly TelemetrySource[],
): CallbackRunTelemetry | undefined {
  const entries: ModelUsageEntry[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  for (const invocation of invocations) {
    const stats = invocation.runStats;
    if (!stats?.tokenUsage) continue;
    inputTokens += stats.tokenUsage.inputTokens;
    outputTokens += stats.tokenUsage.outputTokens;
    cacheCreationTokens += stats.tokenUsage.cacheCreationTokens;
    cacheReadTokens += stats.tokenUsage.cacheReadTokens;
    entries.push({
      // Attributed to the model the API actually served, falling back to the
      // requested one — the same rule the per-run stats comment applies.
      model: stats.servedModels[0] ?? stats.requestedModel,
      usage: stats.tokenUsage,
    });
  }

  if (entries.length === 0) return undefined;

  const estimate = estimateRunCost(entries);
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    // Omitted when any model with tokens had no pricing row: a partial total
    // presented as the run's cost would understate the spend.
    ...(estimate.hasUnknownPricing
      ? {}
      : { estimatedCostUsd: estimate.totalCost }),
  };
}
