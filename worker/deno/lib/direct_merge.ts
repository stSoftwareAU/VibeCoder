/**
 * Direct merge module for PRs targeting unprotected branches.
 *
 * Provides a fallback merge strategy when GitHub's native auto-merge
 * cannot be enabled (e.g., milestone branches without branch protection).
 *
 * Issue #926
 */

import type { Result } from "../types.ts";
import { runGhCommand } from "./github.ts";
import {
  fetchCheckRunsBatch,
  rollupToCheckRunsResponse,
  rollupToCombinedStatusResponse,
} from "./check_runs_batch.ts";
import { fetchPRBranchStateBatch } from "./pr_branch_state.ts";
import { decideMilestoneBaseMerge } from "./milestone_children_gate.ts";
import { mergeMethodFlagForHead } from "./milestone_sync_pr.ts";
import {
  type ApprovedDefaultBranchPolicy,
  fetchPrReviews,
  hasNonFleetApproval,
  type PrReview,
} from "./default_branch_approval.ts";

export type { ApprovedDefaultBranchPolicy, PrReview };

// =============================================================================
// Types
// =============================================================================

/**
 * Aggregate CI status for a PR.
 *
 * `no_checks` is distinct from `passed` (Issue #3705): a head commit with no
 * check runs *and* no commit statuses has not been verified by anything, so
 * the direct-merge path — which bypasses branch protection — must treat it as
 * unverified rather than green.
 */
export type CiStatus = "passed" | "pending" | "failed" | "no_checks";

/** Result from checkCiStatus. */
export interface CiStatusResult {
  status: CiStatus;
  /**
   * Head commit SHA the checks were read for (Issue #3946).
   *
   * The merge is pinned to this SHA via `gh pr merge --match-head-commit`, so
   * a push landing between the check read and the merge call cannot be
   * squash-merged on checks that never evaluated it. Absent only when the
   * head could not be resolved.
   */
  headSha?: string;
}

/**
 * Reason a pre-merge gate refused to merge (Issue #2582).
 *
 * - `checks_pending` — required CI checks have not finished.
 * - `checks_failed`  — at least one required CI check failed.
 * - `behind_target`  — the feature branch is behind its target, so its CI
 *   results no longer reflect the merged state.
 * - `no_checks`      — the head commit has no check runs and no commit
 *   statuses, so nothing has verified it (Issue #3705).
 * - `head_moved`     — the PR head advanced between the check read and the
 *   merge call, so GitHub refused the SHA-pinned merge (Issue #3946).
 */
export type MergeBlockedReason =
  | "checks_pending"
  | "checks_failed"
  | "behind_target"
  | "no_checks"
  | "head_moved"
  | "head_too_recent"
  /**
   * The PR targets an unprotected default branch and carries no approving
   * review from outside the fleet (Issue #1082), so the human review the
   * blast-radius guard (Issue #2416) demands is absent. A deliberate hold,
   * not a fault: the PR is left open and re-evaluated next scan.
   */
  | "default_branch_unapproved"
  | "milestone_rollup_merged"
  /**
   * The milestone's route to the default branch could not be *read*
   * (Issue #477) — a transient deferral, not a refusal.
   */
  | "milestone_route_unreadable";

/**
 * A head commit younger than this is not merged (Issue #4375). After a
 * push GitHub creates check suites asynchronously; for a few seconds the
 * head can carry no check runs at all (or only the ones that raced ahead)
 * and a "green" read is not evidence — observed live when #4363 merged
 * 20 s after a maintenance force-push while `validate` was still running,
 * putting a type error onto the milestone branch.
 */
export const MIN_HEAD_AGE_SECONDS = 180;

/** Result from directMergePr. */
export interface MergeResult {
  merged: boolean;
  /**
   * When `merged` is false, the gate reason the merge was deferred. Absent
   * when the merge succeeded.
   */
  blocked?: MergeBlockedReason;
}

