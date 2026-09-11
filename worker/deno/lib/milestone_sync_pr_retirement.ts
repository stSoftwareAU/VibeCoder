/**
 * Retiring a milestone sync PR before GitHub can retarget it (Issue #1967).
 *
 * `milestone_sync_pr.ts` raises `Sync <default> into milestone/<name>` from
 * `sync/milestone-<name>` and arms auto-merge on it. Nothing used to close
 * that PR when the sync landed some other way, or when the milestone it
 * serves finished. Both leave an armed, approved PR open on a base branch
 * that is about to disappear — and when `delete_branch_on_merge` deletes the
 * milestone branch, GitHub does not close the PRs targeting it: it
 * **retargets** them to the default branch (`automatic_base_change_succeeded`)
 * with their approvals and their auto-merge arming intact.
 *
 * Retargeted, a sync PR is a squash remnant whose diff against the default
 * branch reverts whatever the milestone changed. VibeCoder#1957 reached
 * exactly that state one minute before a reviewer approved it, and only an
 * unrelated red shard stopped it landing on `main`. A sync PR is the one PR
 * the fleet raises that must never target the default branch.
 *
 * So a sync PR is retired at each of the three moments it stops being
 * useful:
 *
 *   1. {@link closeLandedMilestoneSyncPrs} — the sync landed by direct push,
 *      so the PR's diff against its base is empty and it merges nothing.
 *   2. {@link retireMilestoneSyncPrs} — the milestone is finishing, so the
 *      branch the PR targets is about to be deleted.
 *   3. {@link closeRetargetedSyncPr} — defence in depth: the PR-maintenance
 *      scan already found one on the default branch, so it is closed rather
 *      than merged, with the reason posted on it.
 *
 * Closing is deliberately the only verb here. A sync PR that has lost its
 * base has nothing legitimate to contribute to the default branch, and the
 * next sweep re-raises the sync from a fresh branch when the milestone is
 * genuinely still live.
 *
 * Best-effort by design, never silent: a listing, comment or close that fails
 * is logged as a `WARNING` naming the PR, and the PR is simply not counted as
 * retired — the next cycle tries again.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { isMilestoneSyncBranch, syncBranchFor } from "./milestone_sync_pr.ts";

/** Injectable `gh` command runner. */
export type GhCommandFn = (args: string[]) => Promise<string>;

/** The fields of an open PR this module decides on. */
export interface SyncPrRecord {
  number: number;
  headRefName?: string | null;
  baseRefName?: string | null;
}

/** What every closure here needs. */
interface CloseContext {
  repo: string;
  ghCommandFn: GhCommandFn;
  log: (message: string) => void;
}

/** Everything {@link retireMilestoneSyncPrs} needs. */
export interface RetireSyncPrsOptions extends CloseContext {
  /** The milestone branch whose sync PR is being retired. */
  milestoneBranch: string;
  /** One clause naming why, folded into the comment left on the PR. */
  reason: string;
}

/** Everything {@link closeLandedMilestoneSyncPrs} needs. */
export interface CloseLandedSyncPrsOptions extends CloseContext {
  /** The milestone branch whose sync has just landed. */
  milestoneBranch: string;
}

/** Everything {@link closeRetargetedSyncPr} needs. */
export interface CloseRetargetedSyncPrOptions extends CloseContext {
  /** The PR the scan found on the default branch. */
  prNumber: number;
  /** Its sync-shaped head branch. */
  headRefName: string;
  /** The default branch it was retargeted onto. */
  defaultBranch: string;
}

/**
 * Whether an open PR is a fleet sync PR that now targets the default branch.
 *
 * True only when the head is sync-shaped **and** the base was actually read
 * and equals the default branch. An absent base is "unknown", never "the
 * default branch": closing a PR is destructive, so a lookup that said nothing
 * must not be read as evidence.
 *
 * @param pr - The PR as the scan listed it
 * @param defaultBranch - The repository's default branch
 * @returns true when the PR must be closed rather than merged
 */
