/**
 * Declared-outcome hand-off detection, shared by the no-changes phase and
 * the declared-handoff phase (Issue #3088).
 *
 * `work-on` runs can declare three structured outcomes in their final
 * message instead of (or alongside) a code change: a `## Blocked:` dependency
 * deferral (Issue #222), a `vibe-defer-until` time deferral (Issue #2873), or
 * a `<!-- vibe-needs-planning reason="…" -->` planning hand-off (Issue
 * #2688). Historically these were detected only in
 * `workOnIssueHandleNoChanges`, which runs solely when the execute phase
 * early-exits with reason `"no_changes"` — so a run that committed code AND
 * emitted one of these signals sailed straight through `bump_deps` →
 * `quality_gate` → `completion`, raising a PR with `Closes #N` and closing
 * the very issue the agent asked to defer or hand off to planning
 * (Issue #3088).
 *
 * {@link handOffDeclaredOutcome} extracts the three detect-and-apply blocks
 * so both phases share one definition of "what counts as a declared
 * hand-off" and "was it actually applied". `workOnIssueHandleNoChanges` keeps
 * using it exactly as before (falling through to its own analysis-only /
 * partial-answer handling when no result was produced); the new
 * `workOnIssueDeclaredHandoff` phase (declared_handoff_phase.ts) uses it to
 * catch the same signals on a run that also produced a code change.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { resolveFleetMaintenanceAuthorSet } from "../fleet_authors.ts";
import {
  type AnalysisOnlyTrigger,
  handOffAnalysisOnly,
} from "../analysis_only_handoff.ts";
import {
  type BlockedOutcome,
  detectBlockedOutcome,
  formatDependencyRef,
} from "../blocked_outcome.ts";
import {
  deferBlockedIssue,
  hasPriorDeferralOnThread,
} from "../blocked_deferral.ts";
import {
  buildDeferralExhaustedComment,
  countPriorTimeDeferrals,
  deferIssueUntil,
  detectTimeDeferral,
  MAX_TIME_DEFERRALS,
} from "../time_deferral.ts";
import {
  detectPlanningHandoff,
  handOffToPlanning,
  hasPlanningRequestMarker,
  hasPriorPlanningHandoffOnThread,
} from "../planning_handoff.ts";
import { gatePlanningHandoff } from "../image_conclusion_gate.ts";
import { PLANNING_HANDOFF_ANCHOR } from "../planning_handoff_trust.ts";
import { redactSecrets } from "../secret_redaction.ts";

/**
 * Take the publishable tail of Claude's stdout for a public issue comment.
 *
 * Issue #3636: both no-changes branches embed this tail verbatim in a
 * world-readable comment. The child process inherits `GH_TOKEN` and its
 * Anthropic credentials, and a prompt-injected run can put them in its final
 * summary — which is exactly the text this tail captures. Route it through
 * the `redactSecrets()` chokepoint first, mirroring `label_failure.ts`.
 *
 * Redaction runs *before* the slice: slicing first can cut a credential
 * across the 3000-character boundary, leaving a fragment no rule matches.
 */
export function publishableSnippet(claudeOutput: string): string {
  return redactSecrets(claudeOutput).slice(-3000);
}

/**
 * Result of {@link handOffDeclaredOutcome}.
 */
export interface DeclaredOutcomeHandoff {
  /**
   * Set when a deferral, a planning hand-off, or the deferral-exhausted
   * analysis-only hand-off was actually applied. Callers should return this
   * unchanged as their own {@link PhaseResult}.
   */
  result?: PhaseResult;
  /**
   * The blocked-dependency detection, win or lose — callers need it for
   * their own "never treat a blocked run as already resolved" exclusion
   * (Issue #222) even when no result was produced here (e.g. a repeat
   * deferral).
   */
  blocked?: BlockedOutcome;
  /**
   * True when a structured hand-off signal was detected (a blocked outcome,
   * a *valid* time-deferral marker, or a planning request) but no
   * {@link result} was produced because a guard fell through — a repeat
   * deferral/hand-off already on the thread, a planning request missing the
   * `PLANNING_HANDOFF_ANCHOR` label, the planning image gate withholding it,
   * or the planning hand-off itself failing to apply. Callers use this to
   * decide whether a run that committed code but declared one of these
   * signals still needs handing to a human, rather than being allowed
   * straight through to completion (Issue #3088).
   */
  declared: boolean;
}

/**
 * Whether the declared dependency is still open. A committed run is deferred
 * only while it is; a closed dependency, or a state that cannot be read, does
 * not suppress the PR (Issue #3088 review).
 */
