/**
 * Heartbeat-recovery audit classifier (Issue #1885).
 *
 * Pure functions that classify each "Assigned-without-heartbeat recovery
 * (Issue #632)" event into one of four categories:
 *
 *   - `legitimate-crash` — no marker (or stale marker), no linked PR, no
 *     completion within the follow-up window.
 *   - `false-positive:cleared-marker` — the heartbeat marker existed and
 *     had been cleared (epoch=0 + `cleared:` suffix) at recovery time.
 *   - `false-positive:open-pr` — an open PR was linked to the issue at
 *     recovery time.
 *   - `false-positive:other` — some other shape that suggests the worker
 *     had not crashed (e.g. live marker still present, or the issue was
 *     reclaimed and merged shortly after the recovery comment).
 *
 * No I/O lives here — the orchestrating command (commands/audit_heartbeat
 * _recoveries.ts) is responsible for fetching comments, timeline events,
 * and PR state via gh, and feeds the gathered facts into `classifyEvent`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { HEARTBEAT_MARKER_PREFIX } from "./heartbeat_storage.ts";

/** The marker text used by the worker when it posts an Issue-#632 recovery. */
export const RECOVERY_MARKER_NEEDLE =
  "Assigned-without-heartbeat recovery (Issue #632)";

/** State of the VIBE_CODER_HEARTBEAT marker comment at the time of recovery. */
export type MarkerState =
  | "absent" // no marker comment exists
  | "live" // marker exists, epoch > 0, no `cleared:` suffix
  | "stale" // marker exists, epoch > 0, but older than the recovery
  | "cleared"; // marker exists, epoch = 0 and a `cleared:` suffix is present

/** Classification categories defined in Issue #1885. */
export type RecoveryCategory =
  | "legitimate-crash"
  | "false-positive:cleared-marker"
  | "false-positive:open-pr"
  | "false-positive:other";

/** Inputs required to classify a single recovery event. */
export interface ClassificationInput {
  /** State of the VIBE_CODER_HEARTBEAT marker comment at recovery time. */
  markerState: MarkerState;
  /**
   * True when at least one open PR was linked to the issue at the moment
   * the recovery comment was posted.
   */
  openLinkedPRAtRecovery: boolean;
  /**
   * True when the issue was reclaimed by the worker and a PR was merged
   * within the follow-up window. Used as the secondary signal for
   * `legitimate-crash`.
   */
  completedWithinFollowUp: boolean;
}

/**
 * Classify a single recovery event into one of the four buckets.
 *
 * Order is significant — the highest-confidence false-positive signals
 * (an open linked PR, then a cleared marker) are checked first so they
 * are not masked by later, weaker rules.
 */
export function classifyEvent(input: ClassificationInput): RecoveryCategory {
  if (input.openLinkedPRAtRecovery) {
    return "false-positive:open-pr";
  }
  if (input.markerState === "cleared") {
    return "false-positive:cleared-marker";
  }
  if (input.markerState === "live") {
    // A live marker means the worker was still publishing heartbeats — it
    // had not crashed. This is a different shape from a cleared marker
    // and is bucketed under `other`.
    return "false-positive:other";
  }
  // Marker is absent or stale at this point.
  if (input.completedWithinFollowUp) {
    // Worker recovered, reclaimed, and merged — looks like a transient
    // glitch rather than a true crash.
    return "false-positive:other";
  }
  return "legitimate-crash";
}

/**
 * Test whether a comment body looks like an Issue-#632 recovery comment.
 *
 * Matches the canonical marker first, then a small set of near-duplicate
 * phrases so the audit is not blindsided by a worker version drift.
 */
export function isRecoveryComment(body: string): boolean {
  if (body.includes(RECOVERY_MARKER_NEEDLE)) return true;
  // Require both phrases for the near-duplicate match so we do not flag
  // unrelated comments that happen to mention "no heartbeat recorded".
  const lower = body.toLowerCase();
  return (
    lower.includes("no heartbeat recorded") &&
    lower.includes("automatic recovery")
  );
}

/**
 * Classify the state of a VIBE_CODER_HEARTBEAT marker comment body.
 *
 * Decision order:
 *   1. If the body has no marker prefix at all → caller decides
 *      `absent` based on whether any marker comment was found.
 *   2. If the body contains `epoch=0` and a `cleared:` suffix → `cleared`.
 *   3. Otherwise the body holds a live marker.
 *
 * A `stale` classification is performed by the caller after comparing
 * the marker epoch against the recovery moment; this helper deals only
 * with the body content.
 */
export function parseMarkerStateFromBody(
  body: string,
): "live" | "cleared" | "absent" {
  if (!body.includes(HEARTBEAT_MARKER_PREFIX)) return "absent";
  // `epoch=0` is rendered literally as `:0 -->` after the machine id.
  const hasZeroEpoch = /:0\s*-->/.test(body);
  const hasClearedSuffix = body.toLowerCase().includes("cleared:");
  if (hasZeroEpoch && hasClearedSuffix) return "cleared";
  return "live";
}
