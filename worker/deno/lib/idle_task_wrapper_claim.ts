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
 * uses:
 *   - `claimIssue` — live assignee re-read, assign, `CLAIM_LOCK` comment,
 *     earliest-comment race resolution;
 *   - an initial heartbeat marker co-published in that claim comment, then
 *     refreshed for as long as the scan runs. Without a beating marker a
 *     claim whose assignee is dropped mid-scan — by the loser of a race
 *     cleaning up under a shared login, or by the assigned-without-heartbeat
 *     recovery after 30 minutes — reads as free to a sibling host, which is
 *     the same duplicate by another route (Issue #214).
 *
 * A host that does not hold the wrapper is told loudly, so the caller stands
 * down before any scan work.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger } from "../types.ts";
import {
  type ClaimFailureReason,
  claimIssue as defaultClaimIssue,
} from "./claim_issue.ts";
import {
  type HeartbeatHandle,
  startHeartbeat as defaultStartHeartbeat,
} from "./heartbeat.ts";
import { getMachineId as defaultGetMachineId } from "./machine_id.ts";
import {
  clearHeartbeat as libClearHeartbeat,
  recordHeartbeat as libRecordHeartbeat,
} from "./stuck_issue_detector.ts";

/** What a wrapper claim needs to know about the issue and the fleet. */
export interface ClaimIdleTaskWrapperInput {
  /** `owner/repo` the wrapper lives in. */
  repo: string;
  /** Wrapper issue number. */
  issueNumber: number;
  /** This host's GitHub login — the assignee that locks the wrapper. */
  githubUser: string;
  /** Working directory holding the heartbeat and marker state. */
  workDir: string;
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
  /** Stable per-machine id, published in the heartbeat marker. */
  machineIdFn?: typeof defaultGetMachineId;
  /** Heartbeat starter — the claim's liveness signal. */
  startHeartbeatFn?: typeof defaultStartHeartbeat;
}

/**
 * Why a wrapper claim did not succeed. `claim_error` is this module's own
 * code for a `claimIssue` call that failed outright; every other value is a
 * {@link ClaimFailureReason} passed through unchanged.
 */
export type IdleTaskClaimRefusal = ClaimFailureReason | "claim_error";

/** Outcome of a wrapper claim attempt. */
export type IdleTaskWrapperClaim =
  | {
    claimed: true;
    workerId: string;
    /**
     * The claim's heartbeat, which the caller must stop when the scan
     * finishes. Absent only when the heartbeat could not be started — the
     * claim comment's initial marker still stands, and the failure is
     * logged.
     */
    heartbeat?: HeartbeatHandle;
  }
  | {
    claimed: false;
    /** Refusal code, for logs and the run's recorded outcome. */
    reason: IdleTaskClaimRefusal;
    /** One line naming what holds the wrapper, or what went wrong. */
    detail: string;
  };

/**
 * The one log message a stood-down run emits. Exported so tests and log
 * greps share the wording rather than re-spelling it.
 */
export const IDLE_TASK_CLAIM_REFUSED_MESSAGE =
  "idle-task wrapper claim refused — standing down before the scan " +
  "(Issue #1139)";

/**
 * Refusals that mean **another run holds the wrapper**. These are the fleet
 * working as designed: this host takes a cooldown and re-scans, and the run
 * is recorded as a skip.
 *
 * Everything else — a `gh` outage, a worker that is not a collaborator, a
 * verification read that failed — is a fault, and {@link isHeldElsewhere}
 * returning false is what makes the caller report it as one rather than
 * folding a broken GitHub into the benign path.
 */
const HELD_ELSEWHERE: ReadonlySet<IdleTaskClaimRefusal> = new Set<
  IdleTaskClaimRefusal
>([
  "already_assigned",
  "recent_claim",
  "heartbeat_active",
  "race_lost",
  "fleet_pr_exists",
  "blocking_label",
  "already_closed",
]);

/** True when the refusal means a sibling run holds the wrapper. */
export function isHeldElsewhere(reason: IdleTaskClaimRefusal): boolean {
  return HELD_ELSEWHERE.has(reason);
}

