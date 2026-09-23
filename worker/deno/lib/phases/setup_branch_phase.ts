/**
 * Phase 1 — Setup Branch.
 *
 * Claims the issue, clones/updates the repo, resolves the default
 * branch, applies milestone routing, initialises/restores the session,
 * creates the feature branch, and runs any repo-specific pre-setup
 * command. Single responsibility: get the working tree into the
 * correct state for Claude to execute.
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
import { startHeartbeat } from "../heartbeat.ts";
import { createMilestoneBranchName } from "../git_branch.ts";
import {
  resolveFleetAuthors,
  resolveFleetMaintenanceAuthorSet,
} from "../fleet_authors.ts";
import { getMachineId } from "../machine_id.ts";
import {
  initialiseMilestoneSession,
  restoreSession,
} from "../session_manager.ts";
import { runPreSetupCommand } from "../repo_config.ts";
import {
  MILESTONE_BEHIND_DEFER_REASON,
  presyncMilestoneOnceForArming,
} from "../milestone_presync.ts";
import { expectedNoPrOutcome } from "../run_outcome.ts";
import { repoDirName } from "../work_volume_tiers.ts";
import { escalateToHuman } from "../needs_human_escalation.ts";
import { loadResumeState } from "../resume_state_store.ts";
import { readHandoverNote } from "../handover_prompt_note.ts";
import { handoverFilePath } from "../preserved_wip_branch.ts";
import {
  describeResumeOutcome,
  resumeIssueBranch,
} from "../issue_branch_resume.ts";
import {
  anticipatedProviderId,
  primeStreamSession,
  resolveStreamRunKind,
} from "../stream_session.ts";
import { primeStreamCompaction } from "../stream_compaction.ts";
import { isStreamSharingTier } from "../issue_filter.ts";
import {
  claimRepoLevelRejectionReport,
  describeRepoLevelRejection,
  isRepoLevelBranchRejection,
} from "../milestone_branch_rejection.ts";
import {
  claimObjectStoreRepair,
  isObjectStoreCorruption,
} from "../object_store_repair.ts";
import { repairMilestoneCreateBlockAndRetry } from "../milestone_create_block_repair.ts";
import { releaseMilestoneBranchRefusalLabels } from "../milestone_branch_refusal_release.ts";

/**
 * What a human must do when a milestone branch cannot be ensured
 * (Issue #3910). Exported so tests assert the handoff wording.
 */
export const MILESTONE_BRANCH_NEXT_STEP =
  "Restore or unblock the milestone branch (check branch protection, push " +
  "permissions, and whether the branch was deleted), or move this issue off " +
  "the milestone. The worker will not base a milestone issue on the default " +
  "branch, so it stopped rather than opening a wrongly-based PR.";

/**
 * What a human must do when a re-clone did not clear the corruption
 * (Issue #1093). Exported so tests assert the handoff wording.
 */
export const OBJECT_STORE_NEXT_STEP =
  "Delete the repository's clone and its lane worktrees under the work " +
  "volume by hand and check the host's free disk — a truncated object write " +
  "is the usual cause. The worker already re-cloned once this run and the " +
  "corruption survived it, so the fault is in the volume rather than in the " +
  "objects.";

/**
 * Set up the repository and create/checkout the feature branch.
 *
 * Handles cloning, claiming the issue, creating the branch name,
 * milestone routing, and branch synchronisation.
 */
