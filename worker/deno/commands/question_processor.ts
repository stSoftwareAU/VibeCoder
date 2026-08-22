/**
 * Question processor command (Issue #966, #1226).
 *
 * Command wrapper for the question processor library.
 * Exposes question processing as a Deno command.
 *
 * Issue #1226: Added 'process' operation so shell can delegate the full
 * question answering workflow to Deno, including comment filtering, prompt
 * building, Claude invocation, output validation, and answer posting.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildAnswerComment,
  processIssueQuestion,
  type QuestionResult,
} from "../lib/question_processor.ts";
import { createDefaultDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import { prepareQuestionCommentsWithAudit } from "../lib/comment_filter.ts";
import { prepareTrustAnnotatedComments } from "../lib/comment_trust_filter.ts";

// Re-export library functions for external use
export { buildAnswerComment, processIssueQuestion };
export type { QuestionResult };

/** The question-processor command. */
export const questionProcessorCommand: Command = {
  name: "question-processor",
  description: "Process issue question answering requests (Issue #966, #1226)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<QuestionResult>> {
    const operation = String(args["operation"] ?? "");

    if (operation === "build-answer-comment") {
      const answer = String(args["answer"] ?? "");
      const githubUser = String(args["github-user"] ?? "");
      const comment = buildAnswerComment(answer, githubUser);
      return {
        success: true,
        message: comment,
      };
    }

    // Issue #1226: Full question answering workflow — delegates entirely to Deno.
    // Shell wrapper passes repo, issue-number, issue-title, and github-user;
    // this operation fetches issue data, filters comments, builds the question
    // prompt, runs Claude, sanitises output, detects clarification requests,
    // and posts the answer.
    if (operation === "process") {
      const repo = String(args["repo"] ?? "");
      const issueNumber = Number(args["issue-number"] ?? 0);
      const issueTitle = String(args["issue-title"] ?? "");
      const githubUser = String(
        args["github-user"] ?? Deno.env.get("GITHUB_USER") ?? "",
      );

      if (!repo || !issueNumber || !githubUser) {
        return {
          success: false,
          message:
            "Missing required arguments: --repo, --issue-number, --github-user",
        };
      }

      const deps = createDefaultDeps();
      const ghClient = deps.github.createClient(deps.logger);

      // Top-level try/catch to prevent silent crashes (Issue #1226)
      try {
        // Set up the target repo directory so Claude can read the codebase
        // and provide informed answers (Issue #358).
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

        // Fetch issue data internally — no need for shell to pass it
        const issueData = await deps.issues.fetchIssueData(repo, issueNumber);

        // Issue #664/#1226/#1340: Filter comments with trust-level annotations.
        // Classifies each comment author as trusted or untrusted based on
        // allowedAuthors/authorisedCommenters config. Falls back to the
        // original filter if trust lists are empty (backward compatibility).
        const rawJson = JSON.stringify({
          comments: issueData.comments.map(
            (c: { author: string; body: string }) => ({
              body: c.body,
              author: { login: c.author },
            }),
          ),
        });

        const hasTrustConfig = (config.allowedAuthors?.length ?? 0) > 0 ||
          (config.authorisedCommenters?.length ?? 0) > 0;

        let filteredComments: string;
        // Set only on the trust-annotated path, where the assembled blob
        // carries genuine per-comment headers (Issue #3637).
        let commentBoundaryId: string | undefined;
        if (hasTrustConfig) {
          const trustResult = prepareTrustAnnotatedComments(rawJson, {
            allowedAuthors: config.allowedAuthors ?? [],
            authorisedCommenters: config.authorisedCommenters ?? [],
            includeUntrustedComments: config.includeUntrustedComments ?? true,
          });
          filteredComments = trustResult.formattedComments;
          commentBoundaryId = trustResult.boundaryId;

          // Log security audit events for suspicious untrusted comments
          for (const auditMsg of trustResult.securityAuditMessages) {
            deps.logger.warn(auditMsg, { repo, issueNumber });
          }
        } else {
          // No trust config: every author is treated as untrusted and the
          // same suspicious-pattern audit events are logged (Issue #190).
          const legacyResult = prepareQuestionCommentsWithAudit(rawJson);
          filteredComments = legacyResult.formattedComments;

          for (const auditMsg of legacyResult.securityAuditMessages) {
            deps.logger.warn(auditMsg, { repo, issueNumber });
          }
        }

        const ctx: IssueContext = {
          repo,
          issueNumber,
          issueTitle: issueTitle || issueData.body.slice(0, 100),
          issueBody: issueData.body,
          issueLabels: issueData.labels,
          issueComments: filteredComments,
          commentBoundaryId,
          githubUser,
          config: { ...config, workDir: repoWorkDir },
        };

        const result = await processIssueQuestion(ctx, {
          ghClient,
          logger: deps.logger,
          deps,
        });

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
        deps.logger.error("Unhandled exception in question processing", {
          repo,
          issueNumber,
          error: errorMsg,
        });

        // Post failure comment so the user knows what went wrong (Issue #1226)
        try {
          await ghClient.postComment(
            repo,
            issueNumber,
            `## Question Answering Failed\n\nUnexpected error during question processing: ${errorMsg}\n\n---\n🤖 Processed by: ${githubUser}`,
          );
        } catch {
          // Best effort — do not mask the original error
        }

        // Remove question label to prevent limbo
        try {
          await ghClient.removeLabel(repo, issueNumber, config.questionLabel);
        } catch {
          // Best effort
        }

        return {
          success: false,
          message: `Unhandled question error: ${errorMsg}`,
        };
      }
    }

    return {
      success: false,
      message:
        `Unknown operation: ${operation}. Valid: build-answer-comment, process`,
    };
  },
};
