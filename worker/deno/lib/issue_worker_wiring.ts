/**
 * Dependency injection and module wiring for the issue worker.
 *
 * Provides a `WorkerDeps` interface that aggregates all dependencies the
 * issue worker needs, a `createDefaultDeps()` factory for production wiring,
 * and a `createMockDeps()` helper for test mocking.
 *
 * Issue #962: Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger, Result, WorkerConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Imports — real implementations wired by createDefaultDeps()
// ---------------------------------------------------------------------------

// GitHub operations
import { createGitHubClient, runGhCommand } from "./github.ts";
import { safeGhCommand } from "./gh_wrapper.ts";
import { ensureLabelExists } from "./label_operations.ts";
import { handleIssueFailure } from "./label_failure.ts";
import { checkGhAuth } from "./gh_auth.ts";

// Git operations
import {
  createBranchName,
  createFeatureBranchFromBase,
  ensureMilestoneBranchExists,
  reconcileHeadToBranch,
  resumeFeatureBranchFromRemote,
} from "./git_branch.ts";
import {
  countCommitsAhead,
  listRemoteIssueBranches,
  orderBranchesByRecency,
} from "./git_issue_branches.ts";
import {
  commitAndPushPending,
  ensureDefaultBranchCurrent,
  pushUnpushedCommits,
  recoverExistingPr,
} from "./git_push.ts";
import { resolveRebaseConflicts } from "./git_conflict_resolution.ts";
import { recoverGitState } from "./git_state_recovery.ts";
import { syncFeatureBranchWithDefault } from "./git_pull.ts";
import { recoverFromPushRejection } from "./git_push_recovery.ts";
import { validateRepoState } from "./git_repo_validation.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";
import { setupRepo as setupRepoCommand } from "../commands/git_operations.ts";
import { repairSharedObjectStore } from "./object_store_repair.ts";
import { ensureRepoClone } from "./ensure_repo_clone.ts";
import { ensureLaneWorktree } from "./lane_worktree.ts";
import { runGitCommand } from "./git_timeout.ts";
import { restoreSession } from "./session_manager.ts";
import { branchHeadChanged, captureBranchHead } from "./branch_head_tracker.ts";

// Issue operations
import {
  findIssuesByLabel,
  findOldestIssue,
  findPlanningIssuesWithFallback,
} from "./issue_finder.ts";
import { fetchIssueData } from "./issue_data.ts";
import { IssueCache } from "./issue_cache.ts";
import { checkClaimChurn, claimIssue } from "./claim_issue.ts";
import {
  type FilterableIssue,
  filterAndSort,
  filterByAllowedAuthors,
} from "./issue_filter.ts";
import { selectHighestPriority } from "./issue_priority.ts";
import { fetchAllIssues, getBlockingPRForIssue } from "./issue_query.ts";
import { checkParentBlocked } from "./issue_dependencies.ts";

// PR operations
import {
  AutoMergeResult,
  enableAutoMerge,
  finalisePr,
} from "./pr_auto_merge.ts";
import { handlePrCommentFailure, markCommentProcessed } from "./pr_comments.ts";
import { validatePrEvidence } from "./pr_evidence.ts";
import { retargetPrToMilestone } from "./pr_retarget.ts";
import { ensurePrReferencesIssue } from "./pr_body.ts";
import {
  closeDuplicatePrs,
  findExistingPrForBranch,
  findExistingPrForIssue,
  linkPrToIssue,
  updatePrLabels,
} from "./pr_issue_linking.ts";
import { checkCiStatus, directMergePr } from "./direct_merge.ts";

// Claude operations
import { checkClaudeHealth, runClaudeWithRetry } from "./claude_runner.ts";
import { buildClaudeModelArgs } from "./claude_executor.ts";
import { isClaudeAuthError } from "./claude_auth.ts";
import { activeAgentProvider } from "./agent_provider.ts";
import {
  isHealthCacheValid,
  recordHealthCheckSuccess,
} from "./health_check_cache.ts";

// Config operations
import { loadConfig, validateConfig } from "./config.ts";
import { isRepoAllowed, validateConfigFull } from "./config_validator.ts";
import { buildDefaultWorkerConfig } from "./config_defaults.ts";

// Security
import {
  detectBotAccounts,
  detectSuspiciousPatterns,
  isAuthorisedCommenter,
  validateIssueInput,
} from "./security.ts";

// Failure tracking
import {
  resetFailures,
  shouldExitOnFailures,
  trackFailure,
} from "./failure_tracker.ts";
import {
  isIssueInCooldown as cooldownIsIssueInCooldown,
  recordIssueCooldown,
} from "./cooldown_state.ts";
import { getSleepInterval, recordZeroProgress } from "./circuit_breaker.ts";
import {
  isRepoDeprioritised,
  recordRepoFailure,
} from "./repo_failure_tracker.ts";
import { detectFailureCategory } from "./failure_diagnosis.ts";

// Crash handling
import { cleanupInProgressIssue } from "./crash_cleanup.ts";
import { sendCrashNotification } from "./crash_notification.ts";
import {
  clearHeartbeat,
  detectAndRecoverStuckIssues,
  recordHeartbeat,
  recordMilestone,
} from "./stuck_issue_detector.ts";

// Infrastructure
import { createLogger } from "./logger.ts";
import { atomicWrite, safeReadFile } from "./file_utils.ts";
import { safeMktemp } from "./temp_utils.ts";
import { checkAndCleanupDiskSpace } from "./disk_space.ts";
import { checkAndRotateLog } from "./log_rotation.ts";
import { buildIssuePrompt } from "./prompt_builder.ts";
import { loadPrompt } from "./prompt_manager.ts";
import { shuffleArray } from "./array_utils.ts";
import { evaluateRunGuard } from "./run_entrypoint.ts";

// Quality
import { runQualityGate } from "./quality_gate.ts";
import { formatSummary } from "./quality_helpers.ts";
import { collectDiffableGateFindings } from "./baseline_gate.ts";
import { fileBaselineCarryoverTracker } from "./baseline_carryover_tracker.ts";
import {
  readBaselineQualityCache,
  writeBaselineQualityCache,
} from "./baseline_quality_cache.ts";

// ---------------------------------------------------------------------------
// Sub-interface definitions
// ---------------------------------------------------------------------------

/** GitHub operations — gh CLI, API client, labels, auth. */
export interface GitHubDeps {
  createClient: (logger: Logger) => GitHubClient;
  safeGhCommand: typeof safeGhCommand;
  runGhCommand: (args: string[]) => Promise<string>;
  ensureLabelExists: typeof ensureLabelExists;
  handleIssueFailure: typeof handleIssueFailure;
  checkGhAuth: typeof checkGhAuth;
}

