/**
 * Re-apply local commits onto a moved remote head (Issue #211).
 *
 * Two fleet hosts can maintain the same PR minutes apart. When a sibling
 * pushes while this host's agent is running, our push is rejected, and the
 * old behaviour gave up and asked a human to "check the branch status".
 *
 * The right move is to re-apply our work onto the head the sibling created:
 * abort any half-finished rebase, fetch the branch, rebase our local commits
 * onto `origin/<branch>` (auto-resolving conflicts the same way push recovery
 * does), then push. Only a rebase that still conflicts *after* auto-resolution
 * is a genuine hand-off to a human.
 *
 * Every failure names the step that failed and carries the git stderr, so a
 * rejected push is diagnosable from the log alone.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import {
  assertSafeGitRef,
  buildFetchArgs,
  buildPushArgs,
  buildRebaseArgs,
} from "./git_ref_args.ts";
import {
  isRebaseInProgress,
  resolveRebaseConflicts,
} from "./git_conflict_resolution.ts";

/** Outcome of a successful {@link reapplyOntoRemoteHead} call. */
export interface ReapplyOutcome {
  /** Whether local commits were rebased onto a newer remote head. */
  rebased: boolean;
  /** Whether a push was made (false when there was nothing to push). */
  pushed: boolean;
  /** Number of local commits that were ahead of the remote head. */
  commitsReapplied: number;
  /** Human-readable description of what happened. */
  detail: string;
}

/** Build the error for a failed step, naming the step and the git stderr. */
function stepError(step: string, detail: string): Error {
  const trimmed = detail.trim();
  return new Error(
    `re-apply step '${step}' failed${trimmed ? `: ${trimmed}` : ""}`,
  );
}

/**
 * Re-apply the local commits of `branchName` onto the current remote head
 * and push them (Issue #211).
 *
 * Steps, each failing loudly with its git stderr:
 *   1. Abort a rebase left in progress by an earlier recovery attempt.
 *   2. `git fetch origin <branch>` — refresh the remote-tracking ref.
 *   3. Nothing local ahead of the remote head → success, nothing to do.
 *   4. Remote head already an ancestor of HEAD → push straight away.
 *   5. Otherwise rebase onto `origin/<branch>`, auto-resolving conflicts;
 *      an unresolvable conflict aborts the rebase and fails loudly.
 *   6. `git push origin <branch>` — a normal (never forced) push: the
 *      rebase made our commits a fast-forward of the remote head.
 *
 * @param branchName - The PR head branch to re-apply and push
 * @param options - Git command options (cwd, env, timeout)
 * @returns Result describing what was re-applied, or the failing step
 */
export async function reapplyOntoRemoteHead(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<ReapplyOutcome>> {
  try {
    assertSafeGitRef(branchName, "PR head branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // Step 1 — a previous recovery attempt may have left a rebase in progress.
  // Nothing below can run until the tree is out of that state.
  if (await isRebaseInProgress(options)) {
    const abort = await runGitCommand(["rebase", "--abort"], options);
    if (!abort.ok) {
      return {
        ok: false,
        error: stepError("abort-rebase", abort.error.message),
      };
    }
    if (abort.value.code !== 0) {
      return {
        ok: false,
        error: stepError("abort-rebase", abort.value.stderr),
      };
    }
  }

  // Step 2 — refresh the remote-tracking ref so we rebase onto the head the
  // sibling actually pushed, not the one we last saw.
  const fetch = await runGitCommand(
    buildFetchArgs("origin", branchName),
    options,
  );
  if (!fetch.ok) {
    return { ok: false, error: stepError("fetch", fetch.error.message) };
  }
  if (fetch.value.code !== 0) {
    return { ok: false, error: stepError("fetch", fetch.value.stderr) };
  }

  const remoteRef = `origin/${branchName}`;
  const remoteHead = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`],
    options,
  );
  if (!remoteHead.ok || remoteHead.value.code !== 0) {
    return {
      ok: false,
      error: stepError(
        "resolve-remote-head",
        `no remote-tracking ref for '${remoteRef}'`,
      ),
    };
  }

  // Step 3 — how much local work is ahead of the remote head?
  const aheadResult = await runGitCommand(
    ["rev-list", "--count", `${remoteRef}..HEAD`],
    options,
  );
  if (!aheadResult.ok || aheadResult.value.code !== 0) {
    const detail = aheadResult.ok
      ? aheadResult.value.stderr
      : aheadResult.error.message;
    return { ok: false, error: stepError("count-local-commits", detail) };
  }
  const commitsAhead = parseInt(aheadResult.value.stdout.trim(), 10) || 0;
  if (commitsAhead === 0) {
    return {
      ok: true,
      value: {
        rebased: false,
        pushed: false,
        commitsReapplied: 0,
        detail: `nothing to re-apply — HEAD is not ahead of ${remoteRef}`,
      },
    };
  }

  // Step 4 — is the remote head already in our history? Then the head did not
  // move under us and a plain push is all that is needed.
  const ancestor = await runGitCommand(
    ["merge-base", "--is-ancestor", remoteRef, "HEAD"],
    options,
  );
  const alreadyOnRemoteHead = ancestor.ok && ancestor.value.code === 0;

  let rebased = false;
  if (!alreadyOnRemoteHead) {
    // Step 5 — rebase our commits onto the moved head.
    const rebase = await runGitCommand(buildRebaseArgs(remoteRef), options);
    if (!rebase.ok) {
      await runGitCommand(["rebase", "--abort"], options);
      return { ok: false, error: stepError("rebase", rebase.error.message) };
    }
    if (rebase.value.code !== 0) {
      const resolution = await resolveRebaseConflicts(options);
      if (!resolution.ok) {
        await runGitCommand(["rebase", "--abort"], options);
        return {
          ok: false,
          error: stepError(
            "rebase",
            `${rebase.value.stderr.trim()} | auto-resolution failed: ${resolution.error.message}`,
          ),
        };
      }
      // Auto-resolution only counts when it finished the rebase.
      if (await isRebaseInProgress(options)) {
        await runGitCommand(["rebase", "--abort"], options);
        return {
          ok: false,
          error: stepError(
            "rebase",
            `${rebase.value.stderr.trim()} | rebase still in progress after auto-resolution`,
          ),
        };
      }
    }
    rebased = true;
  }

  // Step 6 — push. No force: after the rebase our commits fast-forward the
  // remote head, so a sibling's commits can never be overwritten here.
  let pushArgs: string[];
  try {
    pushArgs = buildPushArgs("origin", branchName, { setUpstream: true });
  } catch (err) {
    return {
      ok: false,
      error: stepError(
        "push",
        err instanceof Error ? err.message : String(err),
      ),
    };
  }
  const push = await runGitCommand(pushArgs, options);
  if (!push.ok) {
    return { ok: false, error: stepError("push", push.error.message) };
  }
  if (push.value.code !== 0) {
    return {
      ok: false,
      error: stepError("push", `${push.value.stderr}${push.value.stdout}`),
    };
  }

  return {
    ok: true,
    value: {
      rebased,
      pushed: true,
      commitsReapplied: commitsAhead,
      detail: rebased
        ? `re-applied ${commitsAhead} commit(s) onto the moved head of ${remoteRef} and pushed`
        : `pushed ${commitsAhead} commit(s) — ${remoteRef} was already in our history`,
    },
  };
}
