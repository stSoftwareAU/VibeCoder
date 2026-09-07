/**
 * Planning-run model-usage stats and degraded-model detection (Issue #2649).
 *
 * On every planning run the worker posts a short model-usage stats comment on
 * the parent issue and computes a degradation verdict: a run is **degraded**
 * when **no** plan-generating response was served by the configured best
 * planning model (Issue #3593), or an explicit rate-limit fallback fired
 * (Issue #2646, #1113).
 *
 * The per-response served `model` declared by the API (captured per-run in
 * {@link RunStats}, Issue #2647) is the only observable source of truth — this
 * reports what the API says served each response. Stats are per-plan-run
 * figures, not an aggregate dashboard (the daily credit summary already
 * aggregates). Works with one, two (#2648 draft+critique), or three (#1219
 * retry) planning invocations.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { activeAgentProvider } from "./agent_provider.ts";
import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import type { RunStats } from "./run_stats.ts";
import type { ExtensionTelemetry } from "./timeout_extension_telemetry.ts";
import {
  formatCostEstimateLines,
  type ModelUsageEntry,
} from "./cost_estimate.ts";
import {
  computeCacheHitRate,
  formatCacheHitRate,
  isCacheHitRateRegressed,
} from "./prompt_cache_telemetry.ts";
import { previousGenerationOf } from "./current_models.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Stats for a single Claude invocation in a planning run.
 *
 * Designed for a list: a planning run makes one call today, draft+critique
 * after #2648, plus the #1219 retry. Only `phase: "planning"` invocations are
 * judged for degradation — auxiliary calls (e.g. `summarise`/haiku helpers)
 * never trigger the flag.
 */
export interface PlanningInvocationStats {
  /** Phase name for the invocation (e.g. "planning"). */
  phase: string;
  /** Per-run generation stats from the invocation, when present (#2647). */
  runStats?: RunStats;
  /** Cheaper model the run fell back to after rate-limit exhaustion (#1113). */
  fallbackModel?: string;
  /**
   * Explicit degraded flag set by the pre-flight Fable reroute (Issue #3231,
   * #3232). When the cached probe said Fable was unavailable, the phase is
   * dispatched on Opus @ `max` and the run carries this flag. The recorder
   * treats it as a first-class degraded cause **even when the served model
   * matches the (fable) expected model** — the reroute deliberately leaves the
   * provider's routing for the phase resolving to `fable`, so the
   * served-vs-expected check alone cannot see it.
   */
  preflightDegraded?: boolean;
  /** Human-readable reason accompanying {@link preflightDegraded}. */
  preflightDegradedReason?: string;
  /**
   * What the re-armable hard deadline did to the invocation (Issue #4298):
   * extensions granted and the seconds they added. Reported in the stats
   * block so the real duration distribution of a feature with no absolute
   * ceiling is reviewable after rollout.
   */
  extensions?: ExtensionTelemetry;
}

/**
 * Failure-Detection gate + self-repair counters for one planning run
 * (Issue #63).
 *
 * The gate's hit rate was previously observable only by grepping worker logs —
 * which is how the systemic scale of the omission was found (8/8 offenders on
 * one run) and why it went unnoticed long enough for the self-repair to become
 * a routine, load-bearing part of every planning run rather than a rare
 * fallback. Recording the outcome here makes the rate measurable from the
 * run-stats comment itself.
 *
 * Every field is **required** so a run with zero offenders records explicit
 * zeros. A metric emitted only on the unhappy path cannot distinguish
 * "healthy" from "not reporting", which is the failure mode this exists to fix.
 */
export interface FailureDetectionGateStats {
  /** Sub-issues this run published and therefore gated. */
  published: number;
  /** Published sub-issues the gate flagged as missing the criterion. */
  offenders: number;
  /** Offenders the self-repair fixed so they now pass the gate (#3272). */
  repaired: number;
  /** Offenders the repair attempted but could not fix. */
  stillOffending: number;
  /**
   * Offenders **never attempted** because the handler budget could not fit
   * their repair (Issue #58). Distinct from {@link stillOffending}: no work was
   * started for them.
   */
  deferred: number;
  /** Wall-clock milliseconds spent in the self-repair (0 when it never ran). */
  repairDurationMs: number;
}