export async function workOnIssueSetupBranch(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<PhaseResult> {
  const { repo, issueNumber, issueTitle, githubUser, milestoneTitle, config } =
    ctx;
  const logger = deps.logger;

  // Claim the issue to prevent race conditions (Issue #433).
  // Pass markerOptions so the claim comment co-publishes the initial
  // heartbeat marker — avoiding the historic "two comments per claim"
  // pattern where claim and heartbeat appeared as separate comments
  // (Issue #1628).
  const workerId = `${githubUser}-${Date.now()}`;
  const machineId = await getMachineId(config.workDir);
  // Issue #3150: after winning the comment race and before any token work,
  // claimIssue re-checks every fleet account's open PRs live (cache
  // bypassed) so a sibling PR opened in the discovery→claim window aborts
  // this claim rather than spending tokens on a duplicate. Pass the same
  // fleet-author union the discovery-time guard uses and the milestone
  // title so the re-check matches blocking PRs milestone-aware.
  const fleetAuthors = resolveFleetAuthors(
    githubUser,
    config.allowedAuthors,
    config.fleetPrAuthors ?? [],
  );
  // Issue #4133: only the fleet's own open PRs abort a claim — a human's
  // open PR is theirs to manage and never blocks issue pickup.
  const pushCapableAuthors = resolveFleetMaintenanceAuthorSet({
    githubUser,
    fleetPrAuthors: config.fleetPrAuthors ?? [],
  });
  const claimResult = await deps.issues.claimIssue({
    repo,
    issueNumber,
    githubUser,
    workerId,
    fleetAuthors,
    pushCapableAuthors,
    milestoneTitle,
    // Issue #2334: one run per milestone stream at a time, fleet-wide. This
    // phase is the standard pipeline's claim — the run that joins the
    // stream's conversation — so the lock applies here and nowhere else; the
    // pre-pipeline routes (idle-task, add-repo, seed-idle-tasks) never join a
    // stream and never set it. With `enable_session_resume` off there is no
    // shared conversation, so there is no lock and no extra API call.
    streamLockEnabled: config.enableSessionResume,
    // Issue #2530: a `top-priority` or `work-on` issue is wanted now, so a
    // busy stream is shared rather than waited for — the claim proceeds and
    // this run keeps a per-issue conversation (see the stream priming below).
    streamShareable: isStreamSharingTier(ctx.issueLabels, {
      issueLabels: config.issueLabels,
      workOnLabel: config.workOnLabel,
    }),
    markerOptions: {
      machineId,
      workDir: config.workDir,
    },
  });
  if (!claimResult.ok) {
    return {
      status: "failure",
      reason: `Failed to claim issue: ${claimResult.error.message}`,
    };
  }
  if (!claimResult.value.claimed) {
    // Issue #2325: surface the actual reason for the failed claim instead
    // of the misleading "already assigned or closed" catch-all. The
    // reason code is set by claimIssue for every non-success path
    // (race_lost, not_assignable, forbidden, etc.); fall back to the
    // legacy message only if no reason is provided.
    const { reason, winnerId, reasonDetail } = claimResult.value;
    let detail: string;
    if (reason === "race_lost" && winnerId) {
      detail = `race_lost: winner=${winnerId}`;
    } else if (reason === "not_assignable") {
      detail =
        `not_assignable: ${githubUser} is not a collaborator on ${repo}` +
        (reasonDetail ? ` (${reasonDetail})` : "");
    } else if (reason) {
      detail = reasonDetail ? `${reason}: ${reasonDetail}` : reason;
    } else {
      detail = winnerId ?? "already assigned or closed";
    }
    // Issue #1193: the claim was refused, so this run holds nothing to
    // release. Every fleet host runs under one login, so an unassign from
    // here removes the *winner's* assignment and clears its live heartbeat
    // marker — the state Issue #214 describes, reached by a stand-down.
    return {
      status: "early_exit",
      reason: `Issue not available: ${detail}`,
      claimNotHeld: true,
    };
  }

  // Check for claim churn (Issue #861, #999)
  const churnResult = await deps.issues.checkClaimChurn({
    repo,
    issueNumber,
    githubUser,
    allowedAuthors: config.allowedAuthors,
  });
  if (churnResult.ok && churnResult.value.escalated) {
    logger.warn("Claim churn detected, escalating to planning", {
      repo,
      issueNumber,
    });
    return { status: "early_exit", reason: "claim_churn_escalation" };
  }

  // Clone or update the repo into the work directory. With a lane id
  // (Issue #923) this is the lane's own worktree off that clone, so a
  // sibling slot working the same repository cannot move HEAD underneath
  // this run.
  const setupResult = await deps.git.setupRepo(
    repo,
    config.workDir,
    ctx.laneId,
  );
  if (!setupResult.ok) {
    return {
      status: "failure",
      reason: `Failed to set up repo ${repo}: ${setupResult.error.message}`,
    };
  }
  let repoPath = setupResult.value;

  // Record initial heartbeat (Issue #631). The initial record is awaited
  // (Issue #1888); on failure release the claim and surface the failure
  // so the worker doesn't proceed without a live heartbeat marker.
  const heartbeatStart = await startHeartbeat({
    repo,
    issueNumber,
    workDir: config.workDir,
    recordFn: deps.crashHandling.recordHeartbeat,
    clearFn: deps.crashHandling.clearHeartbeat,
  });
  if (!heartbeatStart.ok) {
    try {
      const ghClient = deps.github.createClient(logger);
      await ghClient.unassignIssue(repo, issueNumber, [githubUser]);
    } catch (err) {
      logger.warn(
        "Failed to release claim after heartbeat start failure (non-fatal)",
        {
          repo,
          issueNumber,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
    return {
      status: "failure",
      reason: `Failed to start heartbeat: ${heartbeatStart.error.message}`,
    };
  }
  state.heartbeatHandle = heartbeatStart.value;

  // Create branch name
  state.branchName = deps.git.createBranchName(issueNumber, issueTitle);

  // Determine default branch from GitHub API, then sync it locally
  const detectedBranch = await deps.git.getRepoDefaultBranch(repo);
  if (!detectedBranch.ok) {
    return {
      status: "failure",
      reason:
        `Could not determine default branch for ${repo}: ${detectedBranch.error.message}`,
    };
  }
  const defaultBranch = detectedBranch.value;
  const defaultBranchResult = await deps.git.ensureDefaultBranchCurrent(
    defaultBranch,
    {
      cwd: repoPath,
    },
  );
  if (!defaultBranchResult.ok) {
    logger.warn(`Could not ensure default branch '${defaultBranch}' current`);
  }
  state.defaultBranch = defaultBranch;

  // Milestone routing (Issue #423)
  state.baseBranch = state.defaultBranch;
  if (milestoneTitle) {
    state.milestoneBranch = createMilestoneBranchName(milestoneTitle);
    state.baseBranch = state.milestoneBranch;
    logger.info("Milestone routing active", {
      milestone: milestoneTitle,
      milestoneBranch: state.milestoneBranch,
    });

    // Ensure the milestone branch exists on remote, creating from default if needed (Issue #1241)
    const milestoneBranch = state.milestoneBranch;
    const ensureMilestoneBranch = () =>
      deps.git.ensureMilestoneBranchExists(
        milestoneBranch,
        defaultBranch,
        { cwd: repoPath },
      );
    let ensureResult = await ensureMilestoneBranch();

    // Issue #2079: a `milestone/**` ruleset enforcing its required checks on
    // branch CREATION refuses the very push that opens the branch, so every
    // claim on that repository died in `setup` inside a minute until the
    // repository was backed off. Issue #2067 put the remedy in the
    // operator-run `setup` command; nothing re-ran it, so the worker clears
    // the block in the run that meets it and retries once.
    let repairNote: string | null = null;
    if (!ensureResult.ok) {
      const recovery = await repairMilestoneCreateBlockAndRetry({
        repo,
        milestoneBranch,
        detail: ensureResult.error.message,
        repair: (target) => deps.github.repairMilestoneCreateBlock(target),
        retry: ensureMilestoneBranch,
      });
      if (recovery.kind === "recovered") {
        logger.info(
          "Milestone ruleset no longer blocks branch creation — branch opened after an in-run repair (Issue #2079)",
          {
            repo,
            issueNumber,
            milestoneBranch: state.milestoneBranch,
            ruleset: recovery.ruleset,
          },
        );
        ensureResult = { ok: true, value: recovery.value };
      } else if (recovery.kind === "failed") {
        // Never swallowed: the handoff below carries what was tried.
        repairNote = recovery.note;
        logger.warn(
          "In-run milestone ruleset repair did not clear the refusal",
          {
            repo,
            issueNumber,
            milestoneBranch: state.milestoneBranch,
            note: recovery.note,
          },
        );
      }
    }

    if (!ensureResult.ok) {
      // Issue #3910: never retarget a milestone-assigned issue at the
      // default branch. The milestone branch exists so a milestone lands
      // behind ONE human-reviewed merge; basing the PR on the default
      // branch does not degrade that gate, it removes it. Fail loud and
      // hand off with the underlying git error instead.
      const detail = ensureResult.error.message;
      logger.error(
        "Failed to ensure milestone branch — failing the run (no default-branch fallback)",
        {
          repo,
          issueNumber,
          milestone: milestoneTitle,
          milestoneBranch: state.milestoneBranch,
          error: detail,
        },
      );
      // Issue #853: a ruleset or protection that refuses this branch refuses
      // it identically for every issue in the milestone. Escalating each one
      // turned a single configuration fault into nine `needs-human` parks,
      // none of which clear themselves (Issue #854). Report it once per run
      // and leave the rest claimable, so they resume on their own once the
      // repository is fixed.
      const repoLevel = isRepoLevelBranchRejection(detail);
      const shouldEscalate = !repoLevel ||
        claimRepoLevelRejectionReport(repo, state.milestoneBranch);
      if (repoLevel && !shouldEscalate) {
        logger.error(
          "Milestone branch refused by the repository — already reported this run, leaving the issue claimable (Issue #853)",
          {
            repo,
            issueNumber,
            milestoneBranch: state.milestoneBranch,
          },
        );
        return {
          status: "failure",
          reason:
            `Failed to ensure milestone branch '${state.milestoneBranch}' for milestone ` +
            `'${milestoneTitle}': ${detail}`,
        };
      }
      const repoLevelNote = describeRepoLevelRejection(
        detail,
        state.milestoneBranch,
      );
      const ghClient = deps.github.createClient(logger);
      const escalation = await escalateToHuman({
        ghClient,
        repo,
        target: { kind: "issue", number: issueNumber },
        needsHumanLabel: config.needsHumanLabel,
        heading: "Milestone branch unavailable",
        reason:
          `This issue belongs to milestone '${milestoneTitle}', but its milestone branch ` +
          `\`${state.milestoneBranch}\` could not be created or fetched: ${detail}` +
          (repoLevelNote === null ? "" : `\n\n${repoLevelNote}`) +
          (repairNote === null ? "" : `\n\n${repairNote}`),
        nextStep: MILESTONE_BRANCH_NEXT_STEP,
        dedupKey: `milestone-branch-${state.milestoneBranch}`,
        githubUser,
        deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
        logger,
      });
      if (!escalation.ok) {
        logger.error("Milestone branch escalation failed", {
          repo,
          issueNumber,
          error: escalation.error.message,
        });
      }
      return {
        status: "failure",
        reason:
          `Failed to ensure milestone branch '${state.milestoneBranch}' for milestone ` +
          `'${milestoneTitle}': ${detail}`,
      };
    }

    // The branch exists, so the refusal that once blocked it is gone
    // (Issue #2220). Nothing else ever released the issues that refusal had
    // already labelled: GRQ-FX-validation's ruleset was repaired with
    // sixteen sub-issues still carrying `failed-once`/`failed` for a fault
    // that no longer existed, and a human stripped every one by hand. The
    // first run through here is the first witness that the repository is
    // fixed, so it clears the record. Best-effort — the branch is usable
    // whatever the sweep finds — but never silent.
    const release = await releaseMilestoneBranchRefusalLabels({
      repo,
      milestoneTitle,
      milestoneBranch: state.milestoneBranch,
      labels: {
        failedLabel: config.failedLabel,
        failedOnceLabel: config.failedOnceLabel,
      },
      ghCommandFn: deps.github.runGhCommand,
      // The fleet identity is resolved from the config this phase already
      // holds rather than re-read from disk, as `label_clarification.ts`
      // does — one notion of "the fleet", no second config read.
      authorOptions: {
        fleetAuthors: resolveFleetMaintenanceAuthorSet({
          githubUser,
          fleetPrAuthors: config.fleetPrAuthors,
          serviceAccounts: config.serviceAccounts,
        }),
      },
      log: (message) => logger.warn(message, { repo }),
    });
    if (release.released.length > 0) {
      logger.info(
        "Released failure labels left by a repo-level milestone-branch refusal (Issue #2220)",
        {
          repo,
          milestoneBranch: state.milestoneBranch,
          released: release.released,
        },
      );
    }
    for (const error of release.errors) {
      logger.warn(
        `Milestone-branch refusal label sweep: ${error} (Issue #2220)`,
        { repo, milestoneBranch: state.milestoneBranch },
      );
    }

    // Sync before new work (Issue #1780): no child branch is cut while the
    // milestone branch is behind the default branch. One ladder attempt,
    // charged to the branch's own conflict ledger, in the shared clone the
    // periodic sweep uses — never in this lane's worktree, whose checkout of
    // the milestone branch would then be refused to every other lane.
    //
    // Through the per-cycle memo (Issue #2388): a milestone gets ONE sync
    // attempt per run, not one per issue, so every issue of a branch this
    // cycle cannot bring level is answered from that single attempt.
    const presync = await presyncMilestoneOnceForArming({
      repo,
      milestoneTitle,
      milestoneBranch: state.milestoneBranch,
      defaultBranch: state.defaultBranch,
      cwd: `${config.workDir}/${repoDirName(repo)}`,
      workDir: config.workDir,
      config,
      logger,
      ...(ctx.cycleDeadlineEpochMs !== undefined
        ? { cycleDeadlineEpochMs: ctx.cycleDeadlineEpochMs }
        : {}),
      syncMilestoneBranchFn: deps.git.syncMilestoneBranchWithDefault,
      countCommitsAheadFn: deps.git.countCommitsAhead,
      runGitCommandFn: deps.git.runGitCommand,
      runAgentFn: deps.claude.runClaudeWithRetry,
      // Issue #1558: a merge that landed on a resolution nobody chose is
      // reported once, through the sweep's own escalation.
      ghCommandFn: deps.github.runGhCommand,
    });
    if (presync.status === "deferred") {
      // No agent is spent, the issue keeps its pickup label and no human is
      // asked about it: the ledger's deferral paces the branch, the selector
      // skips the milestone's issues while it does, and the release comment
      // states the reason.
      logger.warn(presync.detail, {
        repo,
        issueNumber,
        milestoneBranch: state.milestoneBranch,
        defaultBranch: state.defaultBranch,
      });
      return {
        status: "early_exit",
        reason: MILESTONE_BEHIND_DEFER_REASON,
        expectedSkip: true,
        outcome: expectedNoPrOutcome("setup", presync.detail),
      };
    }
    logger.info(presync.detail, {
      repo,
      issueNumber,
      milestoneBranch: state.milestoneBranch,
      ...(presync.baseSha ? { baseSha: presync.baseSha } : {}),
    });
  }

  // Milestone-aware session branching (Issue #1322):
  // After milestone routing, initialise the milestone session from default
  // if this is the first invocation on this milestone, then restore the
  // appropriate work stream session into .claude/.
  if (ctx.milestoneNumber !== undefined && state.milestoneBranch) {
    const initResult = await initialiseMilestoneSession(
      config.workDir,
      repo,
      ctx.milestoneNumber,
    );
    if (!initResult.ok) {
      logger.warn("Failed to initialise milestone session (non-fatal)", {
        milestoneNumber: ctx.milestoneNumber,
        error: initResult.ok === false ? initResult.error.message : "unknown",
      });
    }
    // Restore the milestone-specific session into .claude/
    const sessionResult = await restoreSession(
      repoPath,
      config.workDir,
      repo,
      ctx.milestoneNumber,
    );
    if (!sessionResult.ok) {
      logger.warn("Failed to restore milestone session (non-fatal)", {
        milestoneNumber: ctx.milestoneNumber,
      });
    }
  }

  // Resume-on-reclaim (Issue #4170, #220): a prior attempt that died mid-work
  // left its WIP checkpoints on a pushed `issue-<N>-…` branch. Find that work
  // by ISSUE NUMBER rather than by the current title slug — retitling #211
  // between two claims orphaned a 20-file WIP commit because the second claim
  // derived a different branch name and never looked at the pushed one.
  //
  // The lookup is deliberately NOT gated on `enable_session_resume`: that flag
  // gates the CLI `--resume` conversation replay below, never whether pushed
  // work is used. Discarding a pushed commit is data loss, not an opt-in.
  state.resumedFromCheckpoint = false;
  state.handoverNote = undefined;
  const persisted = await loadResumeState(config.workDir, repo, issueNumber);
  const resumeOutcome = await resumeIssueBranch(
    {
      issueNumber,
      baseBranch: state.baseBranch,
      ...(persisted ? { persistedBranch: persisted.branch } : {}),
      gitOptions: { cwd: repoPath },
    },
    {
      listRemoteIssueBranches: deps.git.listRemoteIssueBranches,
      orderBranchesByRecency: deps.git.orderBranchesByRecency,
      countCommitsAhead: deps.git.countCommitsAhead,
      resumeFeatureBranchFromRemote: deps.git.resumeFeatureBranchFromRemote,
    },
  );
  // One line on every claim naming the branch resumed, or saying none existed.
  const resumeMessage = describeResumeOutcome(resumeOutcome, issueNumber);
  if (resumeOutcome.reason === "lookup-failed") {
    logger.warn(resumeMessage, { repo, issueNumber });
  } else {
    logger.info(resumeMessage, {
      repo,
      issueNumber,
      candidates: resumeOutcome.candidates,
      ...(resumeOutcome.skipped.length > 0
        ? { skipped: resumeOutcome.skipped }
        : {}),
    });
  }
  if (resumeOutcome.branch) {
    // The resumed branch — not the title-derived name — is the branch this run
    // commits, pushes and opens its PR from.
    state.branchName = resumeOutcome.branch;
    state.resumedFromCheckpoint = true;
    // The portable half of the briefing (Issue #771): the interrupted run's
    // handover file is committed on this branch, so it is readable from the
    // tree just checked out — on any host, under any provider, and without a
    // session id. Read here; the execute phase splices it into the prompt.
    // Absent on every branch preserved before #769, which resumes on the
    // generic note instead.
    const handover = await readHandoverNote(repoPath, issueNumber);
    const handoverLog = {
      repo,
      issueNumber,
      path: handoverFilePath(issueNumber),
    };
    if (handover.status === "found") {
      state.handoverNote = handover.content;
      logger.info("Handover file read from the resumed branch (Issue #771)", {
        ...handoverLog,
        chars: handover.content.length,
      });
    } else if (handover.status === "unreadable") {
      // A present-but-unreadable file is a fault, not an absence: say so
      // rather than reporting "no handover" and resuming on the generic note
      // as though the branch had never carried one.
      logger.warn(
        "Handover file on the resumed branch could not be read — resuming " +
          "with the generic prior-progress note (Issue #771)",
        { ...handoverLog, error: handover.error.message },
      );
    } else {
      logger.info(
        "No handover file on the resumed branch — resuming with the " +
          "generic prior-progress note (Issue #771)",
        handoverLog,
      );
    }
    // Where the resumed branch started is recorded by the execute phase as
    // `executeStartHeadSha` (Issue #148) — the completion phase reads that to
    // tell "this run advanced the checkpoint" from "this run added nothing to
    // it", so setup does not capture its own copy.
    if (
      config.enableSessionResume && persisted?.sessionId &&
      persisted.branch === resumeOutcome.branch
    ) {
      // Prime CLI session continuity (Issue #1324) from the persisted state.
      // phaseCount is forced to at least 1 so the execute phase passes
      // `--resume` and replays the prior conversation from the durable
      // transcript.
      state.sessionResumeState = {
        sessionId: persisted.sessionId,
        phaseCount: Math.max(1, persisted.phaseCount),
        ...(persisted.providerId ? { providerId: persisted.providerId } : {}),
        ...(persisted.credentialScope
          ? { credentialScope: persisted.credentialScope }
          : {}),
      };
      logger.info("Priming CLI session resume from persisted state", {
        branch: state.branchName,
      });
    }
  }

  // Join the issue's stream conversation (Issue #2333). The per-issue
  // checkpoint above wins where it primed a session: it names the very
  // conversation this branch's interrupted run was having, which is closer to
  // the work than the stream's. Otherwise an implementation run continues the
  // conversation its stream — this repository's milestone, or its blank stream
  // — has been having, instead of starting empty.
  //
  // An idle-task sweep keeps its per-issue session and reads no stream record;
  // `primeStreamSession` returns undefined for it, and for any fault.
  //
  // Issue #2530: so does a run that shared a busy stream. Another host is
  // inside that conversation right now, so this run starts its own — no stream
  // session, no compaction of someone else's transcript, and (because
  // `state.streamSession` stays unset) no stream record or `vibe-stream-holder`
  // marker written when it finishes.
  const sharedStream = claimResult.value.streamShared;
  if (sharedStream) {
    logger.info(
      "Stream shared — keeping a per-issue session (Issue #2530)",
      {
        repo,
        issueNumber,
        stream: sharedStream.streamLabel,
        holderIssue: sharedStream.holderIssue,
        holderHost: sharedStream.holderHost,
      },
    );
  }
  if (
    config.enableSessionResume && !state.sessionResumeState && !sharedStream
  ) {
    const providerId = anticipatedProviderId({
      ...(config.repoConfig?.[repo]
        ? { repoConfig: config.repoConfig[repo] }
        : {}),
      logger,
    });
    const adoption = await primeStreamSession({
      workDir: config.workDir,
      repo,
      ...(ctx.milestoneTitle !== undefined
        ? { milestoneTitle: ctx.milestoneTitle }
        : {}),
      providerId,
      runKind: resolveStreamRunKind(ctx.issueLabels),
      logger,
    });
    if (adoption) {
      state.sessionResumeState = adoption.state;
      // `holderHost` is what the run records on the milestone's tracking issue
      // when it finishes (Issue #2336): the conversation ends up on this
      // machine's disk, so this machine gets the stream's next issue first.
      state.streamSession = {
        stream: adoption.stream,
        providerId,
        holderHost: machineId,
      };
      // Compact that conversation before the issue's first phase runs
      // (Issue #2337). It has carried every issue of this stream so far, so
      // left alone it is the next issue that dies of a full context window.
      // Returns the `--autocompact` window when the compaction could not be
      // verified — the CLI's own lever, pulled as early as it goes.
      state.autocompactTokens = await primeStreamCompaction({
        outcome: adoption.outcome,
        providerId,
        sessionId: adoption.state.sessionId,
        cwd: repoPath,
        workDir: config.workDir,
        logger,
        logFields: { repo, issueNumber },
      });
    }
  }

  // Create feature branch from base (skipped when a checkpoint was resumed)
  if (!state.resumedFromCheckpoint) {
    let branchResult = await deps.git.createFeatureBranchFromBase(
      state.branchName,
      state.baseBranch,
      { cwd: repoPath },
    );

    // Issue #1093: `inflate: data stream error` is not a bad ref, it is a
    // damaged object in the store every lane worktree of this repository
    // shares — so failing the issue here fails the next issue, and the one
    // after that, identically. Every object is recoverable from the remote,
    // so repair and retry rather than hand a human a fault the worker can
    // fix itself.
    if (
      !branchResult.ok && isObjectStoreCorruption(branchResult.error.message)
    ) {
      const corruption = branchResult.error.message;
      let repairDetail = "";
      if (!claimObjectStoreRepair(repo)) {
        // Already re-cloned this run and the corruption came back: the work
        // volume is the fault, not the objects. Do not spend another clone.
        repairDetail =
          "the object store was already re-cloned this run and the " +
          "corruption recurred";
        logger.error(
          "Object-store corruption recurred after this run's re-clone — not re-cloning again (Issue #1093)",
          { repo, issueNumber, error: corruption },
        );
      } else {
        logger.error(
          "Shared object store is corrupt — re-cloning the repository before failing the issue (Issue #1093)",
          { repo, issueNumber, error: corruption },
        );
        const repair = await deps.git.repairObjectStore({
          repo,
          workDir: config.workDir,
        });
        if (!repair.ok) {
          repairDetail = repair.error.message;
          logger.error("Object-store repair failed (Issue #1093)", {
            repo,
            issueNumber,
            error: repairDetail,
          });
        } else {
          logger.info(
            "Object store re-cloned — retrying the feature branch (Issue #1093)",
            {
              repo,
              issueNumber,
              removed: repair.value.removed,
              fsck: repair.value.fsck,
            },
          );
          // The lane's worktree went with the clone, so take a fresh one
          // off the new store before retrying.
          const reSetup = await deps.git.setupRepo(
            repo,
            config.workDir,
            ctx.laneId,
          );
          if (!reSetup.ok) {
            repairDetail =
              `the repaired clone could not be re-opened: ${reSetup.error.message}`;
            logger.error(
              "Could not take a working tree off the repaired clone (Issue #1093)",
              { repo, issueNumber, error: reSetup.error.message },
            );
          } else {
            repoPath = reSetup.value;
            branchResult = await deps.git.createFeatureBranchFromBase(
              state.branchName,
              state.baseBranch,
              { cwd: repoPath },
            );
            if (!branchResult.ok) {
              repairDetail =
                `the branch still could not be created after the re-clone: ${branchResult.error.message}`;
            }
          }
        }
      }

      if (!branchResult.ok) {
        // A repair that did not resolve the corruption is the one case a
        // human is needed for, and it is named per repository — every issue
        // in it fails identically, so one report is the whole story.
        const ghClient = deps.github.createClient(logger);
        const escalation = await escalateToHuman({
          ghClient,
          repo,
          target: { kind: "issue", number: issueNumber },
          needsHumanLabel: config.needsHumanLabel,
          heading: "Corrupt git object store",
          reason:
            `The shared git object store of \`${repo}\` on this host is corrupt, ` +
            `and the worker could not repair it: ${repairDetail}.\n\n` +
            "The lane worktrees share one object store per repository, so this " +
            "fault applies to every slot and every milestone branch in it.\n\n" +
            "```\n" + corruption + "\n```",
          nextStep: OBJECT_STORE_NEXT_STEP,
          dedupKey: `object-store-corrupt-${repo}`,
          githubUser,
          deps: {
            github: { ensureLabelExists: deps.github.ensureLabelExists },
          },
          logger,
        });
        if (!escalation.ok) {
          logger.error("Object-store corruption escalation failed", {
            repo,
            issueNumber,
            error: escalation.error.message,
          });
        }
      }
    }

    if (!branchResult.ok) {
      return {
        status: "failure",
        reason:
          `Failed to create feature branch: ${branchResult.error.message}`,
      };
    }
  }

  state.repoPath = repoPath;

  // Run repository-specific pre-setup command if configured (Issue #85, #1184)
  const preSetupResult = await runPreSetupCommand(
    repo,
    repoPath,
    config.repoConfig,
  );
  if (!preSetupResult.ok) {
    logger.warn("Pre-setup command failed (non-fatal)", {
      repo,
      error: preSetupResult.error.message,
    });
  } else if (preSetupResult.value === "completed") {
    logger.info("Pre-setup command completed successfully", { repo });
  }

  logger.info("Branch setup complete", {
    branch: state.branchName,
    base: state.baseBranch,
  });

  return { status: "continue" };
}
