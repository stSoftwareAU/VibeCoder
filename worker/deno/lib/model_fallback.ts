/**
 * Model fallback logic for rate-limit downgrade (Issue #1113).
 *
 * Provides pure functions for resolving the current model in use and
 * determining whether a cheaper fallback model is available. Used by
 * `runClaudeWithRetry()` to automatically downgrade models when
 * rate-limited or credit-exhausted.
 *
 * Provider-aware since Issue #365: both the current model and the ladder come
 * from the **active** coding-agent provider's descriptor, so a rate-limited
 * Codex or Gemini run no longer reasons about a Claude model id it is not
 * running, and a provider with no ladder says so loudly
 * (`no-ladder-for-provider`) instead of passing for "already on the cheapest
 * tier".
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type AgentProviderSelector,
  selectAgentProvider,
} from "./agent_provider.ts";
import type { EnvLookup } from "./env_lookup.ts";

/** Successful fallback result — a cheaper model is available. */
export interface ModelFallbackSuccess {
  ok: true;
  cheaperModel: string;
}

/** Failed fallback result — no cheaper model available or disabled. */
export interface ModelFallbackFailure {
  ok: false;
  reason: "disabled" | "already-cheapest";
}

/**
 * Failed fallback result — the active provider has no ladder at all
 * (Issue #365).
 *
 * Distinct from `already-cheapest`, which means the ladder exists and the run
 * is on its cheapest rung. This reason names the provider so the caller can
 * say which agent the downgrade was skipped for.
 */
export interface ModelFallbackNoLadder {
  ok: false;
  reason: "no-ladder-for-provider";
  /** Id of the provider that has no cheaper-model ladder. */
  provider: string;
}

/** Result of attempting a model fallback. */
export type ModelFallbackResult =
  | ModelFallbackSuccess
  | ModelFallbackFailure
  | ModelFallbackNoLadder;

/**
 * Resolve which model is currently in use given the options.
 *
 * An explicit `model` option always wins. Otherwise the resolution is
 * delegated wholesale to the provider descriptor's `resolveModel(phase)` —
 * the canonical model-precedence chain for whichever agent is actually
 * running (phase-specific env var, per-repo overrides #2625, global config
 * overrides #1265, phase default, base model env var). Each provider's
 * resolver states that ordering; this function deliberately does not restate
 * it so the two cannot drift apart. An empty string is returned when the chain
 * resolves nothing (unknown).
 *
 * @param model - Explicit model option from RunClaudeOptions
 * @param phase - Phase name for model selection
 * @param provider - Provider for this invocation; omit for the active one
 * @param env - Environment lookup for provider selection and phase routing
 *   (Issue #957); defaults to the process environment.
 * @returns The resolved model string
 */
export function resolveCurrentModel(
  model: string | undefined,
  phase: string | undefined,
  provider?: AgentProviderSelector,
  env?: EnvLookup,
): string {
  if (model) return model;

  return selectAgentProvider(provider, { env }).resolveModel(phase, env) ?? "";
}

/**
 * Attempt to find a cheaper fallback model.
 *
 * @param currentModel - The model currently in use
 * @param enabled - Whether model fallback is enabled
 * @param provider - Provider for this invocation; omit for the active one
 * @param env - Environment lookup for provider selection (Issue #957);
 *   defaults to the process environment.
 * @returns The fallback result
 */
export function attemptModelFallback(
  currentModel: string,
  enabled: boolean,
  provider?: AgentProviderSelector,
  env?: EnvLookup,
): ModelFallbackResult {
  if (!enabled) {
    return { ok: false, reason: "disabled" };
  }

  const descriptor = selectAgentProvider(provider, { env });

  // No ladder at all: report it as its own outcome (Issue #365). Returning
  // "already-cheapest" here would tell an operator the run was on the cheapest
  // tier when in truth no downgrade was ever attempted.
  if (!descriptor.cheaperModel) {
    return {
      ok: false,
      reason: "no-ladder-for-provider",
      provider: descriptor.id,
    };
  }

  const cheaper = descriptor.cheaperModel(currentModel);
  if (cheaper) {
    return { ok: true, cheaperModel: cheaper };
  }

  return { ok: false, reason: "already-cheapest" };
}

/** The minimum a caller must supply to receive the warning. */
interface ModelFallbackWarnLogger {
  warn(message: string): void;
}

/**
 * Providers already warned about a missing ladder, once per worker process.
 *
 * One warning per provider: a run that hits its rate limit repeatedly states
 * the gap once rather than on every retry, and a Quorum run driving two
 * ladder-less providers states it once for each.
 */
const _ladderWarnedProviders = new Set<string>();

/**
 * Clear the per-process ladder-warning state (Issue #365).
 *
 * Exposed so a test — or any caller that deliberately re-runs a scenario from
 * scratch — can observe the first warning again.
 */
export function clearModelLadderWarnings(): void {
  _ladderWarnedProviders.clear();
}

/**
 * Report, once per provider, that no downgrade was attempted (Issue #365).
 *
 * Fail loud, do not fail the run (Issue #3234): the rate limit is real and the
 * caller still gives up, but an operator must be able to *see* that the
 * documented downgrade never ran under this provider rather than infer it from
 * silence. A no-op for every other outcome, so callers can hand it any result.
 *
 * @param result - The fallback result to report.
 * @param currentModel - The model the run was on when the limit was hit.
 * @param logger - Run logger; defaults to `console.warn`.
 */
export function warnNoModelLadder(
  result: ModelFallbackResult,
  currentModel: string,
  logger?: ModelFallbackWarnLogger,
): void {
  if (result.ok || result.reason !== "no-ladder-for-provider") return;
  if (_ladderWarnedProviders.has(result.provider)) return;
  _ladderWarnedProviders.add(result.provider);

  const on = currentModel
    ? `model ${JSON.stringify(currentModel)}`
    : "its configured default model";
  const message =
    `[model-fallback] The ${result.provider} coding-agent provider has no ` +
    `cheaper-model ladder, so NO downgrade was attempted from ${on}. The ` +
    `rate-limit fallback documented in docs/MODEL-AND-CACHING.md applies to ` +
    `providers with a tier ladder (claude); under ${result.provider} the run ` +
    `waits and then gives up instead.`;

  if (logger) logger.warn(message);
  else console.warn(message);
}
