/**
 * In-run repair of a `milestone/**` ruleset that refuses its own branch
 * creation (Issue #2079).
 *
 * Issue #2067 removed the trap from the fleet's ruleset writer and taught
 * `setup` to clear it from repositories already carrying one. Setup is an
 * operator-run command, so a repository nobody re-runs setup against stays
 * trapped: `stSoftwareAU/GRQ-FX-validation` kept its blocking ruleset
 * (`do_not_enforce_on_create: false`, untouched since 2026-08-31) and every
 * claim died inside a minute in `setup`:
 *
 * ```text
 * ! [remote rejected] Develop -> milestone/scan-20260910
 *     (push declined due to repository rule violations)
 * ```
 *
 * The worker meets that refusal first-hand, so it repairs it first-hand:
 * this module turns the refusal into one repair attempt and one retry of the
 * branch creation. When the repair is refused — the identity may hold only
 * `write`, and a ruleset write needs `admin` — nothing is swallowed: the
 * caller still fails the run and hands off, now carrying a note saying the
 * worker tried and why it could not.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Result } from "../types.ts";
import type { RepairMilestoneResult } from "./milestone_ruleset_check.ts";

/**
 * True when `message` is a push refused by a repository **ruleset**.
 *
 * Narrower than {@link isRepoLevelBranchRejection}: branch protection and a
 * missing permission are repo-level too, but no ruleset flag clears them, so
 * a repair attempt could only waste two API calls and confuse the handoff.
 */
export function isRulesetCreationRefusal(message: string): boolean {
  return /\bGH013\b/i.test(message) ||
    /repository rule violations/i.test(message) ||
    /push declined due to repository rule/i.test(message);
}

/** What one in-run repair attempt did. */
export type MilestoneCreateBlockOutcome =
  /** No attempt was made — the caller's original failure stands unchanged. */
  | { kind: "not-applicable"; reason: string }
  /** The ruleset was exempted and the branch now exists. */
  | { kind: "recovered"; ruleset: string; value: string }
  /** An attempt was made and did not clear the refusal. */
  | { kind: "failed"; note: string };

/** The edges {@link repairMilestoneCreateBlockAndRetry} drives. */
export interface MilestoneCreateBlockParams {
  /** `owner/repo` of the repository that refused the push. */
  repo: string;
  /** The milestone branch whose creation was refused. */
  milestoneBranch: string;
  /** The git failure text `ensureMilestoneBranchExists` came back with. */
  detail: string;
  /** Exempt the repository's milestone ruleset from branch creation. */
  repair: (repo: string) => Promise<RepairMilestoneResult>;
  /** Re-run the branch creation once the ruleset has been repaired. */
  retry: () => Promise<Result<string>>;
}

/**
 * Repositories a repair has been attempted for in this process.
 *
 * Process-lifetime only, like the Issue #853 rejection registry: one attempt
 * per run is enough — a repaired ruleset lets the next issue's push through
 * on its own, and a refused repair will be refused identically for every
 * other issue in the milestone.
 */
const attempted = new Set<string>();

/**
 * Record a repair attempt and report whether this run has made one before.
 *
 * @returns `true` on the first attempt for this repository.
 */
export function claimMilestoneCreateBlockRepair(repo: string): boolean {
  if (attempted.has(repo)) return false;
  attempted.add(repo);
  return true;
}

/** Reset the registry. Tests only — production state is per process. */
export function resetMilestoneCreateBlockRepairsForTest(): void {
  attempted.clear();
}

/**
 * Clear a create-blocking milestone ruleset and retry the branch creation.
 *
 * @param params - The repository, the refusal, and the repair/retry edges.
 * @returns What the attempt did, and the note a handoff should carry when it
 *   did not clear the refusal.
 */
export async function repairMilestoneCreateBlockAndRetry(
  params: MilestoneCreateBlockParams,
): Promise<MilestoneCreateBlockOutcome> {
  const { repo, milestoneBranch, detail } = params;

  if (!isRulesetCreationRefusal(detail)) {
    return {
      kind: "not-applicable",
      reason: "the refusal does not name a repository ruleset",
    };
  }
  if (!claimMilestoneCreateBlockRepair(repo)) {
    return {
      kind: "not-applicable",
      reason: `a ruleset repair was already attempted for ${repo} this run`,
    };
  }

  const repair = await params.repair(repo);
  if (!repair.ok) {
    return {
      kind: "failed",
      note: "The worker tried to exempt the ruleset from branch creation " +
        `itself and was refused: ${repair.error.message}`,
    };
  }
  if (!repair.repaired) {
    return {
      kind: "failed",
      note: "The worker looked for a `milestone/**` ruleset it could safely " +
        `exempt from branch creation and found none (${repair.reason}), so ` +
        "this refusal has to be cleared by hand.",
    };
  }

  const retry = await params.retry();
  if (!retry.ok) {
    return {
      kind: "failed",
      note: `The worker exempted ruleset '${repair.ruleset}' from branch ` +
        `creation, but creating \`${milestoneBranch}\` was still refused: ` +
        retry.error.message,
    };
  }
  return { kind: "recovered", ruleset: repair.ruleset, value: retry.value };
}
