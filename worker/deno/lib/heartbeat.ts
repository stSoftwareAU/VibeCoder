/**
 * Heartbeat lifecycle management — periodic heartbeat updates during
 * long-running operations (Issue #963).
 *
 * Provides start/stop lifecycle management around the existing heartbeat
 * recording in stuck_issue_detector.ts and clearing in crash_cleanup.ts.
 * Replaces the shell-based start_heartbeat_updater()/stop_heartbeat_updater()
 * from issue_worker.sh with a cleaner setInterval-based approach.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { RunOutcome } from "./run_outcome.ts";
import {
  clearClaimReleaseGuard,
  setPendingReleaseOutcome,
  takePendingReleaseOutcome,
} from "./heartbeat_storage.ts";
import type { Result } from "../types.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { pinWriteRepo, unpinWriteRepo } from "./write_repo_allowlist.ts";

/** Default heartbeat interval in milliseconds (60 seconds). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/** Function signature for recording a heartbeat. */
export type RecordFn = (
  workDir: string,
  repo: string,
  issueNumber: number,
) => Promise<Result<void>>;

/** Function signature for clearing a heartbeat. */
export type ClearFn = (
  workDir: string,
  repo: string,
  issueNumber: number,
) => Promise<Result<void>>;

/** Options for starting a heartbeat. */
export interface HeartbeatOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number being worked on. */
  issueNumber: number;
  /** Working directory for heartbeat files. */
  workDir: string;
  /** Interval between heartbeat updates in milliseconds (default: 60000). */
  intervalMs?: number;
  /** Function to record a heartbeat (defaults to stuck_issue_detector.recordHeartbeat). */
  recordFn: RecordFn;
  /** Function to clear a heartbeat on stop (defaults to crash_cleanup.clearHeartbeat). */
  clearFn: ClearFn;
}

/** Handle returned by startHeartbeat for stopping later. */
export interface HeartbeatHandle {
  /** Unique identifier for this heartbeat (repo + issue). */
  id: string;
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number. */
  issueNumber: number;
}

/** Internal state for an active heartbeat. */
interface ActiveHeartbeat {
  intervalId: ReturnType<typeof setInterval> | null;
  options: HeartbeatOptions;
  /** Count of consecutive heartbeat recording failures. */
  consecutiveFailures: number;
}

/** Registry of active heartbeats, keyed by handle ID. */
const activeHeartbeats = new Map<string, ActiveHeartbeat>();

/**
 * Generate a unique handle ID for a repo/issue combination.
 */
function makeHandleId(repo: string, issueNumber: number): string {
  const safeRepo = repo.replace("/", "_");
  return `${safeRepo}_${issueNumber}`;
}

/**
 * Start periodic heartbeat updates for a given repo/issue.
 *
 * Awaits a single initial heartbeat record before scheduling the periodic
 * interval (Issue #1888). By the time this resolves with `{ ok: true }`,
 * both the local heartbeat file and the GitHub marker comment have been
 * written, closing the claim-to-heartbeat crash window.
 *
 * If the initial record fails (local-write failure or GitHub API error),
 * returns `{ ok: false, error }` without scheduling the interval. The
 * caller should release the claim and abort.
 *
 * Subsequent periodic refreshes remain fire-and-forget and tolerate
 * transient failures via the consecutive-failure counter.
 *
 * Idempotent — calling start twice for the same repo/issue returns the
 * existing handle wrapped in `{ ok: true }` without creating duplicates
 * and without re-running the initial record.
 */
