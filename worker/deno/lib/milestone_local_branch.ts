/**
 * Local state of a milestone branch name (Issue #1345).
 *
 * A milestone branch is created on origin by pushing the default branch ref
 * straight to the milestone ref name, so no local checkout takes part in the
 * creation and none can block it. Whatever local branch of the same name is
 * lying around is left exactly as it is — but it is not left silent: the
 * stale checkout that used to wedge the run is named in one log line so an
 * operator can find it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { parseWorktreeList } from "./worktree_cleanup.ts";

/** A local branch sharing the milestone branch's name. */
export interface LocalMilestoneBranch {
  /** The branch name. */
  branch: string;
  /** The local tip the branch points at. */
  sha: string;
  /**
   * Absolute path of the worktree holding the branch checked out, or null
   * when the branch is only a ref. A checked-out branch is the state that
   * refused `git checkout -B` and escalated the run to a human.
   */
  worktree: string | null;
}

/**
 * Find the worktree that holds `branch` checked out.
 *
 * @param worktreeListOutput - Raw `git worktree list --porcelain` output.
 * @param branch - The branch name (without the `refs/heads/` prefix).
 * @returns The worktree path, or null when no worktree holds the branch.
 */
export function findWorktreeHoldingBranch(
  worktreeListOutput: string,
  branch: string,
): string | null {
  const ref = `refs/heads/${branch}`;
  for (const entry of parseWorktreeList(worktreeListOutput)) {
    if (entry.branch === ref) {
      return entry.path;
    }
  }
  return null;
}

/**
 * Inspect the local ref (if any) sharing the milestone branch's name.
 *
 * Read-only: nothing is deleted, reset, or checked out. Returns null when no
 * local branch of that name exists, or when git could not be asked.
 */
export async function inspectLocalMilestoneBranch(
  branch: string,
  options: GitCommandOptions = {},
): Promise<LocalMilestoneBranch | null> {
  const revParse = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    options,
  );
  if (!revParse.ok || revParse.value.code !== 0) {
    return null;
  }
  const sha = revParse.value.stdout.trim();
  if (sha === "") {
    return null;
  }

  const worktrees = await runGitCommand(
    ["worktree", "list", "--porcelain"],
    options,
  );
  const worktree = worktrees.ok && worktrees.value.code === 0
    ? findWorktreeHoldingBranch(worktrees.value.stdout, branch)
    : null;

  return { branch, sha, worktree };
}

/**
 * The one line naming a local branch left untouched by the creation.
 *
 * @param local - The local branch found by {@link inspectLocalMilestoneBranch}.
 * @param sourceRef - The ref pushed to create the milestone branch on origin.
 */
export function describeLocalMilestoneBranch(
  local: LocalMilestoneBranch,
  sourceRef: string,
): string {
  const where = local.worktree === null
    ? "not checked out"
    : `checked out at ${local.worktree}`;
  return `Local branch '${local.branch}' (${
    local.sha.slice(0, 8)
  }, ${where}) ` +
    `was left untouched — '${local.branch}' was created on origin by pushing ` +
    `'${sourceRef}' directly, which needs no local checkout (Issue #1345)`;
}
