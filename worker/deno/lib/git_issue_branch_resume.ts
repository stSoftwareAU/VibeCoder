/**
 * Find an issue's pushed WIP branch on re-claim (Issue #220).
 *
 * The WIP/resume contract (#47, #148, #4170) parks an interrupted run's work
 * as commits on the issue branch. Locating that work by the *title-derived*
 * branch name made the contract only as stable as the title: #211 was
 * retitled between two claims, so the second claim derived a different slug,
 * never looked at `issue-211-two-hosts-…`, and restarted from scratch while
 * the 20-file WIP commit sat on the remote.
 *
 * The lookup here keys on the issue NUMBER instead — `issue-<N>` and
 * `issue-<N>-*`, plus whatever branch the persisted resume file names — and
 * only offers a branch that is genuinely ahead of base, so a
 * merged-and-squashed leftover is not mistaken for parked work.
 *
 * A remote that cannot be listed is an error, never "nothing to resume":
 * silently degrading to a fresh branch is exactly how WIP gets orphaned.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { runGitCommand } from "./git_timeout.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import { assertSafeGitRef, buildFetchArgs } from "./git_ref_args.ts";
import {
  belongsToIssue,
  type DatedBranchRef,
  issueBranchPatterns,
  mostRecentBranch,
  parseLsRemoteHeads,
  preferredIssueBranch,
  type RemoteBranchRef,
} from "./issue_branch_candidates.ts";

/** The branch a re-claim should continue on. */
export interface ResumableIssueBranch {
  /** Branch name as it exists on the remote. */
  branch: string;
  /** Tip commit SHA on the remote. */
  sha: string;
  /**
   * Commits the branch carries that base does not, or `null` when the count
   * could not be determined (the branch is still offered — losing WIP is the
   * worse failure).
   */
  aheadCount: number | null;
}

/** Outcome of the lookup, shaped so the caller can log it in one line. */
export interface IssueBranchResumeLookup {
  /** The branch to resume, or `null` when there is nothing to resume. */
  candidate: ResumableIssueBranch | null;
  /** Every branch found for the issue, whether chosen or not. */
  considered: string[];
  /** Candidates that were found but not chosen. */
  alternatives: string[];
  /** Why the lookup ended as it did. */
  reason: "resumable" | "none-found" | "not-ahead-of-base";
}

/** Parameters for {@link findResumableIssueBranch}. */
export interface FindResumableIssueBranchParams {
  /** The issue being claimed — the durable branch identity. */
  issueNumber: number;
  /** Branch the work is based on (default or milestone branch). */
  baseBranch: string;
  /** Branch named by the persisted resume file, if any. */
  persistedBranch?: string;
  /** Branch this claim's title derives, if any. */
  titleBranch?: string;
  /** Git command options (cwd, timeout). */
  options?: GitCommandOptions;
}

/**
 * Look up the issue's resumable WIP branch on the remote.
 *
 * Returns `ok` with `candidate: null` when the issue simply has no parked
 * work; returns an error when the remote could not be queried at all.
 */
