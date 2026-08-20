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
import { escalateToHuman } from "../needs_human_escalation.ts";
import { loadResumeState } from "../resume_state_store.ts";

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
    return { status: "early_exit", reason: `Issue not available: ${detail}` };
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

  // Clone or update the repo into the work directory
  const setupResult = await deps.git.setupRepo(repo, config.workDir);
  if (!setupResult.ok) {
    return {
      status: "failure",
      reason: `Failed to set up repo ${repo}: ${setupResult.error.message}`,
    };
  }
  const repoPath = setupResult.value;

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
    const ensureResult = await deps.git.ensureMilestoneBranchExists(
      state.milestoneBranch,
      state.defaultBranch,
      { cwd: repoPath },
    );
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
      const ghClient = deps.github.createClient(logger);
      const escalation = await escalateToHuman({
        ghClient,
        repo,
        target: { kind: "issue", number: issueNumber },
        needsHumanLabel: config.needsHumanLabel,
        heading: "Milestone branch unavailable",
        reason:
          `This issue belongs to milestone '${milestoneTitle}', but its milestone branch ` +
          `\`${state.milestoneBranch}\` could not be created or fetched: ${detail}`,
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

  // Resume-on-reclaim (Issue #4170): a fresh (< 24 h) resume file whose
  // branch matches this claim means a prior attempt died mid-work. Its WIP
  // checkpoints live on the remote issue branch and its conversation
  // transcript in the durable CLAUDE_CONFIG_DIR — pick both up instead of
  // recreating the branch from base and restarting from zero.
  state.resumedFromCheckpoint = false;
  if (config.enableSessionResume) {
    const persisted = await loadResumeState(config.workDir, repo, issueNumber);
    if (persisted && persisted.branch === state.branchName) {
      const resumeResult = await deps.git.resumeFeatureBranchFromRemote(
        state.branchName,
        { cwd: repoPath },
      );
      state.resumedFromCheckpoint = resumeResult.ok &&
        resumeResult.value === true;
      if (state.resumedFromCheckpoint) {
        // Record where the resumed branch started (Issue #148) so the
        // completion phase can tell "this run advanced the checkpoint"
        // from "this run added nothing to it".
        const head = await deps.git.runGitCommand(["rev-parse", "HEAD"], {
          cwd: repoPath,
        });
        const sha = head.ok && head.value.code === 0
          ? head.value.stdout.trim()
          : "";
        if (sha.length > 0) state.resumedCheckpointHead = sha;
      }
      if (persisted.sessionId) {
        // Prime CLI session continuity (Issue #1324) from the persisted
        // state. phaseCount is forced to at least 1 so the execute phase
        // passes `--resume` and replays the prior conversation from the
        // durable transcript.
        state.sessionResumeState = {
          sessionId: persisted.sessionId,
          phaseCount: Math.max(1, persisted.phaseCount),
        };
      }
      logger.info(
        state.resumedFromCheckpoint
          ? "Resuming prior progress from checkpointed branch (Issue #4170)"
          : "Resume state found but no remote checkpoint branch — starting clean",
        {
          branch: state.branchName,
          sessionResume: persisted.sessionId !== undefined,
        },
      );
    }
  }

  // Create feature branch from base (skipped when a checkpoint was resumed)
  if (!state.resumedFromCheckpoint) {
    const branchResult = await deps.git.createFeatureBranchFromBase(
      state.branchName,
      state.baseBranch,
      { cwd: repoPath },
    );
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
