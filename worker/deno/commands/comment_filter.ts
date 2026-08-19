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
import { prepareQuestionComments } from "../lib/comment_filter.ts";

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
        const result = prepareQuestionComments(jsonData, truncateLength);
        return { success: true, message: result };
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