/** Outcome of the pre-merge backstop gate (Issue #2582). */
export interface PreMergeGateOutcome {
  /** True when CI is green and the branch is current — safe to merge. */
  allowed: boolean;
  /** When `allowed` is false, why the merge is blocked. */
  reason?: MergeBlockedReason;
  /** For `milestone_rollup_merged`: what closed the route (Issue #4396). */
  detail?: string;
  /**
   * Head commit SHA the gate evaluated its checks against (Issue #3946).
   * Required when `allowed` is true — {@link directMergePr} pins the merge to
   * it and refuses to merge without it.
   */
  headSha?: string;
  /**
   * Head branch of the PR, read by the gate anyway (Issue #1048). It decides
   * the merge method: a milestone sync must land as a merge commit so the
   * default branch becomes a genuine ancestor of the milestone branch.
   */
  headRefName?: string;
}

/** Operator overrides for the pre-merge gate (Issue #3705). */
export interface PreMergeGateOptions {
  /**
   * Explicit operator override permitting a merge when the head commit has
   * no check runs and no commit statuses. Defaults to `false` — the gate
   * fails closed, because "nothing ran" is not "everything passed".
   */
  allowNoChecks?: boolean;
  /**
   * Minimum age of the head commit before a merge is considered
   * (Issue #4375). Defaults to {@link MIN_HEAD_AGE_SECONDS}; 0 disables.
   */
  minHeadAgeSeconds?: number;
  /** Clock (epoch ms) for the head-age check — injectable for tests. */
  nowMs?: () => number;
  /**
   * Fetch the head commit's identity and age (tests). Defaults to a
   * `gh pr view --json headRefOid,commits` read; a lookup failure logs and
   * does not block on its own (CI status remains the fail-closed gate).
   */
  fetchHeadRecency?: (
    repo: string,
    prNumber: number,
    ghCommandFn: GhCommandFn,
  ) => Promise<HeadRecency | null>;
  /**
   * Milestone-base gate (Issue #4396): refuse to merge into a milestone
   * branch whose rollup PR has already merged or whose milestone is closed
   * — the branch's route to the default branch has closed and the work
   * would be orphaned. Defaults to {@link decideMilestoneBaseMerge}.
   */
  decideMilestoneBaseFn?: typeof decideMilestoneBaseMerge;
}

/** The PR head's identity and when its latest commit was made (Issue #4375). */
export interface HeadRecency {
  headSha: string;
  /** Epoch ms of the head commit's committedDate; null when unknown. */
  committedAtMs: number | null;
}

/** Default head-recency read (Issue #4375): one `gh pr view` round trip. */
export async function fetchHeadRecency(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn = runGhCommand,
): Promise<HeadRecency | null> {
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "headRefOid,commits",
      "--jq",
      "{headSha: .headRefOid, committedDate: (.commits[-1].committedDate // null)}",
    ]);
    const parsed = JSON.parse(raw) as {
      headSha?: string;
      committedDate?: string | null;
    };
    if (!parsed.headSha) return null;
    const ms = parsed.committedDate ? Date.parse(parsed.committedDate) : NaN;
    return {
      headSha: parsed.headSha,
      committedAtMs: Number.isFinite(ms) ? ms : null,
    };
  } catch {
    return null;
  }
}

/**
 * Options accepted by {@link directMergePr} — the gate's own overrides plus
 * the approved-default-branch policy (Issue #1082).
 */
export interface DirectMergeOptions extends PreMergeGateOptions {
  /**
   * Permit a default-branch target when the PR carries an approving review
   * from outside the fleet. Absent (the default) keeps the Issue #2416
   * refusal exactly as it was for every other call site.
   */
  approvedDefaultBranch?: ApprovedDefaultBranchPolicy;
}

/** Injectable pre-merge gate function type (enables testing). */
export type PreMergeGateFn = (
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn,
  options?: PreMergeGateOptions,
) => Promise<Result<PreMergeGateOutcome>>;

/** GitHub check run from the API. */
export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

/** GitHub check-runs API response shape. */
export interface CheckRunsResponse {
  total_count: number;
  check_runs: CheckRun[];
}

/** GitHub commit status entry. */
export interface CommitStatus {
  id: number;
  state: string;
  context: string;
  description: string;
}

/** GitHub combined status API response shape. */
export interface CombinedStatusResponse {
  state: string;
  statuses: CommitStatus[];
}

