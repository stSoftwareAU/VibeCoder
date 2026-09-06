/**
 * PR manager command for the Vibe Coder worker (Issue #915).
 *
 * Unified command entry point for all PR management operations,
 * replacing worker/shared/pr_manager.sh. Each sub-operation delegates
 * to the appropriate focused library module.
 *
 * Sub-operations (--operation):
 *   - ensure-pr-references-issue: Ensure PR body has closing keyword
 *   - build-milestone-section: Generate milestone context section
 *     (--milestone-title, --milestone-branch, --base-branch)
 *   - build-idempotency-marker: Generate idempotency marker
 *   - extract-issue-number: Extract issue number from PR title
 *   - validate-pr-evidence: Validate UI changes include screenshots
 *   - process-screenshot-evidence: Process screenshots and update PR summary
 *   - find-screenshot-references: Find screenshot references in markdown
 *   - enable-auto-merge: Enable auto squash merge on a PR
 *   - finalise-pr: Resolve conflicts then enable auto-merge
 *   - claim-pr-comment: Atomically claim a PR comment before processing
 *   - mark-comment-processed: Mark a comment as processed
 *   - reply-to-comment: Post a reply comment on a PR
 *   - handle-pr-comment-failure: Unified failure handler for PR comments
 *   - check-pr-comment-failed-once: Check if comment has failed once
 *   - record-ci-check-retry: Record a CI check retry
 *   - get-ci-check-retry-count: Get retry count for a CI check
 *   - post-ci-fix-max-retries-comment: Post max-retries comment
 *   - link-pr-to-issue: Post linking comment on issue
 *   - post-issue-link-with-retry: Post linking comment with retry
 *   - verify-issue-link-comment: Check if linking comment exists
 *   - find-existing-pr-for-branch: Find open PR for a branch
 *   - find-existing-pr-for-issue: Find open PR for an issue
 *   - close-duplicate-prs: Close duplicate PRs
 *   - close-issues-for-merged-prs: Close issues whose PRs merged
 *   - retarget-pr-to-milestone: Re-target PR to milestone branch
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildIdempotencyMarker,
  buildMilestonePrSection,
  ensurePrReferencesIssue,
  extractIssueNumberFromPrTitle,
} from "../lib/pr_body.ts";
import {
  findScreenshotReferences,
  processScreenshotEvidence,
  validatePrEvidence,
} from "../lib/pr_evidence.ts";
import {
  createImgbbUploadFn,
  readImgbbApiKeyFromEnv,
} from "../lib/imgbb_upload.ts";
import { AutoMergeResult, enableAutoMerge } from "../lib/pr_auto_merge.ts";
import { mergeMethodFlagForHead } from "../lib/milestone_sync_pr.ts";
import {
  getCiCheckRetryCount,
  postCiFixMaxRetriesComment,
  recordCiCheckRetry,
} from "../lib/pr_ci_checks.ts";
import {
  checkPrCommentHasFailedOnce,
  type CommentType,
  handlePrCommentFailure,
  markCommentProcessed,
  replyToComment,
} from "../lib/pr_comments.ts";
import { claimPrComment } from "../lib/claim_pr_comment.ts";
import { getWorkerUniqueId } from "../lib/worker_identity.ts";
import {
  closeDuplicatePrs,
  closeIssuesForMergedPrs,
  findExistingPrForBranch,
  findExistingPrForIssue,
  linkPrToIssue,
  postIssueLinkWithRetry,
  verifyIssueLinkComment,
} from "../lib/pr_issue_linking.ts";
import { retargetPrToMilestone } from "../lib/pr_retarget.ts";
import { runGhCommand } from "../lib/github.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

/**
 * The PR's head branch, which decides its merge method (Issue #1048).
 *
 * Throws rather than defaulting: an unreadable head would silently squash a
 * milestone sync, which is the fault this whole path exists to prevent.
 */
