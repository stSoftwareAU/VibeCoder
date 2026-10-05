/**
 * PR feedback processor (Issue #967).
 *
 * Handles responding to PR review comments by checking out the PR branch,
 * building a feedback prompt, running Claude to fix issues, running a drift
 * check on the push, committing changes, pushing, and replying to the
 * comment.
 *
 * Migrated from work_on_pr_feedback() in issue_worker.sh.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, RepoConfig, Result } from "../types.ts";
import { browserGranted } from "./browser_grant.ts";
import type { WorkerDeps } from "./issue_worker_wiring.ts";
import { resolvePreFlightSpec } from "./git_push.ts";
import { type CommentType, removeProcessedMark } from "./pr_comments.ts";
import { getTokenEstimate } from "./claude_runner.ts";
import { fetchIssueData } from "./issue_data.ts";
import { fetchPrOwnerDirection } from "./owner_direction.ts";
import {
  buildPrFeedbackPrompt,
  type PrFeedbackPromptOptions,
} from "./prompt_builder.ts";
import { loadRepoContextContent } from "./repo_context_reader.ts";
import {
  collectGraftContext,
  describeGraftContext,
  type GraftContextCollector,
  type GraftContextResult,
  type GraftContextSlot,
  graftQueryForPr,
  withGraftContext,
} from "./graft_context.ts";
import { prTitleForGraftQuery } from "./pr_title_read.ts";
import type { CodegraphContextResult } from "./codegraph_context.ts";
import { prepareCodegraphRun } from "./codegraph_run.ts";
import { type RtkOutputResult, settingsJsonOption } from "./rtk_output.ts";
import { bindGraftRun } from "./graft_run.ts";
import { claimPrComment } from "./claim_pr_comment.ts";
import { guardPrStillOpen, prLiveSkipReason } from "./pr_live_state.ts";
import type { AlertDedupAuthorOptions } from "./alert_dedup_authors.ts";
import {
  preparePrBranch,
  prResponseMessagePath,
  readPrResponseMessage,
} from "./pr_branch_preparation.ts";
import { retryReplyPlaceholdersOnce } from "./result_placeholder_gate.ts";
import {
  DRIFT_CHECK_DISALLOWED_TOOLS,
  runPrFeedbackDriftCheck,
} from "./pr_feedback_drift_check.ts";
import { assessGatedHead } from "./gated_head_guard.ts";
import {
  milestoneFixBranchFor,
  raiseMilestoneFixPr,
} from "./milestone_fix_pr.ts";
import {
  type HeartbeatHandle,
  startHeartbeat,
  stopHeartbeat,
} from "./heartbeat.ts";
import { classifyCiFailure } from "./ci_failure_classifier.ts";
import {
  formatVerifiedPushSuffix,
  type PushVerification,
  verifyPushLanded,
} from "./push_claim_verification.ts";
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
import { noteAgentRunWorkItem } from "./handler_watchdog.ts";
import { runPrBodySync, syncPrBodyFromSummary } from "./pr_body_sync.ts";
import { getRunId } from "./run_id.ts";
import {
  buildReviewerNoChangeEscalation,
  isReviewerChangeRequest,
  MAX_REVIEWER_NO_CHANGE_ATTEMPTS,
  probeAgentAnswer,
  REVIEWER_NO_CHANGE_RETRY_NOTE,
} from "./pr_feedback_reviewer_no_change.ts";

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
  /**
   * What the Graft repo-context collection did this run (Issue #2103, part of
   * #2060) — `off` on a host that has not opted in.
   *
   * Present only on a run that reached the collection: a PR closed since the
   * listing, a comment another worker claimed, or a failed branch checkout all
   * return before a prompt is built. Never carries the bundle itself.
   */
  graftContext?: GraftContextResult;
  /**
   * What this run's CodeGraph step produced (Issue #2160, part of #2145).
   *
   * Present on every **successful** outcome reached after the index step —
   * `off` on a host whose switch is down, `unsupported` on a Gemini-routed
   * run, and `ok` or `failed` otherwise, carrying `queries` once the run's
   * tool tally was read. A run that returns an error has no result object to
   * carry it; the one status line is logged either way, which is where the
   * trial reads a failed run's figure from.
   */
  codegraphContext?: CodegraphContextResult;
  /**
   * What this run's RTK output filter did (Issue #2384, part of #2328).
   *
   * Present on every **successful** outcome reached after the preparation,
   * for the same reason as {@link codegraphContext}, carrying `savedTokens`
   * once the gain store was read a second time.
   */
  rtkOutput?: RtkOutputResult;
}

