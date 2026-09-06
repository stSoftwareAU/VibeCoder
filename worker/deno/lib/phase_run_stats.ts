/**
 * Phase-parametric degraded-model recording for the reactive planning-shaped
 * phases (Issue #3232, parent #3217).
 *
 * This generalises the grill-me recorder (#2717) so **all six** Fable-preferring
 * planning-shaped phases can surface a silent Fable→Opus substitution the same
 * way planning does (#2646): `planning`, `grill_me`, `refinement`, `revision`,
 * `question`, and `clarification`. The four newly-promoted reactive phases
 * (refinement/revision/question/clarification) each make a single planning-shaped
 * Claude call, so — like grill-me — they apply the non-reserved
 * `degraded-model` label **only when the round was degraded**.
 *
 * Since Issue #3756 the `## <Phase> run model stats` comment is no longer
 * degraded-only: a healthy round posts it too, at most once **per run** since
 * Issue #797 (see {@link ./issue_run_stats_comment.ts}). Every run the Vibe
 * Coder completes therefore reports what it cost — an earlier, cheaper round no
 * longer swallows the wrap-up run's figures — and each comment carries the
 * cumulative issue total. A degraded round still posts unconditionally: the
 * label must never appear without the figures that justify it.
 *
 * A run is degraded when any of the following holds for the phase's invocation
 * (all judged by the shared {@link ./planning_run_stats.ts} helpers — no forked
 * logic):
 *   - the explicit pre-flight reroute flag (`preflightDegraded`) is set
 *     (Issue #3231 — Fable unavailable ⇒ Opus @ `max`), honoured even when the
 *     served model matches the (fable) expected model;
 *   - the served model does not match the expected (routing-derived) model
 *     (mid-run #2720/#2724 fallback ⇒ Opus @ high); or
 *   - an explicit rate-limit `fallbackModel` fired (#1113).
 *
 * Every GitHub operation here is **non-fatal**: a label or comment failure is
 * logged and never aborts the phase (mirroring the planning/grill-me closures).
 * For these reactive, single-issue phases the label is applied to the **issue
 * itself** (no sub-issue fan-out).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import type { EnvLookup } from "./env_lookup.ts";
import type { RunStats } from "./run_stats.ts";
import type { ExtensionTelemetry } from "./timeout_extension_telemetry.ts";
import {
  buildDegradationReport,
  type DegradationVerdict,
  phaseDisplayName,
  type PlanningInvocationStats,
} from "./planning_run_stats.ts";
import { applyDegradedModelLabel } from "./planning_degraded_label.ts";
import {
  buildIssueRunStatsComment,
  ghIssueCommentLister,
  postIssueRunStatsComment,
} from "./issue_run_stats_comment.ts";

/** The completed-Claude-invocation fields a planning-shaped round exposes. */
export interface PhaseClaudeResult {
  /** Per-run generation stats (served models, tokens, …), when present. */
  runStats?: RunStats;
  /** Cheaper model the run fell back to after rate-limit exhaustion (#1113). */
  fallbackModel?: string;
  /** Explicit pre-flight reroute degraded flag (#3231/#3232). */
  preflightDegraded?: boolean;
  /** Human-readable reason accompanying {@link preflightDegraded}. */
  preflightDegradedReason?: string;
  /**
   * What the re-armable hard deadline did to the run (Issue #4298). Carried
   * into the per-run stats comment so extension frequency — and the real
   * duration distribution of a feature with no absolute ceiling — is
   * reviewable after rollout.
   */
  extensions?: ExtensionTelemetry;
}

/** Post-a-comment callback (decoupled from any specific GitHub client). */
export type PostCommentFn = (
  repo: string,
  issueNumber: number,
  body: string,
) => Promise<void>;

/**
 * Build the single-invocation list a planning-shaped round records for
 * degradation assessment. The round makes exactly one Claude call, tagged with
 * `phase` so {@link buildDegradationReport} judges it. Absent fields are
 * omitted so an invocation with no stats never spuriously flags.
 */
export function buildPhaseInvocations(
  phase: string,
  claudeResult: PhaseClaudeResult,
): PlanningInvocationStats[] {
  return [{
    phase,
    ...(claudeResult.runStats ? { runStats: claudeResult.runStats } : {}),
    ...(claudeResult.fallbackModel
      ? { fallbackModel: claudeResult.fallbackModel }
      : {}),
    ...(claudeResult.preflightDegraded
      ? {
        preflightDegraded: true,
        ...(claudeResult.preflightDegradedReason
          ? { preflightDegradedReason: claudeResult.preflightDegradedReason }
          : {}),
      }
      : {}),
    ...(claudeResult.extensions ? { extensions: claudeResult.extensions } : {}),
  }];
}

