/**
 * Merged-PR issue sweep command (Issue #504).
 *
 * Closes every open issue across the monitored repos whose fix has already
 * merged and landed, whoever authored the PR. Runs as a housekeeping step so
 * the set no claim can reach — the issues the scan refuses permanently as
 * `merged-pr-permanent` — is swept by something other than the run that
 * happened to produce the fix.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { resolveFleetPrAuthorSet } from "../lib/fleet_authors.ts";
import { runGhOrThrow } from "../lib/gh_spawn.ts";
import { createLogger } from "../lib/logger.ts";
import {
  type MergedPrIssueSweepResult,
  sweepMergedPrIssues,
} from "../lib/merged_pr_issue_sweep.ts";

/**
 * Args:
 *   --github-user <string>  Worker login, unassigned from any issue it closes
 *   --issue-limit <number>  Max open issues examined per repo (default: 200)
 */
export const mergedPrIssueSweepCommand: Command = {
  name: "merged-pr-issue-sweep",
  description:
    "Close open issues whose fix has already merged and landed (Issue #504)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<MergedPrIssueSweepResult>> {
    const githubUser = typeof args["github-user"] === "string"
      ? args["github-user"]
      : "";
    const issueLimit = typeof args["issue-limit"] === "number"
      ? args["issue-limit"]
      : undefined;

    const result = await sweepMergedPrIssues({
      repos: config.repos ?? [],
      githubUser,
      // The claim scan's own author set, so the sweep's candidates are
      // exactly the issues the scan refuses as `merged-pr-permanent`.
      fleetAuthors: resolveFleetPrAuthorSet({
        githubUser,
        allowedAuthors: config.allowedAuthors,
        fleetPrAuthors: config.fleetPrAuthors ?? [],
      }),
      allowedAuthors: config.allowedAuthors ?? [],
      needsHumanLabel: config.needsHumanLabel,
      planningLabel: config.planningLabel,
      closedPrCooldownSeconds: config.closedPrCooldownSeconds,
      issueLimit,
    }, {
      ghCommandFn: (ghArgs) => runGhOrThrow(ghArgs),
      logger: createLogger({ debug: Deno.env.get("DEBUG") === "true" }),
    });

    // Fail loud: a repo that could not be scanned, or a close that failed,
    // must not be reported as a clean sweep.
    return {
      success: result.failures.length === 0,
      message: result.failures.length === 0
        ? result.message
        : `${result.message} — ${result.failures.join("; ")}`,
      data: result,
    };
  },
};