/** Dependencies specific to the feedback processor. */
export interface PrFeedbackProcessorDeps {
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Worker deps for cross-cutting concerns. */
  deps: WorkerDeps;
  /** Working directory for repo operations. */
  workDir: string;
  /**
   * The `WORK_DIR` root where heartbeat and marker state files live — never a
   * clone (Issue #1662).
   *
   * Kept separate from {@link PrFeedbackProcessorDeps.workDir}, which is the
   * clone every git and agent `cwd` uses. It cannot be derived from the
   * clone's parent: a lane worktree sits at `<workRoot>/worktrees/<lane>/<repo>`,
   * so `dirname` names the lane, not the root.
   */
  workRoot: string;
  /**
   * Fleet identity inputs for the PR-comment claim's author check
   * (Issue #1124). Omitted reads the configured fleet, which is what
   * production does; a test states the fleet instead of writing a config
   * file.
   */
  claimAuthorOptions?: AlertDedupAuthorOptions;
  /**
   * Override the remote push verification (Issue #579). Injected by tests so
   * the "a failed push produces no success claim" regression can be exercised
   * without a repository; production leaves it undefined.
   */
  verifyPushFn?: (
    branchName: string,
    options?: { cwd?: string },
  ) => Promise<PushVerification>;
  /** Quality instructions for the prompt. */
  qualityInstructions?: string;
  /** Custom repo-specific instructions. */
  customInstructions?: string;
  /**
   * Whether to index the checkout with CodeGraph and offer the agent that
   * index (Issue #2160, part of #2145, default: false).
   *
   * Threaded from `config.codegraphContext.enabled` by the production wiring.
   * Off, the run spawns nothing and its prompt and MCP configuration are
   * byte-identical to a run from before the trial existed.
   */
  codegraphContextEnabled?: boolean;
  /**
   * Whether to condense the run's Bash output with RTK (Issue #2384, part of
   * #2328, default: false).
   *
   * Threaded from `config.rtkOutput.enabled` by the same production wiring
   * site that supplies {@link codegraphContextEnabled}. Off, the run spawns
   * nothing and its argv and prompt are byte-identical to a run from before
   * the trial existed.
   */
  rtkOutputEnabled?: boolean;
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
   * The trust lists that decide whose comments on the linked issue and its
   * milestone parent count as owner direction (Issue #3205). Omitted → no
   * owner direction is fetched, and the prompt is as it was.
   */
  ownerDirectionAuthors?: {
    allowedAuthors: readonly string[];
    authorisedCommenters: readonly string[];
  };
  /**
   * Override the owner-direction fetch (Issue #3205). Injected by tests;
   * production leaves it undefined and gets {@link fetchPrOwnerDirection}
   * over this run's `gh`.
   */
  fetchOwnerDirectionFn?: typeof fetchPrOwnerDirection;
  /**
   * Per-repo configuration map, used to resolve the pre-flight enforcement
   * gate (Issue #3577). Omitted → no gate.
   */
  repoConfigs?: Record<string, RepoConfig>;
  /**
   * Prompts directory the feedback template is read from (Issue #1024).
   *
   * Left unset in production, where `getPromptsDir()` resolves it from the
   * launcher's environment. A test names its own checkout's `prompts/` here
   * instead of deleting `PROMPTS_DIR`/`VIBE_BASE_DIR` from the process every
   * other parallel worker shares.
   */
  promptsDir?: string;
  /**
   * Whether this host collects a Graft repo-context bundle (Issue #2103,
   * part of #2060, default: false).
   *
   * Threaded from `config.graftContext.enabled` by the dispatchers, which
   * read it through `isGraftContextEnabled()`. Off, the collector returns
   * `off` without spawning anything, so a host that never opted in behaves
   * exactly as it does today.
   */
  graftContextEnabled?: boolean;
  /**
   * Collect the Graft repo-context bundle (Issue #2103). Optional —
   * {@link collectGraftContext} is used when omitted, and it spawns nothing
   * while the host switch is off.
   */
  collectGraftContext?: GraftContextCollector;
  /**
   * Override the PR body refresh after a successful push (Issue #3089).
   * Injected by tests; production leaves it undefined and gets
   * {@link syncPrBodyFromSummary}.
   */
  syncPrBodyFn?: typeof syncPrBodyFromSummary;
  /**
   * Configured worker name, used in the refreshed PR body's footer
   * (Issue #3089). Omitted → empty string.
   */
  workerName?: string;
  /**
   * Override the post-agent drift check (Issue #3143). Injected by tests;
   * production leaves it undefined and gets {@link runPrFeedbackDriftCheck}.
   */
  driftCheckFn?: typeof runPrFeedbackDriftCheck;
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

/**
 * Collect the Graft repo-context bundle for one feedback run (Issue #2103).
 *
 * The query is the PR title plus the feedback text the processor already
 * assembled. The title costs one `gh pr view`, so it is read **only** on an
 * enabled host — a host with the switch off makes no extra API call and the
 * collector short-circuits to `off` without spawning anything. A title that
 * cannot be read is warned about and dropped: the bundle is an accelerator,
 * and a degraded query beats no bundle at all.
 *
 * @param input - The feedback input, for the repo and PR number
 * @param processorDeps - Processor dependencies (switch, seams, logger)
 * @param feedbackText - The feedback comment text, as the prompt will carry it
 * @returns The collection outcome — never throws
 */
async function collectGraftForFeedback(
  input: PrFeedbackInput,
  processorDeps: PrFeedbackProcessorDeps,
  feedbackText: string,
): Promise<GraftContextResult> {
  const { repo, prNumber } = input;
  const { logger, deps } = processorDeps;
  const enabled = processorDeps.graftContextEnabled ?? false;
  const collect = processorDeps.collectGraftContext ?? collectGraftContext;

  const prTitle = enabled
    ? await prTitleForGraftQuery({
      repo,
      prNumber,
      gh: (args: string[]) => deps.github.runGhCommand(args),
      logger,
    })
    : undefined;

  return await collect({
    // `workDir` already is the checkout, with the PR head branch on it
    // (Issue #1673) — never `${workDir}/${repo}`.
    repoDir: processorDeps.workDir,
    query: graftQueryForPr(prTitle, feedbackText),
    enabled,
    logger,
  });
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
  // Issue #2720: the watchdog's abandonment line names this item.
  noteAgentRunWorkItem(`${repo}#${prNumber} ${commentType} ${commentId}`);

  // Issue #1774: the comment was found in a listing up to 10 minutes old, and
  // claiming it writes to the PR. Re-read the live state first — a PR closed
  // since the listing gets no claim comment, no reply and no reaction.
  const liveState = await guardPrStillOpen({
    repo,
    prNumber,
    pass: "review feedback",
    gh: (args: string[]) => deps.github.runGhCommand(args),
    logger,
  });
  if (!liveState.open) {
    return {
      ok: true,
      value: {
        processed: false,
        changesPushed: false,
        summary: `PR #${prNumber} comment #${commentId} — ${
          prLiveSkipReason(liveState)
        }`,
      },
    };
  }

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
      ...(processorDeps.claimAuthorOptions !== undefined
        ? { authorOptions: processorDeps.claimAuthorOptions }
        : {}),
      log: (message: string) => logger.warn(message, { repo, prNumber }),
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
    // A PR, not an issue (Issue #391) — see pr_merge_conflict_processor.
    kind: "pr",
    // Issue #1662: the work root, never the clone — `.heartbeat_*` and
    // `.heartbeat-marker_*` written into the clone dirty its tree and stay
    // invisible to stuck recovery and the prune liveness check, which both
    // read the root. `stopHeartbeat` reuses these options, so the final
    // `clearHeartbeat` follows.
    workDir: processorDeps.workRoot,
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

  // Filled once the run reaches the collection (Issue #2103); every exit
  // above returns before a prompt is built and leaves it unset.
  const graftSlot: GraftContextSlot = {};
  // The body returns from a dozen places; the CodeGraph outcome is attached
  // here instead, so every successful one carries it (Issue #2160).
  // The RTK outcome rides the same carrier (Issue #2384).
  const carrier: FeedbackRunCarrier = {};
  try {
    const result = await _processFeedbackWithHeartbeat(
      input,
      processorDeps,
      graftSlot,
      carrier,
    );
    const withGraft = withGraftContext(result, graftSlot);
    return withGraft.ok && (carrier.codegraphContext || carrier.rtkOutput)
      ? {
        ok: true,
        value: {
          ...withGraft.value,
          ...(carrier.codegraphContext
            ? { codegraphContext: carrier.codegraphContext }
            : {}),
          ...(carrier.rtkOutput ? { rtkOutput: carrier.rtkOutput } : {}),
        },
      }
      : withGraft;
  } finally {
    await stopHeartbeat(heartbeatHandle);
  }
}

/** What the body hands back to every one of its successful return paths. */
interface FeedbackRunCarrier {
  codegraphContext?: CodegraphContextResult;
  /** Issue #2384: `record()` writes `savedTokens` into this same object. */
  rtkOutput?: RtkOutputResult;
}

/**
 * Inner feedback processing logic, separated to allow heartbeat
 * lifecycle management in the outer function (Issue #1204).
 */
async function _processFeedbackWithHeartbeat(
  input: PrFeedbackInput,
  processorDeps: PrFeedbackProcessorDeps,
  graftSlot: GraftContextSlot,
  carrier: FeedbackRunCarrier,
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
    codegraphContextEnabled = OPERATIONAL_DEFAULTS.codegraphContext.enabled,
    rtkOutputEnabled = OPERATIONAL_DEFAULTS.rtkOutput.enabled,
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
  const prepared = await preparePrBranch(input.branchName, {
    logger,
    git: deps.git,
    cwd: processorDeps.workDir,
  });
  if (!prepared.ok) {
    // Mirrors the CI path (pr_ci_processor.ts): never run the agent — or cut
    // a gated-head fix branch — from an unverified HEAD. Without this check,
    // a `branch_held` worktree (Issue #1677) stays on the previous task's
    // branch, `checkout -B <fixBranch>` cuts the fix branch from that wrong
    // HEAD, and a gated head turns what used to be a GH013-refused push into
    // a raised, auto-merge-armed PR carrying an unrelated branch's commits.
    logger.warn(
      `PR feedback skipped for PR #${prNumber}: PR branch '${input.branchName}' ${
        prepared.reason === "branch_missing"
          ? "no longer exists on origin (merged or closed?)"
          : prepared.reason === "branch_held"
          ? "is checked out in another worktree on this host — not the PR's " +
            "fault (Issue #1677)"
          : "could not be checked out"
      } — ${prepared.detail}`,
    );
    // Issue #2909 review: `claimPrComment` already won the claim and left
    // the eyes reaction before this point runs, and `findActionableComment`
    // skips eyes-reacted comments — so returning here with only a log line
    // left a `branch_held`/`checkout_failed` refusal answered by nobody,
    // forever (Issue #2269 exists to stop exactly that). `branch_missing`
    // is different: the PR merged or closed, so there is nothing left to
    // answer and the mark is moot. For the other two, take the mark back so
    // the next scan rediscovers and retries the comment once the
    // contention clears — mirroring how the CI path (pr_ci_processor.ts)
    // relies on the failing check run being rediscovered next cycle.
    if (prepared.reason !== "branch_missing") {
      const markError = await removeProcessedMark(
        repo,
        commentType,
        commentId,
        (args: string[]) => deps.github.runGhCommand(args),
        (message: string) => logger.warn(message, { repo, prNumber }),
      );
      if (markError) {
        // Issue #2909 review (round 2): a `pr_review` mark is a dismissed
        // review — GitHub offers no un-dismissal, so `removeProcessedMark`
        // always errors here — and a failed reaction DELETE errors too. In
        // both cases the next scan will never rediscover this comment, so
        // the only way to answer it is a direct reply now.
        logger.warn(
          "Could not release the eyes reaction after a branch-prepare " +
            "failure — replying directly since the comment will not be " +
            "rediscovered",
          { repo, prNumber, commentId, error: markError.message },
        );
        await replyBranchPrepareFailed(
          repo,
          prNumber,
          deps,
          input.branchName,
          prepared.detail,
        );
      }
    }
    return {
      ok: true,
      value: {
        processed: false,
        changesPushed: false,
        summary:
          `PR branch '${input.branchName}' unavailable (${prepared.reason})`,
      },
    };
  }

  // Issue #2907: a milestone PR's head can itself be a ruleset-gated
  // `milestone/**` branch — the fleet account cannot push to it directly
  // (GH013), so a fix pass that commits and pushes straight to it always
  // fails after Claude has already run. Detect that *before* running Claude,
  // and move the work to a side branch this fix lands via a PR into the
  // gated head instead (mirrors the milestone sync PR, Issue #589).
  const gatedHeadAssessment = await assessGatedHead(
    repo,
    input.branchName,
    (args: string[]) => deps.github.runGhCommand(args),
  );
  let fixBranch: string | undefined;
  if (gatedHeadAssessment.gated) {
    logger.info(
      "PR feedback: head is gated, working on a fix branch instead",
      { repo, prNumber, branchName: input.branchName },
    );
    fixBranch = milestoneFixBranchFor(
      input.branchName,
      prNumber,
      `feedback-${commentId}`,
    );
    const checkoutResult = await deps.git.runGitCommand(
      ["checkout", "-B", fixBranch],
      { cwd: processorDeps.workDir },
    );
    if (!checkoutResult.ok || checkoutResult.value.code !== 0) {
      const detail = checkoutResult.ok
        ? checkoutResult.value.stderr.trim()
        : checkoutResult.error.message;
      logger.error(
        "PR feedback: could not check out the fix branch for a gated head — " +
          "standing down rather than running Claude on it",
        { repo, prNumber, fixBranch, error: detail },
      );
      await replyGatedCheckoutFailed(
        repo,
        prNumber,
        deps,
        fixBranch,
        input.branchName,
        detail,
      );
      return {
        ok: true,
        value: {
          processed: false,
          changesPushed: false,
          summary:
            `PR #${prNumber} feedback: could not check out fix branch '${fixBranch}' for gated head '${input.branchName}'`,
        },
      };
    }
  }
  const pushBranch = fixBranch ?? input.branchName;

  // Capture HEAD SHA before Claude runs (Issue #1862, part of #1855).
  // Claude may commit and push during its own run, leaving
  // commitAndPushPending with nothing to do — the old derivation of
  // hasChanges from commitAndPushPending alone missed Claude's own pushes
  // and produced a misleading "could not identify a code change" reply.
  // We compare HEAD before vs after to recognise self-pushed commits.
  const beforeHeadResult = await deps.git.captureBranchHead(pushBranch, {
    cwd: processorDeps.workDir,
  });
  const beforeSha = beforeHeadResult.ok ? beforeHeadResult.value : undefined;
  if (!beforeHeadResult.ok) {
    logger.warn("captureBranchHead failed before Claude run", {
      branch: pushBranch,
      error: beforeHeadResult.error.message,
    });
  }

  // Read repo context (CLAUDE.md/AGENTS.md) for prompt injection (Issue #1325).
  // `workDir` already is the checkout, so it is read directly — appending the
  // repo name looked one level too deep and injected nothing (Issue #1673).
  const repoContextContent = await loadRepoContextContent(
    processorDeps.workDir,
    logger,
  );

  // Graft repo-context bundle (Issue #2103, part of #2060). Off on a host
  // that has not opted in — the collector returns `off` without spawning. A
  // `failed` collection is reported and the feedback run proceeds unbundled.
  // The graph is built over the checkout itself (Issue #1673), which is the
  // PR head branch `preparePrBranch` put there — hence the untrusted fence
  // the builder renders the bundle behind.
  const graftContext = await collectGraftForFeedback(
    input,
    processorDeps,
    processedBody,
  );
  graftSlot.result = graftContext;
  if (graftContext.status !== "off") {
    logger.info(describeGraftContext(graftContext), { repo, prNumber });
  }

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

  // Owner direction posted after the branch began (Issue #3205): the
  // trusted-author comments on the linked issue and its milestone parent, or
  // on a milestone PR's tracking issue. A failed fetch yields no section.
  const ownerDirection = processorDeps.ownerDirectionAuthors
    ? await (processorDeps.fetchOwnerDirectionFn ?? fetchPrOwnerDirection)(
      {
        repo,
        branchName: input.branchName,
        ...processorDeps.ownerDirectionAuthors,
        ...(processorDeps.githubUser
          ? { workerLogin: processorDeps.githubUser }
          : {}),
      },
      (r, n) => fetchIssueData(r, n, (args) => deps.github.runGhCommand(args)),
    )
    : "";

  // Build prompt
  const promptOptions: PrFeedbackPromptOptions = {
    repo,
    prNumber: String(prNumber),
    commentBody: processedBody,
    qualityInstructions,
    customInstructions,
    repoContextContent,
    // Present only on an `ok` collection (Issue #2103); the builder renders
    // nothing when it is undefined.
    graftContextBundle: graftContext.bundle,
    additionalReviewComments: additionalReviewComments?.ok
      ? additionalReviewComments.value
      : undefined,
    ...(ownerDirection ? { ownerDirection } : {}),
    promptsDir: processorDeps.promptsDir,
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

  // --- CodeGraph repo-context index (Issue #2160, part of #2145) ---
  // The checkout the agent runs in, which is also the `cwd` below — without
  // one the runner writes no MCP configuration at all. Off, this spawns
  // nothing and the invocation is byte-identical to the one this processor
  // always made; on and indexed, it gains the `codegraph` MCP entry and the
  // single prompt line together, never one alone.
  const codegraph = await prepareCodegraphRun({
    repoDir: processorDeps.workDir,
    enabled: codegraphContextEnabled,
    logger,
    prepare: deps.claude.prepareCodegraphContext,
  });
  carrier.codegraphContext = codegraph.result;
  // Issue #2314: the pull side of Graft, beside CodeGraph's.
  const graft = bindGraftRun({
    result: graftContext,
    repoDir: processorDeps.workDir,
    logger,
  });

  // --- RTK shell-output filtering (Issue #2384, part of #2328) ---
  // Installed per spawn, so nothing is written to `~/.claude/settings.json`.
  // The invocation below passes no provider selector, so both name the run's
  // active provider. Off — or on a provider that takes no hooks — this spawns
  // nothing and the argv and prompt are the ones they always were; the hook
  // and its prompt line travel together, and losing RTK never fails the run.
  const rtk = await deps.claude.prepareRtkRun({
    enabled: rtkOutputEnabled,
    providerId: deps.claude.rtkProviderId(undefined, logger),
    logger,
    cwd: processorDeps.workDir,
  });
  carrier.rtkOutput = rtk.result;

  // Execute Claude in the target repo directory (Issue #1297)
  const agentStartMs = Date.now();
  const agentRequest = {
    // Appended in code, not in `prompts/pr_feedback/prompt.md`: the line is
    // run-conditional, so the template stays the same on every host.
    // RTK's line goes outermost, so it is the last thing the agent reads.
    prompt: rtk.applyPrompt(
      graft.applyPrompt(codegraph.applyPrompt(userPrompt)),
    ),
    systemPrompt,
    timeoutSeconds: claudeTimeout,
    noOutputTimeout: claudeNoOutputTimeout,
    phase: "pr_feedback",
    cwd: processorDeps.workDir,
    logger,
    // The browser unless `skip_screenshot_check` (Issue #2925): a review
    // asking for screenshots needs it. CodeGraph and Graft ride beside it
    // only when their index built.
    ...graft.mcpConfigOption(
      codegraph.mcpConfig(browserGranted(processorDeps.repoConfigs, repo)),
    ),
    // Issue #2384: absent unless RTK's hook is installed, so every other
    // run spawns the argv it always did.
    ...settingsJsonOption(undefined, rtk.hookSettings()),
  };
  const claudeResult = await deps.claude.runClaudeWithRetry(agentRequest, {
    maxRetries: maxRateLimitRetries,
  });
  if (claudeResult.ok) codegraph.record(claudeResult.value.runStats);
  if (claudeResult.ok) graft.record(claudeResult.value.runStats);
  // Issue #2384: the saved-token figure, read whether or not the invocation
  // succeeded — the hook ran either way. Never throws.
  await rtk.record();

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

  // In-run retry for an unanswered request-changes review (Issue #3246). A
  // `pr_review` claim dismisses the review, and a dismissal cannot be
  // undone, so a later cycle can never retry it — give the agent a second
  // run inside this one before the worker falls back to the neutral reply
  // or escalates.
  let reviewerAttempts = 1;
  let lastAttempt = {
    exitCode: claudeResult.value.exitCode,
    durationSeconds: Math.round((Date.now() - agentStartMs) / 1000),
  };
  while (
    isReviewerChangeRequest(commentType) &&
    reviewerAttempts < MAX_REVIEWER_NO_CHANGE_ATTEMPTS
  ) {
    const answer = await probeAgentAnswer({
      readResponseMessage: async () => {
        try {
          return await Deno.readTextFile(
            prResponseMessagePath(processorDeps.workDir),
          );
        } catch {
          return undefined;
        }
      },
      headMoved: async () => {
        if (beforeSha === undefined) return undefined;
        const moved = await deps.git.branchHeadChanged(beforeSha, pushBranch, {
          cwd: processorDeps.workDir,
        });
        return moved.ok ? moved.value : undefined;
      },
      workingTreeStatus: async () => {
        const status = await deps.git.runGitCommand(
          ["status", "--porcelain"],
          { cwd: processorDeps.workDir },
        );
        return status.ok && status.value.code === 0
          ? status.value.stdout
          : undefined;
      },
    });
    if (answer !== "nothing") {
      if (answer === "unknown") {
        logger.warn(
          "PR feedback: could not tell whether the run answered the " +
            "review, so it is not re-run (Issue #3246)",
          { repo, prNumber, reviewId: commentId },
        );
      }
      break;
    }
    logger.warn(
      "PR feedback: request-changes review ended with no fix and no " +
        "rebuttal — re-running the agent (Issue #3246)",
      {
        repo,
        prNumber,
        reviewId: commentId,
        attempt: reviewerAttempts,
        exitCode: lastAttempt.exitCode,
        durationSeconds: lastAttempt.durationSeconds,
      },
    );
    reviewerAttempts++;
    const retryStartMs = Date.now();
    const retry = await deps.claude.runClaudeWithRetry(
      {
        ...agentRequest,
        prompt: `${agentRequest.prompt}\n\n${REVIEWER_NO_CHANGE_RETRY_NOTE}`,
      },
      { maxRetries: maxRateLimitRetries },
    );
    lastAttempt = {
      exitCode: retry.ok ? retry.value.exitCode : -1,
      durationSeconds: Math.round((Date.now() - retryStartMs) / 1000),
    };
    if (!retry.ok || retry.value.timedOut) {
      logger.error(
        "PR feedback: the re-run on the request-changes review failed " +
          "(Issue #3246)",
        {
          repo,
          prNumber,
          reviewId: commentId,
          error: retry.ok ? "timed out" : retry.error.message,
        },
      );
      break;
    }
  }

  // Result-placeholder reply recovery (Issue #3124): one in-run retry when
  // Claude's own `.pr_response_message` still carries a bare fill-in-later
  // token where a command's result belongs. Peeking here — before the file
  // is consumed by `readPrResponseMessage` further down this run, and by
  // every other reply consumer that reads through that same chokepoint —
  // gives the agent one chance to supply the actual outcome itself; a token
  // still left afterwards falls through to that chokepoint's fail-loud
  // backstop. The peek reads without consuming the file, and a failed or
  // exhausted retry here must not abort an otherwise-successful feedback run.
  await retryReplyPlaceholdersOnce(
    prResponseMessagePath(processorDeps.workDir),
    {
      readFile: async (path) => {
        try {
          return await Deno.readTextFile(path);
        } catch {
          return undefined;
        }
      },
      runAgent: async (prompt) => {
        const retryResult = await deps.claude.runClaudeWithRetry(
          {
            prompt,
            systemPrompt,
            timeoutSeconds: claudeTimeout,
            noOutputTimeout: claudeNoOutputTimeout,
            phase: "pr_feedback",
            cwd: processorDeps.workDir,
            logger,
          },
          { maxRetries: maxRateLimitRetries },
        );
        if (!retryResult.ok) {
          return { ok: false, error: retryResult.error };
        }
        return { ok: true };
      },
      logger,
    },
  );

  // Post-agent drift check (Issue #3143): review-fix pushes have kept
  // leaving the PR summary (or a manual) contradicting the code they just
  // changed — the prompt's own prose rules against this (#3114, #3117,
  // #3120) go unchecked on this path. Run it here, before the commit-and-
  // push below, so a recovery-turn edit rides the same push and a residual
  // hit reaches the reply through `.pr_response_message`, read later by
  // `readPrResponseMessage`. Wrapped so an unexpected throw never aborts an
  // otherwise-successful run — the check is a backstop, not a gate.
  try {
    const driftCheck = processorDeps.driftCheckFn ?? runPrFeedbackDriftCheck;
    const driftOutcome = await driftCheck(
      { repo, prNumber, repoPath: processorDeps.workDir, beforeSha },
      {
        runGit: async (args: string[]) => {
          const r = await deps.git.runGitCommand(args, {
            cwd: processorDeps.workDir,
          });
          return r.ok ? r.value : null;
        },
        runGh: (args: string[]) => deps.github.runGhCommand(args),
        runAgent: async (req: { prompt: string; readOnly: boolean }) => {
          const r = await deps.claude.runClaudeWithRetry(
            {
              prompt: req.prompt,
              timeoutSeconds: claudeTimeout,
              noOutputTimeout: claudeNoOutputTimeout,
              phase: "pr_feedback",
              cwd: processorDeps.workDir,
              logger,
              ...(req.readOnly
                ? { disallowedTools: [...DRIFT_CHECK_DISALLOWED_TOOLS] }
                : { systemPrompt }),
            },
            { maxRetries: maxRateLimitRetries },
          );
          if (!r.ok) return { ok: false, error: r.error };
          if (r.value.timedOut) {
            return { ok: false, error: new Error("timed out") };
          }
          return { ok: true, output: r.value.output ?? "" };
        },
        logger,
      },
    );
    logger.info("PR feedback drift check (Issue #3143)", {
      repo,
      prNumber,
      status: driftOutcome.status,
    });
  } catch (error) {
    logger.error(
      "PR feedback drift check failed — continuing to commit and push " +
        "without it (Issue #3143)",
      {
        repo,
        prNumber,
        error: error instanceof Error ? error.message : String(error),
      },
    );
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
    pushBranch,
    `Address PR #${prNumber} feedback\n\nAutomated final-mile commit (Issue #1643).`,
    { cwd: processorDeps.workDir },
    false,
    preFlight,
  );

  let pushSucceeded = false;
  let hasChanges = false;
  // Issue #579: `undefined` means NOT MEASURED, which is not the same as
  // measured-and-zero. Initialising this to 0 is what let a failed push
  // helper produce `finalUnpushedCount === 0` and, with a local commit
  // moving HEAD, a confident "fixed and pushed" for a push that never ran.
  let finalUnpushedCount: number | undefined;
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
        pushBranch,
        { cwd: processorDeps.workDir },
      );
      // Issue #211: keep the reason the recovery failed — it names the step
      // (fetch, merge conflict, rejected retry push, unconfirmed push)
      // and carries git's stderr. Without it the log said only "push failed"
      // and the human got "please check the branch status" with no cause.
      let failureDetail = recoveryResult.ok
        ? undefined
        : recoveryResult.error.message;
      if (recoveryResult.ok) {
        const retryFinalise = await deps.git.commitAndPushPending(
          pushBranch,
          `Address PR #${prNumber} feedback\n\nRetry after push recovery (Issue #1643).`,
          { cwd: processorDeps.workDir },
          false,
          preFlight,
        );
        if (retryFinalise.ok) {
          finalUnpushedCount = retryFinalise.value.finalUnpushedCount;
          if (retryFinalise.value.finalUnpushedCount === 0) {
            hasChanges = true;
          } else {
            failureDetail =
              `retry after push recovery left ${finalUnpushedCount} commit(s) unpushed`;
          }
        } else {
          failureDetail = retryFinalise.error.message;
        }
      }
      if (finalUnpushedCount > 0) {
        logger.error("Push failed after recovery attempt", {
          repo,
          prNumber,
          recoveryStep: recoveryResult.ok ? "retry-push" : "recovery",
          detail: failureDetail ?? "no detail reported",
        });
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
      pushBranch,
      { cwd: processorDeps.workDir },
    );
    if (movedResult.ok && movedResult.value) {
      logger.info("Branch HEAD moved during Claude run", {
        branch: pushBranch,
        beforeSha,
      });
      hasChanges = true;
    }
  }

  // Re-derive pushSucceeded from branch reality so it covers both the
  // final-mile commit-and-push path and Claude's own push.
  //
  // Issue #579: local state cannot answer "did it land?". A local commit
  // moves HEAD whether or not the push ran, and an unpushed count that was
  // never taken is not a count of zero. The claim is therefore made against
  // the REMOTE, and an unreachable remote — the incident's exact condition —
  // is never a success.
  const localLooksPushed = finalUnpushedCount === 0 && hasChanges;
  let pushVerification: PushVerification | undefined;
  if (localLooksPushed) {
    const verifyFn = processorDeps.verifyPushFn ?? verifyPushLanded;
    pushVerification = await verifyFn(pushBranch, {
      ...(processorDeps.workDir !== undefined
        ? { cwd: processorDeps.workDir }
        : {}),
    });
    pushSucceeded = pushVerification.landed;
    if (!pushSucceeded) {
      logger.error(
        "Local state looked pushed but the remote does not agree — not claiming success",
        {
          repo,
          prNumber,
          branch: pushBranch,
          reason: pushVerification.reason,
        },
      );
    } else {
      logger.info("Push verified against the remote", {
        repo,
        prNumber,
        branch: pushBranch,
        remoteSha: pushVerification.remoteSha,
      });
    }
  } else {
    pushSucceeded = false;
    if (hasChanges) {
      logger.warn("Changes exist but the push was not confirmed locally", {
        repo,
        prNumber,
        branch: pushBranch,
        finalUnpushedCount: finalUnpushedCount ?? "not measured",
      });
    }
  }

  // Refresh the PR body from a rewritten summary file (Issue #3089). Only
  // on the PR's own branch — a fix branch's push is not yet visible on the
  // PR head, so there is nothing to refresh until the fix PR lands.
  if (pushSucceeded && hasChanges && fixBranch === undefined) {
    const syncFn = processorDeps.syncPrBodyFn ?? syncPrBodyFromSummary;
    await runPrBodySync(
      {
        repo,
        prNumber,
        repoPath: processorDeps.workDir,
        beforeSha,
        workerName: processorDeps.workerName ?? "",
        githubUser: processorDeps.githubUser ??
          Deno.env.get("GITHUB_USER") ?? "",
        runId: getRunId(),
      },
      {
        runGhCommand: (args: string[]) => deps.github.runGhCommand(args),
        runGitCommand: deps.git.runGitCommand,
        logger,
      },
      syncFn,
    );
  }

  // Read .pr_response_message if Claude created one (Issue #1458).
  // Used as the PR comment body when push succeeds, replacing the hardcoded
  // default with Claude's own summary of what it fixed.
  const customMessage = await readPrResponseMessage(
    processorDeps.workDir,
    logger,
  );

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

  // Issue #2907: a verified successful push on a fix branch is not the end
  // of the job — the fix branch is not this PR's head, so the change is not
  // yet visible on it. Raise (or reuse) a PR from the fix branch into the
  // gated milestone head to deliver it.
  let fixPr: { number: number; url: string } | undefined;
  let fixPrError: string | undefined;
  if (fixBranch && hasChanges && pushSucceeded) {
    const fixPrResult = await raiseMilestoneFixPr({
      repo,
      milestoneBranch: input.branchName,
      milestonePrNumber: prNumber,
      fixBranch,
      pass: "review feedback",
    }, {
      gh: (args: string[]) => deps.github.runGhCommand(args),
      log: (m: string) => logger.info(m),
      warn: (m: string) => logger.warn(m),
    });
    if (fixPrResult.ok) {
      fixPr = fixPrResult.value;
    } else {
      fixPrError = fixPrResult.error.message;
      logger.error(
        "PR feedback: pushed to the fix branch but could not raise the fix PR " +
          "into the gated head",
        { repo, prNumber, fixBranch, error: fixPrError },
      );
    }
  }

  // Issue #3246: set when this run escalates an unanswered request-changes
  // review to `needs-human`, so the summary below can say so.
  let reviewerEscalated = false;

  // Reply to comment — only claim "pushed" if push actually succeeded
  if (hasChanges && pushSucceeded && fixBranch && fixPrError) {
    await replyFixPrRaiseFailed(
      repo,
      prNumber,
      deps,
      fixBranch,
      input.branchName,
      fixPrError,
    );
  } else if (hasChanges && pushSucceeded) {
    await replyWithResult(
      repo,
      prNumber,
      deps,
      customMessage,
      pushVerification,
      fixPr
        ? `The fix was delivered through PR #${fixPr.number} (${fixPr.url}) ` +
          `into the gated branch '${input.branchName}'.`
        : undefined,
    );
  } else if (hasChanges && !pushSucceeded) {
    await replyPushFailed(repo, prNumber, deps, pushVerification);
  } else if (
    isReviewerChangeRequest(commentType) && customMessage !== undefined
  ) {
    // Issue #3246: the agent's rebuttal answers the review — post it, never
    // the neutral reply.
    await replyWithResult(repo, prNumber, deps, customMessage);
  } else if (isReviewerChangeRequest(commentType)) {
    // Issue #3246: no fix and no rebuttal after every in-run attempt — a
    // dismissed review cannot be rediscovered next cycle, so escalate now
    // rather than post the neutral "could not identify a code change" reply.
    logger.error(
      "PR feedback: request-changes review left unanswered after every " +
        "in-run attempt — escalating to needs-human (Issue #3246)",
      {
        repo,
        prNumber,
        reviewId: commentId,
        attempts: reviewerAttempts,
        lastExitCode: lastAttempt.exitCode,
        lastDurationSeconds: lastAttempt.durationSeconds,
      },
    );
    const escalation = buildReviewerNoChangeEscalation({
      reviewId: commentId,
      attempts: reviewerAttempts,
      lastExitCode: lastAttempt.exitCode,
      lastDurationSeconds: lastAttempt.durationSeconds,
    });
    const escalated = await escalateToHuman({
      ghClient: createGhEscalationClient(deps.github.runGhCommand),
      repo,
      target: { kind: "pr", number: prNumber },
      needsHumanLabel: "needs-human",
      heading: escalation.heading,
      reason: escalation.reason,
      nextStep: escalation.nextStep,
      ensureLabelColour: "d4c5f9",
      ensureLabelDescription:
        "Worker could not produce a fix; human review required",
      dedupKey: `pr-review-unanswered:${repo}#${prNumber}:${commentId}`,
      deps: { github: { ensureLabelExists: deps.github.ensureLabelExists } },
      logger,
    });
    if (!escalated.ok) {
      logger.error(
        "PR feedback: escalating the unanswered request-changes review " +
          "failed (Issue #3246)",
        { repo, prNumber, reviewId: commentId, error: escalated.error.message },
      );
    }
    reviewerEscalated = true;
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

  // A fix-PR failure means the change never reached the gated head, so it
  // must not be reported as pushed even though the fix branch itself is fine.
  const actuallyPushed = hasChanges && pushSucceeded &&
    !(fixBranch && fixPrError);

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
        ? fixPr
          ? `Pushed fixes for PR #${prNumber} feedback via fix PR #${fixPr.number}`
          : `Pushed fixes for PR #${prNumber} feedback`
        : reviewerEscalated
        ? `PR #${prNumber} review ${commentId}: no fix or rebuttal after ${reviewerAttempts} run(s) — escalated to needs-human`
        : hasChanges
        ? `Fixed PR #${prNumber} feedback locally but failed to push`
        : isReviewerChangeRequest(commentType) && customMessage !== undefined
        ? `Reviewed PR #${prNumber} feedback — rebuttal posted, no changes`
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
  verification?: PushVerification,
  /**
   * Issue #2907: when the fix landed via a fix PR into a gated milestone
   * head (rather than a direct push), say so — the reader otherwise has no
   * way to know the change is not yet on this PR's branch.
   */
  extraNote?: string,
): Promise<void> {
  // Issue #579: the claim carries the SHA it was verified against, so a
  // stale claim is falsifiable at a glance instead of requiring a human to
  // compare the comment against `git log`.
  const body = (customMessage ??
    "I've pushed a fix for this feedback. Please review the changes.") +
    (verification ? formatVerifiedPushSuffix(verification) : "") +
    (extraNote ? `\n\n${extraNote}` : "");
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
  verification?: PushVerification,
): Promise<void> {
  // Issue #211/#579: say WHY the branch is not on origin. "Please check the
  // branch status" gives a reader nothing, and the reason is exactly what
  // distinguishes a rejected push from a broken credential.
  const detail = verification ? `\n\nDetail: ${verification.reason}` : "";
  try {
    await deps.github.runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      "I fixed the issues from this feedback locally but failed to push them — " +
      "the changes are NOT on the remote. I checked against origin rather than " +
      `assuming the push landed, so the work is still on the worker's local branch.${detail}`,
    ]);
  } catch {
    // Comment failure is non-critical
  }
}