/**
 * Assess a completed planning-shaped round, apply the `degraded-model` label
 * when it was degraded, and post the round's cost/model stats comment
 * (Issues #3232, #3756).
 *
 * The expected model is derived from the phase's routing chain
 * ({@link buildDegradationReport} with the phase), so a repo that deliberately
 * routes the phase to a different tier is never flagged (override-for-free,
 * #2625). No new config key is introduced — the derived routing model is the
 * source of truth.
 *
 * **Posting rules.**
 * - *Degraded round* — the `degraded-model` label is applied and the stats
 *   block is posted unconditionally as the label's visible explanation. A
 *   degradation must always be paired with the figures that justify it, so
 *   this post deliberately ignores the duplicate guard.
 * - *Healthy round* — the stats block is posted **at most once per run**
 *   (Issues #3756, #797). Before #3756, healthy reactive rounds reported
 *   nothing; under #3756's issue-scoped guard, only the first wrap-up on an
 *   issue did. {@link postIssueRunStatsComment} now skips only when *this* run
 *   already posted, so a repeat post inside one run is still suppressed while
 *   every completed run's cost is visible.
 *
 * Every GitHub call remains non-fatal — a label or comment failure is logged
 * and never aborts the phase.
 *
 * @returns The degradation verdict (so callers can record it on their result).
 */
export async function reportPhaseDegradation(args: {
  phase: string;
  repo: string;
  issueNumber: number;
  /**
   * The round's completed invocation(s). A planning-shaped phase makes one
   * Claude call and passes it directly; a multi-invocation round — the Quorum
   * plan-off's two drafts plus its judgement (Issue #4434) — passes the list,
   * so one verdict, one label and one aggregated stats comment cover the whole
   * round instead of one per agent.
   */
  claudeResult: PhaseClaudeResult | PhaseClaudeResult[];
  postComment: PostCommentFn;
  runGhCommand: (args: string[]) => Promise<string>;
  logger: Logger;
  /** Optional label-cache directory (injected for testability). */
  cacheDir?: string;
  /**
   * Lists the issue's existing comment bodies for the one-per-run duplicate
   * guard and the cumulative issue total. Defaults to a
   * `gh issue view --json comments` lookup built from
   * {@link args.runGhCommand} (Issues #3756, #797).
   */
  listIssueComments?: (
    repo: string,
    issueNumber: number,
  ) => Promise<readonly { body: string; author?: string | null }[]>;
  /**
   * Fleet identity inputs for the cumulative-tally author check (Issue #1249,
   * finding 12). Omitted reads the configured fleet.
   */
  authorOptions?: AlertDedupAuthorOptions;
  /**
   * Environment lookup the expected-model routing reads through
   * (Issue #961); defaults to the process environment, so a production
   * caller supplies nothing.
   */
  env?: EnvLookup;
}): Promise<DegradationVerdict> {
  const {
    phase,
    repo,
    issueNumber,
    claudeResult,
    postComment,
    runGhCommand,
    logger,
    cacheDir,
  } = args;

  const claudeResults = Array.isArray(claudeResult)
    ? claudeResult
    : [claudeResult];
  const invocations = claudeResults.flatMap((result) =>
    buildPhaseInvocations(phase, result)
  );
  const { expectedModel, verdict } = buildDegradationReport({
    invocations,
    phase,
    ...(args.env ? { env: args.env } : {}),
  });

  // Lower-cased display name so warnings read naturally per phase
  // ("grill-me", "refinement", …) and stay stable for existing assertions.
  const label = phaseDisplayName(phase).toLowerCase();

  // Healthy round — post this run's cost/model stats comment, unless this run
  // already posted one (Issues #3756, #797).
  if (!verdict.degraded) {
    await postIssueRunStatsComment({
      repo,
      issueNumber,
      phase,
      claudeResults,
      getIssueComments: args.listIssueComments ??
        ghIssueCommentLister(runGhCommand),
      postComment,
      logger,
      ...(args.authorOptions ? { authorOptions: args.authorOptions } : {}),
    });
    return verdict;
  }

  logger.warn(`${label} round served by a degraded model (Issue #3232)`, {
    repo,
    issueNumber,
    phase,
    expectedModel,
    reason: verdict.reason,
  });

  // Tag the issue itself (no sub-issues on a reactive round). Non-fatal.
  await applyDegradedModelLabel({
    repo,
    parentIssueNumber: issueNumber,
    subIssueNumbers: [],
    ghCommandFn: runGhCommand,
    logger,
    ...(cacheDir ? { cacheDir } : {}),
  });

  // Post the stats block as the visible explanation paired with the label.
  // Unconditional: the label must never appear without its justification.
  const body = buildIssueRunStatsComment({
    phase,
    claudeResults,
  });
  if (body) {
    try {
      await postComment(repo, issueNumber, body);
    } catch (err) {
      logger.warn(`Failed to post ${label} stats comment (non-fatal)`, {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return verdict;
}
