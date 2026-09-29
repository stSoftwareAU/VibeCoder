/**
 * The stale-verdict ladder's merge rung (Issues #2279, #2806, parent #2272).
 *
 * Rung 1 (the nudge) moves the head with an empty commit so GitHub recomputes
 * mergeability. When that does not shift a `CONFLICTING` verdict, rung 2 merges
 * `origin/BASE` into the branch and pushes the result with a **plain** push.
 *
 * **It never rewrites history (Issue #2806).** The rung used to rebase and
 * force-push with a pinned lease; that replaced the commits a reviewer had
 * anchored comments to. A merge commit sits on top of every existing commit,
 * so the push is a fast-forward and needs no force of any kind. When the
 * remote refuses it — somebody pushed since — the refusal is reported with
 * git's own words and nothing is forced over it.
 *
 * Every outcome other than `pushed` leaves the branch at `OLD`:
 *
 * - a conflicting merge is aborted and reported, so the ladder climbs to its
 *   next rung;
 * - a merge with nothing to merge (the base is already in `OLD`, which is the
 *   ladder's own entry condition unless the base moved since) is reported, not
 *   dressed up as a push;
 * - a refused push restores the clone to `OLD` and reports git's stderr.
 *
 * Faults that are none of these — a merge that fails with no conflict, an
 * abort that fails — restore `OLD` and throw rather than leave a half-merged
 * clone behind a green result.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import { buildPushArgs } from "./git_ref_args.ts";
import { isConflictHeadSha } from "./merge_conflict_markers.ts";
import { appendRunIdTrailer, getRunId } from "./run_id.ts";

/** One git invocation's result, as this rung reads it. */
export interface MergeGitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The git runner this rung drives — `WorkerDeps["git"]["runGitCommand"]`'s
 * shape, narrowed to what is used here so tests can script it directly.
 */
export type MergeGitRunner = (
  args: string[],
  options: { cwd: string },
) => Promise<Result<MergeGitOutcome>>;

/** What {@link runMergeRung} is asked to do. */
export interface MergeRungRequest {
  /** The PR's head branch — the push target. */
  branchName: string;
  /** The base branch the PR targets, without the `origin/` prefix. */
  baseBranch: string;
  /** The head sha GitHub judged `CONFLICTING`. */
  oldHead: string;
  /** The clone the rung runs in. */
  cwd: string;
  /** Injected git runner. */
  git: MergeGitRunner;
  /** Run id for the merge commit's trailer. Defaults to {@link getRunId}. */
  runId?: string;
  /** Optional logger for the route actually taken. */
  logger?: Logger;
}

/** The closed set of outcomes this rung can report. */
export type MergeRungOutcome =
  /**
   * The clone is no longer at the head GitHub judged, so the rung declined
   * and touched nothing.
   */
  | { kind: "head-moved"; localHead: string }
  /** A merge commit on top of `oldHead` was pushed as `newHead`. */
  | { kind: "pushed"; oldHead: string; newHead: string }
  /** The merge conflicted and was aborted; the branch is at `oldHead`. */
  | { kind: "merge-conflicted"; conflictedPaths: number; detail: string }
  /** `origin/BASE` is already in `oldHead`, so there was nothing to merge. */
  | { kind: "nothing-to-merge" }
  /** The plain push was refused; the clone is restored to `oldHead`. */
  | { kind: "push-refused"; detail: string };

/**
 * Run a git command, folding a spawn failure into a non-zero exit so no caller
 * can mistake "could not run git" for "git said nothing was wrong".
 */
async function git(
  run: MergeGitRunner,
  args: string[],
  cwd: string,
): Promise<MergeGitOutcome> {
  const result = await run(args, { cwd });
  if (!result.ok) {
    return { code: 1, stdout: "", stderr: result.error.message };
  }
  return result.value;
}

/** Whatever git said, for an error message. */
function detailOf(outcome: MergeGitOutcome): string {
  return outcome.stderr.trim() || outcome.stdout.trim() || "no output";
}

/**
 * Message of the merge commit (Issue #2806).
 *
 * Names the head it merges into, so a reader can tell from the commit alone
 * why it exists, and carries the `Vibe-Coder-Run-Id` trailer the pre-commit
 * gate requires of every worker-authored commit.
 */
export function buildMergeCommitMessage(
  baseBranch: string,
  oldHead: string,
  runId: string,
): string {
  return appendRunIdTrailer(
    [
      `chore: merge origin/${baseBranch} to refresh a stale merge verdict ` +
      "(Issue #2272)",
      "",
      `GitHub reports this PR as CONFLICTING at ${oldHead}. This merges ` +
      `\`origin/${baseBranch}\` on top of that head and is pushed without ` +
      "any force, so every existing commit — and every review comment " +
      "anchored to one — is kept (Issue #2806).",
    ].join("\n"),
    runId,
  );
}

/** `git reset --hard <revision>`, or a throw naming what git said. */
async function resetHard(
  run: MergeGitRunner,
  cwd: string,
  revision: string,
  why: string,
): Promise<void> {
  const reset = await git(run, ["reset", "--hard", revision], cwd);
  if (reset.code !== 0) {
    throw new Error(
      `Failed to reset the branch to ${revision} ${why}: ${detailOf(reset)} ` +
        `— the working branch may be left part-way through a merge`,
    );
  }
}