/** Verdict on whether a planning run was served by a degraded model. */
export interface DegradationVerdict {
  /** True when any planning invocation was served by a non-expected model. */
  degraded: boolean;
  /**
   * True when the run produced output but **no** served model could be observed
   * so health cannot be asserted (Issue #2745). Mutually exclusive with
   * {@link degraded}: an indeterminate verdict is neither a clean "Degraded: no"
   * nor a confirmed degradation — it reports `unknown / not observed`. The
   * `degraded-model` label is **not** applied for an indeterminate verdict
   * (degradation was not confirmed); only the rendered stats line changes.
   */
  indeterminate?: boolean;
  /**
   * Human-readable reason, present when {@link degraded} **or**
   * {@link indeterminate} is true.
   */
  reason?: string;
}

/**
 * Combined output of {@link buildDegradationReport}: the resolved expected
 * model, the degradation verdict, and the rendered stats markdown section
 * (empty when no judged invocation produced stats).
 */
export interface DegradationReport {
  /** The model the run was expected to be served by (resolved/derived). */
  expectedModel: string;
  /** Whether the run was served by a degraded (non-expected) model. */
  verdict: DegradationVerdict;
  /** The stats markdown block, or "" when there is nothing to report. */
  section: string;
}

// ---------------------------------------------------------------------------
// Model matching (prefix/alias-aware)
// ---------------------------------------------------------------------------

/** Known model-tier aliases the worker requests / the API serves. */
const MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/**
 * Extract the tier family token from a model identifier.
 *
 * Handles both bare aliases (`fable`) and full served IDs
 * (`claude-fable-5-20250101`). Returns undefined when no known tier is found.
 */
export function modelFamily(model: string): string | undefined {
  const lower = model.toLowerCase();
  for (const alias of MODEL_ALIASES) {
    if (lower === alias || lower.includes(alias)) return alias;
  }
  return undefined;
}

/**
 * Prefix/alias-aware match between a requested model and a served model.
 *
 * - Exact match → OK.
 * - Either is a prefix of the other → OK (requested `claude-fable-5` vs served
 *   `claude-fable-5-20250101`).
 * - Same tier family → OK (alias `fable` vs served `claude-fable-5-20250101`).
 * - Different tier family → no match (`claude-fable-5` vs `claude-opus-4-7`).
 *
 * @param expected - The requested / configured model
 * @param served - The model the API declared it served
 * @returns true when the served model satisfies the expected model
 */
export function modelsMatch(expected: string, served: string): boolean {
  const e = expected.trim().toLowerCase();
  const s = served.trim().toLowerCase();
  if (!e || !s) return false;
  if (e === s) return true;
  if (s.startsWith(e) || e.startsWith(s)) return true;

  const ef = modelFamily(e);
  const sf = modelFamily(s);
  if (ef && sf) return ef === sf;
  return false;
}

// ---------------------------------------------------------------------------
// Expected-model resolution (single source of truth)
// ---------------------------------------------------------------------------

/**
 * Sentinel returned by {@link resolveExpectedPlanningModel} when the provider's
 * routing chain resolves to no model (i.e. `resolveModel(phase)` returns
 * `undefined`). The CLI then falls back to its own built-in default, which the
 * worker cannot observe, so the expected model is genuinely unresolvable.
 *
 * {@link assessDegradation} recognises this sentinel and skips served-model
 * matching rather than comparing against a string that can never match any
 * served model — which previously (the unmatchable `"default"` literal) flagged
 * **every** planning invocation as degraded (Issue #2746). It is deliberately a
 * value `modelFamily()` cannot map to a tier, so an accidental comparison still
 * fails closed rather than spuriously matching a real served model.
 */
export const UNRESOLVED_EXPECTED_MODEL = "(CLI default)";

/**
 * The minimum a coding-agent provider must expose to derive an expected model.
 *
 * Structural rather than an `AgentProviderDescriptor` import, mirroring
 * `FableRoutingProvider` in `fable_routing.ts` (Issue #398): the descriptor's
 * *routing* is the whole dependency, so a caller can judge a provider it
 * constructed itself and this module never grows a `provider.id === "claude"`
 * equality check.
 */
