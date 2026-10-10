/**
 * Disarm auto-merge on a pull request (Issue #3433).
 *
 * Shared by the orphan-bound hold and the milestone-fix sweep so a PR that must
 * not merge never keeps a live auto-merge. Import-free by design.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/**
 * Run `gh pr merge <N> --repo <repo> --disable-auto`.
 *
 * Never throws and is never silent: a failure (GitHub errors when auto-merge
 * was never enabled) is logged as a warning.
 *
 * @returns true when auto-merge was disarmed, false when the call failed.
 */
export async function disarmAutoMerge(
  repo: string,
  prNumber: number,
  ghCommandFn: (args: string[]) => Promise<string>,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await ghCommandFn([
      "pr",
      "merge",
      String(prNumber),
      "--repo",
      repo,
      "--disable-auto",
    ]);
    return true;
  } catch (err) {
    log(
      `WARNING: could not disarm auto-merge on ${repo}#${prNumber}: ${
        err instanceof Error ? err.message : String(err)
      } (Issue #3433)`,
    );
    return false;
  }
}
