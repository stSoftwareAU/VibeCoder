/**
 * Crash cleanup — clear in-progress issue state on unexpected exit (Issue #631, #909).
 *
 * When a worker crashes (OOM, SIGKILL, power loss) after claiming an issue,
 * the issue remains assigned with a stale heartbeat file. This module provides
 * cleanup functions to clear that state, minimising the window where an issue
 * is assigned but unrecoverable.
 *
 * Migrated from worker/shared/crash_cleanup.sh (Issue #909).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  incrementCounter,
  recordFaultEvent,
} from "./fault_tolerance_counters.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";
import { spawnGh } from "./gh_spawn.ts";

/** Parameters for cleaning up an in-progress issue. */
export interface CleanupParams {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** Issue number being worked on. */
  issueNumber: number;
  /** GitHub username of the worker. */
  githubUser: string;
  /** Working directory where heartbeat files are stored. */
  workDir: string;
}

/**
 * Generate the heartbeat file path for a given repo and issue.
 *
 * Heartbeat files are stored as .heartbeat_{owner}_{repo}_{issue_number}
 * in the work directory.
 */
export function heartbeatFilePath(
  workDir: string,
  repo: string,
  issueNumber: number,
): string {
  const safeRepo = repo.replace("/", "_");
  return `${workDir}/.heartbeat_${safeRepo}_${issueNumber}`;
}

/**
 * Clear a heartbeat file for the given repo and issue.
 *
 * Returns ok:true regardless of whether the file existed — removal failure
 * is non-fatal.
 */
export async function clearHeartbeat(
  workDir: string,
  repo: string,
  issueNumber: number,
): Promise<Result<void>> {
  const path = heartbeatFilePath(workDir, repo, issueNumber);
  try {
    await Deno.remove(path);
  } catch {
    // File doesn't exist or removal failed — non-fatal
  }
  return { ok: true, value: undefined };
}

/**
 * Clean up an in-progress issue after a crash/exit.
 *
 * 1. Clears the heartbeat file so stuck_issue_detector doesn't false-trigger
 * 2. Unassigns the worker from the issue via `gh issue edit`
 *
 * This is a best-effort operation — all errors are suppressed to avoid
 * interfering with normal exit handling.
 *
 * Returns the actions taken for logging purposes.
 */
export async function cleanupInProgressIssue(
  params: CleanupParams,
): Promise<Result<{ heartbeatCleared: boolean; unassigned: boolean }>> {
  const { repo, issueNumber, githubUser, workDir } = params;

  if (!repo || !issueNumber) {
    return { ok: true, value: { heartbeatCleared: false, unassigned: false } };
  }

  let heartbeatCleared = false;
  let unassigned = false;

  // Step 1: Clear the heartbeat file
  incrementCounter("crashRecoveries");
  const clearResult = await clearHeartbeat(workDir, repo, issueNumber);
  heartbeatCleared = clearResult.ok;

  // Step 2: Unassign the worker from the issue
  if (githubUser) {
    try {
      const result = await spawnGh([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        repo,
        "--remove-assignee",
        githubUser,
      ], { stdout: "null", stderr: "null" });
      unassigned = result.success;
    } catch (err) {
      recordFaultEvent(
        "catch_block_warning",
        `crash cleanup unassign failed for ${repo}: ${err}`,
      );
    }
  }

  await emitSelfHealEventAuto({
    module: "crash_cleanup",
    action: "in_progress_issue_cleanup",
    reason: `repo=${repo} issue=${issueNumber}`,
    result: heartbeatCleared || unassigned ? "ok" : "noop",
    details: { heartbeatCleared, unassigned },
  }, workDir);

  return { ok: true, value: { heartbeatCleared, unassigned } };
}
