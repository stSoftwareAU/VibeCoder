/**
 * Honest "how much of my work is not on origin?" count (Issue #211).
 *
 * Every fleet workdir is a **single-branch clone**: its fetch refspec maps
 * only the default branch, so `refs/remotes/origin/<feature-branch>` never
 * exists — not even after a successful `git push -u`, because push only
 * updates a remote-tracking ref the refspec covers. The old count fell back
 * to `rev-list --count HEAD --not --remotes=origin`, which in that clone
 * means "commits ahead of Develop". A fully pushed four-commit branch
 * therefore reported four unpushed commits, and the worker declared its own
 * good push a failure: bogus rejection recovery, a "please check the branch
 * status" comment addressed to a human, and a `merge-conflict` label on a PR
 * that was perfectly mergeable (NEAT-AI-core #557, #563).
 *
 * This module resolves the remote head of the branch itself and counts
 * against that. It never reports "0 unpushed" from a lookup that failed —
 * an undeterminable remote state is a loud error, because "no failure
 * marker" is not success.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { assertSafeGitRef, buildFetchArgs } from "./git_ref_args.ts";

/** Matches a git object id (SHA-1 or SHA-256). */
const OBJECT_ID_PATTERN = /^[0-9a-f]{7,64}$/;

/** How the remote head used for the count was established. */
export type UnpushedCountSource =
  /** `refs/remotes/origin/<branch>` existed locally — no network needed. */
  | "tracking-ref"
  /** The tracking ref was absent, so the branch was fetched from origin. */
  | "fetched-head"
  /** The branch does not exist on origin yet — every local commit is unpushed. */
  | "no-remote-branch";

/** Outcome of {@link countUnpushedCommits}. */
export interface UnpushedCommitCount {
  /** Commits on HEAD that the remote branch does not have (0 = in sync). */
  count: number;
  /** The remote head, or null when the branch is not on origin yet. */
  remoteSha: string | null;
  /** How {@link remoteSha} was established. */
  source: UnpushedCountSource;
}

/** Read a ref, returning its object id or null when it does not exist. */
async function resolveRef(
  ref: string,
  options: GitCommandOptions,
): Promise<string | null> {
  const result = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", ref],
    options,
  );
  if (!result.ok || result.value.code !== 0) return null;
  const sha = result.value.stdout.trim();
  return OBJECT_ID_PATTERN.test(sha) ? sha : null;
}

/** Count commits reachable from HEAD but not from `sha`. */
async function countAhead(
  sha: string,
  options: GitCommandOptions,
): Promise<Result<number>> {
  const result = await runGitCommand(
    ["rev-list", "--count", "--end-of-options", `${sha}..HEAD`],
    options,
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git rev-list ${sha}..HEAD failed: ${
          result.value.stderr.trim() || "no stderr"
        }`,
      ),
    };
  }
  return { ok: true, value: parseInt(result.value.stdout.trim(), 10) || 0 };
}

/**
 * Count the commits on HEAD that origin's copy of `branchName` does not have.
 *
 * Resolution order:
 *
 *   1. `refs/remotes/origin/<branch>` when the clone tracks it (full clones,
 *      and any clone whose refspec covers the branch) — no network call.
 *   2. Otherwise `git fetch origin <branch>` and count against `FETCH_HEAD`.
 *      This is the single-branch-clone path every fleet workdir takes; the
 *      fetch also brings down objects a sibling host pushed, so the count is
 *      against the *current* remote head rather than a stale local view.
 *   3. When origin has no such branch (first push of a new feature branch),
 *      count every commit not reachable from any origin ref — the correct
 *      "all of this is new" answer that Issue #1463 depends on.
 *
 * Any other failure (unreachable remote, broken repo) is returned as an
 * error. Callers must never treat that as "nothing to push".
 *
 * @param branchName - The branch whose remote copy to compare against
 * @param options - Git command options (cwd selects the repo)
 * @returns The count, the remote head it was measured against, and how that
 *   head was resolved
 */
export async function countUnpushedCommits(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<UnpushedCommitCount>> {
  let fetchArgs: string[];
  try {
    assertSafeGitRef(branchName, "unpushed-count branch name");
    fetchArgs = buildFetchArgs("origin", branchName);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // 1. Local remote-tracking ref — authoritative and free when it exists.
  const trackingSha = await resolveRef(
    `refs/remotes/origin/${branchName}`,
    options,
  );
  if (trackingSha !== null) {
    const counted = await countAhead(trackingSha, options);
    if (!counted.ok) return { ok: false, error: counted.error };
    return {
      ok: true,
      value: {
        count: counted.value,
        remoteSha: trackingSha,
        source: "tracking-ref",
      },
    };
  }

  // 2. No tracking ref (single-branch clone) — ask origin directly.
  const fetchResult = await runGitCommand(fetchArgs, options);
  if (!fetchResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Cannot determine how many commits of '${branchName}' are unpushed: ` +
          `git fetch origin ${branchName} could not run — ` +
          `${fetchResult.error.message}`,
      ),
    };
  }

  if (fetchResult.value.code !== 0) {
    const stderr = fetchResult.value.stderr.trim();
    // 3. The branch simply does not exist on origin yet — first push.
    if (/couldn't find remote ref|no such ref|not our ref/i.test(stderr)) {
      const orphanCount = await runGitCommand(
        ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
        options,
      );
      if (!orphanCount.ok || orphanCount.value.code !== 0) {
        return {
          ok: false,
          error: new Error(
            `Cannot determine how many commits of '${branchName}' are ` +
              `unpushed: origin has no such branch and counting local-only ` +
              `commits failed — ${
                orphanCount.ok
                  ? orphanCount.value.stderr.trim() || "no stderr"
                  : orphanCount.error.message
              }`,
          ),
        };
      }
      return {
        ok: true,
        value: {
          count: parseInt(orphanCount.value.stdout.trim(), 10) || 0,
          remoteSha: null,
          source: "no-remote-branch",
        },
      };
    }

    return {
      ok: false,
      error: new Error(
        `Cannot determine how many commits of '${branchName}' are unpushed: ` +
          `git fetch origin ${branchName} failed — ${stderr || "no stderr"}`,
      ),
    };
  }

  const fetchedSha = await resolveRef("FETCH_HEAD", options);
  if (fetchedSha === null) {
    return {
      ok: false,
      error: new Error(
        `Cannot determine how many commits of '${branchName}' are unpushed: ` +
          `git fetch origin ${branchName} succeeded but FETCH_HEAD could not ` +
          `be resolved`,
      ),
    };
  }

  const counted = await countAhead(fetchedSha, options);
  if (!counted.ok) return { ok: false, error: counted.error };
  return {
    ok: true,
    value: {
      count: counted.value,
      remoteSha: fetchedSha,
      source: "fetched-head",
    },
  };
}
