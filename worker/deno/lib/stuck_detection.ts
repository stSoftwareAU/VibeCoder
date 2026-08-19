/**
 * Stuck issue detection — read-only predicates that decide whether an
 * issue is stale, whether another live worker holds the claim, and
 * whether an open PR is already linked (Issues #471, #1452, #1454).
 *
 * Single responsibility: answer yes/no detection questions. Recovery
 * actions (unassigning, commenting, closing) live in stuck_recovery.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  heartbeatFilePath,
  scanHeartbeatMarkers,
} from "./heartbeat_storage.ts";
import type { IssueCache } from "./issue_cache.ts";
import { findOpenLinkedPR } from "./pr_linkage.ts";

/** Configuration for the stuck issue detector. */
export interface StuckIssueConfig {
  /** Working directory for heartbeat files. */
  workDir: string;
  /** Timeout before an issue is considered stuck (default: 7200 seconds / 2 hours). */
  stuckIssueTimeout: number;
  /** Timeout for assigned-but-no-heartbeat recovery (default: 1800 seconds / 30 minutes). */
  assignedNoHeartbeatTimeout: number;
  /** Timeout for stale GitHub assignments (default: 14400 seconds / 4 hours). */
  staleAssignmentTimeout: number;
  /** Repositories to scan ("owner/repo" format). */
  repos: string[];
  /**
   * Stable machine identifier (Issue #1454). When provided, detection
   * functions consult the GitHub-visible heartbeat marker comments before
   * unassigning so they do not recover another machine's live claim. When
   * omitted, behaviour falls back to the original heartbeat-file-only
   * check.
   */
  machineId?: string;
  /**
   * Fleet GitHub logins whose heartbeat/claim markers are trusted (Issue
   * #3164) — the `resolveFleetAuthors` union of the host login,
   * `allowedAuthors`, and `fleetPrAuthors`. When provided, recovery only
   * honours markers posted by a fleet account; a forged marker from a
   * non-fleet commenter is ignored (fail toward recovery). When omitted,
   * markers from any author are honoured (prior behaviour).
   */
  fleetAuthors?: string[];
}

/** Default configuration values. */
export const STUCK_ISSUE_DEFAULTS = {
  stuckIssueTimeout: 7200,
  assignedNoHeartbeatTimeout: 1800,
  staleAssignmentTimeout: 14400,
} as const;

/** Result of a recovery scan. */
export interface RecoveryScanResult {
  /** Number of stuck heartbeat issues recovered. */
  stuckRecovered: number;
  /** Number of assigned-without-heartbeat issues recovered. */
  noHeartbeatRecovered: number;
  /** Number of stale GitHub assignments recovered. */
  staleRecovered: number;
}

/**
 * Check whether an issue's heartbeat is stale.
 *
 * Returns true if the heartbeat exceeds stuckIssueTimeout seconds.
 */
export async function isIssueStuck(
  workDir: string,
  repo: string,
  issueNumber: number,
  stuckIssueTimeout: number,
  nowFn: () => number = () => Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const path = heartbeatFilePath(workDir, repo, issueNumber);
  try {
    const content = await Deno.readTextFile(path);
    const heartbeatTime = parseInt(content.trim(), 10);
    if (isNaN(heartbeatTime)) return false;
    const elapsed = nowFn() - heartbeatTime;
    return elapsed > stuckIssueTimeout;
  } catch {
    return false; // No heartbeat file — not tracked
  }
}

/**
 * Determine whether the published markers indicate that another live
 * worker holds the claim (Issue #1454) or that the previous claim was
 * cleanly released (Issue #1886).
 *
 * Returns true when any of the following holds:
 *   - Any marker is `cleared` — the worker that previously held the
 *     claim finished and released it (Issue #1886). This is the success
 *     path, not a crash, so recovery must not unassign the issue.
 *   - Any marker has an epoch newer than `now - timeoutSeconds` (another
 *     machine has refreshed within the timeout window).
 *   - Any marker matches `thisMachineId` — the local heartbeat file has
 *     been lost but this machine still holds the claim on GitHub; do not
 *     unassign our own claim.
 *
 * Returns false when no marker exists or all markers are older than the
 * timeout, not cleared, and belong to other machines — the caller should
 * fall back to the existing `updatedAt` based recovery.
 *
 * Issue #3164: `allowedAuthors` (the `resolveFleetAuthors` union) is
 * forwarded to `scanHeartbeatMarkers` so that only markers posted by a
 * fleet account are considered. A forged marker from a non-fleet commenter
 * is ignored, so recovery cannot be defeated by an attacker who can merely
 * comment on the issue.
 */
