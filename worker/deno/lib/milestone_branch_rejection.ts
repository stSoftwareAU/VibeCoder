/**
 * Repo-level milestone-branch rejections (Issue #853).
 *
 * `ensureMilestoneBranch` fails per issue, and the setup phase escalates the
 * issue it was working on. That is right for a fault belonging to one issue.
 * It is wrong for a fault belonging to the **repository**: a ruleset that
 * refuses branch creation refuses it identically for every issue in the
 * milestone, so the fleet claimed nine sub-issues in turn, failed each in
 * `setup`, and parked each with `needs-human` — nine human chores for one
 * configuration fact, none of which clear themselves once it is fixed
 * (nothing ever removes `needs-human`, see Issue #854).
 *
 * Observed on GRQ-23 on 2026-09-03: ruleset "Milestone" applied
 * `required_status_checks` to `refs/heads/milestone/**`. A branch being
 * created has no checks, so every push was refused:
 *
 * ```text
 * remote: error: GH013: Repository rule violations found for
 *   refs/heads/milestone/794-...
 * ! [remote rejected] ... (push declined due to repository rule violations)
 * ```
 *
 * This module answers the two questions the phase could not: is this failure
 * repo-level, and has it already been reported this run.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Signatures of a rejection belonging to the repository rather than to one
 * issue — a ruleset, branch protection, or a permission the account lacks.
 * Each refuses identically for the next issue, so retrying per issue can only
 * repeat the failure.
 *
 * Deliberately narrow: an ambiguous error stays per-issue, because treating a
 * transient fault as permanent would suppress an escalation that should have
 * been raised. Under-matching costs a repeated escalation; over-matching
 * loses one.
 */
const REPO_LEVEL_SIGNATURES: readonly RegExp[] = [
  /\bGH013\b/i,
  /repository rule violations/i,
  /push declined due to repository rule/i,
  /protected branch/i,
  /required status check/i,
  /\bGH006\b/i,
  /permission to .* denied/i,
];

/**
 * True when `message` names a failure the repository will reproduce for every
 * issue in the milestone.
 */
export function isRepoLevelBranchRejection(message: string): boolean {
  return REPO_LEVEL_SIGNATURES.some((re) => re.test(message));
}

/**
 * An operator-facing explanation of a repo-level rejection, appended to the
 * escalation so the reader need not re-derive it from a raw git error.
 *
 * The observed escalation said only "failed at phase 'setup'", which left a
 * human to work out the ruleset themselves — the opposite of an actionable
 * handoff.
 */
export function describeRepoLevelRejection(
  message: string,
  branch: string,
): string | null {
  if (!isRepoLevelBranchRejection(message)) return null;
  const ruleset = /\bGH013\b/i.test(message) ||
    /repository rule violations/i.test(message);
  if (ruleset) {
    return `A repository ruleset refused the creation of \`${branch}\`. ` +
      "A branch being created carries no status checks yet, so a ruleset " +
      "applying `required_status_checks` to this ref pattern rejects every " +
      "push that would create it. Check the repository's rulesets for one " +
      "matching this ref, then either add the fleet account as a bypass " +
      "actor or drop the check requirement from a rule that cannot apply at " +
      "creation time. This refusal is identical for every issue in the " +
      "milestone, so the others are left claimable rather than parked.";
  }
  if (/\bGH006\b/i.test(message) || /protected branch/i.test(message)) {
    return `Branch protection refused \`${branch}\`. The fleet account needs ` +
      "permission to create this ref, or the protection rule must exempt " +
      "it. This refusal is identical for every issue in the milestone.";
  }
  return `The repository refused \`${branch}\` for a reason that recurs for ` +
    "every issue in this milestone, so the others are left claimable rather " +
    "than parked.";
}

/**
 * Milestone branches already reported this run, keyed `repo branch`.
 *
 * Process-lifetime only, deliberately: the point is to escalate once per run
 * rather than once per issue, and a fresh run should report again while the
 * repository is still misconfigured. Persisting it would hide a condition
 * nobody had fixed.
 */
const reported = new Set<string>();

const key = (repo: string, branch: string): string => `${repo} ${branch}`;

/**
 * Record a repo-level rejection and report whether this run has seen it
 * before for that branch.
 *
 * @returns `true` on the first sighting — the caller should escalate.
 */
export function claimRepoLevelRejectionReport(
  repo: string,
  branch: string,
): boolean {
  const k = key(repo, branch);
  if (reported.has(k)) return false;
  reported.add(k);
  return true;
}

/** Whether this run has already reported a repo-level rejection. */
export function hasReportedRepoLevelRejection(
  repo: string,
  branch: string,
): boolean {
  return reported.has(key(repo, branch));
}

/** Reset the registry. Tests only — production state is per process. */
export function resetRepoLevelRejectionsForTest(): void {
  reported.clear();
}
