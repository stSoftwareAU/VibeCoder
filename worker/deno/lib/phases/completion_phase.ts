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

import type {
  IssueContext,
  PhaseResult,
  PhaseState,
} from "../issue_worker_types.ts";
import type { WorkerDeps } from "../issue_worker_wiring.ts";
import { LABEL_DEFAULTS } from "../config_defaults.ts";
import { buildWorkerFooter } from "../worker_identity.ts";
import { getRunId } from "../run_id.ts";
import { buildIdempotencyMarker, buildMilestonePrSection } from "../pr_body.ts";
import { resolveComparableBaseRef } from "../git_base_ref.ts";
import { isWipOnlyCommitLog } from "../wip_commit_marker.ts";
import { loadPrSummary } from "../pr_summary_loader.ts";
import { getRepoConfig } from "../repo_config.ts";
import {
  findBranchEvidenceImages,
  formatBranchEvidenceSection,
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
import { decideCompletionPr, type LinkedPr } from "../pr_run_provenance.ts";
import {
  ensureIssueClosedIfPrMerged,
  unassignAfterPrCreated,
} from "../issue_lifecycle.ts";
import { shouldRetryInfrastructureFailure } from "../infra_retry.ts";
import { createPullRequestViaRest } from "../pr_create_rest.ts";
import { isPrimaryRateLimitMessage } from "../primary_quota_latch.ts";
import { buildBumpRejectionComment } from "../bump_deps.ts";
import {
  formatBuildStamp,
  resolveWorkerBuildInfo,
} from "../worker_build_info.ts";
import { postIssueRunStatsComment } from "../issue_run_stats_comment.ts";
import {
  buildSecurityFixGateMessage,
  evaluateSecurityFixGate,
  hasSecurityLabel,
  referencesFindingId,
} from "../security_fix_gate.ts";
import { collectSecurityFixDiff } from "../security_fix_diff.ts";
import { preserveRunWip } from "./run_wip_preservation.ts";
import { buildUncommittedWorkWipCommitMessage } from "../wip_checkpoint.ts";
import {
  classifyExistingPrForIssue,
  formatSupersededReason,
} from "../superseding_pr.ts";
import { claimStaleOutcome, supersededOutcome } from "../run_outcome.ts";
import { healStaleBranchLineage } from "../stale_branch_lineage.ts";
import {
  checkClaimFreshness,
  type ClaimFreshness,
  formatStaleClaimComment,
  formatStaleClaimReason,
} from "../claim_freshness.ts";
import {
  clearSecurityFixGateBlock,
  recordSecurityFixGateBlock,
  resolveSecurityGateStateDir,
} from "../security_fix_gate_feedback.ts";

/**
 * Phase name the `work-on` coding run is routed under (`PHASE_MODEL_DEFAULTS`).
 * Drives both the stats heading and the expected-model routing chain.
 */
const WORK_ON_STATS_PHASE = "issue";

/**
 * Look up the state of an existing PR. Returns null when the state cannot be
 * determined (e.g. gh API error) — the caller should treat that as "unknown"
 * and preserve existing non-merged behaviour.
 */
async function lookupPrState(
  repo: string,
  prNumber: number,
  deps: WorkerDeps,
): Promise<string | null> {
  if (prNumber <= 0) return null;
  try {
    const output = await deps.github.runGhCommand([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state",
    ]);
    const parsed = JSON.parse(output) as { state?: string };
    return parsed.state ?? null;
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
  const prNumMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumMatch ? parseInt(prNumMatch[1]!, 10) : 0;
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
  const prState = await lookupPrState(repo, prNumber, deps);
  const prAlreadyMerged = prState === "MERGED";

  // Post-recovery finalisation (best-effort)
  try {
    // Skip the link comment when the PR is already merged — the issue is
    // about to be closed, so a "PR created" comment is pure noise.
    if (!prAlreadyMerged) {
      await deps.pr.linkPrToIssue(repo, issueNumber, prUrl);
    }
    await deps.pr.closeDuplicatePrs(repo, state.branchName, prUrl);

    if (milestoneTitle && state.milestoneBranch && prNumber > 0) {
      await deps.pr.retargetPrToMilestone(
        repo,
        prNumber,
        state.milestoneBranch,
      );
    }

    if (prNumber > 0) {
      const isMilestonePr = Boolean(milestoneTitle && state.milestoneBranch);
      await deps.pr.finalisePr({
        repo,
        prNumber,
        skipAutoMerge: isMilestonePr,
      });
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
  let result = await completionBody(ctx, state, deps);

  if (result.status === "failure") {
    const shouldRetry = await shouldRetryInfrastructureFailure(
      "completion",
      result.reason,
      state,
      deps.logger,
      { backoffMs: ctx.config.infraRetryBackoffMs },
    );
    if (shouldRetry) result = await completionBody(ctx, state, deps);
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
  await postIssueRunStatsComment({
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    phase: WORK_ON_STATS_PHASE,
    claudeResults,
    getIssueComments: (repo, issueNumber) =>
      client.getIssueComments(repo, issueNumber),
    postComment: (repo, issueNumber, body) =>
      client.postComment(repo, issueNumber, body),
    logger: deps.logger,
  });
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

  // Push branch
  const pushResult = await deps.git.pushUnpushedCommits(state.branchName, {
    cwd: state.repoPath,
  });
  if (!pushResult.ok) {
    // Attempt push rejection recovery (Issue #423)
    logger.warn("Push failed, attempting recovery");
    const recoveryResult = await deps.git.recoverFromPushRejection(
      state.branchName,
      {
        cwd: state.repoPath,
      },
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
  const prTitle = `${issueTitle} (Issue #${issueNumber})`;
  let prBody: string;

  // Changed files feed the screenshot gate below and the branch-evidence
  // section (Issue #4355), so they are resolved before the body is built.
  let changedFiles: string[] = [];
  const diffResult = await deps.git.runGitCommand(
    ["diff", "--name-only", `${state.defaultBranch}...HEAD`],
    { cwd: state.repoPath },
  );
  if (diffResult.ok) {
    changedFiles = diffResult.value.stdout.trim().split("\n").filter((f) =>
      f.length > 0
    );
  } else {
    logger.warn("Could not determine changed files for screenshot validation");
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
    const client = deps.github.createClient(logger);
    await client.postComment(
      repo,
      issueNumber,
      buildClosureGateComment(closure),
    );
    return {
      status: "failure",
      reason:
        `Acceptance criteria not closed out in the PR summary: ${
          closure.problems[0] ?? "closure block missing"
        }`,
    };
  }

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
  // ---------------------------------------------------------------------
  const issueLabels = ctx.issueLabels.join(",");
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
      logger.warn("Security-fix verification gate blocked PR creation", {
        missing: securityGate.missing,
      });
      try {
        const block = await recordSecurityFixGateBlock(
          gateStateDir,
          repo,
          issueNumber,
          securityGate.missing,
        );
        logger.info("Recorded security-fix gate verdict for the next attempt", {
          blockCount: block.blockCount,
        });
      } catch (err) {
        // Loud, but not fatal: the PR is blocked either way. A silent drop
        // here is what let the loop repeat, so it must reach the log.
        logger.warn(
          `Could not persist the security-fix gate verdict — the next attempt will start blind: ${
            (err as Error).message
          }`,
        );
      }
      const failureMessage = buildSecurityFixGateMessage(securityGate.missing);
      try {
        const client = deps.github.createClient(logger);
        await client.postComment(repo, issueNumber, failureMessage);
      } catch {
        logger.warn("Failed to post security-fix gate comment (non-fatal)");
      }
      return { status: "failure", reason: failureMessage };
    }

    // Gate satisfied (or inactive) — drop any stale verdict so a later run on
    // this issue is not told to fix something it has already fixed.
    await clearSecurityFixGateBlock(gateStateDir, repo, issueNumber);
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
    const rawState = (await lookupPrState(repo, num, deps))?.toUpperCase();
    // An unreadable state is treated as OPEN: that is the pre-#174
    // behaviour (recover it), and the close is guarded separately by
    // provenance, so a `gh` hiccup cannot turn into a lost branch.
    prForIssue = {
      url,
      state: rawState === "MERGED" || rawState === "CLOSED" ? rawState : "OPEN",
    };
  }

  const linkDecision = decideCompletionPr({
    openPrForBranch: openPrForBranch.ok ? openPrForBranch.value : null,
    branchCommitsAhead,
    prForIssue,
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

  // Add reviewers if configured
  if (config.prReviewers.length > 0) {
    for (const reviewer of config.prReviewers) {
      createPrArgs.push("--reviewer", reviewer);
    }
  }

  let prUrl: string;
  try {
    const output = await deps.github.runGhCommand(createPrArgs);
    prUrl = output.trim();
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

  // Post-PR finalisation
  try {
    // Link PR to issue
    await deps.pr.linkPrToIssue(repo, issueNumber, prUrl);

    // Close duplicate PRs
    await deps.pr.closeDuplicatePrs(repo, state.branchName, prUrl);

    // Retarget to milestone if applicable
    if (milestoneTitle && state.milestoneBranch && prNumber > 0) {
      await deps.pr.retargetPrToMilestone(
        repo,
        prNumber,
        state.milestoneBranch,
      );
    }

    // Skip auto-merge for milestone PRs — they are larger and need manual review (Issue #1125)
    if (prNumber > 0) {
      const isMilestonePr = Boolean(milestoneTitle && state.milestoneBranch);
      await deps.pr.finalisePr({
        repo,
        prNumber,
        skipAutoMerge: isMilestonePr,
      });
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
