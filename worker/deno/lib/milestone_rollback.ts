/**
 * Rolling a stuck milestone branch back until the default branch merges
 * cleanly (Issue #1771, part of #1730).
 *
 * A milestone branch that has spent its conflict-resolution budget is not
 * escalated to a human and not restarted from the default-branch tip —
 * restarting is dramatic, and a human who wrote none of the code cannot
 * untangle the merge either. It is rolled back: the merged child PRs that
 * touch the conflicting files are reverted, newest first, until
 * `git merge origin/<default>` succeeds. Only those children then have to be
 * redone.
 *
 * Two properties the mechanics keep, whatever happens:
 *
 * - **History is kept.** Every undo is a `git revert` commit, so what the
 *   branch held before the roll-back is still readable, and the push is an
 *   ordinary fast-forward. Nothing here ever pushes with `--force`.
 * - **Nothing half-done is published.** The pre-roll-back SHA is recorded
 *   first, and any outcome short of a clean merge resets the branch to it, so
 *   a roll-back that did not achieve the merge leaves the branch exactly as
 *   it was found and pushes nothing at all.
 *
 * The default branch is never touched — only the milestone branch moves.
 *
 * ```mermaid
 * flowchart TD
 *     C[conflicting files] --> L[merged child PRs touching them, newest first]
 *     L --> R{revert next}
 *     R --> M{merge default clean?}
 *     M -->|yes| P[commit + push / sync PR]
 *     M -->|no| R
 *     R -->|none left| X[reset to pre-roll-back SHA, report]
 * ```
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { assertSafeGitRef } from "./git_ref_args.ts";
import {
  isMilestoneSyncBranch,
  isRuleViolationPush,
  raiseMilestoneSyncPr,
} from "./milestone_sync_pr.ts";

/** A merged child PR the roll-back may undo. */
export interface RollbackCandidate {
  /** The child PR's number. */
  prNumber: number;
  /** The PR title, quoted in the revert commit so the log reads. */
  title: string;
  /** The commit the merge produced on the milestone branch. */
  sha: string;
  /** When the PR merged, as an ISO timestamp — the roll-back order. */
  mergedAt: string;
  /** Paths that commit touched, as `git diff-tree --name-only` reports them. */
  files: string[];
  /** The PR's head branch; a sync branch is never a roll-back candidate. */
  headRefName?: string;
}

/** One child PR this roll-back reverted. */
export interface RevertedChild {
  prNumber: number;
  sha: string;
  headRefName: string;
  title: string;
}

/** What {@link executeRollback} achieved. */
export interface RollbackOutcome {
  /** True when the default branch now merges cleanly and the merge landed. */
  merged: boolean;
  /** The children reverted to get there; empty whenever `merged` is false. */
  reverted: RevertedChild[];
  /**
   * Why the roll-back did not get there. Absent when `merged` is true.
   *
   * `"nothing left to revert"` — every candidate was reverted (or there were
   * none) and the merge still conflicts. `"revert conflicted on #N"` — the
   * revert of child PR N could not be applied, so the roll-back stopped
   * rather than resolve a second conflict inside the first. The third value,
   * {@link ALREADY_CLEAN_REASON}, answers a caller that asked for a roll-back
   * on a branch that turned out to merge cleanly: a state worth reporting
   * rather than silently reverting work over.
   */
  reason?: string;
}

/** Reason reported when the branch merges cleanly before anything is reverted. */
export const ALREADY_CLEAN_REASON =
  "the default branch already merges cleanly — nothing to roll back";

/** Reason reported when the candidates ran out with the merge still conflicting. */
export const NOTHING_LEFT_REASON = "nothing left to revert";

