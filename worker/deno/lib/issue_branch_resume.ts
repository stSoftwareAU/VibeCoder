/**
 * Resume-on-reclaim keyed on the issue number (Issue #220).
 *
 * A re-claim used to look for exactly one branch: the one derived from the
 * issue's *current* title. Retitling #211 between two claims therefore
 * orphaned a pushed 20-file WIP commit — the second claim derived a new slug,
 * created that branch from base, and repeated the work.
 *
 * Discovery here is by issue number instead (`issue-<N>` / `issue-<N>-*` on
 * the remote, plus whatever branch the resume file names), so the title may
 * change freely between claims. The chosen branch is checked out and becomes
 * the branch the run works on; every candidate that was passed over is named
 * in the outcome so nothing is dropped silently.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { GitCommandOptions } from "./git_timeout.ts";
import type {
  countCommitsAhead,
  listRemoteIssueBranches,
  orderBranchesByRecency,
  RemoteIssueBranch,
} from "./git_issue_branches.ts";
import type { resumeFeatureBranchFromRemote } from "./git_branch.ts";

/** Why a branch was chosen — or why none was. */
export type ResumeBranchReason =
  /** The branch named by the resume file, which exists on the remote. */
  | "persisted"
  /** The only `issue-<N>` branch on the remote. */
  | "only-candidate"
  /** The most recently pushed of several `issue-<N>` branches. */
  | "most-recent"
  /** The remote has no branch for this issue. */
  | "no-candidates"
  /** Branches exist but none was usable (not ahead of base, or unfetchable). */
  | "no-usable-candidate"
  /** `ls-remote` failed, so prior work could neither be found nor ruled out. */
  | "lookup-failed";

/** What the lookup decided, and everything the log line needs. */
export interface ResumeBranchOutcome {
  /** Branch checked out to continue on, or `null` to start fresh from base. */
  branch: string | null;
  reason: ResumeBranchReason;
  /** Every `issue-<N>` branch found on the remote. */
  candidates: string[];
  /** Candidates not chosen, each with the reason it was passed over. */
  skipped: string[];
  /** Commits the resumed branch carries beyond base, when it could be counted. */
  aheadCount?: number;
  /** Failure detail for a lookup that could not complete. */
  detail?: string;
}

/** Git functions the lookup needs, injected so tests drive them directly. */
export interface ResumeBranchGitDeps {
  listRemoteIssueBranches: typeof listRemoteIssueBranches;
  orderBranchesByRecency: typeof orderBranchesByRecency;
  countCommitsAhead: typeof countCommitsAhead;
  resumeFeatureBranchFromRemote: typeof resumeFeatureBranchFromRemote;
}

/** Inputs for {@link resumeIssueBranch}. */
export interface ResumeBranchParams {
  issueNumber: number;
  /** Branch the base of the run is taken from (default or milestone branch). */
  baseBranch: string;
  /** Branch named by the resume file, if any — preferred over the rest. */
  persistedBranch?: string;
  /** Git command options (cwd of the clone). */
  gitOptions: GitCommandOptions;
}

/**
 * Rank the candidates: the persisted branch first, then the order given
 * (most recently pushed first). Pure, so the preference rules are testable
 * without git.
 */
export function rankResumeCandidates(
  orderedCandidates: readonly string[],
  persistedBranch?: string,
): { branch: string; reason: ResumeBranchReason }[] {
  const ranked: { branch: string; reason: ResumeBranchReason }[] = [];
  if (persistedBranch && orderedCandidates.includes(persistedBranch)) {
    ranked.push({ branch: persistedBranch, reason: "persisted" });
  }
  for (const branch of orderedCandidates) {
    if (ranked.some((entry) => entry.branch === branch)) continue;
    ranked.push({
      branch,
      reason: orderedCandidates.length === 1 ? "only-candidate" : "most-recent",
    });
  }
  return ranked;
}

/**
 * Find and check out the branch carrying this issue's prior work.
 *
 * Independent of `enable_session_resume` (Issue #220): that flag gates the
 * CLI `--resume` conversation replay, never whether pushed WIP is used —
 * discarding a pushed commit is a data-loss bug, not an opt-in feature.
 */