/** Git operations — branching, push, conflict resolution, state recovery. */
export interface GitDeps {
  /**
   * Provide the working tree for a run.
   *
   * With `laneId` (Issue #923) the lane gets its own git worktree off the
   * shared clone, so two slots working the same repository never share
   * `HEAD`, the index or the checkout. Without it, the shared clone —
   * unchanged, and still what the CLI single-issue path uses.
   */
  setupRepo: (
    repo: string,
    workDir: string,
    laneId?: string,
  ) => Promise<Result<string>>;
  /**
   * Re-clone a repository whose shared object store is corrupt (Issue
   * #1093). The lane worktrees share one object store, so a damaged object
   * is a repository-wide fault the worker repairs rather than fails on.
   */
  repairObjectStore: typeof repairSharedObjectStore;
  createBranchName: typeof createBranchName;
  createFeatureBranchFromBase: typeof createFeatureBranchFromBase;
  resumeFeatureBranchFromRemote: typeof resumeFeatureBranchFromRemote;
  /** Find an issue's pushed branches by number rather than title (#220). */
  listRemoteIssueBranches: typeof listRemoteIssueBranches;
  orderBranchesByRecency: typeof orderBranchesByRecency;
  countCommitsAhead: typeof countCommitsAhead;
  reconcileHeadToBranch: typeof reconcileHeadToBranch;
  pushUnpushedCommits: typeof pushUnpushedCommits;
  commitAndPushPending: typeof commitAndPushPending;
  ensureDefaultBranchCurrent: typeof ensureDefaultBranchCurrent;
  getRepoDefaultBranch: typeof getRepoDefaultBranch;
  resolveRebaseConflicts: typeof resolveRebaseConflicts;
  recoverGitState: typeof recoverGitState;
  runGitCommand: typeof runGitCommand;
  syncFeatureBranchWithDefault: typeof syncFeatureBranchWithDefault;
  recoverFromPushRejection: typeof recoverFromPushRejection;
  validateRepoState: typeof validateRepoState;
  ensureMilestoneBranchExists: typeof ensureMilestoneBranchExists;
  captureBranchHead: typeof captureBranchHead;
  branchHeadChanged: typeof branchHeadChanged;
}

/** Issue operations — finder, data, cache, claim, filter, priority. */
export interface IssueDeps {
  findOldestIssue: typeof findOldestIssue;
  findIssuesByLabel: typeof findIssuesByLabel;
  findPlanningIssuesWithFallback: typeof findPlanningIssuesWithFallback;
  fetchIssueData: typeof fetchIssueData;
  createIssueCache: (cacheDir?: string, ttlSeconds?: number) => IssueCache;
  claimIssue: typeof claimIssue;
  checkClaimChurn: typeof checkClaimChurn;
  filterAndSort: typeof filterAndSort;
  filterByAllowedAuthors: typeof filterByAllowedAuthors;
  selectHighestPriority: typeof selectHighestPriority;
  fetchAllIssues: typeof fetchAllIssues;
  getBlockingPRForIssue: typeof getBlockingPRForIssue;
  checkParentBlocked: typeof checkParentBlocked;
  isIssueInCooldown: typeof cooldownIsIssueInCooldown;
}

/** PR operations — creation, auto-merge, comments, CI, retarget. */
export interface PrDeps {
  enableAutoMerge: typeof enableAutoMerge;
  finalisePr: typeof finalisePr;
  markCommentProcessed: typeof markCommentProcessed;
  handlePrCommentFailure: typeof handlePrCommentFailure;
  validatePrEvidence: typeof validatePrEvidence;
  retargetPrToMilestone: typeof retargetPrToMilestone;
  ensurePrReferencesIssue: typeof ensurePrReferencesIssue;
  linkPrToIssue: typeof linkPrToIssue;
  findExistingPrForIssue: typeof findExistingPrForIssue;
  findExistingPrForBranch: typeof findExistingPrForBranch;
  closeDuplicatePrs: typeof closeDuplicatePrs;
  recoverExistingPr: typeof recoverExistingPr;
  updatePrLabels: typeof updatePrLabels;
  checkCiStatus: typeof checkCiStatus;
  directMergePr: typeof directMergePr;
}

/** Claude operations — runner, executor, auth, health. */
export interface ClaudeDeps {
  runClaudeWithRetry: typeof runClaudeWithRetry;
  runHealthCheck: typeof checkClaudeHealth;
  isClaudeAuthError: typeof isClaudeAuthError;
  buildClaudeModelArgs: typeof buildClaudeModelArgs;
  isHealthCacheValid: typeof isHealthCacheValid;
  recordHealthCheckSuccess: typeof recordHealthCheckSuccess;
}