export function isRetargetedSyncPr(
  pr: SyncPrRecord,
  defaultBranch: string,
): boolean {
  return isMilestoneSyncBranch(pr.headRefName) &&
    typeof pr.baseRefName === "string" &&
    pr.baseRefName === defaultBranch &&
    defaultBranch !== "";
}

/** The sentence every closure comment ends with, so the cause is traceable. */
const PROVENANCE =
  "Closed, never merged: a milestone sync PR that outlives its base branch " +
  "is retargeted by GitHub onto the default branch with its approval and " +
  "auto-merge arming intact, where its diff reverts the milestone's own work " +
  "(Issue #1967). The next sync sweep raises a fresh PR if one is still " +
  "needed.";

/** List the open PRs raised from a milestone branch's sync branch. */
async function listOpenSyncPrs(
  options: CloseContext & { syncBranch: string },
): Promise<SyncPrRecord[]> {
  const { repo, syncBranch, ghCommandFn, log } = options;
  try {
    const out = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--head",
      syncBranch,
      "--json",
      "number,headRefName,baseRefName",
    ]);
    const parsed = JSON.parse(out || "[]") as SyncPrRecord[];
    // The head filter is GitHub's; re-check it here so a broader answer than
    // the one asked for can never close somebody else's PR.
    return Array.isArray(parsed)
      ? parsed.filter((pr) =>
        typeof pr?.number === "number" && isMilestoneSyncBranch(pr.headRefName)
      )
      : [];
  } catch (error) {
    log(
      `WARNING: Could not list the open sync PRs on '${syncBranch}' in ` +
        `${repo}: ${describe(error)} — any open sync PR stays open this ` +
        `cycle (Issue #1967)`,
    );
    return [];
  }
}

/**
 * Comment on a sync PR and close it, deleting its head branch.
 *
 * @returns true only when the close itself succeeded.
 */
async function closeSyncPr(
  options: CloseContext & { prNumber: number; body: string },
): Promise<boolean> {
  const { repo, prNumber, body, ghCommandFn, log } = options;
  try {
    await ghCommandFn([
      "pr",
      "comment",
      String(prNumber),
      "--repo",
      repo,
      "--body",
      body,
    ]);
  } catch (error) {
    // The comment is the explanation, not the safety property — a PR closed
    // without one is still safe, so this does not abort the close.
    log(
      `WARNING: Could not comment on sync PR ${repo}#${prNumber} before ` +
        `closing it: ${describe(error)} (Issue #1967)`,
    );
  }

  try {
    await ghCommandFn([
      "pr",
      "close",
      String(prNumber),
      "--repo",
      repo,
      // The branch goes too: while it exists, a later sweep can re-raise a
      // PR from it, and GitHub can retarget whatever is open on it.
      "--delete-branch",
    ]);
    return true;
  } catch (error) {
    log(
      `WARNING: Could not close sync PR ${repo}#${prNumber}: ` +
        `${describe(error)} — it is still open and still armed, and will be ` +
        `retried next cycle (Issue #1967)`,
    );
    return false;
  }
}

/**
 * Close every open sync PR for a milestone branch, with its reason.
 *
 * Called before the milestone's final PR is raised, and again once that PR
 * has merged: the window between the final merge and GitHub's branch deletion
 * is where the retarget happens, so the sync PR must already be gone.
 *
 * @param options - Repo, milestone branch, `gh` runner, log sink and reason
 * @returns The PR numbers actually closed
 */
export async function retireMilestoneSyncPrs(
  options: RetireSyncPrsOptions,
): Promise<number[]> {
  const { repo, milestoneBranch, reason, ghCommandFn, log } = options;
  const syncBranch = syncBranchFor(milestoneBranch);
  const open = await listOpenSyncPrs({ repo, syncBranch, ghCommandFn, log });

  const closed: number[] = [];
  for (const pr of open) {
    const body = `Closing this milestone sync PR because ${reason}. ` +
      `Its base \`${milestoneBranch}\` is being retired.\n\n${PROVENANCE}`;
    if (
      await closeSyncPr({ repo, prNumber: pr.number, body, ghCommandFn, log })
    ) {
      closed.push(pr.number);
      log(
        `Closed milestone sync PR ${repo}#${pr.number} for ` +
          `'${milestoneBranch}' — ${reason} (Issue #1967)`,
      );
    }
  }
  return closed;
}

