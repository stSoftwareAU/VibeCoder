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
import type { Logger, Result } from "../types.ts";
import type { BranchUpdateLockResult } from "./pr_branch_lock.ts";
import {
  acquireBranchUpdateLock,
  releaseBranchUpdateLock,
} from "./pr_branch_lock.ts";
import { WORKER_PR_MARKER_PREFIX } from "./pr_body.ts";

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
  /** Whether the update succeeded or failed. */
  status: "updated" | "failed" | "conflict";
  /** Human-readable description of the outcome. */
  message: string;
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
  /** Number of PRs skipped because another worker holds the lock (Issue #1281). */
  lockedCount: number;
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
        } catch {
          failedCount++;
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
 * Execute PR branch updates for the given actions.
 *
 * For each action: set up the repo, perform the branch update (fetch,
 * checkout, rebase, force-push), and restore the default branch.
 *
 * Issue #1281: When workerId is provided, acquires a distributed lock
 * before each update and releases it afterwards. PRs that are locked
 * by another worker are skipped.
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
  const details: PrBranchUpdateDetail[] = [];

  const doAcquireLock = deps.acquireLock ?? acquireBranchUpdateLock;
  const doReleaseLock = deps.releaseLock ?? releaseBranchUpdateLock;

  for (const action of actions) {
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

    // Set up the repository
    const setupResult = await deps.setupRepo(action.repo, deps.workDir);
    if (!setupResult.ok) {
      failedCount++;
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

    if (updateResult.ok) {
      updatedCount++;
      details.push({
        repo: action.repo,
        prNumber: action.prNumber,
        branchName: action.branchName,
        status: "updated",
        message: updateResult.value,
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
  });

  return {
    ok: true,
    value: { updatedCount, failedCount, conflictCount, lockedCount, details },
  };
}