export async function findResumableIssueBranch(
  params: FindResumableIssueBranchParams,
): Promise<Result<IssueBranchResumeLookup>> {
  const {
    issueNumber,
    baseBranch,
    persistedBranch,
    titleBranch,
    options = {},
  } = params;

  const patterns = issueBranchPatterns(issueNumber, persistedBranch);
  for (const pattern of patterns) {
    assertSafeGitRef(pattern, "ls-remote pattern");
  }
  const lsArgs = [
    "ls-remote",
    "--heads",
    "--end-of-options",
    "origin",
    ...patterns,
  ];
  const lsResult = await runGitCommand(lsArgs, options);
  if (!lsResult.ok) {
    return {
      ok: false,
      error: new Error(
        `git ls-remote for issue ${issueNumber} branches failed: ${lsResult.error.message}`,
      ),
    };
  }
  if (lsResult.value.code !== 0) {
    return {
      ok: false,
      error: new Error(
        `git ls-remote for issue ${issueNumber} branches exited ` +
          `${lsResult.value.code}: ` +
          (lsResult.value.stderr.trim() || "(no output)"),
      ),
    };
  }

  // Defence in depth: `ls-remote` wildcards can match more than intended, so
  // only branches that genuinely belong to this issue (or the exact branch
  // the resume file names) are ever considered.
  const candidates = parseLsRemoteHeads(lsResult.value.stdout).filter(
    (ref) =>
      belongsToIssue(ref.branch, issueNumber) ||
      ref.branch === persistedBranch,
  );
  const considered = candidates.map((c) => c.branch);
  if (candidates.length === 0) {
    return {
      ok: true,
      value: {
        candidate: null,
        considered,
        alternatives: [],
        reason: "none-found",
      },
    };
  }

  const chosen = preferredIssueBranch(candidates, {
    ...(persistedBranch !== undefined ? { persistedBranch } : {}),
    ...(titleBranch !== undefined ? { titleBranch } : {}),
  }) ?? await mostRecentByCommitDate(candidates, options);
  if (chosen === null) {
    return {
      ok: true,
      value: {
        candidate: null,
        considered,
        alternatives: considered,
        reason: "none-found",
      },
    };
  }
  const alternatives = considered.filter((name) => name !== chosen.branch);

  await fetchBranch(chosen.branch, options);
  const aheadCount = await countAheadOfBase(chosen.sha, baseBranch, options);
  if (aheadCount === 0) {
    return {
      ok: true,
      value: {
        candidate: null,
        considered,
        alternatives,
        reason: "not-ahead-of-base",
      },
    };
  }

  return {
    ok: true,
    value: {
      candidate: { branch: chosen.branch, sha: chosen.sha, aheadCount },
      considered,
      alternatives,
      reason: "resumable",
    },
  };
}

/** Fetch one branch; failure is reported by the caller's later steps. */
async function fetchBranch(
  branch: string,
  options: GitCommandOptions,
): Promise<boolean> {
  const result = await runGitCommand(buildFetchArgs("origin", branch), options);
  return result.ok && result.value.code === 0;
}

/**
 * Resolve ambiguity by recency: fetch each candidate so its tip is readable
 * locally, then pick the newest commit date.
 */
async function mostRecentByCommitDate(
  candidates: readonly RemoteBranchRef[],
  options: GitCommandOptions,
): Promise<RemoteBranchRef | null> {
  const dated: DatedBranchRef[] = [];
  for (const candidate of candidates) {
    if (!await fetchBranch(candidate.branch, options)) continue;
    const shown = await runGitCommand(
      ["show", "-s", "--format=%ct", "--end-of-options", candidate.sha],
      options,
    );
    if (!shown.ok || shown.value.code !== 0) continue;
    const seconds = Number.parseInt(shown.value.stdout.trim(), 10);
    if (!Number.isFinite(seconds)) continue;
    dated.push({ ...candidate, committedAtEpochSec: seconds });
  }
  return mostRecentBranch(dated);
}

/**
 * How many commits the branch tip carries that base does not.
 *
 * Returns `null` when neither `origin/<base>` nor a local `<base>` can be
 * counted against — the caller then keeps the candidate rather than
 * discarding possible WIP on an unanswerable question.
 */
async function countAheadOfBase(
  sha: string,
  baseBranch: string,
  options: GitCommandOptions,
): Promise<number | null> {
  assertSafeGitRef(sha, "ahead-count commit");
  assertSafeGitRef(baseBranch, "ahead-count base branch");
  for (const base of [`origin/${baseBranch}`, baseBranch]) {
    const result = await runGitCommand(
      ["rev-list", "--count", "--end-of-options", `${base}..${sha}`],
      options,
    );
    if (!result.ok || result.value.code !== 0) continue;
    const count = Number.parseInt(result.value.stdout.trim(), 10);
    if (Number.isFinite(count)) return count;
  }
  return null;
}
