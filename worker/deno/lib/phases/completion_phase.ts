/**
 * Phase 5 — Completion (Push & PR).
 *
 * Pushes the feature branch (with rejection recovery), builds the PR
 * body from `docs/pr-summary-*.md`, validates screenshot evidence for
 * UI changes, creates or recovers the PR, then runs post-PR finalisation
 * (issue linking, duplicate PR closure, milestone retargeting, auto-merge).
 * Single responsibility: turn the local commits into a completed PR.
 *
 * Extracted from worker/deno/lib/issue_worker.ts (Issue #1527).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { HeadDivergedError } from "../git_branch.ts";
import {
  type IssueContext,
  type PhaseResult,
  type PhaseState,
  recordClaudeRunStats,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { LABEL_DEFAULTS } from "../config_defaults.ts";
import { buildWorkerFooter } from "../worker_identity.ts";
import { getRunId } from "../run_id.ts";
import { buildIdempotencyMarker, buildMilestonePrSection } from "../pr_body.ts";
import { resolveComparableBaseRef } from "../git_base_ref.ts";
import { isWipOnlyCommitLog } from "../wip_commit_marker.ts";
import { loadPrSummary } from "../pr_summary_loader.ts";
import { buildPrTitle } from "../pr_title_build.ts";
import { getRepoConfig } from "../repo_config.ts";
import type { WorkerConfig } from "../../types.ts";
import { resolveFleetMaintenanceAuthorSet } from "../fleet_authors.ts";
import {
  findBranchEvidenceImages,
  formatBranchEvidenceSection,
  isUiSourceFile,
  isVersionBumpOnly,
  validateScreenshotEvidence,
} from "../screenshot_validation.ts";
import {
  convertEvidenceImagesToRawUrls,
  findScreenshotReferences,
} from "../pr_evidence.ts";
import { resolveImagePaths } from "../image_path_resolver.ts";
import {
  buildClosureGateComment,
  validateAcceptanceClosure,
} from "../acceptance_criteria_gate.ts";
import {
  buildIndependentReviewComment,
  validateIndependentReview,
} from "../independent_review_gate.ts";
import {
  buildReproductionGateComment,
  validateReproductionStatus,
} from "../reproduction_status_gate.ts";
import {
  type BlockedGatePr,
  buildChangedWorkflowGateMessage,
  evaluateChangedWorkflowGate,
} from "../changed_workflow_gate.ts";
import { decideCompletionPr, type LinkedPr } from "../pr_run_provenance.ts";
import {
  ensureIssueClosedIfPrMerged,
  unassignAfterPrCreated,
} from "../issue_lifecycle.ts";
import { shouldRetryInfrastructureFailure } from "../infra_retry.ts";
import { createPullRequestViaRest } from "../pr_create_rest.ts";
import { ensureBranchCurrent } from "../branch_currency.ts";
import {
  buildRebasePassPrompt,
  postBranchConflictComment,
  runDeclinedRebasePass,
} from "../branch_conflict_pass.ts";
import { rebaseOntoBase } from "../stale_branch_lineage.ts";
import { isPrimaryRateLimitMessage } from "../primary_quota_latch.ts";
import {
  autoMergeOutcomeNeedsComment,
  buildArmingReasonComment,
} from "../pr_auto_merge.ts";
import { buildBumpRejectionComment, buildBumpSkipNote } from "../bump_deps.ts";
import {
  formatBuildStamp,
  resolveWorkerBuildInfo,
} from "../worker_build_info.ts";
import { bindIssueRunBehindSync } from "../milestone_presync.ts";
import { repoDirName } from "../work_volume_tiers.ts";
import {
  IMPLEMENTATION_RUN_STATS_PHASE,
  measureIssuePhaseRun,
  postIssueRunStatsComment,
} from "../issue_run_stats_comment.ts";
import { recordIssuePhaseRun } from "../fleet_telemetry.ts";
import {
  buildSecurityFixGateMessage,
  evaluateSecurityFixGate,
  hasSecurityLabel,
  matchedTestDeclarations,
  referencesFindingId,
} from "../security_fix_gate.ts";
import { collectSecurityFixDiff } from "../security_fix_diff.ts";
import { preserveRunWip } from "./run_wip_preservation.ts";
import {
  isWorkflowScopePushRefusal,
  WORKFLOW_SCOPE_REMEDIATION,
  workflowPathsIn,
  workflowScopePushRefusalMessage,
  type WorkflowScopeState,
} from "../workflow_scope.ts";
import { probeChangedWorkflowPaths } from "../workflow_scope_precheck.ts";
import { buildUncommittedWorkWipCommitMessage } from "../wip_checkpoint.ts";
import {
  classifyExistingPrForIssue,
  formatSupersededReason,
} from "../superseding_pr.ts";
import {
  claimStaleOutcome,
  prNumberFromUrl,
  summaryIncompleteOutcome,
  supersededOutcome,
} from "../run_outcome.ts";
import { createPrWithSecondaryLimitBackoff } from "../pr_creation_retry.ts";
import {
  clearMilestoneReviewRequests,
  reviewersForBase,
} from "../milestone_pr_reviewers.ts";
import {
  deferPrCreation,
  prCreationDeadlineMs,
  recordPrCreationRefusal,
  resetPrCreationBreaker,
} from "./pr_deferral.ts";
import { isSecondaryRateLimitMessage } from "../secondary_rate_limit.ts";
import { healStaleBranchLineage } from "../stale_branch_lineage.ts";
import {
  checkClaimFreshness,
  type ClaimFreshness,
  formatStaleClaimComment,
  formatStaleClaimReason,
} from "../claim_freshness.ts";
import {
  clearSecurityFixGateBlock,
  resolveSecurityGateStateDir,
} from "../security_fix_gate_feedback.ts";
import { recoverFromSecurityGateBlock } from "../security_fix_gate_retry.ts";
import { recoverFromSummaryRuleBlock } from "../summary_rule_gate_retry.ts";
import {
  assessDegradedDelivery,
  buildDegradedPrSection,
  fileDegradedFollowUp,
} from "../degraded_delivery.ts";
import { IDLE_TASK_LABEL } from "../idle_task_issue.ts";

/**
 * Phase name the `work-on` coding run is routed under (`PHASE_MODEL_DEFAULTS`).
 * Drives both the stats heading and the expected-model routing chain.
 *
 * Shared with the renderer (Issue #2346): the split figures render only for
 * this phase, so a local copy drifting from it would silently empty the pilot
 * metric.
 */
const WORK_ON_STATS_PHASE = IMPLEMENTATION_RUN_STATS_PHASE;

/** What {@link lookupPrState} could read about an existing PR. */
interface LinkedPrLookup {
  state: string | null;
  /** The PR's head branch (Issue #1799), or null when it could not be read. */
  headRefName: string | null;
}

/**
 * Look up the state and head of an existing PR. Returns nulls when they
 * cannot be determined (e.g. gh API error) — the caller should treat that
 * as "unknown" and preserve existing non-merged behaviour.
 */