async function fetchHeadRefName(
  repo: string,
  prNumber: number,
): Promise<string> {
  const head = (await runGhCommand([
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "headRefName",
    "--jq",
    ".headRefName",
  ])).trim();
  if (!head) {
    throw new Error(
      `PR #${prNumber} in ${repo} reported no head branch, so its merge ` +
        `method cannot be chosen (Issue #1048)`,
    );
  }
  return head;
}

export const prManagerCommand: Command = {
  name: "pr-manager",
  description:
    "PR management: body, auto-merge, CI checks, comments, evidence, linking, retarget (Issue #915)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");

    switch (operation) {
      // --- PR Body operations ---
      case "ensure-pr-references-issue": {
        const prBody = String(args["pr-body"] ?? "");
        const issueNumber = Number(args["issue-number"] ?? 0);
        if (!issueNumber) {
          return {
            success: false,
            message: "Missing required argument: --issue-number",
          };
        }
        const result = ensurePrReferencesIssue(prBody, issueNumber);
        return { success: true, message: result };
      }

      case "build-milestone-section": {
        const milestoneTitle = String(args["milestone-title"] ?? "");
        const milestoneBranch = String(args["milestone-branch"] ?? "");
        // Issue #3911: the footer is rendered from the PR's actual base, so
        // the caller must supply it rather than the intended branch.
        const baseBranch = String(args["base-branch"] ?? "");
        const section = buildMilestonePrSection({
          milestoneTitle,
          milestoneBranch,
          baseBranch,
        });
        return { success: true, message: section };
      }

      case "build-idempotency-marker": {
        const issueNumber = Number(args["issue-number"] ?? 0);
        if (!issueNumber) {
          return {
            success: false,
            message: "Missing required argument: --issue-number",
          };
        }
        return { success: true, message: buildIdempotencyMarker(issueNumber) };
      }

      case "extract-issue-number": {
        const title = String(args["title"] ?? "");
        if (!title) {
          return {
            success: false,
            message: "Missing required argument: --title",
          };
        }
        const result = extractIssueNumberFromPrTitle(title);
        if (result.ok) {
          return { success: true, message: String(result.value) };
        }
        return { success: false, message: result.error.message };
      }

      // --- Evidence operations ---
      case "validate-pr-evidence": {
        const prSummary = String(args["pr-summary"] ?? "");
        const issueLabels = String(args["issue-labels"] ?? "");
        const result = validatePrEvidence(prSummary, issueLabels);
        if (result.ok) {
          return { success: true, message: result.value };
        }
        // Return the updated content (with warning) but indicate failure
        return { success: false, message: result.error };
      }

      case "process-screenshot-evidence": {
        const prSummary = String(args["pr-summary"] ?? "");
        const repoPath = String(args["repo-path"] ?? ".");
        const githubRepo = String(args["github-repo"] ?? "");
        // From the environment, never argv — a command line is world-readable
        // via `ps` (Issue #3707).
        const imgbbApiKey = readImgbbApiKeyFromEnv();

        const result = await processScreenshotEvidence(prSummary, {
          repoPath,
          githubRepo: githubRepo || undefined,
          imgbbApiKey: imgbbApiKey || undefined,
          uploadFn: imgbbApiKey ? createImgbbUploadFn(imgbbApiKey) : undefined,
          // Issue #1214: routed through the shared timeout chokepoint.
          gitCommandFn: async (gitArgs: string[]) => {
            const result = await runGitCommand(gitArgs);
            return result.ok ? result.value.stdout : "";
          },
        });
        return {
          success: true,
          message: result.content,
          data: {
            screenshotsFound: result.screenshotsFound,
            screenshotsUploaded: result.screenshotsUploaded,
            screenshotsConverted: result.screenshotsConverted,
            screenshotsFailed: result.screenshotsFailed,
          },
        };
      }

      case "find-screenshot-references": {
        const content = String(args["content"] ?? "");
        const refs = findScreenshotReferences(content);
        return { success: true, message: refs.join("\n") };
      }

      // --- Auto-merge operations ---
      case "enable-auto-merge": {
        const repo = String(args["repo"] ?? "");
        const prNumber = Number(args["pr-number"] ?? 0);
        const skipAutoMerge = args["skip-auto-merge"] === true ||
          args["skip-auto-merge"] === "true";
        if (!repo || !prNumber) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --pr-number",
          };
        }
        const result = await enableAutoMerge({
          repo,
          prNumber,
          skipAutoMerge,
          // The head branch decides the merge method (Issue #1048): a
          // milestone sync must land as a merge commit, and without this the
          // arming here would squash one.
          headRefName: await fetchHeadRefName(repo, prNumber),
          ghCommandFn: runGhCommand,
        });
        return {
          success: result.result === AutoMergeResult.Enabled ||
            result.result === AutoMergeResult.NotEnabledOnRepo ||
            result.result === AutoMergeResult.Skipped,
          message: result.message,
          data: { result: result.result },
        };
      }

      case "finalise-pr": {
        const repo = String(args["repo"] ?? "");
        const prNumber = Number(args["pr-number"] ?? 0);
        const skipAutoMerge = args["skip-auto-merge"] === true ||
          args["skip-auto-merge"] === "true";
        if (!repo || !prNumber) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --pr-number",
          };
        }
        // Read once and use for both the arming and the direct-merge fallback
        // (Issue #1048): the head branch decides the merge method.
        const headRefName = await fetchHeadRefName(repo, prNumber);
        const result = await enableAutoMerge({
          repo,
          prNumber,
          skipAutoMerge,
          headRefName,
          ghCommandFn: runGhCommand,
        });
        // If not allowed, attempt direct merge
        if (result.result === AutoMergeResult.NotAllowed) {
          try {
            await runGhCommand([
              "pr",
              "merge",
              String(prNumber),
              "--repo",
              repo,
              mergeMethodFlagForHead(headRefName),
            ]);
            return {
              success: true,
              message: `Direct merge attempted for PR #${prNumber}`,
            };
          } catch {
            return {
              success: true,
              message: `Auto-merge not available, direct merge deferred`,
            };
          }
        }
        return { success: true, message: result.message };
      }

      // --- Comment operations ---
      case "claim-pr-comment": {
        const repo = String(args["repo"] ?? "");
        const prNumber = Number(args["pr-number"] ?? 0);
        const commentId = String(args["comment-id"] ?? "");
        const commentType = String(
          args["comment-type"] ?? "issue",
        ) as CommentType;
        if (!repo || !prNumber || !commentId) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --pr-number, --comment-id",
          };
        }
        const workerId = getWorkerUniqueId(_config.workerName);
        const result = await claimPrComment({
          repo,
          prNumber,
          commentId,
          commentType,
          workerId,
          ghCommandFn: runGhCommand,
        });
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        const { claimed, winnerId } = result.value;
        return {
          success: claimed,
          message: claimed ? "CLAIMED" : "LOST",
          data: { claimed, winnerId, workerId },
        };
      }

      case "mark-comment-processed": {
        const repo = String(args["repo"] ?? "");
        const commentType = String(
          args["comment-type"] ?? "issue",
        ) as CommentType;
        const commentId = String(args["comment-id"] ?? "");
        const prNumber = args["pr-number"]
          ? Number(args["pr-number"])
          : undefined;
        if (!repo || !commentId) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --comment-id",
          };
        }
        const result = await markCommentProcessed(
          repo,
          commentType,
          commentId,
          prNumber,
          runGhCommand,
        );
        return {
          success: result.ok,
          message: result.ok
            ? "Comment marked as processed"
            : result.error.message,
        };
      }

      case "reply-to-comment": {
        const repo = String(args["repo"] ?? "");
        const prNumber = Number(args["pr-number"] ?? 0);
        const message = String(args["message"] ?? "");
        if (!repo || !prNumber || !message) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --pr-number, --message",
          };
        }
        const result = await replyToComment(
          repo,
          prNumber,
          message,
          runGhCommand,
        );
        return {
          success: result.ok,
          message: result.ok ? "Reply posted" : result.error.message,
        };
      }

      case "handle-pr-comment-failure": {
        const repo = String(args["repo"] ?? "");
        const prNumber = Number(args["pr-number"] ?? 0);
        const commentType = String(
          args["comment-type"] ?? "issue",
        ) as CommentType;
        const commentId = String(args["comment-id"] ?? "");
        const failureMessage = String(args["failure-message"] ?? "");
        if (!repo || !prNumber || !commentId) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --pr-number, --comment-id",
          };
        }
        await handlePrCommentFailure(
          repo,
          prNumber,
          commentType,
          commentId,
          failureMessage,
          runGhCommand,
        );
        return { success: true, message: "PR comment failure handled" };
      }

      case "check-pr-comment-failed-once": {
        const repo = String(args["repo"] ?? "");
        const commentType = String(
          args["comment-type"] ?? "issue",
        ) as CommentType;
        const commentId = String(args["comment-id"] ?? "");
        if (!repo || !commentId) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --comment-id",
          };
        }
        const hasFailedOnce = await checkPrCommentHasFailedOnce(
          repo,
          commentType,
          commentId,
          runGhCommand,
        );
        return { success: true, message: hasFailedOnce ? "true" : "false" };
      }

      // --- CI Check operations ---
      case "record-ci-check-retry": {
        const stateDir = String(args["state-dir"] ?? "");
        const repo = String(args["repo"] ?? "");
        const checkId = String(args["check-id"] ?? "");
        if (!stateDir || !repo || !checkId) {
          return {
            success: false,
            message:
              "Missing required arguments: --state-dir, --repo, --check-id",
          };
        }
        const count = await recordCiCheckRetry(stateDir, repo, checkId);
        return { success: true, message: String(count) };
      }

      case "get-ci-check-retry-count": {
        const stateDir = String(args["state-dir"] ?? "");
        const repo = String(args["repo"] ?? "");
        const checkId = String(args["check-id"] ?? "");
        if (!stateDir || !repo || !checkId) {
          return {
            success: false,
            message:
              "Missing required arguments: --state-dir, --repo, --check-id",
          };
        }
        const count = await getCiCheckRetryCount(stateDir, repo, checkId);
        return { success: true, message: String(count) };
      }

      case "post-ci-fix-max-retries-comment": {
        const repo = String(args["repo"] ?? "");
        const prNumber = Number(args["pr-number"] ?? 0);
        const checkName = String(args["check-name"] ?? "");
        const checkId = String(args["check-id"] ?? "");
        const maxRetries = Number(args["max-retries"] ?? 3);
        if (!repo || !prNumber || !checkName || !checkId) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --pr-number, --check-name, --check-id",
          };
        }
        const result = await postCiFixMaxRetriesComment(
          repo,
          prNumber,
          checkName,
          checkId,
          maxRetries,
          runGhCommand,
        );
        return {
          success: result.ok,
          message: result.ok
            ? "Max-retries comment posted"
            : result.error.message,
        };
      }

      // --- Issue linking operations ---
      case "link-pr-to-issue": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = Number(args["issue-number"] ?? 0);
        const prUrl = String(args["pr-url"] ?? "");
        if (!repo || !issueNumber || !prUrl) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --pr-url",
          };
        }
        const result = await linkPrToIssue(
          repo,
          issueNumber,
          prUrl,
          runGhCommand,
        );
        return {
          success: result.ok,
          message: result.ok ? "PR linked to issue" : result.error.message,
        };
      }

      case "post-issue-link-with-retry": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = Number(args["issue-number"] ?? 0);
        const prUrl = String(args["pr-url"] ?? "");
        const maxRetries = Number(args["max-retries"] ?? 3);
        if (!repo || !issueNumber || !prUrl) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --pr-url",
          };
        }
        const result = await postIssueLinkWithRetry(
          repo,
          issueNumber,
          prUrl,
          maxRetries,
          runGhCommand,
        );
        return {
          success: result.ok,
          message: result.ok ? "Issue link posted" : result.error.message,
        };
      }

      case "verify-issue-link-comment": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = Number(args["issue-number"] ?? 0);
        const prUrl = String(args["pr-url"] ?? "");
        if (!repo || !issueNumber || !prUrl) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --pr-url",
          };
        }
        const exists = await verifyIssueLinkComment(
          repo,
          issueNumber,
          prUrl,
          runGhCommand,
        );
        return { success: true, message: exists ? "true" : "false" };
      }

      case "find-existing-pr-for-branch": {
        const repo = String(args["repo"] ?? "");
        const branchName = String(args["branch-name"] ?? "");
        if (!repo || !branchName) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --branch-name",
          };
        }
        const result = await findExistingPrForBranch(
          repo,
          branchName,
          runGhCommand,
        );
        if (result.ok) {
          return { success: true, message: result.value };
        }
        return { success: false, message: result.error.message };
      }

      case "find-existing-pr-for-issue": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = Number(args["issue-number"] ?? 0);
        if (!repo || !issueNumber) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --issue-number",
          };
        }
        const result = await findExistingPrForIssue(
          repo,
          issueNumber,
          runGhCommand,
        );
        if (result.ok) {
          return { success: true, message: result.value };
        }
        return { success: false, message: result.error.message };
      }

      case "close-duplicate-prs": {
        const repo = String(args["repo"] ?? "");
        const branchName = String(args["branch-name"] ?? "");
        const keepPrUrl = String(args["keep-pr-url"] ?? "");
        if (!repo || !branchName || !keepPrUrl) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --branch-name, --keep-pr-url",
          };
        }
        const count = await closeDuplicatePrs(
          repo,
          branchName,
          keepPrUrl,
          runGhCommand,
        );
        return {
          success: true,
          message: String(count),
          data: { closedCount: count },
        };
      }

      case "close-issues-for-merged-prs": {
        const githubUser = String(args["github-user"] ?? "");
        const repos = args["repos"] as string[] ?? [];
        if (!githubUser || repos.length === 0) {
          return {
            success: false,
            message: "Missing required arguments: --github-user, --repos",
          };
        }
        const count = await closeIssuesForMergedPrs(
          repos,
          githubUser,
          runGhCommand,
        );
        return {
          success: true,
          message: String(count),
          data: { closedCount: count },
        };
      }

      // --- Retarget operations ---
      case "retarget-pr-to-milestone": {
        const repo = String(args["repo"] ?? "");
        const prNumber = Number(args["pr-number"] ?? 0);
        const milestoneBranch = String(args["milestone-branch"] ?? "");
        if (!repo || !prNumber) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --pr-number",
          };
        }
        const result = await retargetPrToMilestone(
          repo,
          prNumber,
          milestoneBranch,
          runGhCommand,
        );
        return {
          success: result.ok,
          message: result.ok ? result.value : result.error.message,
        };
      }

      default:
        return {
          success: false,
          message:
            `Unknown operation: ${operation}. Valid: ensure-pr-references-issue, build-milestone-section, build-idempotency-marker, extract-issue-number, validate-pr-evidence, process-screenshot-evidence, find-screenshot-references, enable-auto-merge, finalise-pr, claim-pr-comment, mark-comment-processed, reply-to-comment, handle-pr-comment-failure, check-pr-comment-failed-once, record-ci-check-retry, get-ci-check-retry-count, post-ci-fix-max-retries-comment, link-pr-to-issue, post-issue-link-with-retry, verify-issue-link-comment, find-existing-pr-for-branch, find-existing-pr-for-issue, close-duplicate-prs, close-issues-for-merged-prs, retarget-pr-to-milestone`,
        };
    }
  },
};
