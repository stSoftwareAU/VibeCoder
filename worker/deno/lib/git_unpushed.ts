/**
 * Honest unpushed-commit counting (Issue #211).
 *
 * "How many of my commits are not on the remote branch?" was measured with
 * `git rev-list --count HEAD --not --remotes=origin` — commits reachable from
 * HEAD but from no *locally tracked* origin ref. That is only the same
 * question when the clone tracks the branch. It does not in a single-branch
 * clone: the fetch refspec covers the default branch alone, so `git push -u`
 * never creates `refs/remotes/origin/<feature>` (git still prints "set up to
 * track", but no ref is stored) and the count silently degrades to "commits
 * ahead of Develop".
 *
 * Live consequence (NEAT-AI-core PR #557): a push of 4 commits succeeded and
 * was reported as `commitsPushed=4 finalUnpushedCount=4`, which triggered a
 * pointless rebase recovery, a "please check the branch status" comment aimed
 * at a human, and a `merge-conflict` label on a PR that was mergeable.
 *
 * The measure here always resolves the branch's real remote head first,
 * fetching the tracking ref explicitly when the clone's refspec does not cover
 * it, and never reports a number it could not measure — an unmeasurable count
 * is an error Result, not a quiet zero.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import {
  assertSafeRefComponent,
  buildFetchTrackingRefArgs,
} from "./git_ref_args.ts";

/** Which remote reference the count was measured against. */
export type UnpushedMeasure =
  /** `refs/remotes/origin/<branch>` was already present locally. */
  | "remote-tracking-ref"
  /** The tracking ref was missing and was fetched from the remote. */
  | "fetched-remote-branch"
  /** The branch does not exist on the remote yet (first push pending). */
  | "no-remote-branch";

/** Outcome of {@link countUnpushedCommits}. */
export interface UnpushedCommits {
  /** Commits on HEAD that the remote branch does not have. */
  count: number;
  /** How the count was measured — logged so a 0 can be trusted. */
  measuredAgainst: UnpushedMeasure;
}

/** Read `refs/remotes/<remote>/<branch>`, or null when it does not exist. */
async function readTrackingSha(
  branchName: string,
  options: GitCommandOptions,
): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    options,
  );
  if (!result.ok || result.value.code !== 0) return null;
  return result.value.stdout.trim() || null;
}

/** Count commits in a rev-list range, failing loudly when git cannot. */
async function revListCount(
  args: string[],
  branchName: string,
  options: GitCommandOptions,
): Promise<Result<number>> {
  const result = await runGitCommand(args, options);
  if (!result.ok) return { ok: false, error: result.error };
  if (result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Could not count unpushed commits for '${branchName}': ` +
          `git ${args.join(" ")} exited ${result.value.code}: ` +
          `${result.value.stderr.trim() || "no stderr"}`,
      ),
    };
  }
  const count = Number.parseInt(result.value.stdout.trim(), 10);
  if (!Number.isFinite(count)) {
    return {
      ok: false,
      error: new Error(
        `Could not count unpushed commits for '${branchName}': ` +
          `git printed '${result.value.stdout.trim()}'`,
      ),
    };
  }
  return { ok: true, value: count };
}

/**
 * Count the commits on HEAD that the branch's remote head does not have.
 *
 * @param branchName - The branch being pushed (its remote head is the yardstick)
 * @param options - Git command options (cwd selects the repo)
 * @returns The count and how it was measured, or an error when the state
 *   could not be measured at all (never a silent 0).
 */
export async function countUnpushedCommits(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<UnpushedCommits>> {
  try {
    assertSafeRefComponent(branchName, "unpushed-count branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  let measuredAgainst: UnpushedMeasure = "remote-tracking-ref";
  let remoteSha = await readTrackingSha(branchName, options);

  if (remoteSha === null) {
    // The clone's refspec does not cover this branch — ask the remote for it
    // directly. A branch that does not exist there yet simply leaves the ref
    // missing (the first-push case handled below).
    await runGitCommand(
      buildFetchTrackingRefArgs("origin", branchName),
      options,
    );
    remoteSha = await readTrackingSha(branchName, options);
    measuredAgainst = remoteSha === null
      ? "no-remote-branch"
      : "fetched-remote-branch";
  }

  if (measuredAgainst === "no-remote-branch") {
    // Nothing to compare against: every commit not on some other origin ref
    // is genuinely unpushed, which is exactly what a first push must send.
    const counted = await revListCount(
      ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      branchName,
      options,
    );
    if (!counted.ok) return { ok: false, error: counted.error };
    return { ok: true, value: { count: counted.value, measuredAgainst } };
  }

  // Fast path: the remote head *is* our HEAD, so nothing is unpushed. Decided
  // on object ids alone, so a shallow clone's truncated history cannot turn a
  // successful push into an unmeasurable one.
  const headResult = await runGitCommand(["rev-parse", "HEAD"], options);
  if (headResult.ok && headResult.value.code === 0) {
    if (headResult.value.stdout.trim() === remoteSha) {
      return { ok: true, value: { count: 0, measuredAgainst } };
    }
  }

  const counted = await revListCount(
    ["rev-list", "--count", `refs/remotes/origin/${branchName}..HEAD`],
    branchName,
    options,
  );
  if (!counted.ok) return { ok: false, error: counted.error };
  return { ok: true, value: { count: counted.value, measuredAgainst } };
}
