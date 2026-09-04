/**
 * Refinement processor command (Issue #966, #1119).
 *
 * Command wrapper for the refinement processor library.
 * Exposes refinement processing as a Deno command, including the full
 * process-refinement operation that delegates from shell.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { resolveActingGithubUser } from "../lib/acting_github_user.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";
import {
  buildRefinementPrompt,
  getUnprocessedRefinementComments,
  hasWorkerRefinementResponse,
  parseRefinementResponse,
  processIssueRefinement,
  type RefinementResult,
} from "../lib/refinement_processor.ts";
import { createDefaultDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext } from "../lib/issue_worker.ts";

// Re-export library functions for external use
export {
  buildRefinementPrompt,
  getUnprocessedRefinementComments,
  hasWorkerRefinementResponse,
  parseRefinementResponse,
  processIssueRefinement,
};
export type { RefinementResult };

/**
 * The command, plus the environment seam it reads its identity through
 * (Issue #965).
 *
 * Declared as a widening of {@link Command} — the extra parameter is
 * optional and defaults to the process environment, so the registry and
 * `mod.ts` see the interface they always did.
 */
export interface RefinementProcessorCommand extends Command {
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    env?: EnvLookup,
  ): Promise<CommandResult<RefinementResult>>;
}

/** The refinement-processor command. */
export const refinementProcessorCommand: RefinementProcessorCommand = {
  name: "refinement-processor",
  description: "Process issue refinement requests (Issue #966, #1119)",
  /**
   * @param args - The operation and its inputs.
   * @param config - The worker configuration.
   * @param env - Where the acting `GITHUB_USER` is read from when
   *   `--github-user` is absent (Issue #965). Defaults to the process
   *   environment, so shell callers are unchanged; a test states the
   *   identity instead of deleting the variable from the process.
   */
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    env: EnvLookup = processEnvLookup,
  ): Promise<CommandResult<RefinementResult>> {
    const operation = String(args["operation"] ?? "");

    if (operation === "parse-response") {
      const output = String(args["output"] ?? "");
      const result = parseRefinementResponse(output);
      if (!result.ok) {
        return { success: false, message: result.error.message };
      }
      return {
        success: true,
        message: "Parsed refinement response",
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
      const prompt = buildRefinementPrompt(title, body, feedback);
      return {
        success: true,
        message: prompt,
      };
    }

    if (operation === "process-refinement") {
      const repo = String(args["repo"] ?? "");
      const issueNumber = Number(args["issue-number"] ?? 0);
      const issueTitle = String(args["issue-title"] ?? "");
      const githubUser = resolveActingGithubUser(args, env);

      if (!repo || !issueNumber || !githubUser) {
        return {
          success: false,
          message:
            "Missing required arguments: --repo, --issue-number, --github-user",
        };
      }

      const deps = createDefaultDeps();
      const ghClient = deps.github.createClient(deps.logger);

      // Top-level try/catch to prevent silent crashes (Issue #1150)
      try {
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

        const result = await processIssueRefinement(ctx, {
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
        deps.logger.error("Unhandled exception in refinement processing", {
          repo,
          issueNumber,
          error: errorMsg,
        });

        // Post failure comment so the user knows what went wrong (Issue #1150)
        try {
          await ghClient.postComment(
            repo,
            issueNumber,
            `## Refinement Failed\n\nUnexpected error during refinement: ${errorMsg}\n\n---\n🤖 Processed by: ${githubUser}`,
          );
        } catch {
          // Best effort — do not mask the original error
        }

        // Remove refinement label to prevent limbo (Issue #1150)
        try {
          await ghClient.removeLabel(
            repo,
            issueNumber,
            config.refineIssueLabel,
          );
        } catch {
          // Best effort
        }

        return {
          success: false,
          message: `Unhandled refinement error: ${errorMsg}`,
        };
      }
    }

    return {
      success: false,
      message:
        `Unknown operation: ${operation}. Valid: parse-response, build-prompt, process-refinement`,
    };
  },
};
