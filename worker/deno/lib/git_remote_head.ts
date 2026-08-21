/**
 * Remote-head resolution and honest unpushed counting (Issue #211).
 *
 * `git rev-list --count HEAD --not --remotes=origin` only answers "how many of
 * my commits are unpushed" when a remote-tracking ref exists for the branch.
 * When it does not — a single-branch clone, whose `remote.origin.fetch` covers
 * only the default branch, never gains `refs/remotes/origin/<feature>` even
 * after a successful `git push -u` — the count silently degrades to "commits
 * ahead of the default branch". A perfectly good push then reports 4 commits
 * still unpushed, which triggered a bogus recovery, a "please check the branch
 * status" comment to a human, and a spurious `merge-conflict` label on a PR
 * that was mergeable (NEAT-AI-core #557, #563).
 *
 * The fix is to measure against the branch's *own* remote head:
 *   1. `refs/remotes/origin/<branch>` when it exists (free, offline, and kept
 *      current by git itself on any clone with a wildcard fetch refspec);
 *   2. otherwise `git ls-remote --heads origin <branch>` — authoritative
 *      regardless of the local refspec;
 *   3. and when the branch genuinely is not on the remote, every commit not
 *      reachable from an origin ref is unpushed (the first-push case).
 *
 * Fails loud: when neither the tracking ref nor `ls-remote` can answer, the
 * count is unknowable and an error Result carrying git's own stderr is
 * returned rather than a fabricated 0.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { assertSafeGitRef, buildFetchArgs } from "./git_ref_args.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";

/** Matches a full git object id (SHA-1 or SHA-256). */
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Where a branch's remote head came from. */
export type RemoteHeadSource = "tracking-ref" | "ls-remote" | "absent";

/** The remote head of a branch, and how it was resolved. */
export interface RemoteBranchHead {
  /** The remote head SHA, or `null` when the branch is not on the remote. */
  sha: string | null;
  /** How the answer was obtained. */
  source: RemoteHeadSource;
}

/**
 * Resolve the remote head of a branch (Issue #211).
 *
 * @param branchName - The branch to resolve (untrusted positional)
 * @param options - Git command options (cwd selects the repo)
 * @returns The remote head SHA and its source, or an error Result when the
 *   remote state cannot be determined at all.
 */
export async function resolveRemoteBranchHead(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<RemoteBranchHead>> {
  try {
    assertSafeGitRef(branchName, "branch name");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // 1. The remote-tracking ref, when the clone keeps one for this branch.
  const trackingResult = await runGitCommand(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    options,
  );
  if (trackingResult.ok && trackingResult.value.code === 0) {
    const sha = trackingResult.value.stdout.trim();
    if (OBJECT_ID_PATTERN.test(sha)) {
      return { ok: true, value: { sha, source: "tracking-ref" } };
    }
  }

  // 2. Ask the remote directly — correct on a single-branch clone, and on any
  //    clone whose tracking ref was never fetched or has been pruned.
  const lsRemoteResult = await runGitCommand(
    ["ls-remote", "--heads", "--end-of-options", "origin", branchName],
    options,
  );
  if (!lsRemoteResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Cannot determine the remote head of '${branchName}': ` +
          `git ls-remote failed: ${lsRemoteResult.error.message}`,
      ),
    };
  }
  if (lsRemoteResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Cannot determine the remote head of '${branchName}': ` +
          `git ls-remote exited ${lsRemoteResult.value.code}: ` +
          `${lsRemoteResult.value.stderr.trim() || "no stderr"}`,
      ),
    };
  }

  const sha = parseLsRemoteSha(lsRemoteResult.value.stdout, branchName);
  if (sha === null) {
    // 3. The branch really is not on the remote yet (first push).
    return { ok: true, value: { sha: null, source: "absent" } };
  }
  return { ok: true, value: { sha, source: "ls-remote" } };
}

/**
 * Extract the SHA for `refs/heads/<branchName>` from `git ls-remote` output.
 *
 * Exported for testing: the output is one `<sha>\t<ref>` line per matching
 * ref, and `--heads <pattern>` matches by suffix, so `feature` would also
 * match `refs/heads/other/feature` — only the exact ref counts.
 *
 * @param stdout - Raw `git ls-remote` output
 * @param branchName - The branch whose ref to match exactly
 * @returns The SHA, or null when the exact ref is absent
 */
export function parseLsRemoteSha(
  stdout: string,
  branchName: string,
): string | null {
  for (const line of stdout.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref !== `refs/heads/${branchName}`) continue;
    if (!OBJECT_ID_PATTERN.test(sha)) continue;
    return sha;
  }
  return null;
}

