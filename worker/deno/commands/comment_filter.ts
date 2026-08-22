/**
 * Comment filter command for the Vibe Coder worker (Issue #914).
 *
 * Filters and trims issue comments for follow-up question prompts.
 * Replaces worker/shared/comment_filter.sh.
 *
 * Sub-operations (--operation):
 *   - prepare-question-comments: Filter and truncate comments
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { prepareQuestionCommentsWithAudit } from "../lib/comment_filter.ts";
import { createLogger } from "../lib/logger.ts";

export const commentFilterCommand: Command = {
  name: "comment-filter",
  description: "Comment filtering for question prompts (Issue #914)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "prepare-question-comments");

    switch (operation) {
      case "prepare-question-comments": {
        const jsonData = String(args["json-data"] ?? "");
        const truncateLength = args["truncate-length"]
          ? Number(args["truncate-length"])
          : undefined;
        const result = prepareQuestionCommentsWithAudit(
          jsonData,
          truncateLength,
        );

        // Audit events go to the logger (stderr), keeping the formatted blob
        // on stdout intact for the shell caller (Issue #190).
        const logger = createLogger({
          debug: Deno.env.get("DEBUG") === "true",
        });
        for (const auditMsg of result.securityAuditMessages) {
          logger.warn(auditMsg);
        }

        return { success: true, message: result.formattedComments };
      }

      default:
        return {
          success: false,
          message:
            `Unknown operation: ${operation}. Valid: prepare-question-comments`,
        };
    }
  },
};
