/**
 * Repo failure tracker command for the Vibe Coder worker.
 *
 * Per-repo failure tracking within a scan cycle to prevent one repo's
 * problems from starving other repos.
 * Callable from shell via the Deno CLI (`deno run mod.ts <command>`).
 *
 * Sub-operations (--operation):
 *   - record-failure: Record a failure for a repo (optionally with --issue)
 *   - record-success: Reset failure count for a repo
 *   - get-failure-count: Get current failure count (unique failed issues)
 *   - is-deprioritised: Check if repo should be skipped
 *   - reset-all: Reset all failure counts
 *
 * Issue #1066: record-failure now accepts --issue to track per-issue
 * failures. A single failing issue no longer cascades into deprioritising
 * the entire repository.
 *
 * Migrated from worker/shared/repo_failure_tracker.sh (Issue #909).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  DEFAULT_REPO_FAILURE_THRESHOLD,
  getRepoFailureCount,
  isRepoDeprioritised,
  recordRepoFailure,
  recordRepoSuccess,
  type RepoFailureTrackerConfig,
  resetRepoFailures,
} from "../lib/repo_failure_tracker.ts";

function buildConfig(args: Record<string, unknown>): RepoFailureTrackerConfig {
  return {
    failureFile: String(args["failure-file"] ?? ""),
    threshold: toNumber(args["threshold"], DEFAULT_REPO_FAILURE_THRESHOLD),
  };
}

function toNumber(value: unknown, fallback: number): number;
function toNumber(value: unknown, fallback: undefined): number | undefined;
function toNumber(
  value: unknown,
  fallback: number | undefined,
): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

export const repoFailureTrackerCommand: Command = {
  name: "repo-failure-tracker",
  description: "Per-repo failure tracking within a scan cycle",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult> {
    const operation = String(args["operation"] ?? "get-failure-count");
    const config = buildConfig(args);
    const repo = String(args["repo"] ?? "");

    switch (operation) {
      case "record-failure": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const issueNum = toNumber(args["issue"], undefined);
        const result = await recordRepoFailure(config, repo, issueNum);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return {
          success: true,
          message: String(result.value),
          data: { failureCount: result.value },
        };
      }

      case "record-success": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const result = await recordRepoSuccess(config, repo);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      case "get-failure-count": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const count = await getRepoFailureCount(config, repo);
        return {
          success: true,
          message: String(count),
          data: { failureCount: count },
        };
      }

      case "is-deprioritised": {
        if (!repo) {
          return { success: false, message: "Missing --repo argument" };
        }
        const deprioritised = await isRepoDeprioritised(config, repo);
        return {
          success: true,
          message: deprioritised ? "DEPRIORITISED" : "NOT_DEPRIORITISED",
          data: { deprioritised },
        };
      }

      case "reset-all": {
        const result = await resetRepoFailures(config);
        if (!result.ok) {
          return { success: false, message: result.error.message };
        }
        return { success: true, message: "OK" };
      }

      default:
        return {
          success: false,
          message: `Unknown repo-failure-tracker operation: ${operation}`,
        };
    }
  },
};
