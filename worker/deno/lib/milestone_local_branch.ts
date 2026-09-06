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
 * A git command that could not be RUN is reported as unknown, never as
 * "no local branch" or "not checked out": absence of a failure is not a
 * clean answer, and the reassuring answer is the one that hid this fault.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { parseWorktreeList } from "./worktree_cleanup.ts";

/** What the local ref store says about the milestone branch's name. */
export type LocalMilestoneBranchReport =
  /** No local branch of that name — git said so. */
  | { kind: "absent" }
  /** A local branch exists; `location` describes where it is checked out. */
  | { kind: "present"; sha: string; location: string }
  /** Git could not be asked — say so rather than assume "absent". */
  | { kind: "unknown"; detail: string };

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
 * Read-only: nothing is deleted, reset, or checked out.
 */
export async function inspectLocalMilestoneBranch(
  branch: string,
  options: GitCommandOptions = {},
): Promise<LocalMilestoneBranchReport> {
  const revParseArgs = [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ];
  const revParse = await runGitCommand(revParseArgs, options);
  if (!revParse.ok) {
    return { kind: "unknown", detail: revParse.error.message };
  }
  if (revParse.value.code !== 0) {
    // `--verify --quiet` exits 1 for a ref that does not exist; anything
    // else is git failing to answer, which is not the same thing.
    return revParse.value.code === 1 ? { kind: "absent" } : {
      kind: "unknown",
      detail: `git rev-parse exited ${revParse.value.code}: ` +
        (revParse.value.stderr.trim() || "(no output)"),
    };
  }
  const sha = revParse.value.stdout.trim();
  if (sha === "") {
    return { kind: "absent" };
  }

  const worktrees = await runGitCommand(
    ["worktree", "list", "--porcelain"],
    options,
  );
  if (!worktrees.ok || worktrees.value.code !== 0) {
    const detail = worktrees.ok
      ? worktrees.value.stderr.trim() || `exit ${worktrees.value.code}`
      : worktrees.error.message;
    return {
      kind: "present",
      sha,
      location:
        `checkout location unknown — git worktree list failed: ${detail}`,
    };
  }
  const worktree = findWorktreeHoldingBranch(worktrees.value.stdout, branch);
  return {
    kind: "present",
    sha,
    location: worktree === null
      ? "not checked out"
      : `checked out at ${worktree}`,
  };
}

/**
 * The one line naming local state the creation left untouched.
 *
 * @param branch - The milestone branch name.
 * @param report - What {@link inspectLocalMilestoneBranch} found.
 * @param sourceRef - The ref pushed to create the branch on origin.
 * @returns The line to log, or null when there is nothing to report.
 */
export function describeLocalMilestoneBranch(
  branch: string,
  report: LocalMilestoneBranchReport,
  sourceRef: string,
): string | null {
  if (report.kind === "absent") {
    return null;
  }
  if (report.kind === "unknown") {
    return `Could not inspect the local ref '${branch}' after creating it on ` +
      `origin from '${sourceRef}' — nothing local was touched either way: ` +
      report.detail;
  }
  return `Local branch '${branch}' (${report.sha.slice(0, 8)}, ` +
    `${report.location}) was left untouched — '${branch}' was created on ` +
    `origin by pushing '${sourceRef}' directly, which needs no local ` +
    `checkout (Issue #1345)`;
}
