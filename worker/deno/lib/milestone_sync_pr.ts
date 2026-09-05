/**
 * Landing a milestone-branch sync through a pull request (Issue #589).
 *
 * `syncMilestoneBranchWithDefault` merges the default branch into each
 * milestone branch and pushes the result. That worked while milestone
 * branches were unprotected. Once `milestone/**` is gated by a
 * required-status-checks ruleset — which is what makes a milestone PR
 * auto-mergeable at all (Issue #586) — the push is rejected, measured as the
 * service account itself:
 *
 *     remote: - 2 of 2 required status checks are expected.
 *     ! [remote rejected] milestone/… (push declined due to repository rule violations)
 *
 * `required_status_checks` blocks a direct push even with no `pull_request`
 * rule, because the pushed merge commit has no checks yet: checks run *after*
 * a push. And the operator's policy is that the service account must NOT
 * bypass the gate — an admin may, the fleet may not. So the ruleset is right
 * and the sync is what has to change.
 *
 * The sync therefore lands the same merge through the same door as everything
 * else: a branch the ruleset does not cover, a PR into the milestone branch,
 * and auto-merge. The gate that broke the push is precisely what lets the PR
 * land unattended — GitHub arms auto-merge only when something blocks the
 * merge.
 *
 * Nothing here fires unless a push is actually rejected. A repository with
 * unprotected milestone branches keeps the direct push it has always had.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import type { Result } from "../types.ts";

/** Prefix for the branch a sync PR is raised from. No ruleset covers it. */
export const SYNC_BRANCH_PREFIX = "sync/milestone";

/**
 * Whether a push failed because a repository rule refused it.
 *
 * Distinguished from every other push failure — a race, a network fault, a
 * missing remote — because only this one is answered by raising a PR. Anything
 * else must keep failing as it always did.
 */
export function isRuleViolationPush(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("repository rule violations") ||
    text.includes("push declined") ||
    text.includes("protected branch") ||
    text.includes("required status checks are expected");
}

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

/**
 * The `gh pr merge` method for a PR from this head branch (Issue #1048).
 *
 * Everything else squashes, and should: one commit per change keeps the
 * default branch readable. A **milestone sync is the exception**, because its
 * whole purpose is ancestry. Squashed, the sync commit carries the default
 * branch's content with a single parent, so the default branch is not an
 * ancestor of the milestone branch: every later merge computes its base from
 * before the sync, and a file the default branch deleted in the meantime comes
 * back as a modify/delete conflict rather than as a deletion. That is exactly
 * how `milestone/863` revived a deleted subsystem.
 *
 * A merge commit records the default branch as a parent, so its deletions are
 * genuinely in the branch's history and never have to be re-derived.
 */
export function mergeMethodFlagForHead(
  headRefName?: string | null,
  headIsSameRepository: boolean = true,
): "--merge" | "--squash" {
  // A head branch *name* is chosen by whoever pushed the branch, and a fork
  // PR's head lives in a repository the fleet does not control — so on a fork
  // the name is a claim, not evidence (Issue #1249, finding 10). Only a
  // same-repository head, which needed write access to create, can select the
  // merge-commit deviation; everything else squashes, which is the default
  // this repository's policy expects.
  return isMilestoneSyncBranch(headRefName) && headIsSameRepository
    ? "--merge"
    : "--squash";
}

/**
 * Whether GitHub refused a merge because the repository does not permit merge
 * commits (`allow_merge_commit: false`, or a ruleset whose
 * `allowed_merge_methods` omits `merge`).
 *
 * This is the one refusal the sync answers by changing method rather than by
 * retrying: no number of retries turns a repository setting on.
 */
export function isMergeCommitNotAllowed(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes("merge commits are not allowed") ||
    text.includes("merge commit is not allowed") ||
    (text.includes("merge method") && text.includes("not allowed")) ||
    text.includes("not allowed for this repository");
}

/**
 * The warning a squashed sync earns, naming the repository setting to change.
 *
 * A squashed sync is a real fault — it leaves the default branch outside the
 * milestone branch's ancestry — so it is never silent. It is not fatal either:
 * the `check-resurrected-files` gate on every milestone PR catches the
 * consequence, and a sync that refused to land would leave the branch drifting
 * instead.
 */
export function squashedSyncWarning(
  repo: string,
  milestoneBranch: string,
  detail: string,
): string {
  return `WARNING: the sync PR for '${milestoneBranch}' in ${repo} had to be ` +
    `armed as a SQUASH — ${repo} does not permit merge commits (${detail}). ` +
    `The default branch will not be an ancestor of '${milestoneBranch}', so ` +
    `its deletions can return as modify/delete conflicts. Enable merge ` +
    `commits on ${repo} (Settings → Pull Requests → Allow merge commits) to ` +
    `close this off; until then the check-resurrected-files gate is what ` +
    `catches the consequence (Issue #1048).`;
}

