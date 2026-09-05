/**
 * Production-loop routing helper for idle-task seeding requests (Issue #3860).
 *
 * Claims an issue whose title starts with `seed-idle-tasks:` (for
 * example `seed-idle-tasks: stSoftwareAU/private-repo-14`) and routes it to
 * the `process-seed-idle-tasks` command instead of the standard Claude-driven
 * coding/PR flow. That matters for more than tidiness: the standard flow
 * spawns the agent, whose baked `gh` allowlist carries only the claimed
 * issue's own repo (#3643), so every `gh issue create` against the target was
 * refused with `WRITE_REPO_BLOCKED` and the request died in a `needs-human`
 * hand-off. Routing keeps the seeding in the worker process, where the
 * allowlist can be extended to the operator-approved target.
 *
 * The branch fires **before** the agent is spawned, and the routed command
 * re-validates the target against the fleet `.config.json` `repos` list
 * (defence in depth). The agent's allowlist is never widened.
 *
 * Modelled on `add_repo_process_issue_route.ts`: the production factory wires
 * the real command `execute`; tests inject a stub so the routing shape is
 * exercised with no real network.
 *
 * Issue #1193: the request is **claimed** before the seeding runs. This route
 * dispatches ahead of `workOnIssue`, whose setup phase held the only
 * `claimIssue` call, so a `seed-idle-tasks:` request took no claim lock at all
 * and two hosts scanning the same repo both seeded the target — filing every
 * wrapper issue twice. See `route_claim.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { CommandResult, WorkerConfig } from "../types.ts";
import { isSeedIdleTasksTitle } from "./seed_idle_tasks_request.ts";
import { processSeedIdleTasksCommand } from "../commands/process_seed_idle_tasks.ts";
import {
  type RouteClaimDeps,
  type RouteClaimInput,
  type RouteClaimLost,
  runWithRouteClaim,
} from "./route_claim.ts";

/** Input describing the issue under consideration. */
export interface RouteSeedIdleTasksInput extends RouteClaimInput {
  issueTitle: string;
  /** Worker config — carries the operator-controlled `repos` allowlist. */
  config: WorkerConfig;
}

/** Seam for the underlying command call. */
export type ProcessSeedIdleTasksExecuteFn = (
  args: Record<string, unknown>,
  config: WorkerConfig,
) => Promise<CommandResult>;

/** Injectable seams. Defaults wire the production implementation. */
export interface RouteSeedIdleTasksDeps extends RouteClaimDeps {
  executeFn?: ProcessSeedIdleTasksExecuteFn;
}

/**
 * Outcome:
 * - `{ routed: false }` — not a seeding request; the caller should run the
 *   standard `workOnIssue` pipeline.
 * - `{ routed: true, success }` — `process-seed-idle-tasks` took ownership
 *   and has commented (and closed) the issue.
 * - `{ routed: true, success: false, claimLost: true, … }` — this host does
 *   not hold the request (Issue #1193). Nothing was seeded and nothing was
 *   written to the issue.
 */
export type RouteSeedIdleTasksOutcome =
  | { routed: false }
  | { routed: true; success: boolean }
  | ({ routed: true; success: false } & RouteClaimLost);

/**
 * Dispatch an issue to `process-seed-idle-tasks` when its title starts with
 * `seed-idle-tasks:`; otherwise pass through unchanged.
 *
 * A recognised request is claimed first (Issue #1193): seeding files issues
 * in the target repo, so two hosts running one request file every wrapper
 * twice. A host that is refused the claim seeds nothing.
 */
export async function routeSeedIdleTasksInProcessIssue(
  input: RouteSeedIdleTasksInput,
  deps: RouteSeedIdleTasksDeps,
): Promise<RouteSeedIdleTasksOutcome> {
  if (!isSeedIdleTasksTitle(input.issueTitle)) {
    return { routed: false };
  }

  const execute: ProcessSeedIdleTasksExecuteFn = deps.executeFn ??
    ((args, config) => processSeedIdleTasksCommand.execute(args, config));

  const held = await runWithRouteClaim(
    {
      route: "seed-idle-tasks",
      repo: input.repo,
      issueNumber: input.issueNumber,
      githubUser: input.githubUser,
      workDir: input.workDir,
      fleetAuthors: input.fleetAuthors,
      pushCapableAuthors: input.pushCapableAuthors,
    },
    deps,
    async () => {
      deps.logger.info(
        "Routing idle-task seeding issue to process-seed-idle-tasks",
        {
          repo: input.repo,
          issueNumber: input.issueNumber,
          issueTitle: input.issueTitle,
        },
      );
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
