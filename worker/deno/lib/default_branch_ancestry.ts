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

/**
 * The answer {@link commitAncestryOnDefault} gives. `cause` is set for every
 * `unknown` status: the `gh` error message, the unrecognised status text, or
 * the rejected input, so a caller's warning can name it.
 */
export interface DefaultBranchAncestryResult {
  status: DefaultBranchAncestry;
  cause?: string;
}

/** A commit SHA as GitHub prints it: 7 to 40 hexadecimal characters. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** A failure message, whatever the thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
): Promise<DefaultBranchAncestryResult> {
  if (!SHA_PATTERN.test(sha)) {
    return {
      status: "unknown",
      cause: `not a commit sha: ${JSON.stringify(sha)}`,
    };
  }
  try {
    const status = (await gh([
      "api",
      `repos/${repo}/compare/${encodeURIComponent(defaultBranch)}...${sha}`,
      "--jq",
      ".status",
    ])).trim();
    if (status === "identical" || status === "behind") {
      return { status: "on-default" };
    }
    if (status === "ahead") return { status: "contains-default" };
    if (status === "diverged") return { status: "diverged" };
    return {
      status: "unknown",
      cause: `unrecognised compare status ${JSON.stringify(status)}`,
    };
  } catch (error) {
    return { status: "unknown", cause: errorText(error) };
  }
}
