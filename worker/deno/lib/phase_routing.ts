/**
 * The per-phase model / reasoning-effort precedence chain, stated once
 * (Issue #363, parent #357).
 *
 * Every provider routes a work phase to a model and an effort through the same
 * six steps — an operator escape hatch first, the designed cost defaults last —
 * and only the *names* differ between providers: Claude reads `CLAUDE_MODEL_*`
 * and `PHASE_MODEL_DEFAULTS`, Codex reads `CODEX_MODEL_*` and
 * `CODEX_PHASE_MODEL_DEFAULTS`. This module owns the order; each provider's
 * resolver supplies its own names, tables and override state, so a second
 * provider is a set of {@link PhaseRoutingSources} rather than a second copy of
 * the chain.
 *
 * ```mermaid
 * flowchart LR
 *     A["1. PREFIX_&lt;PHASE&gt; env var"] --> B["2. per-repo phase override"]
 *     B --> C["3. per-repo base tier"]
 *     C --> D["4. global config phase override"]
 *     D --> E["5. built-in phase default"]
 *     E --> F["6. PREFIX env var"]
 *     F --> G["fallback, else warn<br/>and leave the CLI default"]
 * ```
 *
 * Fail loud (Issue #3234): a non-empty phase that resolves to nothing would run
 * on whatever the CLI happens to be configured with, invisibly — so it emits
 * one warning naming the phase and the table that is missing an entry. A
 * phase-less call is deliberate and stays quiet.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";

/** Semantic model tiers shared by all providers. */
export type ModelTier = "best" | "standard" | "fast";

/** Work labels select phases; phases select a provider-independent tier. */
export const PHASE_MODEL_TIERS: Readonly<Record<string, ModelTier>> = {
  planning: "best",
  grill_me: "best",
  quorum: "best",
  quorum_judge: "best",
  refinement: "best",
  revision: "best",
  question: "best",
  clarification: "best",
  issue: "standard",
  ci_fix: "standard",
  pr_feedback: "standard",
  quality_fix: "standard",
  spelling_fix: "fast",
  summarise: "fast",
  health: "fast",
};

/** Translate the shared policy into a provider's concrete model ids. */
export function modelsForPhaseTiers(
  models: Readonly<Record<ModelTier, string>>,
  phases: Readonly<Record<string, ModelTier>> = PHASE_MODEL_TIERS,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(phases).map(([phase, tier]) => [phase, models[tier]]),
  );
}