/** Injectable function type for running gh commands (enables testing). */
export type GhCommandFn = (args: string[]) => Promise<string>;

// =============================================================================
// checkCiStatus
// =============================================================================

/**
 * Query the GitHub API for the PR's check runs and commit statuses.
 *
 * Returns a Result indicating whether all checks have passed, are still
 * pending, or have failed.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - Pull request number
 * @param ghCommandFn - Injectable gh command runner (defaults to runGhCommand)
 * @returns Result with CiStatusResult
 */
export async function checkCiStatus(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn = runGhCommand,
): Promise<Result<CiStatusResult>> {
  // Try GraphQL statusCheckRollup first (single round-trip — Issue #1806).
  // Falls back to the legacy REST pair on any GraphQL failure.
  const batch = await fetchCheckRunsBatch(repo, [prNumber], ghCommandFn);
  if (batch.ok) {
    const rollup = batch.rollups.get(prNumber);
    if (rollup) {
      const checkRuns = rollupToCheckRunsResponse(rollup);
      const combinedStatus = rollupToCombinedStatusResponse(rollup);
      const status = determineCiStatus(
        checkRuns,
        combinedStatus,
        rollup.rollupState,
      );
      return {
        ok: true,
        value: rollup.headSha
          ? { status, headSha: rollup.headSha }
          : { status },
      };
    }
  }

  // Fallback: REST check-runs + status pair, keyed by head SHA.
  let prJson: string;
  try {
    prJson = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "headRefOid",
    ]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to fetch PR #${prNumber} from ${repo}: ${message}`,
      ),
    };
  }

  let headSha: string;
  try {
    const parsed = JSON.parse(prJson) as { headRefOid: string };
    headSha = parsed.headRefOid;
    if (!headSha) {
      return { ok: false, error: new Error(`PR #${prNumber} has no head SHA`) };
    }
  } catch {
    return {
      ok: false,
      error: new Error(`Failed to parse PR data for #${prNumber}`),
    };
  }

  let checkRunsJson: string;
  let combinedStatusJson: string;
  try {
    checkRunsJson = await ghCommandFn([
      "api",
      `repos/${repo}/commits/${headSha}/check-runs`,
      "--jq",
      "{total_count, check_runs: [.check_runs[] | {id, name, status, conclusion}]}",
    ]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to fetch check runs for PR #${prNumber}: ${message}`,
      ),
    };
  }

  try {
    combinedStatusJson = await ghCommandFn([
      "api",
      `repos/${repo}/commits/${headSha}/status`,
    ]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to fetch commit status for PR #${prNumber}: ${message}`,
      ),
    };
  }

  let checkRuns: CheckRunsResponse;
  let combinedStatus: CombinedStatusResponse;
  try {
    checkRuns = JSON.parse(checkRunsJson) as CheckRunsResponse;
    combinedStatus = JSON.parse(combinedStatusJson) as CombinedStatusResponse;
  } catch {
    return {
      ok: false,
      error: new Error(`Failed to parse CI status for PR #${prNumber}`),
    };
  }

  const status = determineCiStatus(checkRuns, combinedStatus);
  return { ok: true, value: { status, headSha } };
}

/**
 * Check-run conclusions that count as passing (Issue #3945).
 *
 * This is an **allowlist**: only these conclusions let a merge through.
 * `skipped` and `neutral` are included by explicit policy — a check that
 * deliberately did not apply is not a failure. Every other completed
 * conclusion (`failure`, `cancelled`, `timed_out`, `action_required`,
 * `startup_failure`, `stale`, and any value GitHub adds in future) fails
 * closed.
 */
const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

/** Commit-status states that count as passing (Issue #3945). */
const PASSING_STATUS_STATES = new Set(["success"]);

/** Commit-status states that mean "not finished yet" (Issue #3945). */
const PENDING_STATUS_STATES = new Set(["pending", "expected"]);

/** Severity ordering — the worst of two verdicts wins. */
const SEVERITY: Record<"passed" | "pending" | "failed", number> = {
  passed: 0,
  pending: 1,
  failed: 2,
};

