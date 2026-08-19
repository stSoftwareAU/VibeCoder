/**
 * Helper for building a `--force-with-lease` push argument array (Issue #3723).
 *
 * A bare `--force-with-lease` leases against `refs/remotes/origin/<branch>` as
 * it stands *at push time*. When the same code path refreshed that ref moments
 * earlier (a `git pull`/`git fetch`), the lease can never fail and the push
 * silently degrades to a plain `--force` (CWE-367) — destroying commits another
 * author pushed in between. Capturing the tracking ref *before* the refresh and
 * pinning the lease to that SHA restores the guard.
 */

/**
 * Build the argv for a lease-protected force push.
 *
 * @param branchName - The branch to push (also the remote-side ref name).
 * @param baselineSha - The `refs/remotes/origin/<branch>` SHA captured before
 *   any fetch/pull refreshed it, or `null` when no remote-tracking ref existed.
 *   A missing baseline falls back to the bare lease: after a rejected push the
 *   tracking ref may legitimately not exist yet, and git then leases on the
 *   remote branch being absent, which is still a meaningful guard.
 * @returns The git argument array, e.g.
 *   `["push", "origin", "feature", "--force-with-lease=feature:<sha>"]`.
 */
export function buildForceWithLeaseArgs(
  branchName: string,
  baselineSha: string | null,
): string[] {
  const lease = baselineSha === null
    ? "--force-with-lease"
    : `--force-with-lease=${branchName}:${baselineSha}`;
  return ["push", "origin", branchName, lease];
}