export interface ExpectedModelProvider {
  /**
   * The model this provider routes `phase` to, if any.
   *
   * `env` is the lookup the provider's own routing chain reads its
   * `*_MODEL_<PHASE>` overrides through (Issue #962) — the same optional
   * second parameter `AgentProviderDescriptor.resolveModel` takes, so a real
   * descriptor satisfies this interface unchanged and a provider a caller
   * constructed itself may ignore it.
   */
  resolveModel(phase?: string, env?: EnvLookup): string | undefined;
}

/**
 * Resolve the configured best planning model (Issue #2654).
 *
 * When an explicit `bestPlanningModel` is configured (globally via the
 * `best_planning_model` config key or per-repo via `repo_config`), that pinned
 * value is the expected model — the run is judged against the exact model the
 * operator declared as best, regardless of which tier the worker routes the
 * request to.
 *
 * When no value is pinned (the empty default — {@link DEFAULT_BEST_PLANNING_MODEL}),
 * the expected model is derived from **the invocation's own provider**
 * (`provider.resolveModel(phase)`, Issue #441) — the six-step chain that
 * provider owns (phase env var > per-repo phase overrides > per-repo base tier
 * > global overrides > that provider's phase defaults > base env var). This
 * keeps the per-repo-override-for-free behaviour (#2625) and never flags a repo
 * that deliberately routes planning to a different tier.
 *
 * Reading **Claude's** chain unconditionally is what this replaces: a
 * `planning` run under `agent_provider: deepseek` is carried on the Anthropic
 * CLI, so its served model *is* observable, and comparing `deepseek-reasoner`
 * against Claude's `fable` flagged every such run degraded for a tier the
 * operator never requested (Issue #441 — the same defect class as #398/#417,
 * one layer up).
 *
 * The `phase` parameter (default `"planning"`) selects the routing chain used
 * to derive the expected model when nothing is pinned — Issue #2717 passes
 * `"grill_me"` so the grill-me phase is judged against its own Fable-tier
 * routing (`DEFAULT_CLAUDE_MODEL_GRILL_ME`).
 *
 * @param configuredBest - The configured best planning model, or empty/undefined
 *   to derive it from the routing chain for {@link phase}
 * @param phase - The phase whose routing chain derives the expected model
 *   (default `"planning"`)
 * @param provider - The provider the invocation ran on; omit for the active
 *   provider, which is the one the run was dispatched to
 * @param env - Environment lookup for the provider selection and the routing
 *   chain's own overrides (Issue #962). Defaults to the process environment,
 *   so every existing caller resolves exactly as before.
 * @returns The model identifier the run is expected to be served by
 */
export function resolveExpectedPlanningModel(
  configuredBest?: string,
  phase: string = "planning",
  provider?: ExpectedModelProvider,
  env: EnvLookup = processEnvLookup,
): string {
  const pinned = configuredBest?.trim();
  if (pinned) return pinned;
  const routed = (provider ?? activeAgentProvider({ env }))
    .resolveModel(phase, env);
  return routed?.trim() ? routed : UNRESOLVED_EXPECTED_MODEL;
}

// ---------------------------------------------------------------------------
// Degradation assessment
// ---------------------------------------------------------------------------

/**
 * Verdict for a run whose served models matched the expected *tier* but are all
 * a previous generation of it (Issue #1362).
 *
 * @param matching - The served models that satisfied the expected model
 * @param expectedModel - The expected (configured/derived) model
 * @returns A degraded verdict naming the served and current models, or
 *   undefined when nothing is stale (or the expectation itself pins an older
 *   generation, which is the operator's own choice)
 */
function assessPreviousGeneration(
  matching: string[],
  expectedModel: string,
): DegradationVerdict | undefined {
  // The expectation itself pins an older generation — the operator asked for
  // that model, so serving it is right.
  if (previousGenerationOf(expectedModel)) return undefined;

  const unique = [...new Set(matching)];
  const stale = unique.map(previousGenerationOf);
  // Lenient, as the tier rule above: one current model keeps the run healthy.
  const reference = stale[0];
  if (!reference || stale.some((s) => s === undefined)) return undefined;

  const { tier, current } = reference;
  return {
    degraded: true,
    reason: unique.length === 1
      ? `served model \`${unique[0]}\` is a previous-generation \`${tier}\` ` +
        `(current: \`${current}\`)`
      : `every served model is a previous-generation \`${tier}\` (served: ${
        unique.map((m) => `\`${m}\``).join(", ")
      }; current: \`${current}\`)`,
  };
}

