/**
 * Production-loop add-repo routing helper (Issue #2579).
 *
 * Routes a claimed `work-on` issue whose title starts with `add-repo:`
 * (for example `add-repo: stSoftwareAU/private-repo-11`) to the
 * `process-add-repo` command (Issue #2578) instead of the standard
 * Claude-driven coding/PR flow — which would otherwise try to open a
 * code PR, the wrong outcome for an add-repo request.
 *
 * Discovery is unchanged: the existing issue scan already claims
 * `work-on` issues by allowed authors. This helper only adds a cheap
 * title-prefix routing branch, so it stays well within the per-handler
 * watchdog budget. The slug carried in the title is re-validated
 * downstream by `process-add-repo` (defence in depth).
 *
 * Modelled on `idle_task_process_issue_route.ts`: the production factory
 * wires the real command `execute`; tests inject a stub so the routing
 * shape is exercised with no real network.
 *
 * Issue #1193: the request is **claimed** before the command runs. This
 * route dispatches ahead of `workOnIssue`, whose setup phase held the only
 * `claimIssue` call, so an `add-repo:` request took no claim lock at all and
 * two hosts scanning the same repo both ran it. See `route_claim.ts`.
 *
 * Australian English spelling used throughout.
 */

import type { CommandResult, WorkerConfig } from "../types.ts";
import { ADD_REPO_PREFIX } from "./add_repo.ts";
import { processAddRepoCommand } from "../commands/process_add_repo.ts";
import {
  type RouteClaimDeps,
  type RouteClaimLost,
  runWithRouteClaim,
} from "./route_claim.ts";

/** Input describing the issue under consideration. */
export interface RouteAddRepoInput {
  /** The repo the issue lives in (where to comment/close). */
  repo: string;
  issueNumber: number;
  issueTitle: string;
  /** Worker config threaded into the command (needs-human label, etc.). */
  config: WorkerConfig;
  /**
   * This host's GitHub login — the assignee that locks a recognised request
   * against a sibling host (Issue #1193). Required: a route that cannot
   * claim must not silently run the command.
   */
  githubUser: string;
  /** Working directory holding the heartbeat and marker state. */
  workDir: string;
  /**
   * Fleet logins whose `CLAIM_LOCK` markers are trusted and whose open PRs
   * defer the claim (`resolveFleetAuthors`), forwarded to `claimIssue`.
   * Required, not optional: an omitted set silently narrows the claim's
   * trust to this login and switches off the live fleet-PR re-check, and a
   * guard that can be disabled by forgetting a field is no guard.
   */
  fleetAuthors: string[];
  /**
   * The fleet's push-capable logins (`resolveFleetMaintenanceAuthorSet`) —
   * only their open PRs defer the claim (Issue #4133). Required for the
   * same reason as `fleetAuthors`.
   */
  pushCapableAuthors: string[];
}

/** Seam for the underlying command call. Defaults to `process-add-repo`. */
export type ProcessAddRepoExecuteFn = (
  args: Record<string, unknown>,
  config: WorkerConfig,
) => Promise<CommandResult>;

/** Injectable seams. Defaults wire the production implementation. */
export interface RouteAddRepoDeps extends RouteClaimDeps {
  executeFn?: ProcessAddRepoExecuteFn;
}

/**
 * Outcome:
 * - `{ routed: false }` — the title is not an `add-repo:` request; the
 *   caller should run the standard `workOnIssue` pipeline.
 * - `{ routed: true, success }` — `process-add-repo` took ownership and
 *   has commented/closed (or escalated) the issue. `success` mirrors the
 *   command's `CommandResult.success`.
 * - `{ routed: true, success: false, claimLost: true, … }` — this host does
 *   not hold the request (Issue #1193). The command never ran and nothing
 *   was written to the issue.
 */
export type RouteAddRepoOutcome =
  | { routed: false }
  | { routed: true; success: boolean }
  | ({ routed: true; success: false } & RouteClaimLost);

/** Cheap title-prefix test (case-insensitive), matching `parseAddRepoTitle`. */
export function isAddRepoTitle(title: string): boolean {
  return title.trim().toLowerCase().startsWith(ADD_REPO_PREFIX);
}

/**
 * Dispatch an issue to `process-add-repo` when its title starts with
 * `add-repo:`; otherwise pass through unchanged.
 *
 * A recognised request is claimed first (Issue #1193): adding a repo twice
 * is not idempotent bookkeeping — each run comments on the issue and can
 * open its own follow-up work — so a host that is refused the claim runs
 * nothing at all.
 */
export async function routeAddRepoInProcessIssue(
  input: RouteAddRepoInput,
  deps: RouteAddRepoDeps,
): Promise<RouteAddRepoOutcome> {
  if (!isAddRepoTitle(input.issueTitle)) {
    return { routed: false };
  }

  const execute: ProcessAddRepoExecuteFn = deps.executeFn ??
    ((args, config) => processAddRepoCommand.execute(args, config));

  const held = await runWithRouteClaim(
    {
      route: "add-repo",
      repo: input.repo,
      issueNumber: input.issueNumber,
      githubUser: input.githubUser,
      workDir: input.workDir,
      fleetAuthors: input.fleetAuthors,
      pushCapableAuthors: input.pushCapableAuthors,
    },
    deps,
    async () => {
      deps.logger.info("Routing add-repo issue to process-add-repo", {
        repo: input.repo,
        issueNumber: input.issueNumber,
        issueTitle: input.issueTitle,
      });
      const result = await execute(
        {
          "repo": input.repo,
          "issue-number": input.issueNumber,
          "title": input.issueTitle,
        },
        input.config,
      );
      return result.success;
    },
  );

  return held.claimed
    ? { routed: true, success: held.value }
    : { routed: true, success: false, ...held.lost };
}
