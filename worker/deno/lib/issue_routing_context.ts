/**
 * Shared construction of the {@link IssueRoutingContext} (Issue #3691).
 *
 * Both `suggest-improvements` and `route-issue` file issues through
 * `routeIssueCreation`; this is the one place that decides which repositories
 * the worker may file in, so the two cannot drift.
 *
 * Australian English spelling used throughout.
 */

import type { Logger } from "../types.ts";
import type { IssueRoutingContext } from "./issue_routing.ts";
import {
  loadMonitoredReposBestEffort,
  type MonitoredReposDeps,
} from "./monitored_repos_allowlist.ts";

/** The worker's own repository: owner of worker, prompt and fleet work. */
export const VIBE_CODER_REPO = "stSoftwareAU/VibeCoder";

/** A closed issue younger than this still counts as a duplicate to reuse. */
export const ISSUE_ROUTING_RECENTLY_CLOSED_DAYS = 30;

export interface BuildIssueRoutingContextOptions {
  /** The repository the issue is being filed from / against. */
  targetRepo: string;
  dryRun: boolean;
  /** Provides `config.loadConfig` for the monitored-repo allowlist. */
  deps: MonitoredReposDeps;
  logger: Logger;
  /** Injected clock (epoch milliseconds). */
  nowMs: number;
}

/**
 * Build the routing context: the monitored repositories plus the target repo
 * itself are the only places a write is permitted.
 */
export async function buildIssueRoutingContext(
  options: BuildIssueRoutingContextOptions,
): Promise<IssueRoutingContext> {
  const monitored = await loadMonitoredReposBestEffort(
    options.deps,
    options.logger,
  );
  const allowedRepos = [...monitored];
  if (
    !allowedRepos.some((r) =>
      r.toLowerCase() === options.targetRepo.toLowerCase()
    )
  ) {
    allowedRepos.push(options.targetRepo);
  }
  return {
    vibeCoderRepo: VIBE_CODER_REPO,
    allowedRepos,
    dryRun: options.dryRun,
    recentlyClosedDays: ISSUE_ROUTING_RECENTLY_CLOSED_DAYS,
    nowMs: options.nowMs,
  };
}
