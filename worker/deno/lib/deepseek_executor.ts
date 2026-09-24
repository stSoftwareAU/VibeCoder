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
 * no cheaper rung — `deepseek-flash` is a different model, not a cheaper tier of
 * `deepseek-v4-pro` — so the descriptor omits the optional method entirely
 * and `model_fallback.ts` reports `no-ladder-for-provider` rather than
 * performing a silent no-op (Issue #365).
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  DEEPSEEK_PHASE_MODEL_DEFAULTS,
  DEFAULT_DEEPSEEK_MODEL_TOP_TIER,
  PHASE_EFFORT_DEFAULTS,
} from "./config_defaults.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { resolvePhaseRoutedValue } from "./phase_routing.ts";
import type { RepoConfig } from "../types.ts";

/** Global `.config.json` `deepseek_phase_model_overrides` (Issue #413). */
let _deepseekPhaseModelConfigOverrides: Readonly<Record<string, string>> = {};

/** The active repo's DeepSeek routing overrides (Issue #413). */
let _repoDeepSeekModel = "";
let _repoDeepSeekPhaseModelOverrides: Readonly<Record<string, string>> = {};

/** Models the vendor currently cannot serve, for this run (Issue #2059). */
let _unavailableDeepSeekModels = new Set<string>();

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
  const model = resolvePhaseRoutedValue({
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

  // (Issue #2059) A tier the vendor cannot serve: when the phase's value came
  // from the designed default — every operator/repo/env layer absent — route
  // it to the top tier for this run instead. An explicit pin always wins,
  // and a phase already on the top tier is untouched.
  if (
    model && phase &&
    _unavailableDeepSeekModels.has(model.trim().toLowerCase())
  ) {
    const defaultsValue = DEEPSEEK_PHASE_MODEL_DEFAULTS[
      phase as keyof typeof DEEPSEEK_PHASE_MODEL_DEFAULTS
    ];
    const defaultSupplied = defaultsValue === model &&
      !_repoDeepSeekPhaseModelOverrides[phase] &&
      !_repoDeepSeekModel &&
      !_deepseekPhaseModelConfigOverrides[phase] &&
      !(env ?? processEnvLookup)(`DEEPSEEK_MODEL_${phase.toUpperCase()}`);
    if (defaultSupplied && defaultsValue !== DEFAULT_DEEPSEEK_MODEL_TOP_TIER) {
      warnAdaptedDeepSeekModelOnce(phase, model);
      return DEFAULT_DEEPSEEK_MODEL_TOP_TIER;
    }
  }
  return model;
}

/**
 * Phases already warned about a tier adaptation, once per worker process.
 */
const _adaptationWarnedPhases = new Set<string>();

/**
 * Report a tier adaptation loudly, once per phase per process (Issue #2059).
 */
function warnAdaptedDeepSeekModelOnce(
  phase: string,
  unavailable: string,
): void {
  if (_adaptationWarnedPhases.has(phase)) return;
  _adaptationWarnedPhases.add(phase);
  console.warn(
    `[deepseek] Model ${JSON.stringify(unavailable)} probed unavailable — ` +
      `adapting phase "${phase}" to ${DEFAULT_DEEPSEEK_MODEL_TOP_TIER} for ` +
      `this run (Issue #2059). Explicit pins still win.`,
  );
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

/**
 * Report sub-agent definitions DeepSeek's endpoint cannot carry (Issue #2342).
 *
 * The same fail-loud-but-run treatment {@link warnDeepSeekEffortUnsupported}
 * gives an unhonourable effort: the sub-agent definitions name Anthropic tier
 * aliases the endpoint cannot resolve, so DeepSeek keeps single-model routing.
 * Stated every time rather than once per phase — a run told it is splitting
 * work across two tiers and is not must say so on the invocation that did it.
 *
 * @param phase - The phase the definitions were requested for, when there is one.
 */
export function warnDeepSeekAgentsUnsupported(phase?: string): void {
  const where = phase ? `phase "${phase}"` : "a phase-less invocation";
  console.warn(
    `[deepseek] Sub-agent definitions (--agents) were requested for ${where} ` +
      `but DeepSeek's Anthropic-compatible endpoint cannot resolve the ` +
      `Anthropic model tiers they name; the run keeps single-model routing ` +
      `and its sub-agents (the issue reviewers included, Issue #2575) run ` +
      `on the phase's own model. Run this phase under the claude provider ` +
      `for tiered sub-agents.`,
  );
}

/**
 * Whether a run served `served` satisfies the expectation `expected`
 * (Issue #2053).
 *
 * The vendor's endpoint does not always serve the id it was asked for:
 *
 * - It serves `deepseek-v4-pro` (the top tier) when `deepseek-flash` (the
 *   base tier) is asked — observed live on the first production run, where
 *   the worker flagged an upgrade as degraded. An upgrade is not
 *   degradation: the detector exists to catch runs served a *worse* model
 *   than designed.
 * - It serves the documented legacy alias `deepseek-v4-flash*` for
 *   Flash-tier requests ("still accepted, served by the Flash model").
 *   The same tier under a legacy name is not degradation either.
 *
 * A downgrade — top tier asked, Flash-tier served — still fails the check,
 * exactly like an id from a different vendor. Matching is case-insensitive
 * and prefix-aware on both sides, mirroring {@link planning_run_stats}
 * `modelsMatch`.
 *
 * @param served - The model id the API declared it served.
 * @param expected - The model id the invocation was expected to run on.
 * @returns True when the served model satisfies the expectation.
 */
export function deepSeekServedModelSatisfies(
  served: string,
  expected: string,
): boolean {
  const s = served.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  if (s === e || s.startsWith(e) || e.startsWith(s)) return true;

  const expectedFlashTier = e.startsWith("deepseek-flash") ||
    e.startsWith("deepseek-v4-flash");
  if (!expectedFlashTier) return false;

  // The vendor's upgrade remap: base tier asked, top tier served.
  if (s.startsWith("deepseek-v4-pro")) return true;
  // The vendor's documented legacy alias of the Flash model.
  if (s.startsWith("deepseek-v4-flash")) return true;

  return false;
}

/**
 * Record the models the vendor currently cannot serve, for this run
 * (Issue #2059). Replaces — never merges — the previous set, on the same
 * rule as the per-repo override state.
 *
 * @param models - Model ids that probed unavailable.
 */
export function setUnavailableDeepSeekModels(models: readonly string[]): void {
  _unavailableDeepSeekModels = new Set(
    models.map((m) => m.trim().toLowerCase()).filter((m) => m !== ""),
  );
}

/**
 * Clear the unavailable-model set (Issue #2059).
 *
 * Exposed so a test — or a caller deliberately re-running as a fresh
 * scenario — can observe the designed routing again.
 */
export function clearUnavailableDeepSeekModels(): void {
  _unavailableDeepSeekModels = new Set();
}

/**
 * The same-provider tiers to try when `model` is unavailable (Issue #2059).
 *
 * The base (Flash) tier has one alternative: the top tier. The top tier has
 * none — nothing cheaper can stand in for it, and the health gate owns the
 * provider-level verdict from there.
 *
 * @param model - The model id that probed unavailable.
 * @returns Ordered alternative model ids, or [] when none exist.
 */
export function deepSeekAlternativeModels(model: string): string[] {
  const wanted = model.trim().toLowerCase();
  return wanted.startsWith("deepseek-flash") ||
      wanted.startsWith("deepseek-v4-flash")
    ? [DEFAULT_DEEPSEEK_MODEL_TOP_TIER]
    : [];
}

/**
 * Apply the tier adaptation for this run (Issue #2059).
 *
 * Records `unavailable` in the per-run set; the resolver then moves phases
 * whose designed default is that model onto the top tier. `alternative` is
 * the id the health gate probed healthy and is logged so the run's record
 * names what the vendor will actually serve.
 *
 * @param unavailable - The model id that probed unavailable.
 * @param alternative - The healthy alternative the probe confirmed.
 */
export function applyDeepSeekModelAdaptation(
  unavailable: string,
  alternative: string,
): void {
  setUnavailableDeepSeekModels([..._unavailableDeepSeekModels, unavailable]);
  console.warn(
    `[deepseek] Model ${JSON.stringify(unavailable)} probed unavailable — ` +
      `adapting this run's routing to ${alternative} (Issue #2059). ` +
      `Explicit pins still win.`,
  );
}