export async function resumeIssueBranch(
  params: ResumeBranchParams,
  git: ResumeBranchGitDeps,
): Promise<ResumeBranchOutcome> {
  const { issueNumber, baseBranch, persistedBranch, gitOptions } = params;

  const listed = await git.listRemoteIssueBranches(
    issueNumber,
    gitOptions,
    persistedBranch ? [persistedBranch] : [],
  );
  if (!listed.ok) {
    // Fail loud rather than reporting "no prior work": a lookup that could
    // not run has not ruled anything out.
    return {
      branch: null,
      reason: "lookup-failed",
      candidates: [],
      skipped: [],
      detail: listed.error.message,
    };
  }

  const candidates = dedupeBranches(listed.value);
  if (candidates.length === 0) {
    return {
      branch: null,
      reason: "no-candidates",
      candidates: [],
      skipped: [],
    };
  }

  const ordered = candidates.length > 1
    ? await git.orderBranchesByRecency(candidates, gitOptions)
    : candidates;

  const skipped: string[] = [];
  for (
    const { branch, reason } of rankResumeCandidates(ordered, persistedBranch)
  ) {
    const checkout = await git.resumeFeatureBranchFromRemote(
      branch,
      gitOptions,
    );
    if (!checkout.ok || checkout.value !== true) {
      skipped.push(`${branch} (could not be checked out)`);
      continue;
    }
    const ahead = await countAhead(git, baseBranch, branch, gitOptions);
    if (ahead.ok && ahead.value === 0) {
      skipped.push(`${branch} (no commits beyond ${baseBranch})`);
      continue;
    }
    return {
      branch,
      reason,
      candidates,
      skipped: [...skipped, ...remainingAfter(ordered, branch, skipped)],
      ...(ahead.ok ? { aheadCount: ahead.value } : {}),
      ...(ahead.ok
        ? {}
        : { detail: `ahead-count unavailable: ${ahead.error.message}` }),
    };
  }

  return {
    branch: null,
    reason: "no-usable-candidate",
    candidates,
    skipped,
  };
}

/** One log line naming the branch resumed, or stating that none existed. */
export function describeResumeOutcome(
  outcome: ResumeBranchOutcome,
  issueNumber: number,
): string {
  if (outcome.branch) {
    const ahead = outcome.aheadCount === undefined
      ? ""
      : ` (${outcome.aheadCount} commit${
        outcome.aheadCount === 1 ? "" : "s"
      } ahead of base)`;
    return `Resuming prior progress from ${outcome.branch}${ahead} ` +
      `[${outcome.reason}] (Issue #220)`;
  }
  switch (outcome.reason) {
    case "lookup-failed":
      return `Could not look up prior branches for issue #${issueNumber} — ` +
        `starting from base: ${outcome.detail ?? "unknown error"} (Issue #220)`;
    case "no-usable-candidate":
      return `No resumable prior progress for issue #${issueNumber} — ` +
        `starting from base; passed over: ${outcome.skipped.join(", ")}`;
    default:
      return `No prior progress branch exists for issue #${issueNumber} — ` +
        `starting from base`;
  }
}

/** Unique branch names, preserving the order the remote listed them in. */
function dedupeBranches(branches: readonly RemoteIssueBranch[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const { branch } of branches) {
    if (seen.has(branch)) continue;
    seen.add(branch);
    names.push(branch);
  }
  return names;
}

/**
 * Commits the candidate carries beyond base. The remote-tracking base ref is
 * preferred; a clone without one (single-branch clones, Issue #211) falls
 * back to the local base ref before the count is reported as unavailable.
 */
async function countAhead(
  git: ResumeBranchGitDeps,
  baseBranch: string,
  branch: string,
  gitOptions: GitCommandOptions,
): Promise<Result<number>> {
  const remote = await git.countCommitsAhead(
    `origin/${baseBranch}`,
    branch,
    gitOptions,
  );
  if (remote.ok) return remote;
  return await git.countCommitsAhead(baseBranch, branch, gitOptions);
}

/** Candidates after the chosen one — recorded so none is dropped silently. */
function remainingAfter(
  ordered: readonly string[],
  chosen: string,
  alreadySkipped: readonly string[],
): string[] {
  return ordered
    .filter((branch) =>
      branch !== chosen &&
      !alreadySkipped.some((entry) => entry.startsWith(`${branch} (`))
    )
    .map((branch) => `${branch} (not chosen)`);
}
