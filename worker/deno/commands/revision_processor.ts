/**
 * Revision processor command (Issue #899, #1119).
 *
 * Command wrapper for the revision processor library.
 * Exposes revision processing as a Deno command, including the full
 * process-revision operation that delegates from shell.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildRevisionPrompt,
  getUnprocessedRevisionComments,
  hasWorkerRevisionResponse,
  parseRevisionResponse,
  processIssueRevision,
  type RevisionResult,
} from "../lib/revision_processor.ts";
import { createDefaultDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext } from "../lib/issue_worker.ts";

// Re-export library functions for external use
export {
  buildRevisionPrompt,
  getUnprocessedRevisionComments,
  hasWorkerRevisionResponse,
  parseRevisionResponse,
  processIssueRevision,
};
export type { RevisionResult };

/** The revision-processor command. */
export const revisionProcessorCommand: Command = {
  name: "revision-processor",
  description: "Process issue revision requests (Issue #899, #1119)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RevisionResult>> {
    const operation = String(args["operation"] ?? "");

    if (operation === "parse-response") {
      const output = String(args["output"] ?? "");
      const result = parseRevisionResponse(output);
      if (!result.ok) {
        return { success: false, message: result.error.message };
      }
      return {
        success: true,
        message: "Parsed revision response",
        data: {
          processed: true,
          titleUpdated: result.value.update_title,
          bodyUpdated: result.value.update_body,
          commentsProcessed: 0,
          summary: result.value.summary,
        },
      };
    }

    if (operation === "build-prompt") {
      const title = String(args["title"] ?? "");
      const body = String(args["body"] ?? "");
      const feedback = String(args["feedback"] ?? "");
      const prompt = buildRevisionPrompt(title, body, feedback);
      return {
        success: true,
        message: prompt,
      };
    }

    if (operation === "process-revision") {
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

      // Fetch issue data for context
      let issueBody = "";
      try {
        const issue = await ghClient.getIssue(repo, issueNumber);
        issueBody = issue.body ?? "";
      } catch (err) {
        deps.logger.warn(
          "Failed to fetch issue data, proceeding with empty body",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }

      const ctx: IssueContext = {
        repo,
        issueNumber,
        issueTitle,
        issueBody,
        issueLabels: [],
        issueComments: "",
        githubUser,
        config,
      };

      const result = await processIssueRevision(ctx, {
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
    }

    return {
      success: false,
      message:
        `Unknown operation: ${operation}. Valid: parse-response, build-prompt, process-revision`,
    };
  },
};
