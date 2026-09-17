/**
 * The stale-verdict ladder's rebase rung (Issue #2279, parent #2272).
 *
 * Rung 1 (the nudge) moves the head with an empty commit so GitHub recomputes
 * mergeability. When that does not shift a `CONFLICTING` verdict, rung 2
 * replays the PR's non-merge commits onto the base so the branch GitHub is
 * judging has a shape it can merge — a linear history off the current base
 * rather than a head that merged the base in.
 *
 * **The tree-identity guard is what makes this admissible.** The resolver's
 * contract forbids a destructive force-push (Issues #1076, #4373) because a
 * rebase once destroyed a PR's own changes. So nothing is pushed until
 * `git diff --quiet OLD NEW` exits 0: the new head's tree is byte-identical to
 * the head GitHub judged, so the push replaces a commit graph and no file
 * content at all. A push that cannot prove that never happens — the replay is
 * thrown away and the branch is restored to `OLD`.
 *
 * When the replay conflicts, or lands on a different tree, the fallback is one
 * commit carrying `OLD`'s tree on top of the base:
 *
 * ```
 * git commit-tree OLD^{tree} -p origin/BASE
 * ```
 *
 * It cannot conflict and it cannot lose the base's changes. The ladder runs
 * only once `origin/BASE` is already an ancestor of `OLD`, so `OLD`'s tree
 * already contains everything the base carries — which is also why the
 * identity assertion on the fallback holds by construction. It is asserted
 * anyway: "identical by construction" is a claim about code, and the push is
 * irreversible.
 *
 * Every outcome leaves the branch either at `OLD` or at a head whose tree
 * equals `OLD`'s. There is no third state, including on the error paths: a
 * fault restores `OLD` and then fails loud rather than leaving a half-replayed
 * branch behind.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, Result } from "../types.ts";
import { buildPushArgs, buildRebaseArgs } from "./git_ref_args.ts";
import { isConflictHeadSha } from "./merge_conflict_markers.ts";
import { appendRunIdTrailer, getRunId } from "./run_id.ts";

/** One git invocation's result, as this rung reads it. */
export interface RebaseGitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The git runner this rung drives — `WorkerDeps["git"]["runGitCommand"]`'s
 * shape, narrowed to what is used here so tests can script it directly.
 */
export type RebaseGitRunner = (
  args: string[],
  options: { cwd: string },
) => Promise<Result<RebaseGitOutcome>>;

/** What {@link runRebaseRung} is asked to do. */
export interface RebaseRungRequest {
  /** The PR's head branch — the push target and the lease's ref. */
  branchName: string;
  /** The base branch the PR targets, without the `origin/` prefix. */
  baseBranch: string;
  /** The head sha GitHub judged `CONFLICTING`, and the lease's expected value. */
  oldHead: string;
  /** The clone the rung runs in. */
  cwd: string;
  /** Injected git runner. */
  git: RebaseGitRunner;
  /** Run id for the fallback commit's trailer. Defaults to {@link getRunId}. */
  runId?: string;
  /** Optional logger for the route actually taken. */
  logger?: Logger;
}

/** How the pushed head was produced. */
export type RebaseRungRoute = "rebase" | "squash";

/** The closed set of outcomes this rung can report. */
export type RebaseRungOutcome =
  /**
   * The clone is no longer at the head GitHub judged, so the rung declined
   * and touched nothing. Rebasing some other head would push a tree nobody
   * compared against the head under judgement.
   */
  | { kind: "head-moved"; localHead: string }
  /** The branch now points at `newHead`, whose tree equals `oldHead`'s. */
  | { kind: "pushed"; oldHead: string; newHead: string; via: RebaseRungRoute }
  /** The push was refused; the branch has been restored to `oldHead`. */
  | { kind: "push-refused"; detail: string };

/**
 * Run a git command, folding a spawn failure into a non-zero exit so no caller
 * can mistake "could not run git" for "git said nothing was wrong".
 */
async function git(
  run: RebaseGitRunner,
  args: string[],
  cwd: string,
): Promise<RebaseGitOutcome> {
  const result = await run(args, { cwd });
  if (!result.ok) {
    return { code: 1, stdout: "", stderr: result.error.message };
  }
  return result.value;
}

/** The first line of whatever git said, for an error message. */
function detailOf(outcome: RebaseGitOutcome): string {
  return outcome.stderr.trim() || outcome.stdout.trim() || "no output";
}

/**
 * Message of the fallback commit (Issue #2279).
 *
 * It names the head whose tree it carries, so a reader can verify the identity
 * claim from the commit alone (`git diff --stat OLD NEW` prints nothing), and
 * carries the `Vibe-Coder-Run-Id` trailer the pre-commit gate requires of every
 * worker-authored commit.
 */
