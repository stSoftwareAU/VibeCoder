/**
 * Analysis-only / no-PR hand-off for `work-on` issues (Issue #2849).
 *
 * Some issues carrying `work-on` have no PR deliverable — gap analyses,
 * coverage matrices, "populate the issue" recommendation tasks whose
 * output is a comment, not a code change. `work-on` treats a raised PR
 * as its completion signal, so a no-PR outcome reads as "not done": the
 * issue is re-picked-up and re-run indefinitely (the #2834 loop, which
 * re-posted the same matrix plus an "unable to make code changes" note
 * about five times).
 *
 * This module detects an analysis-only / no-PR issue from two signals
 * and hands it off cleanly to a human:
 *
 *   (a) an up-front body marker the author / grill-me / planning can add
 *       to declare the issue analysis-only — {@link hasAnalysisOnlyMarker};
 *       and
 *   (b) the post-run signal — Claude made no code changes (the existing
 *       "unable to make code changes" partial-answer path).
 *
 * Both route through {@link escalateToHuman}, which applies `needs-human`
 * plus a paired explanation comment (Issue #1471). The label drops the
 * issue from the new-work scan (`filterAndSort` / `find_issues_by_label`)
 * and triggers `stripDiscoveryLabelsOnEscalation` to remove `work-on`
 * server-side, so the issue never loops.
 *
 * A cleanly-detected hand-off is **not** a failure — the task did its job
 * — so the issue is never marked `failed`. The existing
 * `failed-once` → `failed` / `needs-human` ladder stays the fallback loop
 * guard for the case where clean detection does not fire (no changes AND
 * no useful output).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { expectedNoPrOutcome } from "./run_outcome.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";
import {
  escalateToHuman as defaultEscalateToHuman,
  type EscalateToHumanOptions,
  type EscalateToHumanOutcome,
} from "./needs_human_escalation.ts";
import { releaseClaim as defaultReleaseClaim } from "./claim_release.ts";

/**
 * The up-front body marker an author / grill-me / planning can add to
 * declare an issue analysis-only / no-PR. An HTML comment so it stays
 * invisible in the rendered issue body, matching the existing marker
 * conventions (`<!-- CLAIM_LOCK: ... -->`, the grill-me markers, etc.).
 */
export const ANALYSIS_ONLY_MARKER = "<!-- analysis-only -->";

/**
 * Matches the marker tolerantly: any internal whitespace and case is
 * accepted, so `<!--analysis-only-->`, `<!--  Analysis-Only  -->`, etc.
 * all count.
 */
const ANALYSIS_ONLY_MARKER_RE = /<!--\s*analysis-only\s*-->/i;

/**
 * Return true when the issue body declares itself analysis-only / no-PR
 * via {@link ANALYSIS_ONLY_MARKER}.
 */
export function hasAnalysisOnlyMarker(
  body: string | undefined | null,
): boolean {
  if (!body) return false;
  return ANALYSIS_ONLY_MARKER_RE.test(body);
}

/** Which signal triggered the hand-off. */
export type AnalysisOnlyTrigger = "marker" | "no_changes";