/** Config operations — loading, validation, defaults. */
export interface ConfigDeps {
  loadConfig: typeof loadConfig;
  validateConfig: typeof validateConfig;
  validateConfigFull: typeof validateConfigFull;
  buildDefaultWorkerConfig: (
    overrides?: Record<string, unknown>,
  ) => WorkerConfig;
  isRepoAllowed: (repos: string[], repo: string) => boolean;
}

/** Security — authorisation checks, pattern detection. */
export interface SecurityDeps {
  validateIssueInput: typeof validateIssueInput;
  detectSuspiciousPatterns: typeof detectSuspiciousPatterns;
  isAuthorisedCommenter: typeof isAuthorisedCommenter;
  detectBotAccounts: typeof detectBotAccounts;
}

/** Failure tracking — failures, cooldowns, circuit breaker, repo failures. */
export interface FailureTrackingDeps {
  trackFailure: typeof trackFailure;
  shouldExitOnFailures: typeof shouldExitOnFailures;
  resetFailures: typeof resetFailures;
  recordIssueCooldown: typeof recordIssueCooldown;
  isIssueInCooldown: typeof cooldownIsIssueInCooldown;
  recordZeroProgress: typeof recordZeroProgress;
  getSleepInterval: typeof getSleepInterval;
  recordRepoFailure: typeof recordRepoFailure;
  isRepoDeprioritised: typeof isRepoDeprioritised;
  detectFailureCategory: typeof detectFailureCategory;
}

/** Crash handling — cleanup, notifications, stuck issue detection. */
export interface CrashHandlingDeps {
  cleanupInProgressIssue: typeof cleanupInProgressIssue;
  sendCrashNotification: typeof sendCrashNotification;
  detectAndRecoverStuckIssues: typeof detectAndRecoverStuckIssues;
  recordHeartbeat: typeof recordHeartbeat;
  clearHeartbeat: typeof clearHeartbeat;
  /**
   * Append a milestone to the heartbeat progress log (Issue #3753).
   *
   * Processors call this to make what they are doing visible inside the
   * single heartbeat comment; it never posts a new comment and never fails
   * the work it describes.
   */
  recordMilestone: typeof recordMilestone;
}

/** Infrastructure — file I/O, temp files, disk, logs, prompts, misc. */
export interface InfrastructureDeps {
  atomicWrite: typeof atomicWrite;
  safeReadFile: typeof safeReadFile;
  safeMktemp: typeof safeMktemp;
  checkAndCleanupDiskSpace: typeof checkAndCleanupDiskSpace;
  checkAndRotateLog: typeof checkAndRotateLog;
  buildPrompt: typeof buildIssuePrompt;
  loadPrompt: typeof loadPrompt;
  shuffleArray: typeof shuffleArray;
  evaluateRunGuard: typeof evaluateRunGuard;
}

/** Quality — quality gate, helpers. */
export interface QualityDeps {
  runQualityGate: typeof runQualityGate;
  formatSummary: typeof formatSummary;
  /** Collect check-agnostic diffable findings for the baseline-aware gate (Issue #2604). */
  collectDiffableGateFindings: typeof collectDiffableGateFindings;
  /**
   * File a deduplicated `needs-human` tracker for pre-existing carryover
   * findings on a bypassed PR (Issue #2605).
   */
  fileBaselineCarryoverTracker: typeof fileBaselineCarryoverTracker;
  /**
   * Reuse a baseline gate outcome recorded for a byte-identical checkout
   * (Issue #4283) instead of re-running the whole suite.
   */
  readBaselineQualityCache: typeof readBaselineQualityCache;
  /** Record a baseline gate outcome for reuse (Issue #4283). */
  writeBaselineQualityCache: typeof writeBaselineQualityCache;
}

// ---------------------------------------------------------------------------
// WorkerDeps — top-level aggregation
// ---------------------------------------------------------------------------

/** Aggregated dependencies for the issue worker. */
export interface WorkerDeps {
  logger: Logger;
  config: ConfigDeps;
  github: GitHubDeps;
  git: GitDeps;
  issues: IssueDeps;
  pr: PrDeps;
  claude: ClaudeDeps;
  security: SecurityDeps;
  failureTracking: FailureTrackingDeps;
  crashHandling: CrashHandlingDeps;
  infrastructure: InfrastructureDeps;
  quality: QualityDeps;
}

async function setupRepoFn(
  repo: string,
  workDir: string,
  laneId?: string,
): Promise<Result<string>> {
  // Issue #923: a lane works in its own worktree, never in the shared
  // `${WORK_DIR}/<repo>` clone. `setupRepo` opens with `reset --hard` +
  // `clean -fd`, so two slots pointed at one clone would each throw away
  // the other's work; that is why slots were excluded from a repository a
  // sibling held, and why only one slot could ever serve a backlog
  // concentrated in one repository. `ensureRepoClone` clones only when the
  // clone is genuinely missing, and the worktree gives the lane its own
  // HEAD, index and checkout off the same object store — no second copy of
  // history, which matters because the work volume only ever grows.
  if (laneId !== undefined) {
    const clone = await ensureRepoClone(repo, workDir);
    if (!clone.ok) {
      return {
        ok: false,
        error: new Error(
          clone.message ?? `Could not clone ${repo} into ${workDir}`,
        ),
      };
    }
    const worktree = await ensureLaneWorktree({
      workDir,
      repo,
      laneId,
      repoPath: clone.repoPath,
    });
    if (!worktree.ok) return worktree;

    // Parity with `setupRepo`, which every run relied on to start clean.
    // A lane's worktree is created once and reused across cycles, so
    // without this a run inherits whatever the previous one left behind.
    // `checkout <default>` is deliberately NOT part of that parity: the
    // shared clone has the default branch checked out, git refuses to
    // check the same branch out twice, and the feature branch is created
    // from `origin/<base>` regardless.
    await runGitCommand(["reset", "--hard", "HEAD"], { cwd: worktree.value });
    await runGitCommand(["clean", "-fd"], { cwd: worktree.value });
    await restoreSession(worktree.value, workDir, repo);
    return worktree;
  }
  const result = await setupRepoCommand(repo, workDir);
  if (!result.success) {
    return { ok: false, error: new Error(result.message) };
  }
  return { ok: true, value: result.message };
}

