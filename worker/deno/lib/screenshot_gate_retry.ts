/**
 * One extra in-run agent turn to capture a missing screenshot before the
 * screenshot gate fails the run (Issue #2960).
 *
 * The completion phase's screenshot gate (`screenshot_validation.ts`) blocks a
 * UI change that carries no evidence — a reference in the PR summary or an
 * image file on the branch. Before this module, the first block of a run was
 * reported exactly the same as the second: `needs-screenshot` label, the
 * remediation comment, and a `failure` that released the claim. The agent had
 * often just finished the change and simply forgot the screenshot step; the
 * next claim redid a whole run to add one image.
 *
 * Mirrors the in-run recoveries this phase already carries for the
 * security-fix gate (#1575) and the PR-summary rule gates (#2189): the first
 * block in a run gets one extra agent turn — resuming the same session with
 * the gate's own failure message as the prompt — then one re-run of
 * completion. A second block in the same run fails exactly as before, with
 * the label and comment now applied.
 *
 * Australian English throughout.
 */

import {
  type IssueContext,
  type PhaseResult,
  type PhaseState,
  recordClaudeRunStats,
} from "./issue_worker_types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { LABEL_DEFAULTS, OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import { resolvePreFlightSpec } from "./git_push.ts";

/** The screenshot gate's verdict for this run — its failure message. */
export interface ScreenshotGateBlock {
  /** The gate's remediation message (today's `SCREENSHOT_FAILURE_MESSAGE`). */
  failureMessage: string;
}

/** The phase-failure reason the screenshot gate reports (unchanged text). */
export const SCREENSHOT_EVIDENCE_MISSING_REASON =
  "Screenshot evidence missing for UI-related change";

/**
 * Apply the screenshot gate's failure path: label, comment, fail.
 *
 * This is what the gate did unconditionally before Issue #2960; now it is
 * reached only after the one extra agent turn has already been tried (or
 * could not be).
 */
export async function applyScreenshotGateFailure(
  ctx: IssueContext,
  deps: WorkerDeps,
  failureMessage: string,
): Promise<PhaseResult> {
  const { repo, issueNumber } = ctx;
  const logger = deps.logger;
  const needsScreenshotLabel = LABEL_DEFAULTS.needsScreenshotLabel;

  await deps.github.ensureLabelExists(
    repo,
    needsScreenshotLabel,
    "d93f0b",
    "Previous attempt was blocked for missing screenshot evidence",
  );

  const client = deps.github.createClient(logger);
  await client.addLabel(repo, issueNumber, needsScreenshotLabel);
  await client.postComment(repo, issueNumber, failureMessage);

  return { status: "failure", reason: SCREENSHOT_EVIDENCE_MISSING_REASON };
}

/**
 * Recover from a screenshot gate block inside the run (Issue #2960).
 *
 * Called by the completion phase for the FIRST block of a run. The flag that
 * stops a second entry is set — and the recorded block cleared — before
 * anything is invoked, so a throw, a bad result, or recursion through
 * `rerunCompletion` can never loop: exactly one extra turn per run.
 *
 * @param rerunCompletion - Re-runs the completion attempt after the turn,
 *   which re-reads the changed files and PR summary and re-validates.
 */
