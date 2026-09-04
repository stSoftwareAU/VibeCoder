/**
 * Phase model escalation for large inputs (Issue #2393).
 *
 * The `summarise` (plus `health`, `spelling_fix`) phases are pinned to
 * Haiku for cost — see `DEFAULT_CLAUDE_MODEL_SUMMARISE` in
 * `config_defaults.ts`. Haiku has a 200k context window (vs 1M for
 * Sonnet/Opus), and `summarise` is exactly the phase fed large inputs
 * (whole sessions, transcripts, oversized issue bodies). When the input
 * exceeds 200k it silently truncates on Haiku — degrading the summary
 * without any signal.
 *
 * This module decides whether a phase's input is large enough that the
 * default Haiku-tier model should be escalated for that single run. The
 * caller forwards the returned `model` to `runClaudeWithTimeout` as an
 * explicit override and logs the `reason` so the escalation is visible
 * in run logs.
 *
 * The escalation is one-shot — it does not mutate the global model
 * defaults — and only fires when the resolved model has a context window
 * smaller than the escalation target's. A phase that has already been
 * pinned to Sonnet/Opus by env var or config override is left alone.
 *
 * Uses Australian English throughout (behaviour, colour, organisation,
 * summarise).
 */

import {
  CONTEXT_BUDGET_DEFAULTS,
  getContextWindowSize,
  MODEL_CONTEXT_WINDOWS,
} from "./context_budget.ts";
import { resolveCurrentModel } from "./model_fallback.ts";
import type { EnvLookup } from "./phase_routing.ts";

/**
 * Default escalation target when the configured model's window is too
 * small for the estimated input. Sonnet has a 1M context window — same
 * as Opus — and is markedly cheaper, so it is the natural escalation
 * destination from Haiku.
 */
export const DEFAULT_ESCALATION_TARGET = "sonnet" as const;

/**
 * Default threshold (as a percentage of the resolved model's window) at
 * which we escalate. Matches `CONTEXT_BUDGET_DEFAULTS.errorThresholdPercent`
 * (80%) so escalation kicks in at the same point the context-budget
 * monitor would otherwise emit an error. 20% headroom is reserved for
 * the prompt boilerplate (system prompt, summarise instructions) and the
 * response itself.
 */
export const HAIKU_ESCALATION_THRESHOLD_PERCENT =
  CONTEXT_BUDGET_DEFAULTS.errorThresholdPercent;

/** Result of a model-escalation check. */
export interface ModelEscalationResult {
  /** Whether the model was escalated for this run. */
  escalated: boolean;
  /**
   * The model to use. When `escalated` is true this is the escalation
   * target; otherwise it is the resolved model for the phase (which may
   * be an empty string if no model is configured anywhere — the caller
   * should treat that as "let `buildClaudeModelArgs` decide").
   */
  model: string;
  /**
   * Human-readable reason — populated only when `escalated` is true.
   * Suitable for `logger.info()`.
   */
  reason?: string;
}

/** Optional overrides for `selectModelForLargeInput`. */
export interface SelectModelOptions {
  /** Override the escalation target (default: `sonnet`). */
  escalationTarget?: string;
  /** Override the threshold percentage (default: 80). */
  thresholdPercent?: number;
  /**
   * Environment lookup the phase's model resolution reads through
   * (Issue #957); defaults to the process environment.
   */
  env?: EnvLookup;
}

/**
 * Decide whether to escalate the model for a phase based on the
 * estimated input-token count.
 *
 * Escalation fires when ALL of the following hold:
 *   1. The resolved model's context window is smaller than the
 *      escalation target's window (otherwise escalation buys nothing).
 *   2. `estimatedInputTokens` is at or above
 *      `thresholdPercent`% of the resolved model's window.
 *
 * When the resolved model already has at least as much context as the
 * escalation target (e.g. the phase has been pinned to Sonnet or Opus),
 * no escalation is performed and the configured model is returned
 * unchanged.
 *
 * Negative or zero token counts never escalate.
 *
 * @param phase - Phase name (e.g. "summarise")
 * @param estimatedInputTokens - Estimated token count of the input
 * @param overrides - Optional threshold / escalation-target overrides
 * @returns Escalation decision
 */
export function selectModelForLargeInput(
  phase: string,
  estimatedInputTokens: number,
  overrides?: SelectModelOptions,
): ModelEscalationResult {
  const resolved = resolveCurrentModel(
    undefined,
    phase,
    undefined,
    overrides?.env,
  );
  const target = overrides?.escalationTarget ?? DEFAULT_ESCALATION_TARGET;
  const thresholdPercent = overrides?.thresholdPercent ??
    HAIKU_ESCALATION_THRESHOLD_PERCENT;

  const resolvedWindow = getContextWindowSize(resolved);
  const targetWindow = getContextWindowSize(target);

  // Already on a model with at least as much window as the target — no
  // escalation possible (or worthwhile).
  if (resolvedWindow >= targetWindow) {
    return { escalated: false, model: resolved };
  }

  // Clamp to avoid odd behaviour on negative inputs.
  const tokens = Math.max(0, estimatedInputTokens);
  const thresholdTokens = Math.floor(
    (resolvedWindow * thresholdPercent) / 100,
  );
  if (tokens < thresholdTokens) {
    return { escalated: false, model: resolved };
  }

  const resolvedLabel = resolved || "default";
  const reason = `Input (~${tokens.toLocaleString()} tokens) is at or above ` +
    `${thresholdPercent}% of the ${resolvedLabel} ` +
    `${resolvedWindow.toLocaleString()}-token context window ` +
    `(haiku=${MODEL_CONTEXT_WINDOWS.haiku!.toLocaleString()}); ` +
    `escalating to ${target} for this run`;

  return { escalated: true, model: target, reason };
}
