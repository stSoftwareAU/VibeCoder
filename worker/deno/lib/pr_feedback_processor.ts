/**
 * PR feedback processor (Issue #967).
 *
 * Handles responding to PR review comments by checking out the PR branch,
 * building a feedback prompt, running Claude to fix issues, committing
 * changes, pushing, and replying to the comment.
 *
 * Migrated from work_on_pr_feedback() in issue_worker.sh.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, RepoConfig, Result } from "../types.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { resolvePreFlightSpec } from "./git_push.ts";
import type { CommentType } from "./pr_comments.ts";
import { getTokenEstimate } from "./claude_runner.ts";
import {
  buildPrFeedbackPrompt,
  type PrFeedbackPromptOptions,
} from "./prompt_builder.ts";
import { readRepoContext } from "./repo_context_reader.ts";
import { claimPrComment } from "./claim_pr_comment.ts";
import {
  preparePrBranch,
  readPrResponseMessage,
} from "./pr_branch_preparation.ts";
import {
  type HeartbeatHandle,
  startHeartbeat,
  stopHeartbeat,
} from "./heartbeat.ts";
import { classifyCiFailure } from "./ci_failure_classifier.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import {
  buildFeedbackNoChangesResponse,
  PR_ESCALATION_NEXT_STEP,
} from "./pr_no_changes_response.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { createGhEscalationClient } from "./gh_escalation_client.ts";
import { detectEscapeHatch } from "./escape_hatch.ts";
import { stripReservedLabelsFromFollowUp } from "./escape_hatch_label_strip.ts";
import { loadMonitoredReposBestEffort } from "./monitored_repos_allowlist.ts";
import { verifyFollowUpIssueExists } from "./escape_hatch_verify.ts";
import { loadTrustedFollowUpAuthors } from "./escape_hatch_trusted_authors.ts";
import { fetchTrustedBotReviewComments } from "./pr_review_context.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for the PR feedback processor. */
export interface PrFeedbackInput {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Head branch name. */
  branchName: string;
  /** Type of comment (review, issue, pr_review). */
  commentType: CommentType;
  /** Comment or review ID. */
  commentId: string;
  /** The comment body text. */
  commentBody: string;
  /**
   * Optional name of a failing CI check associated with the feedback
   * (Issue #1691). When set, the no-changes path runs the CI failure
   * classifier with the comment body as the log excerpt so the response
   * can route to `needs-human` for code-fix-required findings.
   */
  failingCheckName?: string;
}

/** Result of PR feedback processing. */
export interface PrFeedbackResult {
  /** Whether processing completed successfully. */
  processed: boolean;
  /** Whether code changes were made and pushed. */
  changesPushed: boolean;
  /** Human-readable summary. */
  summary: string;
}

