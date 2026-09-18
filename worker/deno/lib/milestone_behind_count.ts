/**
 * How far one milestone branch is behind the default branch (Issue #2309).
 *
 * The Priority 1.72 sweep syncs a repository's milestone branches
 * longest-behind first, because the branch carrying the most drift is the one
 * most likely to conflict and the one whose conflict is cheapest to settle
 * today rather than a week from now. That order needs a number, and this is
 * where it is measured — one fetch of the branch's own remote-tracking ref,
 * then the same `git rev-list --count` `milestone_presync.ts` makes.
 *
 * It lives in its own module rather than inside the production wiring so both
 * halves — the fetch that could not reach the remote, and the count git
 * refused — are reachable from a test. An unmeasurable branch is never a
 * branch that goes unsynced: the caller logs the reason and sorts it as level.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { countCommitsAhead } from "./git_issue_branches.ts";
import { buildFetchTrackingRefArgs } from "./git_ref_args.ts";
import type { GitCommandOptions, GitCommandOutput } from "./git_timeout.ts";
import { runGitCommand } from "./git_timeout.ts";

/** The git runner this measurement needs; injected in tests. */
export type GitRunner = (
  args: string[],
  options?: GitCommandOptions,
) => Promise<Result<GitCommandOutput>>;

/** What one measurement needs to know. */
export interface MilestoneBehindCountRequest {
  /** The milestone branch being measured. */
  milestoneBranch: string;
  /** The default branch it is measured against. */
  defaultBranch: string;
  /** The clone the measurement runs in. */
  cwd: string;
  /** Fetches and counts; defaults to the worker's own git runner. */
  gitFn?: GitRunner;
  /** Counts commits; defaults to {@link countCommitsAhead}. */
  countFn?: typeof countCommitsAhead;
}

/**
 * Count the commits the default branch carries that the milestone branch does
 * not.
 *
 * The branch's own remote-tracking ref is fetched explicitly (Issue #211): a
 * narrowed clone never creates `origin/<milestone>` from a bare branch fetch,
 * and the count reads exactly that ref. The default tip is whatever the
 * repository pass already made current.
 *
 * Every failure is returned as the failure git gave rather than as a zero, so
 * an unmeasurable branch is never mistaken for one that is level.
 *
 * @param request - The branch, its default, and the clone to measure in
 * @returns The behind count, or the reason it could not be read
 */
export async function measureMilestoneBehindCount(
  request: MilestoneBehindCountRequest,
): Promise<Result<number>> {
  const { milestoneBranch, defaultBranch, cwd } = request;
  const gitFn = request.gitFn ?? runGitCommand;
  const countFn = request.countFn ?? countCommitsAhead;

  const fetched = await gitFn(
    buildFetchTrackingRefArgs("origin", milestoneBranch),
    { cwd },
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };
  if (fetched.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git fetch origin ${milestoneBranch} exited ${fetched.value.code}: ` +
          (fetched.value.stderr.trim() || "(no output)"),
      ),
    };
  }

  return await countFn(
    `origin/${milestoneBranch}`,
    `origin/${defaultBranch}`,
    { cwd },
  );
}
