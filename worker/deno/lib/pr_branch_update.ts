/**
 * PR branch update decision logic (Issue #1122).
 *
 * Determines which open PRs need their branches updated by checking
 * how far behind the base branch they are and whether they have
 * merge conflicts.
 *
 * Issue #1281: Integrates distributed locking to prevent concurrent
 * workers from updating the same PR branch simultaneously.
 *
 * Migrated from update_open_pr_branches() in worker/issue_worker.sh.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { isPrBranchConflictError } from "./git_pull.ts";
import {
  classifyCloneContention,
  describeCloneContention,
} from "./clone_contention.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import type { Logger, Result } from "../types.ts";
import type { BranchUpdateLockResult } from "./pr_branch_lock.ts";
import {
  acquireBranchUpdateLock,
  releaseBranchUpdateLock,
} from "./pr_branch_lock.ts";
import { WORKER_PR_MARKER_PREFIX } from "./pr_body.ts";
import {
  checkPrBranchUpdateSuppression,
  clearPrBranchUpdateFailure,
  recordPrBranchUpdateFailure,
} from "./pr_branch_update_failure_streak.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reason a PR branch needs updating. */
export type UpdateReason = "behind" | "conflicting";

/** A PR that needs its branch updated. */
export interface PrBranchUpdateAction {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Feature branch name. */
  branchName: string;
  /** Base branch the PR targets. */
  baseBranch: string;
  /** How many commits behind the base branch. */
  behindBy: number;
  /** Why the branch needs updating. */
  reason: UpdateReason;
}

/** Summary of a PR branch update scan. */
export interface PrBranchUpdateScanResult {
  /** PRs that need updating. */
  actions: PrBranchUpdateAction[];
  /** Number of PRs already up-to-date. */
  skippedCount: number;
  /** Number of PRs that failed to check. */
  failedCount: number;
}

/** PR listing entry for branch update checks. */
export interface PrBranchEntry {
  number: number;
  headRefName: string;
  baseRefName: string;
}

/** Detail of a single PR branch update execution. */
export interface PrBranchUpdateDetail {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number. */
  prNumber: number;
  /** Feature branch name. */
  branchName: string;
  /**
   * Whether the update succeeded, failed, conflicted, had nothing left to do
   * because the PR merged or closed mid-cycle (Issue #386), or could not run
   * because another lane held this host's clone (Issue #394).
   */
  status: "updated" | "failed" | "conflict" | "merged" | "contended";
  /** Human-readable description of the outcome. */
  message: string;
}

/**
 * A PR's live state at the moment of action (Issue #386).
 *
 * `UNKNOWN` means the lookup was unavailable or failed — never "fine to
 * skip". The update proceeds and any failure stays loud.
 */
export type PrLiveState = "OPEN" | "MERGED" | "CLOSED" | "UNKNOWN";

/** Map a raw `gh pr view --json state` value onto {@link PrLiveState}. */
export function classifyPrLiveState(raw: string): PrLiveState {
  const state = raw.trim().toUpperCase();
  if (state === "OPEN" || state === "MERGED" || state === "CLOSED") {
    return state;
  }
  return "UNKNOWN";
}

/**
 * Build the `getPrState` dependency from a `gh` runner (Issue #386).
 *
 * Kept here so both wiring sites (the `pr-maintenance` command and the main
 * loop's production deps) ask the same question the same way.
 */
export function makeGhPrStateFetcher(
  ghFn: (args: string[]) => Promise<string>,
): (repo: string, prNumber: number) => Promise<string> {
  return (repo: string, prNumber: number) =>
    ghFn([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "state",
      "--jq",
      ".state",
    ]);
}

/** Overall result of executing PR branch updates (Issue #1233). */
export interface PrBranchUpdateExecutionResult {
  /** Number of PRs successfully updated. */
  updatedCount: number;
  /** Number of PRs that failed to update. */
  failedCount: number;
  /**
   * PRs whose changes collide with the base and were left untouched
   * (Issue #4373) — they need a real merge, not a side-pick.
   */
  conflictCount?: number;
  /**
   * PRs that merged or closed between the scan and the push (Issue #386).
   * Nothing failed and nothing was left to do, so these are counted apart
   * from `failedCount` — a real push rejection must stay distinguishable
   * from a mid-cycle merge.
   */
  mergedCount?: number;
  /** Number of PRs skipped because another worker holds the lock (Issue #1281). */
  lockedCount: number;
  /**
   * PRs left alone because another lane on this host held the clone
   * (Issue #394) — a branch it had checked out, a git lock, unpushed commits
   * it has not published yet. Nothing about the PR failed, so these are
   * counted apart from `failedCount` and retried next cycle.
   */
  contendedCount?: number;
  /**
   * PRs skipped because their branch has already been escalated after
   * repeated failures (Issue #335) — retrying them every cycle changed
   * nothing but the log volume.
   */
  suppressedCount?: number;
  /** Per-PR update details. */
  details: PrBranchUpdateDetail[];
}

