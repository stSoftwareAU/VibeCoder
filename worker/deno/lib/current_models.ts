/**
 * Current-generation model reference for the tiers the worker judges runs
 * against (Issue #1362).
 *
 * The worker requests tier *aliases* (`fable`, `opus`, …) and the Claude CLI
 * resolves each alias locally, so a container whose CLI predates a new minor
 * release keeps being served the **previous** generation of the tier it asked
 * for. That downgrade matched at tier-family level (`modelFamily()` in
 * `planning_run_stats.ts`) and was therefore reported as healthy — silent, and
 * measurable only in the bill (Fable 5 reads cache at 4× the Fable 5.1 rate).
 *
 * {@link CURRENT_TIER_MODELS} is the worker-maintained answer to "what is the
 * latest model of this tier", updated alongside the pricing rows in
 * `token_usage.ts` exactly as Issue #747 updated them. {@link previousGenerationOf}
 * compares a served id against it so the degraded detector can name both the
 * served and the current model.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { type ModelTier, parseClaudeModernVersion } from "./token_usage.ts";

/**
 * The current (latest) model id per tier, for the tiers whose previous
 * generations the worker flags as degraded.
 *
 * **Fable only, deliberately.** Fable is the tier the eight planning-shaped
 * phases request by alias and the one whose generations differ in what the run
 * costs, so a stale Fable is worth a `degraded-model` label. Adding a row for
 * another tier extends the check to it — with the same consequence, so add one
 * only when a stale generation of that tier is genuinely worth flagging.
 *
 * A row must name a real id of its own tier that is current: the invariant is
 * pinned by `worker/deno/tests/current_models_test.ts`.
 */
export const CURRENT_TIER_MODELS: ReadonlyMap<ModelTier, string> = new Map<
  ModelTier,
  string
>([
  // Fable 5.1 — the latest Fable since 2026-09-01 (Issue #747).
  ["fable", "claude-fable-5-1"],
]);

/** A model identified as an earlier generation of a tracked tier. */
export interface PreviousGeneration {
  /** The tier the stale model belongs to. */
  tier: ModelTier;
  /** The current model id of that tier. */
  current: string;
}

/**
 * The tier and current model of `model`, when `model` is an earlier generation.
 *
 * Both fields come from the same parse, so a caller rendering "served X is a
 * previous-generation <tier> (current: Y)" never has to re-derive the tier and
 * cannot end up naming one the comparison did not use.
 *
 * Returns `undefined` — meaning "nothing to report" — when the id is the
 * current generation, a *newer* generation than the reference (the reference
 * lags a release, it must never flag one it has not heard of), a tier with no
 * row in {@link CURRENT_TIER_MODELS}, a bare tier alias (which always means the
 * latest of its tier), or an id the version parser does not recognise.
 *
 * @param model - A served or configured model identifier
 * @returns The tier and its current model, or undefined when not stale
 */
export function previousGenerationOf(
  model: string,
): PreviousGeneration | undefined {
  const parsed = parseClaudeModernVersion(model.trim().toLowerCase());
  if (!parsed) return undefined;
  const current = CURRENT_TIER_MODELS.get(parsed.tier);
  if (!current) return undefined;
  const reference = parseClaudeModernVersion(current);
  if (!reference || reference.tier !== parsed.tier) return undefined;
  const older = parsed.major < reference.major ||
    (parsed.major === reference.major && parsed.minor < reference.minor);
  return older ? { tier: parsed.tier, current } : undefined;
}
