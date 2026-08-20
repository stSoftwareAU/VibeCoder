/**
 * PR feedback processor command (Issue #967, #1230).
 *
 * Command wrapper for the PR feedback processor library.
 * Exposes PR feedback processing as a Deno command.
 *
 * Issue #1230: Added 'process' operation so shell can delegate the full
 * PR feedback workflow to Deno, including comment claiming, summarisation,
 * suspicious pattern detection, prompt building, Claude execution, and
 * comment reply posting.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  assertSafeGitRef,
  buildCheckoutArgs,
  buildFetchArgs,
  buildPullArgs,
} from "../lib/git_ref_args.ts";
import {
  buildFeedbackCommitMessage,
  decodeCommentBody,
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  type PrFeedbackResult,
  processPrFeedback,
  summariseLargeComment,
} from "../lib/pr_feedback_processor.ts";
import { createDefaultDeps } from "../lib/issue_worker_wiring.ts";
import {
  buildQualityInstructions,
  getCustomInstructions,
} from "../lib/repo_config.ts";
import type { CommentType } from "../lib/pr_comments.ts";

// Re-export library functions for external use
export { buildFeedbackCommitMessage, decodeCommentBody, summariseLargeComment };
export type { PrFeedbackResult };

/** The pr-feedback-processor command. */
export const prFeedbackProcessorCommand: Command = {
  name: "pr-feedback-processor",
  description: "Process PR feedback comments (Issue #967, #1230)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<PrFeedbackResult>> {
    const operation = String(args["operation"] ?? "");

    if (operation === "decode-comment") {
      const encoded = String(args["encoded"] ?? "");
      const decoded = decodeCommentBody(encoded);
      return {
        success: true,
        message: decoded,
      };
    }

    if (operation === "build-commit-message") {
      const prNumber = Number(args["pr-number"] ?? 0);
      const commentBody = String(args["comment-body"] ?? "");
      const message = buildFeedbackCommitMessage(prNumber, commentBody);
      return {
        success: true,
        message,
      };
    }

    // Issue #1230: Full PR feedback workflow — delegates entirely to Deno.
    // Shell wrapper passes repo, pr-number, branch-name, comment-type,
    // comment-id, and comment-body; this operation handles claiming,
    // summarisation, pattern detection, prompt building, Claude execution,
    // and reply posting.
    if (operation === "process") {
      const repo = String(args["repo"] ?? "");
      const prNumber = Number(args["pr-number"] ?? 0);
      const branchName = String(args["branch-name"] ?? "");
      const commentType = String(
        args["comment-type"] ?? "review",
      ) as CommentType;
      const commentId = String(args["comment-id"] ?? "");
      const commentBody = String(args["comment-body"] ?? "");
      const workerId = args["worker-id"]
        ? String(args["worker-id"])
        : undefined;

      if (!repo || !prNumber || !branchName || !commentId) {
        return {
          success: false,
          message:
            "Missing required arguments: --repo, --pr-number, --branch-name, --comment-id",
        };
      }

      try {
        assertSafeGitRef(branchName, "PR head branch name");
      } catch (err) {
        return {
          success: false,
          message: `Refusing to process PR #${prNumber}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      const deps = createDefaultDeps();

      // Top-level try/catch to prevent silent crashes (Issue #1230)
      try {
        // Set up the target repo directory so Claude runs with correct context
        const setupResult = await deps.git.setupRepo(
          repo,
          config.workDir || "",
        );
        if (!setupResult.ok) {
          return {
            success: false,
            message: `Failed to set up repo: ${setupResult.error.message}`,
          };
        }
        const repoWorkDir = setupResult.value;

        // Checkout and sync the PR branch
        await deps.git.runGitCommand(
          buildFetchArgs("origin", branchName),
          { cwd: repoWorkDir },
        );
        await deps.git.runGitCommand(
          buildCheckoutArgs(branchName),
          { cwd: repoWorkDir },
        );
        await deps.git.runGitCommand(
          buildPullArgs("origin", branchName),
          { cwd: repoWorkDir },
        );

        // Sync feature branch with default branch (Issue #230)
        const defaultBranchResult = await deps.git.getRepoDefaultBranch(repo);
        const defaultBranch = defaultBranchResult.ok
          ? defaultBranchResult.value
          : "main";
        await deps.git.syncFeatureBranchWithDefault(
          branchName,
          defaultBranch,
          { cwd: repoWorkDir },
        );

        // Build quality and custom instructions from config
        const qualityInstructions = buildQualityInstructions(
          config.repoConfig,
          repo,
        );
        const customInstructions = getCustomInstructions(
          config.repoConfig,
          repo,
        );

        const input: PrFeedbackInput = {
          repo,
          prNumber,
          branchName,
          commentType,
          commentId,
          commentBody,
        };

        const processorDeps: PrFeedbackProcessorDeps = {
          logger: deps.logger,
          deps,
          workDir: repoWorkDir,
          qualityInstructions,
          customInstructions,
          // Issue #1824: PR feedback uses its own timeout, distinct from
          // the larger issue-work claudeTimeout.
          claudeTimeout: config.prFeedbackTimeout || undefined,
          claudeModel: config.claudeModel || undefined,
          workerId,
        };

        const result = await processPrFeedback(input, processorDeps);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        return {
          success: true,
          message: JSON.stringify(result.value),
          data: result.value,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        deps.logger.error("Unhandled exception in PR feedback processing", {
          repo,
          prNumber,
          error: errorMsg,
        });

        // Defence-in-depth: post failure comment
        try {
          await deps.github.runGhCommand([
            "pr",
            "comment",
            String(prNumber),
            "--repo",
            repo,
            "--body",
            `Failed to process PR feedback: ${errorMsg.slice(0, 500)}`,
          ]);
        } catch {
          // Best effort — do not mask the original error
        }

        return {
          success: false,
          message: `Unhandled PR feedback error: ${errorMsg}`,
        };
      }
    }

    return {
      success: false,
      message:
        `Unknown operation: ${operation}. Valid: decode-comment, build-commit-message, process`,
    };
  },
};
