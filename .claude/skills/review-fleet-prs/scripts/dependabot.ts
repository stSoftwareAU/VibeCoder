// Dependabot upkeep for /review-fleet-prs.
//
// The fleet looks after its own PRs, but nothing looks after Dependabot's:
// a green, approved bump sat unmerged because it fell behind the default
// branch and no one armed auto-merge. Every gate pass therefore does two
// cheap, deterministic things for each open Dependabot PR into a default
// branch, with no model involved:
//
//   - behind and approved at its head: branch_update.ts merges in the base
//     once per head with expected_head_sha; conflicting PRs wait on Dependabot
//     with no push or comment, and unapproved PRs get their review first;
//   - approved by the reviewer and not yet armed: arm auto-merge, so it
//     merges as soon as every required check passes.
//
// The Fable review still decides whether a Dependabot PR is approved.

import type { SearchPr } from "./gate.ts";
import { sameLogin } from "./review_log.ts";

export type DependabotAction =
  | { kind: "auto-merge"; method: "squash" | "merge" | "rebase" }
  | { kind: "none"; reason: string };

// Decides whether to arm auto-merge. Branch updates share the fleet path.
export function dependabotAction(
  pr: SearchPr,
  reviewer: string,
): DependabotAction {
  if (pr.isDraft) return { kind: "none", reason: "draft" };
  if (pr.mergeable === "CONFLICTING") {
    return { kind: "none", reason: "conflicting, waiting on Dependabot" };
  }
  if (pr.mergeStateStatus === "BEHIND") {
    return { kind: "none", reason: "branch update follows approval" };
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