/** Dependencies specific to the feedback processor. */
export interface PrFeedbackProcessorDeps {
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Worker deps for cross-cutting concerns. */
  deps: WorkerDeps;
  /** Working directory for repo operations. */
  workDir: string;
  /** Quality instructions for the prompt. */
  qualityInstructions?: string;
  /** Custom repo-specific instructions. */
  customInstructions?: string;
  /** Maximum token count for comment bodies before summarisation. */
  maxCommentTokens?: number;
  /** Claude timeout in seconds. */
  claudeTimeout?: number;
  /**
   * Silence watchdog: kill Claude if stdout has been idle for this many
   * seconds (Issue #1825). Distinct from the hard `claudeTimeout`.
   */
  claudeNoOutputTimeout?: number;
  /** Maximum rate limit retries. */
  maxRateLimitRetries?: number;
  /** Claude model override. */
  claudeModel?: string;
  /** Unique worker ID for PR comment claiming (Issue #1072). */
  workerId?: string;
  /**
   * The run's resolved worker GitHub login (Issue #185). Seeds the
   * trusted-author set for the escape-hatch follow-up gate so a follow-up the
   * worker filed itself is recognised without relying on the `GITHUB_USER`
   * env var being set. Omitted → falls back to that env var.
   */
  githubUser?: string;
  /**
   * Allowlisted bot logins whose unresolved line-level review comments
   * are bundled into the prompt as additional context (Issue #1858).
   * When empty or omitted, no bundling occurs.
   */
  trustedReviewBots?: readonly string[];
  /**
   * Per-repo configuration map, used to resolve the pre-flight enforcement
   * gate (Issue #3577). Omitted → no gate.
   */
  repoConfigs?: Record<string, RepoConfig>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_COMMENT_TOKENS = 50000;
/**
 * Default hard timeout for the PR feedback phase (Issue #1824).
 * Re-exported from OPERATIONAL_DEFAULTS so there is one source of truth.
 */
const DEFAULT_CLAUDE_TIMEOUT = OPERATIONAL_DEFAULTS.prFeedbackTimeout;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
/** Default silence watchdog (Issue #1825) — mirrors OPERATIONAL_DEFAULTS.claudeNoOutputTimeout. */
const DEFAULT_CLAUDE_NO_OUTPUT_TIMEOUT =
  OPERATIONAL_DEFAULTS.claudeNoOutputTimeout;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded comment body.
 *
 * @param encoded - Base64-encoded string
 * @returns Decoded string, or empty string on failure
 */
export function decodeCommentBody(encoded: string): string {
  try {
    return atob(encoded);
  } catch {
    return encoded;
  }
}

/**
 * Summarise a large comment body to fit within token limits.
 *
 * Truncates long content and adds a notice. In a full implementation
 * this would use Claude for intelligent summarisation, but for the
 * processor we do simple truncation.
 *
 * @param body - The full comment body
 * @param maxTokens - Maximum token estimate
 * @returns Summarised body
 */
export function summariseLargeComment(
  body: string,
  maxTokens: number,
): string {
  const estimate = getTokenEstimate(body);
  if (estimate <= maxTokens) return body;

  // Rough character-to-token ratio of ~4 chars per token
  const maxChars = maxTokens * 4;
  const truncated = body.slice(0, maxChars);
  return `${truncated}\n\n[Comment truncated — original was ~${estimate} tokens, limit is ${maxTokens}]`;
}

/**
 * Build a commit message for PR feedback changes.
 *
 * @param prNumber - The PR number
 * @param commentBody - The comment body (truncated for the message)
 * @returns Commit message string
 */
export function buildFeedbackCommitMessage(
  prNumber: number,
  commentBody: string,
): string {
  const truncatedBody = commentBody.slice(0, 50);
  return `Fix PR #${prNumber} feedback: ${truncatedBody}...

Automated fix by auto-issue-worker`;
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

/**
 * Process PR feedback by running Claude to address review comments.
 *
 * This is the Deno equivalent of work_on_pr_feedback() from issue_worker.sh.
 * It:
 * 1. Validates and optionally summarises the comment body
 * 2. Checks for suspicious patterns (defence in depth)
 * 3. Builds a PR feedback prompt
 * 4. Runs Claude with retry/timeout handling
 * 5. Commits and pushes any changes
 * 6. Marks the comment as processed and replies
 *
 * @param input - PR feedback input data
 * @param processorDeps - Processor dependencies
 * @returns Result containing the processing outcome
 */
export async function processPrFeedback(
  input: PrFeedbackInput,
  processorDeps: PrFeedbackProcessorDeps,
): Promise<Result<PrFeedbackResult>> {
  const { repo, prNumber, commentType, commentId } = input;
  const { logger, deps, workerId } = processorDeps;

  logger.info("Processing PR feedback", { repo, prNumber, commentType });

  // Claim the PR comment atomically before processing (Issue #1072).
  // Prevents multiple workers from responding to the same comment.
  if (workerId) {
    const claimResult = await claimPrComment({
      repo,
      prNumber,
      commentId,
      commentType,
      workerId,
      ghCommandFn: (args: string[]) => deps.github.runGhCommand(args),
    });

    if (!claimResult.ok) {
      return {
        ok: false,
        error: new Error(
          `Failed to claim PR comment: ${claimResult.error.message}`,
        ),
      };
    }

    if (!claimResult.value.claimed) {
      const winner = claimResult.value.winnerId ?? "unknown";
      logger.info("PR comment already claimed by another worker", {
        repo,
        prNumber,
        commentId,
        winnerId: winner,
      });
      return {
        ok: true,
        value: {
          processed: false,
          changesPushed: false,
          summary:
            `PR comment #${commentId} on PR #${prNumber} already claimed by ${winner}`,
        },
      };
    }

    logger.info("Successfully claimed PR comment", {
      repo,
      prNumber,
      commentId,
      workerId,
    });
  }

  // Start periodic heartbeat to prevent false crash detection (Issue #1204).
  // The initial record is awaited (Issue #1888); on failure return early so
  // the next worker iteration can re-process the PR comment.
  const heartbeatStart = await startHeartbeat({
    repo,
    issueNumber: prNumber,
    workDir: processorDeps.workDir,
    recordFn: deps.crashHandling.recordHeartbeat,
    clearFn: deps.crashHandling.clearHeartbeat,
  });
  if (!heartbeatStart.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to start heartbeat for PR ${repo}#${prNumber}: ${heartbeatStart.error.message}`,
      ),
    };
  }
  const heartbeatHandle: HeartbeatHandle = heartbeatStart.value;

