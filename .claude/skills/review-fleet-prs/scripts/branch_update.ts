// Bringing an approved fleet or Dependabot PR up to date (Issues #3225, #3663).
//
// On a strict, non-queue base, the shared policy refreshes an approved, armed
// PR only after its current-head required checks pass. The review comes first,
// so the approval is of the diff as reviewed; the branch update then reruns CI
// against the current base. Other bases keep their existing update path, while
// conflicting branches wait without a push or a bot-command comment.

import { loadConfig } from "../../../../worker/deno/lib/config.ts";
import {
  type AlertDedupAuthorOptions,
  resolveAlertDedupAuthors,
} from "../../../../worker/deno/lib/alert_dedup_authors.ts";
import { prKey, sameLogin } from "./review_log.ts";
import {
  FileLockTimeoutError,
  withFileLock,
} from "../../../../worker/deno/lib/file_lock.ts";
import { requestReadyBranchUpdate } from "../../../../worker/deno/lib/required_branch_checks_4613.ts";
import { recordMutation } from "../../../../worker/deno/lib/audit_journal.ts";
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

export interface BranchUpdateAudit {
  auditDir: string;
  runId: string;
}

// Asks GitHub to merge the base branch into the PR. `expected_head_sha`
// makes GitHub refuse (HTTP 422) when the fleet pushed meanwhile, so the
// update never lands on a head the review did not see. A refusal is
// reported, never thrown: one stuck PR must not stop a pass or a post.
export async function updateBranch(
  pr: { repo: string; number: number; headSha: string; baseRefName: string },
  runGh: RunGh,
  authorOptions: AlertDedupAuthorOptions | undefined,
  reviewer: string | undefined,
  audit: BranchUpdateAudit,
): Promise<BranchUpdateResult> {
  const options = authorOptions ?? {
    env: () => undefined,
    loadConfigFn: () =>
      loadConfig(
        Deno.args.find((arg) => arg.startsWith("--config="))?.slice(9) ??
          new URL("../../../../.config.json", import.meta.url).pathname,
        { env: () => undefined },
      ),
  };
  if (reviewer !== undefined) {
    const authors = await resolveAlertDedupAuthors(options, console.error);
    if (!authors.some((author) => sameLogin(author, reviewer))) {
      return {
        updated: false,
        error:
          `Reviewer ${reviewer} must be in service_accounts or fleet_pr_authors on every fleet host`,
      };
    }
  }
  const auditedGh: RunGh = async (args) => {
    const targetIndex = args.findIndex((arg) =>
      /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/update-branch$/.test(arg)
    );
    const isUpdate = args[0] === "api" && args.includes("PUT") &&
      targetIndex >= 0;
    if (!isUpdate) return await runGh(args);

    const target = args[targetIndex]!;
    const match = /^repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pulls\/([1-9]\d*)\/update-branch$/.exec(target)!;
    const timestamp = new Date().toISOString();
    let outcome: "success" | "error" = "error";
    try {
      const result = await runGh(args);
      outcome = "success";
      return result;
    } finally {
      const recorded = await recordMutation({
        actionId: crypto.randomUUID(),
        runId: audit.runId,
        component: "reviewer",
        actionKind: "branch-update",
        caller: "review-fleet-prs/scripts/branch_update.ts",
        repo: match[1],
        prNumber: Number(match[2]),
        headSha: pr.headSha,
        verb: "api-put",
        target,
        outcome,
        timestamp,
      }, {
        baseDir: audit.auditDir,
        workerId: "fleet-reviewer",
        date: timestamp.slice(0, 10),
        env: () => undefined,
      });
      if (!recorded.ok) {
        console.error(
          `[SECURITY] [AUDIT_JOURNAL_REFUSED] branch update: ${recorded.error.message}`,
        );
      }
    }
  };
  const result = await requestReadyBranchUpdate(
    pr.repo,
    pr.number,
    auditedGh,
    pr.baseRefName,
    pr.headSha,
    undefined,
    options,
  );
  return result.ok
    ? { updated: true }
    : { updated: false, error: result.error.message.split("\n")[0]! };
}

// Gate and parallel post processes share one request lease per PR. Re-read
// after taking the lock, and persist only this action's entry; another PR
// can finish its API call in parallel without losing either cached head.
export async function updateBranchOnce(
  pr: { repo: string; number: number; headSha: string; baseRefName: string },
  dir: string,
  runGh: RunGh,
  authorOptions: AlertDedupAuthorOptions | undefined,
  reviewer: string | undefined,
  audit: BranchUpdateAudit,
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
        const result = await updateBranch(
          pr,
          runGh,
          authorOptions,
          reviewer,
          audit,
        );
        if (result.updated) {
          await writeMemory(dir, BRANCH_UPDATE_FILE, { [key]: pr.headSha });
        } else {
          if (
            [
              "must be in service_accounts or fleet_pr_authors",
              "merge-queue base is exempt",
              "base does not require strict up-to-date checks",
              "base refresh owned by",
              "PR base or head changed before branch update",
              "PR no longer ready for a branch update",
              "PR changed while its required checks were read",
              "PR test merge changed while required checks were read",
              "required current-head checks have not passed",
              "required-check read failed:",
              "test merge or required checks changed before branch update",
            ].some((marker) => result.error.includes(marker))
          ) {
            console.warn(`${key} branch refresh skipped: ${result.error}`);
            return undefined;
          }
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
