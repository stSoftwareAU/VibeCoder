/**
 * Test fixture (Issue #4396): the gh answers `verifyMergeLanded` needs to
 * report a merged PR as LANDED on the default branch, for tests whose
 * subject is what happens after a merge (issue closing, sweeps) rather
 * than the landing check itself — that has its own tests.
 */

/** A merged PR whose merge commit sits on the default branch. */
export const MERGED_PR_VIEW = {
  state: "MERGED",
  mergeCommit: { oid: "abc123" },
  baseRefName: "Develop",
};

/**
 * Answer the landing-check calls, or return null when `args` is not one of
 * them (so the caller's own stub takes over).
 */
export function answerLandingCalls(args: string[]): string | null {
  const key = args.join(" ");
  if (key.includes(".default_branch")) return "Develop\n";
  if (key.includes("/compare/")) return JSON.stringify({ status: "behind" });
  return null;
}

/** A `verifyMergeLandedFn` that always says landed. */
export const alwaysLanded = () =>
  Promise.resolve({
    landed: true as const,
    via: "default-branch" as const,
    mergeCommit: "abc123",
    baseRefName: "Develop",
  });