/** Validate operator tier settings and derive the existing routing maps. */
export function modelTierOverrides(
  rawPhases: unknown,
  rawProviders: unknown,
  defaults: Readonly<Record<string, Readonly<Record<ModelTier, string>>>>,
): Record<string, Record<string, string>> {
  const record = (value: unknown, key: string): Record<string, unknown> => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${key} must be an object`);
    }
    return value as Record<string, unknown>;
  };
  const phases: Record<string, ModelTier> = { ...PHASE_MODEL_TIERS };
  for (
    const [phase, tier] of Object.entries(
      record(rawPhases, "phase_model_tiers"),
    )
  ) {
    if (
      !Object.hasOwn(PHASE_MODEL_TIERS, phase) || typeof tier !== "string" ||
      !["best", "standard", "fast"].includes(tier)
    ) {
      throw new Error(
        `phase_model_tiers.${phase} must name a known phase and best, standard or fast tier`,
      );
    }
    phases[phase] = tier as ModelTier;
  }
  const providers = record(rawProviders, "provider_model_tiers");
  for (const provider of Object.keys(providers)) {
    if (!Object.hasOwn(defaults, provider)) {
      throw new Error(
        `provider_model_tiers.${provider} is not a registered provider`,
      );
    }
  }
  const result: Record<string, Record<string, string>> = {};
  for (const [provider, models] of Object.entries(defaults)) {
    const merged = { ...models };
    for (
      const [tier, model] of Object.entries(
        record(providers[provider], `provider_model_tiers.${provider}`),
      )
    ) {
      if (
        !Object.hasOwn(models, tier) || typeof model !== "string" ||
        !model.trim()
      ) {
        throw new Error(
          `provider_model_tiers.${provider}.${tier} must name best, standard or fast and a non-empty model`,
        );
      }
      merged[tier as ModelTier] = model.trim();
    }
    // Unconfigured deployments retain their existing empty override maps.
    result[provider] =
      rawPhases !== undefined || Object.hasOwn(providers, provider)
        ? modelsForPhaseTiers(merged, phases)
        : {};
  }
  return result;
}

/** Where one provider's routing values come from, in precedence order. */
export interface PhaseRoutingSources {
  /** Log prefix for the fail-loud warning, e.g. `"codex-executor"`. */
  logPrefix: string;
  /** What is being routed, for the warning text: `"model"` or `"effort"`. */
  what: string;
  /** The CLI surface the value lands on, e.g. `"--model"`. */
  flag: string;
  /**
   * Base environment variable, e.g. `"CODEX_MODEL"` (step 6). The
   * phase-specific escape hatch of step 1 is `${envVar}_${PHASE}`.
   */
  envVar: string;
  /**
   * Where steps 1 and 6 read their variables from (Issue #957). Defaults to
   * the process environment, so a production caller supplies nothing.
   */
  env?: EnvLookup;
  /** Step 2 — the active repo's per-phase overrides. */
  repoPhaseOverrides: Readonly<Record<string, string>>;
  /** The config key naming step 2, e.g. `"codex_phase_model_overrides"`. */
  repoPhaseOverridesKey: string;
  /** Step 3 — the active repo's base tier; omitted when there is none. */
  repoBase?: string;
  /** The config key naming step 3, e.g. `"codex_model"`. */
  repoBaseKey?: string;
  /** Step 4 — global `.config.json` per-phase overrides. */
  globalPhaseOverrides: Readonly<Record<string, string>>;
  /** The config key naming step 4. */
  globalPhaseOverridesKey: string;
  /** Step 5 — the built-in per-phase defaults (the designed cost routing). */
  phaseDefaults: Readonly<Record<string, string>>;
  /** The table's name, e.g. `"CODEX_PHASE_MODEL_DEFAULTS"`. */
  phaseDefaultsName: string;
  /**
   * Terminal fallback after step 6 — Claude's effort chain always resolves to
   * something. Omitted means "leave the CLI on its own default", which is what
   * triggers the fail-loud warning for a phase.
   */
  fallback?: string;
  /**
   * Inspect a resolved value before it is returned, naming the precedence level
   * it came from — Claude uses it to warn about a model-id typo. Must return
   * the value (verbatim, unless the provider deliberately rewrites it).
   */
  check?: (level: string, value: string) => string;
}

export function resolvePhaseRoutedValue(
  sources: PhaseRoutingSources & { fallback: string },
  phase?: string,
): string;
export function resolvePhaseRoutedValue(
  sources: PhaseRoutingSources,
  phase?: string,
): string | undefined;
/**
 * Resolve the value one phase routes to, walking the six-step chain.
 *
 * Priority order (most specific wins):
 *   1. Phase-specific env var (`${envVar}_${PHASE}`) — operator escape hatch
 *   2. Per-repo per-phase override
 *   3. Per-repo base tier — applies to every phase, and to phase-less calls
 *   4. Global config per-phase override
 *   5. Built-in per-phase default — the designed cost optimisation
 *   6. Base env var (`${envVar}`) — global fallback, then `fallback`
 *
 * @param sources - The provider's names, tables and override state.
 * @param phase - Optional phase name (e.g. `"planning"`).
 * @returns The resolved value, or `undefined` when no step supplies one and
 *   the provider declared no terminal fallback — the CLI's own default stands.
 */
export function resolvePhaseRoutedValue(
  sources: PhaseRoutingSources,
  phase?: string,
): string | undefined {
  const accept = (level: string, value: string): string =>
    sources.check ? sources.check(level, value) : value;
  const env = sources.env ?? processEnvLookup;

  if (phase) {
    // 1. Phase-specific env var (explicit operator override for this phase)
    const phaseVar = `${sources.envVar}_${phase.toUpperCase()}`;
    const fromPhaseEnv = env(phaseVar) ?? "";
    if (fromPhaseEnv) return accept(`${phaseVar} env var`, fromPhaseEnv);

    // 2. Per-repo per-phase override
    const fromRepoPhase = sources.repoPhaseOverrides[phase];
    if (fromRepoPhase) {
      return accept(
        `per-repo ${sources.repoPhaseOverridesKey}["${phase}"]`,
        fromRepoPhase,
      );
    }
  }

  // 3. Per-repo base tier — overrides the global base for every phase in this
  //    repo, including phase-less calls.
  if (sources.repoBase) {
    return accept(
      `per-repo ${sources.repoBaseKey} base tier`,
      sources.repoBase,
    );
  }

  if (phase) {
    // 4. Global config per-phase override
    const fromGlobalPhase = sources.globalPhaseOverrides[phase];
    if (fromGlobalPhase) {
      return accept(
        `global ${sources.globalPhaseOverridesKey}["${phase}"]`,
        fromGlobalPhase,
      );
    }

    // 5. Built-in per-phase default — the designed cost routing
    const phaseDefault = sources.phaseDefaults[phase];
    if (phaseDefault) {
      return accept(`${sources.phaseDefaultsName}["${phase}"]`, phaseDefault);
    }
  }

  // 6. Base env var (global fallback)
  const fromBaseEnv = env(sources.envVar) ?? "";
  if (fromBaseEnv) return accept(`${sources.envVar} env var`, fromBaseEnv);

  if (sources.fallback) return sources.fallback;

  // A non-empty phase that reaches here has no resolvable value and will run on
  // the CLI default with no observability (Issue #2712, #3234). Warn so a
  // missing table entry — a typo, or a new phase whose author forgot to add a
  // default — is caught rather than shipping silently. Phase-less calls are
  // intentional and stay quiet.
  if (phase) {
    console.warn(
      `[${sources.logPrefix}] Phase "${phase}" resolved to no ${sources.flag} ` +
        `arg; falling back to the CLI default. Add a ` +
        `${sources.phaseDefaultsName} entry for "${phase}" or set ` +
        `${sources.envVar} to make the ${sources.what} explicit.`,
    );
  }
  return undefined;
}
