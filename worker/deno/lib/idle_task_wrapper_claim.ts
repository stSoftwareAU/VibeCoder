/**
 * Cross-host claim for an idle-task scan wrapper (Issue #1139).
 *
 * The production loop routed a recognised wrapper straight to the template
 * runner — `routeIdleTaskInProcessIssue` runs **before** `workOnIssue`, and
 * `workOnIssue`'s setup phase is the only place that ever called
 * `claimIssue`. A wrapper therefore collected no assignee and no
 * `CLAIM_LOCK` comment, so nothing on GitHub said "this one is taken" and
 * every host's scan kept offering it.
 *
 * Measured on 2026-09-05: `NEAT-AI-Lamarck#206` ran on GRQ-3 (01:56:42 →
 * 02:01:32) and on Mac-Ultra-M2 (02:00:25 → 02:05:25); `NEAT-AI-Snapshot#17`
 * ran on both hosts two minutes apart. Both are `idle-task` wrappers, both
 * runs recorded `success`, and neither issue's timeline carries a single
 * `assigned` event — the claim lock was never taken, not lost.
 *
 * This module takes that lock with the same machinery the standard pipeline
 * uses (`claimIssue`: live assignee re-read → assign → `CLAIM_LOCK` comment →
 * earliest-comment race resolution), and states loudly when a sibling host
 * already holds it so the losing run stands down before any scan work.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import {
  type ClaimFailureReason,
  claimIssue as defaultClaimIssue,
} from "./claim_issue.ts";

/** What a wrapper claim needs to know about the issue and the fleet. */
export interface ClaimIdleTaskWrapperInput {
  /** `owner/repo` the wrapper lives in. */
  repo: string;
  /** Wrapper issue number. */
  issueNumber: number;
  /** This host's GitHub login — the assignee that locks the wrapper. */
  githubUser: string;
  /**
   * Fleet logins whose `CLAIM_LOCK` markers this host trusts, and whose
   * open PRs are re-checked live before the claim is finalised — the same
   * union the standard pipeline passes (`resolveFleetAuthors`).
   */
  fleetAuthors?: string[];
  /**
   * The fleet's push-capable logins (`resolveFleetMaintenanceAuthorSet`).
   * Only these accounts' open PRs defer a claim; a human's PR is theirs to
   * manage (Issue #4133).
   */
  pushCapableAuthors?: string[];
}

/** Injectable seams. Defaults wire the production claim path. */
export interface ClaimIdleTaskWrapperDeps {
  logger: Logger;
  claimIssueFn?: typeof defaultClaimIssue;
  /** Worker-id factory — one unique id per claim attempt. */
  workerIdFn?: (githubUser: string) => string;
}

/**
 * Why a wrapper claim did not succeed. `claim_error` is this module's own
 * code for a `claimIssue` call that failed outright; every other value is a
 * {@link ClaimFailureReason} passed through unchanged.
 */
export type IdleTaskClaimRefusal = ClaimFailureReason | "claim_error";

/** Outcome of a wrapper claim attempt. */
export type IdleTaskWrapperClaim =
  | { claimed: true; workerId: string }
  | {
    claimed: false;
    /** Refusal code, for logs and the run's recorded outcome. */
    reason: IdleTaskClaimRefusal;
    /** One line naming what holds the wrapper. */
    detail: string;
  };

/** Default worker id — the same shape the setup phase uses. */
function defaultWorkerId(githubUser: string): string {
  return `${githubUser}-${Date.now()}`;
}

/**
 * Claim an idle-task wrapper for this host, or report who holds it.
 *
 * Fails **closed**: an unclaimable wrapper — already assigned, holding a
 * sibling's recent `CLAIM_LOCK`, race lost, or a `claimIssue` call that
 * errored — never runs the scan. Two hosts doing one repo's audit is the
 * fault this guards against, and a scan skipped this cycle is retried on the
 * next one.
 */
export async function claimIdleTaskWrapper(
  input: ClaimIdleTaskWrapperInput,
  deps: ClaimIdleTaskWrapperDeps,
): Promise<IdleTaskWrapperClaim> {
  const claim = deps.claimIssueFn ?? defaultClaimIssue;
  const workerId = (deps.workerIdFn ?? defaultWorkerId)(input.githubUser);
  const { repo, issueNumber, githubUser, fleetAuthors, pushCapableAuthors } =
    input;

  let result: Awaited<ReturnType<typeof defaultClaimIssue>>;
  try {
    result = await claim({
      repo,
      issueNumber,
      githubUser,
      workerId,
      ...(fleetAuthors ? { fleetAuthors } : {}),
      ...(pushCapableAuthors ? { pushCapableAuthors } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse(deps.logger, input, "claim_error", message);
  }

  if (!result.ok) {
    return refuse(deps.logger, input, "claim_error", result.error.message);
  }
  if (!result.value.claimed) {
    const { reason, reasonDetail, winnerId } = result.value;
    const detail = reasonDetail ??
      (winnerId ? `winner=${winnerId}` : "no detail reported");
    return refuse(deps.logger, input, reason ?? "api_error", detail);
  }

  deps.logger.info("Claimed idle-task wrapper before running the scan", {
    repo,
    issueNumber,
    workerId,
  });
  return { claimed: true, workerId };
}

/** Log the stand-down loudly and build the refusal. */
function refuse(
  logger: Logger,
  input: ClaimIdleTaskWrapperInput,
  reason: IdleTaskClaimRefusal,
  detail: string,
): IdleTaskWrapperClaim {
  logger.warn(IDLE_TASK_CLAIM_LOST_MESSAGE, {
    repo: input.repo,
    issueNumber: input.issueNumber,
    reason,
    detail,
  });
  return { claimed: false, reason, detail };
}

/**
 * The one log message a stood-down run emits. Exported so tests and log
 * greps share the wording rather than re-spelling it.
 */
export const IDLE_TASK_CLAIM_LOST_MESSAGE =
  "idle-task wrapper is already claimed — standing down before the scan " +
  "(Issue #1139)";
