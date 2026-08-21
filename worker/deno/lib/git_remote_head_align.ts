/**
 * Align a local PR branch with the remote head before evaluating it (Issue #211).
 *
 * The branch-update pass reuses one working copy per repo, so a local feature
 * branch can still carry commits an earlier pass failed to push. Rebasing that
 * stale local branch onto the base reports a conflict the *PR* does not have —
 * live, PR #557 was labelled `merge-conflict` while the remote PR was perfectly
 * mergeable, because the conflict came from four unpushed local commits.
 *
 * A PR is what the remote says it is. This helper resets the checked-out branch
 * to `origin/<branch>` whenever local-only commits are present, so conflict
 * detection is always evaluated against the remote head. Discarded commits are
 * named in the result (and recoverable from the reflog) rather than dropped
 * silently.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { assertSafeGitRef, buildFetchArgs } from "./git_ref_args.ts";

/** Outcome of {@link alignBranchWithRemoteHead}. */
export interface RemoteHeadAlignment {
  /** Whether the local branch was reset to the remote head. */
  aligned: boolean;
  /** Local-only commits that were discarded by the reset. */
  discardedCommits: number;
  /** HEAD before the reset — the reflog entry to recover from. */
  previousSha?: string;
  /** Human-readable description of what happened. */
  detail: string;
}

/**
 * Reset the currently checked-out `branchName` to `origin/<branchName>` when it
 * carries local-only commits (Issue #211).
 *
 * A no-op — reported as success — when the remote-tracking ref does not exist
 * (a branch never pushed) or when nothing local is ahead of it.
 *
 * @param branchName - The branch to align (must be checked out)
 * @param options - Git command options (cwd, env, timeout)
 * @returns What was aligned, or the git failure that stopped it
 */
export async function alignBranchWithRemoteHead(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<RemoteHeadAlignment>> {
  try {
    assertSafeGitRef(branchName, "PR head branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  const remoteRef = `origin/${branchName}`;
  const fetch = await runGitCommand(
    buildFetchArgs("origin", branchName),
    options,
  );
  const fetchFailure = !fetch.ok
    ? fetch.error.message
    : fetch.value.code !== 0
    ? fetch.value.stderr.trim()
    : null;

  const remoteHead = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`],
    options,
  );
  const hasRemoteHead = remoteHead.ok && remoteHead.value.code === 0;

  if (fetchFailure !== null && hasRemoteHead) {
    // A branch we *do* track failed to refresh: the local ref may be stale, so
    // any verdict drawn from it would be unreliable. Fail loudly rather than
    // aligning to a ref we could not confirm.
    return {
      ok: false,
      error: new Error(
        `Failed to fetch '${branchName}' before aligning with the remote head: ${fetchFailure}`,
      ),
    };
  }

  if (!hasRemoteHead) {
    // A branch that was never pushed has no remote head to align to — that is
    // the ordinary first-push case, not a failure.
    return {
      ok: true,
      value: {
        aligned: false,
        discardedCommits: 0,
        detail:
          `no remote-tracking ref for '${remoteRef}' — nothing to align to` +
          (fetchFailure ? ` (fetch said: ${fetchFailure})` : ""),
      },
    };
  }

  const aheadResult = await runGitCommand(
    ["rev-list", "--count", `${remoteRef}..HEAD`],
    options,
  );
  if (!aheadResult.ok || aheadResult.value.code !== 0) {
    const detail = aheadResult.ok
      ? aheadResult.value.stderr.trim()
      : aheadResult.error.message;
    return {
      ok: false,
      error: new Error(
        `Failed to count local commits ahead of '${remoteRef}': ${detail}`,
      ),
    };
  }
  const localOnly = parseInt(aheadResult.value.stdout.trim(), 10) || 0;
  if (localOnly === 0) {
    return {
      ok: true,
      value: {
        aligned: false,
        discardedCommits: 0,
        detail: `'${branchName}' already matches ${remoteRef}`,
      },
    };
  }

  const headResult = await runGitCommand(["rev-parse", "HEAD"], options);
  const previousSha = headResult.ok && headResult.value.code === 0
    ? headResult.value.stdout.trim()
    : undefined;

  const reset = await runGitCommand(
    ["reset", "--hard", remoteRef],
    options,
  );
  if (!reset.ok) {
    return { ok: false, error: reset.error };
  }
  if (reset.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Failed to reset '${branchName}' to ${remoteRef}: ${reset.value.stderr.trim()}`,
      ),
    };
  }

  return {
    ok: true,
    value: {
      aligned: true,
      discardedCommits: localOnly,
      previousSha,
      detail:
        `reset '${branchName}' to ${remoteRef}, setting aside ${localOnly} unpushed local commit(s)` +
        (previousSha ? ` (was ${previousSha.substring(0, 7)})` : ""),
    },
  };
}
