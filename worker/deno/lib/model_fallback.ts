/**
 * Model fallback logic for rate-limit downgrade (Issue #1113).
 *
 * Provides pure functions for resolving the current model in use and
 * determining whether a cheaper fallback model is available. Used by
 * `runClaudeWithRetry()` to automatically downgrade models when
 * rate-limited or credit-exhausted.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { getCheaperModel } from "./config_defaults.ts";
import { buildClaudeModelArgs } from "./claude_executor.ts";

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

/** Result of attempting a model fallback. */
export type ModelFallbackResult = ModelFallbackSuccess | ModelFallbackFailure;

/**
 * Resolve which model is currently in use given the options.
 *
 * An explicit `model` option always wins. Otherwise the resolution is
 * delegated wholesale to `buildClaudeModelArgs(phase)` — the canonical
 * model-precedence chain (phase-specific env var, per-repo overrides #2625,
 * global config overrides #1265, phase default, base CLAUDE_MODEL env var).
 * See `buildClaudeModelArgs` for the authoritative ordering; this function
 * deliberately does not restate it so the two cannot drift apart. An empty
 * string is returned when the chain resolves nothing (unknown).
 *
 * @param model - Explicit model option from RunClaudeOptions
 * @param phase - Phase name for model selection
 * @returns The resolved model string
 */
export function resolveCurrentModel(
  model: string | undefined,
  phase: string | undefined,
): string {
  if (model) return model;

  // Use buildClaudeModelArgs to resolve env vars and phase defaults
  const args = buildClaudeModelArgs(phase);
  if (args.length >= 2) {
    return args[1]!;
  }

  return "";
}

/**
 * Attempt to find a cheaper fallback model.
 *
 * @param currentModel - The model currently in use
 * @param enabled - Whether model fallback is enabled
 * @returns The fallback result
 */
export function attemptModelFallback(
  currentModel: string,
  enabled: boolean,
): ModelFallbackResult {
  if (!enabled) {
    return { ok: false, reason: "disabled" };
  }

  const cheaper = getCheaperModel(currentModel);
  if (cheaper) {
    return { ok: true, cheaperModel: cheaper };
  }

  return { ok: false, reason: "already-cheapest" };
}
