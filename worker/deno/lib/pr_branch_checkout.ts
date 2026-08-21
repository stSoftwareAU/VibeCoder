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
  buildCheckoutNewBranchArgs,
  buildFetchTrackingRefArgs,
} from "./git_ref_args.ts";
import { buildCheckoutArgs } from "./git_ref_args.ts";

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

  if (localSha === null) {
    const created = await runGitCommand(
      buildCheckoutNewBranchArgs(branchName, trackingRef),
      options,
    );
    if (!created.ok || created.value.code !== 0) {
      const stderr = created.ok ? created.value.stderr.trim() : "";
      return {
        ok: false,
        error: new Error(
          `Failed to create branch '${branchName}' from its remote head: ` +
            `${stderr || (created.ok ? `exit ${created.value.code}` : created.error.message)}`,
        ),
      };
    }
    return { ok: true, value: "created-from-remote" };
  }

  const checkedOut = await runGitCommand(buildCheckoutArgs(branchName), options);
  if (!checkedOut.ok || checkedOut.value.code !== 0) {
    const stderr = checkedOut.ok ? checkedOut.value.stderr.trim() : "";
    return {
      ok: false,
      error: new Error(
        `Failed to checkout branch '${branchName}': ` +
          `${stderr || (checkedOut.ok ? `exit ${checkedOut.value.code}` : checkedOut.error.message)}`,
      ),
    };
  }

  if (localSha === remoteSha) {
    return { ok: true, value: "already-at-remote" };
  }

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
          `${stderr || (aheadResult.ok ? `exit ${aheadResult.value.code}` : aheadResult.error.message)}`,
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
    return {
      ok: false,
      error: new Error(
        `Local branch '${branchName}' holds ${ahead} commit(s) that ` +
          `origin/${branchName} does not — refusing to evaluate or update a ` +
          `PR from a stale local branch (Issue #211). Push or discard them ` +
          `first.`,
      ),
    };
  }

  const reset = await runGitCommand(
    ["reset", "--hard", trackingRef],
    options,
  );
  if (!reset.ok || reset.value.code !== 0) {
    const stderr = reset.ok ? reset.value.stderr.trim() : "";
    return {
      ok: false,
      error: new Error(
        `Failed to reset '${branchName}' onto its remote head: ` +
          `${stderr || (reset.ok ? `exit ${reset.value.code}` : reset.error.message)}`,
      ),
    };
  }
  return { ok: true, value: "reset-to-remote" };
}
