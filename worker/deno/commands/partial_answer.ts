/**
 * Partial answer command for the Vibe Coder worker (Issue #913).
 *
 * Posts partial answers when question answering times out.
 * Replaces worker/shared/partial_answer.sh.
 *
 * Sub-operations (--operation):
 *   - post: Post a partial answer from a timed-out question
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { postPartialAnswer } from "../lib/partial_answer.ts";
import { createLogger } from "../lib/logger.ts";

export const partialAnswerCommand: Command = {
  name: "partial-answer",
  description: "Post partial answers on timeout (Issue #913)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "post");
    const logger = createLogger({
      debug: Deno.env.get("DEBUG") === "true",
    });

    switch (operation) {
      case "post": {
        const repo = String(args["repo"] ?? "");
        const issueNumber = Number(args["issue-number"] ?? 0);
        const githubUser = String(args["github-user"] ?? "");
        const claudeOutput = String(args["claude-output"] ?? "");
        const questionLabel = args["question-label"]
          ? String(args["question-label"])
          : undefined;
        const workerFooter = args["worker-footer"]
          ? String(args["worker-footer"])
          : undefined;

        if (!repo || !issueNumber) {
          return {
            success: false,
            message: "Missing required arguments: --repo, --issue-number",
          };
        }

        const result = await postPartialAnswer({
          repo,
          issueNumber,
          githubUser,
          claudeOutput,
          questionLabel,
          workerFooter,
          logger,
        });

        if (!result.ok) {
          return { success: false, message: result.error.message };
        }

        return {
          success: true,
          message: String(result.value),
          data: { posted: result.value },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown operation: ${operation}. Valid: post`,
        };
    }
  },
};