// ---------------------------------------------------------------------------
// createDefaultDeps — production wiring
// ---------------------------------------------------------------------------

/**
 * Create a WorkerDeps wired with all real implementations.
 *
 * Replaces the implicit wiring that currently happens via shell `source`
 * statements and `deno_run_command` calls.
 */
export function createDefaultDeps(
  options: { logger?: Logger } = {},
): WorkerDeps {
  // The caller's logger when given (Issue #4320): run_core builds a
  // file-backed logger for worker.log, and every phase of workOnIssue —
  // baseline, context budget, the agent-progress lines, phase heartbeats,
  // WIP checkpoints — must reach that same file. The stderr-only default
  // is for callers with no file sink (CLI commands, tests).
  const logger = options.logger ?? createLogger({
    debug: Deno.env.get("DEBUG") === "true",
  });

  return {
    logger,

    config: {
      loadConfig,
      validateConfig,
      validateConfigFull,
      buildDefaultWorkerConfig: buildDefaultWorkerConfig as (
        overrides?: Record<string, unknown>,
      ) => WorkerConfig,
      isRepoAllowed,
    },

    github: {
      createClient: createGitHubClient,
      safeGhCommand,
      runGhCommand,
      ensureLabelExists,
      handleIssueFailure,
      checkGhAuth,
    },

    git: {
      setupRepo: setupRepoFn,
      repairObjectStore: repairSharedObjectStore,
      createBranchName,
      createFeatureBranchFromBase,
      resumeFeatureBranchFromRemote,
      listRemoteIssueBranches,
      orderBranchesByRecency,
      countCommitsAhead,
      reconcileHeadToBranch,
      pushUnpushedCommits,
      commitAndPushPending,
      ensureDefaultBranchCurrent,
      getRepoDefaultBranch,
      resolveRebaseConflicts,
      recoverGitState,
      runGitCommand,
      syncFeatureBranchWithDefault,
      recoverFromPushRejection,
      validateRepoState,
      ensureMilestoneBranchExists,
      captureBranchHead,
      branchHeadChanged,
    },

    issues: {
      findOldestIssue,
      findIssuesByLabel,
      findPlanningIssuesWithFallback,
      fetchIssueData,
      createIssueCache: (cacheDir?: string, ttlSeconds?: number) =>
        new IssueCache(cacheDir, ttlSeconds),
      claimIssue,
      checkClaimChurn,
      filterAndSort,
      filterByAllowedAuthors,
      selectHighestPriority,
      fetchAllIssues,
      getBlockingPRForIssue,
      checkParentBlocked,
      isIssueInCooldown: cooldownIsIssueInCooldown,
    },

    pr: {
      enableAutoMerge,
      finalisePr,
      markCommentProcessed,
      handlePrCommentFailure,
      validatePrEvidence,
      retargetPrToMilestone,
      ensurePrReferencesIssue,
      linkPrToIssue,
      findExistingPrForIssue,
      findExistingPrForBranch,
      closeDuplicatePrs,
      recoverExistingPr,
      updatePrLabels,
      checkCiStatus,
      directMergePr,
    },

    claude: {
      runClaudeWithRetry,
      runHealthCheck: checkClaudeHealth,
      // Provider-auth classification goes through the seam (Issue #4067),
      // so a different provider classifies its own auth failures.
      isClaudeAuthError: (output: string) =>
        activeAgentProvider().isAuthError(output),
      buildClaudeModelArgs,
      isHealthCacheValid,
      recordHealthCheckSuccess,
    },

    security: {
      validateIssueInput,
      detectSuspiciousPatterns,
      isAuthorisedCommenter,
      detectBotAccounts,
    },

    failureTracking: {
      trackFailure,
      shouldExitOnFailures,
      resetFailures,
      recordIssueCooldown,
      isIssueInCooldown: cooldownIsIssueInCooldown,
      recordZeroProgress,
      getSleepInterval,
      recordRepoFailure,
      isRepoDeprioritised,
      detectFailureCategory,
    },

    crashHandling: {
      cleanupInProgressIssue,
      sendCrashNotification,
      detectAndRecoverStuckIssues,
      recordHeartbeat,
      clearHeartbeat,
      recordMilestone,
    },

    infrastructure: {
      atomicWrite,
      safeReadFile,
      safeMktemp,
      checkAndCleanupDiskSpace,
      checkAndRotateLog,
      buildPrompt: buildIssuePrompt,
      loadPrompt,
      shuffleArray,
      evaluateRunGuard,
    },

    quality: {
      runQualityGate,
      formatSummary,
      collectDiffableGateFindings,
      fileBaselineCarryoverTracker,
      readBaselineQualityCache,
      writeBaselineQualityCache,
    },
  };
}

// ---------------------------------------------------------------------------
// createMockDeps — test-friendly stubs
// ---------------------------------------------------------------------------

