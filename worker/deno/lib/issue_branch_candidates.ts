/**
 * Issue-number-keyed branch candidates (Issue #220).
 *
 * Resume-on-reclaim used to key on the *title-derived* branch name, so the
 * WIP/resume contract (#47, #148, #4170) was only as stable as the issue
 * title: retitling #211 between two claims orphaned a 20-file WIP branch
 * and the next claim started from scratch. The durable identity of an
 * attempt is the ISSUE NUMBER — these helpers turn that into the candidate
 * set a re-claim searches, and pick between candidates deterministically.
 *
 * Pure functions only; the git I/O lives in `git_issue_branch_resume.ts`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** A branch head as reported by `git ls-remote --heads`. */
export interface RemoteBranchRef {
  /** Branch name without the `refs/heads/` prefix. */
  branch: string;
  /** Tip commit SHA. */
  sha: string;
}

/** A candidate enriched with its tip's committer date. */
export interface DatedBranchRef extends RemoteBranchRef {
  /** Committer date of the branch tip, in epoch seconds. */
  committedAtEpochSec: number;
}

/** Which branch a re-claim would rather resume, in preference order. */
export interface BranchPreferences {
  /** Branch named by the persisted resume file, whatever its name. */
  persistedBranch?: string;
  /** Branch this claim's title derives. */
  titleBranch?: string;
}

/** `<sha>\trefs/heads/<branch>` — anything else is not a branch head. */
const LS_REMOTE_HEAD_LINE = /^([0-9a-f]{7,64})\s+refs\/heads\/(\S.*)$/;

/**
 * Parse `git ls-remote --heads` output into branch/SHA pairs.
 *
 * Lines that are not branch heads (tags, blanks, warnings git prints to
 * stdout) are ignored rather than guessed at.
 */
export function parseLsRemoteHeads(stdout: string): RemoteBranchRef[] {
  const refs: RemoteBranchRef[] = [];
  for (const line of stdout.split("\n")) {
    const match = LS_REMOTE_HEAD_LINE.exec(line.trim());
    if (!match) continue;
    refs.push({ sha: match[1]!, branch: match[2]!.trim() });
  }
  return refs;
}

/**
 * Is this branch the worker's branch for the given issue?
 *
 * Matches `issue-<N>` and `issue-<N>-<slug>` only, so neither a
 * neighbouring number (`issue-2200-…` for issue 220) nor a namespaced
 * branch (`wip/issue-220-…`) is mistaken for this issue's work.
 */
export function belongsToIssue(branch: string, issueNumber: number): boolean {
  const prefix = `issue-${issueNumber}`;
  return branch === prefix || branch.startsWith(`${prefix}-`);
}

/**
 * `git ls-remote` patterns that find every branch this issue could own.
 *
 * The persisted branch is included regardless of its name: an attempt may
 * have been checkpointed on a branch that no longer matches the convention.
 */
export function issueBranchPatterns(
  issueNumber: number,
  persistedBranch?: string,
): string[] {
  const patterns = [`issue-${issueNumber}`, `issue-${issueNumber}-*`];
  if (
    persistedBranch !== undefined && persistedBranch.length > 0 &&
    !belongsToIssue(persistedBranch, issueNumber)
  ) {
    patterns.push(persistedBranch);
  }
  return patterns;
}

/**
 * Pick the candidate a re-claim should resume, when the choice is obvious.
 *
 * Order: the persisted branch, then the title-derived branch, then a lone
 * candidate. Returns `null` when several candidates exist and none is
 * preferred — the caller resolves that by recency
 * ({@link mostRecentBranch}), which needs git.
 */
export function preferredIssueBranch(
  candidates: readonly RemoteBranchRef[],
  preferences: BranchPreferences,
): RemoteBranchRef | null {
  const byName = (name?: string): RemoteBranchRef | null =>
    name === undefined
      ? null
      : candidates.find((c) => c.branch === name) ?? null;

  return byName(preferences.persistedBranch) ??
    byName(preferences.titleBranch) ??
    (candidates.length === 1 ? candidates[0]! : null);
}

/**
 * The most recently committed candidate; ties break by branch name so two
 * hosts looking at the same remote make the same choice.
 */
export function mostRecentBranch(
  candidates: readonly DatedBranchRef[],
): DatedBranchRef | null {
  let best: DatedBranchRef | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.committedAtEpochSec > best.committedAtEpochSec ||
      (candidate.committedAtEpochSec === best.committedAtEpochSec &&
        candidate.branch < best.branch)
    ) {
      best = candidate;
    }
  }
  return best;
}