/**
 * Assess whether a planning run was degraded.
 *
 * Degraded when **no** served model observed across the judged invocations
 * matches the expected model (prefix/alias-aware), when every model that *did*
 * match it is a previous generation of that tier ({@link assessPreviousGeneration},
 * Issue #1362), **or** when an invocation records an explicit `fallbackModel`
 * (rate-limit downgrade) or `preflightDegraded` flag. Only invocations tagged
 * with {@link phase} are judged — auxiliary calls never trigger the flag.
 *
 * The served-model rule is **lenient at run level** (Issue #3593): a mixed run
 * where the expected model served part of the work and another tier served the
 * rest is *not* degraded — the plan was still generated with the expected tier
 * in play. The generation rule is lenient the same way. On the tier question
 * this matches `isMismatch()` in `planning_run_aggregation.ts`, so the per-run
 * verdict and the fleet aggregate cannot disagree about tier substitution; the
 * aggregate deliberately does not judge *generation* — it answers "was the
 * Fable tier substituted across runs" (Issue #2698), which is a different
 * question. Every served model still appears in the stats comment, so partial
 * service stays visible.
 *
 * **Indeterminate** (Issue #2745): when no degradation is detected but a judged
 * invocation ran and produced output (its `runStats` is present) while **no**
 * served model could be observed across the judged invocations, the verdict is
 * `{ degraded: false, indeterminate: true }` rather than a clean
 * `{ degraded: false }`. The verdict cannot legitimately assert health when it
 * observed no served model (older CLI versions, or parse-failure cases, omit
 * `message.model`), so it reports `unknown / not observed` instead. This is only
 * evaluated when the expected model is resolved — when the routing chain
 * resolved to the CLI default, served-model matching is skipped entirely and the
 * indeterminate check does not apply (Issue #2746).
 *
 * @param invocations - All Claude invocations recorded during the run
 * @param expectedModel - The expected (configured/derived) model
 * @param phase - The phase to judge (default `"planning"`; Issue #2717 passes
 *   `"grill_me"`)
 * @returns The degradation verdict
 */
export function assessDegradation(
  invocations: PlanningInvocationStats[],
  expectedModel: string,
  phase: string = "planning",
): DegradationVerdict {
  const judged = invocations.filter((inv) => inv.phase === phase);

  // When the routing chain resolved to no explicit model the expected model is
  // unresolvable (the CLI used its own unobservable default). Served-model
  // matching cannot determine degradation, so skip it rather than compare
  // against a sentinel that can never match — which would flag every invocation
  // (Issue #2746). An explicit rate-limit fallback is still observable
  // degradation, so that signal is honoured regardless.
  const expectedResolved = expectedModel !== UNRESOLVED_EXPECTED_MODEL;

  for (const inv of judged) {
    // Explicit pre-flight reroute signal (Issue #3232). Honoured first and
    // unconditionally: the reroute serves Opus deliberately while leaving the
    // expected model resolving to `fable`, so served-vs-expected cannot detect
    // it. A resolved expected model is not required here.
    if (inv.preflightDegraded) {
      return {
        degraded: true,
        reason: inv.preflightDegradedReason ??
          "pre-flight Fable reroute (served by fallback model)",
      };
    }
    if (inv.fallbackModel) {
      return {
        degraded: true,
        reason:
          `explicit rate-limit fallback to \`${inv.fallbackModel}\` (expected \`${expectedModel}\`)`,
      };
    }
  }

  // Lenient run-level served-model check (Issue #3593): degraded only when the
  // run observed served models and **none** of them match the expected model. A
  // mixed run (e.g. Fable served most of the work, Opus served the rest) is not
  // degraded — the same rule `isMismatch()` applies to the fleet aggregate.
  if (expectedResolved) {
    const served = judged.flatMap((inv) => inv.runStats?.servedModels ?? []);
    const matching = served.filter((s) => modelsMatch(expectedModel, s));
    if (served.length > 0 && matching.length === 0) {
      const unique = [...new Set(served)];
      return {
        degraded: true,
        reason: unique.length === 1
          ? `served model \`${
            unique[0]
          }\` does not match expected \`${expectedModel}\``
          : `no served model matches expected \`${expectedModel}\` (served: ${
            unique.map((m) => `\`${m}\``).join(", ")
          })`,
      };
    }

    // The tier matched, but on a previous generation of it (Issue #1362) —
    // rules in `assessPreviousGeneration` above.
    const staleVerdict = assessPreviousGeneration(matching, expectedModel);
    if (staleVerdict) return staleVerdict;
  }

  // No degradation detected. If a judged invocation ran and produced output but
  // yielded no served model, the verdict is indeterminate, not healthy — an
  // empty served-model set must not be read as a clean run (Issue #2745). Only
  // applies when the expected model is resolved (otherwise served-model matching
  // was skipped entirely — Issue #2746).
  if (expectedResolved) {
    const ranWithOutput = judged.some((inv) => inv.runStats);
    const observedServed = judged.some(
      (inv) => (inv.runStats?.servedModels.length ?? 0) > 0,
    );
    if (ranWithOutput && !observedServed) {
      return {
        degraded: false,
        indeterminate: true,
        reason:
          `no served model observed (expected \`${expectedModel}\`); cannot confirm the run was served by the expected model`,
      };
    }
  }

  return { degraded: false };
}

