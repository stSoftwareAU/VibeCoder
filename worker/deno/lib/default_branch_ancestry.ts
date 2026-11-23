/**
 * How a commit stands against a repository's default branch (Issue #5437).
 *
 * A `sync/milestone-*` PR inherits whatever is red on the default branch, and
 * so does any PR whose head commit has already landed on it. Callers that
 * judge a PR's own checks need to tell those failures apart from the PR's.
 * This helper answers that question by asking GitHub to compare the default
 * branch with the commit.
 *
 * Australian English throughout.
 */

/**
 * `on-default`: the commit is the default branch's tip or an ancestor of it,
 * so the default branch already contains it.
 * `contains-default`: the commit has the whole default branch plus more.
 * `diverged`: the commit lacks some default-branch commits and has commits of
 * its own.
 * `unknown`: the answer cannot be decided (bad input, a failed `gh` call, or
 * an unrecognised status). Callers decide what that means for them.
 */
export type DefaultBranchAncestry =
  | "on-default"
  | "contains-default"
  | "diverged"
  | "unknown";

/** A commit SHA as GitHub prints it: 7 to 40 hexadecimal characters. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * How `sha` stands against `defaultBranch`.
 *
 * Calls `gh api repos/{repo}/compare/{defaultBranch}...{sha} --jq .status`.
 * GitHub reports `identical` or `behind` when the commit is on the default
 * branch (`on-default`), `ahead` when it contains the whole default branch
 * (`contains-default`), and `diverged` when it lacks some of it. Never throws.
 */
export async function commitAncestryOnDefault(
  repo: string,
  sha: string,
  defaultBranch: string,
  gh: (args: string[]) => Promise<string>,
): Promise<DefaultBranchAncestry> {
  if (!SHA_PATTERN.test(sha)) return "unknown";
  try {
    const status = (await gh([
      "api",
      `repos/${repo}/compare/${encodeURIComponent(defaultBranch)}...${sha}`,
      "--jq",
      ".status",
    ])).trim();
    if (status === "identical" || status === "behind") return "on-default";
    if (status === "ahead") return "contains-default";
    if (status === "diverged") return "diverged";
    return "unknown";
  } catch {
    return "unknown";
  }
}
