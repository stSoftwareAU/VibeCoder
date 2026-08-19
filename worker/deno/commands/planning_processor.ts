/**
 * Planning processor command (Issue #966, #1226).
 *
 * Command wrapper for the planning processor library.
 * Exposes planning processing as a Deno command.
 *
 * Issue #1226: Added 'process' operation so shell can delegate the full
 * planning workflow to Deno, including complexity context detection,
 * sub-issue parsing, and state management.
 *
 * Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  buildPlanningSummaryComment,
  countSubIssues,
  detectCreatedSubIssues,
  extractSubIssueNumbers,
  extractSubIssueUrls,
  type PlanningResult,
  processIssuePlanning,
} from "../lib/planning_processor.ts";
import { createDefaultDeps } from "../lib/issue_worker_wiring.ts";
import type { IssueContext } from "../lib/issue_worker.ts";
import { prepareTrustAnnotatedComments } from "../lib/comment_trust_filter.ts";

// Re-export library functions for external use
export {
  buildPlanningSummaryComment,
  countSubIssues,
  detectCreatedSubIssues,
  extractSubIssueNumbers,
  extractSubIssueUrls,
  processIssuePlanning,
};
export type { PlanningResult };

/** The planning-processor command. */
export const planningProcessorCommand: Command = {
  name: "planning-processor",
  description: "Process issue planning requests (Issue #966, #1226)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<PlanningResult>> {
    const operation = String(args["operation"] ?? "");

    if (operation === "count-sub-issues") {
      const output = String(args["output"] ?? "");
      const count = countSubIssues(output);
      return {
        success: true,
        message: `Found ${count} sub-issue(s)`,
        data: {
          processed: true,
          subIssueCount: count,
          subIssueUrls: extractSubIssueUrls(output),
          summary: `Found ${count} sub-issue(s)`,
        },
      };
    }

    if (operation === "extract-sub-issue-numbers") {
      const output = String(args["output"] ?? "");
      const repo = String(args["repo"] ?? "");
      const numbers = extractSubIssueNumbers(output, repo);
      return {
        success: true,
        message: `Found ${numbers.length} sub-issue number(s)`,
        data: {
          processed: true,
          subIssueCount: numbers.length,
          subIssueUrls: numbers.map((n) =>
            `https://github.com/${repo}/issues/${n}`
          ),
          summary: `Found sub-issues: ${numbers.join(", ")}`,
        },
      };
    }

    if (operation === "detect-created-sub-issues") {
      const output = String(args["output"] ?? "");
      const detected = detectCreatedSubIssues(output);
      return {
        success: true,
        message: String(detected),
        data: {
          processed: true,
          subIssueCount: detected ? countSubIssues(output) : 0,
          subIssueUrls: detected ? extractSubIssueUrls(output) : [],
          summary: detected
            ? "Sub-issue creation detected"
            : "No sub-issue creation detected",
        },
      };
    }

    if (operation === "build-summary-comment") {
      const urls = args["urls"];
      const githubUser = String(args["github-user"] ?? "");
      const escalationReason = args["escalation-reason"]
        ? String(args["escalation-reason"])
        : undefined;
      const urlList = Array.isArray(urls) ? urls.map(String) : [];
      const comment = buildPlanningSummaryComment(
        urlList,
        githubUser,
        escalationReason,
      );
      return {
        success: true,
        message: comment,
      };
    }

    // Issue #1226: Full planning workflow — delegates entirely to Deno.
    // Shell wrapper passes repo, issue-number, issue-title, and github-user;
    // this operation fetches issue data, detects complexity, builds the prompt,
    // runs Claude, checks for sub-issues, retries if needed, and closes the
    // planning issue.
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
        // Set up the target repo directory so Claude runs with correct context
        // (Issue #358). Without this, Claude reads the wrong project files.
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

        // Issue #1340: Use trust-annotated comments when trust lists are configured.
        const hasTrustConfig = (config.allowedAuthors?.length ?? 0) > 0 ||
          (config.authorisedCommenters?.length ?? 0) > 0;

        let formattedComments: string;
        // Set only on the trust-annotated path, where the assembled blob
        // carries genuine per-comment headers (Issue #3637).
        let commentBoundaryId: string | undefined;
        if (hasTrustConfig) {
          const rawJson = JSON.stringify({
            comments: issueData.comments.map(
              (c: { author: string; body: string }) => ({
                body: c.body,
                author: { login: c.author },
              }),
            ),
          });
          const trustResult = prepareTrustAnnotatedComments(rawJson, {
            allowedAuthors: config.allowedAuthors ?? [],
            authorisedCommenters: config.authorisedCommenters ?? [],
            includeUntrustedComments: config.includeUntrustedComments ?? true,
          });
          formattedComments = trustResult.formattedComments;
          commentBoundaryId = trustResult.boundaryId;

          for (const auditMsg of trustResult.securityAuditMessages) {
            deps.logger.warn(auditMsg, { repo, issueNumber });
          }
        } else {
          formattedComments = issueData.comments.map(
            (c: { author: string; body: string }) => `[${c.author}]: ${c.body}`,
          ).join("\n\n");
        }

        const ctx: IssueContext = {
          repo,
          issueNumber,
          issueTitle: issueTitle || issueData.body.slice(0, 100),
          issueBody: issueData.body,
          issueLabels: issueData.labels,
          issueComments: formattedComments,
          commentBoundaryId,
          githubUser,
          // Issue #1300: Pass milestone so sub-issues inherit it
          milestoneTitle: issueData.milestoneTitle || undefined,
          config: { ...config, workDir: repoWorkDir },
        };

        const result = await processIssuePlanning(ctx, {
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
        deps.logger.error("Unhandled exception in planning processing", {
          repo,
          issueNumber,
          error: errorMsg,
        });

        // Post failure comment so the user knows what went wrong (Issue #1226)
        try {
          await ghClient.postComment(
            repo,
            issueNumber,
            `## Planning Failed\n\nUnexpected error during planning: ${errorMsg}\n\n---\n🤖 Processed by: ${githubUser}`,
          );
        } catch {
          // Best effort — do not mask the original error
        }

        // Remove planning label to prevent limbo
        try {
          await ghClient.removeLabel(repo, issueNumber, config.planningLabel);
        } catch {
          // Best effort
        }

        return {
          success: false,
          message: `Unhandled planning error: ${errorMsg}`,
        };
      }
    }

    return {
      success: false,
      message:
        `Unknown operation: ${operation}. Valid: count-sub-issues, detect-created-sub-issues, extract-sub-issue-numbers, build-summary-comment, process`,
    };
  },
};
