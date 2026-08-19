/**
 * Stale workflow detector command for the Vibe Coder worker.
 *
 * Scans configured repos for issues stuck in workflow states and takes
 * appropriate action (reminders, diagnostics, warnings).
 *
 * Issue #1240: Auto-detect and handle stale workflow labels on issues.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  scanForStaleWorkflowIssues,
  STALE_WORKFLOW_DEFAULTS,
  type StaleWorkflowConfig,
  type StaleWorkflowDeps,
  type StaleWorkflowScanResult,
} from "../lib/stale_workflow_detector.ts";
import { createGitHubClient, runGhCommand } from "../lib/github.ts";
import { createLogger } from "../lib/logger.ts";
import { fetchCommentBatch } from "../lib/comment_batch.ts";
import type { GitHubComment, GitHubIssue } from "../types.ts";

/**
 * List open issues with a given label from a repository using the gh CLI.
 */
async function listIssuesByLabel(
  repo: string,
  label: string,
): Promise<GitHubIssue[]> {
  const json = await runGhCommand([
    "issue",
    "list",
    "--repo",
    repo,
    "--label",
    label,
    "--state",
    "open",
    "--json",
    "number,title,body,labels,author,assignees,createdAt,updatedAt",
    "--limit",
    "50",
  ]);

  const parsed = JSON.parse(json) as Array<{
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    author: { login: string };
    assignees: Array<{ login: string }>;
    createdAt: string;
    updatedAt: string;
  }>;

  return parsed.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    labels: i.labels.map((l) => l.name),
    author: i.author.login,
    assignees: i.assignees.map((a) => a.login),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  }));
}

/**
 * Fetch the GraphQL rate-limit reset epoch (Unix seconds) via
 * `gh api rate_limit`. This call is free (does not consume quota) and
 * works even when the quota is exhausted, so it is safe to invoke
 * from inside a rate-limit handler.
 *
 * Falls back to the core resource if the GraphQL resource is missing
 * (older GitHub Enterprise installations). Returns now+3600 if the
 * payload cannot be parsed.
 *
 * Issue #1781: production helper for waitUntilRateLimitReset.
 */
async function fetchGraphqlRateLimitReset(): Promise<number> {
  const raw = await runGhCommand(["api", "rate_limit"]);
  const parsed = JSON.parse(raw) as {
    resources?: {
      graphql?: { reset?: number };
      core?: { reset?: number };
    };
  };
  const reset = parsed.resources?.graphql?.reset ??
    parsed.resources?.core?.reset;
  if (typeof reset !== "number" || !Number.isFinite(reset)) {
    return Math.floor(Date.now() / 1000) + 3600;
  }
  return reset;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

export const staleWorkflowDetectorCommand: Command = {
  name: "stale-workflow-detector",
  description: "Detect and handle issues stuck in workflow states",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<StaleWorkflowScanResult>> {
    const repos = args["repos"]
      ? (Array.isArray(args["repos"])
        ? args["repos"].map(String)
        : String(args["repos"]).split(","))
      : config.repos ?? [];

    const logger = createLogger({ debug: false });
    const ghClient = createGitHubClient(logger);

    // Issue #2031: needs-clarification reminder/auto-close branch retired —
    // those issues are handed off to humans via needs-human. Only the
    // failure-diagnostic and planning-warning branches remain.
    const staleConfig: StaleWorkflowConfig = {
      repos,
      labels: {
        failed: config.failedLabel ?? "failed",
        failedOnce: config.failedOnceLabel ?? "failed-once",
        planning: config.planningLabel ?? "planning",
      },
      thresholds: {
        failedDiagnosticDays: toNumber(
          args["failed-diagnostic-days"],
          config.staleFailedDiagnosticDays ??
            STALE_WORKFLOW_DEFAULTS.failedDiagnosticDays,
        ),
        planningWarningDays: toNumber(
          args["planning-warning-days"],
          config.stalePlanningWarningDays ??
            STALE_WORKFLOW_DEFAULTS.planningWarningDays,
        ),
      },
    };

    const deps: StaleWorkflowDeps = {
      listIssuesByLabel,
      getIssueComments: (repo, issueNumber) =>
        ghClient.getIssueComments(repo, issueNumber),
      // Issue #1842: collapse the per-issue REST loop into a single
      // batched GraphQL call. Sub-batches that fail are reported but
      // the detector falls back to per-issue REST for the missing
      // issues, so a transient failure cannot abort the scan.
      getIssueCommentsBatch: async (
        repo: string,
        issueNumbers: number[],
      ): Promise<Map<number, GitHubComment[]>> => {
        const result = await fetchCommentBatch(repo, issueNumbers);
        for (const err of result.errors) {
          logger.info(
            `[stale-workflow] comment batch sub-call failed for ${repo}: ${err.message}`,
          );
        }
        return result.comments;
      },
      postComment: async (repo, issueNumber, body) => {
        // Adapter: drop the GitHubComment return value so the
        // StaleWorkflowDeps shape (Promise<void>) is satisfied.
        await ghClient.postComment(repo, issueNumber, body);
      },
      closeIssue: async (repo, issueNumber) => {
        await runGhCommand([
          "issue",
          "close",
          String(issueNumber),
          "--repo",
          repo,
          "--comment",
          "",
        ]);
      },
      log: (msg) => logger.info(msg),
      now: () => Date.now(),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      // Standalone command invocation has no main-loop shutdown signal,
      // so the rate-limit wait honours only the safety cap (Issue #1781).
      shouldShutdown: () => false,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      getRateLimitReset: () => fetchGraphqlRateLimitReset(),
    };

    const result = await scanForStaleWorkflowIssues(staleConfig, deps);
    if (!result.ok) {
      return { success: false, message: result.error.message };
    }

    return {
      success: true,
      message:
        `Scanned ${result.value.scanned} repos, actioned ${result.value.actioned} stale issues`,
      data: result.value,
    };
  },
};