/** Injected seams, so the whole path is testable against real git or stubs. */
export interface MilestoneRollbackDeps {
  /** `owner/repo`, used to list the merged children and raise a sync PR. */
  repo: string;
  /** The milestone branch being rolled back; must be the checked-out branch. */
  milestoneBranch: string;
  /** The default branch that has to merge cleanly. */
  defaultBranch: string;
  /** Runs git in the clone, resolving with the exit code and both streams. */
  git: (
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Runs `gh`, returning stdout; throws on failure. */
  gh: (args: string[]) => Promise<string>;
  log?: (message: string) => void;
  /**
   * The conflicting paths, as the caller's aborted merge reported them.
   * Omitted, they are discovered here with a trial merge that is aborted
   * again — the caller usually has them already.
   */
  conflictingPaths?: string[];
  /**
   * Child PRs a previous roll-back already reverted, from the branch's
   * ledger. The branch's own revert commits are read as well, so a ledger
   * that has lost an entry still cannot revert the same PR twice.
   */
  alreadyReverted?: number[];
}

/** The subject line a roll-back revert commit carries. */
export function revertCommitMessage(prNumber: number, title: string): string {
  return `Revert child PR #${prNumber} "${title}" — milestone roll-back ` +
    `(Issue #1730)`;
}

/**
 * The child PRs the given git log says have already been reverted.
 *
 * Reads {@link revertCommitMessage}'s own shape back out of the log, so a
 * roll-back that ran before the ledger existed — or whose ledger entry was
 * lost — still cannot revert the same PR a second time.
 */
export function parseRevertedChildPrs(log: string): number[] {
  const numbers = new Set<number>();
  for (const match of log.matchAll(/Revert child PR #(\d+)\b/g)) {
    const value = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(value) && value > 0) numbers.add(value);
  }
  return [...numbers];
}

/** A merge SHA git may be handed as a positional; anything else is refused. */
function isCommitSha(sha: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(sha);
}

/** Sort key for "newest first": an unreadable timestamp sorts oldest. */
function mergedAtMs(candidate: RollbackCandidate): number {
  const parsed = Date.parse(candidate.mergedAt ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The child PRs to revert, newest first.
 *
 * A candidate is planned when it touches at least one conflicting path. The
 * newest is reverted first because it sits closest to the branch tip: undoing
 * it is the revert least likely to conflict with the commits above it.
 *
 * Four kinds of candidate are never planned:
 *
 * - one whose head branch is a `sync/milestone-*` branch — that PR *is* the
 *   default branch arriving, so reverting it undoes the very merge the
 *   roll-back is trying to achieve;
 * - one already reverted, by number, whether the caller read that from the
 *   branch's revert commits or from its ledger;
 * - one with no usable merge SHA — there is nothing to hand `git revert`, and
 *   guessing a commit is how a roll-back reverts the wrong change;
 * - one that touches none of the conflicting paths, which is the whole point:
 *   children that are not in the way are kept.
 *
 * @param candidates - Merged child PRs, in any order.
 * @param conflictingPaths - Paths the conflicting merge reported.
 * @param alreadyReverted - Child PR numbers a previous roll-back undid.
 * @returns The candidates to revert, newest first.
 */
export function planRollback(
  candidates: RollbackCandidate[],
  conflictingPaths: string[],
  alreadyReverted: number[] = [],
): RollbackCandidate[] {
  const conflicting = new Set(conflictingPaths.filter(Boolean));
  const reverted = new Set(alreadyReverted);
  return candidates
    .filter((candidate) =>
      !isMilestoneSyncBranch(candidate.headRefName) &&
      !reverted.has(candidate.prNumber) &&
      isCommitSha(candidate.sha) &&
      candidate.files.some((file) => conflicting.has(file))
    )
    .sort((a, b) => mergedAtMs(b) - mergedAtMs(a) || b.prNumber - a.prNumber);
}

/** A merged child PR as `gh pr list --json …` reports it. */
interface MergedChildPr {
  number?: number;
  title?: string;
  mergedAt?: string;
  headRefName?: string;
  mergeCommit?: { oid?: string } | null;
}

/**
 * The merged child PRs of a milestone branch, without their touched files.
 *
 * A PR GitHub reports without a merge commit is kept with an empty SHA rather
 * than dropped: {@link planRollback} refuses it, and the caller can say so.
 */
export function parseMergedChildPrs(json: string): RollbackCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const candidates: RollbackCandidate[] = [];
  for (const entry of parsed as MergedChildPr[]) {
    const prNumber = entry?.number;
    if (typeof prNumber !== "number" || !Number.isFinite(prNumber)) continue;
    const oid = entry.mergeCommit?.oid ?? "";
    candidates.push({
      prNumber,
      title: typeof entry.title === "string" ? entry.title : "",
      sha: typeof oid === "string" && isCommitSha(oid) ? oid : "",
      mergedAt: typeof entry.mergedAt === "string" ? entry.mergedAt : "",
      files: [],
      ...(typeof entry.headRefName === "string"
        ? { headRefName: entry.headRefName }
        : {}),
    });
  }
  return candidates;
}

/** Run git and report the exit code and both streams, never throwing. */
async function runGit(
  deps: MilestoneRollbackDeps,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    return await deps.git(args);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/** git's own stderr, or the note that it produced none. */
function gitDetail(result: { stderr: string }): string {
  return result.stderr.trim() || "git reported no stderr";
}

/** Number of parents a commit has; -1 when git could not say. */
async function parentCount(
  deps: MilestoneRollbackDeps,
  sha: string,
): Promise<number> {
  const result = await runGit(deps, ["rev-list", "--parents", "-n", "1", sha]);
  if (result.code !== 0) return -1;
  const tokens = result.stdout.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens.length - 1 : -1;
}

/**
 * The paths a merge commit changed, against its first parent.
 *
 * The first parent is the milestone branch, so this is what the child PR
 * added to it — a plain `diff-tree` of a two-parent merge reports nothing at
 * all, and `-m` reports both parents' diffs pooled together, which would plan
 * a roll-back of children that touched none of the conflicting files.
 */
export async function readTouchedFiles(
  deps: MilestoneRollbackDeps,
  sha: string,
  parents?: number,
): Promise<string[]> {
  if (!isCommitSha(sha)) return [];
  const count = parents ?? await parentCount(deps, sha);
  const args = count >= 1
    ? ["diff-tree", "--no-commit-id", "--name-only", "-r", `${sha}^1`, sha]
    : ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha];
  const result = await runGit(deps, args);
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Every merged child PR of the milestone branch, with its touched files. */
async function collectCandidates(
  deps: MilestoneRollbackDeps,
): Promise<RollbackCandidate[]> {
  let listed = "";
  try {
    listed = await deps.gh([
      "pr",
      "list",
      "--repo",
      deps.repo,
      "--base",
      deps.milestoneBranch,
      "--state",
      "merged",
      "--json",
      "number,title,mergeCommit,mergedAt,headRefName",
    ]);
  } catch (error) {
    deps.log?.(
      `WARNING: milestone roll-back could not list the merged children of ` +
        `'${deps.milestoneBranch}' in ${deps.repo}, so nothing can be ` +
        `reverted (Issue #1771): ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
    return [];
  }

  const candidates = parseMergedChildPrs(listed);
  const withFiles: RollbackCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.sha) {
      deps.log?.(
        `WARNING: milestone roll-back skipped child PR #${candidate.prNumber} ` +
          `of '${deps.milestoneBranch}': GitHub reports no merge commit for ` +
          `it, so there is nothing to revert (Issue #1771)`,
      );
      continue;
    }
    withFiles.push({
      ...candidate,
      files: await readTouchedFiles(deps, candidate.sha),
    });
  }
  return withFiles;
}

/** The child PRs the milestone branch's own log says were already reverted. */
async function revertedOnBranch(
  deps: MilestoneRollbackDeps,
): Promise<number[]> {
  const log = await runGit(deps, ["log", "--format=%B", "-n", "500", "HEAD"]);
  return log.code === 0 ? parseRevertedChildPrs(log.stdout) : [];
}

/** Undo any merge git left in progress, then put HEAD back where it was. */
async function resetTo(
  deps: MilestoneRollbackDeps,
  sha: string,
): Promise<Result<void>> {
  await runGit(deps, ["merge", "--abort"]);
  const reset = await runGit(deps, ["reset", "--hard", sha]);
  if (reset.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Milestone roll-back of '${deps.milestoneBranch}' could NOT reset ` +
          `the branch to its pre-roll-back commit ${sha}, so the clone is ` +
          `left mid-roll-back (Issue #1771): ${gitDetail(reset)}`,
      ),
    };
  }
  return { ok: true, value: undefined };
}

/** Try the merge; report the conflicting paths when it does not take. */
async function tryMerge(
  deps: MilestoneRollbackDeps,
): Promise<{ clean: boolean; conflicting: string[]; detail: string }> {
  const merge = await runGit(deps, [
    "merge",
    "--no-commit",
    "--no-ff",
    `origin/${deps.defaultBranch}`,
  ]);
  if (merge.code === 0) return { clean: true, conflicting: [], detail: "" };
  const conflicted = await runGit(deps, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ]);
  const conflicting = conflicted.code === 0
    ? conflicted.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  await runGit(deps, ["merge", "--abort"]);
  return { clean: false, conflicting, detail: gitDetail(merge) };
}

