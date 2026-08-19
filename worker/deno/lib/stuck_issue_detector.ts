/**
 * Stuck issue detection and recovery — top-level orchestrator
 * (Issues #471, #909, #1454).
 *
 * Single responsibility: compose the heartbeat storage, detection, and
 * recovery modules into one entry point (`detectAndRecoverStuckIssues`)
 * for the worker startup scan, and re-export the public surface so
 * existing call sites keep working.
 *
 * Module split (Issue #1530):
 *   - heartbeat_storage.ts — heartbeat & marker file/comment storage
 *   - stuck_detection.ts   — read-only detection predicates and types
 *   - stuck_recovery.ts    — recovery side effects (unassign/comment/close)
 *
 * Workflow:
 *   1. When a worker claims an issue, recordHeartbeat writes an epoch
 *      timestamp locally and (when a machineId is provided) publishes a
 *      cross-machine visible marker comment on the GitHub issue.
 *   2. The heartbeat is updated periodically while working on the issue.
 *      The GitHub marker is refreshed at most once per refresh window.
 *   3. On startup, detectAndRecoverStuckIssues scans for stale heartbeats
 *      and for assigned issues with no live marker.
 *   4. Stale issues are unassigned and made available for the next scan
 *      cycle.
 *
 * Multi-worker safety: heartbeat files are stored locally in workDir, so
 * each worker only sees its own crashed-in-progress issues via heartbeat
 * files. The assigned-without-heartbeat and stale-assignment paths
 * additionally consult the GitHub-visible marker comments published by
 * recordHeartbeat so one machine does not unassign another machine's
 * live claim.
 *
 * Migrated from worker/shared/stuck_issue_detector.sh (Issue #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  type RecoveryScanResult,
  type StuckIssueConfig,
} from "./stuck_detection.ts";
import {
  detectAndRecoverStuckHeartbeats,
  detectAssignedWithoutHeartbeat,
  recoverStaleGithubAssignments,
} from "./stuck_recovery.ts";

// Re-export the public surface so existing imports of this module keep
// working without churn.
export {
  clearHeartbeat,
  DEFAULT_MARKER_REFRESH_SECONDS,
  type ExistingMarkerComment,
  findExistingMarkerComment,
  formatHeartbeatMarker,
  HEARTBEAT_MARKER_PREFIX,
  type HeartbeatBodyFields,
  heartbeatFilePath,
  type HeartbeatMarkerOptions,
  type HeartbeatMilestone,
  markerStateFilePath,
  parseHeartbeatMarker,
  publishOrRefreshMarker,
  recordHeartbeat,
  recordMilestone,
  releaseClaim,
  type ReleaseClaimOptions,
  renderHeartbeatBody,
  scanHeartbeatMarkers,
  seedMarkerState,
} from "./heartbeat_storage.ts";

export {
  hasOpenLinkedPR,
  isIssueStuck,
  parseHeartbeatFilename,
  type RecoveryScanResult,
  shouldSkipRecoveryForMarker,
  STUCK_ISSUE_DEFAULTS,
  type StuckIssueConfig,
} from "./stuck_detection.ts";

export {
  detectAndRecoverStuckHeartbeats,
  detectAssignedWithClosedPr,
  detectAssignedWithoutHeartbeat,
  recoverStaleGithubAssignments,
  recoverStuckIssue,
} from "./stuck_recovery.ts";

// Telemetry surface for heartbeat recovery decisions (Issue #1884).
export {
  __getRecoveryDecisions,
  __resetRecoveryDecisions,
  classifyMarkers,
  type MarkerClassification,
  type MarkerStateClassification,
  recordRecoveryDecision,
  type RecoveryDecision,
  type RecoveryDecisionEvent,
  type RecoverySource,
} from "./recovery_telemetry.ts";

/**
 * Full recovery scan — runs all detection and recovery mechanisms.
 *
 * This is the main entry point called during worker startup.
 *
 * Issue #1787: accepts an optional `IssueCache` so the per-iteration
 * `issues_all` cache is shared with the candidate collectors.
 */
export async function detectAndRecoverStuckIssues(
  config: StuckIssueConfig,
  githubUser: string,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
  cache?: import("./issue_cache.ts").IssueCache,
  options: { env?: (name: string) => string | undefined } = {},
): Promise<Result<RecoveryScanResult>> {
  // Container mode sweeps every local heartbeat at start-up (Issue #4241):
  // one worker per container is structural, so any file that exists here
  // is a dead run's — and on the durable volume it would otherwise
  // suppress recovery until it aged past the stuck timeout. Injectable env
  // so the suites pass with and without the image stamp.
  const env = options.env ?? ((name: string) => Deno.env.get(name));
  const inContainer = env("VIBE_IMAGE_AGENT_PROVIDERS") !== undefined;
  const stuckRecovered = await detectAndRecoverStuckHeartbeats(
    config,
    githubUser,
    nowFn,
    { sweepAllHeartbeats: inContainer },
  );
  const noHeartbeatRecovered = await detectAssignedWithoutHeartbeat(
    config,
    githubUser,
    nowFn,
    undefined,
    cache,
  );
  const staleRecovered = await recoverStaleGithubAssignments(
    config,
    githubUser,
    nowFn,
    undefined,
    cache,
  );

  return {
    ok: true,
    value: { stuckRecovered, noHeartbeatRecovered, staleRecovered },
  };
}