export async function recoverFromScreenshotGateBlock(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
  rerunCompletion: () => Promise<PhaseResult>,
): Promise<PhaseResult> {
  const logger = deps.logger;
  const { repo, issueNumber, config } = ctx;

  const block = state.screenshotGateBlock;
  // Set before anything is invoked — guarantees exactly one extra turn per
  // run, never a loop, even if this function is somehow re-entered.
  state.screenshotRetryAttempted = true;
  delete state.screenshotGateBlock;

  if (!block) {
    // The caller only enters here with a block recorded; saying so beats
    // silently returning a pass.
    logger.warn(
      "No screenshot-gate block to act on — failing as the gate reported",
      { repo, issueNumber },
    );
    return { status: "failure", reason: SCREENSHOT_EVIDENCE_MISSING_REASON };
  }

  logger.warn(
    "Screenshot gate failed — resuming the agent for one extra turn to " +
      "capture the evidence (Issue #2960)",
    { repo, issueNumber },
  );

  let retryResult;
  try {
    retryResult = await deps.claude.runClaudeWithRetry(
      {
        prompt: block.failureMessage,
        phase: "issue",
        repo,
        issueNumber,
        timeoutSeconds: config.screenshotRetryTimeoutSeconds ??
          OPERATIONAL_DEFAULTS.screenshotRetryTimeoutSeconds,
        killAfterSeconds: config.claudeKillAfter,
        model: config.claudeModel || undefined,
        cwd: state.repoPath,
        // The browser is needed to take the screenshot; a repo with
        // skip_screenshot_check never reaches this recovery at all.
        mcpConfig: true,
        logger,
        // Resume the same session, as invokeAgent in execute_phase.ts does.
        sessionResumeState: state.sessionResumeState,
      },
      { maxRetries: config.maxRateLimitRetries },
    );
  } catch (err) {
    logger.warn(
      `Screenshot gate: the one extra agent turn was tried and did not ` +
        `help — ${
          err instanceof Error ? err.message : String(err)
        }; failing as before (Issue #2960)`,
      { repo, issueNumber },
    );
    return await applyScreenshotGateFailure(ctx, deps, block.failureMessage);
  }

  if (!retryResult.ok) {
    logger.warn(
      `Screenshot gate: the one extra agent turn was tried and did not ` +
        `help — ${retryResult.error.message}; failing as before ` +
        `(Issue #2960)`,
      { repo, issueNumber },
    );
    return await applyScreenshotGateFailure(ctx, deps, block.failureMessage);
  }

  const { value } = retryResult;
  if (value.timedOut === true) {
    logger.warn(
      `Screenshot gate: the one extra agent turn was tried and did not ` +
        `help — timed out after ${
          config.screenshotRetryTimeoutSeconds ??
            OPERATIONAL_DEFAULTS.screenshotRetryTimeoutSeconds
        }s; failing as before (Issue #2960)`,
      { repo, issueNumber },
    );
    return await applyScreenshotGateFailure(ctx, deps, block.failureMessage);
  }
  if (value.exitCode !== 0) {
    logger.warn(
      `Screenshot gate: the one extra agent turn was tried and did not ` +
        `help — exited with code ${value.exitCode}; failing as before ` +
        `(Issue #2960)`,
      { repo, issueNumber },
    );
    return await applyScreenshotGateFailure(ctx, deps, block.failureMessage);
  }

  recordClaudeRunStats(state, value);

  // Whatever the turn left uncommitted is committed onto the branch before
  // completion re-runs, the way `commitRecoveredSummary` does for the
  // PR-summary recovery. Failures here are logged at error level and the
  // consequence named, never thrown — the re-run still decides whether
  // evidence landed.
  await commitScreenshotEvidence(ctx, state, deps);

  return await rerunCompletion();
}

/**
 * Commit what the extra turn produced onto the issue branch (Issue #2960).
 *
 * Mirrors `commitRecoveredSummary` in `summary_rule_gate_retry.ts`: HEAD is
 * reconciled first, in case the turn left its commit on a detached checkout,
 * then whatever is pending is committed and pushed. Never fails the run — a
 * commit that cannot be made leaves the file on disk exactly as the agent
 * wrote it, which the re-run's own diff and summary checks will simply not
 * find as evidence.
 */
async function commitScreenshotEvidence(
  ctx: IssueContext,
  state: PhaseState,
  deps: WorkerDeps,
): Promise<void> {
  const { repo, issueNumber, config } = ctx;
  const logger = deps.logger;

  const reconcile = await deps.git.reconcileHeadToBranch(state.branchName, {
    cwd: state.repoPath,
  });
  if (!reconcile.ok) {
    logger.error(
      `Could not put HEAD back on '${state.branchName}' to commit the ` +
        `screenshot evidence — it stays UNTRACKED and the re-run will not ` +
        `see it: ${reconcile.error.message}`,
      { repo, issueNumber },
    );
    return;
  }

  const commit = await deps.git.commitAndPushPending(
    state.branchName,
    `docs: screenshot evidence for #${issueNumber}\n\n` +
      `In-run screenshot-gate recovery (Issue #2960).`,
    { cwd: state.repoPath },
    false,
    resolvePreFlightSpec(config.repoConfig, repo),
  );
  if (!commit.ok) {
    logger.error(
      `Could not commit the screenshot evidence — it stays UNTRACKED on ` +
        `'${state.branchName}', so the re-run will not find it: ` +
        `${commit.error.message}`,
      { repo, issueNumber },
    );
    return;
  }
  logger.info("Screenshot evidence committed before completion re-runs", {
    repo,
    issueNumber,
    committedNewChanges: commit.value.committedNewChanges,
    commitsPushed: commit.value.commitsPushed,
  });
}