/** Injectable dependencies for executing PR branch updates (Issue #1233). */
export interface PrBranchExecutionDeps {
  /** Working directory where repos are cloned. */
  workDir: string;
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Set up a repository (clone/update). Returns repo path on success. */
  setupRepo: (repo: string, workDir: string) => Promise<Result<string>>;
  /** Get a repo's default branch. */
  getDefaultBranch: (repo: string) => Promise<string>;
  /** Execute git operations for a single PR branch update. */
  performBranchUpdate: (params: {
    repoPath: string;
    branchName: string;
    baseBranch: string;
    defaultBranch: string;
    /** Why the branch needs updating (Issue #1313). */
    reason: UpdateReason;
  }) => Promise<Result<string>>;
  /**
   * Unique worker identifier for distributed locking (Issue #1281).
   * When set, enables distributed lock acquisition before each branch
   * update to prevent concurrent workers from updating the same PR.
   */
  workerId?: string;
  /**
   * Acquire a distributed lock for a PR branch update (Issue #1281).
   * Injected for testability. Defaults to acquireBranchUpdateLock.
   */
  acquireLock?: (options: {
    repo: string;
    prNumber: number;
    workerId: string;
    sleepFn?: (ms: number) => Promise<void>;
    ghCommandFn?: (args: string[]) => Promise<string>;
    nowFn?: () => number;
  }) => Promise<Result<BranchUpdateLockResult>>;
  /**
   * Release a distributed lock for a PR branch update (Issue #1281).
   * Injected for testability. Defaults to releaseBranchUpdateLock.
   */
  releaseLock?: (options: {
    repo: string;
    prNumber: number;
    lockCommentId: number;
    ghCommandFn?: (args: string[]) => Promise<string>;
  }) => Promise<Result<void>>;
  /**
   * Per-`(repo, branch)` failure-streak tracking (Issue #335). Omit it and
   * the pass behaves exactly as before — every failure is retried next cycle.
   */
  failureStreak?: PrBranchFailureStreakDeps;
  /**
   * Live PR-state lookup, returning a raw `gh` state string (Issue #386).
   *
   * Called immediately before the push, and again when the update fails, so
   * a PR that merged inside the scan→push window is reported as a no-op
   * instead of a push failure. Omit it and the pass behaves exactly as
   * before — every failure is counted and warned about.
   */
  getPrState?: (repo: string, prNumber: number) => Promise<string>;
}

/**
 * Wiring for the per-branch failure streak (Issue #335).
 *
 * Only `gh` is injected; the streak state itself is real, so tests exercise
 * the same counting, escalation and suppression the worker runs.
 */
export interface PrBranchFailureStreakDeps {
  /** Streak state file — see `prBranchFailureStatePath()`. */
  statePath: string;
  /** Identifies this cycle; repeats within it do not count twice. */
  cycleId: string;
  /** gh runner used to file the escalation issue. */
  ghFn: (args: string[]) => Promise<string>;
  /** Consecutive failing cycles before escalating (default 3). */
  threshold?: number;
  /** Cycles an escalated branch is skipped before one re-probe (default 10). */
  retryAfterSkips?: number;
}

/**
 * Pre-fetched per-PR branch state (Issue #1807). When the batch
 * helper succeeds it returns one of these per PR; missing entries
 * cause the scanner to fall back to per-PR REST.
 */
export interface PrBranchStateEntry {
  /** Commits the head is behind the base. */
  behindBy: number;
  /** GitHub mergeable state ("MERGEABLE" / "CONFLICTING" / etc.). */
  mergeable: string;
}

