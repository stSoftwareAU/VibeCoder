/**
 * DeepSeek per-phase model / effort routing (Issue #413, parent #396).
 *
 * DeepSeek does not ship a CLI of its own: it is carried on the **Claude** CLI
 * pointed at DeepSeek's Anthropic-compatible endpoint, so the argv shape is
 * Claude's and there is no `deepseek_executor` argv builder to match
 * `gemini_executor.ts`. What DeepSeek does need is its own *routing*, and that
 * is what this module owns.
 *
 * Two provider facts drive it:
 *
 * - **Claude's routing resolves to tier aliases, not model ids.** `fable`,
 *   `opus`, `sonnet` and `haiku` mean nothing to DeepSeek's endpoint, and a
 *   provider that supplies no routing of its own resolves to `undefined` and
 *   lets the CLI fall back to an Anthropic model name the endpoint cannot
 *   resolve. Every phase is therefore pinned to a real DeepSeek model id in
 *   {@link DEEPSEEK_PHASE_MODEL_DEFAULTS}.
 * - **The endpoint does not implement Anthropic's effort control.** Following
 *   the Gemini precedent (Issue #364), the effort a phase was *asked* to run
 *   at is reported rather than turned into an argument: there is deliberately
 *   no DeepSeek effort table and no `deepseek_effort` config key, because
 *   either would be configuration that can never be applied (Issue #3234).
 *
 * There is deliberately **no** `cheaperModel` export either. DeepSeek publishes
 * no cheaper rung — `deepseek-chat` is a different model, not a cheaper tier of
 * `deepseek-reasoner` — so the descriptor omits the optional method entirely
 * and `model_fallback.ts` reports `no-ladder-for-provider` rather than
 * performing a silent no-op (Issue #365).
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  DEEPSEEK_PHASE_MODEL_DEFAULTS,
  PHASE_EFFORT_DEFAULTS,
} from "./config_defaults.ts";
import { type EnvLookup, resolvePhaseRoutedValue } from "./phase_routing.ts";
import type { RepoConfig } from "../types.ts";

/** Global `.config.json` `deepseek_phase_model_overrides` (Issue #413). */
let _deepseekPhaseModelConfigOverrides: Readonly<Record<string, string>> = {};

/** The active repo's DeepSeek routing overrides (Issue #413). */
let _repoDeepSeekModel = "";
let _repoDeepSeekPhaseModelOverrides: Readonly<Record<string, string>> = {};

/**
 * Record the global per-phase DeepSeek model overrides (Issue #413).
 *
 * Called during config loading with the `deepseek_phase_model_overrides` key.
 * These override {@link DEEPSEEK_PHASE_MODEL_DEFAULTS} and are themselves
 * overridden by the per-repo overrides and the `DEEPSEEK_MODEL_<PHASE>` env
 * var.
 *
 * @param overrides - Phase-to-model mapping from `.config.json`.
 */
export function setDeepSeekPhaseModelConfigOverrides(
  overrides: Record<string, string>,
): void {
  _deepseekPhaseModelConfigOverrides = { ...overrides };
}

/**
 * Set the active repo's DeepSeek model routing overrides (Issue #413).
 *
 * Mirrors `setActiveRepoGeminiModelOverrides` in `gemini_executor.ts`: call it
 * once when the worker starts work on a repo, passing that repo's merged
 * RepoConfig (or `undefined` to clear). It **replaces** — never merges — the
 * previously-active overrides, so a high-value repo's premium routing can never
 * leak into a filler repo when one worker process serves several repos.
 *
 * @param repoConfig - The active repo's RepoConfig, or undefined to clear.
 */
export function setActiveRepoDeepSeekModelOverrides(
  repoConfig: RepoConfig | undefined,
): void {
  _repoDeepSeekModel = repoConfig?.deepseekModel ?? "";
  _repoDeepSeekPhaseModelOverrides = {
    ...(repoConfig?.deepseekPhaseModelOverrides ?? {}),
  };
}

