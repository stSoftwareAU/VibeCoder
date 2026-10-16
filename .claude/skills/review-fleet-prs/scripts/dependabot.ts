// Dependabot upkeep for /review-fleet-prs.
//
// The fleet looks after its own PRs, but nothing looks after Dependabot's:
// a green, approved bump sat unmerged because it fell behind the default
// branch and no one armed auto-merge. Every gate pass therefore does cheap,
// deterministic things for each open Dependabot PR into a default branch,
// with no model involved. The App cannot command Dependabot (it only obeys
// users with push access, and refused the reviewer App's `@dependabot rebase`
// on PR #3639), so the gate never comments on a Dependabot PR:
//
//   - behind and approved at its head (by any host or by hand):
//     branch_update.ts brings it up to date, the same update-branch path fleet
//     PRs use (Issue #3663). Dependabot stops rebasing a PR someone else has
//     committed to, which is harmless because auto-merge lands it next;
//   - conflicting: no comment and no push. Dependabot rebases a conflicting
//     PR itself, and the gate reports it as waiting on Dependabot;
//   - approved by the reviewer and not yet armed: arm auto-merge, so it merges
//     as soon as every required check passes. This comes first, because the
//     update makes a new merge commit that the approval does not cover, and
//     post.ts does the same when it updates a Dependabot PR it just approved.
//
// The Fable review still decides whether a Dependabot PR is approved.

import type { SearchPr } from "./gate.ts";
import { sameLogin } from "./review_log.ts";

export type MergeMethod = "squash" | "merge" | "rebase";

export type DependabotAction =
  | { kind: "conflicting" }
  | { kind: "auto-merge"; method: MergeMethod }
  | { kind: "none"; reason: string };

// The method auto-merge is armed with: squash where the repo allows it.
export function autoMergeMethod(
  repo: { squashMergeAllowed?: boolean; mergeCommitAllowed?: boolean },
): MergeMethod {
  return repo.squashMergeAllowed !== false
    ? "squash"
    : repo.mergeCommitAllowed !== false
    ? "merge"
    : "rebase";
}

// Arms auto-merge on a PR; throws the gh error when GitHub refuses.
export async function armAutoMerge(
  pr: { repo: string; number: number },
  method: MergeMethod,
  runGh: (args: string[]) => Promise<string>,
): Promise<void> {
  await runGh([
    "pr",
    "merge",
    String(pr.number),
    "-R",
    pr.repo,
    "--auto",
    `--${method}`,
  ]);
}

// Decides the one action a Dependabot PR needs this pass.
export function dependabotAction(
  pr: SearchPr,
  reviewer: string,
): DependabotAction {
  if (pr.isDraft) return { kind: "none", reason: "draft" };
  if (pr.mergeable === "CONFLICTING") return { kind: "conflicting" };
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
  return { kind: "auto-merge", method: autoMergeMethod(repo) };
}
