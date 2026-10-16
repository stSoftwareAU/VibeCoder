// Bringing an approved fleet PR's branch up to date (Issue #3225).
//
// Every fleet PR is armed with auto-merge on three conditions: CI green,
// approved, and branch up to date. The review comes first, so the approval
// is of the diff as reviewed; this module then asks GitHub to merge the base
// into the PR (the `update-branch` endpoint, as the worker's own merge path
// does), so the third condition clears and the PR merges once CI re-runs.
// The same update applies to Dependabot PRs (Issue #3663), since the reviewer
// App's `@dependabot rebase` is refused.

export type RunGh = (args: string[]) => Promise<string>;

interface ReviewLike {
  state: string;
  commit: { oid: string } | null;
}

/** Whether anyone approved this PR at its current head commit. */
export function approvedAtHead(
  reviews: readonly ReviewLike[],
  headSha: string,
): boolean {
  return reviews.some((r) =>
    r.state === "APPROVED" && r.commit?.oid === headSha
  );
}

export interface BranchStateLike {
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus?: string;
  headRefOid: string;
  reviews: { nodes: readonly ReviewLike[] };
}

// Whether the gate should ask for an update this pass: a fleet or Dependabot
// PR, approved at its head, behind its base, not a draft or conflicting, and
// not already asked at this head (`askedFor` is the head an update was last
// requested for, so GitHub is not asked again while CI runs on the merge
// commit).
export function needsBranchUpdate(
  pr: BranchStateLike,
  askedFor: string | undefined,
): boolean {
  return !pr.isDraft && pr.mergeable !== "CONFLICTING" &&
    pr.mergeStateStatus === "BEHIND" &&
    approvedAtHead(pr.reviews.nodes, pr.headRefOid) &&
    askedFor !== pr.headRefOid;
}

export type BranchUpdateResult =
  | { updated: true }
  | { updated: false; error: string };

// Asks GitHub to merge the base branch into the PR. `expected_head_sha`
// makes GitHub refuse (HTTP 422) when the fleet pushed meanwhile, so the
// update never lands on a head the review did not see. A refusal is
// reported, never thrown: one stuck PR must not stop a pass or a post.
export async function updateBranch(
  pr: { repo: string; number: number; headSha: string },
  runGh: RunGh,
): Promise<BranchUpdateResult> {
  try {
    await runGh([
      "api",
      "--method",
      "PUT",
      `repos/${pr.repo}/pulls/${pr.number}/update-branch`,
      "-f",
      `expected_head_sha=${pr.headSha}`,
    ]);
    return { updated: true };
  } catch (e) {
    return { updated: false, error: (e as Error).message.split("\n")[0]! };
  }
}