/** Options for partially overriding mock dependencies. */
export interface MockDepsOverrides {
  logger?: Partial<Logger>;
  config?: Partial<ConfigDeps>;
  github?: Partial<GitHubDeps>;
  git?: Partial<GitDeps>;
  issues?: Partial<IssueDeps>;
  pr?: Partial<PrDeps>;
  claude?: Partial<ClaudeDeps>;
  security?: Partial<SecurityDeps>;
  failureTracking?: Partial<FailureTrackingDeps>;
  crashHandling?: Partial<CrashHandlingDeps>;
  infrastructure?: Partial<InfrastructureDeps>;
  quality?: Partial<QualityDeps>;
}

/** No-op function for mock stubs. */
const noop = () => {};

/**
 * Constrain a mock implementation to the real dependency signature (Issue
 * #2167).
 *
 * Replaces the previous `as unknown as T` double-cast pattern. The generic
 * parameter is the target dep slot (e.g. `ConfigDeps["loadConfig"]`); the
 * passed `impl` must be assignable to that type, so any drift between the
 * production signature (carried in via `typeof`) and the mock body shows up
 * as a compile error here — restoring the type signal the deps interface
 * was designed to provide.
 *
 * The `(...args: never[]) => unknown` bound is the function-bottom type:
 * every function type extends it, so the helper accepts any dep slot
 * without erasing structure on the way through.
 */
function mockFn<T extends (...args: never[]) => unknown>(impl: T): T {
  return impl;
}

/** Create a silent no-op logger for testing. */
function createMockLogger(overrides?: Partial<Logger>): Logger {
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
    ...overrides,
  };
}

/**
 * Create a WorkerDeps with all dependencies stubbed for testing.
 *
 * Mock functions return safe defaults (empty results, no-ops, etc.).
 * Pass `overrides` to replace specific dependencies while keeping the
 * rest as stubs.
 */
/**
 * A GitHubClient that performs no network I/O (Issue #4347): reads answer
 * empty, writes succeed silently. `getIssue` rejects, because a test that
 * needs issue data must say what it is.
 */