/**
 * Map GitHub's aggregate `statusCheckRollup.state` onto a CI verdict.
 *
 * Allowlisted the same way as individual conclusions: only `SUCCESS` passes,
 * `PENDING`/`EXPECTED` are still running, and everything else — `FAILURE`,
 * `ERROR`, or a future enum value — fails closed.
 */
function rollupStateToCiStatus(
  state: string,
): "passed" | "pending" | "failed" {
  const normalised = state.trim().toLowerCase();
  if (PASSING_STATUS_STATES.has(normalised)) return "passed";
  if (PENDING_STATUS_STATES.has(normalised)) return "pending";
  return "failed";
}

/**
 * Determine the aggregate CI status from check runs and combined status.
 *
 * Logic:
 * - If no checks exist at all → no_checks (unverified, not green — #3705).
 * - If any check run's conclusion is not on the passing allowlist → failed.
 * - If the combined status state is not `success`/`pending` → failed.
 * - If any check run is not completed → pending.
 * - If combined status state is pending and has statuses → pending.
 * - If GitHub's own rollup state is supplied, the worse of the two verdicts
 *   wins (Issue #3945).
 * - Otherwise → passed.
 *
 * @param checkRuns - Check runs for the head commit
 * @param combinedStatus - Combined commit status for the head commit
 * @param rollupState - GitHub's aggregate `statusCheckRollup.state`, when the
 *   GraphQL path supplied one; `null` on the REST fallback path
 */
function determineCiStatus(
  checkRuns: CheckRunsResponse,
  combinedStatus: CombinedStatusResponse,
  rollupState: string | null = null,
): CiStatus {
  const hasCheckRuns = checkRuns.total_count > 0;
  const hasCommitStatuses = combinedStatus.statuses.length > 0;

  // No checks at all — nothing verified this commit, so it is not "passed"
  // (Issue #3705). The caller decides whether an operator override applies.
  if (!hasCheckRuns && !hasCommitStatuses) {
    return "no_checks";
  }

  const detail = determineDetailStatus(
    checkRuns,
    combinedStatus,
    hasCommitStatuses,
  );

  // Fold in GitHub's own aggregate verdict when the GraphQL path supplied one.
  // The worse verdict wins, so a red rollup can never be masked by check runs
  // that individually look green (Issue #3945).
  if (rollupState !== null && rollupState !== "") {
    const fromRollup = rollupStateToCiStatus(rollupState);
    return SEVERITY[fromRollup] > SEVERITY[detail] ? fromRollup : detail;
  }
  return detail;
}

/** Per-check verdict, before GitHub's aggregate rollup state is folded in. */
function determineDetailStatus(
  checkRuns: CheckRunsResponse,
  combinedStatus: CombinedStatusResponse,
  hasCommitStatuses: boolean,
): "passed" | "pending" | "failed" {
  // Any completed check run whose conclusion is not allowlisted is a failure.
  const hasFailedCheckRun = checkRuns.check_runs.some(
    (run) =>
      run.conclusion !== null && !PASSING_CONCLUSIONS.has(run.conclusion),
  );
  if (hasFailedCheckRun) {
    return "failed";
  }

  // Combined status: anything that is neither passing nor pending is a
  // failure — including "failure", "error", and any future state.
  const statusState = combinedStatus.state;
  if (
    !PASSING_STATUS_STATES.has(statusState) &&
    !PENDING_STATUS_STATES.has(statusState)
  ) {
    return "failed";
  }

  // Check for pending check runs
  const hasPendingCheckRun = checkRuns.check_runs.some(
    (run) => run.status !== "completed",
  );
  if (hasPendingCheckRun) {
    return "pending";
  }

  // Check for pending commit statuses
  if (PENDING_STATUS_STATES.has(statusState) && hasCommitStatuses) {
    return "pending";
  }

  return "passed";
}

// =============================================================================
// prTargetsDefaultBranch — blast-radius guard (Issue #2416)
// =============================================================================

