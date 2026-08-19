/**
 * Quorum run model-usage stats and degraded-model detection (Issue #4434).
 *
 * The six single-call Fable-preferring phases each report a completed round
 * through `phase_run_stats.ts`: a degraded round applies the `degraded-model`
 * label and posts the stats block that justifies it. Quorum could not, because
 * a plan-off is **three** invocations behind an injected runner (Issue #4111)
 * and none of their served-model observations reached the processor. So after
 * Issue #4429 made both Quorum phases Fable-preferring, a plan-off served on
 * Opus @ `max` during a Fable outage ran correctly but reported nothing.
 *
 * Two decisions carry the weight:
 *
 * - **One report per plan-off, not one per agent.** The whole round — both
 *   drafts and the judgement — is assessed and costed together, so a degraded
 *   run leaves one label and one stats comment rather than three. The two
 *   Quorum phases share a single routing default (`quorum` and `quorum_judge`
 *   are both Fable @ `high` in `PHASE_MODEL_DEFAULTS`), so judging the round
 *   under the `quorum` phase is honest for every invocation in it.
 * - **A healthy plan-off stays quiet.** Quorum already posts a substantial
 *   result comment naming the winning plan; adding a cost comment beside it on
 *   every healthy run would be comment noise. The degradation is the thing
 *   that needs surfacing, and the label must never appear without the figures
 *   that justify it — so both go up together, or neither does.
 *
 * Every GitHub operation is **non-fatal**: a label or comment failure is
 * logged and never aborts the plan-off (mirroring the other closures).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger } from "../types.ts";
import {
  buildDegradationReport,
  type DegradationVerdict,
} from "./planning_run_stats.ts";
import {
  buildPhaseInvocations,
  type PhaseClaudeResult,
  reportPhaseDegradation,
} from "./phase_run_stats.ts";
import {
  QUORUM_DRAFT_PHASE,
  type QuorumModelObservation,
} from "./quorum_orchestrator.ts";

/**
 * The phase the whole plan-off is judged and costed under.
 *
 * Both Quorum phases route identically, so the drafting phase names the round
 * — `## Quorum run model stats` covers the drafts and the judgement alike.
 */
export const QUORUM_STATS_PHASE = QUORUM_DRAFT_PHASE;

/**
 * Reduce the orchestrator's observations to the invocation facts the shared
 * recorder judges (Issue #4434).
 *
 * The role/position/provider attribution is dropped deliberately: it names
 * *which agent* ran, and the degradation verdict turns only on *which model
 * served it*.
 *
 * @param observations - One entry per invocation the runner reported.
 * @returns One {@link PhaseClaudeResult} per observation, in run order.
 */
export function buildQuorumClaudeResults(
  observations: readonly QuorumModelObservation[],
): PhaseClaudeResult[] {
  return observations.map((observation) => ({
    ...(observation.runStats ? { runStats: observation.runStats } : {}),
    ...(observation.fallbackModel
      ? { fallbackModel: observation.fallbackModel }
      : {}),
    ...(observation.preflightDegraded
      ? {
        preflightDegraded: true,
        ...(observation.preflightDegradedReason
          ? { preflightDegradedReason: observation.preflightDegradedReason }
          : {}),
      }
      : {}),
  }));
}

/**
 * Assess a completed plan-off for model degradation and — only when degraded —
 * apply the `degraded-model` label to the issue and post the round's stats
 * block as its explanation (Issue #4434).
 *
 * The verdict is computed by the same shared {@link buildDegradationReport}
 * the recorder itself uses, so there is no forked degradation logic: this call
 * only decides whether the round is worth reporting at all.
 *
 * @param args.observations - The orchestrator's per-invocation observations.
 * @returns The degradation verdict, so the caller can record it.
 */
export async function reportQuorumDegradation(args: {
  repo: string;
  issueNumber: number;
  observations: readonly QuorumModelObservation[];
  ghClient: GitHubClient;
  runGhCommand: (args: string[]) => Promise<string>;
  logger: Logger;
  /** Optional label-cache directory (injected for testability). */
  cacheDir?: string;
}): Promise<DegradationVerdict> {
  const { repo, issueNumber, ghClient, runGhCommand, logger } = args;

  const claudeResults = buildQuorumClaudeResults(args.observations);
  const { verdict } = buildDegradationReport({
    invocations: claudeResults.flatMap((result) =>
      buildPhaseInvocations(QUORUM_STATS_PHASE, result)
    ),
    phase: QUORUM_STATS_PHASE,
  });
  // A healthy (or unobservable) plan-off reports nothing — the result comment
  // it already posted is the round's output.
  if (!verdict.degraded) return verdict;

  return await reportPhaseDegradation({
    phase: QUORUM_STATS_PHASE,
    repo,
    issueNumber,
    claudeResult: claudeResults,
    postComment: async (r, i, b) => {
      await ghClient.postComment(r, i, b);
    },
    // Reuse the client's comment listing rather than an extra `gh issue view`.
    listIssueComments: (r, i) => ghClient.getIssueComments(r, i),
    runGhCommand,
    logger,
    ...(args.cacheDir ? { cacheDir: args.cacheDir } : {}),
  });
}
