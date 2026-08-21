/**
 * PR comment management for the Vibe Coder worker (Issue #915).
 *
 * Handles marking comments as processed, replying to comments,
 * and failure handling for PR comment processing.
 *
 * Replaces the comment-related functions from worker/shared/pr_manager.sh.
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGhOrThrow } from "./gh_spawn.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Comment type for API routing. */
export type CommentType = "review" | "issue" | "pr_review";

/** Information about a PR comment to fix. */
export interface PrCommentToFix {
  /** Repository in "owner/repo" format */
  repo: string;
  /** PR number */
  prNumber: number;
  /** Branch name */
  branchName: string;
  /** Type of comment */
  commentType: CommentType;
  /** Comment or review ID */
  commentId: string;
  /** Base64-encoded comment body */
  encodedBody: string;
  /**
   * GitHub login of the comment author. Optional for backward
   * compatibility — populated by `findActionableComment` so downstream
   * PR-feedback processing can apply author-based gating without a
   * second `gh` fetch.
   */
  commentAuthor?: string;
  /**
   * ISO 8601 creation time of the comment, when the API supplied one
   * (Issue #211). The scan uses it to drop feedback a later fleet push has
   * already answered.
   */
  commentCreatedAt?: string;
}

/** Default gh command function — routed through the shared chokepoint. */
async function defaultGhCommand(args: string[]): Promise<string> {
  return await runGhOrThrow(args);
}

/**
 * Mark a comment as processed by adding an eyes reaction (or dismissing a review).
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentType - Type of comment ("review", "issue", or "pr_review")
 * @param commentId - The comment or review ID
 * @param prNumber - PR number (required for pr_review type)
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function markCommentProcessed(
  repo: string,
  commentType: CommentType,
  commentId: string,
  prNumber?: number,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<Result<void, Error>> {
  try {
    if (commentType === "review") {
      await ghCommandFn([
        "api",
        "-X",
        "POST",
        `repos/${repo}/pulls/comments/${commentId}/reactions`,
        "-f",
        "content=eyes",
      ]);
    } else if (commentType === "pr_review") {
      if (prNumber !== undefined) {
        await ghCommandFn([
          "api",
          "-X",
          "PUT",
          `repos/${repo}/pulls/${prNumber}/reviews/${commentId}/dismissals`,
          "-f",
          "message=Changes have been addressed by the automated worker.",
        ]);
      }
    } else {
      await ghCommandFn([
        "api",
        "-X",
        "POST",
        `repos/${repo}/issues/comments/${commentId}/reactions`,
        "-f",
        "content=eyes",
      ]);
    }
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to mark comment processed: ${msg}`),
    };
  }
}

/**
 * Post a reply comment on a PR.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param message - Reply message
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns Result indicating success or failure
 */
export async function replyToComment(
  repo: string,
  prNumber: number,
  message: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<Result<void, Error>> {
  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      message,
    ]);
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(`Failed to reply to PR #${prNumber}: ${msg}`),
    };
  }
}

/**
 * Check if a PR comment has the "confused" reaction (failed-once marker).
 *
 * @param repo - Repository in "owner/repo" format
 * @param commentType - Type of comment ("review" or "issue")
 * @param commentId - The comment ID
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 * @returns true if the comment has been marked as failed once
 */