  try {
    return await _processFeedbackWithHeartbeat(input, processorDeps);
  } finally {
    await stopHeartbeat(heartbeatHandle);
  }
}

/**
 * Inner feedback processing logic, separated to allow heartbeat
 * lifecycle management in the outer function (Issue #1204).
 */
async function _processFeedbackWithHeartbeat(
  input: PrFeedbackInput,
  processorDeps: PrFeedbackProcessorDeps,
): Promise<Result<PrFeedbackResult>> {
  const { repo, prNumber, commentType, commentId, commentBody } = input;
  const {
    logger,
    deps,
    qualityInstructions,
    customInstructions,
    maxCommentTokens = DEFAULT_MAX_COMMENT_TOKENS,
    claudeTimeout = DEFAULT_CLAUDE_TIMEOUT,
    claudeNoOutputTimeout = DEFAULT_CLAUDE_NO_OUTPUT_TIMEOUT,
    maxRateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES,
    trustedReviewBots,
  } = processorDeps;

  // Summarise large comments
  let processedBody = commentBody;
  const tokenEstimate = getTokenEstimate(commentBody);
  if (tokenEstimate > maxCommentTokens) {
    logger.info("Comment is large, summarising", {
      tokens: tokenEstimate,
      limit: maxCommentTokens,
    });
    processedBody = summariseLargeComment(commentBody, maxCommentTokens);
  }

  // Defence in depth — check for suspicious patterns
  deps.security.detectSuspiciousPatterns(processedBody, "PR comment");

  // Checkout the PR branch before running Claude (Issue #1458).
  // Shell work_on_pr_feedback did this; the Deno migration missed it,
  // leaving milestone-branch PRs running on the wrong branch.
  await preparePrBranch(input.branchName, {
    logger,
    git: deps.git,
    cwd: processorDeps.workDir,
  });

  // Capture HEAD SHA before Claude runs (Issue #1862, part of #1855).
  // Claude may commit and push during its own run, leaving
  // commitAndPushPending with nothing to do — the old derivation of
  // hasChanges from commitAndPushPending alone missed Claude's own pushes
  // and produced a misleading "could not identify a code change" reply.
  // We compare HEAD before vs after to recognise self-pushed commits.
  const beforeHeadResult = await deps.git.captureBranchHead(input.branchName, {
    cwd: processorDeps.workDir,
  });
  const beforeSha = beforeHeadResult.ok ? beforeHeadResult.value : undefined;
  if (!beforeHeadResult.ok) {
    logger.warn("captureBranchHead failed before Claude run", {
      branch: input.branchName,
      error: beforeHeadResult.error.message,
    });
  }

  // Read repo context (CLAUDE.md/AGENTS.md) for system prompt injection (Issue #1325)
  const repoName = repo.split("/").pop() ?? repo;
  const repoDir = `${processorDeps.workDir}/${repoName}`;
  const repoContextResult = await readRepoContext(repoDir);
  const repoContextContent =
    repoContextResult.ok && repoContextResult.value.content
      ? repoContextResult.value.content
      : undefined;

  // Bundle unresolved trusted-bot review comments as additional prompt
  // context (Issue #1858). Failures degrade silently — no bundling
  // beats blocking PR feedback processing on a transient API error.
  let additionalReviewComments:
    | Awaited<
      ReturnType<typeof fetchTrustedBotReviewComments>
    >
    | undefined;
  if (trustedReviewBots && trustedReviewBots.length > 0) {
    additionalReviewComments = await fetchTrustedBotReviewComments(
      repo,
      prNumber,
      trustedReviewBots,
      (args: string[]) => deps.github.runGhCommand(args),
    );
    if (!additionalReviewComments.ok) {
      logger.warn("Failed to fetch trusted-bot review comments", {
        repo,
        prNumber,
        error: additionalReviewComments.error.message,
      });
    } else {
      logger.info("Bundled trusted-bot review comments", {
        repo,
        prNumber,
        count: additionalReviewComments.value.length,
      });
    }
  }

  // Build prompt
  const promptOptions: PrFeedbackPromptOptions = {
    repo,
    prNumber: String(prNumber),
    commentBody: processedBody,
    qualityInstructions,
    customInstructions,
    repoContextContent,
    additionalReviewComments: additionalReviewComments?.ok
      ? additionalReviewComments.value
      : undefined,
  };

  const promptResult = await buildPrFeedbackPrompt(promptOptions);
  if (!promptResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to build feedback prompt: ${promptResult.error.message}`,
      ),
    };
  }

  // Destructure PromptParts for prompt caching (Issue #1262)
  const { systemPrompt, prompt: userPrompt } = promptResult.value;

  // Execute Claude in the target repo directory (Issue #1297)
  const claudeResult = await deps.claude.runClaudeWithRetry(
    {
      prompt: userPrompt,
      systemPrompt,
      timeoutSeconds: claudeTimeout,
      noOutputTimeout: claudeNoOutputTimeout,
      phase: "pr_feedback",
      cwd: processorDeps.workDir,
      logger,
    },
    {
      maxRetries: maxRateLimitRetries,
    },
  );

  if (!claudeResult.ok) {
    // Handle failure — report via comment failure handler
    const failureMessage =
      `Claude execution failed: ${claudeResult.error.message}`;
    await deps.pr.handlePrCommentFailure(
      repo,
      prNumber,
      commentType,
      commentId,
      failureMessage,
    );
    return {
      ok: false,
      error: new Error(failureMessage),
    };
  }

  // Check for timeout (Issue #1825: distinguish silence watchdog from hard timeout)
  if (claudeResult.value.timedOut) {
    const failureMessage = claudeResult.value.timeoutReason === "no-output"
      ? `Claude produced no output for ${claudeNoOutputTimeout} seconds (silence watchdog fired)`
      : `Claude timed out after ${claudeTimeout} seconds`;
    await deps.pr.handlePrCommentFailure(
      repo,
      prNumber,
      commentType,
      commentId,
      failureMessage,
    );
    return {
      ok: false,
      error: new Error(failureMessage),
    };
  }

  // Mark comment as processed
  await deps.pr.markCommentProcessed(repo, commentType, commentId, prNumber);

  // Always commit and push any pending work (Issue #1643).
  // Previously gated on `claudeOutput.length > 0`, but Claude stdout is
  // not a reliable signal of git state — silent commits or uncommitted
  // working-tree changes left local-only work behind on unattended
  // machines. Use git itself as the source of truth.
  //
  // Issue #3577: enforce the repo's pre-flight gate — a non-zero exit blocks
  // both the commit and the push so a broken feedback fix is not pushed.
  const preFlight = resolvePreFlightSpec(processorDeps.repoConfigs, repo);
  const finaliseResult = await deps.git.commitAndPushPending(
    input.branchName,
    `Address PR #${prNumber} feedback\n\nAutomated final-mile commit (Issue #1643).`,
    { cwd: processorDeps.workDir },
    false,
    preFlight,
  );

  let pushSucceeded = false;
  let hasChanges = false;
  let finalUnpushedCount = 0;
  if (finaliseResult.ok) {
    const { committedNewChanges, commitsPushed } = finaliseResult.value;
    finalUnpushedCount = finaliseResult.value.finalUnpushedCount;
    hasChanges = committedNewChanges || commitsPushed > 0;
    logger.info("Final-mile commit-and-push complete", {
      committedNewChanges,
      commitsPushed,
      finalUnpushedCount,
    });

    if (finalUnpushedCount > 0) {
      logger.warn("Local commits remain after push, attempting recovery", {
        unpushed: finalUnpushedCount,
      });
      const recoveryResult = await deps.git.recoverFromPushRejection(
        input.branchName,
        { cwd: processorDeps.workDir },
      );
      if (recoveryResult.ok) {
        const retryFinalise = await deps.git.commitAndPushPending(
          input.branchName,
          `Address PR #${prNumber} feedback\n\nRetry after rebase recovery (Issue #1643).`,
          { cwd: processorDeps.workDir },
          false,
          preFlight,
        );
        if (retryFinalise.ok) {
          finalUnpushedCount = retryFinalise.value.finalUnpushedCount;
          if (retryFinalise.value.finalUnpushedCount === 0) {
            hasChanges = true;
          }
        }
      }
      if (finalUnpushedCount > 0) {
        logger.error("Push failed after recovery attempt", { repo, prNumber });
      }
    }
  } else {
    logger.error("commitAndPushPending failed", {
      error: finaliseResult.error.message,
    });
  }

  // Issue #1862: Detect Claude self-pushed commits by comparing HEAD SHA
  // before vs after the Claude run. If HEAD moved, treat the run as having
  // produced changes even if commitAndPushPending found nothing to do.
  if (beforeSha !== undefined) {
    const movedResult = await deps.git.branchHeadChanged(
      beforeSha,
      input.branchName,
      { cwd: processorDeps.workDir },
    );
    if (movedResult.ok && movedResult.value) {
      logger.info("Branch HEAD moved during Claude run", {
        branch: input.branchName,
        beforeSha,
      });
      hasChanges = true;
    }
  }

  // Re-derive pushSucceeded from branch reality so it covers both the
  // final-mile commit-and-push path and Claude's own push.
  pushSucceeded = finalUnpushedCount === 0 && hasChanges;

  // Read .pr_response_message if Claude created one (Issue #1458).
  // Used as the PR comment body when push succeeds, replacing the hardcoded
  // default with Claude's own summary of what it fixed.
  const customMessage = await readPrResponseMessage(processorDeps.workDir);

  // Detect escape-hatch invocation (Issue #1826). When Claude raises a
  // follow-up issue and posts a hand-off message instead of looping on a
  // genuinely out-of-scope request, treat the run as a successful
  // resolution and post Claude's own message rather than the neutral
  // "no changes" fallback. Surface needs-human in the run summary log.
  //
  // Issue #3661 (SEC-6287d379587c): the prose markers alone are a claim, not
  // evidence. Confirm the follow-up issue the message names actually exists
  // before recording the run as resolved; a definitively-absent issue falls
  // through to the ordinary reply path instead of silently suppressing it.
  //
  // Issue #185 (SEC-8f21c4a0e7b3): existence is forgeable — any actor whose
  // text reaches this prompt can steer the message into naming a real,
  // pre-existing issue. Also require GitHub's own record of *who filed it* to
  // be the worker, a fleet sibling, or an allowlisted author.
  const escapeHatch = detectEscapeHatch(customMessage, repo);
  const escapeHatchClient = escapeHatch.invoked
    ? deps.github.createClient(logger)
    : undefined;
  const followUp = escapeHatchClient
    ? await verifyFollowUpIssueExists({
      issueRef: escapeHatch.issueRef,
      currentRepo: repo,
      trustedAuthors: await loadTrustedFollowUpAuthors(
        deps,
        logger,
        processorDeps.githubUser,
      ),
      ghClient: escapeHatchClient,
      logger,
    })
    : { verified: false, reason: "no-ref" as const };
  if (escapeHatch.invoked && followUp.verified && escapeHatchClient) {
    logger.info("PR feedback escape hatch invoked", {
      repo,
      prNumber,
      issueRef: escapeHatch.issueRef,
      needsHuman: escapeHatch.needsHuman,
      verification: followUp.reason,
    });
    // Issue #2824: Claude builds the follow-up `gh issue create` itself, so the
    // worker cannot filter labels before creation. Strip any reserved label it
    // self-applied to that follow-up, after the fact. Non-fatal — never changes
    // the hand-off result. The deliberate `escalateToHuman` add of
    // `needs-human` to an existing issue (Issue #1471) runs elsewhere and is
    // untouched.
    //
    // Issue #3074: the follow-up ref is model output (untrusted). Pass the
    // monitored-repo allowlist so a cross-repo strip can only target a repo
    // the worker is configured for — an injected arbitrary `owner/repo#NNN`
    // is logged and skipped. Loading the allowlist is best-effort; on failure
    // the strip falls back to the current-repo-only secure default.
    //
    // Issue #3708: a failed strip is not a log line. The helper retries once
    // and returns a Result; a still-failing strip means the follow-up may
    // still carry the reserved label the guard exists to remove, so say so
    // loudly rather than letting the warning read as success.
    const stripResult = await stripReservedLabelsFromFollowUp({
      issueRef: escapeHatch.issueRef,
      currentRepo: repo,
      allowedRepos: await loadMonitoredReposBestEffort(deps, logger),
      excludeIssueNumber: prNumber,
      ghClient: escapeHatchClient,
      logger,
    });
    if (!stripResult.ok) {
      logger.error(
        "Reserved-label strip did not apply to the escape-hatch follow-up — " +
          "it may still carry a reserved label (Issue #3708)",
        {
          repo,
          prNumber,
          issueRef: escapeHatch.issueRef,
          error: stripResult.error.message,
        },
      );
    }
    await replyWithResult(repo, prNumber, deps, customMessage);
    return {
      ok: true,
      value: {
        processed: true,
        changesPushed: false,
        summary: escapeHatch.needsHuman
          ? `PR #${prNumber} feedback handed off via escape hatch (${
            escapeHatch.issueRef ?? "follow-up"
          }) — needs-human requested`
          : `PR #${prNumber} feedback handed off via escape hatch (${
            escapeHatch.issueRef ?? "follow-up"
          })`,
      },
    };
  }

  // Reply to comment — only claim "pushed" if push actually succeeded
  if (hasChanges && pushSucceeded) {
    await replyWithResult(repo, prNumber, deps, customMessage);
  } else if (hasChanges && !pushSucceeded) {
    await replyPushFailed(repo, prNumber, deps);
  } else {
    await replyNoChanges(
      repo,
      prNumber,
      deps,
      logger,
      input.failingCheckName,
      processedBody,
    );
  }

  const actuallyPushed = hasChanges && pushSucceeded;

  logger.info("PR feedback processing complete", {
    repo,
    prNumber,
    changesPushed: actuallyPushed,
  });

  return {
    ok: true,
    value: {
      processed: true,
      changesPushed: actuallyPushed,
      summary: actuallyPushed
        ? `Pushed fixes for PR #${prNumber} feedback`
        : hasChanges
        ? `Fixed PR #${prNumber} feedback locally but failed to push`
        : `Reviewed PR #${prNumber} feedback — no changes needed`,
    },
  };
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

async function replyWithResult(
  repo: string,
  prNumber: number,
  deps: WorkerDeps,
  customMessage?: string,
): Promise<void> {
  const body = customMessage ??
    "I've pushed a fix for this feedback. Please review the changes.";
  try {
    await deps.github.runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
  } catch {
    // Comment failure is non-critical
  }
}

async function replyPushFailed(
  repo: string,
  prNumber: number,
  deps: WorkerDeps,
): Promise<void> {
  try {
    await deps.github.runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      "I fixed the issues from this feedback locally but failed to push the changes. Please check the branch status.",
    ]);
  } catch {
    // Comment failure is non-critical
  }
}