/**
 * Determine whether a PR targets the repository's default branch.
 *
 * Direct merge (`gh pr merge --squash` without `--auto`, or `--merge` for a
 * milestone sync — Issue #1048) bypasses branch
 * protection and human review, so it must never reach the default branch of a
 * monitored repo. It is only safe for milestone (and other non-default)
 * branches, whose merge into the default branch goes through a separate,
 * human-reviewed PR. This helper lets {@link directMergePr} refuse a
 * default-branch target — capping what a hijacked run can push to the branch
 * that ships.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - Pull request number
 * @param ghCommandFn - Injectable gh command runner (defaults to runGhCommand)
 * @returns Result with `true` when the PR targets the default branch
 */
export async function prTargetsDefaultBranch(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn = runGhCommand,
): Promise<Result<boolean>> {
  let baseBranch: string;
  try {
    baseBranch = (await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "baseRefName",
      "--jq",
      ".baseRefName",
    ])).trim();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to fetch base branch for PR #${prNumber} in ${repo}: ${message}`,
      ),
    };
  }
  if (!baseBranch) {
    return {
      ok: false,
      error: new Error(`PR #${prNumber} in ${repo} has no base branch`),
    };
  }

  let defaultBranch: string;
  try {
    defaultBranch = (await ghCommandFn([
      "api",
      `repos/${repo}`,
      "--jq",
      ".default_branch",
    ])).trim();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to fetch default branch for ${repo}: ${message}`,
      ),
    };
  }
  if (!defaultBranch) {
    return {
      ok: false,
      error: new Error(`Could not determine default branch for ${repo}`),
    };
  }

  return { ok: true, value: baseBranch === defaultBranch };
}

// =============================================================================
// enforcePreMergeRequirements — pre-merge backstop gate (Issue #2582)
// =============================================================================

/** Injectable branch-state fetcher type (enables testing). */
type FetchBranchStateFn = typeof fetchPRBranchStateBatch;

/**
 * Pre-merge backstop gate: confirm a PR is safe to direct-merge.
 *
 * The direct-merge path bypasses GitHub branch protection, so the worker
 * enforces its own backstop (Issue #2582, part of #2561) immediately before
 * merging. The gate re-fetches the live state at merge time — never reusing a
 * value cached at PR-creation time — and refuses to merge unless:
 *
 *   1. CI status is `passed` (not `pending`, `failed`, or `no_checks`); and
 *   2. the feature branch is not behind its target (`behindBy === 0`), so a
 *      stale green CI result computed against an older base is never trusted.
 *
 * On success the outcome carries `headSha` — the exact commit the checks were
 * read for — so {@link directMergePr} can pin the merge to it (Issue #3946).
 *
 * Zero checks is *not* success (Issue #3705): a head commit with no check runs
 * and no commit statuses is unverified, and the gate refuses it unless the
 * operator passes an explicit `allowNoChecks` override. Even under that
 * override the branch-freshness requirement still applies.
 *
 * A blocked outcome is returned as `{ ok: true, value: { allowed: false,
 * reason } }` — it is an expected, recoverable state, not an error. Genuine
 * lookup failures (CI fetch, branch-state fetch) return `{ ok: false, error }`
 * so the caller fails closed and retries on the next maintenance scan.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - Pull request number
 * @param ghCommandFn - Injectable gh command runner (defaults to runGhCommand)
 * @param options - Operator overrides (see {@link PreMergeGateOptions})
 * @param checkCiStatusFn - Injectable CI status checker (enables testing)
 * @param fetchBranchStateFn - Injectable branch-state fetcher (enables testing)
 * @returns Result with the gate outcome
 */
export async function enforcePreMergeRequirements(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn = runGhCommand,
  options: PreMergeGateOptions = {},
  checkCiStatusFn: typeof checkCiStatus = checkCiStatus,
  fetchBranchStateFn: FetchBranchStateFn = fetchPRBranchStateBatch,
): Promise<Result<PreMergeGateOutcome>> {
  // 1. Re-fetch CI status at merge time.
  const ci = await checkCiStatusFn(repo, prNumber, ghCommandFn);
  if (!ci.ok) {
    return { ok: false, error: ci.error };
  }
  if (ci.value.status === "pending") {
    return { ok: true, value: { allowed: false, reason: "checks_pending" } };
  }
  if (ci.value.status === "failed") {
    return { ok: true, value: { allowed: false, reason: "checks_failed" } };
  }
  // Nothing verified this commit — fail closed unless explicitly overridden.
  if (ci.value.status === "no_checks" && options.allowNoChecks !== true) {
    return { ok: true, value: { allowed: false, reason: "no_checks" } };
  }

  // 2. Re-fetch fresh branch state so a stale green CI result is never trusted.
  //    Both refs come back in one read: the ahead/behind comparison has to be
  //    oriented base-to-head, so the head ref is not optional (Issue #470).
  let baseRefName: string;
  let headRefName: string;
  try {
    const raw = await ghCommandFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "baseRefName,headRefName",
    ]);
    const parsed = JSON.parse(raw) as {
      baseRefName?: unknown;
      headRefName?: unknown;
    };
    baseRefName = typeof parsed.baseRefName === "string"
      ? parsed.baseRefName.trim()
      : "";
    headRefName = typeof parsed.headRefName === "string"
      ? parsed.headRefName.trim()
      : "";
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: new Error(
        `Failed to fetch base branch for PR #${prNumber} in ${repo}: ${message}`,
      ),
    };
  }
  if (!baseRefName) {
    return {
      ok: false,
      error: new Error(`PR #${prNumber} in ${repo} has no base branch`),
    };
  }
  if (!headRefName) {
    return {
      ok: false,
      error: new Error(
        `PR #${prNumber} in ${repo} has no head branch, so its ahead/behind ` +
          `comparison cannot be oriented (Issue #470)`,
      ),
    };
  }

  // 2b. Never merge into a milestone branch whose route to the default
  //     branch has closed (Issue #4396): seven fixes merged into
  //     milestone/clean-up eleven days after its rollup PR #3125 had merged
  //     and evaporated with the branch while their issues closed COMPLETED.
  //     A non-milestone base costs nothing here.
  const routeGate = await (options.decideMilestoneBaseFn ??
    decideMilestoneBaseMerge)({
      repo,
      prNumber,
      baseRefName,
      ghCommandFn,
    });
  // Issue #477: an unreadable route defers like any other transient gate
  // failure; only positive evidence refuses the merge outright.
  if (routeGate.decision === "defer") {
    return {
      ok: true,
      value: {
        allowed: false,
        reason: "milestone_route_unreadable",
        detail: routeGate.detail,
      },
    };
  }
  if (routeGate.decision === "block") {
    return {
      ok: true,
      value: {
        allowed: false,
        reason: "milestone_rollup_merged",
        detail: routeGate.detail,
      },
    };
  }

  const batch = await fetchBranchStateFn(
    repo,
    [{ number: prNumber, baseRefName, headRefName }],
    ghCommandFn,
  );
  if (!batch.ok) {
    return { ok: false, error: batch.error };
  }
  const state = batch.states.get(prNumber);
  if (!state) {
    return {
      ok: false,
      error: new Error(
        `No branch state returned for PR #${prNumber} in ${repo}`,
      ),
    };
  }
  if (state.behindBy > 0) {
    return { ok: true, value: { allowed: false, reason: "behind_target" } };
  }

  // 3. The head must be settled (Issue #4375): a commit pushed moments ago
  //    may not have its check suites yet, and a head that moved since the
  //    CI read was not the one those checks ran on.
  const minHeadAge = options.minHeadAgeSeconds ?? MIN_HEAD_AGE_SECONDS;
  const recency = await (options.fetchHeadRecency ?? fetchHeadRecency)(
    repo,
    prNumber,
    ghCommandFn,
  );
  if (recency) {
    if (ci.value.headSha && recency.headSha !== ci.value.headSha) {
      return { ok: true, value: { allowed: false, reason: "head_moved" } };
    }
    const now = (options.nowMs ?? Date.now)();
    if (
      minHeadAge > 0 && recency.committedAtMs !== null &&
      now - recency.committedAtMs < minHeadAge * 1000
    ) {
      return {
        ok: true,
        value: { allowed: false, reason: "head_too_recent" },
      };
    }
  }

  // Report the SHA the checks were read for so the merge can be pinned to it
  // (Issue #3946).
  const headSha = ci.value.headSha ?? recency?.headSha;
  return {
    ok: true,
    value: headSha
      ? { allowed: true, headSha, headRefName }
      : { allowed: true, headRefName },
  };
}