/** Injected seams so the whole path is testable without git or GitHub. */
export interface MilestoneSyncPrDeps {
  /** Runs git in the clone; resolves with the exit code and stderr. */
  git: (args: string[]) => Promise<{ code: number; stderr: string }>;
  /** Runs `gh`, returning stdout; throws on failure. */
  gh: (args: string[]) => Promise<string>;
  log?: (message: string) => void;
}

/** What {@link raiseMilestoneSyncPr} did. */
export interface MilestoneSyncPrOutcome {
  /** Branch the PR was raised from. */
  branch: string;
  /** True when this call opened the PR rather than updating an open one. */
  opened: boolean;
}

/**
 * Arm auto-merge on a freshly-raised sync PR, as a merge commit (Issue #1048).
 *
 * A repository that forbids merge commits gets the squash it can take, with a
 * loud warning naming the setting — never a quiet downgrade. Any other failure
 * is left for `ensureAutoMergeOnOpenPrs` to retry, as before.
 */
async function armSyncPrAutoMerge(
  repo: string,
  prNumber: string,
  branch: string,
  deps: MilestoneSyncPrDeps,
): Promise<void> {
  const arm = (method: "--merge" | "--squash") =>
    deps.gh(["pr", "merge", prNumber, "--repo", repo, "--auto", method]);
  try {
    await arm(mergeMethodFlagForHead(branch));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isMergeCommitNotAllowed(message)) return;
    try {
      await arm("--squash");
      deps.log?.(squashedSyncWarning(repo, branch, message.trim()));
    } catch {
      // Left for `ensureAutoMergeOnOpenPrs` to arm on its next pass.
    }
  }
}

/**
 * Push the already-merged tree to a sync branch and raise a PR for it.
 *
 * The caller has merged the default branch into the milestone branch in its
 * clone and had the push refused; HEAD therefore already carries the merge
 * this PR is for.
 *
 * @param repo - `owner/repo`.
 * @param milestoneBranch - The branch the PR targets.
 * @param defaultBranch - Named in the PR body, so a reader knows what merged.
 */
export async function raiseMilestoneSyncPr(
  repo: string,
  milestoneBranch: string,
  defaultBranch: string,
  deps: MilestoneSyncPrDeps,
): Promise<Result<MilestoneSyncPrOutcome>> {
  const branch = syncBranchFor(milestoneBranch);

  // Force-with-lease: the sync branch is this function's alone, and a stale
  // one from an earlier cycle carries a merge that is no longer current.
  // `--force-with-lease` still refuses if somebody else moved it.
  const push = await deps.git([
    "push",
    "--force-with-lease",
    "origin",
    `HEAD:refs/heads/${branch}`,
  ]);
  if (push.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Could not push the milestone sync branch '${branch}': ` +
          `${push.stderr.trim() || "git reported no stderr"}`,
      ),
    };
  }

  // One open PR per milestone branch: a sync that is still open is updated by
  // the push above, and re-filing would leave two PRs merging the same thing.
  try {
    const listed = await deps.gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--head",
      branch,
      "--base",
      milestoneBranch,
      "--json",
      "number",
    ]);
    const open = JSON.parse(listed || "[]") as { number: number }[];
    if (Array.isArray(open) && open.length > 0) {
      deps.log?.(
        `milestone sync: updated the open sync PR #${open[0]!.number} for ` +
          `'${milestoneBranch}' (Issue #589)`,
      );
      return { ok: true, value: { branch, opened: false } };
    }
  } catch {
    // An unreadable listing falls through to creating one: a duplicate PR is
    // recoverable, a sync that never lands is not.
  }

  try {
    const body = [
      `Merges \`${defaultBranch}\` into \`${milestoneBranch}\`.`,
      "",
      "Raised as a pull request rather than pushed directly because " +
      `\`${milestoneBranch}\` is gated by a required-status-checks ruleset ` +
      "(Issue #586). That gate is what makes this PR auto-mergeable — GitHub " +
      "arms auto-merge only when something blocks the merge — so this lands " +
      "unattended once its checks are green.",
      "",
      `Lands as a **merge commit**, never a squash: the point of the sync is ` +
      `to put \`${defaultBranch}\` in this branch's *ancestry*, so its ` +
      `deletions are history here rather than conflicts later (Issue #1048).`,
      "",
      "Filed by the milestone branch sync (Issue #589).",
    ].join("\n");

    const created = await deps.gh([
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      milestoneBranch,
      "--head",
      branch,
      "--title",
      `Sync ${defaultBranch} into ${milestoneBranch}`,
      "--body",
      body,
    ]);

    // Best-effort: a PR that cannot be armed still lands through the fleet's
    // own auto-merge pass, so a failure here is not the sync's failure.
    const number = created.trim().split("/").pop() ?? "";
    if (number) {
      await armSyncPrAutoMerge(repo, number, branch, deps);
    }
    deps.log?.(
      `milestone sync: raised PR ${created.trim()} to merge ` +
        `'${defaultBranch}' into '${milestoneBranch}' — the branch is gated, ` +
        `so the push had to become a PR (Issue #589)`,
    );
    return { ok: true, value: { branch, opened: true } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
