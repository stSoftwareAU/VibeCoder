/**
 * Tell clone contention apart from a PR fault (Issue #394).
 *
 * Lanes on one host share a repository's refs — and, before per-lane
 * worktrees, its `HEAD`, index and working tree as well. When one lane moves
 * that state under another, git's own wording describes the *clone*, not the
 * pull request:
 *
 *   error: pathspec 'issue-373-…' did not match any file(s) known to git
 *
 * Reported as a branch-update failure that reads as "your branch is gone",
 * and sends an operator to GitHub to look for a branch sitting healthily on
 * origin — PR #392 was OPEN with its branch on origin while the pass said
 * exactly this. The same is true of the Issue #211 refusal: unpushed commits
 * another lane left in the clone say nothing about the PR.
 *
 * Contention is transient by construction: the other lane finishes, and the
 * next cycle's pass finds the clone as it expects. So it is named as
 * contention, counted apart from failures, and retried — never escalated as
 * a broken PR.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isLocalAheadOfRemoteError } from "./git_branch_sync.ts";

/** What the other lane was doing to the clone. */
export type CloneContentionKind =
  /** A ref resolved a moment ago and no longer does. */
  | "branch-vanished"
  /** Another worktree on this host has the branch checked out. */
  | "branch-held"
  /** Another lane holds git's index / ref lock in this clone. */
  | "clone-locked"
  /** Another lane left commits on the branch that origin has never seen. */
  | "unpushed-local-work";

/** A classified contention, with git's own words kept for the log. */
export interface CloneContention {
  kind: CloneContentionKind;
  /** The message the classification was taken from. */
  detail: string;
}

/** git's wording for a ref that is not in this clone. */
const BRANCH_VANISHED_RE =
  /did not match any file\(s\) known to git|pathspec '[^']*' did not match|unknown revision or path not in the working tree|bad object refs\/heads\//i;

/** git's wording for a branch another worktree holds. */
const BRANCH_HELD_RE =
  /is already checked out at|already used by worktree|is already used by worktree|cannot force update the branch|checked out at '[^']*'/i;

/** git's wording for a lock another process holds in this clone. */
const CLONE_LOCKED_RE =
  /index\.lock|shallow\.lock|unable to create '[^']*\.lock'|cannot lock ref|another git process seems to be running/i;

/** The Issue #211 refusal, matched by text for callers that lost the Error. */
const UNPUSHED_LOCAL_WORK_RE =
  /is ahead of the remote head by|holds \d+ commit\(s\) that origin\//i;

/** Read a message out of whatever the caller had. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Classify an error as clone contention, or `null` when it is a real fault.
 *
 * @param error - An `Error` or message from a git-backed operation
 * @returns The contention, or `null` when nothing about it says "the clone
 *   changed under us"
 */
export function classifyCloneContention(
  error: unknown,
): CloneContention | null {
  const detail = messageOf(error);
  if (detail.length === 0) return null;

  // The typed refusal first: it carries its own name, so it classifies even
  // if its wording is reworded later.
  if (isLocalAheadOfRemoteError(error) || UNPUSHED_LOCAL_WORK_RE.test(detail)) {
    return { kind: "unpushed-local-work", detail };
  }
  if (BRANCH_HELD_RE.test(detail)) return { kind: "branch-held", detail };
  if (CLONE_LOCKED_RE.test(detail)) return { kind: "clone-locked", detail };
  if (BRANCH_VANISHED_RE.test(detail)) {
    return { kind: "branch-vanished", detail };
  }
  return null;
}

/** What each kind means, in the operator's terms. */
const EXPLANATIONS: Record<CloneContentionKind, string> = {
  "branch-vanished":
    "the branch could not be resolved in this host's clone even though the " +
    "PR is open — another lane moved the clone under the operation",
  "branch-held":
    "another lane on this host has that branch checked out in this clone",
  "clone-locked": "another lane holds this clone's git lock",
  "unpushed-local-work":
    "another lane left commits on that branch in this host's clone that " +
    "origin has never seen",
};

/**
 * One sentence an operator can act on — or, better, safely ignore.
 *
 * Says what the clone did, states plainly that the PR is not at fault, and
 * says what happens next, so nobody goes looking on GitHub for a branch that
 * is sitting right there.
 *
 * @param contention - The classified contention
 * @returns The line to log
 */
export function describeCloneContention(contention: CloneContention): string {
  return `${EXPLANATIONS[contention.kind]} — the PR is not at fault, so it ` +
    `is left exactly as it is and retried next cycle (Issue #394). git said: ` +
    `${contention.detail}`;
}