// ---------------------------------------------------------------------------
// Stats markdown
// ---------------------------------------------------------------------------

/**
 * Human-readable phase name for the stats heading / invocation-count label.
 *
 * `"planning"` maps to `"Planning"` so the default heading stays exactly
 * `## Planning run model stats` (the string `planning_run_aggregation.ts`
 * parses). `"grill_me"` maps to `"Grill-me"` (Issue #2717). Any other phase
 * is title-cased with underscores replaced by hyphens as a sensible fallback.
 */
export function phaseDisplayName(phase: string): string {
  if (phase === "planning") return "Planning";
  if (phase === "grill_me") return "Grill-me";
  const spaced = phase.replace(/_/g, "-");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Format an integer with thousands separators (locale-independent). */
function formatCount(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format a millisecond duration as a short human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds - mins * 60);
  return `${mins}m ${rem}s`;
}

/**
 * Render the Failure-Detection gate + self-repair counters (Issue #63).
 *
 * Always emits both lines when gate stats are supplied — including all-zero
 * counts — so a clean run positively reports "gate ran, nothing offended"
 * rather than being indistinguishable from a run that never reported.
 */
function formatGateLines(gate: FailureDetectionGateStats): string[] {
  return [
    `- **Failure-Detection gate:** published ${
      formatCount(gate.published)
    } · offenders ${formatCount(gate.offenders)} · repaired ${
      formatCount(gate.repaired)
    } · still offending ${formatCount(gate.stillOffending)} · deferred ${
      formatCount(gate.deferred)
    }`,
    `- **Failure-Detection repair:** ${formatDuration(gate.repairDurationMs)}`,
  ];
}

/**
 * Build the planning-run stats markdown block.
 *
 * Aggregates across every planning-phase invocation with stats: requested
 * model, served model(s), effort, input/output/cache tokens, turn count and
 * duration (when available), the number of planning invocations, and the
 * degradation verdict. Returns an empty string when there is nothing to report
 * (no planning invocation produced stats **and** no Failure-Detection gate
 * stats were supplied — e.g. a recovery path that skipped Claude and published
 * nothing), so callers can omit the section.
 *
 * When `gate` is supplied (Issue #63) the block additionally carries the
 * Failure-Detection gate/repair counters, and the block is emitted even if no
 * planning invocation produced stats — a recovery close that skipped Claude
 * still gated its published sub-issues, and those counts must not vanish with
 * the model stats.
 *
 * The optional `phase` (default `"planning"`) selects which invocations are
 * aggregated and drives the heading / "N invocations" label — Issue #2717
 * passes `"grill_me"` to emit a "Grill-me run model stats" block. The default
 * keeps the exact "Planning run model stats" wording the planning aggregation
 * (`planning_run_aggregation.ts`) parses.
 *
 * @param args.invocations - All Claude invocations recorded during the run
 * @param args.expectedModel - The expected (configured/derived) model
 * @param args.verdict - The degradation verdict (computed by the caller)
 * @param args.phase - The phase to aggregate (default `"planning"`)
 * @param args.gate - Failure-Detection gate/repair counters for the run (#63)
 * @returns The markdown block, or "" when no stats are available
 */