export function buildSquashCommitMessage(
  baseBranch: string,
  oldHead: string,
  runId: string,
): string {
  return appendRunIdTrailer(
    [
      "chore: replay this PR's changes onto the base as one commit (Issue #2272)",
      "",
      `GitHub reports this PR as CONFLICTING at ${oldHead}, but ` +
      `\`origin/${baseBranch}\` is already an ancestor of that head, so the ` +
      "verdict is stale rather than the branch. Rebasing the commits " +
      "individually did not reproduce that head's tree, so this commit " +
      "carries it whole instead.",
      "",
      `This commit's tree is byte-identical to ${oldHead}'s — ` +
      `\`git diff --stat ${oldHead} HEAD\` prints nothing. No file changed; ` +
      "only the commit graph did.",
    ].join("\n"),
    runId,
  );
}

/** `git reset --hard <revision>`, or a throw naming what git said. */
async function resetHard(
  run: RebaseGitRunner,
  cwd: string,
  revision: string,
  why: string,
): Promise<void> {
  const reset = await git(run, ["reset", "--hard", revision], cwd);
  if (reset.code !== 0) {
    throw new Error(
      `Failed to reset the branch to ${revision} ${why}: ${detailOf(reset)} ` +
        `— the working branch may be left part-way through a replay`,
    );
  }
}

/**
 * Put one commit carrying `oldHead`'s tree on top of the base, and leave the
 * branch on it.
 *
 * @returns The new head sha, whose tree is asserted equal to `oldHead`'s.
 */
async function replaceWithSquashOfOldTree(
  request: RebaseRungRequest,
  oldHead: string,
  runId: string,
): Promise<string> {
  const { baseBranch, cwd, git: run } = request;

  const commitTree = await git(run, [
    "commit-tree",
    `${oldHead}^{tree}`,
    "-p",
    `origin/${baseBranch}`,
    "-m",
    buildSquashCommitMessage(baseBranch, oldHead, runId),
  ], cwd);
  if (commitTree.code !== 0) {
    throw new Error(
      `Failed to build the fallback commit carrying ${oldHead}'s tree: ` +
        detailOf(commitTree),
    );
  }

  const newHead = commitTree.stdout.trim().toLowerCase();
  if (!isConflictHeadSha(newHead)) {
    throw new Error(
      `\`git commit-tree\` reported "${commitTree.stdout.trim()}", which is ` +
        `not a usable object name, so the fallback commit cannot be pushed`,
    );
  }

  await resetHard(run, cwd, newHead, "onto the fallback commit");

  // Identical by construction — the tree came from `oldHead` — so this can
  // only fail if the construction is wrong. Assert it anyway: the next step
  // force-pushes, and "by construction" is a claim about code.
  const identical = await git(run, ["diff", "--quiet", oldHead, newHead], cwd);
  if (identical.code !== 0) {
    await resetHard(run, cwd, oldHead, "after the fallback failed its guard");
    throw new Error(
      `The fallback commit ${newHead} carries ${oldHead}'s tree by ` +
        `construction, but \`git diff --quiet ${oldHead} ${newHead}\` exited ` +
        `${identical.code} — nothing was pushed and the branch is back at ` +
        `${oldHead}`,
    );
  }

  return newHead;
}

/** The sha `HEAD` points at, or a throw when git reports no usable name. */
async function readHead(
  run: RebaseGitRunner,
  cwd: string,
): Promise<string> {
  const result = await git(run, ["rev-parse", "HEAD"], cwd);
  const sha = result.stdout.trim().toLowerCase();
  if (result.code !== 0 || !isConflictHeadSha(sha)) {
    throw new Error(
      `Cannot run the rebase rung: \`git rev-parse HEAD\` reported no usable ` +
        `object name (${detailOf(result)})`,
    );
  }
  return sha;
}

/**
 * Rung 2 — replay the PR's commits onto the base, guarded by tree identity.
 *
 * Never returns a `pushed` outcome whose tree differs from `oldHead`'s, and
 * never leaves the branch anywhere but `oldHead` or that pushed head. Faults
 * restore `oldHead` and then throw: a half-replayed branch reported as a
 * success is the silent failure this ladder cannot afford.
 *
 * @throws when the clone cannot be read, the replay fails for a reason that is
 *   not a conflict, the fallback cannot be built, or a restore fails.
 */