export async function startHeartbeat(
  options: HeartbeatOptions,
): Promise<Result<HeartbeatHandle>> {
  const id = makeHandleId(options.repo, options.issueNumber);

  // Idempotent: if already running, return existing handle
  if (activeHeartbeats.has(id)) {
    return {
      ok: true,
      value: { id, repo: options.repo, issueNumber: options.issueNumber },
    };
  }

  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  // A new claim on this issue may beat again (Issue #214): lift the
  // write-after-release guard a previous claim's release armed.
  clearClaimReleaseGuard(options.workDir, options.repo, options.issueNumber);

  const state: ActiveHeartbeat = {
    intervalId: null,
    options,
    consecutiveFailures: 0,
  };

  // Issue #3760: pin the claim's repo in the write-repo allowlist for the
  // heartbeat's lifetime, so a reseed by the next claim cannot block the
  // periodic marker refreshes. Pinned before the initial record because
  // that record already performs a GitHub marker write. Released in
  // stopHeartbeat, or below when the initial record fails.
  pinWriteRepo(options.repo);

  // Await the initial heartbeat record — propagate failure to the caller
  // so they can release the claim instead of leaving an issue assigned
  // without a heartbeat marker (Issue #1888).
  let initialResult: Result<void>;
  try {
    initialResult = await options.recordFn(
      options.workDir,
      options.repo,
      options.issueNumber,
    );
  } catch (err) {
    unpinWriteRepo(options.repo);
    const msg = err instanceof Error ? err.message : String(err);
    recordFaultEvent(
      "heartbeat_failure",
      `${options.repo}#${options.issueNumber} initial threw: ${msg}`,
    );
    return {
      ok: false,
      error: new Error(`Initial heartbeat record threw: ${msg}`),
    };
  }
  if (!initialResult.ok) {
    unpinWriteRepo(options.repo);
    recordFaultEvent(
      "heartbeat_failure",
      `${options.repo}#${options.issueNumber} initial failed: ${initialResult.error.message}`,
    );
    return {
      ok: false,
      error: new Error(
        `Initial heartbeat record failed: ${initialResult.error.message}`,
      ),
    };
  }
  recordFaultEvent("heartbeat_success");

  // Periodic refresh — fire-and-forget, tolerates transient failures.
  const recordWithTracking = () => {
    try {
      options.recordFn(options.workDir, options.repo, options.issueNumber)
        .then((result) => {
          if (result.ok) {
            state.consecutiveFailures = 0;
            recordFaultEvent("heartbeat_success");
            return;
          }
          state.consecutiveFailures++;
          recordFaultEvent(
            "heartbeat_failure",
            `${options.repo}#${options.issueNumber} (consecutive: ${state.consecutiveFailures})`,
          );
          console.warn(
            `[heartbeat] recording failed for ${options.repo}#${options.issueNumber} ` +
              `(${state.consecutiveFailures} consecutive): ${result.error.message}`,
          );
        })
        .catch((err: unknown) => {
          state.consecutiveFailures++;
          const msg = err instanceof Error ? err.message : String(err);
          recordFaultEvent(
            "heartbeat_failure",
            `${options.repo}#${options.issueNumber} (consecutive: ${state.consecutiveFailures})`,
          );
          console.warn(
            `[heartbeat] recording failed for ${options.repo}#${options.issueNumber} ` +
              `(${state.consecutiveFailures} consecutive): ${msg}`,
          );
        });
    } catch (err: unknown) {
      state.consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      recordFaultEvent(
        "heartbeat_failure",
        `${options.repo}#${options.issueNumber} sync threw (consecutive: ${state.consecutiveFailures})`,
      );
      console.warn(
        `[heartbeat] recording threw for ${options.repo}#${options.issueNumber} ` +
          `(${state.consecutiveFailures} consecutive): ${msg}`,
      );
    }
  };

  // Set up periodic heartbeat
  const intervalId = setInterval(recordWithTracking, intervalMs);
  state.intervalId = intervalId;

  activeHeartbeats.set(id, state);

  return {
    ok: true,
    value: { id, repo: options.repo, issueNumber: options.issueNumber },
  };
}

/**
 * Stop periodic heartbeat updates and clear the heartbeat.
 *
 * Clears the interval and calls clearFn for a final cleanup.
 * Safe to call even if the heartbeat is not running or has already been stopped.
 */
