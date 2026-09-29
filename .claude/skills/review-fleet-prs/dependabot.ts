// Dependabot upkeep for /review-fleet-prs.
//
// The fleet looks after its own PRs, but nothing looks after Dependabot's:
// a green, approved bump sat unmerged because it fell behind the default
// branch and no one armed auto-merge. Every gate pass therefore does two
// cheap, deterministic things for each open Dependabot PR into a default
// branch, with no model involved:
//
//   - behind or conflicting: ask Dependabot to rebase it (once per head
//     commit), so the branch is brought up to date and conflicts resolved by
//     Dependabot itself; pushing to its branch would stop it updating the PR;
//   - approved by the reviewer and not yet armed: arm auto-merge, so it
//     merges as soon as every required check passes.
//
// The Fable review still decides whether a Dependabot PR is approved.

import type { SearchPr } from "./gate.ts";
import { sameLogin } from "./review_log.ts";

export type DependabotAction =
  | { kind: "rebase" }
  | { kind: "auto-merge"; method: "squash" | "merge" | "rebase" }
  | { kind: "none"; reason: string };

// Decides the one action a Dependabot PR needs this pass. `rebaseAskedFor`
// is the head commit a rebase was last requested for, so the request is not
// repeated while Dependabot works on it.
export function dependabotAction(
  pr: SearchPr,
  reviewer: string,
  rebaseAskedFor: string | undefined,
): DependabotAction {
  if (pr.isDraft) return { kind: "none", reason: "draft" };
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "BEHIND") {
    return rebaseAskedFor === pr.headRefOid
      ? { kind: "none", reason: "rebase already requested" }
      : { kind: "rebase" };
  }
  if (pr.autoMergeRequest) return { kind: "none", reason: "auto-merge armed" };
  const approvedByReviewer = pr.reviews.nodes.some((r) =>
    sameLogin(r.author?.login, reviewer) && r.state === "APPROVED" &&
    r.commit?.oid === pr.headRefOid
  );
  if (!approvedByReviewer) return { kind: "none", reason: "not approved" };
  const repo = pr.repository;
  if (repo.autoMergeAllowed === false) {
    return { kind: "none", reason: "repo does not allow auto-merge" };
  }
  const method = repo.squashMergeAllowed !== false
    ? "squash"
    : repo.mergeCommitAllowed !== false
    ? "merge"
    : "rebase";
  return { kind: "auto-merge", method };
}
