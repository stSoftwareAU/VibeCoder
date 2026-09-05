/**
 * Cross-host claim for a route that runs **before** the standard pipeline
 * (Issues #1139, #1193).
 *
 * `processIssue` dispatches three routes ahead of `workOnIssue`, whose setup
 * phase is the only other place that ever calls `claimIssue`: the idle-task
 * wrapper runner, `add-repo:` requests and `seed-idle-tasks:` requests. A
 * routed issue therefore collected no assignee and no `CLAIM_LOCK` comment,
 * so nothing on GitHub said "this one is taken" and every host's scan kept
 * offering it.
 *
 * Measured on 2026-09-05: `NEAT-AI-Lamarck#206` ran on GRQ-3 (01:56:42 →
 * 02:01:32) and on Mac-Ultra-M2 (02:00:25 → 02:05:25); `NEAT-AI-Snapshot#17`
 * ran on both hosts two minutes apart. Both are `idle-task` wrappers, both
 * runs recorded `success`, and neither issue's timeline carries a single
 * `assigned` event — the claim lock was never taken, not lost. Issue #1139
 * fixed the idle-task route; #1193 generalised this module so the other two
 * take the same lock.
 *
 * This module takes that lock with the same machinery the standard pipeline
 * uses:
 *   - `claimIssue` — live assignee re-read, assign, `CLAIM_LOCK` comment,
 *     earliest-comment race resolution;
 *   - an initial heartbeat marker co-published in that claim comment, then
 *     refreshed for as long as the routed work runs. Without a beating marker
 *     a claim whose assignee is dropped mid-run — by the loser of a race
 *     cleaning up under a shared login, or by the assigned-without-heartbeat
 *     recovery after 30 minutes — reads as free to a sibling host, which is
 *     the same duplicate by another route (Issue #214).
 *
 * A host that does not hold the issue is told loudly, so the caller stands
 * down before any work.
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
  stopHeartbeat as defaultStopHeartbeat,
} from "./heartbeat.ts";
import { getMachineId as defaultGetMachineId } from "./machine_id.ts";
import {
  clearHeartbeat as libClearHeartbeat,
  recordHeartbeat as libRecordHeartbeat,
} from "./stuck_issue_detector.ts";

/** What a routed claim needs to know about the issue and the fleet. */
export interface ClaimRoutedIssueInput {
  /** `owner/repo` the issue lives in. */
  repo: string;
  /** The issue number being claimed. */
  issueNumber: number;
  /** This host's GitHub login — the assignee that locks the issue. */
  githubUser: string;
  /** Working directory holding the heartbeat and marker state. */
  workDir: string;
  /**
   * Fleet logins whose `CLAIM_LOCK` markers this host trusts, and whose
   * open PRs are re-checked live before the claim is finalised — the same
   * union the standard pipeline passes (`resolveFleetAuthors`).
   *
   * Required, like the route's copy of it: an omitted set silently narrows
   * the claim's trust to this login and switches off the live fleet-PR
   * re-check, and a guard that can be disabled by forgetting a field is no
   * guard.
   */
  fleetAuthors: string[];
  /**
   * The fleet's push-capable logins (`resolveFleetMaintenanceAuthorSet`).
   * Only these accounts' open PRs defer a claim; a human's PR is theirs to
   * manage (Issue #4133). Required for the same reason as `fleetAuthors`.
   */
  pushCapableAuthors: string[];
  /**
   * Which route is claiming — `idle-task`, `add-repo`, `seed-idle-tasks`.
   * Logged with every claim and every refusal so a worker-log grep says
   * *which* pre-pipeline route stood down, not merely that one did.
   */
  route: string;
}

