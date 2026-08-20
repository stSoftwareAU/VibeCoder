/**
 * Force push recovery (Issue #186, #321, #375, #912, #3723).
 *
 * When a push is rejected because the remote contains work not present locally
 * (e.g., automated reformatting from CI), this module attempts to recover by:
 *   1. Pulling with rebase to integrate the remote changes
 *   2. If rebase conflicts occur, automatically resolving them
 *   3. If conflict resolution fails on a feature branch, falling back to
 *      --force-with-lease as a safe last resort (Issue #375), leased against
 *      the remote-tracking ref as it stood *before* the pull (Issue #3723)
 *   4. Retrying the push
 *
 * Migrated from worker/shared/git_operations.sh (recover_from_push_rejection).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertSafeGitRef, buildPullArgs } from "./git_ref_args.ts";
import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { isProtectedBranch } from "./git_branch.ts";
import { resolveRebaseConflicts } from "./git_conflict_resolution.ts";
import { buildForceWithLeaseArgs } from "./git_push_lease_args.ts";

/** Matches a git object id (SHA-1 or SHA-256, in full or abbreviated form). */
const OBJECT_ID_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * Capture `refs/remotes/origin/<branch>` before anything refreshes it (Issue #3723).
 *
 * @param branchName - The branch whose remote-tracking ref to read
 * @param options - Git command options (cwd, etc.)
 * @returns The tracking ref SHA, or null when it does not exist
 */
async function captureRemoteTrackingSha(
  branchName: string,
  options: GitCommandOptions,
): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    options,
  );

  if (!result.ok || result.value.code !== 0) {
    return null;
  }

  const sha = result.value.stdout.trim();
  return OBJECT_ID_PATTERN.test(sha) ? sha : null;
}

/**
 * Recover from a push rejection by fetching, rebasing, and retrying (Issue #186, #321, #375).
 *
 * @param branchName - The branch to recover
 * @param options - Git command options (cwd, etc.)
 * @returns Result indicating whether recovery succeeded
 */
export async function recoverFromPushRejection(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<string>> {
  // Refuse an empty or option-injecting ref before any git runs (Issue #12).
  try {
    assertSafeGitRef(branchName, "PR head branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  // Issue #3723: capture the remote-tracking ref *before* the pull refreshes
  // it, so the last-resort lease below is pinned to what we actually saw.
  const leaseBaseline = await captureRemoteTrackingSha(branchName, options);

  // Pull with rebase to integrate remote changes
  const pullResult = await runGitCommand(
    buildPullArgs("origin", branchName, { rebase: true }),
    options,
  );

  if (!pullResult.ok) {
    return { ok: false, error: pullResult.error };
  }

  if (pullResult.value.code !== 0) {
    // Rebase failed — attempt automatic conflict resolution (Issue #321)
    const conflictResult = await resolveRebaseConflicts(options);

    if (!conflictResult.ok) {
      // Abort the rebase
      await runGitCommand(["rebase", "--abort"], options);

      // Last resort: force-with-lease for feature branches (Issue #375)
      if (isProtectedBranch(branchName)) {
        return {
          ok: false,
          error: new Error(
            `Cannot force-push to protected branch '${branchName}'`,
          ),
        };
      }

      // Issue #3723: lease against the pre-pull baseline, not the ref the pull
      // just refreshed — otherwise the lease cannot fail and this degrades to
      // a plain --force over a concurrent author's commits (CWE-367).
      const forceResult = await runGitCommand(
        buildForceWithLeaseArgs(branchName, leaseBaseline),
        options,
      );

      if (forceResult.ok && forceResult.value.code === 0) {
        return { ok: true, value: "Push succeeded via --force-with-lease" };
      }

      const forceError = forceResult.ok
        ? forceResult.value.stderr
        : forceResult.error.message;
      return {
        ok: false,
        error: new Error(`--force-with-lease push also failed: ${forceError}`),
      };
    }
  }

  // Retry the push
  const retryResult = await runGitCommand(
    ["push", "origin", branchName],
    options,
  );

  if (!retryResult.ok) {
    return { ok: false, error: retryResult.error };
  }

  if (retryResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(`Retry push failed: ${retryResult.value.stderr}`),
    };
  }

  return { ok: true, value: "Push succeeded after rebase recovery" };
}