/** A readable sentence for a refusal `claimIssue` reports without detail. */
function describeRefusal(reason: IdleTaskClaimRefusal): string {
  switch (reason) {
    case "already_assigned":
      return "the wrapper is assigned to another run";
    case "recent_claim":
      return "another fleet host posted a CLAIM_LOCK in the last minute";
    case "race_lost":
      return "another fleet host's CLAIM_LOCK is earlier";
    case "already_closed":
      return "the wrapper is closed";
    case "blocking_label":
      return "the wrapper carries a blocking label";
    case "fleet_pr_exists":
      return "an open fleet PR already targets this work stream";
    case "heartbeat_active":
      return "another run's heartbeat is still beating on the wrapper";
    default:
      return `the claim was refused (${reason})`;
  }
}

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
  const machineIdFn = deps.machineIdFn ?? defaultGetMachineId;
  const startHeartbeatFn = deps.startHeartbeatFn ?? defaultStartHeartbeat;
  const workerId = (deps.workerIdFn ?? defaultWorkerId)(input.githubUser);
  const {
    repo,
    issueNumber,
    githubUser,
    workDir,
    fleetAuthors,
    pushCapableAuthors,
  } = input;

  // The machine id rides in the heartbeat marker so another host can tell
  // whose run is beating. Losing it costs the marker, not the claim, so it
  // is logged rather than refusing an otherwise legitimate claim.
  let machineId = "";
  try {
    machineId = await machineIdFn(workDir);
  } catch (err) {
    deps.logger.warn("idle-task wrapper claim: machine id unavailable", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let result: Awaited<ReturnType<typeof defaultClaimIssue>>;
  try {
    result = await claim({
      repo,
      issueNumber,
      githubUser,
      workerId,
      ...(fleetAuthors ? { fleetAuthors } : {}),
      ...(pushCapableAuthors ? { pushCapableAuthors } : {}),
      // Co-publish the initial heartbeat marker inside the CLAIM_LOCK
      // comment (Issue #1628) so the claim carries liveness from the start.
      ...(machineId ? { markerOptions: { machineId, workDir } } : {}),
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
    const code = reason ?? "api_error";
    const detail = reasonDetail ??
      (winnerId ? `winner=${winnerId}` : describeRefusal(code));
    return refuse(deps.logger, input, code, detail);
  }

  const heartbeat = await startClaimHeartbeat(
    { repo, issueNumber, workDir, machineId, fleetAuthors },
    startHeartbeatFn,
    deps.logger,
  );
  deps.logger.info("Claimed idle-task wrapper before running the scan", {
    repo,
    issueNumber,
    workerId,
    heartbeat: heartbeat !== undefined,
  });
  return { claimed: true, workerId, ...(heartbeat ? { heartbeat } : {}) };
}

/**
 * Keep the claim's marker beating for the life of the scan.
 *
 * Best-effort: a heartbeat that will not start costs the refreshes, not the
 * claim — the assignee and the claim comment's initial marker still hold the
 * wrapper — so it is logged loudly and the scan proceeds.
 */
async function startClaimHeartbeat(
  claim: {
    repo: string;
    issueNumber: number;
    workDir: string;
    machineId: string;
    fleetAuthors?: string[];
  },
  startHeartbeatFn: typeof defaultStartHeartbeat,
  logger: Logger,
): Promise<HeartbeatHandle | undefined> {
  const { repo, issueNumber, workDir, machineId, fleetAuthors } = claim;
  if (!machineId) return undefined;
  const markerOptions = {
    machineId,
    ...(fleetAuthors && fleetAuthors.length > 0
      ? { allowedAuthors: fleetAuthors }
      : {}),
  };
  try {
    const started = await startHeartbeatFn({
      repo,
      issueNumber,
      workDir,
      recordFn: (w, r, i) =>
        libRecordHeartbeat(w, r, i, undefined, markerOptions),
      clearFn: (w, r, i) => libClearHeartbeat(w, r, i, markerOptions),
    });
    if (started.ok) return started.value;
    logger.warn(
      "idle-task wrapper heartbeat did not start — the claim stands on its " +
        "assignee and initial marker alone (Issue #1139)",
      { repo, issueNumber, error: started.error.message },
    );
  } catch (err) {
    logger.warn(
      "idle-task wrapper heartbeat threw — the claim stands on its assignee " +
        "and initial marker alone (Issue #1139)",
      {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
  return undefined;
}

/** Log the stand-down loudly and build the refusal. */
function refuse(
  logger: Logger,
  input: ClaimIdleTaskWrapperInput,
  reason: IdleTaskClaimRefusal,
  detail: string,
): IdleTaskWrapperClaim {
  logger.warn(IDLE_TASK_CLAIM_REFUSED_MESSAGE, {
    repo: input.repo,
    issueNumber: input.issueNumber,
    reason,
    heldElsewhere: isHeldElsewhere(reason),
    detail,
  });
  return { claimed: false, reason, detail };
}