/** Injectable dependencies for PR branch update scanning. */
export interface PrBranchUpdateDeps {
  /** Repositories to scan. */
  repos: readonly string[];
  /** Logger for diagnostic output. */
  logger: Logger;
  /** Check if a repo is in the allowlist. */
  isRepoAllowed: (repo: string) => boolean;
  /** Get a repo's default branch. */
  getDefaultBranch: (repo: string) => Promise<string>;
  /** List open worker PRs for a repo (identified by body marker). */
  listPrs: (repo: string) => Promise<PrBranchEntry[]>;
  /** Get how many commits a branch is behind its base. */
  getBehindBy: (
    repo: string,
    baseBranch: string,
    headBranch: string,
  ) => Promise<number>;
  /** Check if a PR has merge conflicts (returns "CONFLICTING" or other). */
  getMergeableStatus: (repo: string, prNumber: number) => Promise<string>;
  /**
   * Optional batched branch-state fetcher (Issue #1807).
   *
   * Called once per repo with the full PR list. If it returns a non-null
   * map, the scanner uses it instead of calling `getBehindBy` /
   * `getMergeableStatus` per PR. Returning `null` (e.g. on GraphQL
   * outage) signals the scanner to fall back to the per-PR REST pair.
   *
   * For N PRs in one repo this turns 2N REST calls into 1 GraphQL call.
   */
  fetchBranchStateBatch?: (
    repo: string,
    prs: readonly PrBranchEntry[],
  ) => Promise<Map<number, PrBranchStateEntry> | null>;
}

// ---------------------------------------------------------------------------
// Conflict warning suppression (Issue #84)
// ---------------------------------------------------------------------------

/**
 * PRs already warned about this process, keyed `repo#number`.
 *
 * The "needs a real merge" warning used to fire on every ~2.5-minute pass
 * for as long as the PR stayed conflicting — six hours of identical log
 * lines in the observed case. The queue is now visible as the
 * `merge-conflict` label the conflict pass applies, so the log line only
 * needs to fire once per PR.
 */
const warnedConflicts = new Set<string>();

/**
 * Whether the conflict warning for this PR has yet to be emitted.
 *
 * Returns true exactly once per PR per process; subsequent calls for the
 * same PR return false.
 */
export function shouldWarnPrConflictOnce(
  repo: string,
  prNumber: number,
): boolean {
  const key = `${repo}#${prNumber}`;
  if (warnedConflicts.has(key)) return false;
  warnedConflicts.add(key);
  return true;
}

/** Clear the warned-PR set. Exported for tests. */
export function resetPrConflictWarnings(): void {
  warnedConflicts.clear();
}

// ---------------------------------------------------------------------------
// Worker PR identification
// ---------------------------------------------------------------------------

/** The branch-name shape a worker-created PR uses: `issue-<n>-…`. */
const WORKER_PR_BRANCH_RE = /^issue-\d+-/;

/** True when `ref` is safe to hand git as a positional (no leading dash). */
function isSafeGitRef(ref: string | undefined): boolean {
  return ref !== undefined && ref !== "" && !ref.startsWith("-");
}

/**
 * Check whether a PR was created by the worker.
 *
 * Two signals: the branch-name shape (`issue-<n>-…`), which the worker
 * controls, and the body marker ({@link WORKER_PR_MARKER_PREFIX}), a fixed
 * public HTML comment any PR author can paste into their own body. The
 * marker is a legitimate fallback for worker PRs on other branch shapes
 * (milestone PRs, older PRs), but on its own it is spoofable (Issue #12): an
 * outside PR could carry the marker to be treated as worker-owned and route
 * its attacker-controlled head branch into the maintenance git commands.
 *
 * So the marker path additionally requires the head branch to be a safe git
 * ref (no leading dash — the argument-injection shape). The git commands are
 * independently hardened (`git_ref_args.ts`); this keeps a spoofed PR from
 * even being *selected* for maintenance. The `issue-<n>-` shape already
 * excludes a dash-leading name, so it needs no extra check.
 */