export async function stopHeartbeat(
  handle: HeartbeatHandle,
  outcome?: RunOutcome,
): Promise<void> {
  const active = activeHeartbeats.get(handle.id);
  if (!active) {
    return; // Already stopped or never started — safe no-op
  }

  if (active.intervalId !== null) clearInterval(active.intervalId);
  activeHeartbeats.delete(handle.id);

  // The run outcome rides the final clear (Issue #4330): parked for the
  // marker path, whatever `clearFn` wiring the caller supplied, so the
  // release comment states what the run achieved.
  if (outcome) {
    setPendingReleaseOutcome(
      active.options.repo,
      active.options.issueNumber,
      outcome,
    );
  }
  // Clear heartbeat on completion (best-effort)
  try {
    await active.options.clearFn(
      active.options.workDir,
      active.options.repo,
      active.options.issueNumber,
    );
  } catch (err) {
    recordFaultEvent(
      "catch_block_warning",
      `heartbeat clearFn failed for ${handle.repo}#${handle.issueNumber}: ${err}`,
    );
  } finally {
    // A clearFn that never reached the marker path leaves the parked
    // outcome behind — drop it so it cannot attach to a later claim.
    takePendingReleaseOutcome(active.options.repo, active.options.issueNumber);
  }

  // Issue #3760: release the allowlist pin taken by startHeartbeat — after
  // clearFn, because the final stale-marker PATCH is itself a GitHub write
  // to this repo and must still be allowed.
  unpinWriteRepo(active.options.repo);
}

/**
 * Stop every active heartbeat and return the handles that were stopped
 * (Issue #3760).
 *
 * Safety net for the claim boundary: a heartbeat still active when the
 * scan loop is about to process the next claim was leaked by its owning
 * processor (every start/stop pair should have closed it). Left running,
 * the leaked interval keeps writing marker comments for a claim this
 * worker no longer holds. The caller logs each returned handle so the
 * leaking processor is identifiable from the worker log.
 */
export async function stopAllHeartbeats(): Promise<HeartbeatHandle[]> {
  const leaked: HeartbeatHandle[] = [...activeHeartbeats.entries()].map(
    ([id, state]) => ({
      id,
      repo: state.options.repo,
      issueNumber: state.options.issueNumber,
    }),
  );
  for (const handle of leaked) {
    await stopHeartbeat(handle);
  }
  return leaked;
}

/**
 * Stop every heartbeat that no live slot owns (Issue #4178, part of #4168).
 *
 * `stopAllHeartbeats` stops EVERY heartbeat in the process — right for
 * process shutdown, wrong under a pool: slot A finishing would kill slot
 * B's marker refresh and a sibling host's stuck-detection would steal B's
 * issue. The leaked-heartbeat sweep (Issue #3760) that runs before each
 * claim now uses this variant, fed the `(repo, issue)` pairs the pool
 * currently holds; a genuinely leaked heartbeat — no owning slot — is
 * still stopped.
 *
 * @param live - The `(repo, issueNumber)` pairs live slots own.
 * @returns The handles that were stopped (the leaks).
 */
export async function stopHeartbeatsExcept(
  live: ReadonlyArray<{ repo: string; issueNumber: number }>,
): Promise<HeartbeatHandle[]> {
  const keep = new Set(live.map((l) => makeHandleId(l.repo, l.issueNumber)));
  const leaked: HeartbeatHandle[] = [...activeHeartbeats.entries()]
    .filter(([id]) => !keep.has(id))
    .map(([id, state]) => ({
      id,
      repo: state.options.repo,
      issueNumber: state.options.issueNumber,
    }));
  for (const handle of leaked) {
    await stopHeartbeat(handle);
  }
  return leaked;
}

/**
 * Check whether a heartbeat is currently running for the given repo/issue.
 */
export function isHeartbeatRunning(repo: string, issueNumber: number): boolean {
  const id = makeHandleId(repo, issueNumber);
  return activeHeartbeats.has(id);
}
