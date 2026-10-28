/**
 * Remote view of a gated-head feedback fix branch (Issue #4466).
 *
 * A PR-feedback run on a ruleset-gated `milestone/**` head works on a
 * `milestone-fix/...` side branch (Issue #2907). The agent can push that
 * branch itself and leave local HEAD or the unpushed count in a state the
 * local change/push view reads as "nothing pushed", which stranded the fix:
 * no fix PR and a no-change reply. What is on origin is what counts, so this
 * asks the remote: does `origin/<fixBranch>` hold commits that are not on
 * `origin/<headBranch>`?
 *
 * Uses Australian English throughout (behaviour, recognise).
 */

import type { Result } from "../types.ts";
import { ensureHistoryDepth } from "./git_history.ts";
import type { GitRunner } from "./git_history.ts";
import { buildFetchTrackingRefArgs } from "./git_ref_args.ts";

/** Matches a full git object id (SHA-1 or SHA-256). */
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Commits on the fix branch's remote head that the PR head does not hold. */
export interface StrandedFixCommits {
  /** How many commits `origin/<fixBranch>` is ahead of `origin/<headBranch>`. */
  ahead: number;
  /** The remote tip of the fix branch. */
  tipSha: string;
}

function failure(message: string): Result<never> {
  return { ok: false, error: new Error(message) };
}

/**
 * Report the commits on `origin/<fixBranch>` that are not on
 * `origin/<headBranch>`.
 *
 * @returns `ok(null)` when the fix branch is absent from origin or holds
 *   nothing the PR head lacks; `ok({ahead, tipSha})` when it does; an error
 *   Result, carrying git's own stderr, when the remote cannot be consulted —
 *   never a fabricated "nothing ahead".
 */
export async function findCommitsAheadOnRemote(
  run: GitRunner,
  fixBranch: string,
  headBranch: string,
  options: { cwd?: string } = {},
): Promise<Result<StrandedFixCommits | null>> {
  const gitOptions = options.cwd !== undefined ? { cwd: options.cwd } : {};
  let headFetchArgs: string[];
  let fixFetchArgs: string[];
  try {
    headFetchArgs = buildFetchTrackingRefArgs("origin", headBranch);
    fixFetchArgs = buildFetchTrackingRefArgs("origin", fixBranch);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(`${err}`),
    };
  }

  const headFetch = await run(headFetchArgs, gitOptions);
  if (!headFetch.ok) return headFetch;
  if (headFetch.value.code !== 0) {
    return failure(
      `could not fetch '${headBranch}' from origin: ${headFetch.value.stderr.trim()}`,
    );
  }

  const fixFetch = await run(fixFetchArgs, gitOptions);
  if (!fixFetch.ok) return fixFetch;
  if (fixFetch.value.code !== 0) {
    // A fix branch that never reached origin is a legitimate "nothing
    // stranded" — git says so with "couldn't find remote ref".
    if (/couldn't find remote ref/i.test(fixFetch.value.stderr)) {
      return { ok: true, value: null };
    }
    return failure(
      `could not fetch '${fixBranch}' from origin: ${fixFetch.value.stderr.trim()}`,
    );
  }

  const remoteHead = `refs/remotes/origin/${headBranch}`;
  const remoteFix = `refs/remotes/origin/${fixBranch}`;

  // Monitored repos are shallow clones: without the merge base the count
  // would include commits the PR head already holds.
  const depth = await ensureHistoryDepth([remoteHead, remoteFix], {
    ...gitOptions,
    gitRunner: run,
  });
  if (!depth.ok) return depth;

  const counted = await run(
    ["rev-list", "--count", remoteFix, "--not", remoteHead],
    gitOptions,
  );
  if (!counted.ok) return counted;
  if (counted.value.code !== 0) {
    return failure(
      `could not count '${fixBranch}' commits ahead of '${headBranch}': ${counted.value.stderr.trim()}`,
    );
  }
  const countText = counted.value.stdout.trim();
  if (!/^\d+$/.test(countText)) {
    return failure(
      `unexpected 'git rev-list --count' output for '${fixBranch}': '${countText}'`,
    );
  }
  const ahead = Number(countText);
  if (ahead === 0) return { ok: true, value: null };

  const tip = await run(["rev-parse", "--verify", remoteFix], gitOptions);
  if (!tip.ok) return tip;
  const tipSha = tip.value.stdout.trim();
  if (tip.value.code !== 0 || !OBJECT_ID_PATTERN.test(tipSha)) {
    return failure(
      `could not resolve the remote tip of '${fixBranch}': ${tip.value.stderr.trim()}`,
    );
  }
  return { ok: true, value: { ahead, tipSha } };
}