/**
 * Commit the merge git has staged, and push the branch.
 *
 * `--no-ff` guarantees a merge commit whenever the default branch actually
 * brings something, so the default branch lands in this branch's ancestry
 * rather than beside it (Issue #1048). A merge that brought nothing leaves no
 * `MERGE_HEAD` and nothing to commit, which is not a failure.
 */
async function commitAndPushMerge(
  deps: MilestoneRollbackDeps,
): Promise<Result<void>> {
  const pending = await runGit(deps, [
    "rev-parse",
    "-q",
    "--verify",
    "MERGE_HEAD",
  ]);
  if (pending.code === 0) {
    const commit = await runGit(deps, ["commit", "--no-edit"]);
    if (commit.code !== 0) {
      return {
        ok: false,
        error: new Error(
          `Milestone roll-back of '${deps.milestoneBranch}' merged ` +
            `'${deps.defaultBranch}' cleanly but could not commit the merge ` +
            `(Issue #1771): ${gitDetail(commit)}`,
        ),
      };
    }
  }

  const push = await runGit(deps, [
    "push",
    "origin",
    `HEAD:refs/heads/${deps.milestoneBranch}`,
  ]);
  if (push.code === 0) return { ok: true, value: undefined };

  // A gated milestone branch refuses a direct push whatever it carries, so
  // the roll-back lands the same way the ordinary sync does (Issue #589).
  if (!isRuleViolationPush(push.stderr)) {
    return {
      ok: false,
      error: new Error(
        `Milestone roll-back of '${deps.milestoneBranch}' could not push the ` +
          `rolled-back branch (Issue #1771): ${gitDetail(push)}`,
      ),
    };
  }
  const raised = await raiseMilestoneSyncPr(
    deps.repo,
    deps.milestoneBranch,
    deps.defaultBranch,
    {
      git: async (args) => {
        const result = await runGit(deps, args);
        return { code: result.code, stderr: result.stderr };
      },
      gh: deps.gh,
      ...(deps.log ? { log: deps.log } : {}),
    },
  );
  if (!raised.ok) {
    return {
      ok: false,
      error: new Error(
        `Milestone roll-back of '${deps.milestoneBranch}' was refused by a ` +
          `repository rule and the sync PR could not be raised ` +
          `(Issues #589, #1771): ${raised.error.message}`,
      ),
    };
  }
  deps.log?.(
    `milestone roll-back: '${deps.milestoneBranch}' is gated, so the ` +
      `rolled-back merge landed through the sync PR from ` +
      `'${raised.value.branch}' (Issues #589, #1771)`,
  );
  return { ok: true, value: undefined };
}