export function isWorkerPr(
  body: string | undefined,
  branchName?: string,
): boolean {
  if (branchName && WORKER_PR_BRANCH_RE.test(branchName)) return true;
  if (body && body.includes(WORKER_PR_MARKER_PREFIX)) {
    return isSafeGitRef(branchName);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core decision logic
// ---------------------------------------------------------------------------

/**
 * Determine the update action for a single PR.
 *
 * Returns an action if the PR needs updating, or null if it can be skipped.
 *
 * Decision rules:
 * 1. If behind_by > 0 → needs update (reason: "behind")
 * 2. If behind_by == 0 and mergeable == "CONFLICTING" → needs update (reason: "conflicting")
 * 3. Otherwise → skip (already current and no conflicts)
 */
export function decidePrUpdateAction(
  repo: string,
  pr: PrBranchEntry,
  baseBranch: string,
  behindBy: number,
  mergeableStatus: string,
): PrBranchUpdateAction | null {
  if (behindBy > 0) {
    return {
      repo,
      prNumber: pr.number,
      branchName: pr.headRefName,
      baseBranch,
      behindBy,
      reason: "behind",
    };
  }

  if (mergeableStatus === "CONFLICTING") {
    return {
      repo,
      prNumber: pr.number,
      branchName: pr.headRefName,
      baseBranch,
      behindBy: 0,
      reason: "conflicting",
    };
  }

  return null;
}

/**
 * Scan open PRs across all repos and determine which need updating.
 *
 * This is the decision logic only — it does not perform git operations.
 * The caller (shell or Deno orchestrator) is responsible for acting
 * on the returned actions.
 *
 * @param deps - Injectable dependencies for scanning
 * @returns Result containing scan results with actions to take
 */
export async function scanPrBranchUpdates(
  deps: PrBranchUpdateDeps,
): Promise<Result<PrBranchUpdateScanResult>> {
  const actions: PrBranchUpdateAction[] = [];
  let skippedCount = 0;
  let failedCount = 0;

  if (deps.repos.length === 0) {
    deps.logger.info("No repositories configured — skipping PR branch updates");
    return { ok: true, value: { actions, skippedCount, failedCount } };
  }

  for (const repo of deps.repos) {
    if (!deps.isRepoAllowed(repo)) {
      continue;
    }

    let defaultBranch: string;
    try {
      defaultBranch = await deps.getDefaultBranch(repo);
    } catch {
      defaultBranch = "main"; // allow-hardcoded-branch — fallback after dynamic detection
    }

    let prs: PrBranchEntry[];
    try {
      prs = await deps.listPrs(repo);
    } catch {
      deps.logger.warn("Failed to list PRs for repo", { repo });
      continue;
    }

    // Issue #1807: batch fetch ahead/behind/mergeable for every PR via
    // GraphQL. On success, the map below short-circuits the per-PR REST
    // pair below; on failure (or when no batch fetcher is wired) we fall
    // through to the existing getBehindBy / getMergeableStatus path.
    let batchState: Map<number, PrBranchStateEntry> | null = null;
    if (deps.fetchBranchStateBatch && prs.length > 0) {
      try {
        batchState = await deps.fetchBranchStateBatch(repo, prs);
      } catch {
        batchState = null;
      }
    }

    for (const pr of prs) {
      const baseBranch = pr.baseRefName || defaultBranch;

      let behindBy: number;
      let mergeableStatus = "";

      const cached = batchState?.get(pr.number);
      if (cached) {
        behindBy = cached.behindBy;
        mergeableStatus = cached.mergeable;
      } else {
        try {
          behindBy = await deps.getBehindBy(repo, baseBranch, pr.headRefName);
        } catch (err) {
          // Issue #231: a PR that cannot even be compared must be named —
          // a bare counter hid which one failed every hour.
          failedCount++;
          deps.logger.warn(
            `PR #${pr.number} (${pr.headRefName}) ahead/behind lookup against ${baseBranch} failed — skipped this pass: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { repo, prNumber: pr.number },
          );
          continue;
        }

        // Only check mergeable status when branch appears current
        if (behindBy === 0) {
          try {
            mergeableStatus = await deps.getMergeableStatus(repo, pr.number);
          } catch {
            // If we cannot determine mergeability, skip this PR
            skippedCount++;
            continue;
          }
        }
      }

      const action = decidePrUpdateAction(
        repo,
        pr,
        baseBranch,
        behindBy,
        mergeableStatus,
      );

      if (action) {
        deps.logger.info(
          action.reason === "behind"
            ? `PR #${pr.number} (${pr.headRefName}) is ${behindBy} commit(s) behind ${baseBranch} — needs update`
            : `PR #${pr.number} (${pr.headRefName}) has merge conflicts — needs resolution`,
          { repo, prNumber: pr.number, reason: action.reason },
        );
        actions.push(action);
      } else {
        skippedCount++;
      }
    }
  }

  deps.logger.info("PR branch update scan complete", {
    actionsCount: actions.length,
    skippedCount,
    failedCount,
  });

  return { ok: true, value: { actions, skippedCount, failedCount } };
}

// ---------------------------------------------------------------------------
// Execution — Issue #1233
// ---------------------------------------------------------------------------

/**
 * Read a PR's live state, or `UNKNOWN` when it cannot be established
 * (Issue #386).
 *
 * A lookup that fails is warned about and returns `UNKNOWN`, which never
 * excuses anything: the caller proceeds with the update and still counts a
 * genuine failure as a failure.
 */
async function resolvePrLiveState(
  deps: PrBranchExecutionDeps,
  action: PrBranchUpdateAction,
): Promise<PrLiveState> {
  if (!deps.getPrState) return "UNKNOWN";
  try {
    return classifyPrLiveState(
      await deps.getPrState(action.repo, action.prNumber),
    );
  } catch (err) {
    deps.logger.warn(
      `PR #${action.prNumber} (${action.branchName}) state lookup failed — ` +
        `proceeding with the branch update: ${
          err instanceof Error ? err.message : String(err)
        }`,
      { repo: action.repo, prNumber: action.prNumber },
    );
    return "UNKNOWN";
  }
}

/** True when the PR is finished, so its branch update has nothing left to do. */
function isFinishedPrState(state: PrLiveState): boolean {
  return state === "MERGED" || state === "CLOSED";
}

/**
 * Execute PR branch updates for the given actions.
 *
 * For each action: set up the repo, perform the branch update (fetch,
 * checkout, rebase, force-push), and restore the default branch.
 *
 * Issue #1281: When workerId is provided, acquires a distributed lock
 * before each update and releases it afterwards. PRs that are locked
 * by another worker are skipped.
 *
 * Issue #386: the scan decides from a snapshot and the push happens up to a
 * minute later, so a PR can merge inside that window and `--force-with-lease`
 * then refuses the push with `(stale info)` — the lease working, not a
 * failure. When `getPrState` is wired, the PR's freshness is re-checked
 * immediately before the push and again after a failed update; a PR that has
 * merged or closed is counted as `mergedCount` at INFO. Every rejection
 * against a PR that is *still open* stays a `failedCount` WARNING.
 *
 * This replaces the shell-based git orchestration that previously parsed
 * pipe-delimited output from the scan phase.
 *
 * @param actions - PR branch update actions from scanPrBranchUpdates()
 * @param deps - Injectable dependencies for execution
 * @returns Result containing execution summary with per-PR details
 */
export async function executePrBranchUpdates(
  actions: PrBranchUpdateAction[],
  deps: PrBranchExecutionDeps,
): Promise<Result<PrBranchUpdateExecutionResult>> {
  let updatedCount = 0;
  let failedCount = 0;
  let conflictCount = 0;
  let lockedCount = 0;
  let contendedCount = 0;
  let suppressedCount = 0;
  let mergedCount = 0;
  const details: PrBranchUpdateDetail[] = [];

  const doAcquireLock = deps.acquireLock ?? acquireBranchUpdateLock;
  const doReleaseLock = deps.releaseLock ?? releaseBranchUpdateLock;
  const streak = deps.failureStreak;

  for (const action of actions) {
    // Issue #409: a PR that has merged or closed is settled before anything
    // else is considered — including the suppression check below. Suppression
    // short-circuits the loop, so a branch whose streak had already escalated
    // never reached the finished-PR check that Issue #386 added, and its
    // streak could never clear: no update will ever succeed on a merged PR,
    // and success was the only thing that cleared it. The escalation issue
    // then stayed open for ever describing work nobody could do — #409 is
    // exactly that, filed against PR #405's branch, which had merged.
    if (streak) {
      const settledState = await resolvePrLiveState(deps, action);
      if (isFinishedPrState(settledState)) {
        mergedCount++;
        const verb = settledState === "MERGED" ? "merged" : "closed";
        deps.logger.info(
          `PR #${action.prNumber} (${action.branchName}) is ${verb} — ` +
            `clearing its branch-update failure streak (Issue #409)`,
          { repo: action.repo, prNumber: action.prNumber },
        );
        await clearPrBranchUpdateFailure(
          streak.statePath,
          action.repo,
          action.branchName,
          (message: string) => deps.logger.warn(message),
        );
        details.push({
          repo: action.repo,
          prNumber: action.prNumber,
          branchName: action.branchName,
          status: "merged",
          message: `PR ${verb}; failure streak cleared`,
        });
        continue;
      }
    }

    // Issue #335: a branch that has already been escalated after repeated
    // failures is skipped rather than retried — 65 identical warnings for one
    // branch is the state this replaces. It is re-probed periodically, so a
    // branch that is fixed recovers without anyone touching the worker.
    if (streak) {
      const suppression = await checkPrBranchUpdateSuppression({
        statePath: streak.statePath,
        repo: action.repo,
        branch: action.branchName,
        cycleId: streak.cycleId,
        retryAfterSkips: streak.retryAfterSkips,
        log: (message: string) => deps.logger.warn(message),
      });
      if (suppression.suppressed) {
        suppressedCount++;
        deps.logger.info(
          `PR #${action.prNumber} (${action.branchName}) branch update skipped — ` +
            `${suppression.count} consecutive failures already escalated${
              suppression.issueNumber ? ` as #${suppression.issueNumber}` : ""
            } (Issue #335)`,
          { repo: action.repo, prNumber: action.prNumber },
        );
        details.push({
          repo: action.repo,
          prNumber: action.prNumber,
          branchName: action.branchName,
          status: "failed",
          message: `Skipped: ${suppression.count} consecutive failures ` +
            `escalated${
              suppression.issueNumber ? ` as #${suppression.issueNumber}` : ""
            }`,
        });
        continue;
      }
    }

    // Log what we're about to do
    if (action.reason === "behind") {
      deps.logger.info(
        `PR #${action.prNumber} (${action.branchName}) is ${action.behindBy} commit(s) behind ${action.baseBranch} — updating...`,
        { repo: action.repo, prNumber: action.prNumber },
      );
    } else {
      deps.logger.info(
        `PR #${action.prNumber} (${action.branchName}) has merge conflicts — resolving...`,
        { repo: action.repo, prNumber: action.prNumber },
      );
    }

    // Issue #1281: Acquire distributed lock if workerId is configured
    let lockCommentId: number | undefined;
    if (deps.workerId) {
      const lockResult = await doAcquireLock({
        repo: action.repo,
        prNumber: action.prNumber,
        workerId: deps.workerId,
      });

      if (!lockResult.ok || !lockResult.value.acquired) {
        const winnerId = lockResult.ok ? lockResult.value.winnerId : undefined;
        lockedCount++;
        deps.logger.info(
          `PR #${action.prNumber} (${action.branchName}) is locked by another worker${
            winnerId ? ` (${winnerId})` : ""
          } — skipping`,
          { repo: action.repo, prNumber: action.prNumber },
        );
        details.push({
          repo: action.repo,
          prNumber: action.prNumber,
          branchName: action.branchName,
          status: "failed",
          message: `Skipped: branch locked by another worker${
            winnerId ? ` (${winnerId})` : ""
          }`,
        });
        continue;
      }

      lockCommentId = lockResult.value.lockCommentId;
    }

    // Issue #386: freshness re-check at the point of action, as Issue #352
    // taught the claim path to do. The scan read this PR as behind up to a
    // minute ago; if it has merged since, the push would be refused by the
    // lease and reported as a failure it never was. Checked before the clone
    // so a finished PR costs no repository setup either.
    const preState = await resolvePrLiveState(deps, action);
    if (isFinishedPrState(preState)) {
      mergedCount++;
      const verb = preState === "MERGED" ? "merged" : "closed";
      deps.logger.info(
        `PR #${action.prNumber} (${action.branchName}) ${verb} between the ` +
          `scan and the push — nothing to do (Issue #386)`,
        { repo: action.repo, prNumber: action.prNumber },
      );
      details.push({
        repo: action.repo,
        prNumber: action.prNumber,
        branchName: action.branchName,
        status: "merged",
        message: `PR ${verb} before the branch update ran — no update needed`,
      });
      if (lockCommentId !== undefined) {
        await doReleaseLock({
          repo: action.repo,
          prNumber: action.prNumber,
          lockCommentId,
        });
      }
      continue;
    }

    // Set up the repository
    const setupResult = await deps.setupRepo(action.repo, deps.workDir);
    if (!setupResult.ok) {
      // Issue #394: a setup that lost a race with another lane — a held git
      // lock, a worktree that could not be positioned — says nothing about
      // the PR. Named as contention and retried, never counted as a failure.
      const setupContention = classifyCloneContention(setupResult.error);
      if (setupContention) {
        contendedCount++;
        deps.logger.info(
          `PR #${action.prNumber} (${action.branchName}) branch update ` +
            `deferred — ${describeCloneContention(setupContention)}`,
          { repo: action.repo, prNumber: action.prNumber },
        );
        details.push({
          repo: action.repo,
          prNumber: action.prNumber,
          branchName: action.branchName,
          status: "contended",
          message: describeCloneContention(setupContention),
        });
        if (lockCommentId !== undefined) {
          await doReleaseLock({
            repo: action.repo,
            prNumber: action.prNumber,
            lockCommentId,
          });
        }
        continue;
      }
      failedCount++;
      // Issue #231: name the PR and the reason — the summary line only
      // carried the count, so a PR failing every pass was invisible.
      deps.logger.warn(
        `PR #${action.prNumber} (${action.branchName}) branch update failed — repository setup: ${setupResult.error.message}`,
        { repo: action.repo, prNumber: action.prNumber },
      );
      recordFaultEvent(
        "catch_block_warning",
        `pr-branch-update setup failed ${action.repo}#${action.prNumber}: ${setupResult.error.message}`,
      );
      details.push({
        repo: action.repo,
        prNumber: action.prNumber,
        branchName: action.branchName,
        status: "failed",
        message: `Setup failed: ${setupResult.error.message}`,
      });
      // Release lock on failure
      if (lockCommentId !== undefined) {
        await doReleaseLock({
          repo: action.repo,
          prNumber: action.prNumber,
          lockCommentId,
        });
      }
      continue;
    }

    const repoPath = setupResult.value;

    // Get the default branch for cleanup after update
    let defaultBranch: string;
    try {
      defaultBranch = await deps.getDefaultBranch(action.repo);
    } catch {
      defaultBranch = "main"; // allow-hardcoded-branch — fallback after dynamic detection
    }

    // Perform the branch update (fetch, checkout, rebase, push, restore)
    // Issue #1313: Pass the reason so the update function can handle
    // "conflicting" PRs that are not behind (behindBy == 0).
    const updateResult = await deps.performBranchUpdate({
      repoPath,
      branchName: action.branchName,
      baseBranch: action.baseBranch,
      defaultBranch,
      reason: action.reason,
    });

    // Issue #386: the PR can also merge while the update itself is in flight,
    // which is what the observed `(stale info)` rejection was — the lease
    // refusing a push nobody needed any more. Only asked for on failure, so a
    // clean pass costs no extra API call.
    const postState = updateResult.ok
      ? "UNKNOWN"
      : await resolvePrLiveState(deps, action);

    if (updateResult.ok) {
      updatedCount++;
      // Issue #335: one success ends the streak — the next failure starts
      // counting from one, so a transient failure never escalates.
      if (streak) {
        await clearPrBranchUpdateFailure(
          streak.statePath,
          action.repo,
          action.branchName,
          (message: string) => deps.logger.warn(message),
        );
      }
      details.push({
        repo: action.repo,
        prNumber: action.prNumber,
        branchName: action.branchName,
        status: "updated",
        message: updateResult.value,
      });
    } else if (isFinishedPrState(postState)) {
      // Issue #386: nothing failed. The PR finished while the update ran, so
      // the rejection (or the conflict against a base that has since taken
      // this PR's commits) describes work that no longer exists. INFO, and
      // counted apart from failedCount / conflictCount so a genuine push
      // failure is still the only thing that shows up as one.
      mergedCount++;
      const verb = postState === "MERGED" ? "merged" : "closed";
      deps.logger.info(
        `PR #${action.prNumber} (${action.branchName}) ${verb} while its ` +
          `branch update was in flight — nothing to do (Issue #386)`,
        { repo: action.repo, prNumber: action.prNumber },
      );
      details.push({
        repo: action.repo,
        prNumber: action.prNumber,
        branchName: action.branchName,
        status: "merged",
        message: `PR ${verb} mid-update — no-op; git reported: ` +
          updateResult.error.message,
      });
    } else if (
      !isPrBranchConflictError(updateResult.error) &&
      classifyCloneContention(updateResult.error) !== null
    ) {
      // Issue #394: another lane on this host moved the clone under the
      // operation — a branch it holds checked out, a git lock, unpushed
      // commits origin has never seen. `pathspec … did not match any file(s)
      // known to git` reads as "your branch is gone" and sends an operator to
      // GitHub to look for a branch that is sitting right there, so the line
      // says what actually happened. Nothing about the PR failed: it is left
      // exactly as it is, counted apart from `failedCount`, kept out of the
      // failure streak, and retried next cycle.
      const contention = classifyCloneContention(updateResult.error)!;
      contendedCount++;
      const explanation = describeCloneContention(contention);
      deps.logger.info(
        `PR #${action.prNumber} (${action.branchName}) branch update against ` +
          `${action.baseBranch} deferred — ${explanation}`,
        { repo: action.repo, prNumber: action.prNumber },
      );
      details.push({
        repo: action.repo,
        prNumber: action.prNumber,
        branchName: action.branchName,
        status: "contended",
        message: explanation,
      });
    } else if (isPrBranchConflictError(updateResult.error)) {
      // Issue #4373: the PR's changes collide with the base and the worker
      // will not pick a side. Distinct status and a loud line — this PR
      // needs a real merge, and it stays exactly as its author left it
      // until then.
      //
      // Issue #84: the hand-off now has a receiver — the Priority 1.61
      // conflict-resolution pass, which labels the PR `merge-conflict` and
      // merges the base in for real. The warning fires once per PR rather
      // than on every pass, because the label is the visible queue.
      conflictCount++;
      if (shouldWarnPrConflictOnce(action.repo, action.prNumber)) {
        deps.logger.warn(
          `PR #${action.prNumber} (${action.branchName}) conflicts with ${action.baseBranch} — left untouched, needs a real merge; handed to the merge-conflict pass (Issue #4373, Issue #84)`,
          { repo: action.repo, prNumber: action.prNumber },
        );
      }
      details.push({
        repo: action.repo,
        prNumber: action.prNumber,
        branchName: action.branchName,
        status: "conflict",
        message: updateResult.error.message,
      });
    } else {
      failedCount++;
      // Issue #231: see above — every failure names its PR and cause.
      deps.logger.warn(
        `PR #${action.prNumber} (${action.branchName}) branch update against ${action.baseBranch} failed: ${updateResult.error.message}`,
        { repo: action.repo, prNumber: action.prNumber },
      );
      recordFaultEvent(
        "catch_block_warning",
        `pr-branch-update failed ${action.repo}#${action.prNumber}: ${updateResult.error.message}`,
      );
      // Issue #335: count this branch's consecutive failing cycles, and at the
      // threshold file one issue naming the PR, the count and the git error.
      if (streak) {
        const decision = await recordPrBranchUpdateFailure({
          statePath: streak.statePath,
          cycleId: streak.cycleId,
          threshold: streak.threshold,
          ghFn: streak.ghFn,
          report: {
            repo: action.repo,
            prNumber: action.prNumber,
            branch: action.branchName,
            baseBranch: action.baseBranch,
            error: updateResult.error.message,
          },
          log: (message: string) => deps.logger.warn(message),
        });
        if (decision.action === "filed") {
          deps.logger.warn(
            `PR #${action.prNumber} (${action.branchName}) branch update has ` +
              `failed on ${decision.count} consecutive cycles — escalated as ` +
              `#${decision.issueNumber}; the branch is now skipped until it ` +
              `updates cleanly (Issue #335)`,
            { repo: action.repo, prNumber: action.prNumber },
          );
        }
      }
      details.push({
        repo: action.repo,
        prNumber: action.prNumber,
        branchName: action.branchName,
        status: "failed",
        message: updateResult.error.message,
      });
    }

    // Release lock after update (success or failure)
    if (lockCommentId !== undefined) {
      await doReleaseLock({
        repo: action.repo,
        prNumber: action.prNumber,
        lockCommentId,
      });
    }
  }

  deps.logger.info("PR branch update execution complete", {
    updatedCount,
    failedCount,
    conflictCount,
    lockedCount,
    suppressedCount,
    mergedCount,
    contendedCount,
  });

  return {
    ok: true,
    value: {
      updatedCount,
      failedCount,
      conflictCount,
      lockedCount,
      suppressedCount,
      mergedCount,
      contendedCount,
      details,
    },
  };
}
