// Bringing an approved fleet or Dependabot PR up to date (Issues #3225, #3663).
//
// Every fleet PR is armed with auto-merge on three conditions: CI green,
// approved, and branch up to date. The review comes first, so the approval
// is of the diff as reviewed; this module then asks GitHub to merge the base
// into the PR (the `update-branch` endpoint, as the worker's own merge path
// does), so the third condition clears and the PR merges once CI re-runs.
// Dependabot uses this same leased update after the reviewer's approval;
// conflicting branches wait without a push or a bot-command comment.

import { prKey, sameLogin } from "./review_log.ts";
import {
  FileLockTimeoutError,
  withFileLock,
} from "../../../../worker/deno/lib/file_lock.ts";
import {
  BRANCH_UPDATE_FILE,
  FAILED_FILE,
  readMemory,
  writeMemory,
} from "./upkeep_memory.ts";

export type RunGh = (args: string[]) => Promise<string>;

interface ReviewLike {
  author?: { login: string } | null;
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

// Whether the gate should ask for an update this pass: an eligible PR, approved
// at its head, behind its base, not a draft or conflicting, and not already
// asked at this head (`askedFor` is the head an update was last requested
// for, so GitHub is not asked again while CI runs on the merge commit).
// A Dependabot approval must be from `reviewer`; fleet approvals may be by hand.
export function needsBranchUpdate(
  pr: BranchStateLike,
  kind: "dependabot" | "fleet",
  askedFor: string | undefined,
  reviewer = "",
): boolean {
  const reviews = kind === "dependabot"
    ? pr.reviews.nodes.filter((r) => sameLogin(r.author?.login, reviewer))
    : pr.reviews.nodes;
  return !pr.isDraft && pr.mergeable !== "CONFLICTING" &&
    pr.mergeStateStatus === "BEHIND" &&
    approvedAtHead(reviews, pr.headRefOid) &&
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

// Gate and parallel post processes share one request lease per PR. Re-read
// after taking the lock, and persist only this action's entry; another PR
// can finish its API call in parallel without losing either cached head.
export async function updateBranchOnce(
  pr: { repo: string; number: number; headSha: string },
  dir: string,
  runGh: RunGh,
): Promise<BranchUpdateResult | undefined> {
  await Deno.mkdir(dir, { recursive: true });
  const key = prKey(pr.repo, pr.number);
  let acquired = false;
  try {
    return await withFileLock(
      `${dir}/branch-update-${encodeURIComponent(key)}.lock`,
      async () => {
        acquired = true;
        const updateAsked = await readMemory(dir, BRANCH_UPDATE_FILE);
        const failed = await readMemory(dir, FAILED_FILE);
        if (
          updateAsked[key] === pr.headSha ||
          failed[`${key} branch-update`] === pr.headSha
        ) return undefined;
        const result = await updateBranch(pr, runGh);
        if (result.updated) {
          await writeMemory(dir, BRANCH_UPDATE_FILE, { [key]: pr.headSha });
        } else {
          await writeMemory(dir, FAILED_FILE, {
            [`${key} branch-update`]: pr.headSha,
          });
        }
        return result;
      },
    );
  } catch (error) {
    // Another review may still own this PR's update. Report the contention
    // without marking an API request that was never sent as failed. A
    // persistence failure after acquiring the PR lock must still fail loud.
    if (error instanceof FileLockTimeoutError && !acquired) {
      return { updated: false, error: error.message };
    }
    throw error;
  }
}
