/**
 * Pre-flight Fable reroute (Issue #3231, parent #3217).
 *
 * When the cached Fable-availability probe (#3230) says Fable is
 * **unavailable**, the eight "Fable-preferring" planning-shaped phases must run
 * on the next-highest model (**Opus**) at the **higher effort** (`max`) for
 * that single invocation, and the run must be flagged **degraded** so the
 * recording sub-issue can label the issue / post its stats comment.
 *
 * This module is the deterministic core: a pure decision function plus a thin
 * invocation-layer helper that forwards the override onto a run-options object.
 * It performs **no** I/O — the caller reads the cached verdict (via
 * `readFableAvailability`) and reports whether an explicit operator override is
 * present, then this module decides.
 *
 * Design invariants (from the issue):
 *   - The override is applied at the **invocation layer** — an explicit
 *     `model`/`effort` on the run options — never by rewriting a phase's
 *     `PHASE_MODEL_DEFAULTS`. `buildClaudeModelArgs(phase)` must still resolve
 *     to `fable` so the existing served-vs-expected degraded detector (#2720)
 *     keeps working.
 *   - **Pre-flight reroute ⇒ effort bumped to `max`** ("request the higher
 *     effort"). The mid-run fallback (#2720/#2724) is a separate path and its
 *     effort is left unchanged — this module is not involved there.
 *   - An explicit per-repo / env model or effort override for the phase wins:
 *     an operator who pinned the phase is not second-guessed by the probe.
 *   - **Provider-gated** (Issue #398): the reroute is a move down the Anthropic
 *     tier ladder, so it fires only for an invocation whose coding-agent
 *     provider routes the phase to the Fable tier. A Codex or Gemini
 *     invocation — which cannot resolve `opus` at all — stays on its own
 *     routing and is never flagged degraded for a tier it never requested.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import type { EnvLookup } from "./env_lookup.ts";
import type { FableCacheRead } from "./health_check_cache.ts";
import { modelFamily } from "./planning_run_stats.ts";

/**
 * The eight "Fable-preferring" planning-shaped phases (Issues #3217, #4429).
 *
 * These are the phases whose default routing prefers the Fable 5 top tier, so
 * they are the only phases eligible for the Opus @ `max` pre-flight reroute.
 * The two Quorum phases joined the top tier in Issue #4112 but were left out
 * of this list, so a Fable outage sent them to `claude-fable-5` regardless
 * (Issue #4429); they are Fable-preferring like the rest.
 */
export const FABLE_PREFERRING_PHASES = [
  "planning",
  "grill_me",
  "quorum",
  "quorum_judge",
  "refinement",
  "revision",
  "question",
  "clarification",
] as const;

/** Fast membership lookup for {@link isFablePreferringPhase}. */
const FABLE_PREFERRING_SET: ReadonlySet<string> = new Set(
  FABLE_PREFERRING_PHASES,
);

/**
 * Whether `phase` is one of the eight Fable-preferring planning-shaped phases.
 *
 * @param phase - The phase name (may be undefined for phase-less calls).
 * @returns true only for a phase in {@link FABLE_PREFERRING_PHASES}.
 */
export function isFablePreferringPhase(phase: string | undefined): boolean {
  return phase !== undefined && FABLE_PREFERRING_SET.has(phase);
}

/**
 * The minimum a coding-agent provider must expose for the reroute gate.
 *
 * Structural rather than an `AgentProviderDescriptor` import, so this module
 * stays free of the provider registry (and of any import cycle through it) and
 * a caller can gate on a descriptor it constructed itself.
 */
export interface FableRoutingProvider {
  /** Provider id, named in the log line when the reroute is skipped. */
  id: string;
  /**
   * The model this provider routes `phase` to, if any.
   *
   * `env` is the lookup the provider's routing chain reads its variables
   * through (Issue #957); omitted means the process environment.
   */
  resolveModel(phase?: string, env?: EnvLookup): string | undefined;
}