// =============================================================================
// directMergePr
// =============================================================================

/**
 * Merge the PR directly via `gh pr merge --squash` (without --auto), or
 * `--merge` when the head is a milestone sync branch (Issue #1048).
 *
 * Only call this when all checks have passed.
 *
 * Blast-radius guard (Issue #2416): refuses to merge a PR that targets the
 * repository's default branch. Direct merge bypasses review and branch
 * protection, so a default-branch PR must instead go through native
 * auto-merge (which respects branch protection) or a human merge. The guard
 * fails closed — if the target branch cannot be confirmed as non-default the
 * merge is refused and retried on the next maintenance scan, so a transient
 * lookup failure never silently pushes code to the default branch.
 *
 * Approved default branch (Issue #1082): when the caller supplies an
 * {@link ApprovedDefaultBranchPolicy} — only `enableAutoMerge` does, and only
 * for a base with no required checks, where native auto-merge is unusable — a
 * default-branch PR carrying an approving review from outside the fleet
 * proceeds to the same gate as any other PR. Without that approval it is a
 * typed deferral (`blocked: "default_branch_unapproved"`), so the PR is held
 * and the hold is logged rather than retried as a failure forever.
 *
 * Pre-merge backstop (Issue #2582): before merging, {@link
 * enforcePreMergeRequirements} re-fetches CI status and branch freshness and
 * refuses to merge unless CI is green and the branch is current. A blocked
 * outcome returns `{ ok: true, value: { merged: false, blocked } }` (a typed,
 * non-throwing deferral); a behind branch leaves the PR open for the
 * branch-update maintenance cycle to rebase and re-evaluate. Because the gate
 * lives inside `directMergePr`, every direct-merge caller is protected by
 * construction.
 *
 * Unverified heads (Issue #3705): a PR whose head commit has no check runs and
 * no commit statuses is blocked with `no_checks` unless the caller passes the
 * explicit `allowNoChecks` operator override.
 *
 * SHA-pinned merge (Issue #3946): the merge names the exact commit the gate
 * read its checks for (`--match-head-commit`), closing the TOCTOU window
 * between the check read and the merge call. A head that moved inside that
 * window is a deferral (`blocked: "head_moved"`), not an error — the next
 * maintenance cycle re-reads the checks for the new head. A gate outcome with
 * no head SHA is refused outright, since an unpinnable merge cannot be tied to
 * the verdict that allowed it.
 *
 * @param repo - Repository in "owner/repo" format
 * @param prNumber - Pull request number
 * @param ghCommandFn - Injectable gh command runner (defaults to runGhCommand)
 * @param gateFn - Injectable pre-merge gate (defaults to enforcePreMergeRequirements)
 * @param options - Operator overrides passed through to the gate
 * @returns Result with MergeResult
 */