async function dependencyStillOpen(
  deps: WorkerDeps,
  repo: string,
  blocked: BlockedOutcome,
): Promise<boolean> {
  const dep = blocked.dependency;
  const depRepo = dep.repo ?? repo;
  try {
    const issue = await deps.github.createClient(deps.logger).getIssue(
      depRepo,
      dep.number,
    );
    return issue.state === "OPEN";
  } catch (err) {
    deps.logger.warn(
      "Could not read the dependency's state — not deferring a committed run",
      {
        repo,
        dependency: formatDependencyRef(dep),
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return false;
  }
}

/**
 * Detect and, where possible, apply the three declared-outcome signals a
 * `work-on` run's final message can carry: a `## Blocked:` dependency
 * deferral, a `vibe-defer-until` time deferral, and a `vibe-needs-planning`
 * hand-off. See {@link DeclaredOutcomeHandoff} for the result shape.
 */
export async function handOffDeclaredOutcome(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  trigger: AnalysisOnlyTrigger = "no_changes",
): Promise<DeclaredOutcomeHandoff> {
  const { repo, issueNumber, githubUser, config } = ctx;
  const logger = deps.logger;
  const claudeOutput = state.claudeOutput;

  // Issue #222 — a run that reported itself blocked on another issue is a
  // DEFERRAL, and it is checked first: its output routinely contains phrases
  // the completion indicators below match ("no changes needed until #560
  // lands"), and closing a live task is the one outcome that cannot be undone
  // by the next scan. The issue stays open with its discovery label, records
  // `Depends on owner/repo#N`, and the dependency gate skips it until the
  // dependency closes.
  // The committed path (`declared_handoff`) only defers the documented
  // shape: a `## Blocked:` heading whose `Depends on` / `Blocked by` line
  // names a dependency that is still open. A passing mention, a
  // first-reference fallback, or a dependency that has already merged must
  // not suppress the PR (Issue #3088 review).
  const committed = trigger === "declared_handoff";
  let blocked = detectBlockedOutcome(
    claudeOutput,
    { repo, issueNumber },
    committed ? { declaredHeadingOnly: true } : undefined,
  );
  if (blocked && committed && !await dependencyStillOpen(deps, repo, blocked)) {
    logger.info(
      "Committed run names a dependency that is not open — not deferring",
      {
        repo,
        issueNumber,
        dependency: formatDependencyRef(blocked.dependency),
      },
    );
    blocked = undefined;
  }
  // Loop guard: a deferral holds only while the dependency gate skips the
  // issue. Back here on the *same* dependency means it did not hold, and
  // deferring again would spin a fresh agent run on every scan — so the repeat
  // falls through to the analysis-only hand-off and a human sees it. Reads
  // the full comment thread rather than the budgeted prompt blob, which drops
  // the marker on a busy issue (Issue #2936).
  const blockedClient = blocked ? deps.github.createClient(logger) : undefined;
  const repeatDeferral = blocked !== undefined &&
    await hasPriorDeferralOnThread({
      ghClient: blockedClient!,
      repo,
      issueNumber,
      ref: formatDependencyRef(blocked.dependency),
      fallbackComments: ctx.issueComments,
      logger,
    });
  if (blocked && repeatDeferral) {
    logger.warn(
      "Blocked on a dependency already deferred once — handing off to a " +
        "human instead of deferring again",
      {
        repo,
        issueNumber,
        dependency: formatDependencyRef(blocked.dependency),
      },
    );
  }
  if (blocked && !repeatDeferral) {
    const result = await deferBlockedIssue({
      ghClient: blockedClient!,
      repo,
      issueNumber,
      githubUser,
      blocked,
      outputSnippet: publishableSnippet(claudeOutput),
      logger,
      deps: { ensureLabelExists: deps.github.ensureLabelExists },
      ...(committed ? { committedBranch: state.branchName } : {}),
    });
    logger.info("Blocked on a dependency — deferred instead of closing", {
      repo,
      issueNumber,
      dependency: result.ref,
      recorded: result.recorded,
    });
    return {
      blocked,
      declared: true,
      result: {
        status: "early_exit",
        reason: `deferred: depends on ${result.ref}`,
        expectedSkip: true,
        outcome: result.outcome,
      },
    };
  }

  // Issue #2873 — a run that reports the data it needs to analyse does not
  // exist *yet* (rather than the issue being blocked on another issue, or
  // genuinely needing a human decision) asks to be parked until a future
  // time via a `vibe-defer-until` marker. This is checked here, after the
  // blocked-dependency deferral above (which takes priority when both
  // appear) and before the #2834 analysis-only hand-off below, which a
  // missing/invalid/exhausted marker falls through to.
  const timeDeferral = blocked ? undefined : detectTimeDeferral(
    claudeOutput,
    Date.now(),
  );
  if (timeDeferral?.kind === "invalid") {
    logger.warn(
      committed
        ? "Time-deferral marker present but invalid — handing off to a human"
        : "Time-deferral marker present but invalid — falling through to " +
          "normal handling",
      { repo, issueNumber, why: timeDeferral.why },
    );
  } else if (timeDeferral?.kind === "valid") {
    const ghClient = deps.github.createClient(logger);
    const history = await countPriorTimeDeferrals({
      ghClient,
      repo,
      issueNumber,
      // Fleet-wide, not this host alone (Issue #2933 review): a sibling
      // host's park comments must count too, or the bound becomes
      // MAX_TIME_DEFERRALS per login rather than per issue.
      fleetAuthors: resolveFleetMaintenanceAuthorSet({
        githubUser,
        fleetPrAuthors: ctx.config.fleetPrAuthors ?? [],
        serviceAccounts: ctx.config.serviceAccounts ?? [],
      }),
      fallbackComments: ctx.issueComments,
      logger,
    });
    if (history.length < MAX_TIME_DEFERRALS) {
      const result = await deferIssueUntil({
        ghClient,
        repo,
        issueNumber,
        githubUser,
        request: timeDeferral.request,
        priorCount: history.length,
        logger,
        ...(committed ? { committedBranch: state.branchName } : {}),
      });
      logger.info(
        "Data not there yet — deferred until the requested time instead of " +
          "escalating",
        {
          repo,
          issueNumber,
          until: timeDeferral.request.until,
          recorded: result.recorded,
        },
      );
      return {
        blocked,
        declared: true,
        result: {
          status: "early_exit",
          reason: `deferred: until ${timeDeferral.request.until}`,
          expectedSkip: true,
          outcome: result.outcome,
        },
      };
    }

    logger.warn(
      "Time-deferral limit reached — handing off to a human instead of " +
        "deferring again",
      { repo, issueNumber, priorCount: history.length },
    );
    try {
      await ghClient.postComment(
        repo,
        issueNumber,
        buildDeferralExhaustedComment(history, timeDeferral.request),
      );
    } catch (err) {
      logger.error("Failed to post the deferral-exhausted comment", {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await handOffAnalysisOnly({
      ghClient,
      repo,
      issueNumber,
      needsHumanLabel: config.needsHumanLabel,
      githubUser,
      trigger,
      logger,
      deps: { ensureLabelExists: deps.github.ensureLabelExists },
    });
    return {
      blocked,
      declared: true,
      result: { status: "early_exit", reason: "analysis_only_handed_off" },
    };
  }

  // Issue #2688 — a run that judged the issue too large for one PR asks for
  // decomposition. The worker applies `planning` itself (audited, and trusted
  // only while the human `work-on` add anchors it). A repeat request, or a
  // hand-off that fails, falls through to the human hand-off below.
  const planningRequest = blocked ? undefined : detectPlanningHandoff(
    claudeOutput,
  );
  // Label security trusts the worker's `planning` only while a human
  // `work-on` add anchors it, so on any other pickup tier the label would be
  // flagged and ignored — hand those to a human instead.
  const planningImageGate = gatePlanningHandoff(ctx.untrustedImages);
  // Issue #2942: read the loop guard off the full comment thread, not the
  // budgeted prompt blob, which drops the marker on a busy issue.
  const planningClient = planningRequest
    ? deps.github.createClient(logger)
    : undefined;
  const repeatPlanning = planningRequest !== undefined &&
    await hasPriorPlanningHandoffOnThread({
      ghClient: planningClient!,
      repo,
      issueNumber,
      fallbackComments: ctx.issueComments,
      logger,
    });
  if (planningRequest && repeatPlanning) {
    logger.warn(
      "Planning requested again after an earlier hand-off — handing off to " +
        "a human instead",
      { repo, issueNumber },
    );
  } else if (
    planningRequest && !ctx.issueLabels.includes(PLANNING_HANDOFF_ANCHOR)
  ) {
    logger.warn(
      `Planning requested on an issue without \`${PLANNING_HANDOFF_ANCHOR}\` ` +
        "— the hand-off is trusted only on that anchor, so handing off to a " +
        "human instead",
      { repo, issueNumber, labels: ctx.issueLabels.join(",") },
    );
  } else if (planningRequest && planningImageGate.withheld) {
    logger.warn(planningImageGate.auditMessage ?? "", {
      repo,
      issueNumber,
      untrustedImages: planningImageGate.imageCount,
    });
  } else if (planningRequest) {
    const handoff = await handOffToPlanning({
      ghClient: planningClient!,
      repo,
      issueNumber,
      githubUser,
      reason: planningRequest.reason,
      outputSnippet: publishableSnippet(claudeOutput),
      logger,
      deps: { ensureLabelExists: deps.github.ensureLabelExists },
    });
    if (handoff.applied) {
      logger.info("Too large for one PR — handed off to planning", {
        repo,
        issueNumber,
      });
      return {
        blocked,
        declared: true,
        result: {
          status: "early_exit",
          reason: "handed off to planning",
          expectedSkip: true,
          outcome: handoff.outcome,
        },
      };
    }
  }

  // A valid time deferral never reaches here — every `kind === "valid"`
  // branch above returns. An invalid marker, and a planning marker with no
  // usable reason, still count: on the committed path those must hand off
  // rather than raise a PR (Issue #3088). The no-changes caller ignores
  // `declared` and keeps its own fall-through.
  const planningMarker = !blocked && hasPlanningRequestMarker(claudeOutput);
  const declared = blocked !== undefined || planningRequest !== undefined ||
    timeDeferral?.kind === "invalid" || planningMarker;

  return { blocked, declared };
}
