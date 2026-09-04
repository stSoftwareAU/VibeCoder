/**
 * Grill-me run model-usage stats and degraded-model detection (Issue #2717).
 *
 * The `grill_me` phase routes to the **same** Fable 5 top tier as planning
 * (`DEFAULT_CLAUDE_MODEL_GRILL_ME = DEFAULT_CLAUDE_MODEL_TOP_TIER`) with the
 * same "plan-quality compounds across every downstream sub-issue" rationale
 * (#2621). A silent Fable→Opus degradation on a requirements-interrogation
 * round is therefore exactly the failure class the #2646 family was built to
 * surface — yet planning had the only stats block and degradation verdict
 * (#2649/#2650). This module closes that observability gap by reusing the
 * phase-parametric detection helpers in {@link ./planning_run_stats.ts} for the
 * `grill_me` phase, and the shared `degraded-model` label applied by
 * {@link ./planning_degraded_label.ts}.
 *
 * **Scoping difference from planning (deliberate, Issue #2717).** Planning
 * posts a stats block on every run. Grill-me is an interactive, multi-round,
 * human-facing clarification flow, so emitting a model-stats block after every
 * healthy round would clutter the conversation the developer is reading. This
 * module therefore posts the stats block **and** applies the `degraded-model`
 * label **only when a round was served by a degraded model**. Healthy rounds
 * report nothing — the label is the visible signal, paired with the stats
 * comment as its explanation. There are no sub-issues on a grill-me round, so
 * only the grill-me issue itself is labelled.
 *
 * Every GitHub operation here is **non-fatal**: a label or comment failure is
 * logged and never aborts the grill-me round (mirroring the planning closure).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";
import type { EnvLookup } from "./env_lookup.ts";
import type { DegradationVerdict } from "./planning_run_stats.ts";
import type { PlanningInvocationStats } from "./planning_run_stats.ts";
import {
  buildPhaseInvocations,
  type PhaseClaudeResult,
  reportPhaseDegradation,
} from "./phase_run_stats.ts";

/** The phase token used for grill-me degradation detection. */
export const GRILL_ME_PHASE = "grill_me";

/**
 * The completed-Claude-invocation fields a grill-me round exposes.
 *
 * Alias of the generic {@link PhaseClaudeResult} (Issue #3232): grill-me is
 * now one of the six planning-shaped phases sharing the generic recorder, so it
 * additionally honours the explicit pre-flight reroute flag (#3231).
 */
export type GrillMeClaudeResult = PhaseClaudeResult;

/**
 * Build the single-invocation list a grill-me round records for degradation
 * assessment. A grill-me round makes exactly one Claude call, tagged with the
 * `grill_me` phase so the shared assessment judges it. Delegates to the generic
 * {@link buildPhaseInvocations} (Issue #3232).
 */
export function buildGrillMeInvocations(
  claudeResult: GrillMeClaudeResult,
): PlanningInvocationStats[] {
  return buildPhaseInvocations(GRILL_ME_PHASE, claudeResult);
}

/**
 * Assess a completed grill-me round for model degradation, and — only when
 * degraded — apply the `degraded-model` label to the issue and post the stats
 * block as its explanation (Issue #2717).
 *
 * The expected model is derived from the `grill_me` routing chain
 * ({@link resolveExpectedPlanningModel} with `phase: "grill_me"`), so a repo
 * that deliberately routes grill-me to a different tier is never flagged
 * (override-for-free, #2625). No new config key is introduced — there is no
 * `best_grill_me_model`; the derived routing model is the source of truth.
 *
 * @returns The degradation verdict (so callers can record it on their result).
 */
export async function reportGrillMeDegradation(args: {
  repo: string;
  issueNumber: number;
  claudeResult: GrillMeClaudeResult;
  ghClient: GitHubClient;
  runGhCommand: (args: string[]) => Promise<string>;
  logger: Logger;
  /** Optional label-cache directory (injected for testability). */
  cacheDir?: string;
  /**
   * Environment lookup the expected-model routing reads through
   * (Issue #961); defaults to the process environment.
   */
  env?: EnvLookup;
}): Promise<DegradationVerdict> {
  const { repo, issueNumber, claudeResult, ghClient, runGhCommand, logger } =
    args;

  // Delegate to the phase-parametric recorder (Issue #3232). Grill-me tags the
  // issue itself (no sub-issues), posts only on a degraded round, and now also
  // honours the explicit pre-flight reroute flag alongside the served-model and
  // rate-limit-fallback checks. The comment is posted through the ghClient.
  return await reportPhaseDegradation({
    phase: GRILL_ME_PHASE,
    repo,
    issueNumber,
    claudeResult,
    postComment: async (r, i, b) => {
      await ghClient.postComment(r, i, b);
    },
    // Reuse the client's comment listing for the one-stats-comment-per-issue
    // guard (Issue #3756) rather than an extra `gh issue view` round trip.
    listIssueComments: (r, i) => ghClient.getIssueComments(r, i),
    runGhCommand,
    logger,
    ...(args.cacheDir ? { cacheDir: args.cacheDir } : {}),
    ...(args.env ? { env: args.env } : {}),
  });
}
