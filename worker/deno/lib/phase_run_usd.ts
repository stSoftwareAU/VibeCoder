/**
 * Estimated USD for a phase run's Claude invocations (Issue #3404).
 *
 * Single source of the USD maths for a phase run's Claude invocations.
 * `measureIssuePhaseRun` and the PR-feedback and CI-fix paths all call it, so
 * every phase is priced identically.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { attributeUsageByModel, estimateRunCost } from "./cost_estimate.ts";
import type { ModelUsageEntry } from "./cost_estimate.ts";
import type { RunStats } from "./run_stats.ts";

/**
 * Estimate the total USD cost of a phase run from its per-invocation stats.
 *
 * @param runStats - Run stats of each invocation; undefined entries and
 *   entries without token usage are skipped
 * @param fallbackModel - Model assumed when the stats name no served model
 * @returns Estimated total cost in USD (0 when nothing is priceable)
 */
export function estimatePhaseRunUsd(
  runStats: readonly (RunStats | undefined)[],
  fallbackModel: string,
): number {
  const entries: ModelUsageEntry[] = [];
  for (const stats of runStats) {
    if (stats?.tokenUsage) {
      entries.push(
        ...attributeUsageByModel(
          stats.tokenUsage,
          stats.modelUsage,
          stats.servedModels[0] ?? fallbackModel,
        ),
      );
    }
  }
  return estimateRunCost(entries).totalCost;
}
