/**
 * Milestone sync-branch naming (Issue #589).
 *
 * A milestone sync lands the default branch's changes into a milestone branch
 * through a PR raised from a branch no ruleset covers. This module holds the
 * pure naming helpers — the branch prefix, the deterministic branch name, and
 * the "is this a sync branch" test — so callers that only need to recognise a
 * sync PR can import them without pulling in the sync-landing machinery (and
 * the dependency cycle that comes with it, Issue #3476).
 *
 * Australian English throughout.
 */

/** Prefix for the branch a sync PR is raised from. No ruleset covers it. */
export const SYNC_BRANCH_PREFIX = "sync/milestone";

/**
 * The branch a sync PR is raised from, for a given milestone branch.
 *
 * Deterministic, so a second run finds the branch the first one pushed and
 * updates it rather than opening a second PR for the same sync.
 */
export function syncBranchFor(milestoneBranch: string): string {
  const leaf = milestoneBranch.replace(/^milestone\//, "").replace(
    /[^A-Za-z0-9._-]+/g,
    "-",
  );
  return `${SYNC_BRANCH_PREFIX}-${leaf}`;
}

/** Whether a PR head branch is one this module raised. */
export function isMilestoneSyncBranch(headRefName?: string | null): boolean {
  return typeof headRefName === "string" &&
    headRefName.startsWith(`${SYNC_BRANCH_PREFIX}-`);
}