async function lookupPrState(
  repo: string,
  prNumber: number,
  deps: WorkerDeps,
): Promise<LinkedPrLookup | null> {
  if (prNumber <= 0) return null;
  try {
    const output = await deps.github.runGhCommand([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state,headRefName",
    ]);
    const parsed = JSON.parse(output) as {
      state?: string;
      headRefName?: string;
    };
    return {
      state: parsed.state ?? null,
      headRefName: typeof parsed.headRefName === "string" &&
          parsed.headRefName.length > 0
        ? parsed.headRefName
        : null,
    };
  } catch (err) {
    deps.logger.warn("Recovery: PR state lookup errored (non-fatal)", {
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Run a git command and return its stdout, throwing on any failure.
 *
 * `deps.git.runGitCommand` reports a non-zero exit as `ok: true` with the exit
 * code in the value, so a caller that only checks `ok` would read a failed
 * `git diff` as empty output — a fault masked as success (Issue #3234). This
 * adapter converts both failure shapes into a throw, which is the contract
 * `collectSecurityFixDiff` uses to fall back to its next ref.
 */
async function runGitOrThrow(
  args: string[],
  repoPath: string,
  deps: WorkerDeps,
): Promise<string> {
  const result = await deps.git.runGitCommand(args, { cwd: repoPath });
  if (!result.ok) throw result.error;
  if (result.value.code !== 0) {
    throw new Error(
      `git ${
        args.join(" ")
      } failed (exit ${result.value.code}): ${result.value.stderr.trim()}`,
    );
  }
  return result.value.stdout;
}

/**
 * Does this repository opt out of auto-merge (`skip_auto_merge: true` in its
 * `.config.json` entry)? Exported for the tests; the same lookup the
 * maintenance sweep and `pr_manager` make (Issue #1650).
 */
export function repoOptsOutOfAutoMerge(
  config: WorkerConfig,
  repo: string,
): boolean {
  return getRepoConfig(config.repoConfig, repo, "skipAutoMerge") === "true";
}

/**
 * Arm auto-merge on a PR the moment it exists, and say what happened
 * (Issues #1136, #470).
 *
 * Arming at creation is the fleet's *primary* landing mechanism — the
 * priority 1.65 sweep runs before the work that raises PRs, so it cannot see
 * a PR its own cycle created. That makes this the call whose refusals matter:
 * a gate may refuse the merge, but it may not refuse silently, or an unarmed
 * PR blocks its work stream with nothing in the log to say why.
 *
 * A repository's `skip_auto_merge` opt-out is honoured here as everywhere
 * else (Issue #1650). It used to be hard-coded `false`: the sweep and
 * `pr_manager` read the setting, but the primary path did not, so a
 * repository an operator had marked for human review had its AI-authored
 * PRs armed the moment they were raised. The rest of `finalisePr` still
 * runs; only the arming is withheld, and the log says so.
 */
async function armAutoMergeAtCreation(
  ctx: IssueContext,
  state: PhaseState,
  prNumber: number,
  deps: WorkerDeps,
): Promise<void> {
  const { repo, config } = ctx;
  const logger = deps.logger;
  const skipAutoMerge = repoOptsOutOfAutoMerge(config, repo);
  if (skipAutoMerge) {
    logger.info(
      "Auto-merge not armed at creation: the repository opts out " +
        "(skip_auto_merge) — a human lands this PR (Issue #1650)",
      { repo, prNumber },
    );
  }
  const workDir = config.workDir;
  // Issue #2457: one comment seam, shared by `finalisePr`'s own note and the
  // caller's reason comment, so every PR comment goes through the same
  // `EnableAutoMergeOptions.commentFn` shape.
  const commentFn = async (
    r: string,
    n: number,
    body: string,
  ): Promise<void> => {
    await deps.github.runGhCommand([
      "pr",
      "comment",
      String(n),
      "--repo",
      r,
      "--body",
      body,
    ]);
  };
  const result = await deps.pr.finalisePr({
    repo,
    prNumber,
    skipAutoMerge,
    commentFn,
    // Route the milestone gates' warnings into the worker log rather than
    // `console.warn`, which no operator reads.
    log: (message: string) => logger.warn(message, { repo, prNumber }),
    ...(state.branchName ? { headRefName: state.branchName } : {}),
    ...(state.milestoneBranch ?? state.baseBranch
      ? { baseRefName: state.milestoneBranch ?? state.baseBranch }
      : {}),
    // Issue #2005: a child raised while its milestone fell behind mid-run
    // used to wait a full cycle for the 1.72 sweep. Sync here with the
    // same ledger as the pre-cut path, then arm in this cycle when it lands.
    ...(workDir && state.defaultBranch && !skipAutoMerge
      ? {
        syncBehindMilestone: bindIssueRunBehindSync({
          repo,
          ...(ctx.milestoneTitle ? { milestoneTitle: ctx.milestoneTitle } : {}),
          defaultBranch: state.defaultBranch,
          cwd: `${workDir}/${repoDirName(repo)}`,
          workDir,
          config,
          logger,
          ...(ctx.cycleDeadlineEpochMs !== undefined
            ? { cycleDeadlineEpochMs: ctx.cycleDeadlineEpochMs }
            : {}),
          syncMilestoneBranchFn: deps.git.syncMilestoneBranchWithDefault,
          countCommitsAheadFn: deps.git.countCommitsAhead,
          runGitCommandFn: deps.git.runGitCommand,
          runAgentFn: deps.claude.runClaudeWithRetry,
          ghCommandFn: deps.github.runGhCommand,
        }),
      }
      : {}),
  });
  if (result.ok) {
    if (!skipAutoMerge) {
      logger.info(
        `Auto-merge ${result.value.result} at creation: ${result.value.message}`,
        { repo, prNumber },
      );
    }
    // Issue #2457: a refusal to arm must carry a reason on the PR, exactly
    // once per run, naming the reason and stating the sweep retries. Success
    // and already-explained outcomes stay quiet on the comment channel.
    if (
      !skipAutoMerge &&
      autoMergeOutcomeNeedsComment(result.value)
    ) {
      const body = buildArmingReasonComment(result.value);
      logger.warn(`Auto-merge NOT armed at creation: ${result.value.message}`, {
        repo,
        prNumber,
      });
      try {
        await commentFn(repo, prNumber, body);
      } catch (error: unknown) {
        logger.warn(
          `Could not post the auto-merge reason comment on ${repo}#${prNumber}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { repo, prNumber },
        );
      }
    }
    return;
  }
  logger.warn(`Auto-merge NOT armed at creation: ${result.error.message}`, {
    repo,
    prNumber,
  });
}

/**
 * The open PR already on this run's head, when the gate that just blocked was
 * not, in fact, ahead of the PR (Issue #2044).
 *
 * The agent raises its own PR from inside the execute phase often enough that
 * the completion phase carries a recovery path for it, and the changed-workflow
 * gate runs whether or not that happened. Absent this lookup the block reported
 * "no PR was raised" over a live PR on its own head.
 *
 * Returns `undefined` for "no open PR" and for a lookup fault alike — both mean
 * this run cannot name a PR — but the two are logged apart, so an outage is
 * never silently recorded as a run that raised nothing. A URL this phase cannot
 * number is refused for the same reason `reportSummaryRuleBlock` refuses one:
 * naming `#0` is worse than naming nothing.
 */
async function lookupBlockedGatePr(
  repo: string,
  branchName: string,
  deps: WorkerDeps,
): Promise<BlockedGatePr | undefined> {
  const logger = deps.logger;
  const existing = await deps.pr.findExistingPrForBranch(repo, branchName);
  if (!existing.ok) {
    logger.info(
      "No open PR found for this run's branch — the gate block is reported " +
        "as a run that raised no PR",
      { repo, branch: branchName, lookup: existing.error.message },
    );
    return undefined;
  }
  const number = prNumberFromUrl(existing.value);
  if (number <= 0) {
    logger.warn(
      "Could not read a PR number from the open PR URL — the gate block " +
        "names no PR rather than naming #0",
      { repo, branch: branchName, prUrl: existing.value },
    );
    return undefined;
  }
  return { number, url: existing.value };
}

/**
 * Report a PR-summary document rule the run broke (Issue #1140).
 *
 * The three summary gates — acceptance-criteria closure, independent review,
 * reproduction status — sit at this phase's PR-creation chokepoint, so
 * blocking one normally costs the next attempt a rewrite and nothing else.
 * The chokepoint is not always ahead of the PR: the agent raises its own PR
 * from inside the execute phase often enough that this module already carries
 * a self-healing recovery path for exactly that. On 2026-09-05 four fleet runs
 * raised a PR and were recorded `failure` 25-68 seconds later for a summary
 * rule — a missing `reviewer:` name, most of them — and all four PRs merged.
 * A `failure` releases the claim, cools the issue down and returns it to the
 * claimable pool, so a sibling host redoes finished work at a mean $10.80 a
 * run, and nine such format blocks in twenty-five phase failures buried the
 * genuine ones.
 *
 * The rule is worth checking; reporting it as "the code did not work" is not.
 * So the outcome depends on whether the work reached a PR:
 *
 * - **no PR for this run's branch** — the verdict is recorded on the phase
 *   state and the gate blocks, which `workOnIssueCompletion` recovers from
 *   once inside the run (Issue #2189) before the failure stands;
 * - **a PR already exists** — the PR is finalised the way the recovery path
 *   finalises it (body, labels, link, auto-merge), and the run reports
 *   `summary_incomplete`: the work is done, the summary is short, and the
 *   issue stays attached to its PR instead of going back in the queue.
 *
 * Either way the gate's remediation comment is posted, so the shortfall is on
 * the issue thread rather than only in this host's log — once per distinct
 * verdict, so the in-run recovery does not post the same block twice.
 *
 * The security-fix gate deliberately does not route through here. A PR that
 * closes a security-labelled finding without its vulnerability-fix evidence
 * must stop, PR or no PR.
 *
 * @param reason - The phase-failure reason the gate would have reported.
 * @param comment - The gate's remediation comment for the issue thread.
 * @returns `failure` when no PR exists, `early_exit` carrying the
 *   `summary_incomplete` outcome when one does.
 */
async function reportSummaryRuleBlock(
  reason: string,
  comment: string,
  ctx: IssueContext,
  state: PhaseState,
  prBody: string,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber } = ctx;
  const logger = deps.logger;
  const client = deps.github.createClient(logger);

  const existingPr = await deps.pr.findExistingPrForBranch(
    repo,
    state.branchName,
  );

  // A run that recovers in-run (Issue #2189) reaches this gate twice, and the
  // second verdict is usually the first one again. Post it once: the thread
  // records the shortfall, not the number of attempts at it.
  const verdicts = state.summaryRuleBlocks ?? [];
  const alreadyOnThread = verdicts.some((v) => v.comment === comment);
  if (!existingPr.ok) {
    state.summaryRuleBlocks = [...verdicts, { reason, comment }];
  }
  if (alreadyOnThread) {
    logger.info(
      "Summary-rule verdict already posted in this run — not repeating the " +
        "comment",
      { repo, issueNumber, reason },
    );
  } else {
    await client.postComment(repo, issueNumber, comment);
  }

  if (!existingPr.ok) {
    // `findExistingPrForBranch` returns the same shape for "no open PR" and
    // for a `gh` fault, and only one of those is a fact about the run. Say
    // which was seen: an outage reported as "this run raised no PR" is the
    // silent downgrade the fail-loud rule exists to stop.
    logger.warn(
      "No open PR found for this run's branch — the summary rule fails the " +
        "run as before",
      {
        repo,
        issueNumber,
        branch: state.branchName,
        lookup: existingPr.error.message,
      },
    );
    return { status: "failure", reason };
  }

  const prUrl = existingPr.value;
  logger.warn(
    "PR-summary rule broken on a run that had already raised its PR — " +
      "recording the shortfall against that PR instead of failing the run " +
      "(Issue #1140)",
    { repo, issueNumber, prUrl, reason },
  );
  const recovered = await recoverAndFinaliseExistingPr(
    prUrl,
    ctx,
    state,
    prBody,
    deps,
  );
  if (recovered.status !== "continue") return recovered;

  const prNumber = state.prNumber ?? 0;
  if (prNumber <= 0) {
    // A PR URL this phase cannot number is a PR it cannot name on the
    // outcome, and an outcome that reads "Raised #0" is worse than a
    // failure. Fail loud and let the ordinary retry path have it.
    logger.warn(
      "Could not read a PR number from the existing PR URL — reporting the " +
        "summary rule as a failure rather than naming an unnumbered PR",
      { repo, issueNumber, prUrl },
    );
    return { status: "failure", reason };
  }

  return {
    status: "early_exit",
    reason,
    outcome: summaryIncompleteOutcome({
      phase: "completion",
      prUrl,
      prNumber,
      problem: reason,
    }),
  };
}

/**
 * Recover an existing PR by updating its body and labels, then finalise (Issue #1189).
 *
 * Issue #1559: When the recovered PR is already merged, skip the redundant
 * "PR created" link comment and call `ensureIssueClosedIfPrMerged` so the
 * worker does not loop re-picking up an issue whose work is already shipped.
 *
 * Exported for unit testing — the primary entry point remains
 * `workOnIssueCompletion`.
 */
export async function recoverAndFinaliseExistingPr(
  prUrl: string,
  ctx: IssueContext,
  state: PhaseState,
  prBody: string,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber, githubUser, milestoneTitle, issueLabels } = ctx;
  const logger = deps.logger;
  const prNumber = prNumberFromUrl(prUrl);
  // The run outcome names this PR at claim release (Issue #4325).
  state.prUrl = prUrl;
  state.prNumber = prNumber;

  // Update existing PR body with latest content
  await deps.pr.recoverExistingPr(repo, issueNumber, prUrl, prBody);

  // Update labels on existing PR (Issue #1189)
  if (issueLabels.length > 0 && prNumber > 0) {
    const labelResult = await deps.pr.updatePrLabels(
      repo,
      prNumber,
      issueLabels,
    );
    if (!labelResult.ok) {
      logger.warn("Failed to update PR labels (non-fatal)", {
        error: labelResult.error.message,
      });
    }
  }

  // Issue #1559: Check PR state up front so we can suppress the redundant
  // "PR created" link comment when the PR is already merged.
  const prState = (await lookupPrState(repo, prNumber, deps))?.state ?? null;
  const prAlreadyMerged = prState === "MERGED";

  // Post-recovery finalisation (best-effort)
  try {
    // Skip the link comment when the PR is already merged — the issue is
    // about to be closed, so a "PR created" comment is pure noise.
    if (!prAlreadyMerged) {
      await deps.pr.linkPrToIssue(repo, issueNumber, prUrl);
    }
    // Issue #1264: name the fleet authors and opt out of the report-only
    // default — only the fleet's own duplicate on this branch is closed.
    await deps.pr.closeDuplicatePrs(repo, state.branchName, prUrl, undefined, {
      allowedAuthors: fleetAuthorsFor(ctx),
      dryRun: false,
    });

    if (milestoneTitle && state.milestoneBranch && prNumber > 0) {
      await deps.pr.retargetPrToMilestone(
        repo,
        prNumber,
        state.milestoneBranch,
      );
    }

    // Issue #1136: arm auto-merge here, on the recovery path too — see the
    // note on the creation path below.
    if (prNumber > 0) {
      await armAutoMergeAtCreation(ctx, state, prNumber, deps);
    }
  } catch (err) {
    logger.warn("Post-recovery finalisation error (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Issue #1559: After finalisation, close the issue if the recovered PR
  // was merged. Best-effort — a failure here must not regress existing
  // recovery behaviour.
  if (prNumber > 0) {
    try {
      // Issue #174: the branch is the provenance proof. Without it the
      // recovery path would close the issue against whichever merged PR the
      // linker happened to return.
      const closeResult = await ensureIssueClosedIfPrMerged(
        repo,
        issueNumber,
        prNumber,
        githubUser,
        { ghCommandFn: deps.github.runGhCommand, logger },
        state.branchName,
      );
      if (!closeResult.ok) {
        logger.warn(
          "Recovery: ensureIssueClosedIfPrMerged errored (non-fatal)",
          {
            repo,
            issueNumber,
            prNumber,
            error: closeResult.error.message,
          },
        );
      }
    } catch (err) {
      logger.warn("Recovery: ensureIssueClosedIfPrMerged threw (non-fatal)", {
        repo,
        issueNumber,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { status: "continue" };
}

/**
 * Push commits, create a PR, and finalise the issue.
 *
 * Handles push with recovery, PR body construction, duplicate PR
 * detection, auto-merge, reviewer requests, and issue linking.
 *
 * Issue #1550: Wraps the phase body in a bounded in-process retry for
 * infrastructure-category failures (notably `push_failure`). A transient
 * git-push blip no longer applies `failed-once` on the first occurrence —
 * the phase sleeps briefly and re-runs once before surfacing the failure.
 */
export async function workOnIssueCompletion(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  let result = await runCompletionAttempt(ctx, state, deps);

  // In-run recovery from the first security-fix gate block (Issue #1575): a
  // false block used to cost the whole run.
  if (
    result.status === "failure" && (state.securityGateBlocks?.length ?? 0) > 0
  ) {
    result = await recoverFromSecurityGateBlock(
      ctx,
      state,
      deps,
      () => runCompletionAttempt(ctx, state, deps),
    );
  }

  // In-run recovery from the first PR-summary rule block (Issue #2189): a
  // documentation shortfall on a pushed, quality-gated branch used to cost the
  // whole run. Entered once per run — a block on the re-run is the second, and
  // fails as before.
  if (
    result.status === "failure" && (state.summaryRuleBlocks?.length ?? 0) === 1
  ) {
    result = await recoverFromSummaryRuleBlock(
      ctx,
      state,
      deps,
      result,
      () => runCompletionAttempt(ctx, state, deps),
    );
  }

  // Issue #3756 — a `work-on` issue is auto-closed by its merged PR, with no
  // worker attached at that moment, so PR-raise is the last point the worker
  // can report what the run cost. Post the issue's single cost/model stats
  // comment here, once the PR exists. Non-fatal and deduplicated: it never
  // affects the phase result.
  if (result.status !== "failure") {
    await postWorkOnRunStats(ctx, state, deps);
  }

  return result;
}

/**
 * One completion-phase attempt, with the #1550 infrastructure retry.
 *
 * A security-fix or summary-rule gate block is a verdict, not an infrastructure
 * blip: re-running the same body against the same summary reproduces it, so the
 * retry is skipped and the in-run recovery (Issues #1575 and #2189) handles it
 * instead.
 */
async function runCompletionAttempt(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const blocksBefore = state.securityGateBlocks?.length ?? 0;
  const summaryBlocksBefore = state.summaryRuleBlocks?.length ?? 0;
  const result = await completionBody(ctx, state, deps);
  const gateBlocked = (state.securityGateBlocks?.length ?? 0) > blocksBefore;
  const summaryRuleBlocked =
    (state.summaryRuleBlocks?.length ?? 0) > summaryBlocksBefore;

  if (result.status !== "failure" || gateBlocked || summaryRuleBlocked) {
    return result;
  }

  const shouldRetry = await shouldRetryInfrastructureFailure(
    "completion",
    result.reason,
    state,
    deps.logger,
    {
      backoffMs: ctx.config.infraRetryBackoffMs,
      cycleDeadlineEpochMs: ctx.cycleDeadlineEpochMs,
    },
  );
  return shouldRetry ? await completionBody(ctx, state, deps) : result;
}

/**
 * The fleet logins whose run-stats comments this run counts (Issue #1249).
 *
 * `service_accounts` ∪ `fleet_pr_authors` ∪ this host's login — the same
 * identity every other author check uses, read from the context the phase
 * already holds rather than from the config file a second time.
 */
function fleetAuthorsFor(ctx: IssueContext): string[] {
  return resolveFleetMaintenanceAuthorSet({
    githubUser: ctx.githubUser,
    fleetPrAuthors: ctx.config.fleetPrAuthors ?? [],
    serviceAccounts: ctx.config.serviceAccounts ?? [],
  });
}

/**
 * Post the `work-on` run's cost/model stats comment on the issue (Issue #3756).
 *
 * Reports only the invocations the execute phase recorded on this run — the
 * comment body states that limit explicitly. Skipped entirely when Claude never
 * ran (nothing to report) or when the issue already carries a stats comment.
 */
async function postWorkOnRunStats(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<void> {
  const claudeResults = state.claudeRunStats ?? [];
  if (claudeResults.length === 0) return;

  const client = deps.github.createClient(deps.logger);
  const posted = await postIssueRunStatsComment({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    phase: WORK_ON_STATS_PHASE,
    claudeResults,
    getIssueComments: (repo, issueNumber) =>
      client.getIssueComments(repo, issueNumber),
    postComment: (repo, issueNumber, body) =>
      client.postComment(repo, issueNumber, body),
    logger: deps.logger,
    // What Graft did for this run, from the slot the execute phase filled
    // (Issue #2105). Absent when the run never reached the collection.
    ...(state.graftContext ? { graft: state.graftContext } : {}),
    // The cumulative total is summed over fleet-authored comments only
    // (Issue #1249, finding 12). This phase already holds the run's identity,
    // so it states the fleet rather than re-reading the config file.
    authorOptions: { fleetAuthors: fleetAuthorsFor(ctx) },
    // The run's CodeGraph figures, recorded by the execute phase beside the
    // invocations above, ride the same comment (Issue #2161).
    ...(state.codegraphContext ? { codegraph: state.codegraphContext } : {}),
    // Which attempt the quality gate passed on, from the slot the gate phase
    // filled (Issue #2345). Absent when the run never reached the gate, which
    // renders no line at all.
    ...(state.qualityGateOutcome
      ? { qualityGate: state.qualityGateOutcome }
      : {}),
    // …and so does its RTK status, `off` included (Issue #2385).
    ...(state.rtkOutput ? { rtk: state.rtkOutput } : {}),
    // …and brief's, when the run built a codebase map (Issue #2603).
    ...(state.brief ? { brief: state.brief } : {}),
  });

  // Issue #2347: the same figures the comment above renders, recorded once per
  // completed implementation run so the pilot host's spend, first-attempt gate
  // pass rate and duration are comparable with the control hosts' straight off
  // the fleet summary — no reading every run-stats comment.
  //
  // `already_posted` is the one skip that must not record: this run is counted
  // already, and counting it twice would halve its own pass rate. A GitHub
  // failure still records — the run happened, and losing its figures to a
  // comment that did not post would understate the host. `no_stats` needs no
  // guard here: a run no invocation produced stats for renders no comment, and
  // `measureIssuePhaseRun` measures nothing for it either.
  if (posted.reason !== "already_posted") {
    const figures = measureIssuePhaseRun({
      phase: WORK_ON_STATS_PHASE,
      claudeResults,
      ...(state.qualityGateOutcome
        ? { qualityGate: state.qualityGateOutcome }
        : {}),
    });
    if (figures) recordIssuePhaseRun(figures);
  }
}

/**
 * Refuse a PR built from nothing but an earlier run's WIP commits (Issue #148).
 *
 * WIP preservation (#47) and the periodic checkpoints (#4170) both leave
 * placeholder commits on the claim-locked issue branch so a killed run's work
 * survives. Those commits make the branch "ahead of base", so the guard above
 * — which only knows the *count* — waves through a re-claim that added
 * nothing, and a half-done PR is raised from work nobody finished.
 *
 * Two conditions must both hold before the PR is refused:
 *
 *  1. every commit ahead of base is a worker-authored WIP marker, and
 *  2. the branch tip is exactly where it stood before this run's agent
 *     started — the resume did not advance it.
 *
 * Condition 2 is what keeps a genuine run safe: an agent that finished its
 * work and left the phase-end checkpoint to commit it *did* move the tip, so
 * its PR is raised as normal. Anything the gate cannot determine (no captured
 * SHA, an unreadable log) fails open — this refuses a PR, so it must never
 * act on a guess.
 *
 * @returns the failure reason when the branch is half-done, otherwise null.
 */
async function detectHalfDoneWipBranch(
  state: PhaseState,
  deps: WorkerDeps,
  comparableBase: string,
): Promise<string | null> {
  const startSha = state.executeStartHeadSha;
  if (!startSha) return null;

  // One call yields both the tip (first line — `git log` is newest first) and
  // every subject in the range.
  const logResult = await deps.git.runGitCommand(
    [
      "log",
      "--format=%H%x09%s",
      "--end-of-options",
      `${comparableBase}..${state.branchName}`,
    ],
    { cwd: state.repoPath },
  );
  if (!logResult.ok || logResult.value.code !== 0) {
    deps.logger.warn(
      "WIP-only guard could not run — proceeding to PR creation without it",
      {
        error: logResult.ok
          ? logResult.value.stderr.trim() || `exit ${logResult.value.code}`
          : logResult.error.message,
      },
    );
    return null;
  }

  const entries = logResult.value.stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab < 0
        ? { sha: line, subject: "" }
        : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
  if (entries.length === 0) return null;
  // The run moved the branch on — whatever it produced is this run's work.
  if (entries[0]!.sha !== startSha) return null;
  if (!isWipOnlyCommitLog(entries.map((entry) => entry.subject))) return null;

  // The wording carries `failure_diagnosis`'s stable "without making any
  // changes" marker on purpose: this run finished without adding to the
  // branch, which is a no_changes outcome, not a worker fault to retry.
  return `Branch \`${state.branchName}\` carries only WIP commits preserved ` +
    `from an earlier timed-out run, and this run ended without making any ` +
    `changes to it — refusing to raise a half-done PR (Issue #148). The ` +
    `next claim resumes from the branch and must add to it before a PR can ` +
    `be raised.`;
}

/**
 * Open the PR over REST when `gh pr create` met an exhausted primary
 * GraphQL quota (Issue #42).
 *
 * The REST `pulls` endpoint rides GitHub's separate core quota, so a run
 * whose work is committed, pushed and quality-gated still lands its PR
 * instead of leaving an orphaned branch behind. Best-effort by design: a
 * REST failure returns null and the caller falls through to its existing
 * self-healing/failure path, with the original error intact.
 *
 * @returns the created (or already-existing) PR URL, or null when the
 *          fallback could not open one.
 */
async function createPrViaRestFallback(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  pr: { title: string; body: string; base: string },
): Promise<string | null> {
  const logger = deps.logger;
  logger.warn(
    "gh pr create hit the primary GraphQL quota — falling back to the REST " +
      "pulls endpoint (core quota) so the pushed branch still gets its PR",
    { repo: ctx.repo, branch: state.branchName },
  );

  const created = await createPullRequestViaRest({
    repo: ctx.repo,
    title: pr.title,
    body: pr.body,
    head: state.branchName,
    base: pr.base,
    reviewers: ctx.config.prReviewers,
  }, {
    ghCommandFn: deps.github.runGhCommand,
    log: (message) => logger.warn(message),
  });

  if (!created.ok) {
    logger.warn("REST PR-create fallback failed", {
      error: created.error.message,
    });
    return null;
  }

  logger.info("PR created via the REST fallback", {
    prUrl: created.value,
    build: formatBuildStamp(resolveWorkerBuildInfo()),
  });
  return created.value;
}

/**
 * Stop the run because the claim went stale before the PR could be raised
 * (Issue #344).
 *
 * The branch is already pushed by this point, so nothing is lost — but only
 * if someone can find it. The comment on the issue is what makes that true,
 * and it is best-effort: a comment that fails to post must not turn a clean
 * abort into a failure, so it is warned about and the abort stands.
 *
 * Not a failure: no failure label, no `unknown` class, no run-failure issue,
 * and no contribution to the failure streak — "the claim went stale" is the
 * system working (Issue #342 is what happens when a normal outcome is counted
 * as a crash).
 */
async function abortStaleClaim(
  stale: Extract<ClaimFreshness, { kind: "stale" }>,
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber } = ctx;
  const logger = deps.logger;

  logger.warn(
    `Claim on ${repo}#${issueNumber} went stale during this run — NOT ` +
      `opening a PR (Issue #344)`,
    {
      reason: stale.reason,
      detail: stale.detail,
      branch: state.branchName,
      ...(stale.prUrl ? { prUrl: stale.prUrl } : {}),
    },
  );

  try {
    const client = deps.github.createClient(logger);
    await client.postComment(
      repo,
      issueNumber,
      formatStaleClaimComment({
        repo,
        branch: state.branchName,
        stale,
      }),
    );
  } catch (err) {
    logger.warn(
      `Could not comment the stale-claim hand-off on ${repo}#${issueNumber} ` +
        `— the work is still on '${state.branchName}' (Issue #344): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }

  return {
    status: "early_exit",
    reason: formatStaleClaimReason(stale),
    outcome: claimStaleOutcome({
      phase: "completion",
      stale,
      branch: state.branchName,
    }),
  };
}

/** Single-attempt completion-phase body — see `workOnIssueCompletion`. */
async function completionBody(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber, issueTitle, githubUser, config, milestoneTitle } =
    ctx;
  const logger = deps.logger;

  // Reconcile HEAD to the worker branch before anything is pushed (Issue
  // #4286). The agent may have committed on a branch of its own; every
  // step below assumes HEAD IS state.branchName, and each silently agreed
  // with the others while all being wrong until `gh pr create` met an
  // empty branch ("No commits between …", private-repo-22#565, three
  // attempts). Fast-forward when safe; refuse loudly when diverged.
  const reconcile = await deps.git.reconcileHeadToBranch(state.branchName, {
    cwd: state.repoPath,
  });
  if (!reconcile.ok) {
    // Issue #1793: a divergence on an issue that has since closed is not a
    // stranded branch, it is work that landed elsewhere. GRQ-AutoTrader#127
    // — a milestone-sync conflict a human routed to the worker — could only
    // be resolved by a PR into the milestone branch, so the agent opened
    // and merged one from a branch of its own and closed the issue; this
    // guard then failed the run, and a health failure was recorded for a
    // run that succeeded. Ask the issue before calling the divergence a
    // failure: closed means the #344 stale-claim exit, which is the system
    // working — no failure label, no run-failure issue, no streak.
    if (reconcile.error instanceof HeadDivergedError) {
      const freshness = await checkClaimFreshness({
        repo,
        issueNumber,
        runBranch: state.branchName,
        mode: "pre-write",
        deps: {
          findExistingPrForIssue: deps.pr.findExistingPrForIssue,
          runGhCommand: deps.github.runGhCommand,
          warn: (m: string) => logger.warn(m),
        },
      });
      if (freshness.kind === "stale") {
        logger.warn(
          `HEAD is on '${reconcile.error.head}', diverged from ` +
            `'${state.branchName}', and the issue is closed — the work ` +
            `landed elsewhere; not a failure (Issue #1793)`,
          { repo, issueNumber, head: reconcile.error.head },
        );
        return await abortStaleClaim(
          {
            ...freshness,
            detail: `${freshness.detail}; the agent's commits are on ` +
              `'${reconcile.error.head}', which has diverged from this ` +
              `run's branch (Issue #1793)`,
          },
          ctx,
          state,
          deps,
        );
      }
    }
    return {
      status: "failure",
      reason:
        `Cannot push branch \`${state.branchName}\`: ${reconcile.error.message}`,
    };
  }
  if (reconcile.value.action === "fast-forwarded") {
    logger.warn(
      `The agent committed on '${reconcile.value.fromRef}' rather than the ` +
        `worker branch — fast-forwarded '${state.branchName}' to that work ` +
        `before pushing (Issue #4286)`,
    );
  }

  // The single resolved base for this PR — used by the stale-lineage guard
  // below, the ahead-count guard, the milestone footer (Issue #3911), and
  // `gh pr create --base`, so they can never disagree.
  const baseBranch = state.milestoneBranch ?? state.defaultBranch;

  // Stale-lineage guard (Issue #534) — before anything is pushed. Two runs
  // held one issue branch: the first rebased, force-pushed and squash-merged;
  // the second never saw it, re-created the reaped branch from the pre-rebase
  // lineage and opened a PR that could never merge (identical content collides
  // with its own squash), wedged on a two-attempt path to `needs-human`. The
  // guard rebases the branch past the squash and republishes it, so what
  // reaches `gh pr create` carries only the genuinely unmerged commits.
  const lineage = await healStaleBranchLineage({
    repo,
    branch: state.branchName,
    baseBranch,
    runGit: deps.git.runGitCommand,
    runGh: deps.github.runGhCommand,
    cwd: state.repoPath,
    warn: (m: string) => logger.warn(m),
  });
  if (lineage.kind === "refused") {
    return {
      status: "failure",
      reason:
        `Refusing to push \`${state.branchName}\`: ${lineage.detail} (Issue #534)`,
    };
  }
  if (lineage.kind === "healed") {
    logger.warn(
      `SELF-HEALING: '${state.branchName}' was rebased past a squash merge ` +
        `before this run's PR (Issue #534)`,
      {
        detail: lineage.detail,
        previousHead: lineage.previousHead,
        newHead: lineage.newHead,
        replayed: lineage.replayed.length,
        dropped: lineage.dropped.length,
        pushed: lineage.pushed,
      },
    );
  }

  // Bring the branch up to date BEFORE the PR exists, so its CI runs once.
  //
  // A branch behind its base is tested twice: once on the stale head, then
  // again after something updates it. Both runs pass, nothing reports the
  // duplication, and the cycle is simply slower — and with the four
  // `validate (tests N/4)` shards now required on `milestone/**` as well as
  // the default branch, that doubling is the most expensive avoidable thing
  // the fleet does.
  //
  // Distinct from the stale-lineage guard above, which repairs a branch whose
  // commits were already squashed away. This one handles the ordinary case:
  // the base simply moved on while the agent worked.
  //
  // Never fatal. A dirty tree, a real content conflict or an unreadable
  // comparison all leave the branch exactly as it was and the PR proceeds —
  // an extra CI run is a cost, a wrongly-rebased branch is a defect, and
  // diverged content belongs to the conflict ladder.
  const currency = await ensureBranchCurrent({
    branch: state.branchName,
    baseBranch,
    runGit: deps.git.runGitCommand,
    cwd: state.repoPath,
    rebase: rebaseOntoBase,
    log: (m: string) => logger.info(m),
  });
  // Issue #2459: a decline means the content genuinely diverged, and until now
  // the PR was raised on the stale head and sat unmergeable until the conflict
  // ladder found it hours later. Spend exactly one agent pass trying to close
  // that gap — one invocation, bounded by the cycle deadline, no retry loop and
  // no polling. `branch_currency.ts` stays a non-resolver; the resolving lives
  // here. `unknown` is unchanged: it means we could not read the comparison, so
  // there is nothing to resolve.
  let branchConflictComment: string | null = null;
  if (currency.kind === "declined") {
    const pass = await runDeclinedRebasePass({
      branch: state.branchName,
      baseBranch,
      detail: currency.detail,
      runGit: deps.git.runGitCommand,
      cwd: state.repoPath,
      deadlineEpochMs: ctx.cycleDeadlineEpochMs,
      log: (m: string) => logger.info(m),
      runAgentFn: async (request) => {
        const result = await deps.claude.runClaudeWithRetry(
          {
            prompt: buildRebasePassPrompt(request),
            phase: "issue",
            repo,
            issueNumber,
            timeoutSeconds: Math.min(
              config.claudeTimeout,
              request.budgetSeconds ?? config.claudeTimeout,
            ),
            killAfterSeconds: config.claudeKillAfter,
            model: config.claudeModel || undefined,
            cwd: state.repoPath,
            logger,
          },
          { maxRetries: config.maxRateLimitRetries },
        );
        if (result.ok) recordClaudeRunStats(state, result.value);
        return result;
      },
    });
    if (pass.kind === "handed-off") {
      branchConflictComment = pass.comment;
      logger.warn(
        `'${state.branchName}' was not brought up to date before its PR — ` +
          `CI may run twice: ${pass.detail}`,
      );
    }
  } else if (currency.kind === "unknown") {
    logger.warn(
      `'${state.branchName}' was not brought up to date before its PR — ` +
        `CI may run twice: ${currency.detail}`,
    );
  }

  // Issue #1475: a token without the `workflow` OAuth scope cannot create
  // or update anything under .github/workflows/ — GitHub rejects the push,
  // and only says so at the push, after five recovery attempts. Ask git
  // what this branch changes and stop here, with the fix, when the answer
  // needs a scope the token does not have.
  //
  // Issue #1952: neither half of this may fail open in silence. When the
  // launcher recorded no verdict the check cannot run at all, and says so;
  // when the diff cannot answer, the probe asks the commit list before
  // giving up. A branch that still reaches the push meets the refusal
  // handler below, which fails once instead of rebasing five times.
  const scopeState: WorkflowScopeState = deps.infrastructure
    .workflowScopeState();
  if (scopeState !== "granted") {
    const probe = await probeChangedWorkflowPaths({
      baseRef: `origin/${baseBranch}`,
      cwd: state.repoPath,
      runGit: deps.git.runGitCommand,
      warn: (message: string) => logger.warn(message),
    });
    const workflowPaths = workflowPathsIn(probe.paths);
    // Named in both messages: a path the commit list supplied is a weaker
    // answer than one the diff gave, and the reader is told which it was.
    const provenance = probe.source === "diff"
      ? "the branch diff"
      : "the branch's commit list, the diff having failed";
    if (workflowPaths.length > 0 && scopeState === "absent") {
      return {
        status: "failure",
        reason: `Cannot push: the token lacks the 'workflow' scope and the ` +
          `branch changes ${workflowPaths.join(", ")} (per ${provenance}) — ` +
          `GitHub rejects such a push from any OAuth token without it. No ` +
          `push was attempted. Fix: ${WORKFLOW_SCOPE_REMEDIATION}`,
      };
    }
    if (workflowPaths.length > 0) {
      logger.warn(
        `Workflow-scope pre-push check could not decide: the launcher ` +
          `recorded no token-scope verdict and this branch changes ` +
          `${workflowPaths.join(", ")} (per ${provenance}) — GitHub decides ` +
          `at the push, and a refusal there fails the run once (Issue #1952)`,
      );
    }
  }

  // Push branch
  const pushResult = await deps.git.pushUnpushedCommits(state.branchName, {
    cwd: state.repoPath,
  });
  if (!pushResult.ok) {
    // Issue #1952: GitHub refusing a workflow file for want of the scope is
    // not a stale branch. Fetch, rebase and retry cannot supply a missing
    // scope, so stop on the first refusal with the fix named — and with the
    // phrase that classifies the run as `token_scope`, not `push_failure`.
    if (isWorkflowScopePushRefusal(pushResult.error.message)) {
      const reason = workflowScopePushRefusalMessage(pushResult.error.message);
      logger.error(reason);
      return { status: "failure", reason };
    }
    // Attempt push rejection recovery (Issue #423)
    logger.warn("Push failed, attempting recovery");
    const recoveryResult = await deps.git.recoverFromPushRejection(
      state.branchName,
      {
        cwd: state.repoPath,
      },
      pushResult.error.message,
    );
    if (!recoveryResult.ok) {
      return {
        status: "failure",
        // Issue #1550: include "Git push failed" so detectFailureCategory
        // classifies this as `push_failure` (infrastructure) and the infra
        // retry wrapper fires.
        reason:
          `Git push failed and recovery unsuccessful: ${recoveryResult.error.message}`,
      };
    }

    // Retry push after recovery
    const retryPush = await deps.git.pushUnpushedCommits(state.branchName, {
      cwd: state.repoPath,
    });
    if (!retryPush.ok) {
      return {
        status: "failure",
        reason: `Git push failed after recovery: ${retryPush.error.message}`,
      };
    }
  }

  // Pre-flight: branch must have at least one commit ahead of the PR base
  // before we attempt `gh pr create`. Without this guard, an empty branch
  // (zero commits ahead) reaches `gh pr create` and surfaces as the opaque
  // "GraphQL: No commits between <base> and <branch>" error — diagnosed in
  // production as Issue #1463 (pushUnpushedCommits side, fixed in #1592)
  // and again on private-repo-22#42 from another path. Bail out here with a
  // clear, diagnostic failure so the worker reports an actionable cause
  // instead of a misleading PR-creation error.
  // Issue #68: the ahead-count runs against a LOCAL ref, but a milestone base
  // is present in this clone only as `origin/<base>` — the clone was set up on
  // the issue branch from the remote milestone, so the bare name is an unknown
  // revision and `rev-list` failed on every milestone PR, taking the "could
  // not run" path silently each time. Resolve it (local → origin/<base>, with a
  // fetch only when the remote-tracking ref is absent). `baseBranch` (the bare
  // name) stays correct for the milestone footer and `gh pr create --base`,
  // which GitHub resolves server-side.
  // Issue #174: the count is read again at the PR-linking decision below,
  // where it is what separates "a merged PR completes this issue" from
  // "a merged PR merely mentions it while our commits sit unpublished".
  // `null` means the guard could not run — never silently zero.
  let branchCommitsAhead: number | null = null;
  const comparableBase = await resolveComparableBaseRef(
    deps.git.runGitCommand,
    baseBranch,
    { cwd: state.repoPath },
  );
  if (!comparableBase.ok) {
    // The guard genuinely cannot run — a base that resolves to nothing local,
    // remote, or fetchable. Louder than the per-PR warning (Issue #68): this
    // line is the diagnostic of record for the empty-branch PR failure it
    // exists to pre-empt, so it must not be routine noise.
    logger.error(
      "Ahead-of-base guard could not run — base ref unresolvable; " +
        "proceeding to PR creation without it",
      { baseBranch, error: comparableBase.error.message },
    );
  } else {
    // Count against the ref that will actually be pushed and named to
    // `gh pr create --head` — the worker branch — not HEAD (Issue #4286);
    // after the reconciliation above they agree, and this keeps the guard
    // honest if they ever do not.
    const aheadCountResult = await deps.git.runGitCommand(
      ["rev-list", "--count", `${comparableBase.value}..${state.branchName}`],
      { cwd: state.repoPath },
    );
    if (!aheadCountResult.ok || aheadCountResult.value.code !== 0) {
      // A guard that cannot run must say so (Issue #4286): the old code
      // parsed "" to NaN and proceeded silently.
      logger.warn(
        "Ahead-of-base guard could not run — proceeding to PR creation without it",
        {
          error: aheadCountResult.ok
            ? aheadCountResult.value.stderr.trim() ||
              `exit ${aheadCountResult.value.code}`
            : aheadCountResult.error.message,
        },
      );
    }
    if (aheadCountResult.ok && aheadCountResult.value.code === 0) {
      const aheadCount = parseInt(aheadCountResult.value.stdout.trim(), 10);
      if (Number.isFinite(aheadCount)) branchCommitsAhead = aheadCount;
      if (Number.isFinite(aheadCount) && aheadCount > 0) {
        const halfDone = await detectHalfDoneWipBranch(
          state,
          deps,
          comparableBase.value,
        );
        if (halfDone) return { status: "failure", reason: halfDone };
      }
      if (Number.isFinite(aheadCount) && aheadCount === 0) {
        // Issue #218: this used to describe the loss and stop — "uncommitted
        // changes are present … Claude likely modified files but did not
        // commit them" — while discarding exactly those changes. Preserve
        // them onto the claim-locked branch first, so the next claim resumes
        // the work instead of starting from zero. The commit carries the
        // `wip:` prefix, so the #148 WIP-only gate still refuses to build a
        // "finished" PR out of it.
        const wip = await preserveRunWip({
          state,
          deps,
          issueNumber,
          repo,
          buildMessage: (dirtyFiles) =>
            buildUncommittedWorkWipCommitMessage({ dirtyFiles }),
        });

        // The branch can be level with base because a sibling's PR merged
        // this issue's work mid-run (VibeCoder#185). That is not a failure of
        // this run: stop with `superseded:pr#N` rather than an `unknown`
        // no-PR failure that labels the issue and files a run-failure issue.
        const disposition = await classifyExistingPrForIssue(
          repo,
          issueNumber,
          {
            findExistingPrForIssue: deps.pr.findExistingPrForIssue,
            runGhCommand: deps.github.runGhCommand,
            warn: (m: string) => logger.warn(m),
          },
        );
        if (disposition.kind === "superseded") {
          logger.warn(
            `Branch '${state.branchName}' is level with '${baseBranch}' ` +
              `because ${
                disposition.prState === "MERGED" ? "merged" : "closed"
              } PR #${disposition.prNumber} already resolved this issue — ` +
              `releasing as superseded (Issue #218)`,
            {
              prUrl: disposition.prUrl,
              ...(wip.wipNote ? { wip: wip.wipNote } : {}),
            },
          );
          return {
            status: "early_exit",
            reason: formatSupersededReason(disposition, wip.wipNote),
            outcome: supersededOutcome({
              phase: "completion",
              prUrl: disposition.prUrl,
              prNumber: disposition.prNumber,
              prState: disposition.prState,
              ...(wip.wipNote ? { wipNote: wip.wipNote } : {}),
            }),
          };
        }

        // A dirty tree always yields a note (preserved, already checkpointed,
        // or preservation failed), so the diagnostic now says what happened
        // to the work as well as that it existed.
        const wipHint = wip.dirtyFiles > 0
          ? ` — ${wip.dirtyFiles} file(s) carried uncommitted changes; ` +
            `${wip.wipNote}`
          : wip.wipNote
          ? ` — ${wip.wipNote}`
          : "";
        return {
          status: "failure",
          reason:
            `Branch \`${state.branchName}\` has no commits ahead of \`${baseBranch}\` — cannot create PR${wipHint}`,
        };
      }
    }
  }

  // Build PR body before idempotency checks so recovery can update it (Issue #1189)
  // The issue title is attacker-supplied, so issue-reference syntax is
  // scrubbed out of it before the worker's own authoritative `(Issue #N)`
  // suffix is appended (Issue #1248) — an unscrubbed `[#999]` made this
  // fleet-authored title "reference" #999 for every title matcher, and a
  // merged PR blocks permanently (Issue #3151).
  const prTitle = buildPrTitle(issueTitle, issueNumber);
  let prBody: string;

  // Changed files feed the screenshot gate below and the branch-evidence
  // section (Issue #4355), so they are resolved before the body is built.
  // Issue #2147: the list is the branch's own changes, so it is diffed
  // against the same resolved base as the ahead-of-base guard — the branch's
  // real base (a milestone branch, not always the default branch), as origin
  // has it. It used to diff against the local default branch, which a run
  // never updates: on GRQ-AutoTrader#463 a stale local Develop made a
  // 12-file Rust change read as 62 files including web/*.tsx, and the
  // screenshot gate failed the run.
  let changedFiles: string[] = [];
  const diffResult = comparableBase.ok
    ? await deps.git.runGitCommand(
      ["diff", "--name-only", `${comparableBase.value}...HEAD`],
      { cwd: state.repoPath },
    )
    : comparableBase;
  if (diffResult.ok && diffResult.value.code === 0) {
    changedFiles = diffResult.value.stdout.trim().split("\n").filter((f) =>
      f.length > 0
    );
  } else {
    logger.warn("Could not determine changed files for screenshot validation");
  }

  // Issue #2300: a UI file whose only change is a version stamp — the
  // cache-busting bump GRQ-health's update_version.sh writes into
  // index.html, sw.js and dashboard.js on every change — is not a UI
  // change. Each such file's own patch is read against the same base, and
  // one that reads as a bump is set aside from the gate's triggers.
  const versionBumpOnlyFiles: string[] = [];
  if (comparableBase.ok) {
    for (const file of changedFiles.filter(isUiSourceFile)) {
      const patch = await deps.git.runGitCommand(
        ["diff", "--unified=0", `${comparableBase.value}...HEAD`, "--", file],
        { cwd: state.repoPath },
      );
      if (
        patch.ok && patch.value.code === 0 &&
        isVersionBumpOnly(patch.value.stdout)
      ) {
        versionBumpOnlyFiles.push(file);
      }
    }
    if (versionBumpOnlyFiles.length > 0) {
      logger.info(
        "UI files changed only by a version bump are not counted as a UI change (Issue #2300)",
        { files: versionBumpOnlyFiles },
      );
    }
  }

  const summaryResult = await loadPrSummary(state.repoPath, issueNumber);
  if (summaryResult.ok && summaryResult.value.content) {
    logger.info("Loaded PR summary file", {
      source: summaryResult.value.source,
    });
    prBody = summaryResult.value.content + "\n\n";
  } else {
    if (!summaryResult.ok) {
      logger.warn("Error reading PR summary file", {
        error: summaryResult.error.message,
      });
    } else {
      logger.warn("No PR summary file found, using minimal body");
    }
    prBody = `## Summary\n\nCloses #${issueNumber}.\n\n`;
  }

  // Screenshots the agent committed to docs/evidence/ but did not reference
  // in the summary (a WIP-resumed run keeps the earlier summary — Issue
  // #4355) are referenced here, so the evidence renders in the PR and the
  // gate below sees it. The relative paths go through the same repair and
  // raw-URL conversion as authored references.
  const branchEvidence = findBranchEvidenceImages(changedFiles);
  if (
    branchEvidence.length > 0 && findScreenshotReferences(prBody).length === 0
  ) {
    logger.info("Referencing branch evidence images not named in the summary", {
      images: branchEvidence,
    });
    prBody += formatBranchEvidenceSection(branchEvidence);
  }

  if (milestoneTitle && state.milestoneBranch) {
    prBody += buildMilestonePrSection({
      milestoneTitle,
      milestoneBranch: state.milestoneBranch,
      baseBranch,
    });
  }

  // Issue #1775: a milestone child run skips the dependency bump, so the PR
  // says so rather than leaving a reviewer to wonder why the lockfile is
  // untouched. Empty for every other bump outcome.
  prBody += buildBumpSkipNote(state.bumpInfo);

  // Worker footer for multi-worker visibility (Issue #1190)
  prBody += buildWorkerFooter({
    workerName: config.workerName,
    githubUser,
    runId: getRunId(),
  });
  prBody += buildIdempotencyMarker(issueNumber);
  prBody = deps.pr.ensurePrReferencesIssue(prBody, issueNumber);

  // Issue #2985: Make evidence image links render in the PR description.
  //
  // GitHub does not resolve relative image paths in PR bodies, so an
  // `![alt](docs/evidence/foo.png)` reference renders as a broken image even
  // though the same markdown renders in a committed file. First repair any
  // broken relative path to a real on-disk file (soft gate, Issue #2230), then
  // rewrite in-repo evidence images to commit-pinned raw URLs. Both steps are
  // best-effort — warnings are logged but never block PR creation.
  const imageResolution = await resolveImagePaths(prBody, state.repoPath);
  prBody = imageResolution.body;
  for (const rewrite of imageResolution.rewrites) {
    logger.info("Repaired evidence image path", {
      from: rewrite.from,
      to: rewrite.to,
    });
  }
  for (const warning of imageResolution.warnings) {
    logger.warn("Could not resolve evidence image path", {
      path: warning.path,
      reason: warning.reason,
    });
  }

  const headShaResult = await deps.git.runGitCommand(
    ["rev-parse", "HEAD"],
    { cwd: state.repoPath },
  );
  const headSha = headShaResult.ok ? headShaResult.value.stdout.trim() : "";
  if (headSha) {
    const conversion = await convertEvidenceImagesToRawUrls(prBody, {
      repoPath: state.repoPath,
      githubRepo: repo,
      commitSha: headSha,
    });
    prBody = conversion.content;
    for (const converted of conversion.conversions) {
      logger.info("Converted evidence image to raw URL", {
        from: converted.from,
        to: converted.to,
      });
    }
  } else {
    logger.warn(
      "Could not resolve HEAD SHA — evidence images left as relative paths",
    );
  }

  // Issue #1185: Screenshot validation before PR creation
  const skipScreenshot =
    getRepoConfig(config.repoConfig, repo, "skipScreenshotCheck") === "true";

  const screenshotResult = validateScreenshotEvidence({
    prSummaryContent: prBody,
    issueLabels: ctx.issueLabels.join(","),
    changedFiles,
    repo,
    issueNumber,
    skipScreenshotCheck: skipScreenshot,
    versionBumpOnlyFiles,
  });

  const needsScreenshotLabel = LABEL_DEFAULTS.needsScreenshotLabel;
  if (!screenshotResult.valid) {
    logger.info("Screenshot validation failed — UI change without evidence");

    await deps.github.ensureLabelExists(
      repo,
      needsScreenshotLabel,
      "d93f0b",
      "Previous attempt was blocked for missing screenshot evidence",
    );

    const client = deps.github.createClient(logger);
    await client.addLabel(repo, issueNumber, needsScreenshotLabel);
    await client.postComment(
      repo,
      issueNumber,
      screenshotResult.failureMessage!,
    );

    return {
      status: "failure",
      reason: "Screenshot evidence missing for UI-related change",
    };
  }

  // Remove needs-screenshot label if validation passed and label was present
  if (
    screenshotResult.isUiChange &&
    ctx.issueLabels.includes(needsScreenshotLabel)
  ) {
    try {
      const client = deps.github.createClient(logger);
      await client.removeLabel(repo, issueNumber, needsScreenshotLabel);
    } catch {
      logger.warn("Failed to remove needs-screenshot label (non-fatal)");
    }
  }

  // The label list every gate below reads, as one comma-joined string.
  const issueLabels = ctx.issueLabels.join(",");

  // ---------------------------------------------------------------------
  // Security-fix patch-verification gate (Issue #3540, hardened by #3652,
  // wired into this live phase by #3939).
  //
  // A PR that closes a `security`-labelled finding (or references a
  // `SEC-<hex>` finding id) must demonstrate that the fault is genuinely
  // closed. The decisive evidence is machine-checkable against the branch
  // diff — a test file is changed, and the test identifier the summary names
  // really appears in that diff — with the prose linkage kept as a secondary
  // human-review aid. Fail loud rather than mask a fault as success (Issue
  // #3234). Per-repo only (Issue #3239); opt out with the
  // `skip_security_fix_check` repo config.
  //
  // It runs **first** of the five PR gates (Issue #1140). The three summary
  // gates below stop being a hard failure once the run has raised its PR, and
  // a `security` run whose summary also broke a format rule would otherwise
  // leave through the first of those and never be asked for its
  // vulnerability-fix evidence. Order is the guard: nothing downgrades a
  // block this gate has not already had its say on.
  // ---------------------------------------------------------------------
  const skipSecurityFixCheck =
    getRepoConfig(config.repoConfig, repo, "skipSecurityFixCheck") === "true";

  if (!skipSecurityFixCheck) {
    // Only pay for a diff when the gate is actually active.
    const gateActive = hasSecurityLabel(issueLabels) ||
      referencesFindingId(prBody);
    const securityDiff = gateActive
      ? await collectSecurityFixDiff(
        (gitArgs) => runGitOrThrow(gitArgs, state.repoPath, deps),
        baseBranch,
      )
      : null;
    if (gateActive && !securityDiff) {
      logger.warn("Could not collect branch diff for security-fix gate", {
        base: baseBranch,
      });
    }

    const securityGate = evaluateSecurityFixGate({
      prSummaryContent: prBody,
      issueLabels,
      diff: securityDiff,
    });
    // The verdict is carried in worker run state so the next attempt reads it
    // from a trusted channel (Issue #4057). The gate's issue comment cannot
    // serve: it is authored by the service account, which the retry's comment
    // trust filter classifies UNTRUSTED, so ten runs on #4030 started blind.
    const gateStateDir = resolveSecurityGateStateDir(config.workDir);

    if (securityGate.isSecurityFix && !securityGate.ok) {
      // The declarations the gate matched (Issue #1575) — a
      // `test-identifier-in-diff` block that cannot say what it did see reads
      // exactly like the false block that cost #1385 three runs.
      const declarations = matchedTestDeclarations(
        securityDiff?.testDiffText ?? "",
      );
      logger.warn("Security-fix verification gate blocked PR creation", {
        missing: securityGate.missing,
        matchedDeclarations: declarations.length,
      });
      // The verdict is reported on run state; the wrapper decides whether it
      // is recoverable in-run (first block) or ends the run (second), and
      // owns the persistence, the comment and any escalation (Issue #1575).
      state.securityGateBlocks = [
        ...(state.securityGateBlocks ?? []),
        { missing: securityGate.missing, declarations },
      ];
      return {
        status: "failure",
        reason: buildSecurityFixGateMessage(securityGate.missing, declarations),
      };
    }

    // Gate satisfied (or inactive) — drop any stale verdict so a later run on
    // this issue is not told to fix something it has already fixed.
    await clearSecurityFixGateBlock(gateStateDir, repo, issueNumber);
  }

  // ---------------------------------------------------------------------
  // Changed-workflow file-check gate (Issue #1859, split out of #1755).
  //
  // #1755 hardens the provisioning path by construction only — templates,
  // filing-time pin resolution and a prompt rule, all of them instructions an
  // LLM run follows rather than a gate. A run that embellishes what it was
  // given, or writes a workflow no template produces, still ships a file the
  // `github-actions-audit` idle task files a finding against days later, in a
  // repository the fleet does not own. `WORKFLOW_FILE_CHECKS` decides entirely
  // from the file text, so the same checks run here on the branch diff in
  // milliseconds.
  //
  // Only the workflow files this run added or changed are in scope, and within
  // those only the findings absent from the base commit's version of the same
  // file (Issue #2043): a pre-existing offender is the audit's business, not
  // this PR's, whether or not the run happened to touch its file. Like the
  // security gate above and unlike the three summary gates below, a finding is
  // a defect in the change rather than a documentation shortfall, so it stops
  // the run whether or not a PR already exists.
  // ---------------------------------------------------------------------
  if (!comparableBase.ok) {
    // No ref this clone can diff against — the same condition the ahead-of-base
    // guard above already reported. Blocking here would fail every run on such
    // a clone, including the ones that touch no workflow at all, so the gate
    // stands down and says so at ERROR rather than passing quietly.
    logger.error(
      "Changed-workflow file checks did not run — base ref unresolvable, " +
        "so the branch diff cannot be collected",
      { baseBranch, error: comparableBase.error.message },
    );
  } else {
    const workflowGate = await evaluateChangedWorkflowGate({
      // The trigger check decides against the repository's default branch,
      // whatever this PR's base happens to be.
      defaultBranch: state.defaultBranch,
      deps: {
        listChangedFiles: async () => {
          // Resolved above: the local branch, else `origin/<base>`.
          const base = comparableBase.value;
          // `runGitOrThrow` is the phase's existing adapter: it turns both a
          // failed spawn and a non-zero exit into a throw, which is what
          // stops an unreadable diff reading as "nothing changed".
          const stdout = await runGitOrThrow(
            // Deletions excluded: a removed workflow has no text to check, and
            // its absence must not read as an unreadable file.
            ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`],
            state.repoPath,
            deps,
          );
          return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        },
        readFile: (path) => Deno.readTextFile(`${state.repoPath}/${path}`),
        // The baseline (Issue #2043): a finding already on the base commit is
        // the repository's, not this run's, even in a file the run touched.
        readBaseFile: async (path) => {
          const base = comparableBase.value;
          // `ls-tree` exits zero with empty output when the path is absent at
          // base, which separates "the run added this file" from a read that
          // genuinely failed — `git show` alone conflates the two.
          const listed = await runGitOrThrow(
            ["ls-tree", "--name-only", base, "--", path],
            state.repoPath,
            deps,
          );
          if (listed.trim() === "") return null;
          return await runGitOrThrow(
            ["show", `${base}:${path}`],
            state.repoPath,
            deps,
          );
        },
      },
    });

    if (!workflowGate.ok) {
      // The gate runs whether or not a PR already exists, so the run's own
      // head may carry one the agent raised from inside the execute phase
      // (Issue #2044). Which world this is decides what the comment says and
      // what the outcome records — told "no PR was raised" over an open PR, a
      // human read a delivered run as having delivered nothing.
      const blockedPr = await lookupBlockedGatePr(
        repo,
        state.branchName,
        deps,
      );
      const message = buildChangedWorkflowGateMessage(
        workflowGate,
        blockedPr,
      );
      logger.warn("Changed-workflow file checks blocked PR creation", {
        files: workflowGate.scannedFiles,
        findings: workflowGate.findings.length,
        errors: workflowGate.errors.length,
        ...(blockedPr ? { prNumber: blockedPr.number } : {}),
      });
      try {
        await deps.github.createClient(logger).postComment(
          repo,
          issueNumber,
          message,
        );
      } catch (err) {
        // The comment is the next run's brief, not the verdict — losing it
        // must not turn a block into a pass, so it is logged and the failure
        // stands.
        logger.warn("Could not post the changed-workflow gate comment", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (blockedPr) {
        // The run still fails — the finding is a defect in the change, not a
        // documentation shortfall — but the outcome names the PR the work is
        // on, so the archive reads "delivered, one finding outstanding"
        // rather than "delivered nothing" (Issue #2044). `deriveRunOutcome`
        // turns these two fields plus the failed result into a `pr` outcome
        // carrying the diagnosed category of the block.
        state.prUrl = blockedPr.url;
        state.prNumber = blockedPr.number;
      }
      return { status: "failure", reason: message };
    }
  }

  // ---------------------------------------------------------------------
  // Acceptance-criteria closure gate (Issue #518).
  //
  // The planner writes a `## Acceptance Criteria` checklist into every
  // sub-issue and nothing used to read it back. When the issue carries
  // criteria, the summary must close each one out as met / partial / missing
  // with the evidence observed, and explain every gap — an unexplained gap is
  // a failure to surface, not a pass. Issues with no criteria are unaffected.
  // ---------------------------------------------------------------------
  const closure = validateAcceptanceClosure({
    issueBody: ctx.issueBody,
    prSummaryContent: prBody,
  });
  if (closure.applicable && !closure.valid) {
    logger.warn("Acceptance-criteria closure gate blocked PR creation", {
      criteria: closure.criteria.length,
      problems: closure.problems,
    });
    return await reportSummaryRuleBlock(
      `Acceptance criteria not closed out in the PR summary: ${
        closure.problems[0] ?? "closure block missing"
      }`,
      buildClosureGateComment(closure),
      ctx,
      state,
      prBody,
      deps,
    );
  }

  // ---------------------------------------------------------------------
  // Independent two-axis review gate (Issue #663).
  //
  // The closure block above says which criteria were met; this says who
  // judged them. A verdict written by the agent that wrote the code, in the
  // context that produced it, is not a review — so the criteria block must
  // carry the independent Spec reviewer's provenance and its per-entry
  // verdict, with any departure from that verdict recorded out loud. The
  // Standards axis is reported under its own heading: a change can pass one
  // axis and fail the other, and merging them lets one mask the other.
  // Issues with no criteria are unaffected.
  // ---------------------------------------------------------------------
  const review = validateIndependentReview({
    issueBody: ctx.issueBody,
    prSummaryContent: prBody,
  });
  if (review.applicable && !review.valid) {
    logger.warn("Independent two-axis review gate blocked PR creation", {
      specEntries: review.specEntries.length,
      standardsEntries: review.standardsEntries.length,
      problems: review.problems,
    });
    return await reportSummaryRuleBlock(
      `Independent Spec/Standards review not reported in the PR summary: ${
        review.problems[0] ?? "review blocks missing"
      }`,
      buildIndependentReviewComment(review),
      ctx,
      state,
      prBody,
      deps,
    );
  }

  // ---------------------------------------------------------------------
  // Bug-fix reproduction-status gate (Issue #521).
  //
  // `bug` is a descriptive label on the one shared pipeline, so a summary
  // claiming "added a regression test" used to read identically whether the
  // test was watched to fail before the fix or merely written afterwards. A
  // bug-labelled issue must now record the symptom, the reproduction status as
  // verified / partial / not-run, and the covering regression test — with
  // `verified` reserved for a test actually observed failing before and passing
  // after. A not-run reproduction is a legitimate, reportable outcome; the
  // silent over-claim is what is blocked. Non-`bug` issues are unaffected.
  // ---------------------------------------------------------------------
  const reproduction = validateReproductionStatus({
    issueLabels,
    prSummaryContent: prBody,
  });
  if (reproduction.applicable && !reproduction.valid) {
    logger.warn("Reproduction-status gate blocked PR creation", {
      status: reproduction.block.status,
      problems: reproduction.problems,
    });
    return await reportSummaryRuleBlock(
      `Reproduction status not recorded in the PR summary: ${
        reproduction.problems[0] ?? "`## Reproduction` block missing"
      }`,
      buildReproductionGateComment(reproduction),
      ctx,
      state,
      prBody,
      deps,
    );
  }

  // ---------------------------------------------------------------------
  // Degraded-run delivery guard (Issue #2562).
  //
  // A run served by a fallback model must not read as complete delivery: on
  // #2543 a Haiku-fallback run shipped one of seven accepted changes and its
  // PR closed the issue with the rest recorded nowhere. The PR is still raised
  // (the work is kept, and a PR that does not close its issue loops — #520),
  // but every accepted scope item not shown `met` is filed as an `idle-task`
  // follow-up the fleet picks up, and the PR body names the gap. A healthy
  // run, or a degraded one that met everything, is untouched.
  // ---------------------------------------------------------------------
  const degradedDelivery = assessDegradedDelivery({
    claudeResults: state.claudeRunStats ?? [],
    issueBody: ctx.issueBody,
    prBody,
  });
  if (degradedDelivery.shortfalls.length > 0) {
    const labelled = await deps.github.ensureLabelExists(
      repo,
      IDLE_TASK_LABEL,
    );
    if (!labelled.ok) {
      logger.warn(
        "Could not ensure the idle-task label for the degraded-run follow-up; filing anyway",
        { error: labelled.error.message },
      );
    }
    const followUp = await fileDegradedFollowUp({
      repo,
      parentNumber: issueNumber,
      parentTitle: issueTitle,
      verdict: degradedDelivery,
      runId: getRunId(),
      gh: deps.github.runGhCommand,
      dedupAuthors: { fleetAuthors: fleetAuthorsFor(ctx) },
    });
    if (!followUp.ok) {
      // Raising the PR now would close the issue with the residue recorded
      // nowhere — the exact silent loss this guard exists to stop.
      logger.error(
        "Degraded run: could not file the follow-up for its undelivered scope — no PR raised",
        { error: followUp.error.message },
      );
      return {
        status: "failure",
        reason:
          `Degraded run (${degradedDelivery.reason}) left ${degradedDelivery.shortfalls.length} ` +
          `accepted scope item(s) short of met, and the follow-up recording them ` +
          `could not be filed: ${followUp.error.message}`,
      };
    }
    logger.warn(
      "Degraded run delivered partial scope — residue recorded in a follow-up",
      {
        reason: degradedDelivery.reason,
        shortfalls: degradedDelivery.shortfalls.length,
        followUp: followUp.value.number,
        reused: followUp.value.reused,
      },
    );
    prBody = buildDegradedPrSection(degradedDelivery, followUp.value.number) +
      prBody;
  }

  // Issue #869 (by issue number), #623 (by branch), #872 (defence in depth),
  // and Issue #174, which reordered them.
  //
  // The old order asked "is there any PR for this issue?" first, and a
  // merged PR answered yes. On VibeCoder#42 that was a human's partial PR,
  // merged mid-run: the worker logged `IDEMPOTENT: PR already exists`,
  // closed the issue against #173 and released three unpublished commits.
  // A merged or closed PR is never the PR for commits this run just pushed,
  // so the branch is consulted first and the decision is made explicitly.
  const openPrForBranch = await deps.pr.findExistingPrForBranch(
    repo,
    state.branchName,
  );
  let prForIssueResult = await deps.pr.findExistingPrForIssue(
    repo,
    issueNumber,
  );
  // Issue #872: defence in depth. A transient miss on both lookups must not
  // send the run down the creation path when a PR really does exist, so the
  // issue-number lookup gets one retry. Reordering for #174 must not cost
  // this — it is the guard against a duplicate PR, not against lost work.
  if (!openPrForBranch.ok && !prForIssueResult.ok) {
    prForIssueResult = await deps.pr.findExistingPrForIssue(repo, issueNumber);
  }

  let prForIssue: LinkedPr | null = null;
  if (prForIssueResult.ok) {
    const url = prForIssueResult.value;
    const numMatch = url.match(/\/pull\/(\d+)/);
    const num = numMatch ? parseInt(numMatch[1]!, 10) : 0;
    const looked = await lookupPrState(repo, num, deps);
    const rawState = looked?.state?.toUpperCase();
    // An unreadable state is treated as OPEN: that is the pre-#174
    // behaviour (recover it), and the close is guarded separately by
    // provenance, so a `gh` hiccup cannot turn into a lost branch.
    prForIssue = {
      url,
      state: rawState === "MERGED" || rawState === "CLOSED" ? rawState : "OPEN",
      // Issue #1799: the head decides whether an open linked PR is ours.
      headRefName: looked?.headRefName ?? null,
    };
  }

  const linkDecision = decideCompletionPr({
    openPrForBranch: openPrForBranch.ok ? openPrForBranch.value : null,
    branchCommitsAhead,
    prForIssue,
    runBranch: state.branchName,
  });

  if (linkDecision.kind === "recover") {
    logger.info(
      "IDEMPOTENT: recovering the PR for this run, skipping creation",
      {
        prUrl: linkDecision.prUrl,
        branch: state.branchName,
        why: linkDecision.why,
      },
    );
    return await recoverAndFinaliseExistingPr(
      linkDecision.prUrl,
      ctx,
      state,
      prBody,
      deps,
    );
  }

  // ---------------------------------------------------------------------
  // Claim-freshness re-check (Issue #344) — the last thing before creation.
  //
  // The claim was legitimate when it was taken; the question here is whether
  // it still is. On VibeCoder#333 it was not: the issue closed at 07:57:54Z
  // and this phase opened PR #341 against it at 08:15:06Z, a CONFLICTING
  // duplicate of work already on `main`. The lookups above answer "what PR
  // exists"; none of them asks "is the issue still open".
  // ---------------------------------------------------------------------
  const freshness = await checkClaimFreshness({
    repo,
    issueNumber,
    runBranch: state.branchName,
    mode: "pre-pr",
    deps: {
      findExistingPrForIssue: deps.pr.findExistingPrForIssue,
      runGhCommand: deps.github.runGhCommand,
      warn: (m: string) => logger.warn(m),
    },
  });
  if (freshness.kind === "stale") {
    return await abortStaleClaim(freshness, ctx, state, deps);
  }

  // Opening a PR for this branch even though something else references the
  // issue is the Issue #174 behaviour, so say why at INFO — the silence is
  // what made the original loss invisible.
  logger.info("Opening a PR for this run's branch", {
    branch: state.branchName,
    why: linkDecision.why,
  });

  // Create PR via gh CLI
  const createPrArgs = [
    "pr",
    "create",
    "--title",
    prTitle,
    "--body",
    prBody,
    "--base",
    baseBranch,
    "--head",
    state.branchName,
    "--repo",
    repo,
  ];

  // Add reviewers if configured. Issue #2438: a PR into a milestone branch
  // asks for none — nothing waits on that review, because the `milestone/**`
  // ruleset requires status checks only and the review that matters sits on
  // the milestone → default-branch PR.
  const prReviewers = reviewersForBase(baseBranch, config.prReviewers);
  for (const reviewer of prReviewers) {
    createPrArgs.push("--reviewer", reviewer);
  }

  // Issue #1951: GitHub's *secondary* (content-creation) rate limit refuses
  // the create for minutes, and `runGhCommand`'s generic 2s/4s/8s retry is
  // spent long before it clears. Wait it out in minutes instead — and when it
  // outlasts the run's own budget, park the PR rather than throwing finished,
  // pushed work away as a failure.
  const prDeadlineMs = prCreationDeadlineMs(ctx);
  const attempt = await createPrWithSecondaryLimitBackoff({
    createPr: () => deps.github.runGhCommand(createPrArgs),
    ...(prDeadlineMs !== undefined ? { deadlineMs: prDeadlineMs } : {}),
    onRefusal: (n, message) =>
      recordPrCreationRefusal(config.workDir, n, message, logger),
    onSuccess: () => resetPrCreationBreaker(config.workDir, logger),
    log: (message, fields) => logger.warn(message, fields),
  });
  if (attempt.kind === "deferred") {
    return await deferPrCreation(attempt, ctx, state, deps, {
      title: prTitle,
      body: prBody,
      base: baseBranch,
      reviewers: prReviewers,
    });
  }

  let prUrl: string;
  // The REST path clears its own milestone review requests (Issue #2438), so
  // the clear below runs only for a PR `gh pr create` opened — exactly once
  // either way.
  let clearedDuringCreate = false;
  try {
    if (attempt.kind === "failed") throw attempt.error;
    prUrl = attempt.prUrl;
    // Issue #3138: stamp the worker build on the PR-open line so a duplicate
    // PR can be traced back to the exact build that raised it.
    logger.info("PR created", {
      prUrl,
      build: formatBuildStamp(resolveWorkerBuildInfo()),
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Issue #42: `gh pr create` is GraphQL-backed, so an exhausted primary
    // GraphQL quota used to discard finished, quality-gated, already-pushed
    // work — branch pushed, no PR, issue left assigned. The REST `pulls`
    // endpoint rides the separate core quota, which is typically still
    // healthy, so fall back to it rather than losing the run. This also
    // catches the latch's own skip message, which carries the same phrase.
    const restUrl = isPrimaryRateLimitMessage(errorMsg)
      ? await createPrViaRestFallback(
        ctx,
        state,
        deps,
        { title: prTitle, body: prBody, base: baseBranch },
      )
      : null;
    if (restUrl !== null) {
      prUrl = restUrl;
      clearedDuringCreate = true;
    } else {
      // Self-healing: detect existing PR after creation failure (Issue #386, #1189)
      const existingPrFromError = await deps.pr.findExistingPrForIssue(
        repo,
        issueNumber,
      );
      if (existingPrFromError.ok) {
        logger.info("Found existing PR after creation error, recovering", {
          prUrl: existingPrFromError.value,
        });
        return await recoverAndFinaliseExistingPr(
          existingPrFromError.value,
          ctx,
          state,
          prBody,
          deps,
        );
      } else if (isSecondaryRateLimitMessage(errorMsg)) {
        // The latch's own cool-down names both limits (Issue #1456), so it
        // takes the REST fallback above rather than the minute-scale wait.
        // Reaching here means REST could not open it either, and the throttle
        // is still the reason — so the PR is parked, not the run failed
        // (Issue #1951).
        return await deferPrCreation(
          {
            attempts: attempt.attempts,
            waitedMs: 0,
            message: errorMsg,
            why: "the REST fallback could not open it either",
          },
          ctx,
          state,
          deps,
          {
            title: prTitle,
            body: prBody,
            base: baseBranch,
            reviewers: prReviewers,
          },
        );
      } else {
        return { status: "failure", reason: `PR creation failed: ${errorMsg}` };
      }
    }
  }

  // Extract PR number from URL for API calls
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1]!, 10) : 0;
  // The run outcome names this PR at claim release (Issue #4325).
  state.prUrl = prUrl;
  state.prNumber = prNumber;

  // Issue #2438: CODEOWNERS auto-requests a review the moment the PR opens,
  // and nothing acts on it when the base is a milestone branch. Remove it
  // once, here, right after creation — a no-op for every other base.
  if (!clearedDuringCreate) {
    await clearMilestoneReviewRequests({ repo, prNumber, base: baseBranch }, {
      ghCommandFn: deps.github.runGhCommand,
      log: (message: string) => logger.info(message),
      warn: (message: string) => logger.warn(message),
    });
  }

  // Post-PR finalisation
  try {
    // Link PR to issue
    await deps.pr.linkPrToIssue(repo, issueNumber, prUrl);

    // Close duplicate PRs
    // Issue #1264: name the fleet authors and opt out of the report-only
    // default — only the fleet's own duplicate on this branch is closed.
    await deps.pr.closeDuplicatePrs(repo, state.branchName, prUrl, undefined, {
      allowedAuthors: fleetAuthorsFor(ctx),
      dryRun: false,
    });

    // Retarget to milestone if applicable
    if (milestoneTitle && state.milestoneBranch && prNumber > 0) {
      await deps.pr.retargetPrToMilestone(
        repo,
        prNumber,
        state.milestoneBranch,
      );
    }

    // Arm auto-merge the moment the PR exists (Issue #1136). GitHub then
    // lands it as soon as its checks pass, with no cycle boundary to wait
    // for. The priority 1.65 sweep runs *before* the issue work that raises
    // PRs, so it structurally cannot see a PR this cycle created — leaving
    // arming to the sweep meant a green, unblocked PR sat open for up to an
    // hour, freezing every sibling issue the blocking guard defers to it.
    //
    // Issue #1125 skipped this for "milestone PRs". The PR raised here is a
    // milestone *child* — this run's branch into `milestone/**` — not the
    // summary PR into the default branch, which `milestone_completion.ts`
    // raises and `decideSummaryPrMerge` re-gates on open children at merge
    // time (Issue #3909). The sweep already merged these children, so the
    // skip only ever delayed them.
    if (prNumber > 0) {
      await armAutoMergeAtCreation(ctx, state, prNumber, deps);
    }

    // Issue #1613: Surface a rejected dependency bump on the PR thread
    // so reviewers can see what was attempted and why it was dropped.
    if (prNumber > 0 && state.bumpInfo) {
      const comment = buildBumpRejectionComment(state.bumpInfo);
      if (comment.length > 0) {
        try {
          const client = deps.github.createClient(logger);
          await client.postComment(repo, prNumber, comment);
        } catch (err) {
          logger.warn("Bump rejection comment failed (non-fatal)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Issue #2459: the rebase pass could not bring this branch forward, so say
    // so once — which paths diverged, and that the conflict ladder owns the PR
    // from here. Exactly one comment; the PR itself was raised regardless.
    await postBranchConflictComment({
      repo,
      prNumber,
      comment: branchConflictComment,
      postComment: (r, n, body) =>
        deps.github.createClient(logger).postComment(r, n, body),
      warn: (m: string) => logger.warn(m),
    });
  } catch (err) {
    // Post-PR finalisation is best-effort
    logger.warn("Post-PR finalisation error (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Unassign the worker from the source issue once the PR exists (Issue
  // #1453). Like the security gate above, this only ever ran in the module the
  // bash→Deno migration orphaned, so `unassign_on_pr_created` had no effect in
  // production (Issue #3939). Best-effort — never fails the phase.
  if (config.unassignOnPrCreated) {
    await unassignAfterPrCreated(repo, issueNumber, githubUser, {
      ghCommandFn: deps.github.runGhCommand,
      logger,
    });
  }

  return { status: "continue" };
}
