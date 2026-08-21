/**
 * Stranded-branch detection (Issue #174).
 *
 * A branch named `issue-<n>-…` that is ahead of the base and carries **no PR
 * at all** is stranded work: commits nobody can review, merge, or even see.
 * VibeCoder#42 ended a 49-minute run that way — a human's partial PR for the
 * same issue merged mid-run, the completion phase mistook it for the run's
 * own PR, and the three pushed commits were left behind with no PR.
 *
 * "No PR at all" is the deliberate test. A branch whose PR merged (including
 * into a milestone branch that has not rolled up yet) is *not* stranded — its
 * work is accounted for — so this scan never fires on a normal milestone
 * child.
 *
 * Failure policy: a scan that cannot run returns `ok: false` with the reason.
 * It never reports "nothing stranded" for an unreadable state — the caller
 * decides what to do with an undetermined answer, loudly.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { getRepoDefaultBranch } from "./shell_helpers.ts";

type GhCommandFn = (args: string[]) => Promise<string>;

/** A branch carrying unshipped commits with no PR of its own. */
export interface StrandedBranch {
  /** The branch name (no `refs/heads/` prefix). */
  branch: string;
  /** The base the branch was compared against. */
  baseBranch: string;
  /** Commits the branch is ahead of that base. */
  aheadBy: number;
}

/** Outcome of a stranded-branch scan. */
export type StrandedBranchScan =
  | {
    ok: true;
    /** The first stranded branch found, or null when none is. */
    stranded: StrandedBranch | null;
    /** True when `maxBranches` cut the scan short — coverage was partial. */
    truncated: boolean;
  }
  | { ok: false; error: Error };

/** Options for {@link findStrandedIssueBranch}. */
export interface FindStrandedIssueBranchOptions {
  /** Base to compare against; the repo default branch when omitted. */
  baseBranch?: string;
  /** Upper bound on branches examined (default 20). */
  maxBranches?: number;
}

/**
 * Is `branch` the worker's deterministic branch for `issueNumber`?
 *
 * The shape is `issue-<n>-<slug>` (see `buildBranchName`). The trailing
 * separator is what keeps `issue-421-…` out of a scan for issue 42.
 */
export function isIssueBranchName(
  branch: string,
  issueNumber: number,
): boolean {
  return branch.startsWith(`issue-${Math.trunc(issueNumber)}-`);
}

/** List the remote `issue-<n>-…` branches, newest listing order preserved. */
async function listIssueBranches(
  repo: string,
  issueNumber: number,
  ghCommandFn: GhCommandFn,
): Promise<string[]> {
  const prefix = `issue-${Math.trunc(issueNumber)}-`;
  const raw = await ghCommandFn([
    "api",
    `repos/${repo}/git/matching-refs/heads/${prefix}`,
    "--jq",
    ".[].ref",
  ]);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("refs/heads/"))
    .map((ref) => ref.slice("refs/heads/".length))
    .filter((branch) => isIssueBranchName(branch, issueNumber));
}

/** How many PRs (any state) exist for `branch`. */
async function countPrsForBranch(
  repo: string,
  branch: string,
  ghCommandFn: GhCommandFn,
): Promise<number> {
  const raw = await ghCommandFn([
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number",
    "--limit",
    "5",
  ]);
  const parsed = JSON.parse(raw.trim() || "[]") as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected pr list payload for branch '${branch}'`);
  }
  return parsed.length;
}

/** Commits `branch` is ahead of `base`. */
async function countAheadOfBase(
  repo: string,
  base: string,
  branch: string,
  ghCommandFn: GhCommandFn,
): Promise<number> {
  const raw = await ghCommandFn([
    "api",
    `repos/${repo}/compare/${encodeURIComponent(base)}...${
      encodeURIComponent(branch)
    }`,
    "--jq",
    ".ahead_by",
  ]);
  const aheadBy = parseInt(raw.trim(), 10);
  if (!Number.isFinite(aheadBy)) {
    throw new Error(
      `Unreadable ahead_by for '${base}...${branch}': '${raw.trim()}'`,
    );
  }
  return aheadBy;
}

/**
 * Find the first branch for `issueNumber` that carries unshipped commits and
 * has no PR of its own.
 *
 * @param repo - Repository in `owner/repo` form
 * @param issueNumber - The issue whose branches to scan
 * @param ghCommandFn - gh command runner (injectable for testing)
 * @param options - Base branch and scan bound
 */
export async function findStrandedIssueBranch(
  repo: string,
  issueNumber: number,
  ghCommandFn: GhCommandFn,
  options: FindStrandedIssueBranchOptions = {},
): Promise<StrandedBranchScan> {
  const maxBranches = options.maxBranches ?? 20;

  let branches: string[];
  try {
    branches = await listIssueBranches(repo, issueNumber, ghCommandFn);
  } catch (err) {
    return {
      ok: false,
      error: new Error(
        `Could not list matching-refs branches for issue #${issueNumber}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    };
  }

  if (branches.length === 0) {
    return { ok: true, stranded: null, truncated: false };
  }

  let baseBranch = options.baseBranch;
  if (!baseBranch) {
    const resolved = await getRepoDefaultBranch(repo, ghCommandFn);
    if (!resolved.ok) {
      return {
        ok: false,
        error: new Error(
          `Could not resolve the default branch of ${repo}: ${resolved.error.message}`,
        ),
      };
    }
    baseBranch = resolved.value;
  }

  const scanned = branches.slice(0, maxBranches);
  const truncated = branches.length > scanned.length;

  for (const branch of scanned) {
    try {
      // A branch with any PR — open, closed, or merged — is accounted for.
      if (await countPrsForBranch(repo, branch, ghCommandFn) > 0) continue;
      const aheadBy = await countAheadOfBase(
        repo,
        baseBranch,
        branch,
        ghCommandFn,
      );
      if (aheadBy > 0) {
        return {
          ok: true,
          stranded: { branch, baseBranch, aheadBy },
          truncated,
        };
      }
    } catch (err) {
      return {
        ok: false,
        error: new Error(
          `Could not determine whether '${branch}' is stranded: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      };
    }
  }

  return { ok: true, stranded: null, truncated };
}