export function mockGitHubClient(): GitHubClient {
  return {
    getIssue: () =>
      Promise.reject(
        new Error(
          "createMockDeps: getIssue is not stubbed — override github.createClient",
        ),
      ),
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

export function createMockDeps(overrides?: MockDepsOverrides): WorkerDeps {
  const defaultConfig = buildDefaultWorkerConfig();

  const mockLogger = createMockLogger(overrides?.logger);

  const mockConfig: ConfigDeps = {
    loadConfig: mockFn<ConfigDeps["loadConfig"]>(() =>
      Promise.resolve(defaultConfig)
    ),
    validateConfig: mockFn<ConfigDeps["validateConfig"]>(noop),
    validateConfigFull: mockFn<ConfigDeps["validateConfigFull"]>(() => ({
      valid: true,
      errors: [],
      warnings: [],
    })),
    buildDefaultWorkerConfig: () => defaultConfig,
    isRepoAllowed: () => true,
    ...overrides?.config,
  };

  const mockGithub: GitHubDeps = {
    // A no-op recording client, NOT the production one (Issue #4347). The
    // mock used to hand back createGitHubClient(): 65 test files use
    // createMockDeps and 52 never override createClient, so any path that
    // touched it spawned a real `gh` against github.com, 404'd, and was
    // retried with 2 s + 4 s + 8 s back-off — ~50 % of the whole quality
    // gate on an authenticated worker VM (issue_worker_test 44 s → 0.2 s
    // with gh denied, identical pass counts). A test that wants the real
    // client opts in through overrides.github.createClient.
    createClient: mockFn<GitHubDeps["createClient"]>(() => mockGitHubClient()),
    safeGhCommand: mockFn<GitHubDeps["safeGhCommand"]>(() =>
      Promise.resolve({
        ok: true,
        value: {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          rateLimited: false,
          circuitBroken: false,
        },
      })
    ),
    runGhCommand: () => Promise.resolve(""),
    ensureLabelExists: mockFn<GitHubDeps["ensureLabelExists"]>(() =>
      Promise.resolve({ ok: true, value: undefined })
    ),
    handleIssueFailure: mockFn<GitHubDeps["handleIssueFailure"]>(() =>
      Promise.resolve({
        ok: true,
        value: {
          markedAsFailed: false,
          markedAsFailedOnce: true,
          failureCategory: "unknown",
          isInfrastructure: false,
        },
      })
    ),
    checkGhAuth: mockFn<GitHubDeps["checkGhAuth"]>(() =>
      Promise.resolve({
        ok: true,
        value: { valid: true, message: "Mock auth OK" },
      })
    ),
    ...overrides?.github,
  };

  const mockGit: GitDeps = {
    setupRepo: mockFn<GitDeps["setupRepo"]>(() =>
      Promise.resolve({ ok: true, value: "/tmp/test-repo" })
    ),
    // Default: no test's clone is corrupt, so the repair is never reached
    // unless a test makes `createFeatureBranchFromBase` say otherwise.
    repairObjectStore: mockFn<GitDeps["repairObjectStore"]>(() =>
      Promise.resolve({
        ok: true,
        value: { fsck: "", removed: [], repoPath: "/tmp/test-repo" },
      })
    ),
    createBranchName: mockFn<GitDeps["createBranchName"]>((
      issueNumber: number,
      title: string,
    ) =>
      `issue-${issueNumber}-${
        title.slice(0, 20).toLowerCase().replace(/\s+/g, "-")
      }`
    ),
    createFeatureBranchFromBase: mockFn<GitDeps["createFeatureBranchFromBase"]>(
      () => Promise.resolve({ ok: true, value: "mock-branch" }),
    ),
    resumeFeatureBranchFromRemote: mockFn<
      GitDeps["resumeFeatureBranchFromRemote"]
    >(() => Promise.resolve({ ok: true, value: false })),
    // Default: the remote carries no branch for the issue, so a mocked run
    // starts clean unless the test says otherwise (#220).
    listRemoteIssueBranches: mockFn<GitDeps["listRemoteIssueBranches"]>(() =>
      Promise.resolve({ ok: true, value: [] })
    ),
    orderBranchesByRecency: mockFn<GitDeps["orderBranchesByRecency"]>((
      branches: readonly string[],
    ) => Promise.resolve([...branches])),
    countCommitsAhead: mockFn<GitDeps["countCommitsAhead"]>(() =>
      Promise.resolve({ ok: true, value: 1 })
    ),
    reconcileHeadToBranch: mockFn<GitDeps["reconcileHeadToBranch"]>(() =>
      Promise.resolve({
        ok: true,
        value: { action: "already-on-branch", fromRef: "mock-branch" },
      })
    ),
    pushUnpushedCommits: mockFn<GitDeps["pushUnpushedCommits"]>(() =>
      Promise.resolve({ ok: true, value: 0 })
    ),
    commitAndPushPending: mockFn<GitDeps["commitAndPushPending"]>(() =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 0,
          finalUnpushedCount: 0,
          finalUnpushedSource: "remote-head" as const,
        },
      })
    ),
    ensureDefaultBranchCurrent: mockFn<GitDeps["ensureDefaultBranchCurrent"]>(
      () => Promise.resolve({ ok: true, value: "main" }),
    ),
    getRepoDefaultBranch: mockFn<GitDeps["getRepoDefaultBranch"]>(() =>
      Promise.resolve({ ok: true, value: "main" })
    ),
    resolveRebaseConflicts: mockFn<GitDeps["resolveRebaseConflicts"]>(() =>
      Promise.resolve({ ok: true, value: { filesResolved: 0, rounds: 0 } })
    ),
    recoverGitState: mockFn<GitDeps["recoverGitState"]>(() =>
      Promise.resolve({ ok: true, value: { actions: [], recovered: true } })
    ),
    runGitCommand: mockFn<GitDeps["runGitCommand"]>(() =>
      Promise.resolve({ ok: true, value: { code: 0, stdout: "", stderr: "" } })
    ),
    syncFeatureBranchWithDefault: mockFn<
      GitDeps["syncFeatureBranchWithDefault"]
    >(() => Promise.resolve({ ok: true, value: "synced" })),
    recoverFromPushRejection: mockFn<GitDeps["recoverFromPushRejection"]>(() =>
      Promise.resolve({ ok: true, value: "recovered" })
    ),
    validateRepoState: mockFn<GitDeps["validateRepoState"]>(() =>
      Promise.resolve({
        ok: true,
        value: { valid: true, actions: [], warnings: [] },
      })
    ),
    ensureMilestoneBranchExists: mockFn<GitDeps["ensureMilestoneBranchExists"]>(
      () =>
        Promise.resolve({ ok: true, value: "mock milestone branch ensured" }),
    ),
    captureBranchHead: mockFn<GitDeps["captureBranchHead"]>(() =>
      Promise.resolve({
        ok: true,
        value: "0000000000000000000000000000000000000000",
      })
    ),
    branchHeadChanged: mockFn<GitDeps["branchHeadChanged"]>(() =>
      Promise.resolve({ ok: true, value: false })
    ),
    ...overrides?.git,
  };

  const mockIssues: IssueDeps = {
    findOldestIssue: mockFn<IssueDeps["findOldestIssue"]>(() =>
      Promise.resolve({ found: false, output: "", summary: "mock" })
    ),
    findIssuesByLabel: mockFn<IssueDeps["findIssuesByLabel"]>(() =>
      Promise.resolve({ found: false, output: "", summary: "mock" })
    ),
    findPlanningIssuesWithFallback: mockFn<
      IssueDeps["findPlanningIssuesWithFallback"]
    >(() => Promise.resolve({ found: false, output: "", summary: "mock" })),
    fetchIssueData: mockFn<IssueDeps["fetchIssueData"]>(() =>
      Promise.resolve({
        title: "",
        body: "",
        labels: [],
        comments: [],
        state: "OPEN",
        milestoneTitle: "",
      })
    ),
    createIssueCache: () => new IssueCache(),
    claimIssue: mockFn<IssueDeps["claimIssue"]>(() =>
      Promise.resolve({ ok: true, value: { claimed: true, workerId: "mock" } })
    ),
    checkClaimChurn: mockFn<IssueDeps["checkClaimChurn"]>(() =>
      Promise.resolve({ ok: true, value: { churnCount: 0, escalated: false } })
    ),
    filterAndSort: mockFn<IssueDeps["filterAndSort"]>((
      issues: FilterableIssue[],
    ) => issues),
    filterByAllowedAuthors: mockFn<IssueDeps["filterByAllowedAuthors"]>((
      issues: FilterableIssue[],
    ) => issues),
    selectHighestPriority: mockFn<IssueDeps["selectHighestPriority"]>(() =>
      null
    ),
    fetchAllIssues: mockFn<IssueDeps["fetchAllIssues"]>(() =>
      Promise.resolve([])
    ),
    getBlockingPRForIssue: mockFn<IssueDeps["getBlockingPRForIssue"]>(() =>
      null
    ),
    checkParentBlocked: mockFn<IssueDeps["checkParentBlocked"]>(() =>
      Promise.resolve({
        ok: true,
        value: {
          isBlocked: false,
          openChildren: [],
          closedChildren: [],
          totalChildren: 0,
        },
      })
    ),
    isIssueInCooldown: mockFn<IssueDeps["isIssueInCooldown"]>(() =>
      Promise.resolve(false)
    ),
    ...overrides?.issues,
  };

  const mockPr: PrDeps = {
    enableAutoMerge: mockFn<PrDeps["enableAutoMerge"]>(() =>
      Promise.resolve({
        result: AutoMergeResult.Enabled,
        message: "Mock auto-merge enabled",
      })
    ),
    finalisePr: mockFn<PrDeps["finalisePr"]>(() =>
      Promise.resolve({ ok: true, value: "finalised" })
    ),
    markCommentProcessed: mockFn<PrDeps["markCommentProcessed"]>(() =>
      Promise.resolve({ ok: true, value: undefined })
    ),
    handlePrCommentFailure: mockFn<PrDeps["handlePrCommentFailure"]>(() =>
      Promise.resolve()
    ),
    validatePrEvidence: mockFn<PrDeps["validatePrEvidence"]>(() => ({
      ok: true,
      value: "mock pr summary",
    })),
    retargetPrToMilestone: mockFn<PrDeps["retargetPrToMilestone"]>(() =>
      Promise.resolve({ ok: true, value: "retargeted" })
    ),
    ensurePrReferencesIssue: mockFn<PrDeps["ensurePrReferencesIssue"]>((
      body: string,
    ) => body),
    linkPrToIssue: mockFn<PrDeps["linkPrToIssue"]>(() =>
      Promise.resolve({ ok: true, value: undefined })
    ),
    findExistingPrForIssue: mockFn<PrDeps["findExistingPrForIssue"]>(() =>
      Promise.resolve({ ok: false, error: new Error("No PR found") })
    ),
    findExistingPrForBranch: mockFn<PrDeps["findExistingPrForBranch"]>(() =>
      Promise.resolve({ ok: false, error: new Error("No PR found") })
    ),
    closeDuplicatePrs: mockFn<PrDeps["closeDuplicatePrs"]>(() =>
      Promise.resolve(0)
    ),
    recoverExistingPr: mockFn<PrDeps["recoverExistingPr"]>(() =>
      Promise.resolve({ ok: true, value: "recovered" })
    ),
    updatePrLabels: mockFn<PrDeps["updatePrLabels"]>(() =>
      Promise.resolve({ ok: true, value: undefined })
    ),
    checkCiStatus: mockFn<PrDeps["checkCiStatus"]>(() =>
      Promise.resolve({ ok: true, value: { status: "passed" } })
    ),
    directMergePr: mockFn<PrDeps["directMergePr"]>(() =>
      Promise.resolve({ ok: true, value: { merged: true } })
    ),
    ...overrides?.pr,
  };

  const mockClaude: ClaudeDeps = {
    runClaudeWithRetry: mockFn<ClaudeDeps["runClaudeWithRetry"]>(() =>
      Promise.resolve({
        ok: true,
        value: { exitCode: 0, output: "mock", timedOut: false },
      })
    ),
    runHealthCheck: mockFn<ClaudeDeps["runHealthCheck"]>(() =>
      Promise.resolve({ healthy: true, exitCode: 0, message: "OK" })
    ),
    isClaudeAuthError: () => false,
    buildClaudeModelArgs: () => [],
    isHealthCacheValid: mockFn<ClaudeDeps["isHealthCacheValid"]>(() => ({
      ok: true,
      value: true,
    })),
    recordHealthCheckSuccess: mockFn<ClaudeDeps["recordHealthCheckSuccess"]>(
      () => ({ ok: true, value: undefined }),
    ),
    ...overrides?.claude,
  };

  const mockSecurity: SecurityDeps = {
    validateIssueInput: mockFn<SecurityDeps["validateIssueInput"]>(() => ({
      titleLength: 10,
      bodyLength: 100,
      titleSuspicious: false,
      bodySuspicious: false,
    })),
    detectSuspiciousPatterns: mockFn<SecurityDeps["detectSuspiciousPatterns"]>(
      () => ({
        detected: false,
        context: "mock",
      }),
    ),
    isAuthorisedCommenter: () => true,
    detectBotAccounts: mockFn<SecurityDeps["detectBotAccounts"]>(() => ({
      botCount: 0,
      botNames: [],
    })),
    ...overrides?.security,
  };

  const emptyFailureState = {
    consecutiveFailures: 0,
    lastFailureKey: "",
    lastFailureTimestamp: 0,
  };
  const emptyCircuitState = {
    zeroCycles: 0,
    lastUpdated: 0,
    operationFailures: {},
  };
  const mockFailureTracking: FailureTrackingDeps = {
    trackFailure: mockFn<FailureTrackingDeps["trackFailure"]>(() =>
      Promise.resolve({ ok: true, value: emptyFailureState })
    ),
    shouldExitOnFailures: mockFn<FailureTrackingDeps["shouldExitOnFailures"]>(
      () => Promise.resolve(false),
    ),
    resetFailures: mockFn<FailureTrackingDeps["resetFailures"]>(() =>
      Promise.resolve({ ok: true, value: emptyFailureState })
    ),
    recordIssueCooldown: mockFn<FailureTrackingDeps["recordIssueCooldown"]>(
      () =>
        Promise.resolve({
          ok: true,
          value: { state: { entries: [] }, consecutiveTimeouts: 0 },
        }),
    ),
    isIssueInCooldown: mockFn<FailureTrackingDeps["isIssueInCooldown"]>(() =>
      Promise.resolve(false)
    ),
    recordZeroProgress: mockFn<FailureTrackingDeps["recordZeroProgress"]>(() =>
      Promise.resolve({ ok: true, value: emptyCircuitState })
    ),
    getSleepInterval: mockFn<FailureTrackingDeps["getSleepInterval"]>(() =>
      Promise.resolve(30)
    ),
    recordRepoFailure: mockFn<FailureTrackingDeps["recordRepoFailure"]>(() =>
      Promise.resolve({ ok: true, value: 0 })
    ),
    isRepoDeprioritised: mockFn<FailureTrackingDeps["isRepoDeprioritised"]>(
      () => Promise.resolve(false),
    ),
    detectFailureCategory: mockFn<FailureTrackingDeps["detectFailureCategory"]>(
      () => "unknown",
    ),
    ...overrides?.failureTracking,
  };

  const mockCrashHandling: CrashHandlingDeps = {
    cleanupInProgressIssue: mockFn<CrashHandlingDeps["cleanupInProgressIssue"]>(
      () =>
        Promise.resolve({
          ok: true,
          value: { heartbeatCleared: false, unassigned: false },
        }),
    ),
    sendCrashNotification: mockFn<CrashHandlingDeps["sendCrashNotification"]>(
      () => Promise.resolve({ ok: true, value: { notified: false } }),
    ),
    detectAndRecoverStuckIssues: mockFn<
      CrashHandlingDeps["detectAndRecoverStuckIssues"]
    >(() =>
      Promise.resolve({
        ok: true,
        value: {
          stuckRecovered: 0,
          noHeartbeatRecovered: 0,
          staleRecovered: 0,
        },
      })
    ),
    // Issue #1888 — startHeartbeat awaits the initial recordHeartbeat result
    // and checks `.ok`, so the mock must return a Result rather than `undefined`.
    recordHeartbeat: mockFn<CrashHandlingDeps["recordHeartbeat"]>(() =>
      Promise.resolve({ ok: true, value: undefined })
    ),
    clearHeartbeat: mockFn<CrashHandlingDeps["clearHeartbeat"]>(() =>
      Promise.resolve({ ok: true, value: undefined })
    ),
    recordMilestone: mockFn<CrashHandlingDeps["recordMilestone"]>(() =>
      Promise.resolve({ ok: true, value: undefined })
    ),
    ...overrides?.crashHandling,
  };

  const mockInfrastructure: InfrastructureDeps = {
    atomicWrite: mockFn<InfrastructureDeps["atomicWrite"]>(() =>
      Promise.resolve({ ok: true, value: undefined })
    ),
    safeReadFile: mockFn<InfrastructureDeps["safeReadFile"]>(() =>
      Promise.resolve({ ok: true, value: "" })
    ),
    safeMktemp: mockFn<InfrastructureDeps["safeMktemp"]>(() =>
      Promise.resolve({ ok: true, value: "/tmp/mock-temp" })
    ),
    checkAndCleanupDiskSpace: mockFn<
      InfrastructureDeps["checkAndCleanupDiskSpace"]
    >(() =>
      Promise.resolve({
        usagePercent: 50,
        threshold: 90,
        gentleThreshold: 80,
        tier: "none",
        cleanedUp: false,
        denoCacheCleaned: false,
        message: "mock disk OK",
      })
    ),
    checkAndRotateLog: mockFn<InfrastructureDeps["checkAndRotateLog"]>(() =>
      Promise.resolve(false)
    ),
    buildPrompt: mockFn<InfrastructureDeps["buildPrompt"]>(() =>
      Promise.resolve({
        ok: true,
        value: { systemPrompt: "mock system", prompt: "mock prompt" },
      })
    ),
    loadPrompt: mockFn<InfrastructureDeps["loadPrompt"]>(() =>
      Promise.resolve({ ok: true, value: "mock template" })
    ),
    shuffleArray: mockFn<InfrastructureDeps["shuffleArray"]>(<T>(
      items: readonly T[],
    ) => [...items]),
    evaluateRunGuard: mockFn<InfrastructureDeps["evaluateRunGuard"]>(() =>
      Promise.resolve({ action: "proceed", reason: "mock proceed" })
    ),
    ...overrides?.infrastructure,
  };

  const mockQuality: QualityDeps = {
    runQualityGate: mockFn<QualityDeps["runQualityGate"]>(() =>
      Promise.resolve({
        ok: true,
        value: {
          checks: [],
          summary: { text: "All checks passed", passed: true },
          passed: true,
          output: "",
        },
      })
    ),
    formatSummary: mockFn<QualityDeps["formatSummary"]>(() => ({
      text: "All checks passed",
      passed: true,
    })),
    collectDiffableGateFindings: mockFn<
      QualityDeps["collectDiffableGateFindings"]
    >(() => Promise.resolve([])),
    fileBaselineCarryoverTracker: mockFn<
      QualityDeps["fileBaselineCarryoverTracker"]
    >(() => Promise.resolve()),
    readBaselineQualityCache: mockFn<QualityDeps["readBaselineQualityCache"]>(
      () => Promise.resolve(null),
    ),
    writeBaselineQualityCache: mockFn<QualityDeps["writeBaselineQualityCache"]>(
      () => Promise.resolve(),
    ),
    ...overrides?.quality,
  };

  return {
    logger: mockLogger,
    config: mockConfig,
    github: mockGithub,
    git: mockGit,
    issues: mockIssues,
    pr: mockPr,
    claude: mockClaude,
    security: mockSecurity,
    failureTracking: mockFailureTracking,
    crashHandling: mockCrashHandling,
    infrastructure: mockInfrastructure,
    quality: mockQuality,
  };
}