/**
 * Whether `provider` routes `phase` to the Fable tier (Issue #398).
 *
 * The tier — not the provider id — is the gate, so registering a fourth
 * provider that carries a Fable tier needs no edit here, and a provider whose
 * routing is moved off the tier stops being rerouted for free.
 *
 * @param provider - The provider this invocation will run on.
 * @param phase - The phase name.
 * @param env - Environment lookup the provider's routing reads through
 *   (Issue #961); omitted means the process environment.
 * @returns true when the provider's routing for `phase` is a Fable-tier model.
 */
export function providerRoutesToFableTier(
  provider: FableRoutingProvider,
  phase: string | undefined,
  env?: EnvLookup,
): boolean {
  return modelFamily(provider.resolveModel(phase, env) ?? "") === "fable";
}

/** Model the pre-flight reroute selects when Fable is unavailable. */
export const FABLE_PREFLIGHT_MODEL = "opus" as const;

/** Effort the pre-flight reroute requests ("the higher effort"). */
export const FABLE_PREFLIGHT_EFFORT = "max" as const;

/** Degraded reason attached to a pre-flight-rerouted run. */
export const FABLE_PREFLIGHT_DEGRADED_REASON =
  "fable-unavailable (pre-flight health probe)" as const;

/**
 * The outcome of the pre-flight routing decision.
 *
 * A no-op result (`{ degraded: false }`, no `model`/`effort`) means the caller
 * should dispatch the phase unchanged at its normal Fable / `high` routing.
 */
export interface FablePreflightRouting {
  /** Model override to force for this single invocation, when rerouted. */
  model?: typeof FABLE_PREFLIGHT_MODEL;
  /** Effort override to force for this single invocation, when rerouted. */
  effort?: typeof FABLE_PREFLIGHT_EFFORT;
  /** Whether this run must be flagged degraded. */
  degraded: boolean;
  /** Human-readable degraded reason, present only when {@link degraded}. */
  reason?: string;
}

/**
 * Decide the pre-flight reroute for a phase given the cached Fable verdict.
 *
 * Reroutes (Opus @ `max`, degraded) **only** when all of:
 *   - `phase` is Fable-preferring;
 *   - `provider` routes that phase to the Fable tier (Issue #398);
 *   - no explicit operator override is present; and
 *   - the cached verdict is a fresh `"unavailable"`.
 *
 * Every other combination — a non-Fable-preferring phase, a provider with no
 * Fable tier, an `available` / `unknown` (missing/expired) verdict, or an
 * explicit override — returns the no-op `{ degraded: false }`.
 *
 * @param phase - The phase name.
 * @param fableVerdict - Cached verdict: `available` / `unavailable` / `unknown`.
 * @param hasExplicitOverride - Whether the phase has an explicit per-repo / env
 *   / call-site model or effort override that should suppress the reroute.
 * @param provider - The provider this invocation will run on. Required: the
 *   reroute names an Anthropic tier alias, so it cannot be decided without
 *   knowing which agent would receive it.
 * @param env - Environment lookup the provider's routing reads through
 *   (Issue #961); omitted means the process environment.
 * @returns The routing decision.
 */
export function resolveFablePreflightRouting(
  phase: string | undefined,
  fableVerdict: FableCacheRead,
  hasExplicitOverride: boolean,
  provider: FableRoutingProvider,
  env?: EnvLookup,
): FablePreflightRouting {
  if (!isFablePreferringPhase(phase)) {
    return { degraded: false };
  }
  if (!providerRoutesToFableTier(provider, phase, env)) {
    return { degraded: false };
  }
  if (hasExplicitOverride) {
    return { degraded: false };
  }
  if (fableVerdict !== "unavailable") {
    return { degraded: false };
  }
  return {
    model: FABLE_PREFLIGHT_MODEL,
    effort: FABLE_PREFLIGHT_EFFORT,
    degraded: true,
    reason: FABLE_PREFLIGHT_DEGRADED_REASON,
  };
}

