/**
 * Find an issue's pushed work by issue number, not by title slug (Issue #220).
 *
 * The resume contract (#47, #148, #4170) checkpointed WIP onto the branch
 * whose name is derived from the issue *title*. Retitle the issue — a human
 * tidying it, the clarity pass rewriting it, or two hosts truncating the slug
 * differently — and the next claim derives a different name, never looks at
 * the pushed branch, and starts from scratch (VibeCoder#211 orphaned a
 * 20-file WIP commit that way).
 *
 * The issue number is the only stable part of the name, so discovery keys on
 * it: `git ls-remote --heads origin refs/heads/issue-<N> refs/heads/issue-<N>-*`
 * lists every branch the fleet has ever pushed for the issue, whatever the
 * title was at the time.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import {
  assertSafeGitRef,
  buildFetchArgs,
  buildFetchTrackingRefArgs,
} from "./git_ref_args.ts";

/** One branch on the remote that may carry the issue's prior work. */
export interface RemoteIssueBranch {
  /** Short branch name, e.g. `issue-211-false-push-failed`. */
  branch: string;
  /** Tip commit SHA as reported by `ls-remote`. */
  sha: string;
}

/**
 * Ref patterns naming every branch that belongs to an issue.
 *
 * `ls-remote` matches each pattern against the tail of the ref, so
 * `refs/heads/issue-220-*` matches `issue-220-anything` while excluding
 * `issue-2200-other` and `wip-issue-220-x`.
 *
 * @param issueNumber - The issue number (must be a positive integer).
 * @param extraRefs - Additional exact branch names to look up, e.g. the
 *   branch recorded in the resume file, whose name may predate a retitle.
 */
export function issueBranchRefPatterns(
  issueNumber: number,
  extraRefs: readonly string[] = [],
): string[] {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `Refusing to run git: issue number must be a positive integer (got '${issueNumber}')`,
    );
  }
  const patterns = [
    `refs/heads/issue-${issueNumber}`,
    `refs/heads/issue-${issueNumber}-*`,
  ];
  for (const ref of extraRefs) {
    if (ref === "") continue;
    assertSafeGitRef(ref, "ls-remote ref");
    const pattern = `refs/heads/${ref}`;
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

/**
 * Parse `git ls-remote --heads` output into branch/SHA pairs.
 *
 * Lines are `<sha>\t<ref>`; anything that is not a `refs/heads/` entry with a
 * SHA is ignored rather than guessed at.
 */
export function parseLsRemoteHeads(stdout: string): RemoteIssueBranch[] {
  const branches: RemoteIssueBranch[] = [];
  for (const line of stdout.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref || !/^[0-9a-f]{7,40}$/.test(sha)) continue;
    if (!ref.startsWith("refs/heads/")) continue;
    const branch = ref.slice("refs/heads/".length);
    if (branch === "") continue;
    branches.push({ branch, sha });
  }
  return branches;
}

/**
 * List the remote branches that could carry this issue's prior work.
 *
 * Returns an error — never an empty list — when `ls-remote` itself fails, so
 * the caller can say "lookup failed" rather than "no prior work exists"
 * (absence of a success marker is not success).
 */
export async function listRemoteIssueBranches(
  issueNumber: number,
  options: GitCommandOptions = {},
  extraRefs: readonly string[] = [],
): Promise<Result<RemoteIssueBranch[]>> {
  const patterns = issueBranchRefPatterns(issueNumber, extraRefs);
  const args = [
    "ls-remote",
    "--heads",
    "--end-of-options",
    "origin",
    ...patterns,
  ];
  const result = await runGitCommand(args, options);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  if (result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git ls-remote exited ${result.value.code}: ` +
          (result.value.stderr.trim() || "(no output)"),
      ),
    };
  }
  return { ok: true, value: parseLsRemoteHeads(result.value.stdout) };
}

/**
 * Order branches most-recently-pushed first (Issue #220).
 *
 * Each branch is fetched and its tip's committer date read from
 * `FETCH_HEAD`, which works on single-branch clones where no
 * `refs/remotes/origin/<branch>` is created. Best-effort: a branch whose date
 * cannot be read keeps its original relative position, so the result is always
 * a permutation of the input.
 */
export async function orderBranchesByRecency(
  branches: readonly string[],
  options: GitCommandOptions = {},
): Promise<string[]> {
  const dated: Array<{ branch: string; index: number; when: number }> = [];
  for (const [index, branch] of branches.entries()) {
    let when = Number.NEGATIVE_INFINITY;
    const fetched = await runGitCommand(
      buildFetchArgs("origin", branch),
      options,
    );
    if (fetched.ok && fetched.value.code === 0) {
      const show = await runGitCommand(
        ["show", "-s", "--format=%ct", "FETCH_HEAD"],
        options,
      );
      if (show.ok && show.value.code === 0) {
        const parsed = Number(show.value.stdout.trim());
        if (Number.isFinite(parsed)) when = parsed;
      }
    }
    dated.push({ branch, index, when });
  }
  dated.sort((a, b) => b.when - a.when || a.index - b.index);
  return dated.map((entry) => entry.branch);
}

/**
 * Count the commits `ref` carries beyond `baseRef`.
 *
 * Used to tell a branch holding real WIP from one that never moved past base.
 * Returns an error when either ref is unknown, so an unverifiable count is
 * never reported as zero.
 */
export async function countCommitsAhead(
  baseRef: string,
  ref: string,
  options: GitCommandOptions = {},
): Promise<Result<number>> {
  assertSafeGitRef(baseRef, "rev-list base ref");
  assertSafeGitRef(ref, "rev-list ref");
  const result = await runGitCommand(
    ["rev-list", "--count", "--end-of-options", `${baseRef}..${ref}`],
    options,
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (result.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git rev-list --count ${baseRef}..${ref} exited ${result.value.code}: ` +
          (result.value.stderr.trim() || "(no output)"),
      ),
    };
  }
  const count = Number(result.value.stdout.trim());
  if (!Number.isFinite(count)) {
    return {
      ok: false,
      error: new Error(
        `git rev-list --count ${baseRef}..${ref} returned '${result.value.stdout.trim()}'`,
      ),
    };
  }
  return { ok: true, value: count };
}