/** The sha `HEAD` points at, or a throw when git reports no usable name. */
async function readHead(
  run: MergeGitRunner,
  cwd: string,
): Promise<string> {
  const result = await git(run, ["rev-parse", "HEAD"], cwd);
  const sha = result.stdout.trim().toLowerCase();
  if (result.code !== 0 || !isConflictHeadSha(sha)) {
    throw new Error(
      `Cannot run the merge rung: \`git rev-parse HEAD\` reported no usable ` +
        `object name (${detailOf(result)})`,
    );
  }
  return sha;
}

/**
 * Rung 2 — merge the base into the branch and push it plainly.
 *
 * Never force-pushes and never rewrites a commit: the only push is
 * `git push origin BRANCH`, which the remote accepts only as a fast-forward.
 *
 * @throws when the clone cannot be read, the merge fails for a reason that is
 *   not a conflict, the abort fails, or a restore fails.
 */
export async function runMergeRung(
  request: MergeRungRequest,
): Promise<MergeRungOutcome> {
  const { branchName, baseBranch, cwd, git: run, logger } = request;
  const oldHead = request.oldHead.trim().toLowerCase();
  if (!isConflictHeadSha(oldHead)) {
    throw new Error(
      `Cannot run the merge rung for head "${request.oldHead}" — a head sha ` +
        `must be 7–40 hex characters`,
    );
  }
  const runId = request.runId ?? getRunId();

  // 1. The rung is judged at the head GitHub judged. A clone sitting anywhere
  //    else would merge into — and push — a head nobody judged.
  const localHead = await readHead(run, cwd);
  if (localHead !== oldHead) {
    return { kind: "head-moved", localHead };
  }

  // 2. Merge the base on top. `--no-ff` makes a real merge commit whenever
  //    there is anything to merge, so the new head always has `oldHead` as
  //    its first parent.
  const merge = await git(run, [
    "merge",
    "--no-ff",
    "--no-edit",
    "-m",
    buildMergeCommitMessage(baseBranch, oldHead, runId),
    `origin/${baseBranch}`,
  ], cwd);

  if (merge.code !== 0) {
    // Read the unmerged paths while the merge is still stopped — after the
    // abort git reports none, so the conflict would be invisible.
    const unmerged = await git(
      run,
      ["diff", "--name-only", "--diff-filter=U"],
      cwd,
    );
    const paths = unmerged.code === 0 ? unmerged.stdout.trim() : "";

    if (paths.length === 0) {
      // Not a conflict — a dirty tree, a missing upstream, a broken clone.
      // Restore `OLD` and fail loud rather than report it as a rung outcome.
      await resetHard(run, cwd, oldHead, "after the merge failed");
      throw new Error(
        `\`git merge\` of 'origin/${baseBranch}' failed with no unmerged ` +
          `paths, so the failure is not a merge conflict: ${detailOf(merge)}`,
      );
    }

    const abort = await git(run, ["merge", "--abort"], cwd);
    if (abort.code !== 0) {
      await resetHard(run, cwd, oldHead, "after `git merge --abort` failed");
      throw new Error(
        `\`git merge --abort\` failed after the merge of ` +
          `'origin/${baseBranch}' conflicted: ${detailOf(abort)} — the ` +
          `branch was reset to ${oldHead} and nothing was pushed`,
      );
    }

    const conflictedPaths = paths.split("\n").length;
    logger?.info?.("Merge rung: the merge conflicted — aborted it", {
      branchName,
      baseBranch,
      oldHead,
      conflictedPaths,
    });
    return {
      kind: "merge-conflicted",
      conflictedPaths,
      detail: detailOf(merge),
    };
  }

  // 3. A merge that moved nothing: the base was already in `oldHead`. There is
  //    no commit to push, and pushing `oldHead` back would give GitHub nothing
  //    new to judge while the comment claimed a merge that never happened.
  const newHead = await readHead(run, cwd);
  if (newHead === oldHead) {
    logger?.info?.(
      "Merge rung: 'origin/BASE' is already merged — nothing to push",
      {
        branchName,
        baseBranch,
        oldHead,
      },
    );
    return { kind: "nothing-to-merge" };
  }

  // 4. A plain push: no lease, no force, no `+` refspec. The merge commit is a
  //    descendant of `oldHead`, so the remote accepts it only as a
  //    fast-forward, and refuses it — rather than being overwritten — when the
  //    branch moved on since.
  const push = await git(run, buildPushArgs("origin", branchName), cwd);
  if (push.code !== 0) {
    await resetHard(run, cwd, oldHead, "after the push was refused");
    return { kind: "push-refused", detail: detailOf(push) };
  }

  logger?.info?.("Merge rung: pushed a merge commit on top of the old head", {
    branchName,
    baseBranch,
    oldHead,
    newHead,
  });

  return { kind: "pushed", oldHead, newHead };
}