export async function runRebaseRung(
  request: RebaseRungRequest,
): Promise<RebaseRungOutcome> {
  const { branchName, baseBranch, cwd, git: run, logger } = request;
  const oldHead = request.oldHead.trim().toLowerCase();
  if (!isConflictHeadSha(oldHead)) {
    throw new Error(
      `Cannot run the rebase rung for head "${request.oldHead}" — a head sha ` +
        `must be 7–40 hex characters`,
    );
  }
  const runId = request.runId ?? getRunId();

  // 1. The rung is judged at the head GitHub judged. A clone sitting anywhere
  //    else would push a tree that was never compared with that head.
  const localHead = await readHead(run, cwd);
  if (localHead !== oldHead) {
    return { kind: "head-moved", localHead };
  }

  let newHead: string;
  let via: RebaseRungRoute;

  // 2. Replay the non-merge commits onto the base. `--no-rebase-merges` drops
  //    the merge commits, which is the point: a head that merged the base in
  //    is the shape GitHub is stuck on.
  const rebase = await git(
    run,
    buildRebaseArgs(`origin/${baseBranch}`, { noRebaseMerges: true }),
    cwd,
  );

  if (rebase.code !== 0) {
    // 3. A replay conflict. The only tree this rung may push is `oldHead`'s,
    //    and the fallback produces exactly that without resolving anything —
    //    so abort and take it, rather than spending an agent run on a
    //    resolution whose only admissible answer is already known.
    const unmerged = await git(
      run,
      ["diff", "--name-only", "--diff-filter=U"],
      cwd,
    );
    const conflicted = unmerged.code === 0 && unmerged.stdout.trim().length > 0;
    const abort = await git(run, ["rebase", "--abort"], cwd);

    if (abort.code !== 0) {
      // A clone that may still be mid-rebase is not one to build a commit on:
      // the fallback's `reset --hard` would land on a half-replayed state the
      // header promises never to leave behind. Restore and stop.
      await resetHard(run, cwd, oldHead, "after `git rebase --abort` failed");
      throw new Error(
        `\`git rebase --abort\` failed after the replay onto ` +
          `'origin/${baseBranch}' stopped: ${detailOf(abort)} — the branch ` +
          `was reset to ${oldHead} and nothing was pushed`,
      );
    }

    if (!conflicted) {
      // Not a conflict at all — a dirty tree, a missing upstream, a broken
      // clone. Fail loud rather than papering over it with the fallback,
      // which would hide a broken clone behind a green push.
      throw new Error(
        `\`git rebase\` onto 'origin/${baseBranch}' failed with no unmerged ` +
          `paths, so the failure is not a replay conflict: ${detailOf(rebase)}`,
      );
    }

    logger?.info?.("Rebase rung: the replay conflicted — squashing instead", {
      branchName,
      baseBranch,
      oldHead,
      conflictedPaths: unmerged.stdout.trim().split("\n").length,
    });
    newHead = await replaceWithSquashOfOldTree(request, oldHead, runId);
    via = "squash";
  } else {
    // 4. The tree-identity guard. `git diff --quiet` exits 0 only when the two
    //    trees are identical, which is the whole licence for the force-push
    //    below.
    const guard = await git(run, ["diff", "--quiet", oldHead, "HEAD"], cwd);
    const replayed = await readHead(run, cwd);
    if (guard.code === 0 && replayed !== oldHead) {
      newHead = replayed;
      via = "rebase";
    } else {
      // Two cases, one answer. Either the replay produced a **different
      // tree** — a legitimate rebase outcome, dropped merges change what the
      // commits apply to, but not one this rung may push — or it was a
      // **no-op**: the branch was already linear off the base, so `HEAD` did
      // not move and pushing it back would give GitHub nothing new to judge
      // while the comment claimed a linearisation that never happened. Throw
      // the replay away and take the fallback, which always produces a new
      // commit carrying the same tree.
      logger?.info?.(
        replayed === oldHead
          ? "Rebase rung: the replay moved nothing — squashing instead"
          : "Rebase rung: the replayed tree differs from the judged head — " +
            "squashing instead",
        { branchName, baseBranch, oldHead },
      );
      await resetHard(run, cwd, oldHead, "after the replay was rejected");
      newHead = await replaceWithSquashOfOldTree(request, oldHead, runId);
      via = "squash";
    }
  }

  // (Step 5 — building the fallback commit and asserting its tree — lives in
  // `replaceWithSquashOfOldTree`, which both branches above call.)
  //
  // 6. The lease pins the remote to the head GitHub judged, so a push races
  //    nothing: if anybody moved the branch since, the push is refused rather
  //    than overwriting them.
  const push = await git(
    run,
    buildPushArgs("origin", branchName, {
      forceWithLease: `--force-with-lease=${branchName}:${oldHead}`,
    }),
    cwd,
  );
  if (push.code !== 0) {
    await resetHard(run, cwd, oldHead, "after the push was refused");
    return { kind: "push-refused", detail: detailOf(push) };
  }

  logger?.info?.("Rebase rung: pushed a head whose tree equals the old head", {
    branchName,
    baseBranch,
    oldHead,
    newHead,
    via,
  });

  return { kind: "pushed", oldHead, newHead, via };
}