async function replyNoChanges(
  repo: string,
  prNumber: number,
  deps: WorkerDeps,
  logger: Logger,
  failingCheckName: string | undefined,
  commentBody: string,
): Promise<void> {
  // Issue #1691: replace the dismissive fallback message with a
  // classifier-aware response. When a failing CI check is associated with
  // the feedback we route via the classifier; otherwise we use a neutral
  // "could not identify a code change" message.
  const classification = failingCheckName
    ? classifyCiFailure(failingCheckName, [], commentBody)
    : undefined;
  const response = buildFeedbackNoChangesResponse(classification);

  if (response.addNeedsHuman) {
    // Issue #2211: route via the shared escalateToHuman helper so the
    // label add and the explanation comment land atomically through a
    // single chokepoint. The classifier-derived explanation becomes the
    // `reason`; the reviewer instructions become the `nextStep`.
    await escalateToHuman({
      ghClient: createGhEscalationClient(deps.github.runGhCommand),
      repo,
      target: { kind: "pr", number: prNumber },
      needsHumanLabel: "needs-human",
      heading: "PR feedback needs human attention",
      reason: response.reason ?? response.body,
      nextStep: response.nextStep ?? PR_ESCALATION_NEXT_STEP,
      ensureLabelColour: "d4c5f9",
      ensureLabelDescription:
        "Worker could not produce a fix; human review required",
      deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
      logger,
    });
    return;
  }

  try {
    await deps.github.runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      response.body,
    ]);
  } catch {
    // Comment failure is non-critical
  }
}