/**
 * Apply the pre-flight reroute to a run-options object at the invocation layer.
 *
 * When {@link resolveFablePreflightRouting} decides to reroute, returns a
 * **copy** of `options` with `model` / `effort` forced to Opus @ `max`;
 * otherwise returns the original object unchanged. The `routing` verdict is
 * returned alongside so the caller can thread `degraded`/`reason` onto the run
 * record the recorder reads.
 *
 * Generic over the minimal option shape so it does not depend on (and cannot
 * import-cycle with) `claude_runner.ts`'s `RunClaudeOptions`.
 *
 * @param options - The run options (must carry `phase`; may carry `model`/`effort`).
 * @param fableVerdict - Cached Fable-availability verdict.
 * @param hasExplicitOverride - Whether an explicit operator override is present.
 * @param provider - The provider this invocation will run on (Issue #398).
 * @param env - Environment lookup the provider's routing reads through
 *   (Issue #961); omitted means the process environment.
 * @returns The (possibly rerouted) options and the routing verdict.
 */
export function applyFablePreflightRouting<
  T extends { phase?: string; model?: string; effort?: string },
>(
  options: T,
  fableVerdict: FableCacheRead,
  hasExplicitOverride: boolean,
  provider: FableRoutingProvider,
  env?: EnvLookup,
): { options: T; routing: FablePreflightRouting } {
  const routing = resolveFablePreflightRouting(
    options.phase,
    fableVerdict,
    hasExplicitOverride,
    provider,
    env,
  );
  if (routing.model) {
    return {
      options: { ...options, model: routing.model, effort: routing.effort },
      routing,
    };
  }
  return { options, routing };
}

/** The minimum a caller must supply to receive the warning. */
interface FableRoutingWarnLogger {
  warn(message: string): void;
}

/**
 * Providers already warned about a missing Fable tier, once per worker process.
 *
 * One warning per provider: a Quorum round dispatching three invocations under
 * a Fable outage states the gap once for each agent rather than on every call.
 */
const _noFableTierWarnedProviders = new Set<string>();

/**
 * Clear the per-process no-Fable-tier warning state (Issue #398).
 *
 * Exposed so a test — or any caller deliberately re-running a scenario from
 * scratch — can observe the first warning again.
 */
export function clearFableTierWarnings(): void {
  _noFableTierWarnedProviders.clear();
}

/**
 * Report, once per provider, that a Fable outage rerouted nothing (Issue #398).
 *
 * Fail loud, do not fail the run (Issue #3234): the outage is real and the
 * invocation still proceeds on its own routing, but an operator must be able to
 * *see* that the documented Opus @ `max` reroute did not apply — and therefore
 * that this run is not flagged degraded — rather than infer it from silence.
 * Both ways a phase can end up off the tier are reported: a provider with no
 * Fable tier (Codex, Gemini) and an operator pin that moved the phase off it.
 * A no-op for every other combination, so callers can hand it any invocation.
 *
 * @param provider - The provider this invocation runs on.
 * @param phase - The phase name.
 * @param fableVerdict - Cached Fable-availability verdict.
 * @param logger - Run logger; defaults to `console.warn`.
 * @param env - Environment lookup the provider's routing reads through
 *   (Issue #961); omitted means the process environment.
 */
export function warnProviderHasNoFableTier(
  provider: FableRoutingProvider,
  phase: string | undefined,
  fableVerdict: FableCacheRead,
  logger?: FableRoutingWarnLogger,
  env?: EnvLookup,
): void {
  if (!isFablePreferringPhase(phase)) return;
  if (fableVerdict !== "unavailable") return;
  if (providerRoutesToFableTier(provider, phase, env)) return;
  if (_noFableTierWarnedProviders.has(provider.id)) return;
  _noFableTierWarnedProviders.add(provider.id);

  const routed = provider.resolveModel(phase, env);
  const on = routed
    ? `model ${JSON.stringify(routed)}`
    : "its configured default model";
  const message =
    `[fable-routing] The cached probe reports Fable unavailable, but phase ` +
    `${JSON.stringify(phase)} resolves to ${on} under the ${provider.id} ` +
    `coding-agent provider — not the Fable tier — so NO pre-flight reroute ` +
    `to ${FABLE_PREFLIGHT_MODEL} @ ${FABLE_PREFLIGHT_EFFORT} was applied and ` +
    `the run is NOT flagged degraded. The reroute documented in ` +
    `docs/MODEL-AND-CACHING.md fires only where the phase's resolved routing ` +
    `is a Fable-tier model.`;

  if (logger) logger.warn(message);
  else console.warn(message);
}
