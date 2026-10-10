/**
 * Pure milestone branch-name predicates (Issue #3433).
 *
 * This is a leaf module and must import nothing. It is loaded by the `gh`
 * chokepoint (`gh_spawn.ts`) and by the agent's permissionless gh-guard child
 * through `pr_base_change_guard.ts`. Importing `milestone_children_gate.ts` or
 * `milestone_fix_pr.ts` there would cycle back into `gh_spawn.ts` and pull
 * heavy dependencies into the guard child. Those modules re-export these names.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/** Branch prefix shared by every milestone branch. */
const MILESTONE_BRANCH_PREFIX = "milestone/";

/** Prefix for the branch a milestone fix PR is raised from. */
export const MILESTONE_FIX_BRANCH_PREFIX = "milestone-fix";

/** Return true when `branch` is a milestone branch. */
export function isMilestoneBranch(branch: string): boolean {
  return branch.startsWith(MILESTONE_BRANCH_PREFIX) &&
    branch.length > MILESTONE_BRANCH_PREFIX.length;
}

/** Sanitise a path segment to the character set a git ref allows. */
export function sanitiseSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Whether a PR head branch is a milestone fix branch. */
export function isMilestoneFixBranch(head: string): boolean {
  return head.startsWith(`${MILESTONE_FIX_BRANCH_PREFIX}/`);
}

/**
 * The head prefix every fix branch for this milestone PR shares:
 * `milestone-fix/<leaf>/pr-<N>-`.
 *
 * Used both to build a fresh branch name and to recognise an already-open
 * fix PR raised by an earlier pass, regardless of that pass's discriminator.
 */
export function milestoneFixPrefixFor(
  milestoneBranch: string,
  prNumber: number,
): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(
      `milestoneFixPrefixFor: prNumber must be a positive integer, got ${prNumber}`,
    );
  }
  const leaf = sanitiseSegment(milestoneBranch.replace(/^milestone\//, ""));
  if (!leaf) {
    throw new Error(
      `milestoneFixPrefixFor: milestoneBranch '${milestoneBranch}' sanitised to an empty leaf`,
    );
  }
  return `${MILESTONE_FIX_BRANCH_PREFIX}/${leaf}/pr-${prNumber}-`;
}
