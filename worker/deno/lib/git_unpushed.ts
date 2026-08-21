/**
 * Remote-authoritative unpushed-commit counting (Issue #211).
 *
 * The worker used to answer "did my push land?" with
 * `git rev-list --count HEAD --not --remotes=origin` — the number of commits
 * not reachable from ANY `origin/*` remote-tracking ref. That is wrong on a
 * `--single-branch` clone: its fetch refspec covers the default branch only, so
 * `git push -u origin <feature>` never creates `refs/remotes/origin/<feature>`
 * and every commit of a perfectly good push still looked unpushed. Live, that
 * produced `commitsPushed=4 finalUnpushedCount=4`, a bogus recovery attempt, a
 * "please check the branch status" comment to a human, and a spurious
 * `merge-conflict` label on a PR that was mergeable (NEAT-AI-core #557, #563).
 *
 * This module answers the same question against the branch as it actually
 * stands on the remote, and always names how it got its answer so a caller can
 * log it. It never throws — on failure it degrades to the local count and says
 * so via `source: "local-fallback"` plus a populated `detail`, so a degraded
 * answer is never mistaken for an authoritative one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { assertSafeGitRef, buildFetchArgs } from "./git_ref_args.ts";

/** Matches a full git object id (SHA-1 or SHA-256). */
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/i;

/** How an unpushed count was established. */
export type UnpushedCountSource =
  /** Counted against the local `origin/<branch>` tracking ref. */
  | "tracking-ref"
  /** Counted against the branch tip the remote itself reported. */
  | "remote-head"
  /** The branch does not exist on the remote — everything is unpushed. */
  | "remote-absent"
  /** The remote could not be consulted; the local-only count was used. */
  | "local-fallback";

/** Outcome of {@link countUnpushedCommits}. */
export interface UnpushedCount {
  /** Commits reachable from HEAD that the remote branch does not have. */
  count: number;
  /** How the count was established. */
  source: UnpushedCountSource;
  /** Why the remote could not be consulted (set for `local-fallback`). */
  detail?: string;
}

/** Read a count from `git rev-list --count …`, or null when the probe fails. */
async function revListCount(
  args: string[],
  options: GitCommandOptions,
): Promise<number | null> {
  const result = await runGitCommand(["rev-list", "--count", ...args], options);
  if (!result.ok || result.value.code !== 0) return null;
  const parsed = parseInt(result.value.stdout.trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The local-only count — commits on no `origin/*` ref at all. */
async function localOnlyCount(options: GitCommandOptions): Promise<number> {
  return await revListCount(["HEAD", "--not", "--remotes=origin"], options) ??
    0;
}

/** Whether `sha` names a commit object present in this clone. */
async function commitExistsLocally(
  sha: string,
  options: GitCommandOptions,
): Promise<boolean> {
  const result = await runGitCommand(
    ["cat-file", "-e", `${sha}^{commit}`],
    options,
  );
  return result.ok && result.value.code === 0;
}

/** The remote tip of `branchName`, or how the lookup failed. */
async function lookupRemoteTip(
  branchName: string,
  options: GitCommandOptions,
): Promise<{ sha: string | null; detail?: string }> {
  const result = await runGitCommand(
    ["ls-remote", "--end-of-options", "origin", `refs/heads/${branchName}`],
    options,
  );
  if (!result.ok) return { sha: null, detail: result.error.message };
  if (result.value.code !== 0) {
    return {
      sha: null,
      detail: result.value.stderr.trim() ||
        `ls-remote exit ${result.value.code}`,
    };
  }

  const firstLine = result.value.stdout.split("\n")[0]?.trim() ?? "";
  if (firstLine === "") {
    // Empty output is a definitive answer: the remote has no such branch.
    return { sha: null };
  }
  const sha = firstLine.split(/\s+/)[0] ?? "";
  if (!OBJECT_ID_PATTERN.test(sha)) {
    return {
      sha: null,
      detail: `ls-remote returned no SHA for refs/heads/${branchName}`,
    };
  }
  return { sha };
}

/**
 * Count the commits on HEAD that the remote branch does not yet have
 * (Issue #211).
 *
 * Resolution order:
 *   1. The local `origin/<branch>` tracking ref, when it already contains HEAD.
 *      A tracking ref that contains HEAD proves the remote had those commits,
 *      so this needs no network call — the ordinary full-clone happy path.
 *   2. `git ls-remote origin refs/heads/<branch>` — the remote's own answer.
 *      When the reported tip is unknown locally (a fleet sibling pushed while
 *      we worked), it is fetched so the count is against the real head.
 *   3. On any failure to consult the remote, the local-only count, flagged as
 *      `local-fallback` with the reason in `detail`.
 *
 * @param branchName - The branch whose remote state to compare HEAD against
 * @param options - Git command options (cwd selects the clone)
 * @returns The count, how it was established, and any failure detail. Never
 *   throws: an unsafe branch name degrades to `local-fallback` with detail.
 */
export async function countUnpushedCommits(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<UnpushedCount> {
  try {
    assertSafeGitRef(branchName, "unpushed-count branch name");
  } catch (err) {
    return {
      count: await localOnlyCount(options),
      source: "local-fallback",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // 1. Local tracking ref — only trusted when it already contains HEAD.
  const trackingCount = await revListCount(
    [`refs/remotes/origin/${branchName}..HEAD`],
    options,
  );
  if (trackingCount === 0) {
    return { count: 0, source: "tracking-ref" };
  }

  // 2. Ask the remote what the branch actually points at.
  const tip = await lookupRemoteTip(branchName, options);
  if (tip.sha === null && tip.detail === undefined) {
    return { count: await localOnlyCount(options), source: "remote-absent" };
  }
  if (tip.sha === null) {
    return {
      count: trackingCount ?? await localOnlyCount(options),
      source: "local-fallback",
      detail: tip.detail,
    };
  }

  // Fetch the tip when this clone has never seen it, so the count is against
  // the real remote head rather than a stale local approximation.
  if (!await commitExistsLocally(tip.sha, options)) {
    const fetchResult = await runGitCommand(
      buildFetchArgs("origin", branchName),
      options,
    );
    const fetchFailed = !fetchResult.ok || fetchResult.value.code !== 0 ||
      !await commitExistsLocally(tip.sha, options);
    if (fetchFailed) {
      const detail = fetchResult.ok
        ? fetchResult.value.stderr.trim() ||
          `fetch origin ${branchName} did not produce ${tip.sha.slice(0, 7)}`
        : fetchResult.error.message;
      return {
        count: trackingCount ?? await localOnlyCount(options),
        source: "local-fallback",
        detail,
      };
    }
  }

  const remoteCount = await revListCount([`${tip.sha}..HEAD`], options);
  if (remoteCount === null) {
    return {
      count: trackingCount ?? await localOnlyCount(options),
      source: "local-fallback",
      detail: `rev-list ${tip.sha.slice(0, 7)}..HEAD failed`,
    };
  }
  return { count: remoteCount, source: "remote-head" };
}
