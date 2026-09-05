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
 * Issue #1139 added the third: a recognised wrapper is **claimed** before
 * any scan work. This route runs before `workOnIssue`, whose setup phase
 * was the only caller of `claimIssue`, so a routed wrapper took no claim
 * lock at all and two hosts ran the same audit minutes apart. See
 * `idle_task_wrapper_claim.ts`.
 *
 * Australian English spelling used throughout.
 */

import type { Logger } from "../types.ts";
import {
  claimIdleTaskWrapper as defaultClaimIdleTaskWrapper,
  type IdleTaskClaimRefusal,
  isWrapperUnavailable,
} from "./idle_task_wrapper_claim.ts";
import {
  type HeartbeatHandle,
  stopHeartbeat as defaultStopHeartbeat,
} from "./heartbeat.ts";
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
  /**
   * This host's GitHub login — the assignee that locks a recognised wrapper
   * against a sibling host (Issue #1139). Required: a route that cannot
   * claim must not silently scan.
   */
  githubUser: string;
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
  /**
   * Epoch-ms deadline of the current cycle (Issue #186), forwarded to the
   * claim handler so the scan's Claude budget is bounded by the runway left.
   * Optional — the CLI single-issue path has no cycle and omits it.
   */
  cycleDeadlineEpochMs?: number;
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
  /** Cross-host wrapper claim (Issue #1139). */
  claimWrapperFn?: typeof defaultClaimIdleTaskWrapper;
  /** Stops the claim's heartbeat once the scan is finished (Issue #1139). */
  stopHeartbeatFn?: typeof defaultStopHeartbeat;
}

/**
 * Outcome:
 * - `{ routed: false }` — the issue is not an idle-task wrapper; the
 *   caller should run the standard `workOnIssue` pipeline.
 * - `{ routed: true, success }` — the claim handler took ownership.
 *   A successful run closed the wrapper with the template summary; a
 *   failed run left it open carrying a failure comment (Issue #179).
 *   `success` mirrors `HandleIdleTaskIssueResult.ok`.
 * - `{ routed: true, success: false, claimLost: true, … }` — this host does
 *   not hold the wrapper (Issue #1139). Nothing was scanned and nothing was
 *   written to the wrapper.
 */
export type RouteIdleTaskOutcome =
  | { routed: false }
  | { routed: true; success: boolean }
  | {
    routed: true;
    success: false;
    /** This host does not hold the wrapper — it did no work. */
    claimLost: true;
    /** Refusal code from the claim path. */
    claimReason: IdleTaskClaimRefusal;
    /** One line naming what holds the wrapper, or what went wrong. */
    claimDetail: string;
  };

/** How the main loop records a routed idle-task run. */
export interface IdleTaskRouteRunResult {
  success: boolean;
  skipped: boolean;
  /**
   * This run never held the claim, so it has nothing to release
   * (Issue #1139). The fleet shares one GitHub login, so an unassign here
   * would strip the **winner's** claim off an issue it is still scanning —
   * exactly the "assignee dropped while the run is live" state Issue #214
   * describes.
   */
  claimNotHeld?: true;
}

/**
 * Classify a routed idle-task run for the main loop (Issue #1139).
 *
 * A wrapper another run holds is a **skip**: this host takes a cooldown and
 * re-scans, it is not a failure to diagnose, and — crucially — it is not the
 * ordinary success that made two hosts' duplicate audits indistinguishable
 * from one host working twice as often.
 *
 * A claim that failed for any other reason (a `gh` outage, a worker that is
 * not a collaborator, a verification read that failed) is a **failure**: the
 * same verdict the standard pipeline gives it, so a broken GitHub reaches
 * the failure counters instead of being filed away as a benign conflict.
 */
export function idleTaskRouteRunResult(
  outcome: Extract<RouteIdleTaskOutcome, { routed: true }>,
): IdleTaskRouteRunResult {
  if (!("claimLost" in outcome)) {
    return { success: outcome.success, skipped: false };
  }
  return {
    success: false,
    skipped: isWrapperUnavailable(outcome.claimReason),
    claimNotHeld: true,
  };
}

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
  const claimWrapper = deps.claimWrapperFn ?? defaultClaimIdleTaskWrapper;
  const stopHeartbeatFn = deps.stopHeartbeatFn ?? defaultStopHeartbeat;

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

  let heartbeat: HeartbeatHandle | undefined;
  if (template !== undefined) {
    // Issue #1139: take the cross-host claim BEFORE the clone and the scan.
    // This route bypasses `workOnIssue`, whose setup phase held the only
    // `claimIssue` call, so a wrapper carried no assignee and no CLAIM_LOCK
    // and every host's scan kept offering it. A host that does not hold the
    // wrapper does no work and writes nothing to it.
    const claim = await claimWrapper(
      {
        repo: input.repo,
        issueNumber: input.issueNumber,
        githubUser: input.githubUser,
        workDir: input.workDir,
        fleetAuthors: input.fleetAuthors,
        pushCapableAuthors: input.pushCapableAuthors,
      },
      { logger: deps.logger },
    );
    if (!claim.claimed) {
      return {
        routed: true,
        success: false,
        claimLost: true,
        claimReason: claim.reason,
        claimDetail: claim.detail,
      };
    }
    // The claim beats for as long as the scan runs; `finally` below stops it.
    heartbeat = claim.heartbeat;
  }

  try {
    return await runRoutedScan(input, deps, template, {
      handleIdleTask,
      ghCommand,
      ensureClone,
    });
  } finally {
    if (heartbeat) await stopHeartbeatFn(heartbeat);
  }
}

/** The routed work itself: clone the repo, run the scan, finalise the wrapper. */
async function runRoutedScan(
  input: RouteIdleTaskInput,
  deps: RouteIdleTaskDeps,
  template: ReturnType<typeof defaultFindIdleTaskTemplate>,
  fns: {
    handleIdleTask: typeof defaultHandleIdleTaskIssue;
    ghCommand: typeof defaultRunGhCommand;
    ensureClone: typeof defaultEnsureRepoClone;
  },
): Promise<RouteIdleTaskOutcome> {
  const { handleIdleTask, ghCommand, ensureClone } = fns;
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
      ...(input.cycleDeadlineEpochMs !== undefined
        ? { cycleDeadlineEpochMs: input.cycleDeadlineEpochMs }
        : {}),
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