export async function directMergePr(
  repo: string,
  prNumber: number,
  ghCommandFn: GhCommandFn = runGhCommand,
  gateFn: PreMergeGateFn = enforcePreMergeRequirements,
  options: DirectMergeOptions = {},
): Promise<Result<MergeResult>> {
  const guard = await prTargetsDefaultBranch(repo, prNumber, ghCommandFn);
  if (!guard.ok) {
    return {
      ok: false,
      error: new Error(
        `Refusing to direct-merge PR #${prNumber} in ${repo}: could not confirm its target is not the default branch (${guard.error.message}). Direct merge is only permitted for non-default branches (Issue #2416).`,
      ),
    };
  }
  if (guard.value) {
    const policy = options.approvedDefaultBranch;
    if (!policy) {
      return {
        ok: false,
        error: new Error(
          `Refusing to direct-merge PR #${prNumber} in ${repo}: it targets the default branch. Default-branch PRs must merge via branch protection or a human review (Issue #2416).`,
        ),
      };
    }

    // Issue #1082: the guard asks for "branch protection or a human review".
    // There is no protection on this base, so the review has to be real —
    // an approval from a login outside the fleet. Fail closed: an unreadable
    // review list is a refusal, never an implied approval.
    let reviews: PrReview[];
    try {
      reviews = await (policy.fetchReviewsFn ?? fetchPrReviews)(
        repo,
        prNumber,
        ghCommandFn,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: new Error(
          `Refusing to direct-merge PR #${prNumber} in ${repo}: its reviews could not be read (${message}), so the approval the default-branch guard requires cannot be confirmed. Failing closed; will retry on the next maintenance scan (Issue #1082).`,
        ),
      };
    }

    if (!hasNonFleetApproval(reviews, policy.fleetAuthors)) {
      // A deliberate hold, not a fault — leave the PR open and say why.
      return {
        ok: true,
        value: { merged: false, blocked: "default_branch_unapproved" },
      };
    }
  }

  // Pre-merge backstop gate (Issue #2582): CI must be green and branch current.
  const gate = await gateFn(repo, prNumber, ghCommandFn, {
    allowNoChecks: options.allowNoChecks === true,
  });
  if (!gate.ok) {
    return {
      ok: false,
      error: new Error(
        `Refusing to direct-merge PR #${prNumber} in ${repo}: pre-merge gate could not confirm CI/branch state (${gate.error.message}). Failing closed; will retry on the next maintenance scan (Issue #2582).`,
      ),
    };
  }
  if (!gate.value.allowed) {
    // Typed, non-throwing deferral — leave the PR open for the next cycle.
    return { ok: true, value: { merged: false, blocked: gate.value.reason } };
  }

  // The merge must name the exact commit the gate evaluated (Issue #3946).
  // Without it the gate's verdict is unattributable, so refuse loudly rather
  // than merging whatever the head happens to be now.
  const headSha = gate.value.headSha;
  if (!headSha) {
    return {
      ok: false,
      error: new Error(
        `Refusing to direct-merge PR #${prNumber} in ${repo}: the pre-merge gate did not report the head SHA its checks were read for, so the merge cannot be pinned to it. Failing closed; will retry on the next maintenance scan (Issue #3946).`,
      ),
    };
  }

  try {
    await ghCommandFn([
      "pr",
      "merge",
      String(prNumber),
      "--repo",
      repo,
      // A milestone sync lands as a merge commit so the default branch is a
      // genuine ancestor of the milestone branch (Issue #1048); every other
      // PR squashes as before.
      mergeMethodFlagForHead(gate.value.headRefName),
      // Pin the merge to the checked commit — GitHub refuses the merge if the
      // head moved after the checks were read (Issue #3946).
      "--match-head-commit",
      headSha,
    ]);
    return { ok: true, value: { merged: true } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (isHeadMovedError(message)) {
      // The head advanced inside the check-to-merge window. That is an
      // expected race, not a fault: leave the PR open so the next maintenance
      // cycle re-reads the checks for the new head.
      return { ok: true, value: { merged: false, blocked: "head_moved" } };
    }
    return {
      ok: false,
      error: new Error(
        `Failed to merge PR #${prNumber} in ${repo}: ${message}`,
      ),
    };
  }
}

/**
 * Recognise GitHub's "the head moved" refusal of a SHA-pinned merge.
 *
 * `gh pr merge --match-head-commit <sha>` forwards the SHA as the merge API's
 * expected head. When the PR head has advanced, GitHub refuses with one of
 * several wordings — "Head branch was modified…" (REST 409) or an expected-head
 * SHA mismatch (GraphQL `expectedHeadOid`). Matching the wording keeps a
 * genuine merge failure (protection rule, conflict) loud while the benign race
 * defers (Issue #3946).
 *
 * @param message - Error message from the failed `gh pr merge` call
 * @returns True when the refusal was caused by the head having moved
 */
export function isHeadMovedError(message: string): boolean {
  const text = message.toLowerCase();
  if (text.includes("head branch was modified")) return true;
  if (text.includes("head commit has changed")) return true;
  if (text.includes("expected head")) return true;
  // "Head sha did not match…" / "…didn't match current head ref."
  return text.includes("head") && text.includes("sha") &&
    text.includes("match");
}