export function buildPlanningStatsSection(args: {
  invocations: PlanningInvocationStats[];
  expectedModel: string;
  verdict: DegradationVerdict;
  phase?: string;
  gate?: FailureDetectionGateStats;
}): string {
  const { invocations, expectedModel, verdict, gate } = args;
  const phase = args.phase ?? "planning";
  const displayPhase = phaseDisplayName(phase);
  const planning = invocations.filter(
    (inv) => inv.phase === phase && inv.runStats,
  );
  if (planning.length === 0 && !gate) return "";

  // Union of served models, preserving first-seen order.
  const served: string[] = [];
  const seen = new Set<string>();
  // Per-invocation usage attributed to its primary served model, so a mixed
  // run (e.g. Fable→Opus fallback across invocations) is costed per model
  // (Issue #3557). Falls back to the expected model when the API reported no
  // served model for the invocation.
  const costEntries: ModelUsageEntry[] = [];
  let effort: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let haveTokens = false;
  let numTurns = 0;
  let haveTurns = false;
  let durationMs = 0;
  let haveDuration = false;
  // Re-armable deadline counters (Issue #4298), summed across invocations.
  let extensionsGranted = 0;
  let extendedSeconds = 0;
  let baseTimeoutSeconds = 0;

  for (const inv of planning) {
    if (inv.extensions) {
      extensionsGranted += inv.extensions.granted;
      extendedSeconds += inv.extensions.extendedSeconds;
      baseTimeoutSeconds = inv.extensions.baseTimeoutSeconds;
    }
    const stats = inv.runStats!;
    for (const m of stats.servedModels) {
      if (!seen.has(m)) {
        seen.add(m);
        served.push(m);
      }
    }
    if (!effort && stats.effort) effort = stats.effort;
    if (stats.tokenUsage) {
      haveTokens = true;
      inputTokens += stats.tokenUsage.inputTokens;
      outputTokens += stats.tokenUsage.outputTokens;
      cacheCreationTokens += stats.tokenUsage.cacheCreationTokens;
      cacheReadTokens += stats.tokenUsage.cacheReadTokens;
      costEntries.push({
        model: stats.servedModels[0] ?? expectedModel,
        usage: stats.tokenUsage,
      });
    }
    if (typeof stats.numTurns === "number") {
      haveTurns = true;
      numTurns += stats.numTurns;
    }
    if (typeof stats.durationMs === "number") {
      haveDuration = true;
      durationMs += stats.durationMs;
    }
  }

  const servedDisplay = served.length > 0
    ? served.map((m) => `\`${m}\``).join(", ")
    : "_none reported_";

  const lines = [
    `## ${displayPhase} run model stats`,
    "",
    `- **Requested model:** \`${expectedModel}\``,
    `- **Served model(s):** ${servedDisplay}`,
  ];
  if (effort) lines.push(`- **Effort:** \`${effort}\``);
  lines.push(`- **${displayPhase} invocations:** ${planning.length}`);
  if (haveTokens) {
    lines.push(
      `- **Tokens:** input ${formatCount(inputTokens)} · output ${
        formatCount(outputTokens)
      } · cache write ${formatCount(cacheCreationTokens)} · cache read ${
        formatCount(cacheReadTokens)
      }`,
    );
    // Anthropic prompt-cache effectiveness for the run (Issue #4282). A rate
    // that falls is the visible symptom of a volatile token entering the
    // stable prompt prefix, so it is reported beside the tokens it explains.
    const cacheRate = computeCacheHitRate({
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    });
    if (cacheRate.measured) {
      const flag = isCacheHitRateRegressed(cacheRate) ? " ⚠️" : "";
      lines.push(`- **Prompt cache:** ${formatCacheHitRate(cacheRate)}${flag}`);
    }
  }
  if (haveTurns) lines.push(`- **Turns:** ${formatCount(numTurns)}`);
  if (haveDuration) lines.push(`- **Duration:** ${formatDuration(durationMs)}`);
  // Re-armable deadline counters (Issue #4298). Omitted entirely when no
  // invocation was extended, so a run without the feature reports exactly
  // what it always did.
  if (extensionsGranted > 0) {
    lines.push(
      `- **Deadline extensions:** ${extensionsGranted} ` +
        `(+${extendedSeconds}s beyond the ${baseTimeoutSeconds}s budget)`,
    );
  }
  // Estimate-only API cost, priced from the shared MODEL_PRICING table
  // (Issue #3557). Omitted entirely when no priced tokens were recorded.
  lines.push(...formatCostEstimateLines(costEntries));
  lines.push(
    verdict.degraded
      ? `- **Degraded:** ⚠️ yes — ${verdict.reason}`
      : verdict.indeterminate
      ? `- **Degraded:** ❓ unknown — ${verdict.reason}`
      : `- **Degraded:** no`,
  );
  // Failure-Detection gate + self-repair counters (Issue #63), appended after
  // the pre-existing block so the established lines keep their exact shape and
  // order. Always rendered when supplied, zeros included — the whole point is
  // that a healthy run is distinguishable from a run that never reported.
  if (gate) lines.push(...formatGateLines(gate));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared assess-and-render orchestration (Issue #2734)
// ---------------------------------------------------------------------------

/**
 * Resolve the expected model, assess degradation, and render the stats block
 * for a single top-tier phase — the resolve → assess → build triple every
 * caller must run together (Issue #2734).
 *
 * Both top-tier phases — `planning` (every run, judged against a possibly
 * pinned `best_planning_model`) and `grill_me` (only-on-degraded, derived
 * routing) — share this exact triple. Factoring it into one helper invoked by
 * both `planning_processor.ts` and `grill_me_run_stats.ts` means the two paths
 * cannot drift: a change to how the expected model is resolved, how a served
 * model is matched, or how the stats heading is rendered applies to both phases
 * at once.
 *
 * This is a pure computation — it performs no GitHub I/O. Callers decide
 * whether and how to post the {@link DegradationReport.section} comment and
 * apply the `degraded-model` label, because those side-effects differ by phase
 * (planning posts every run and labels sub-issues; grill-me posts and labels
 * only when degraded, and has no sub-issues).
 *
 * @param args.invocations - All Claude invocations recorded during the run
 * @param args.configuredBestModel - The pinned best model, or empty/undefined
 *   to derive the expected model from {@link phase}'s routing chain
 * @param args.phase - The top-tier phase to judge (default `"planning"`;
 *   grill-me passes `"grill_me"`)
 * @param args.gate - Failure-Detection gate/repair counters for the run (#63);
 *   supplied only by the planning closure, which is the sole path that gates
 *   published sub-issues
 * @param args.provider - The provider the invocations ran on (Issue #441); omit
 *   for the active provider, which is the one the run was dispatched to
 * @param args.env - Environment lookup the expected model is derived through
 *   (Issue #962); defaults to the process environment
 * @returns The resolved expected model, the verdict, and the stats section
 */
export function buildDegradationReport(args: {
  invocations: PlanningInvocationStats[];
  configuredBestModel?: string;
  phase?: string;
  gate?: FailureDetectionGateStats;
  provider?: ExpectedModelProvider;
  env?: EnvLookup;
}): DegradationReport {
  const phase = args.phase ?? "planning";
  const expectedModel = resolveExpectedPlanningModel(
    args.configuredBestModel,
    phase,
    args.provider,
    args.env ?? processEnvLookup,
  );
  const verdict = assessDegradation(args.invocations, expectedModel, phase);
  const section = buildPlanningStatsSection({
    invocations: args.invocations,
    expectedModel,
    verdict,
    phase,
    ...(args.gate ? { gate: args.gate } : {}),
  });
  return { expectedModel, verdict, section };
}
