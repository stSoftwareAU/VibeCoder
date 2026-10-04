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
import type { GitHubIssue } from "../../types.ts";
import { buildDeclaredHandoffWipCommitMessage } from "../wip_checkpoint.ts";
import {
  isFleetAuthor,
  resolveFleetMaintenanceAuthorSet,
} from "../fleet_authors.ts";
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
import {
  isWorkflowScopePushRefusal,
  workflowScopePushRefusalMessage,
} from "../workflow_scope.ts";

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
 * Push the run's branch before a committed hand-off (Issue #3088).
 *
 * The execute checkpoint only pushes when session resume is on, and a failed
 * checkpoint push does not stop the run. Deferring after that names a branch
 * the next claim cannot see, and `checkout -B` from base then discards the
 * local commits. The hand-off is applied only once this push leaves nothing
 * unpushed. A failure posts no comment.
 */
export async function pushCommittedBranchForHandoff(
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult | undefined> {
  const dirtyFiles = await uncommittedFileCount(state, deps);
  const pushed = await deps.git.commitAndPushPending(
    state.branchName,
    buildDeclaredHandoffWipCommitMessage({ dirtyFiles }),
    { cwd: state.repoPath },
  );
  const stillUnpushed = pushed.ok && pushed.value.finalUnpushedCount > 0;
  if (!pushed.ok || stillUnpushed) {
    const detail = pushed.ok
      ? `${pushed.value.finalUnpushedCount} commit(s) still unpushed`
      : pushed.error.message;
    // The branch stays in the log only. The reason is what the failure
    // ladder classifies, and it must not claim a branch the push never
    // published.
    deps.logger.warn(
      "Declared hand-off not applied — the committed branch could not be pushed",
      { branch: state.branchName, error: detail },
    );
    // A workflow-scope refusal is the host's token, not a retryable push.
    // Completion reports it the same way (Issue #1952).
    if (!pushed.ok && isWorkflowScopePushRefusal(pushed.error.message)) {
      return {
        status: "failure",
        reason: workflowScopePushRefusalMessage(pushed.error.message),
      };
    }
    return {
      status: "failure",
      // "Git push failed" is the phrase detectFailureCategory reads as
      // push_failure, so the infra retry treats this like completion's push.
      reason:
        `Git push failed before the declared hand-off, so no hand-off was applied: ${detail}`,
    };
  }
  return undefined;
}

/**
 * How many paths `git status --porcelain` reports, for the hand-off commit
 * subject. A status that cannot be read counts as none: the subject still
 * carries the `wip:` prefix, and the push itself reports a real failure.
 */
async function uncommittedFileCount(
  state: PhaseState,
  deps: WorkerDeps,
): Promise<number> {
  const status = await deps.git.runGitCommand(
    ["status", "--porcelain"],
    { cwd: state.repoPath },
  );
  if (!status.ok || status.value.code !== 0) return 0;
  return status.value.stdout.split("\n").filter((line) =>
    line.trim().length > 0
  )
    .length;
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
  /**
   * True when the blocked match was excluded because the dependency was
   * filed by this fleet during the current run (Issue #3146). Only set
   * alongside `blocked` on the no-changes trigger — the committed path
   * clears `blocked` instead (via its own `blockedNotOpen` exclusion) and
   * already hands off through `declared`. The no-changes caller must hand
   * off on this detection directly rather than falling through to its
   * described-code-change retry or short-output failure: both return a
   * `failure` with no `needs-human`, and on the very next run the same
   * follow-up falls outside the run-scoped self-filed window, so the issue
   * defers onto a follow-up nothing picks up (Issue #3146 review).
   */
  selfFiledDependency?: boolean;
}

/**
 * The declared dependency's issue, or `undefined` when it cannot be read.
 * A committed run defers only while that issue is still open.
 */
async function readDeclaredDependency(
  deps: WorkerDeps,
  repo: string,
  blocked: BlockedOutcome,
): Promise<GitHubIssue | undefined> {
  const dep = blocked.dependency;
  const depRepo = dep.repo ?? repo;
  try {
    return await deps.github.createClient(deps.logger).getIssue(
      depRepo,
      dep.number,
    );
  } catch (err) {
    deps.logger.warn(
      "Could not read the dependency's state",
      {
        repo,
        dependency: formatDependencyRef(dep),
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }
}

/**
 * Whether the dependency was filed by this fleet during the current run.
 *
 * The decision is the issue record, not the run's prose: the author is this
 * host's login or another fleet author, and `createdAt` is at or after the
 * whole run started (`runStartTime`). A later execute attempt resets
 * `executeStartTime` and must not move that start. Depending on that issue
 * after a commit is not a real
 * deferral — the follow-up has no pickup label — so the run stays declared
 * and hands off to a human (Issue #3088).
 */
function dependencyFiledDuringThisRun(
  issue: GitHubIssue,
  fleetAuthors: readonly string[],
  runStartTime: number,
): boolean {
  if (!isFleetAuthor(issue.author, [...fleetAuthors])) return false;
  const createdMs = Date.parse(issue.createdAt);
  return Number.isFinite(createdMs) && createdMs >= runStartTime;
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
  // names a dependency that is still open. A passing mention or a heading
  // with no declaration line still continues. A dependency that is closed,
  // merged, missing a state, or unreadable does not defer, but the run stays
  // declared and hands off to a human instead of raising a PR (Issue #3088).
  // A dependency this fleet filed during the run does not defer on either
  // path: that would park a human-only decision on an issue nothing picks
  // up. The issue record decides that, not wording in the output
  // (Issue #3146). The no-changes path does not consult open/closed state.
  const committed = trigger === "declared_handoff";
  let blocked = detectBlockedOutcome(
    claudeOutput,
    { repo, issueNumber },
    committed ? { declaredHeadingOnly: true } : undefined,
  );
  const fleetAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    fleetPrAuthors: config.fleetPrAuthors ?? [],
    serviceAccounts: config.serviceAccounts ?? [],
  });
  let blockedNotOpen = false;
  let selfFiledDependency = false;
  if (blocked && committed) {
    const dependency = await readDeclaredDependency(deps, repo, blocked);
    const open = dependency?.state === "OPEN";
    const filedDuringRun = dependency !== undefined &&
      dependencyFiledDuringThisRun(
        dependency,
        fleetAuthors,
        state.runStartTime ?? state.executeStartTime,
      );
    if (filedDuringRun && open) {
      logger.info(
        "Committed run depends on an issue this run filed — not deferring, " +
          "handing off to a human",
        {
          repo,
          issueNumber,
          dependency: formatDependencyRef(blocked.dependency),
        },
      );
      blockedNotOpen = true;
      blocked = undefined;
    } else if (!open) {
      logger.info(
        "Committed run names a dependency that is not open — not deferring, " +
          "handing off to a human",
        {
          repo,
          issueNumber,
          dependency: formatDependencyRef(blocked.dependency),
        },
      );
      blockedNotOpen = true;
      blocked = undefined;
    }
  } else if (blocked) {
    // Issue #3146: keep `blocked` set so the already-resolved exclusion
    // below still holds, but skip only the deferral, as a repeat deferral
    // does, so the caller hands off to a human.
    const dependency = await readDeclaredDependency(deps, repo, blocked);
    const filedDuringRun = dependency !== undefined &&
      dependencyFiledDuringThisRun(
        dependency,
        fleetAuthors,
        state.runStartTime ?? state.executeStartTime,
      );
    if (filedDuringRun) {
      logger.info(
        "No-changes run depends on an issue this run filed — not deferring, " +
          "handing off to a human",
        {
          repo,
          issueNumber,
          dependency: formatDependencyRef(blocked.dependency),
        },
      );
      selfFiledDependency = true;
    }
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
  if (blocked && !repeatDeferral && !selfFiledDependency) {
    if (committed) {
      const failed = await pushCommittedBranchForHandoff(state, deps);
      if (failed) return { blocked, declared: true, result: failed };
    }
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
      fleetAuthors,
      fallbackComments: ctx.issueComments,
      logger,
    });
    if (history.length < MAX_TIME_DEFERRALS) {
      if (committed) {
        const failed = await pushCommittedBranchForHandoff(state, deps);
        if (failed) return { blocked, declared: true, result: failed };
      }
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
    if (committed) {
      const failed = await pushCommittedBranchForHandoff(state, deps);
      if (failed) return { blocked, declared: true, result: failed };
    }
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
    if (committed) {
      const failed = await pushCommittedBranchForHandoff(state, deps);
      if (failed) return { blocked, declared: true, result: failed };
    }
    const handoff = await handOffToPlanning({
      ghClient: planningClient!,
      repo,
      issueNumber,
      githubUser,
      reason: planningRequest.reason,
      outputSnippet: publishableSnippet(claudeOutput),
      logger,
      ...(committed ? { committedBranch: state.branchName } : {}),
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
    timeDeferral?.kind === "invalid" || planningMarker || blockedNotOpen;

  return { blocked, declared, selfFiledDependency };
}
