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
 * Australian English spelling used throughout.
 */

import type { CommandResult, Logger, WorkerConfig } from "../types.ts";
import { ADD_REPO_PREFIX } from "./add_repo.ts";
import { processAddRepoCommand } from "../commands/process_add_repo.ts";

/** Input describing the claimed issue under consideration. */
export interface RouteAddRepoInput {
  /** The repo the issue lives in (where to comment/close). */
  repo: string;
  issueNumber: number;
  issueTitle: string;
  /** Worker config threaded into the command (needs-human label, etc.). */
  config: WorkerConfig;
}

/** Seam for the underlying command call. Defaults to `process-add-repo`. */
export type ProcessAddRepoExecuteFn = (
  args: Record<string, unknown>,
  config: WorkerConfig,
) => Promise<CommandResult>;

/** Injectable seams. Defaults wire the production implementation. */
export interface RouteAddRepoDeps {
  logger: Logger;
  executeFn?: ProcessAddRepoExecuteFn;
}

/**
 * Outcome:
 * - `{ routed: false }` — the title is not an `add-repo:` request; the
 *   caller should run the standard `workOnIssue` pipeline.
 * - `{ routed: true, success }` — `process-add-repo` took ownership and
 *   has commented/closed (or escalated) the issue. `success` mirrors the
 *   command's `CommandResult.success`.
 */
export type RouteAddRepoOutcome =
  | { routed: false }
  | { routed: true; success: boolean };

/** Cheap title-prefix test (case-insensitive), matching `parseAddRepoTitle`. */
export function isAddRepoTitle(title: string): boolean {
  return title.trim().toLowerCase().startsWith(ADD_REPO_PREFIX);
}

/**
 * Dispatch a claimed issue to `process-add-repo` when its title starts
 * with `add-repo:`; otherwise pass through unchanged.
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

  return { routed: true, success: result.success };
}