/**
 * Revert merged children until the default branch merges cleanly.
 *
 * Reverts newest first and re-tries the merge after each one, so the roll-back
 * stops at the first child whose removal is enough — the smallest amount of
 * work to redo. A revert that itself conflicts stops the roll-back rather than
 * resolving a conflict inside the conflict, and the branch is put back.
 *
 * Nothing is pushed unless the merge succeeded: every other path ends at
 * `git reset --hard <pre-roll-back SHA>`, so the branch is either merged or
 * untouched. The remote milestone branch only ever moves forwards — no push
 * here is a force-push, and the default branch is never written to.
 *
 * @returns The outcome; `ok: false` only when git itself failed in a way that
 *   leaves nothing safe to report — an unreadable HEAD, a reset that would not
 *   run, a push that failed for a reason a sync PR cannot answer.
 */
export async function executeRollback(
  deps: MilestoneRollbackDeps,
): Promise<Result<RollbackOutcome>> {
  try {
    assertSafeGitRef(deps.milestoneBranch, "milestone branch name");
    assertSafeGitRef(deps.defaultBranch, "default branch name");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  const head = await runGit(deps, ["rev-parse", "HEAD"]);
  if (head.code !== 0 || !isCommitSha(head.stdout.trim())) {
    return {
      ok: false,
      error: new Error(
        `Refusing to roll back '${deps.milestoneBranch}': its current commit ` +
          `could not be read, so there would be nothing to reset to ` +
          `(Issue #1771): ${gitDetail(head)}`,
      ),
    };
  }
  const preRollbackSha = head.stdout.trim();

  let conflictingPaths = deps.conflictingPaths ?? [];
  if (deps.conflictingPaths === undefined) {
    const probe = await tryMerge(deps);
    if (probe.clean) {
      const reset = await resetTo(deps, preRollbackSha);
      if (!reset.ok) return reset;
      deps.log?.(
        `WARNING: milestone roll-back of '${deps.milestoneBranch}' was asked ` +
          `for a branch that merges '${deps.defaultBranch}' cleanly, so ` +
          `nothing was reverted (Issue #1771)`,
      );
      return {
        ok: true,
        value: { merged: false, reverted: [], reason: ALREADY_CLEAN_REASON },
      };
    }
    conflictingPaths = probe.conflicting;
  }

  const plan = planRollback(
    await collectCandidates(deps),
    conflictingPaths,
    [...(deps.alreadyReverted ?? []), ...await revertedOnBranch(deps)],
  );

  const reverted: RevertedChild[] = [];
  for (const candidate of plan) {
    const parents = await parentCount(deps, candidate.sha);
    // A child PR that squash-merged has one parent; one merged as a merge
    // commit has two, and git will not revert that without being told which
    // side is the mainline. `-m 1` is the milestone branch either way.
    const revertArgs = parents >= 2
      ? ["revert", "--no-edit", "-m", "1", candidate.sha]
      : ["revert", "--no-edit", candidate.sha];
    const revert = await runGit(deps, revertArgs);
    if (revert.code !== 0) {
      await runGit(deps, ["revert", "--abort"]);
      const reset = await resetTo(deps, preRollbackSha);
      if (!reset.ok) return reset;
      deps.log?.(
        `WARNING: milestone roll-back of '${deps.milestoneBranch}' stopped — ` +
          `the revert of child PR #${candidate.prNumber} conflicted, so the ` +
          `branch was reset to ${preRollbackSha} and nothing was pushed ` +
          `(Issue #1771): ${gitDetail(revert)}`,
      );
      return {
        ok: true,
        value: {
          merged: false,
          reverted: [],
          reason: `revert conflicted on #${candidate.prNumber}`,
        },
      };
    }

    // `git revert` writes its own subject; this is the one the log needs —
    // it names the PR, so a later roll-back can see it was already undone.
    const amend = await runGit(deps, [
      "commit",
      "--amend",
      "-m",
      revertCommitMessage(candidate.prNumber, candidate.title),
    ]);
    if (amend.code !== 0) {
      const reset = await resetTo(deps, preRollbackSha);
      if (!reset.ok) return reset;
      return {
        ok: false,
        error: new Error(
          `Milestone roll-back of '${deps.milestoneBranch}' reverted child ` +
            `PR #${candidate.prNumber} but could not name the revert commit, ` +
            `so the branch was reset to ${preRollbackSha} (Issue #1771): ` +
            gitDetail(amend),
        ),
      };
    }
    reverted.push({
      prNumber: candidate.prNumber,
      sha: candidate.sha,
      headRefName: candidate.headRefName ?? "",
      title: candidate.title,
    });

    const merge = await tryMerge(deps);
    if (!merge.clean) continue;

    const landed = await commitAndPushMerge(deps);
    if (!landed.ok) {
      const reset = await resetTo(deps, preRollbackSha);
      if (!reset.ok) return reset;
      return landed;
    }
    deps.log?.(
      `milestone roll-back: '${deps.milestoneBranch}' merges ` +
        `'${deps.defaultBranch}' again after reverting ${reverted.length} ` +
        `child PR(s) — ${
          reverted.map((child) => `#${child.prNumber}`).join(", ")
        } (Issue #1771)`,
    );
    return { ok: true, value: { merged: true, reverted } };
  }

  const reset = await resetTo(deps, preRollbackSha);
  if (!reset.ok) return reset;
  deps.log?.(
    `WARNING: milestone roll-back of '${deps.milestoneBranch}' reverted ` +
      `${plan.length} child PR(s) and '${deps.defaultBranch}' still does not ` +
      `merge, so the branch was reset to ${preRollbackSha} and nothing was ` +
      `pushed (Issue #1771)`,
  );
  return {
    ok: true,
    value: { merged: false, reverted: [], reason: NOTHING_LEFT_REASON },
  };
}
