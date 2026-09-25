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
 * "this run was free". `turns` follows the same rule (Issue #2100) — a
 * provider that never reported `num_turns` reports no turn count, not nought
 * turns.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { estimateRunCost, type ModelUsageEntry } from "./cost_estimate.ts";
import type {
  CallbackRunTelemetry,
  TelemetryAbsentReason,
} from "./run_callbacks.ts";
import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
} from "./agent_provider.ts";

/** The per-invocation stats this summariser reads. */
export interface TelemetrySource {
  runStats?: {
    servedModels: string[];
    requestedModel: string;
    /**
     * Effort the invocation was started with, verbatim from the argv the
     * runner built (Issue #2573). Absent when the provider takes none.
     */
    effort?: string;
    /** Turns the provider reported for this invocation, when it reported any. */
    numTurns?: number;
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
  let turns: number | undefined;
  /** The dominant invocation so far: most tokens wins, first-seen on a tie. */
  let dominant: { model: string; effort?: string; tokens: number } | undefined;

  for (const invocation of invocations) {
    const stats = invocation.runStats;
    if (!stats) continue;
    // Turns are summed independently of usage (Issue #2100), the same way
    // `aggregateRunStats` does it: an invocation killed after reporting
    // `num_turns` but before a parseable usage line still took those turns.
    // Absent stays absent — a provider that reports none omits the field.
    if (stats.numTurns !== undefined) turns = (turns ?? 0) + stats.numTurns;
    if (!stats.tokenUsage) continue;
    inputTokens += stats.tokenUsage.inputTokens;
    outputTokens += stats.tokenUsage.outputTokens;
    cacheCreationTokens += stats.tokenUsage.cacheCreationTokens;
    cacheReadTokens += stats.tokenUsage.cacheReadTokens;
    // Attributed to the model the API actually served, falling back to the
    // requested one — the same rule the per-run stats comment applies.
    const model = stats.servedModels[0] ?? stats.requestedModel;
    entries.push({ model, usage: stats.tokenUsage });
    // Issue #2100: one run can be served by several models, so `model` names
    // the one the largest share of the run went through — the invocation with
    // the biggest token total. Tokens rather than estimated cost, because a
    // model with no pricing row has no cost to rank by but always has a token
    // count. Deterministic: strictly-greater, so an exact tie keeps the
    // earlier invocation rather than depending on iteration luck.
    const tokens = stats.tokenUsage.inputTokens +
      stats.tokenUsage.outputTokens +
      stats.tokenUsage.cacheCreationTokens +
      stats.tokenUsage.cacheReadTokens;
    if (dominant === undefined || tokens > dominant.tokens) {
      // Issue #2573: the effort travels with the model, from the same
      // invocation, so `model` and `effort` can never describe two calls.
      dominant = { model, effort: stats.effort, tokens };
    }
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
    ...(turns !== undefined ? { turns } : {}),
    ...(dominant ? { model: dominant.model } : {}),
    ...(dominant?.effort ? { effort: dominant.effort } : {}),
  };
}

/**
 * Providers whose adapters populate `tokenUsage` when the CLI reports it.
 *
 * A missing count from one of these is "the run did not report usage"
 * (killed before the terminal result line), not "this adapter never fills
 * the field". Any other provider id is `provider_unsupported` (Issue #1948).
 */
const PROVIDERS_WITH_USAGE_ADAPTER: ReadonlySet<string> = new Set([
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
]);

/**
 * Why a run has no callback telemetry (Issue #1948).
 *
 * Returns `undefined` when {@link summariseCallbackTelemetry} produced a
 * value — the caller publishes `telemetry` in that case, never a reason.
 */
export function callbackTelemetryAbsenceReason(
  invocations: readonly TelemetrySource[],
  provider?: string,
): TelemetryAbsentReason | undefined {
  if (summariseCallbackTelemetry(invocations) !== undefined) return undefined;
  if (invocations.length === 0) return "agent_not_invoked";
  if (provider !== undefined && !PROVIDERS_WITH_USAGE_ADAPTER.has(provider)) {
    return "provider_unsupported";
  }
  return "usage_not_reported";
}
