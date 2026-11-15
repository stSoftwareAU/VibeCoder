/**
 * The baseline for a review-fix run's own changes (Issue #3750).
 *
 * A review-fix run adds commits to a PR that already exists, so the lines it
 * answers for are the lines THIS run added since `beforeSha` (the branch head
 * before the run), not the whole PR diff. The post-agent drift check diffs
 * against this baseline (Issue #4155). The diff-scoped mutation check that
 * also used it was retired (Issue #5095).
 *
 * Scope rule: the run's own lines are the working tree's lines that are not in
 * the baseline "beforeSha plus whatever the run merged in". Lines a merge
 * brought in (for example the agent ran `git merge origin/main`) are not the
 * run's own, so they are excluded. The baseline is `merge-tree` of `beforeSha`
 * and the merged parent, which is the tree the branch would have had if it had
 * merged that parent before the run.
 *
 * Nothing here writes refs or commits: `merge-tree --write-tree` only writes
 * tree objects.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";

type RunGit = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string } | null>;

/** A git tree or commit object id (SHA-1 or SHA-256). */
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/**
 * Name the step and git's first stderr line as the cause, so no failure reads
 * as a bare "failed".
 */
function failure(
  step: string,
  result: { code: number; stderr: string } | null,
): Error {
  if (result === null) return new Error(`${step}: git could not be run`);
  const cause = result.stderr.split("\n").map((line) => line.trim()).find((
    line,
  ) => line !== "");
  return new Error(
    `${step} (exit ${result.code}): ${cause ?? "git gave no message"}`,
  );
}

/**
 * The baseline for this run’s own changes since `beforeSha`, with
 * lines brought in by a merge excluded (Issue #3750). Each error names its
 * cause; a run that merged two unrelated histories is refused, because its own
 * lines cannot then be told apart from the merged ones.
 */
export async function collectRunOwnBaseline(
  runGit: RunGit,
  beforeSha: string,
): Promise<Result<string>> {
  // 1. The merges this run made, oldest first. Each line is "M P1 P2 [P3...]".
  const merges = await runGit([
    "rev-list",
    "--merges",
    "--parents",
    "--reverse",
    `${beforeSha}..HEAD`,
  ]);
  if (merges === null || merges.code !== 0) {
    return {
      ok: false,
      error: failure("listing the merges since the run began", merges),
    };
  }
  const mergeTokens = merges.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/));

  // The side the diff is taken from: the run's start, or the baseline when
  // the run merged something in.
  let oldSide = beforeSha;
  const newest = mergeTokens[mergeTokens.length - 1];
  if (newest !== undefined) {
    // The first foreign parent of the newest merge is the history it brought
    // in last; every other foreign parent must already be contained in it.
    const first = newest[2];
    if (first === undefined) {
      return {
        ok: false,
        error: new Error(
          `the newest merge (${newest[0]}) names no second parent to merge`,
        ),
      };
    }
    const foreign = mergeTokens.flatMap((tokens) => tokens.slice(2));
    for (const other of foreign) {
      const contained = await runGit([
        "merge-base",
        "--is-ancestor",
        other,
        first,
      ]);
      if (
        contained === null || (contained.code !== 0 && contained.code !== 1)
      ) {
        return {
          ok: false,
          error: failure(
            `checking that ${other} is contained in ${first}`,
            contained,
          ),
        };
      }
      if (contained.code === 1) {
        return {
          ok: false,
          error: new Error(
            `this run merged more than one unrelated history (${other} is not contained in ${first}), so its own lines cannot be separated from the merged ones`,
          ),
        };
      }
    }
    // Exit 1 is a conflicted merge, and its markers are the run's own
    // resolution lines, so they stay in the run's own changes.
    const baseline = await runGit([
      "merge-tree",
      "--write-tree",
      "--no-messages",
      beforeSha,
      first,
    ]);
    if (baseline === null || (baseline.code !== 0 && baseline.code !== 1)) {
      return {
        ok: false,
        error: failure("building the run's baseline with merge-tree", baseline),
      };
    }
    const treeId = baseline.stdout.split("\n")[0]?.trim() ?? "";
    if (!OBJECT_ID.test(treeId)) {
      return {
        ok: false,
        error: failure(
          "merge-tree did not print a tree id for the run's baseline",
          baseline,
        ),
      };
    }
    oldSide = treeId;
  }

  return { ok: true, value: oldSide };
}
