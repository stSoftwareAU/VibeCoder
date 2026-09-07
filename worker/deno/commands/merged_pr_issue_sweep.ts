/**
 * Merged-PR issue sweep command (Issue #504).
 *
 * Closes every open issue across the monitored repos whose fix has already
 * merged and landed, whoever authored the PR. Runs as a housekeeping step so
 * the set no claim can reach — the issues the scan refuses permanently as
 * `merged-pr-permanent` — is swept by something other than the run that
 * happened to produce the fix.
 *
 * Issue #1477: the sweep is wired to the rate-limit machinery the rest of
 * the worker uses — a once-per-sweep pre-flight, the process-wide primary
 * quota latch, the shared scan and timeline caches on the work volume, and
 * its own sweep watermark — so an exhausted quota costs one call and one
 * line, and a warm cycle costs almost nothing.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { resolveFleetPrAuthorSet } from "../lib/fleet_authors.ts";
import { runGhCommandRaw } from "../lib/github.ts";
import { preflightGitHubRateLimit } from "../lib/github_rate_limit_preflight.ts";
import {
  probeGraphqlQuota,
  toRateLimitDocument,
} from "../lib/graphql_quota_probe.ts";
import { IssueCache } from "../lib/issue_cache.ts";
import { createLogger } from "../lib/logger.ts";
import {
  type MergedPrIssueSweepResult,
  sweepMergedPrIssues,
} from "../lib/merged_pr_issue_sweep.ts";
import { mergedIssueSweepWatermarkPath } from "../lib/merged_sweep_watermark.ts";
import { TimelineCache } from "../lib/timeline_cache.ts";

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
    const logger = createLogger({ debug: Deno.env.get("DEBUG") === "true" });
    const workDir = config.workDir || undefined;

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
      watermarkPath: workDir
        ? mergedIssueSweepWatermarkPath(workDir)
        : undefined,
    }, {
      // `runGhCommandRaw`, not the bare spawn: its catch notes the first
      // primary-quota refusal, which latches the process and writes the
      // shared signal, so every later step this cycle skips instead of
      // spending (Issue #42, #1477).
      ghCommandFn: (ghArgs) => runGhCommandRaw(ghArgs),
      logger,
      // The same directories the run's discovery passes read and fill
      // (Issue #4303), so the lists this sweep needs are usually already
      // there.
      cache: new IssueCache(workDir ? `${workDir}/.gh-scan-cache` : undefined),
      timelineCache: new TimelineCache(
        config.timelineCacheTtlSeconds,
        workDir ? `${workDir}/.gh-timeline-cache` : undefined,
      ),
      // Once per sweep, the same gate the main loop runs: the shared signal
      // first, then the cached quota reading, then one free probe.
      preflightFn: workDir
        ? () =>
          preflightGitHubRateLimit({
            workDir,
            nowSeconds: () => Math.floor(Date.now() / 1000),
            runGhRateLimit: async () => {
              const probe = await probeGraphqlQuota();
              if (probe.ok) return toRateLimitDocument(probe.value);
              logger.warn(
                `GraphQL quota probe failed — falling back to gh api rate_limit: ${probe.error.message}`,
              );
              return await runGhCommandRaw(["api", "rate_limit"]);
            },
            log: (m) => logger.info(m),
          })
        : undefined,
    });

    // Fail loud: a repo that could not be scanned, or a close that failed,
    // must not be reported as a clean sweep. A quota stop is not a failure
    // — nothing is wrong with any repo — and the message already says so.
    return {
      success: result.failures.length === 0,
      message: result.failures.length === 0
        ? result.message
        : `${result.message} — ${result.failures.join("; ")}`,
      data: result,
    };
  },
};
