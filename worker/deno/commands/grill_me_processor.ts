/**
 * Grill-me processor command (Issue #1615, #1618).
 *
 * Thin command wrapper around the grill-me processor library. Exposes
 * two operations:
 *   - `process` — run a single grill-me round end-to-end
 *   - `build-grill-me-prompt` — render the prompt for shell-driven flows
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildGrillMePrompt,
  countConsecutiveFailures,
  countGrillMeRounds,
  formatCommentHistory,
  GRILL_ME_FAILED_MARKER,
  GRILL_ME_FINAL_MARKER,
  GRILL_ME_READY_MARKER,
  GRILL_ME_ROUND_MARKER,
  type GrillMeResult,
  hasReadyMarkerBeenPosted,
  processGrillMe,
} from "../lib/grill_me_processor.ts";
import { createDefaultDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext } from "../lib/issue_worker.ts";

export {
  buildGrillMePrompt,
  countConsecutiveFailures,
  countGrillMeRounds,
  formatCommentHistory,
  GRILL_ME_FAILED_MARKER,
  GRILL_ME_FINAL_MARKER,
  GRILL_ME_READY_MARKER,
  GRILL_ME_ROUND_MARKER,
  hasReadyMarkerBeenPosted,
  processGrillMe,
};
export type { GrillMeResult };

/** The grill-me-processor command. */
export const grillMeProcessorCommand: Command = {
  name: "grill-me-processor",
  description: "Run a single grill-me clarification round (Issue #1615, #1618)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<GrillMeResult>> {
    const operation = String(args["operation"] ?? "");

    if (operation === "build-grill-me-prompt") {
      const roundNumber = Number(args["round-number"] ?? 1);
      const maxRounds = Number(args["max-rounds"] ?? config.maxGrillMeRounds);
      const issueBody = String(args["issue-body"] ?? "");
      const commentHistory = String(args["comment-history"] ?? "");
      // Nonce of the genuine per-comment trust headers, when the caller built
      // the history with `formatCommentHistory` (Issue #3706). A malformed id
      // is discarded for a fresh nonce by `createPromptDelimiters`.
      const commentBoundaryId = args["comment-boundary-id"]
        ? String(args["comment-boundary-id"])
        : undefined;
      const repo = String(args["repo"] ?? "");
      const issueNumber = Number(args["issue-number"] ?? 0);
      const issueTitle = String(args["issue-title"] ?? "");
      const codingGuidelines = String(args["coding-guidelines"] ?? "");
      const verbosityInstructions = String(
        args["verbosity-instructions"] ?? "",
      );

      if (!repo || !issueNumber) {
        return {
          success: false,
          message: "Missing required arguments: --repo, --issue-number",
        };
      }

      const promptResult = await buildGrillMePrompt({
        roundNumber,
        maxRounds,
        issueBody,
        commentHistory,
        commentBoundaryId,
        repo,
        issueNumber,
        issueTitle,
        codingGuidelines,
        verbosityInstructions,
      });

      if (!promptResult.ok) {
        return { success: false, message: promptResult.error.message };
      }
      return { success: true, message: promptResult.value };
    }

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

      try {
        let issueBody = "";
        let issueLabels: string[] = [];
        try {
          const issue = await ghClient.getIssue(repo, issueNumber);
          issueBody = issue.body ?? "";
          issueLabels = issue.labels;
        } catch (err) {
          deps.logger.warn(
            "Failed to fetch issue data for grill-me — proceeding with empty body",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }

        const ctx: IssueContext = {
          repo,
          issueNumber,
          issueTitle,
          issueBody,
          issueLabels,
          issueComments: "",
          githubUser,
          config,
        };

        const result = await processGrillMe(ctx, {
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
        deps.logger.error("Unhandled exception in grill-me processing", {
          repo,
          issueNumber,
          error: errorMsg,
        });
        return {
          success: false,
          message: `Unhandled grill-me error: ${errorMsg}`,
        };
      }
    }

    return {
      success: false,
      message:
        `Unknown operation: ${operation}. Valid: process, build-grill-me-prompt`,
    };
  },
};
