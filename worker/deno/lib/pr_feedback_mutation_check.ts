/**
 * The review-fix run's diff-scoped mutation check (Issue #3750).
 *
 * Issue #3393 mutates the lines a PR adds, and the completion phase runs it
 * once before the PR is raised. A review-fix run adds commits to a PR that
 * already exists, so the lines it must answer for are the lines THIS run added
 * since `beforeSha` (the branch head before the run), not the whole PR diff.
 *
 * Scope rule: the run's own lines are the working tree's lines that are not in
 * the baseline "beforeSha plus whatever the run merged in". Lines a merge
 * brought in (for example the agent ran `git merge origin/main`) are not the
 * run's own, so they are excluded. The baseline is `merge-tree` of `beforeSha`
 * and the merged parent, which is the tree the branch would have had if it had
 * merged that parent before the run. The new side is the working tree, so
 * uncommitted edits count (the worker commits them afterwards), and untracked
 * files count as wholly added.
 *
 * Nothing here writes refs or commits: `merge-tree --write-tree` only writes
 * tree objects.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Logger, RepoConfig, Result } from "../types.ts";
import { invokeMutationCheck } from "./mutation_check_invocation.ts";
import type { MutationCheckResult } from "./mutation_gate.ts";
import type { MutationRunInput } from "./mutation_runner.ts";
import { isWorkerStatePath } from "./worker_state_paths.ts";

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
 * The unified=0 diff of only the lines this run added since `beforeSha`, with
 * lines brought in by a merge excluded (Issue #3750). Each error names its
 * cause; a run that merged two unrelated histories is refused, because its own
 * lines cannot then be told apart from the merged ones.
 */
export async function collectRunOwnDiff(
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
    // resolution lines, which are mutated as the run's own on purpose.
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

  // 2. The tracked lines: the old side against the working tree.
  const tracked = await runGit([
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    oldSide,
    "--",
  ]);
  if (tracked === null || tracked.code !== 0) {
    return {
      ok: false,
      error: failure("diffing the run's own tracked lines", tracked),
    };
  }
  let diff = tracked.stdout;

  // 3. Untracked files count as wholly added. Worker state files never do.
  const untracked = await runGit([
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (untracked === null || untracked.code !== 0) {
    return {
      ok: false,
      error: failure("listing the untracked files", untracked),
    };
  }
  for (const path of [] as string[]) {
    if (path === "" || isWorkerStatePath(path)) continue;
    // `--no-index` exits 1 when the files differ, which is the expected case.
    const added = await runGit([
      "diff",
      "--no-index",
      "--unified=0",
      "--no-color",
      "--",
      "/dev/null",
      path,
    ]);
    if (added === null || (added.code !== 0 && added.code !== 1)) {
      return {
        ok: false,
        error: failure(`diffing the untracked file ${path}`, added),
      };
    }
    diff += added.stdout;
  }
  return { ok: true, value: diff };
}

export interface ReviewFixMutationInput {
  repo: string;
  repoPath: string;
  /** The branch head before the review-fix run began. */
  beforeSha: string;
  repoConfigs: Record<string, RepoConfig> | undefined;
}

export interface ReviewFixMutationDeps {
  runGit: RunGit;
  /** The wired runner (`WorkerDeps.quality.runMutationCheck`); absent → not applicable. */
  runner:
    | ((input: MutationRunInput) => Promise<MutationCheckResult>)
    | undefined;
  logger: Pick<Logger, "info" | "warn">;
}

/**
 * The review-fix run's mutation verdict input: the shared invocation (Issue
 * #3393) fed with the lines this run added (Issue #3750).
 */
export function runReviewFixMutationCheck(
  input: ReviewFixMutationInput,
  deps: ReviewFixMutationDeps,
): Promise<MutationCheckResult> {
  return invokeMutationCheck({
    repo: input.repo,
    repoPath: input.repoPath,
    repoConfigs: input.repoConfigs,
    runner: deps.runner,
    logger: deps.logger,
    collectDiff: () => collectRunOwnDiff(deps.runGit, input.beforeSha),
  });
}
