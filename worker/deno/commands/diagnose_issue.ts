/**
 * diagnose-issue command (Issue #1063).
 *
 * Analyses a specific issue in a specific repo and reports exactly why
 * it would or would not be picked up by the worker. Essential for
 * debugging situations where issues are not being picked up.
 *
 * Usage:
 *   deno_run_command diagnose-issue --repo example-org/private-repo-13 --issue 1590
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  diagnoseIssue,
  formatDiagnosticReport,
} from "../lib/diagnose_issue.ts";
import type { DiagnosticReport } from "../lib/diagnose_issue.ts";

export const diagnoseIssueCommand: Command = {
  name: "diagnose-issue",
  description:
    "Diagnose why a specific issue would or would not be picked up by the worker",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<DiagnosticReport>> {
    const repo = args["repo"] as string | undefined;
    if (!repo) {
      return {
        success: false,
        message:
          "Required argument 'repo' is missing (e.g., --repo owner/repo)",
      };
    }

    const issueArg = args["issue"];
    const issueNumber = typeof issueArg === "number"
      ? issueArg
      : typeof issueArg === "string"
      ? parseInt(issueArg, 10)
      : NaN;

    if (isNaN(issueNumber) || issueNumber <= 0) {
      return {
        success: false,
        message:
          "Required argument 'issue' is missing or invalid (e.g., --issue 42)",
      };
    }

    const githubUser = (args["github-user"] as string | undefined) ??
      Deno.env.get("GITHUB_USER") ?? "";

    const report = await diagnoseIssue(repo, issueNumber, config, {
      githubUser,
    });

    const formatted = formatDiagnosticReport(report);

    return {
      success: true,
      message: formatted,
      data: report,
    };
  },
};
