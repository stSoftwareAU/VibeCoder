/**
 * Production-loop idle-task routing helper (Issue #2118).
 *
 * Routes an issue claimed by the main worker loop through the
 * idle-task template runner before the standard `workOnIssue`
 * pipeline. Without this branch the orchestrator's `idle_task_guard`
 * (in `issue_worker.ts`) refuses every claimed wrapper.
 *
 * Extracted from `run_core_production_deps.ts` so it can be exercised
 * in isolation: the production factory wires real `gh` and
 * `handleIdleTaskIssue` implementations; tests inject stubs.
 *
 * Australian English spelling used throughout.
 */

import type { Logger } from "../types.ts";
import {
  handleIdleTaskIssue as defaultHandleIdleTaskIssue,
  type HandleIdleTaskIssueResult,
} from "./idle_task_claim_handler.ts";
import { runGhCommand as defaultRunGhCommand } from "./github.ts";

/** Input describing the issue under consideration. */
export interface RouteIdleTaskInput {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueLabels: string[];
  issueBody: string;
  workDir: string;
}

/** Injectable seams. Defaults wire the production implementations. */
export interface RouteIdleTaskDeps {
  logger: Logger;
  handleIdleTaskFn?: typeof defaultHandleIdleTaskIssue;
  ghCommandFn?: typeof defaultRunGhCommand;
}

/**
 * Outcome:
 * - `{ routed: false }` — the issue is not an idle-task wrapper; the
 *   caller should run the standard `workOnIssue` pipeline.
 * - `{ routed: true, success }` — the claim handler took ownership.
 *   The wrapper issue has been closed with the template summary.
 *   `success` mirrors `HandleIdleTaskIssueResult.ok`.
 */
export type RouteIdleTaskOutcome =
  | { routed: false }
  | { routed: true; success: boolean };

/**
 * Dispatch an issue to the idle-task template runner when it looks
 * like a wrapper; otherwise pass through.
 *
 * Mirrors the routing in `commands/work_on_issue.ts:156-200`, which
 * the CLI entry uses. The production main loop must also route here
 * — without it, the orchestrator's idle-task guard fails every
 * wrapper at phase `idle_task_guard` (Issue #2118).
 */
export async function routeIdleTaskInProcessIssue(
  input: RouteIdleTaskInput,
  deps: RouteIdleTaskDeps,
): Promise<RouteIdleTaskOutcome> {
  const handleIdleTask = deps.handleIdleTaskFn ?? defaultHandleIdleTaskIssue;
  const ghCommand = deps.ghCommandFn ?? defaultRunGhCommand;

  const idleResult: HandleIdleTaskIssueResult = await handleIdleTask(
    {
      repo: input.repo,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      issueLabels: input.issueLabels,
      issueBody: input.issueBody,
      workDir: input.workDir,
    },
    { logger: deps.logger },
  );

  if (!idleResult.handled) {
    return { routed: false };
  }

  const summary = idleResult.summary ?? "idle-task processed";
  try {
    await ghCommand([
      "issue",
      "close",
      String(input.issueNumber),
      "--repo",
      input.repo,
      "--comment",
      summary,
    ]);
  } catch (err) {
    deps.logger.warn("Failed to close idle-task issue", {
      repo: input.repo,
      issueNumber: input.issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { routed: true, success: idleResult.ok ?? false };
}