/**
 * Close every open sync PR for a milestone branch whose diff is empty.
 *
 * A sync that lands by direct push — the ordinary case once the branch's
 * ruleset stops refusing the push — leaves the PR open with nothing to merge
 * and auto-merge still armed. Nothing to merge is what makes it safe to
 * close and dangerous to leave: an empty PR still carries the arming that a
 * later retarget turns into a merge onto the default branch.
 *
 * A file list that cannot be read closes nothing and says so: "could not
 * tell" is never "empty".
 *
 * @param options - Repo, milestone branch, `gh` runner and log sink
 * @returns The PR numbers actually closed
 */
export async function closeLandedMilestoneSyncPrs(
  options: CloseLandedSyncPrsOptions,
): Promise<number[]> {
  const { repo, milestoneBranch, ghCommandFn, log } = options;
  const syncBranch = syncBranchFor(milestoneBranch);
  const open = await listOpenSyncPrs({ repo, syncBranch, ghCommandFn, log });

  const closed: number[] = [];
  for (const pr of open) {
    let files: unknown;
    try {
      const out = await ghCommandFn([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repo,
        "--json",
        "files",
      ]);
      files = (JSON.parse(out || "{}") as { files?: unknown }).files;
    } catch (error) {
      log(
        `WARNING: Could not read the file list of sync PR ${repo}#${pr.number}: ` +
          `${describe(error)} — leaving it open, since an unreadable diff is ` +
          `not an empty one (Issue #1967)`,
      );
      continue;
    }
    if (!Array.isArray(files)) {
      log(
        `WARNING: Sync PR ${repo}#${pr.number} returned no file list — ` +
          `leaving it open (Issue #1967)`,
      );
      continue;
    }
    if (files.length > 0) continue;

    const body =
      `Closing this milestone sync PR: \`${milestoneBranch}\` already ` +
      `carries the merge, so there is nothing left to merge here — the sync ` +
      `landed by direct push.\n\n${PROVENANCE}`;
    if (
      await closeSyncPr({ repo, prNumber: pr.number, body, ghCommandFn, log })
    ) {
      closed.push(pr.number);
      log(
        `Closed empty milestone sync PR ${repo}#${pr.number} for ` +
          `'${milestoneBranch}' — the sync landed another way (Issue #1967)`,
      );
    }
  }
  return closed;
}

/**
 * Close a sync PR the maintenance scan found targeting the default branch.
 *
 * The last line of defence: by the time a PR reaches this state its base
 * branch is already gone, so nothing can be merged and nothing can be
 * retargeted back. Closing is the only correct verb.
 *
 * @param options - Repo, PR number, head branch, default branch, runner, log
 * @returns true when the PR was closed
 */
export async function closeRetargetedSyncPr(
  options: CloseRetargetedSyncPrOptions,
): Promise<boolean> {
  const { repo, prNumber, headRefName, defaultBranch, ghCommandFn, log } =
    options;
  const body =
    `This milestone sync PR is now targeting \`${defaultBranch}\`. ` +
    `Its head \`${headRefName}\` was raised to merge the default branch *into* ` +
    `a milestone branch; that branch has been deleted, so GitHub retargeted ` +
    `the PR here. Against \`${defaultBranch}\` its diff reverts the ` +
    `milestone's work, so it is closed and never merged.\n\n${PROVENANCE}`;

  const closed = await closeSyncPr({
    repo,
    prNumber,
    body,
    ghCommandFn,
    log,
  });
  if (closed) {
    log(
      `Closed retargeted milestone sync PR ${repo}#${prNumber}: head ` +
        `'${headRefName}' was pointing at '${defaultBranch}' with auto-merge ` +
        `armed (Issue #1967)`,
    );
  }
  return closed;
}

/** The message of a thrown value, for a log line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