export async function shouldSkipRecoveryForMarker(
  repo: string,
  issueNumber: number,
  thisMachineId: string,
  timeoutSeconds: number,
  nowFn: () => number,
  ghFn: (args: string[]) => Promise<string>,
  allowedAuthors?: string[],
): Promise<boolean> {
  const markers = await scanHeartbeatMarkers(
    repo,
    issueNumber,
    ghFn,
    allowedAuthors,
  );
  if (markers.length === 0) return false;
  // Issue #1886: a cleared marker is the explicit "claim released by
  // worker on success" signal. Check it before the live/own-machine
  // predicates so a cleared marker on an older claim still wins —
  // recovering an issue whose worker has already finished is the
  // false-positive root cause from #1881.
  for (const m of markers) {
    if (m.cleared) return true;
  }
  const now = nowFn();
  for (const m of markers) {
    if (m.epoch > 0 && now - m.epoch <= timeoutSeconds) return true;
    if (m.machineId === thisMachineId && m.epoch > 0) return true;
  }
  return false;
}

/**
 * Check whether an open PR linked to an issue exists (Issues #1452,
 * #1887).
 *
 * Reused by recovery paths to skip recovery when work has been
 * delivered and the worker is legitimately waiting on review/merge.
 *
 * Delegates to `findOpenLinkedPR`, which considers four signals
 * (title match, GraphQL `closedByPullRequestsReferences`, GraphQL
 * `CrossReferencedEvent`, and the worker-authored "Pull request ...
 * has been created" comment). The `githubUser` parameter is forwarded
 * as the worker login for the worker-comment signal.
 */
export async function hasOpenLinkedPR(
  repo: string,
  issueNumber: number,
  ghFn: (args: string[]) => Promise<string>,
  cache?: IssueCache,
  githubUser?: string,
): Promise<boolean> {
  const linked = await findOpenLinkedPR(
    repo,
    issueNumber,
    ghFn,
    cache,
    githubUser,
  );
  return linked !== null;
}

/**
 * Parse a heartbeat filename to extract repo and issue number.
 *
 * Format: .heartbeat_{owner}_{repo}_{issue_number}
 * Returns null if the filename cannot be parsed.
 */
export function parseHeartbeatFilename(
  filename: string,
): { repo: string; issueNumber: number } | null {
  const prefix = ".heartbeat_";
  if (!filename.startsWith(prefix)) return null;

  const remainder = filename.substring(prefix.length);
  // The issue number is the last segment after the final underscore
  const lastUnderscoreIdx = remainder.lastIndexOf("_");
  if (lastUnderscoreIdx < 0) return null;

  const issueStr = remainder.substring(lastUnderscoreIdx + 1);
  const issueNumber = parseInt(issueStr, 10);
  if (isNaN(issueNumber)) return null;

  const repoParts = remainder.substring(0, lastUnderscoreIdx);
  // Reconstruct repo name: first underscore becomes /
  const firstUnderscoreIdx = repoParts.indexOf("_");
  if (firstUnderscoreIdx < 0) return null;

  const repo = repoParts.substring(0, firstUnderscoreIdx) + "/" +
    repoParts.substring(firstUnderscoreIdx + 1);

  return { repo, issueNumber };
}

/**
 * Parse an ISO date string to Unix epoch seconds.
 * Returns NaN on failure.
 */
export function parseISODate(dateStr: string): number {
  const ms = Date.parse(dateStr);
  if (isNaN(ms)) return NaN;
  return Math.floor(ms / 1000);
}