/** What {@link countCommitsAheadRepairingBrokenRef} needs beyond the count's own arguments. */
export interface BrokenRefRepairDeps {
  /** One line naming the repaired ref. */
  log: (message: string) => void;
  /** Counts commits; defaults to {@link countCommitsAhead}. */
  countFn?: typeof countCommitsAhead;
  /** Runs the repair's git commands; defaults to runGitCommand. */
  gitFn?: typeof runGitCommand;
}

/** Matches the warning git prints for a loose ref whose content will not parse. */
const BROKEN_REF_WARNING_PATTERN = /ignoring broken ref (\S+)/;

/** Only remote-tracking refs under this remote are ever repaired (Issue #2824). */
const REPAIRABLE_REMOTE_REF_PREFIX = "refs/remotes/origin/";

/**
 * Delete a ref with `git update-ref -d`, using `--end-of-options` when this
 * git accepts it for the subcommand and falling back when it does not
 * (support was added to `update-ref` after other ref-taking verbs).
 */
async function deleteRefSafely(
  gitFn: typeof runGitCommand,
  fullRef: string,
  options: GitCommandOptions,
) {
  assertSafeGitRef(fullRef, "update-ref delete target");
  const withSeparator = await gitFn(
    ["update-ref", "-d", "--end-of-options", fullRef],
    options,
  );
  if (
    withSeparator.ok &&
    withSeparator.value.code !== 0 &&
    /unknown option `end-of-options'/i.test(withSeparator.value.stderr)
  ) {
    return await gitFn(["update-ref", "-d", fullRef], options);
  }
  return withSeparator;
}

/**
 * Count commits ahead, repairing a broken remote-tracking ref that blocks the
 * count (Issue #2824).
 *
 * A remote-tracking ref left with unparsable content — a crash mid-write, or
 * a fetch racing another process — makes git refuse every read that touches
 * it: `rev-list --count` exits 128 with `warning: ignoring broken ref ...`
 * rather than a count, and every future count against that branch fails the
 * same way until something rebuilds the ref. The ref only mirrors what
 * `origin` already has, so it is safe to delete and re-fetch — but only when
 * the warning names exactly the ref this count itself asked git to read
 * (`refs/remotes/${baseRef}` or `refs/remotes/${ref}`); a warning naming any
 * other ref, or a failure that is not this warning at all, is returned
 * unchanged so nothing outside the two refs this call owns is ever touched.
 *
 * @param baseRef - The lower bound of the range, e.g. `origin/milestone-x`.
 * @param ref - The upper bound of the range, e.g. `origin/main`.
 * @param options - Git command options (cwd, timeout, env).
 * @param deps - The logger and, in tests, fakes for the count and git calls.
 * @returns The count, repaired if the ref was broken; the original failure
 *   otherwise — never a zero standing in for an unread ref.
 */
export async function countCommitsAheadRepairingBrokenRef(
  baseRef: string,
  ref: string,
  options: GitCommandOptions,
  deps: BrokenRefRepairDeps,
): Promise<Result<number>> {
  const countFn = deps.countFn ?? countCommitsAhead;
  const gitFn = deps.gitFn ?? runGitCommand;

  const first = await countFn(baseRef, ref, options);
  if (first.ok) return first;

  const match = first.error.message.match(BROKEN_REF_WARNING_PATTERN);
  const brokenRef = match?.[1];
  if (!brokenRef) return first;

  const allowed = new Set([
    `refs/remotes/${baseRef}`,
    `refs/remotes/${ref}`,
  ]);
  if (
    !allowed.has(brokenRef) ||
    !brokenRef.startsWith(REPAIRABLE_REMOTE_REF_PREFIX)
  ) {
    return first;
  }
  const branch = brokenRef.slice(REPAIRABLE_REMOTE_REF_PREFIX.length);

  const deleteResult = await deleteRefSafely(gitFn, brokenRef, options);
  if (!deleteResult.ok) {
    return {
      ok: false,
      error: new Error(
        `${first.error.message} — repair failed: could not run ` +
          `git update-ref -d ${brokenRef}: ${deleteResult.error.message}`,
      ),
    };
  }
  if (deleteResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `${first.error.message} — repair failed: git update-ref -d ` +
          `${brokenRef} exited ${deleteResult.value.code}: ` +
          (deleteResult.value.stderr.trim() || "(no output)"),
      ),
    };
  }

  const fetchResult = await gitFn(
    buildFetchTrackingRefArgs("origin", branch),
    options,
  );
  if (!fetchResult.ok) {
    return {
      ok: false,
      error: new Error(
        `${first.error.message} — repair failed: could not run ` +
          `git fetch origin ${branch}: ${fetchResult.error.message}`,
      ),
    };
  }
  if (fetchResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `${first.error.message} — repair failed: git fetch origin ` +
          `${branch} exited ${fetchResult.value.code}: ` +
          (fetchResult.value.stderr.trim() || "(no output)"),
      ),
    };
  }

  deps.log(
    `Repaired broken remote-tracking ref '${brokenRef}' (deleted and ` +
      `re-fetched from origin) before counting ${baseRef}..${ref} (Issue #2824)`,
  );

  return await countFn(baseRef, ref, options);
}
