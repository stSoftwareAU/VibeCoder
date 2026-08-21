/**
 * Structured telemetry for heartbeat recovery decisions (Issue #1884).
 *
 * Each scanned assigned issue produces exactly one
 * `RecoveryDecisionEvent` describing the inputs the recovery code
 * considered and the decision it reached, so the frequency of
 * "no heartbeat recorded" recoveries can be diagnosed (parent #1883).
 *
 * Events are emitted as a single JSON line with the
 * `[recovery-decision]` prefix so they can be grepped out of the
 * worker log without parsing TypeScript stack traces. They are also
 * captured in an in-memory ring buffer so unit tests can assert on
 * the decision reached for a given fixture without depending on
 * console output.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { recordFaultEvent } from "./fault_tolerance_counters.ts";

/**
 * Classification of the published heartbeat marker comment(s).
 *
 *   - `none`      — no marker comment found on the issue.
 *   - `live`      — at least one marker has an epoch within the
 *                   recovery timeout window.
 *   - `stale`     — markers exist but every epoch is older than the
 *                   timeout window (no `cleared` markers either).
 *   - `cleared`   — the latest marker has epoch 0, indicating the
 *                   claim was released by `clearHeartbeat`.
 *   - `malformed` — markers were present but no epoch could be parsed.
 */
export type MarkerStateClassification =
  | "none"
  | "live"
  | "stale"
  | "cleared"
  | "malformed";

/**
 * Decision reached for a single scanned assigned issue.
 *
 * `skipped:cleared_marker` is reserved for sub-issue #3 of the parent
 * diagnostic effort — it is included in the type so the schema is
 * stable, even though no current code path emits it.
 */
export type RecoveryDecision =
  | "recovered"
  | "skipped:open_pr"
  | "skipped:live_marker"
  | "skipped:own_machine"
  | "skipped:within_threshold"
  | "skipped:has_local_heartbeat"
  /** A live slot on this host owns the claim (Issue #214). */
  | "skipped:live_slot"
  | "skipped:cleared_marker"
  | "skipped:invalid_updated_at"
  /** The issue is already closed — a leftover heartbeat file only (Issue #230). */
  | "skipped:issue_closed"
  /** The issue is no longer assigned to this account (Issue #230). */
  | "skipped:not_assigned";

/** Source recovery scan that produced the decision. */
export type RecoverySource =
  | "detectAssignedWithoutHeartbeat"
  | "recoverStaleGithubAssignments"
  /** Start-up sweep of leftover local heartbeat files (Issue #230). */
  | "detectAndRecoverStuckHeartbeats";

/** A single recovery decision event. */
export interface RecoveryDecisionEvent {
  /** Identifies the scan that emitted the event. */
  readonly source: RecoverySource;
  /** "owner/repo#number". */
  readonly issue: string;
  /** GitHub user the issue is assigned to. */
  readonly assignee: string;
  /** Seconds since the issue's `updatedAt` timestamp; `null` when unknown. */
  readonly elapsedSinceUpdate: number | null;
  /** Classification of the latest marker comment on the issue. */
  readonly markerState: MarkerStateClassification;
  /** Latest marker's machine identifier, if any. */
  readonly markerMachineId: string | null;
  /** Latest marker's epoch (seconds since 1970), if any. */
  readonly markerEpoch: number | null;
  /** Linked open PR ("owner/repo#N") or `null` when none was found. */
  readonly linkedOpenPR: string | null;
  /** Whether a heartbeat file for this issue exists in `workDir`. */
  readonly localHeartbeatPresent: boolean;
  /**
   * Whether this decision concerns an assignee from a *different* account
   * than the scanning worker, recovered on the strength of that account's
   * own claim/heartbeat marker evidence (Issue #2671). `false` for the
   * ordinary own-account recovery path. Lets log aggregators tell
   * cross-account recoveries apart from own-account ones.
   */
  readonly crossAccount: boolean;
  /** Final decision reached for this issue. */
  readonly decision: RecoveryDecision;
}

const recordedEvents: RecoveryDecisionEvent[] = [];