/** Injectable dependencies for {@link handOffAnalysisOnly} (testing). */
export interface HandOffAnalysisOnlyDeps {
  /** Override the escalation chokepoint. Defaults to {@link escalateToHuman}. */
  escalate?: (
    options: EscalateToHumanOptions,
  ) => Promise<Result<EscalateToHumanOutcome>>;
  /** Override the claim-release helper. Defaults to {@link releaseClaim}. */
  releaseClaim?: typeof defaultReleaseClaim;
  /**
   * Ensure the `needs-human` label exists. Forwarded to the escalation
   * helper's `deps.github.ensureLabelExists`. In the worker pipeline this
   * is `deps.github.ensureLabelExists`; tests inject a hermetic stub.
   */
  ensureLabelExists?: (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
  /** Override the clock used by the escalation dedup window. */
  now?: () => number;
}

/** Options accepted by {@link handOffAnalysisOnly}. */
export interface HandOffAnalysisOnlyOptions {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  needsHumanLabel: string;
  githubUser: string;
  trigger: AnalysisOnlyTrigger;
  logger: Logger;
  deps?: HandOffAnalysisOnlyDeps;
}

/**
 * Build the `**Why:**` reason text for the escalation comment.
 * Exported for testing.
 */
export function buildAnalysisOnlyReason(trigger: AnalysisOnlyTrigger): string {
  if (trigger === "marker") {
    return (
      "this issue is declared analysis-only / no-PR (its body carries the " +
      "`<!-- analysis-only -->` marker), so `work-on` has no PR to raise as " +
      "its completion signal. Left under `work-on` it would be re-picked-up " +
      "and re-run indefinitely without ever completing."
    );
  }
  return (
    "`work-on` produced no code changes for this issue — it looks " +
    "analysis-only / recommendation-only, with no PR deliverable. `work-on` " +
    "treats a raised PR as its completion signal, so left under `work-on` " +
    "this issue would be re-picked-up and re-run indefinitely (the looping " +
    "behaviour reported in #2834)."
  );
}

/**
 * Build the `**Next step:**` text for the escalation comment.
 * Exported for testing.
 */
export function buildAnalysisOnlyNextStep(): string {
  return (
    "Decide the next phase for this analysis-only issue — add `planning` to " +
    "break it into actionable sub-issues, or re-scope it into a concrete " +
    "code change and re-apply `work-on` — then remove `needs-human`. " +
    "(The worker cannot self-apply `planning`/`work-on`; the security layer " +
    "strips workflow labels added by the worker, which is why the hand-off " +
    "stops at `needs-human`.)"
  );
}

/** Stable dedup key so a re-run never double-posts the hand-off comment. */
export function buildAnalysisOnlyDedupKey(issueNumber: number): string {
  return `work-on-analysis-only-${issueNumber}`;
}

/**
 * Hand a no-PR / analysis-only `work-on` issue off to a human.
 *
 * Applies `needs-human` + a paired explanation comment via the shared
 * {@link escalateToHuman} chokepoint (Issue #1471), then releases the
 * worker's self-assignment. Best-effort and non-fatal: a failure is
 * logged and swallowed so the hand-off never aborts the surrounding
 * phase.
 *
 * @returns `true` when the escalation reported a visible side effect
 *   (label added, comment posted, or comment deduped away — i.e. a prior
 *   hand-off comment already exists); `false` on escalation failure.
 */
export async function handOffAnalysisOnly(
  options: HandOffAnalysisOnlyOptions,
): Promise<boolean> {
  const {
    ghClient,
    repo,
    issueNumber,
    needsHumanLabel,
    githubUser,
    trigger,
    logger,
    deps,
  } = options;

  const escalate = deps?.escalate ?? defaultEscalateToHuman;
  const releaseClaim = deps?.releaseClaim ?? defaultReleaseClaim;

  let handedOff = false;
  try {
    const result = await escalate({
      ghClient,
      repo,
      target: { kind: "issue", number: issueNumber },
      needsHumanLabel,
      heading: "Analysis-only issue — no PR deliverable",
      reason: buildAnalysisOnlyReason(trigger),
      nextStep: buildAnalysisOnlyNextStep(),
      dedupKey: buildAnalysisOnlyDedupKey(issueNumber),
      githubUser,
      logger,
      deps: {
        ...(deps?.ensureLabelExists
          ? { github: { ensureLabelExists: deps.ensureLabelExists } }
          : {}),
        ...(deps?.now ? { now: deps.now } : {}),
      },
    });
    if (result.ok) {
      handedOff = result.value.labelAdded || result.value.commentPosted ||
        result.value.dedupSkipped;
    } else {
      logger.warn("handOffAnalysisOnly: escalation failed", {
        repo,
        issueNumber,
        error: result.error.message,
      });
    }
  } catch (err) {
    logger.warn("handOffAnalysisOnly: escalation threw", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Release the worker's claim on every terminal path (Issue #2731).
  await releaseClaim(ghClient, repo, issueNumber, githubUser, logger, {
    outcome: expectedNoPrOutcome(
      "analysis-only hand-off",
      "handed off to a human (analysis-only)",
    ),
  });

  return handedOff;
}