export async function checkPrCommentHasFailedOnce(
  repo: string,
  commentType: CommentType,
  commentId: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<boolean> {
  const apiPath = commentType === "review"
    ? `repos/${repo}/pulls/comments/${commentId}`
    : `repos/${repo}/issues/comments/${commentId}`;

  try {
    const output = await ghCommandFn([
      "api",
      apiPath,
      "--jq",
      ".reactions.confused // 0",
    ]);
    const count = parseInt(output.trim(), 10);
    return count > 0;
  } catch {
    return false;
  }
}

/**
 * Mark a PR comment as having failed once (confused reaction + reply).
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param commentType - Type of comment
 * @param commentId - The comment ID
 * @param failureMessage - Description of the failure
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 */
export async function markPrCommentAsFailedOnce(
  repo: string,
  prNumber: number,
  commentType: CommentType,
  commentId: string,
  failureMessage: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<void> {
  // Add confused reaction
  const reactionPath = commentType === "review"
    ? `repos/${repo}/pulls/comments/${commentId}/reactions`
    : `repos/${repo}/issues/comments/${commentId}/reactions`;

  try {
    await ghCommandFn([
      "api",
      "-X",
      "POST",
      reactionPath,
      "-f",
      "content=confused",
    ]);
  } catch {
    // Reaction failure is not fatal
  }

  // Public sink: the failure text is arbitrary worker/Claude output, so mask
  // known secret shapes before it is published (Issue #3707).
  const body = `## Automated Processing Failed (First Attempt)

The automated worker encountered an issue while processing this comment and will retry.

### Failure Details
${redactSecrets(failureMessage)}

### What happens next?
- This comment has been marked for retry (confused reaction added)
- The worker will attempt to process it again on the next scan
- If it fails again, manual intervention will be required`;

  await replyToComment(repo, prNumber, body, ghCommandFn);
}

/**
 * Mark a PR comment as permanently failed (eyes reaction + reply).
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param commentType - Type of comment
 * @param commentId - The comment ID
 * @param failureMessage - Description of the failure
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 */
export async function markPrCommentAsFailed(
  repo: string,
  prNumber: number,
  commentType: CommentType,
  commentId: string,
  failureMessage: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<void> {
  // Mark as processed (eyes) to prevent further retries
  await markCommentProcessed(
    repo,
    commentType,
    commentId,
    prNumber,
    ghCommandFn,
  );

  // Public sink — same reasoning as the first-attempt reply (Issue #3707).
  const body =
    `## Automated Processing Failed (Second Attempt - Permanently Failed)

The automated worker has failed to process this comment twice and will not retry automatically.

### Failure Details
${redactSecrets(failureMessage)}

### Why this might be happening
- The requested change may be too complex for automated processing
- The comment may need more detail or clarification
- There may be dependencies or context that Claude doesn't have

### To retry this comment
1. Address the underlying issue described above
2. Post a new comment with clarified requirements
3. The worker will pick up the new comment on the next scan`;

  await replyToComment(repo, prNumber, body, ghCommandFn);
}

/**
 * Unified failure handler for PR comment processing.
 *
 * Checks if this is the first or second failure and calls the appropriate
 * mark function.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - PR number
 * @param commentType - Type of comment
 * @param commentId - The comment ID
 * @param failureMessage - Description of the failure
 * @param ghCommandFn - Function to run gh commands (injectable for testing)
 */
export async function handlePrCommentFailure(
  repo: string,
  prNumber: number,
  commentType: CommentType,
  commentId: string,
  failureMessage: string,
  ghCommandFn: (args: string[]) => Promise<string> = defaultGhCommand,
): Promise<void> {
  const hasFailedOnce = await checkPrCommentHasFailedOnce(
    repo,
    commentType,
    commentId,
    ghCommandFn,
  );

  if (hasFailedOnce) {
    await markPrCommentAsFailed(
      repo,
      prNumber,
      commentType,
      commentId,
      failureMessage,
      ghCommandFn,
    );
  } else {
    await markPrCommentAsFailedOnce(
      repo,
      prNumber,
      commentType,
      commentId,
      failureMessage,
      ghCommandFn,
    );
  }
}

/**
 * Format a PR comment to fix as a pipe-delimited string (for shell integration).
 *
 * @param comment - The comment information
 * @returns Pipe-delimited string
 */
export function formatPrCommentToFix(comment: PrCommentToFix): string {
  return `${comment.repo}|${comment.prNumber}|${comment.branchName}|${comment.commentType}|${comment.commentId}|${comment.encodedBody}`;
}