/**
 * Record a recovery decision event.
 *
 * Logs the event as a single JSON line for production diagnostics and
 * captures it in an in-memory buffer for unit tests.
 */
export function recordRecoveryDecision(event: RecoveryDecisionEvent): void {
  recordedEvents.push(event);
  // Counter-style summary so existing fault tolerance tooling can
  // surface aggregate decision frequencies without parsing the JSON
  // payload.
  recordFaultEvent(
    "catch_block_warning",
    `recovery-decision ${event.decision} ${event.source} ${event.issue}`,
  );
  // Production diagnostic line — keep on a single line so log
  // aggregators can ingest it as JSON.
  console.log(`[recovery-decision] ${JSON.stringify(event)}`);
}

/**
 * Reset the in-memory event buffer. Tests must call this in setup so
 * assertions only see events produced by the current test case.
 */
export function __resetRecoveryDecisions(): void {
  recordedEvents.length = 0;
}

/**
 * Snapshot of all recovery decision events recorded since the last
 * reset.
 */
export function __getRecoveryDecisions(): RecoveryDecisionEvent[] {
  return recordedEvents.slice();
}

/**
 * Result of classifying the markers visible on an issue.
 */
export interface MarkerClassification {
  /** Overall state classification. */
  readonly state: MarkerStateClassification;
  /** Latest marker by epoch (or `null` when no markers were found). */
  readonly latest:
    | { machineId: string; epoch: number; cleared?: boolean }
    | null;
  /**
   * Whether the markers indicate recovery should be skipped, and the
   * matching skip decision.
   */
  readonly skip:
    | {
      skip: true;
      decision:
        | "skipped:live_marker"
        | "skipped:own_machine"
        | "skipped:cleared_marker";
    }
    | { skip: false };
}

/**
 * Classify a list of heartbeat markers for telemetry purposes.
 *
 * Matches the predicates used by `shouldSkipRecoveryForMarker` so the
 * emitted decision can distinguish a peer's live claim from a refresh
 * left behind by this same machine.
 *
 * Issue #1886: a cleared marker (epoch=0 + `<!-- cleared: ... -->`
 * suffix) takes precedence over live/own-machine checks — it means the
 * previous worker finished cleanly, so recovery must skip with
 * `skipped:cleared_marker`.
 */
export function classifyMarkers(
  markers: ReadonlyArray<
    { machineId: string; epoch: number; cleared?: boolean }
  >,
  thisMachineId: string | undefined,
  now: number,
  timeoutSeconds: number,
): MarkerClassification {
  if (markers.length === 0) {
    return { state: "none", latest: null, skip: { skip: false } };
  }

  let latest: { machineId: string; epoch: number; cleared?: boolean } | null =
    null;
  for (const m of markers) {
    if (latest === null || m.epoch > latest.epoch) latest = m;
  }
  if (latest === null) {
    return { state: "malformed", latest: null, skip: { skip: false } };
  }

  // Issue #1886: a cleared marker means the previous worker finished
  // and released the claim on success. Skip recovery regardless of
  // updatedAt or which machine we are.
  for (const m of markers) {
    if (m.cleared) {
      return {
        state: "cleared",
        latest,
        skip: { skip: true, decision: "skipped:cleared_marker" },
      };
    }
  }

  // Then check live/own-machine skip predicates — the recovery code
  // uses these to decide skip:live_marker vs skip:own_machine.
  if (thisMachineId) {
    for (const m of markers) {
      if (m.epoch > 0 && now - m.epoch <= timeoutSeconds) {
        return {
          state: "live",
          latest,
          skip: { skip: true, decision: "skipped:live_marker" },
        };
      }
      if (m.machineId === thisMachineId && m.epoch > 0) {
        return {
          state: "live",
          latest,
          skip: { skip: true, decision: "skipped:own_machine" },
        };
      }
    }
  }

  // No skip — classify the latest marker for diagnostic purposes.
  // (epoch=0 without the cleared suffix is treated as stale — it's an
  // older marker shape that we still record but no longer recognise as
  // a release signal.)
  if (latest.epoch === 0) {
    return { state: "cleared", latest, skip: { skip: false } };
  }
  return { state: "stale", latest, skip: { skip: false } };
}
