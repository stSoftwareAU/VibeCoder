/**
 * Production-loop routing helper for idle-task seeding requests (Issue #3860).
 *
 * Routes a claimed issue whose title starts with `seed-idle-tasks:` (for
 * example `seed-idle-tasks: stSoftwareAU/private-repo-14`) to the
 * `process-seed-idle-tasks` command instead of the standard Claude-driven
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
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { CommandResult, Logger, WorkerConfig } from "../types.ts";
import { isSeedIdleTasksTitle } from "./seed_idle_tasks_request.ts";
import { processSeedIdleTasksCommand } from "../commands/process_seed_idle_tasks.ts";

/** Input describing the claimed issue under consideration. */
export interface RouteSeedIdleTasksInput {
  /** The repo the issue lives in (where to comment/close). */
  repo: string;
  issueNumber: number;
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
export interface RouteSeedIdleTasksDeps {
  logger: Logger;
  executeFn?: ProcessSeedIdleTasksExecuteFn;
}

/**
 * Outcome:
 * - `{ routed: false }` — not a seeding request; the caller should run the
 *   standard `workOnIssue` pipeline.
 * - `{ routed: true, success }` — `process-seed-idle-tasks` took ownership
 *   and has commented (and closed) the issue.
 */
export type RouteSeedIdleTasksOutcome =
  | { routed: false }
  | { routed: true; success: boolean };

/**
 * Dispatch a claimed issue to `process-seed-idle-tasks` when its title starts
 * with `seed-idle-tasks:`; otherwise pass through unchanged.
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

  return { routed: true, success: result.success };
}
