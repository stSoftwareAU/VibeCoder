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
 * The count itself is made via {@link countCommitsAheadRepairingBrokenRef}, so
 * a broken remote-tracking ref left over from an earlier crash or race no
 * longer blocks the count (Issue #2824): it is deleted and re-fetched once,
 * then the count is retried. A broken `origin/<default>` fails the milestone
 * tracking-ref fetch first (`fatal: bad object refs/remotes/origin/<default>`
 * from git's connectivity check), so a failed fetch also attempts that repair
 * and, once a ref has been repaired, fetches again before counting.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import {
  countCommitsAhead,
  countCommitsAheadRepairingBrokenRef,
} from "./git_issue_branches.ts";
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
  /** Logs a repaired broken ref (Issue #2824); defaults to `console.warn` so it is never dropped. */
  log?: (message: string) => void;
  /** Deletes a broken loose ref file (Issue #2824); defaults to `Deno.remove`. */
  removeFileFn?: (path: string) => Promise<void>;
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
  const log = request.log ?? console.warn;

  const fetchArgs = buildFetchTrackingRefArgs("origin", milestoneBranch);
  const baseRef = `origin/${milestoneBranch}`;
  const ref = `origin/${defaultBranch}`;
  const repairDeps = {
    log,
    countFn,
    gitFn,
    removeFileFn: request.removeFileFn,
  };

  const fetched = await gitFn(fetchArgs, { cwd });
  if (!fetched.ok) return { ok: false, error: fetched.error };
  if (fetched.value.code === 0) {
    return await countCommitsAheadRepairingBrokenRef(
      baseRef,
      ref,
      { cwd },
      repairDeps,
    );
  }

  const fetchFailure = new Error(
    `git fetch origin ${milestoneBranch} exited ${fetched.value.code}: ` +
      (fetched.value.stderr.trim() || "(no output)"),
  );

  // A broken remote-tracking ref for either counted branch fails the fetch
  // before any count runs (Issue #2824). The count's own `ignoring broken
  // ref` warning names it, so let the count drive the repair; only when a
  // ref was actually repaired is the fetch worth running again.
  let repaired = false;
  await countCommitsAheadRepairingBrokenRef(baseRef, ref, { cwd }, {
    ...repairDeps,
    log: (message) => {
      repaired = true;
      log(message);
    },
  });
  if (!repaired) return { ok: false, error: fetchFailure };

  const refetched = await gitFn(fetchArgs, { cwd });
  if (!refetched.ok) {
    return {
      ok: false,
      error: new Error(
        `${fetchFailure.message} — fetch retried after repairing a broken ` +
          `ref and could not run: ${refetched.error.message}`,
      ),
    };
  }
  if (refetched.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `${fetchFailure.message} — fetch retried after repairing a broken ` +
          `ref and exited ${refetched.value.code}: ` +
          (refetched.value.stderr.trim() || "(no output)"),
      ),
    };
  }
  return await countFn(baseRef, ref, { cwd });
}
