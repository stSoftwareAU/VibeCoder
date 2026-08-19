/**
 * Question clarification command for the Vibe Coder worker (Issue #914).
 *
 * Detects and handles clarification requests in question answering.
 * Replaces worker/shared/question_clarification.sh.
 *
 * Sub-operations (--operation):
 *   - detect: Check if output is a clarification request
 *   - extract-body: Extract body from clarification request
 *   - post: Post clarification and manage labels
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  detectQuestionClarificationRequest,
  extractClarificationBody,
  postQuestionClarification,
} from "../lib/question_clarification.ts";
import { createLogger } from "../lib/logger.ts";

export const questionClarificationCommand: Command = {
  name: "question-clarification",
  description: "Question clarification detection and handling (Issue #914)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "");
    const logger = createLogger({
      debug: Deno.env.get("DEBUG") === "true",
    });

    switch (operation) {
      case "detect": {
        const claudeOutput = String(args["claude-output"] ?? "");
        const isClarification = detectQuestionClarificationRequest(
          claudeOutput,
        );
        return {
          success: true,
          message: String(isClarification),
          data: { isClarification },
        };
      }

      case "extract-body": {
        const claudeOutput = String(args["claude-output"] ?? "");
        const body = extractClarificationBody(claudeOutput);
        return { success: true, message: body };
      }

      case "post": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = Number(args["issue-number"] ?? 0);
        const githubUser = String(args["github-user"] ?? "");
        const clarificationBody = String(
          args["clarification-body"] ?? "",
        );

        if (!repo || !issueNumber || !githubUser) {
          return {
            success: false,
            message:
              "Missing required arguments: --repo, --issue-number, --github-user",
          };
        }

        const questionLabel = args["question-label"]
          ? String(args["question-label"])
          : undefined;
        const needsHumanLabel = args["needs-human-label"]
          ? String(args["needs-human-label"])
          : undefined;
        const workerFooter = args["worker-footer"]
          ? String(args["worker-footer"])
          : undefined;

        const result = await postQuestionClarification({
          repo,
          issueNumber,
          githubUser,
          clarificationBody,
          questionLabel,
          needsHumanLabel,
          workerFooter,
          logger,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        return {
          success: true,
          message: "true",
          data: { posted: true },
        };
      }

      default:
        return {
          success: false,
          message:
            `Unknown operation: ${operation}. Valid: detect, extract-body, post`,
        };
    }
  },
};
