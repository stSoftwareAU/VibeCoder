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
 * Issue #179 added the two invariants this route now owns:
 *   - the repo's local clone is ensured before a template walks its tree,
 *     so a repo freshly added to `.config.json` scans on the next run;
 *   - only a scan that actually ran closes its wrapper — a failed run
 *     comments and leaves the wrapper open for a cooldown-gated retry.
 *
 * Australian English spelling used throughout.
 */

import type { Logger } from "../types.ts";
import {
  findIdleTaskTemplate as defaultFindIdleTaskTemplate,
  handleIdleTaskIssue as defaultHandleIdleTaskIssue,
  type HandleIdleTaskIssueResult,
} from "./idle_task_claim_handler.ts";
import { runGhCommand as defaultRunGhCommand } from "./github.ts";
import { ensureRepoClone as defaultEnsureRepoClone } from "./ensure_repo_clone.ts";
import { finaliseIdleTaskWrapper } from "./idle_task_wrapper_closure.ts";

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
  /** Wrapper identification, used to decide whether a clone is needed. */
  findTemplateFn?: typeof defaultFindIdleTaskTemplate;
  /** Lazy clone helper — same `setupRepo` the setup phase uses. */
  ensureCloneFn?: typeof defaultEnsureRepoClone;
}

/**
 * Outcome:
 * - `{ routed: false }` — the issue is not an idle-task wrapper; the
 *   caller should run the standard `workOnIssue` pipeline.
 * - `{ routed: true, success }` — the claim handler took ownership.
 *   A successful run closed the wrapper with the template summary; a
 *   failed run left it open carrying a failure comment (Issue #179).
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
  const findTemplate = deps.findTemplateFn ?? defaultFindIdleTaskTemplate;
  const ensureClone = deps.ensureCloneFn ?? defaultEnsureRepoClone;

  // Issue #179: a template walks `${workDir}/<repo>`, and nothing on this
  // path had ever cloned it. A repo freshly added to `.config.json` therefore
  // failed every scan with ENOENT. Ensure the clone before running — but only
  // for a recognised wrapper, so ordinary issues take the standard setup
  // phase's clone as before. An existing clone is left untouched.
  const template = findTemplate({
    repo: input.repo,
    issueTitle: input.issueTitle,
    issueBody: input.issueBody,
  });
  if (template !== undefined) {
    const clone = await ensureClone(input.repo, input.workDir);
    if (!clone.ok) {
      const summary = `idle-task ${template.name} could not run: no local ` +
        `clone of ${input.repo} at ${clone.repoPath} — ${clone.message}`;
      deps.logger.warn("idle-task clone preparation failed", {
        repo: input.repo,
        issueNumber: input.issueNumber,
        template: template.name,
        repoPath: clone.repoPath,
        error: clone.message,
      });
      await finaliseIdleTaskWrapper(
        {
          repo: input.repo,
          issueNumber: input.issueNumber,
          ok: false,
          summary,
        },
        { logger: deps.logger, ghCommandFn: ghCommand },
      );
      return { routed: true, success: false };
    }
    if (clone.cloned) {
      deps.logger.info("Cloned repo for idle-task scan", {
        repo: input.repo,
        issueNumber: input.issueNumber,
        template: template.name,
        repoPath: clone.repoPath,
      });
    }
  }

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
  const ok = idleResult.ok ?? false;

  // Issue #179: only a scan that actually ran closes its wrapper. A failed
  // run comments the failure and leaves the wrapper open, so the standard
  // failure cooldown applies and a later claim retries the scan.
  await finaliseIdleTaskWrapper(
    { repo: input.repo, issueNumber: input.issueNumber, ok, summary },
    { logger: deps.logger, ghCommandFn: ghCommand },
  );

  return { routed: true, success: ok };
}
