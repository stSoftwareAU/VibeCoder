/**
 * Execute-claude phase command for the Vibe Coder worker (Issue #1227).
 *
 * Wraps the full Claude execution flow: screenshot detection, prompt building,
 * Claude invocation with heartbeat, timeout/rate-limit error handling,
 * self-healing PR detection, and change detection. Callable from shell
 * via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Arguments:
 *   --repo                      Repository in "owner/repo" format
 *   --issue-number              Issue number
 *   --issue-title               Issue title
 *   --issue-body                Issue body
 *   --issue-labels              Comma-separated issue labels
 *   --github-user               Worker's GitHub username
 *   --branch-name               Feature branch name
 *   --base-branch               Base branch (default/milestone)
 *   --milestone-branch          Milestone branch (empty if none)
 *   --clarity-status            Clarity status from clarity phase
 *   --work-dir                  Working directory for heartbeat files
 *   --claude-timeout            Claude timeout in seconds (default: 14400)
 *   --claude-kill-after         Grace period in seconds (default: 30)
 *   --max-rate-limit-retries    Max rate-limit retries (default: 2)
 *   --max-rate-limit-wait       Max rate-limit wait in seconds (default: 600)
 *   --claude-no-output-timeout  No-output timeout for diagnostics (default: 900)
 *   --needs-screenshot-label    Screenshot label name (default: "needs-screenshot")
 *   --credit-log-dir            Credit log directory (optional)
 *   --worker-name               Worker name for credit tracking (optional)
 *   --milestone-id              Milestone number for session branching (Issue #1322)
 *
 * Output: JSON with the phase result:
 *   { action, failureType?, failureMessage?, diagnosticContext?,
 *     prUrl?, prNumber?, hasUncommittedChanges?, hasNewCommits?,
 *     promptVersions?, elapsedSeconds? }
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type ExecuteClaudePhaseResult,
  runExecuteClaudePhase,
} from "../lib/execute_claude_phase.ts";
import { saveSession } from "../lib/session_manager.ts";
import { buildProgressExtension } from "../lib/progress_extension_runtime.ts";

export const executeClaudePhaseCommand: Command = {
  name: "execute-claude-phase",
  description:
    "Execute Claude phase — prompt building, Claude invocation, timeout/error handling, self-healing (Issue #1227)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<ExecuteClaudePhaseResult>> {
    const repo = String(args["repo"] ?? "");
    const issueNumber = Number(args["issue-number"] ?? 0);
    const issueTitle = String(args["issue-title"] ?? "");
    const issueBody = String(args["issue-body"] ?? "");
    const issueLabels = String(args["issue-labels"] ?? "");
    const githubUser = String(args["github-user"] ?? "");
    const branchName = String(args["branch-name"] ?? "");
    const baseBranch = String(args["base-branch"] ?? "");
    const milestoneBranch = String(args["milestone-branch"] ?? "");
    const clarityStatus = String(args["clarity-status"] ?? "clear");
    const workDir = String(args["work-dir"] ?? config.workDir ?? "/tmp");
    const claudeTimeout = Number(
      args["claude-timeout"] ?? config.claudeTimeout ?? 14400,
    );
    const claudeKillAfter = Number(
      args["claude-kill-after"] ?? config.claudeKillAfter ?? 30,
    );
    const maxRateLimitRetries = Number(
      args["max-rate-limit-retries"] ?? config.maxRateLimitRetries ?? 2,
    );
    const maxRateLimitWait = Number(
      args["max-rate-limit-wait"] ?? config.maxRateLimitWait ?? 600,
    );
    const claudeNoOutputTimeout = Number(
      args["claude-no-output-timeout"] ?? config.claudeNoOutputTimeout ?? 900,
    );
    const needsScreenshotLabel = String(
      args["needs-screenshot-label"] ?? "needs-screenshot",
    );
    const creditLogDir = args["credit-log-dir"]
      ? String(args["credit-log-dir"])
      : undefined;
    const workerName = args["worker-name"]
      ? String(args["worker-name"])
      : config.workerName || undefined;
    const milestoneId = args["milestone-id"]
      ? Number(args["milestone-id"])
      : undefined;

    // Validate required arguments
    if (!repo) {
      return { success: false, message: "Missing required argument: --repo" };
    }
    if (!issueNumber) {
      return {
        success: false,
        message: "Missing required argument: --issue-number",
      };
    }
    if (!branchName) {
      return {
        success: false,
        message: "Missing required argument: --branch-name",
      };
    }
    if (!baseBranch) {
      return {
        success: false,
        message: "Missing required argument: --base-branch",
      };
    }

    // Re-armable deadline for issue work only (Issue #4296, part of #4290);
    // undefined unless the operator enabled it, which leaves the hard
    // timeout exactly as it was.
    const repoName = repo.split("/").pop() ?? repo;
    const repoPath = `${workDir}/${repoName}`;
    const progressExtension = await buildProgressExtension(config, repoPath);

    const result = await runExecuteClaudePhase({
      repo,
      issueNumber,
      issueTitle,
      issueBody,
      issueLabels,
      githubUser,
      branchName,
      baseBranch,
      milestoneBranch,
      clarityStatus,
      workDir,
      repoConfigs: config.repoConfig,
      claudeTimeout,
      claudeKillAfter,
      maxRateLimitRetries,
      maxRateLimitWait,
      claudeNoOutputTimeout,
      needsScreenshotLabel,
      creditLogDir,
      workerName,
      includeRecentActivity: config.includeRecentActivity,
      recentActivityMergedPrLimit: config.recentActivityMergedPrLimit,
      recentActivityCommitLimit: config.recentActivityCommitLimit,
      recentActivityMaxTokens: config.recentActivityMaxTokens,
      recentActivityCacheTtlSeconds: config.recentActivityCacheTtlSeconds,
      includeCodebaseMap: config.includeCodebaseMap,
      // Context budget thresholds, including the hard ceiling (Issue #3713)
      contextBudgetWarningPercent: config.contextBudgetWarningPercent,
      contextBudgetErrorPercent: config.contextBudgetErrorPercent,
      contextBudgetBlockPercent: config.contextBudgetBlockPercent,
      needsHumanLabel: config.needsHumanLabel,
      ...(progressExtension ? { progressExtension } : {}),
    });

    // Save Claude session state to per-repo store after execution (Issue #1321, #1322)
    await saveSession(repoPath, workDir, repo, undefined, milestoneId);

    const success = result.action === "success" ||
      result.action === "self_healed" ||
      result.action === "remote_self_healed";

    // Output JSON for shell parsing
    return {
      success,
      message: JSON.stringify(result),
      data: result,
    };
  },
};