/** Injectable seams. Defaults wire the production claim path. */
export interface ClaimRoutedIssueDeps {
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
 * Why a routed claim did not succeed. `claim_error` is this module's own
 * code for a `claimIssue` call that failed outright; every other value is a
 * {@link ClaimFailureReason} passed through unchanged.
 */
export type RouteClaimRefusal = ClaimFailureReason | "claim_error";

/** Outcome of a routed claim attempt. */
export type RoutedIssueClaim =
  | {
    claimed: true;
    workerId: string;
    /**
     * The claim's heartbeat, which the caller must stop when the routed
     * work finishes. Absent only when the heartbeat could not be started —
     * the claim comment's initial marker still stands, and the failure is
     * logged.
     */
    heartbeat?: HeartbeatHandle;
  }
  | {
    claimed: false;
    /** Refusal code, for logs and the run's recorded outcome. */
    reason: RouteClaimRefusal;
    /** One line naming what holds the issue, or what went wrong. */
    detail: string;
  };

/**
 * The one log message a stood-down run emits. Exported so tests and log
 * greps share the wording rather than re-spelling it; the `route` field of
 * the log context says which route stood down.
 */
export const ROUTE_CLAIM_REFUSED_MESSAGE =
  "routed claim refused — standing down before any work " +
  "(Issues #1139, #1193)";

/**
 * Refusals that mean the issue is **not this host's to run** — another run
 * holds it, or it is not claimable at all right now (closed, parked behind a
 * blocking label, deferred to an open fleet PR). These are the fleet working
 * as designed: this host takes a cooldown and re-scans, and the run is
 * recorded as a skip.
 *
 * Everything else — a `gh` outage, a worker that is not a collaborator, a
 * verification read that failed — is a fault, and {@link isRouteClaimUnavailable}
 * returning false is what makes the caller report it as one rather than
 * folding a broken GitHub into the benign path.
 */
const UNAVAILABLE: ReadonlySet<RouteClaimRefusal> = new Set<
  RouteClaimRefusal
>([
  "already_assigned",
  "recent_claim",
  "heartbeat_active",
  "race_lost",
  "fleet_pr_exists",
  "blocking_label",
  "already_closed",
]);

/**
 * True when the refusal means the issue was legitimately unavailable —
 * held by a sibling run, or not claimable at this moment — rather than a
 * fault in this host's ability to claim.
 */
export function isRouteClaimUnavailable(reason: RouteClaimRefusal): boolean {
  return UNAVAILABLE.has(reason);
}

/** A readable sentence for a refusal `claimIssue` reports without detail. */
function describeRefusal(reason: RouteClaimRefusal): string {
  switch (reason) {
    case "already_assigned":
      return "the issue is assigned to another run";
    case "recent_claim":
      return "another fleet host posted a CLAIM_LOCK in the last minute";
    case "race_lost":
      return "another fleet host's CLAIM_LOCK is earlier";
    case "already_closed":
      return "the issue is closed";
    case "blocking_label":
      return "the issue carries a blocking label";
    case "fleet_pr_exists":
      return "an open fleet PR already targets this work stream";
    case "heartbeat_active":
      return "another run's heartbeat is still beating on the issue";
    default:
      return `the claim was refused (${reason})`;
  }
}

/** Default worker id — the same shape the setup phase uses. */
function defaultWorkerId(githubUser: string): string {
  return `${githubUser}-${Date.now()}`;
}

/**
 * Claim a routed issue for this host, or report who holds it.
 *
 * Fails **closed**: an unclaimable issue — already assigned, holding a
 * sibling's recent `CLAIM_LOCK`, race lost, or a `claimIssue` call that
 * errored — never runs the routed work. Two hosts running one repo's audit,
 * adding one repo twice or seeding one repo's idle tasks twice is the fault
 * this guards against, and work skipped this cycle is retried on the next one.
 */
export async function claimRoutedIssue(
  input: ClaimRoutedIssueInput,
  deps: ClaimRoutedIssueDeps,
): Promise<RoutedIssueClaim> {
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

  // The machine id rides in the heartbeat marker, and a claim with no marker
  // is the state this module exists to prevent: drop the assignee mid-run —
  // a race loser cleaning up under the shared login, or the 30-minute
  // assigned-without-heartbeat recovery — and a sibling host reads the issue
  // as free. So a missing machine id refuses the claim rather than working
  // without liveness. The standard pipeline fails the same way: its setup
  // phase awaits `getMachineId` before claiming and a throw there is a phase
  // failure.
  let machineId: string;
  try {
    machineId = await machineIdFn(workDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse(
      deps.logger,
      input,
      "claim_error",
      `machine id unavailable, so the claim would carry no heartbeat: ${message}`,
    );
  }
  if (machineId.length === 0) {
    return refuse(
      deps.logger,
      input,
      "claim_error",
      "machine id resolved empty, so the claim would carry no heartbeat",
    );
  }

  let result: Awaited<ReturnType<typeof defaultClaimIssue>>;
  try {
    result = await claim({
      repo,
      issueNumber,
      githubUser,
      workerId,
      fleetAuthors,
      pushCapableAuthors,
      // Co-publish the initial heartbeat marker inside the CLAIM_LOCK
      // comment (Issue #1628) so the claim carries liveness from the start.
      markerOptions: { machineId, workDir },
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
  deps.logger.info("Claimed routed issue before running the route", {
    route: input.route,
    repo,
    issueNumber,
    workerId,
    heartbeat: heartbeat !== undefined,
  });
  return { claimed: true, workerId, ...(heartbeat ? { heartbeat } : {}) };
}

/**
 * Keep the claim's marker beating for the life of the routed work.
 *
 * Best-effort: a heartbeat that will not start costs the refreshes, not the
 * claim — the assignee and the claim comment's initial marker still hold the
 * issue — so it is logged loudly and the work proceeds.
 */
async function startClaimHeartbeat(
  claim: {
    repo: string;
    issueNumber: number;
    workDir: string;
    machineId: string;
    fleetAuthors: string[];
  },
  startHeartbeatFn: typeof defaultStartHeartbeat,
  logger: Logger,
): Promise<HeartbeatHandle | undefined> {
  const { repo, issueNumber, workDir, machineId, fleetAuthors } = claim;
  const markerOptions = {
    machineId,
    ...(fleetAuthors.length > 0 ? { allowedAuthors: fleetAuthors } : {}),
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
      "routed claim heartbeat did not start — the claim stands on its " +
        "assignee and initial marker alone (Issue #1139)",
      { repo, issueNumber, error: started.error.message },
    );
  } catch (err) {
    logger.warn(
      "routed claim heartbeat threw — the claim stands on its assignee " +
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
  input: ClaimRoutedIssueInput,
  reason: RouteClaimRefusal,
  detail: string,
): RoutedIssueClaim {
  logger.warn(ROUTE_CLAIM_REFUSED_MESSAGE, {
    route: input.route,
    repo: input.repo,
    issueNumber: input.issueNumber,
    reason,
    // Whether the issue was legitimately unavailable (a skip) or this
    // host could not claim it (a fault the failure counters must see).
    unavailable: isRouteClaimUnavailable(reason),
    detail,
  });
  return { claimed: false, reason, detail };
}

// ---------------------------------------------------------------------------
// The shape every pre-pipeline route shares (Issue #1193)
// ---------------------------------------------------------------------------

/**
 * The claim half of a route's outcome: the route recognised the issue, but
 * this host does not hold it and so did — and wrote — nothing.
 */
export interface RouteClaimLost {
  /** This host does not hold the issue; it did no work. */
  claimLost: true;
  /** Refusal code from the claim path. */
  claimReason: RouteClaimRefusal;
  /** One line naming what holds the issue, or what went wrong. */
  claimDetail: string;
}

/** Seams a route needs to claim, and to stop the claim's heartbeat. */
export interface RouteClaimDeps {
  logger: Logger;
  /** Cross-host claim for this route (Issues #1139, #1193). */
  claimRouteFn?: typeof claimRoutedIssue;
  /** Stops the claim's heartbeat once the routed work is finished. */
  stopHeartbeatFn?: typeof defaultStopHeartbeat;
}

/** What {@link runWithRouteClaim} gives the caller back. */
export type RouteClaimRun<T> =
  | { claimed: true; value: T }
  /** `lost` is spread straight into the route's own outcome. */
  | { claimed: false; lost: RouteClaimLost };

/**
 * Take the cross-host claim, run the routed work, then stop the heartbeat.
 *
 * The claim is taken **before** any work, and a host that is refused runs
 * nothing at all — no command, no scan, no comment on the issue. The
 * heartbeat is stopped in a `finally` so a throw cannot leak the interval.
 */
export async function runWithRouteClaim<T>(
  input: ClaimRoutedIssueInput,
  deps: RouteClaimDeps,
  run: () => Promise<T>,
): Promise<RouteClaimRun<T>> {
  const claimFn = deps.claimRouteFn ?? claimRoutedIssue;
  const stopHeartbeatFn = deps.stopHeartbeatFn ?? defaultStopHeartbeat;
  const claim = await claimFn(input, { logger: deps.logger });
  if (!claim.claimed) {
    return {
      claimed: false,
      lost: {
        claimLost: true,
        claimReason: claim.reason,
        claimDetail: claim.detail,
      },
    };
  }
  try {
    return { claimed: true, value: await run() };
  } finally {
    if (claim.heartbeat) await stopHeartbeatFn(claim.heartbeat);
  }
}

/** How the main loop records a routed run. */
export interface RouteRunResult {
  success: boolean;
  skipped: boolean;
  /**
   * This run never held the claim, so it has nothing to release
   * (Issue #1139). The fleet shares one GitHub login, so an unassign here
   * would strip the **winner's** claim off an issue it is still working —
   * exactly the "assignee dropped while the run is live" state Issue #214
   * describes.
   */
  claimNotHeld?: true;
}

/**
 * Classify a routed run for the main loop (Issues #1139, #1193).
 *
 * An issue another run holds is a **skip**: this host takes a cooldown and
 * re-scans, it is not a failure to diagnose, and — crucially — it is not the
 * ordinary success that made two hosts' duplicate runs indistinguishable
 * from one host working twice as often.
 *
 * A claim that failed for any other reason (a `gh` outage, a worker that is
 * not a collaborator, a verification read that failed) is a **failure**: the
 * same verdict the standard pipeline gives it, so a broken GitHub reaches
 * the failure counters instead of being filed away as a benign conflict.
 */
export function routeRunResult(
  outcome: { success: boolean } | ({ success: false } & RouteClaimLost),
): RouteRunResult {
  if (!("claimLost" in outcome)) {
    return { success: outcome.success, skipped: false };
  }
  return {
    success: false,
    skipped: isRouteClaimUnavailable(outcome.claimReason),
    claimNotHeld: true,
  };
}