/** How far `HEAD` is ahead of the branch's remote head (Issue #211). */
export interface UnpushedState extends RemoteBranchHead {
  /** Commits on `HEAD` the remote head does not have (0 = fully pushed). */
  count: number;
}

/**
 * Resolve the remote head of a branch and count what `HEAD` has beyond it
 * (Issue #211).
 *
 * Callers that need both facts (the push path needs to know whether the branch
 * exists remotely at all) use this to pay for the remote lookup once.
 *
 * @param branchName - The branch being pushed (untrusted positional)
 * @param options - Git command options (cwd selects the repo)
 * @returns The remote head, its source, and the unpushed count — or an error
 *   Result when the remote state cannot be determined.
 */
export async function describeUnpushedCommits(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<UnpushedState>> {
  const headResult = await resolveRemoteBranchHead(branchName, options);
  if (!headResult.ok) {
    return { ok: false, error: headResult.error };
  }

  const { sha, source } = headResult.value;
  const countResult = await countAgainstRemoteHead(sha, branchName, options);
  if (!countResult.ok) {
    return { ok: false, error: countResult.error };
  }
  return { ok: true, value: { sha, source, count: countResult.value } };
}

/**
 * Count the commits on `HEAD` that the branch's remote head does not have
 * (Issue #211).
 *
 * @param branchName - The branch being pushed (untrusted positional)
 * @param options - Git command options (cwd selects the repo)
 * @returns The number of unpushed commits (0 = fully pushed), or an error
 *   Result when the remote state cannot be determined.
 */
export async function countUnpushedCommits(
  branchName: string,
  options: GitCommandOptions = {},
): Promise<Result<number>> {
  const state = await describeUnpushedCommits(branchName, options);
  return state.ok ? { ok: true, value: state.value.count } : state;
}

/**
 * Count `HEAD` against a resolved remote head.
 *
 * @param sha - The remote head SHA, or null when the branch is not on the remote
 * @param branchName - The branch being counted (for messages and the fetch)
 * @param options - Git command options
 * @returns The unpushed commit count
 */
async function countAgainstRemoteHead(
  sha: string | null,
  branchName: string,
  options: GitCommandOptions,
): Promise<Result<number>> {
  // The branch is not on the remote — everything not reachable from an origin
  // ref is unpushed. This is the only case `--remotes=origin` answers
  // correctly, and it is the first-push case.
  if (sha === null) {
    return await countRevList(
      ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
      options,
      `count commits not yet on origin for '${branchName}'`,
    );
  }

  const localHead = await runGitCommand(["rev-parse", "HEAD"], options);
  if (localHead.ok && localHead.value.code === 0) {
    if (localHead.value.stdout.trim() === sha) return { ok: true, value: 0 };
  }

  // Count against the remote head. The object may be missing locally on a
  // shallow clone or when a sibling pushed it, so fetch the branch once
  // before giving up.
  const direct = await countRevList(
    ["rev-list", "--count", `${sha}..HEAD`],
    options,
    `count commits ahead of origin/${branchName}`,
  );
  if (direct.ok) return direct;

  const fetchResult = await runGitCommand(
    buildFetchArgs("origin", branchName),
    options,
  );
  if (!fetchResult.ok || fetchResult.value.code !== 0) {
    const detail = fetchResult.ok
      ? fetchResult.value.stderr.trim() || `exit ${fetchResult.value.code}`
      : fetchResult.error.message;
    return {
      ok: false,
      error: new Error(
        `Cannot count unpushed commits for '${branchName}': the remote head ` +
          `${sha} is not present locally and fetching it failed: ${detail}`,
      ),
    };
  }

  return await countRevList(
    ["rev-list", "--count", `${sha}..HEAD`],
    options,
    `count commits ahead of origin/${branchName} after fetch`,
  );
}

/**
 * Run a `rev-list --count` and parse its output, failing loud on a bad exit.
 *
 * @param args - Full git argv
 * @param options - Git command options
 * @param what - Short description used in the error message
 * @returns The parsed count, or an error Result carrying git's stderr
 */
async function countRevList(
  args: string[],
  options: GitCommandOptions,
  what: string,
): Promise<Result<number>> {
  const result = await runGitCommand(args, options);
  if (!result.ok) {
    return {
      ok: false,
      error: new Error(`Failed to ${what}: ${result.error.message}`),
    };
  }
  if (result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `Failed to ${what}: git exited ${result.value.code}: ` +
          `${result.value.stderr.trim() || "no stderr"}`,
      ),
    };
  }
  const parsed = parseInt(result.value.stdout.trim(), 10);
  if (Number.isNaN(parsed)) {
    return {
      ok: false,
      error: new Error(
        `Failed to ${what}: git printed '${result.value.stdout.trim()}'`,
      ),
    };
  }
  return { ok: true, value: parsed };
}
