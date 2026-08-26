/**
 * Check a PR branch out at its *remote* head before maintenance (Issue #211).
 *
 * The branch-update pass shares its clone with every other pass. `git checkout
 * <branch>` therefore lands on whatever that clone's local branch happens to
 * hold — in NEAT-AI-core PR #557 that was the pre-sibling-push state, so the
 * test-merge of the base ran against a stale branch, reported a conflict the
 * remote PR did not have, and got the PR labelled `merge-conflict` while it
 * was perfectly mergeable.
 *
 * The remote head is the PR. This module makes the local branch match it
 * before anything is evaluated, and refuses loudly rather than silently
 * evaluating (or force-pushing) a local branch that carries commits the remote
 * has never seen.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import {
  assertSafeRefComponent,
  buildCheckoutResetBranchArgs,
  buildFetchTrackingRefArgs,
} from "./git_ref_args.ts";
import { LOCAL_AHEAD_OF_REMOTE_ERROR } from "./git_branch_sync.ts";

/** What the checkout had to do to put the local branch on the remote head. */
export type BranchAlignment =
  /** The local branch already pointed at the remote head. */
  | "already-at-remote"
  /** A stale local branch was reset onto the remote head. */
  | "reset-to-remote"
  /** No local branch existed; it was created from the remote head. */
  | "created-from-remote";

/** Read a ref's SHA, or null when the ref does not exist. */
async function readSha(
  ref: string,
  options: GitCommandOptions,
): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", ref],
    options,
  );
  if (!result.ok || result.value.code !== 0) return null;
  return result.value.stdout.trim() || null;
}

/**
 * Check out `branchName` positioned exactly at `origin/<branchName>`.
 *
 * Fetches the branch into its remote-tracking ref first — an explicit refspec,
 * so a single-branch clone gets the ref too — then:
 *
 * - no local branch → create it from the remote head;
 * - local branch holds nothing the remote lacks → hard-reset it onto the
 *   remote head (discards only work the remote already has);
 * - local branch holds commits the remote lacks → refuse, naming the count.
 *   Those commits are somebody's unpushed work: evaluating a merge against
 *   them invents conflicts, and force-pushing the result would publish them.
 *
 * @param branchName - The PR head branch
 * @param options - Git command options (cwd selects the repo)
 * @returns How the branch was aligned, or an error explaining the refusal
 */
export async function checkoutPrBranchAtRemoteHead(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<BranchAlignment>> {
  try {
    assertSafeRefComponent(branchName, "PR head branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  const trackingRef = `refs/remotes/origin/${branchName}`;
  await runGitCommand(buildFetchTrackingRefArgs("origin", branchName), options);

  const remoteSha = await readSha(trackingRef, options);
  if (remoteSha === null) {
    return {
      ok: false,
      error: new Error(
        `Branch '${branchName}' does not exist on origin — refusing to ` +
          `evaluate a PR branch that is only local (Issue #211)`,
      ),
    };
  }

  const localSha = await readSha(`refs/heads/${branchName}`, options);

  // What the local branch is, before anything is moved. The ahead-check has
  // to happen here — before the branch is touched — because it is the only
  // thing standing between somebody's unpushed work and a hard reset.
  let alignment: BranchAlignment;
  if (localSha === null) {
    alignment = "created-from-remote";
  } else if (localSha === remoteSha) {
    alignment = "already-at-remote";
  } else if (!(await isReadableCommit(localSha, options))) {
    // The ref resolves but names an object this clone does not have — the
    // `fatal: bad object` / `unable to read tree` shape (Issue #411). There
    // is no reachable work to protect, and the ref cannot be read, only
    // replaced. The remote head is the PR, so take it.
    alignment = "reset-to-remote";
  } else {
    const aheadResult = await runGitCommand(
      ["rev-list", "--count", `${trackingRef}..refs/heads/${branchName}`],
      options,
    );
    if (!aheadResult.ok || aheadResult.value.code !== 0) {
      const stderr = aheadResult.ok ? aheadResult.value.stderr.trim() : "";
      return {
        ok: false,
        error: new Error(
          `Could not compare '${branchName}' with its remote head: ` +
            `${
              stderr || (aheadResult.ok
                ? `exit ${aheadResult.value.code}`
                : aheadResult.error.message)
            }`,
        ),
      };
    }
    const ahead = Number.parseInt(aheadResult.value.stdout.trim(), 10);
    if (!Number.isFinite(ahead)) {
      return {
        ok: false,
        error: new Error(
          `Could not compare '${branchName}' with its remote head: git printed ` +
            `'${aheadResult.value.stdout.trim()}'`,
        ),
      };
    }
    if (ahead > 0) {
      // Named (Issue #394) so callers can tell this apart from a PR fault:
      // the commits belong to another lane sharing this clone, and the PR is
      // retried next cycle rather than counted as failed.
      const error = new Error(
        `Local branch '${branchName}' holds ${ahead} commit(s) that ` +
          `origin/${branchName} does not — refusing to evaluate or update a ` +
          `PR from a stale local branch (Issue #211). Push or discard them ` +
          `first.`,
      );
      error.name = LOCAL_AHEAD_OF_REMOTE_ERROR;
      return { ok: false, error };
    }
    alignment = "reset-to-remote";
  }

  // One mutating command for every case (Issue #411). `checkout -B` creates
  // the branch when it is absent, resets it when it is stale, and overwrites
  // it when it is corrupt — so the local ref is never *read* to get there.
  //
  // The old shape read the ref with `rev-parse` and then ran a separate
  // `git checkout <branch>`, which failed permanently on a ref that resolved
  // but could not be checked out, and left a window in which another lane
  // sharing the clone could delete the branch between the two commands:
  //
  //   Failed to checkout branch 'issue-387-side-data-…': error: pathspec
  //   'issue-387-side-data-…' did not match any file(s) known to git
  //
  // — while the branch sat healthy on origin the whole time. PR #408 failed
  // that way on three consecutive cycles.
  const aligned = await runGitCommand(
    buildCheckoutResetBranchArgs(branchName, trackingRef),
    options,
  );
  if (!aligned.ok || aligned.value.code !== 0) {
    const stderr = aligned.ok ? aligned.value.stderr.trim() : "";
    return {
      ok: false,
      error: new Error(
        `Failed to position '${branchName}' on its remote head: ` +
          `${
            stderr ||
            (aligned.ok ? `exit ${aligned.value.code}` : aligned.error.message)
          }`,
      ),
    };
  }
  return { ok: true, value: alignment };
}

/**
 * Is `sha` a commit this clone can actually read?
 *
 * A ref can resolve while the object it names is missing — the shape behind
 * `fatal: bad object` and `unable to read tree`. Such a branch has no
 * reachable work on it, so it is safe to overwrite; a readable one must go
 * through the ahead-check first.
 */
async function isReadableCommit(
  sha: string,
  options: GitCommandOptions,
): Promise<boolean> {
  const result = await runGitCommand(
    ["cat-file", "-e", `${sha}^{commit}`],
    options,
  );
  return result.ok && result.value.code === 0;
}