/**
 * Resolve the model DeepSeek runs a phase on — the value behind `--model`.
 *
 * The six-step chain itself lives in `phase_routing.ts`; this supplies
 * DeepSeek's names, tables and override state, so the precedence is Claude's
 * precedence with DeepSeek-named keys (Issue #413):
 *   1. `DEEPSEEK_MODEL_<PHASE>` env var — operator escape hatch
 *   2. Per-repo `deepseek_phase_model_overrides`
 *   3. Per-repo `deepseek_model` base tier — applies to all phases
 *   4. Global config `deepseek_phase_model_overrides`
 *   5. {@link DEEPSEEK_PHASE_MODEL_DEFAULTS} — the designed routing
 *   6. Base `DEEPSEEK_MODEL` env var — global fallback
 *
 * @param phase - Optional phase name (e.g. `"planning"`).
 * @param env - Environment lookup for steps 1 and 6 (Issue #957); defaults to
 *   the process environment.
 * @returns The resolved model, or `undefined` when no step supplies one — the
 *   CLI's configured default then stands, and a non-empty phase warns.
 */
export function resolveDeepSeekModel(
  phase?: string,
  env?: EnvLookup,
): string | undefined {
  return resolvePhaseRoutedValue({
    logPrefix: "deepseek-executor",
    what: "model",
    flag: "--model",
    envVar: "DEEPSEEK_MODEL",
    env,
    repoPhaseOverrides: _repoDeepSeekPhaseModelOverrides,
    repoPhaseOverridesKey: "deepseek_phase_model_overrides",
    repoBase: _repoDeepSeekModel,
    repoBaseKey: "deepseek_model",
    globalPhaseOverrides: _deepseekPhaseModelConfigOverrides,
    globalPhaseOverridesKey: "deepseek_phase_model_overrides",
    phaseDefaults: DEEPSEEK_PHASE_MODEL_DEFAULTS,
    phaseDefaultsName: "DEEPSEEK_PHASE_MODEL_DEFAULTS",
  }, phase);
}

/**
 * Resolve the reasoning effort a phase is *asked* to run at (Issue #413).
 *
 * The Claude CLI has `--effort`, but DeepSeek's Anthropic-compatible endpoint
 * does not implement Anthropic's effort control, so this value never becomes an
 * argument — there is deliberately no DeepSeek effort table and no DeepSeek
 * effort config key, because either would be configuration that can never be
 * applied. What it does supply is the signal the fail-loud standard requires
 * (Issue #3234): the worker's own phase effort design
 * ({@link PHASE_EFFORT_DEFAULTS}) is what an operator relying on defaults
 * expects to be honoured, so the request is reported through
 * {@link warnDeepSeekEffortUnsupported} instead of being discarded silently.
 *
 * @param phase - Optional phase name (e.g. `"planning"`).
 * @returns The effort the phase design asks for, or `undefined` when the phase
 *   is absent or has no designed effort — nothing to report in either case.
 */
export function resolveDeepSeekEffort(phase?: string): string | undefined {
  return phase ? PHASE_EFFORT_DEFAULTS[phase] : undefined;
}

/**
 * Phases already warned about an unhonourable effort, once per worker process.
 *
 * One warning per phase per process: a multi-phase run states the gap for each
 * distinct phase it routes, and a phase that is invoked repeatedly (a retry, a
 * quality-fix loop) states it once. The key of a phase-less invocation is the
 * empty string, so it too warns once.
 */
const _effortWarnedPhases = new Set<string>();

/**
 * Clear the per-process effort-warning state (Issue #413).
 *
 * Exposed so a test — or any caller that deliberately re-runs a phase as a
 * fresh scenario — can observe the first warning again.
 */
export function clearDeepSeekEffortWarnings(): void {
  _effortWarnedPhases.clear();
}

/**
 * Report an effort DeepSeek's endpoint cannot honour, once per phase.
 *
 * Fail loud, do not fail the run (Issue #364's precedent): the invocation is
 * valid, it simply cannot carry the lever, so the warning *is* the fix. Passing
 * the flag through to an endpoint that does not implement it would either be
 * rejected or silently ignored, and the silent case is the one that hides.
 *
 * @param effort - The requested reasoning effort.
 * @param phase - The phase it was requested for, when there is one.
 */
export function warnDeepSeekEffortUnsupported(
  effort: string,
  phase?: string,
): void {
  const key = phase ?? "";
  if (_effortWarnedPhases.has(key)) return;
  _effortWarnedPhases.add(key);

  const where = phase ? `phase "${phase}"` : "a phase-less invocation";
  console.warn(
    `[deepseek] Reasoning effort ${JSON.stringify(effort)} requested for ` +
      `${where} but DeepSeek's Anthropic-compatible endpoint has no effort ` +
      `control; the request is ignored. Run this phase under a provider that ` +
      `has the lever (claude, codex), or clear the effort configuration for ` +
      `it.`,
  );
}
