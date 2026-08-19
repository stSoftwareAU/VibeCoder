/**
 * Purge stale workflow-sync issues command.
 *
 * Re-audits each configured repo (or a single repo passed via `--repo`)
 * and closes any open issue carrying a workflow-sync deduplication tag
 * whose underlying workflow now classifies as **present** under the
 * current detection logic.
 *
 * Issue #1582: Add command to close stale false-positive workflow-sync
 * partial-match issues.
 *
 * Usage:
 *   deno run mod.ts purge-stale-workflow-issues [--repo owner/repo] [--dry-run]
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type PurgeOptions,
  type PurgeResult,
  purgeStaleWorkflowIssuesForAllRepos,
  purgeStaleWorkflowIssuesForRepo,
} from "../lib/purge_stale_workflow_issues.ts";

interface PurgeCommandData {
  /** Per-repo result: ok flag, repo, and either the purge details or error. */
  results: Array<
    | {
      ok: true;
      repo: string;
      closed: number;
      kept: number;
      notApplicable: number;
      failures: number;
    }
    | { ok: false; repo: string; error: string }
  >;
  totalClosed: number;
  totalKept: number;
  totalNotApplicable: number;
  totalFailures: number;
}

function summarise(result: PurgeResult): {
  ok: true;
  repo: string;
  closed: number;
  kept: number;
  notApplicable: number;
  failures: number;
} {
  return {
    ok: true,
    repo: result.repo,
    closed: result.closed.length,
    kept: result.kept.length,
    notApplicable: result.notApplicable.length,
    failures: result.failures.length,
  };
}

export const purgeStaleWorkflowIssuesCommand: Command = {
  name: "purge-stale-workflow-issues",
  description:
    "Close stale workflow-sync issues whose workflow is now classified as present",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<PurgeCommandData>> {
    const dryRun = args["dry-run"] === true || args["dryRun"] === true;
    const singleRepo = typeof args["repo"] === "string"
      ? args["repo"]
      : undefined;

    const repos = singleRepo ? [singleRepo] : (config.repos ?? []);
    if (repos.length === 0) {
      return {
        success: true,
        message: "No repos configured — nothing to purge.",
        data: {
          results: [],
          totalClosed: 0,
          totalKept: 0,
          totalNotApplicable: 0,
          totalFailures: 0,
        },
      };
    }

    const options: PurgeOptions = { dryRun };

    const summary: PurgeCommandData = {
      results: [],
      totalClosed: 0,
      totalKept: 0,
      totalNotApplicable: 0,
      totalFailures: 0,
    };

    if (singleRepo) {
      const result = await purgeStaleWorkflowIssuesForRepo(singleRepo, options);
      if (!result.ok) {
        summary.results.push({
          ok: false,
          repo: singleRepo,
          error: result.error,
        });
      } else {
        summary.results.push(summarise(result.value));
        summary.totalClosed += result.value.closed.length;
        summary.totalKept += result.value.kept.length;
        summary.totalNotApplicable += result.value.notApplicable.length;
        summary.totalFailures += result.value.failures.length;
      }
    } else {
      const results = await purgeStaleWorkflowIssuesForAllRepos(repos, options);
      for (const { repo, result } of results) {
        if (!result.ok) {
          summary.results.push({ ok: false, repo, error: result.error });
          continue;
        }
        summary.results.push(summarise(result.value));
        summary.totalClosed += result.value.closed.length;
        summary.totalKept += result.value.kept.length;
        summary.totalNotApplicable += result.value.notApplicable.length;
        summary.totalFailures += result.value.failures.length;
      }
    }

    const verb = dryRun ? "would close" : "closed";
    const message =
      `Purge complete: ${verb} ${summary.totalClosed} issue(s); ${summary.totalNotApplicable} not applicable; kept ${summary.totalKept}; ${summary.totalFailures} failure(s).`;

    return {
      success: summary.totalFailures === 0,
      message,
      data: summary,
    };
  },
};