/**
 * Issue #2907: the gated head's fix branch could not even be checked out, so
 * Claude never ran and nothing was changed. `replyPushFailed`'s wording
 * ("I fixed the issues ... but failed to push them") would be false here —
 * this reply says plainly that no fix was attempted.
 */
async function replyGatedCheckoutFailed(
  repo: string,
  prNumber: number,
  deps: WorkerDeps,
  fixBranch: string,
  headBranch: string,
  detail: string,
): Promise<void> {
  try {
    await deps.github.runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      `The head branch '${headBranch}' is ruleset-gated, so this feedback ` +
      `pass works on a fix branch instead. I could not create the fix ` +
      `branch '${fixBranch}': ${detail}\n\nNo changes were made.`,
    ]);
  } catch {
    // Comment failure is non-critical
  }
}

/**
 * Posts a direct reply when a branch-prepare failure's processed mark could
 * not be taken back (Issue #2909 review, round 2). Without this, a
 * `pr_review` claim — always unable to un-dismiss — or a failed reaction
 * DELETE leaves the comment eyes-reacted forever with nothing posted, so the
 * next scan never rediscovers it either.
 */
async function replyBranchPrepareFailed(
  repo: string,
  prNumber: number,
  deps: WorkerDeps,
  branchName: string,
  detail: string,
): Promise<void> {
  try {
    await deps.github.runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      `I could not check out '${branchName}' on this host (${detail}). ` +
      `No changes were made.`,
    ]);
  } catch {
    // Comment failure is non-critical
  }
}

/**
 * Issue #2907: the fix branch itself pushed successfully — it IS on origin —
 * but the PR that would land it into the gated head could not be raised.
 * `replyPushFailed`'s "the work is still on the worker's local branch"
 * would be false here; say the fix is on origin and needs a human to open
 * the PR.
 */
async function replyFixPrRaiseFailed(
  repo: string,
  prNumber: number,
  deps: WorkerDeps,
  fixBranch: string,
  headBranch: string,
  error: string,
): Promise<void> {
  try {
    await deps.github.runGhCommand([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      `I pushed the fix to '${fixBranch}' on origin, but could not raise ` +
      `the PR to land it into the gated head '${headBranch}': ${error}` +
      "\n\nCould someone open that PR manually?",
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
  //
  // Issue #3246: a request-changes review (`commentType === "pr_review"`)
  // never reaches this function — its unanswered case is caught upstream
  // and either posts the agent's rebuttal or escalates to `needs-human`.
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
