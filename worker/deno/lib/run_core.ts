/**
 * Main event loop with priority dispatch and signal handling.
 *
 * Owns the priority-dispatch main loop in type-safe Deno TypeScript:
 * initialisation, the priority dispatch loop, rate limiting, circuit breaker
 * integration, and graceful shutdown. Invoked as the Deno `run-core` command.
 *
 * This is the main loop only. The surrounding orchestration — PID guard, the
 * bootstrap prelude, startup housekeeping, and exit cleanup — lives in the Deno
 * worker driver (worker/deno/lib/run_worker.ts), which calls this loop last.
 * Issue #3504 deleted the bash `worker/run_core.sh` conductor that previously
 * sequenced these steps and delegated the main loop here via
 * `deno_run_command "run-core"` (Issue #1124).
 *
 * Issue #968: Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { OPERATIONAL_DEFAULTS } from "./config_defaults.ts";
import type { FableAvailability } from "./health_check_cache.ts";
import type { RefreshOutcome } from "./trust_snapshot.ts";
import {
  formatCounterSummary,
  resetCounters,
} from "./fault_tolerance_counters.ts";
import {
  formatGhCallsByPrioritySummary,
  formatGhCallSummary,
  formatGraphQLSummary,
  resetGhCallMetrics,
  withPriorityContext,
} from "./gh_call_metrics.ts";
import {
  MAINTENANCE_LANE_SLOT_ID,
  type MaintenanceLaneBroker,
  runInMaintenanceLane,
} from "./maintenance_lane.ts";
import {
  formatCycleTimingsSummary,
  recordStepDuration,
  startCycleTimings,
} from "./cycle_timings.ts";
import type { HeartbeatLiveKey } from "./heartbeat.ts";
import { formatInFlightHold, InFlightRepoRegistry } from "./in_flight_repos.ts";
import type {
  ProcessedIssueReason,
  ProcessedIssueRegistry,
} from "./processed_issue_registry.ts";
import type { SlotCeiling } from "./slot_governor.ts";
import {
  deriveRunOutcome,
  describeRunOutcome,
  type RunOutcome,
} from "./run_outcome.ts";
import {
  formatSlotPrefix,
  renderSlotStatus,
  runInSlotContext,
} from "./slot_context.ts";
import {
  createWriteRepoAllowlistContext,
  withWriteRepoAllowlistContext,
} from "./write_repo_allowlist.ts";
import {
  getInaccessibleRepos,
  logRepoAccessOnce,
} from "./monitored_repo_access.ts";
import { resolveClaimRunwayFloor } from "./claim_runway.ts";
import {
  decideAdaptiveClaim,
  type IssueClaimEvidence,
  issueClaimKey,
} from "./claim_runway_evidence.ts";
import {
  ADAPTIVE_FLOOR_STARVATION_LIMIT,
  formatAdaptiveFloorStarvation,
} from "./adaptive_floor_starvation.ts";
import {
  type DiagnosticSummary,
  formatScanSummary,
} from "./issue_finder_logger.ts";
import { formatRateLimitReset } from "./rate_limit_signal.ts";
import { isPrimaryRateLimitMessage } from "./primary_quota_latch.ts";
import { waitUntilRateLimitReset } from "./rate_limit_wait.ts";
import { runWithWatchdog } from "./handler_watchdog.ts";
import { resolveStartPriority, type ScanCursor } from "./scan_cursor.ts";
import {
  formatBuildStamp,
  resolveWorkerBuildInfo,
} from "./worker_build_info.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the main worker loop. */
export interface RunCoreConfig {
  /** Total duration to run before planned shutdown (seconds, default: 3600). */
  runDurationSeconds: number;
  /** Base sleep interval between scan cycles (seconds, default: 30). */
  sleepInterval: number;
  /**
   * Concurrent-issue slot count (Issue #4174; default 1). Made available and
   * validated here; `runIssueScanLoop` does not yet consume it — the pool is
   * a sub-issue of #4168.
   */
  maxConcurrentIssues: number;
  /** Maximum consecutive failures before exit (default: 10). */
  maxConsecutiveFailures: number;
  /** Rate limit backoff duration (seconds, default: 300). */
  rateLimitBackoff: number;
  /**
   * Per-handler hard watchdog timeout (seconds, default: 600 — Issue #2473).
   *
   * Each Priority 1.x handler's `execute()` is bounded by this timeout so a
   * hung `gh`/network call cannot freeze the whole dispatch loop. On timeout
   * the loop logs a `[watchdog]` line and proceeds to the next priority. A
   * value `<= 0` disables the watchdog. Kept conservative so it never trips a
   * legitimately slow handler nor interferes with the rate-limit pause/resume.
   */
  handlerTimeoutSeconds: number;
  /**
   * Per-handler soft watchdog threshold (seconds, default: 120 — Issue #2473).
   *
   * A handler that returns but took at least this long emits a `[watchdog]`
   * soft-warning so slow handlers stay visible in logs. A value `<= 0`
   * disables soft warnings.
   */
  handlerSoftTimeoutSeconds: number;
  /**
   * The planning agent's own wall-clock timeout (seconds, default 1800 —
   * mirrors `WorkerConfig.planningTimeout`).
   *
   * Read only to size Planning Mode's watchdog floor (Issue #62): the handler
   * budget must never be smaller than the agent timeout it wraps plus
   * `PLANNING_TAIL_SECONDS` for the post-publish gate and self-repair.
   */
  planningTimeoutSeconds: number;
}

/** Result of a single priority handler execution. */
export interface PriorityHandlerResult {
  /** Whether an item was found and processed. */
  processed: boolean;
  /** Whether a rate limit was detected. */
  rateLimited?: boolean;
}

/** What the dispatcher tells a handler about its own watchdog bound (#58). */
export interface HandlerExecuteOptions {
  /**
   * Epoch-millisecond instant at which the watchdog will abandon this handler.
   * A handler doing bounded post-work (e.g. the Failure-Detection self-repair)
   * uses it to stop cleanly rather than be killed mid-way. Optional: a handler
   * that ignores it behaves exactly as before.
   */
  deadlineEpochMs: number;
}

/** A single entry in the priority dispatch table. */
export interface PriorityHandler {
  /** Numeric priority (lower = higher priority). */
  priority: number;
  /** Human-readable name for logging. */
  name: string;
  /** Execute this priority level's work. */
  execute: (
    opts?: HandlerExecuteOptions,
  ) => Promise<Result<PriorityHandlerResult | void>>;
  /**
   * The handler may spawn a coding agent (Issue #4369). Its watchdog is
   * bounded by the cycle deadline rather than the flat handler timeout — an
   * agent run legitimately takes 10–60 min — and an abandonment terminates
   * the agent instead of leaving it running detached.
   */
  agentBacked?: boolean;
  /**
   * Lower bound in milliseconds for this handler's watchdog budget (Issue
   * #62), for an agent-backed handler that keeps working after its agent
   * returns. Built with `agentHandlerFloorMs()` from the wrapped agent's own
   * timeout plus the handler's post-agent tail allowance, so the budget can
   * never be smaller than the agent timeout it contains — even when the cycle
   * has no time left. Undefined for a handler with no post-agent tail, which
   * keeps the Issue #4369 cycle-deadline bound unchanged.
   */
  agentFloorMs?: number;
  /**
   * Run this handler in the **maintenance lane**, concurrently with the
   * Priority-2 issue-scan pool, rather than serially ahead of it (Issue
   * #213). A CI fix with a 30-minute agent budget used to hold every issue
   * slot idle for half the cycle; in the lane it competes for wall-clock
   * with issue work instead of pre-empting it.
   *
   * Only for handlers whose wiring takes an `acquireMaintenanceRepoLease()`
   * before it touches `${WORK_DIR}/<repo>` — without the lease a pass and a
   * slot can write the same working tree. Handlers without the flag keep
   * running serially, exactly as before, and so does every handler when the
   * pool is off (`max_concurrent_issues: 1`).
   */
  maintenanceLane?: boolean;
}

/** What one dispatched priority handler did. */
type PriorityDispatchOutcome =
  /** Ran to completion (or was abandoned by the watchdog). */
  | { kind: "completed" }
  /** The handler reported a rate limit: stop dispatching this cycle. */
  | { kind: "rate-limited" }
  /** A primary rate limit was thrown: the caller owns the pause. */
  | { kind: "rate-limit-error"; error: Error };

/** Discovered issue for processing. */
export interface DiscoveredIssue {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  milestoneTitle: string;
}

/** Result of the main loop execution. */
export interface RunCoreResult {
  /** Whether the loop exited due to planned shutdown (duration expired). */
  plannedShutdown: boolean;
  /** Whether the loop was skipped due to PID lock. */
  skippedDueToPidLock: boolean;
  /** Whether the loop exited due to consecutive failures. */
  exitedOnFailures: boolean;
  /** Number of issues processed during the run. */
  issuesProcessed: number;
  /** Total duration in seconds. */
  durationSeconds: number;
  /** Human-readable reason for exit. */
  exitReason: string;
  /**
   * Issue #342: whether the loop stopped because the host is out of quota and
   * the wait would outlast this run. A scheduled pause, not a failure — the
   * supervisor re-probes at a fixed cadence instead of backing off.
   */
  quotaPaused: boolean;
  /**
   * When the usage window the pause was waiting on reopens, in epoch
   * milliseconds. Only set alongside `quotaPaused` (Issue #342).
   */
  quotaResetEpochMs?: number;
  /**
   * Issue #2602: whether the most recent health checks (Claude + GitHub auth)
   * passed. Used to gate the end-of-run private-repo-6 report — a worker that
   * could not authenticate must not report itself healthy.
   */
  lastHealthCheckPassed: boolean;
}

/** Mutable progress tracker for a scan cycle. */
export interface WorkProgressTracker {
  /** Number of issues successfully processed this run. */
  issuesProcessed: number;
  /**
   * Whether the current scan cycle had any success.
   *
   * Set true by either:
   *   - a Priority 1–1.85 handler returning `{ processed: true }`, or
   *   - a successful Priority 2 issue claim via `recordSuccess()`.
   *
   * Retained for callers that still need the broad "did anything happen"
   * signal. The idle-task filer gate (Issue #2048) uses the narrower
   * `foundClaimableIssue` flag instead.
   */
  scanHadSuccess: boolean;
  /**
   * Whether the current scan cycle found and processed a claimable issue
   * via the Priority 2 scan path (Issue #2048).
   *
   * Set true only from `recordSuccess()` — i.e. only when Priority 2
   * claimed and successfully processed an issue. Priority 1–1.85
   * handlers do **not** flip this flag, because their work (PR
   * feedback, planning, milestone bookkeeping, refinement, etc.) is
   * orthogonal to "is there a claimable issue this cycle".
   *
   * The idle-task filer gate uses this flag so a busy Priority 1
   * handler in one repo does not suppress idle-task filing when the
   * Priority 2 scan came up empty across every monitored repo.
   */
  foundClaimableIssue: boolean;
  /**
   * Repos the Priority 2 scan claimed an issue from this cycle (Issue #460).
   *
   * Distinct from {@link WorkProgressTracker.foundClaimableIssue}, which
   * flips only on *success*. GRQ#4465 was filed against a repo the scan had
   * claimed from and worked for thirteen minutes — the run then timed out at
   * the cycle deadline, so no success was recorded and the idle-inversion
   * streak counted the repo as one the scan "keeps refusing". A claim that
   * later fails is still not a refusal.
   */
  claimedRepos: Set<string>;
  /** Record a successful issue processing. */
  recordSuccess: () => void;
  /** Record that the scan claimed an issue from `repo` this cycle (#460). */
  recordClaim: (repo: string) => void;
  /** Reset scan-level progress tracking for a new cycle. */
  resetScanProgress: () => void;
}

/**
 * Dependency injection interface for the main event loop.
 *
 * All external operations are injected, enabling testing without
 * real file I/O, network calls, or process management.
 */
export interface RunCoreDeps {
  // Logging
  log: (message: string) => void;
  logError: (message: string) => void;
  logTiming: (operation: string, durationSeconds: number) => void;
  logWorkerSummary: (issuesProcessed: number, durationSeconds: number) => void;

  // PID management
  checkPidFile: () => Promise<{ canProceed: boolean; message: string }>;
  claimPidFile: () => Promise<void>;
  releasePidFile: () => Promise<void>;

  // Initialisation
  gitResetToOrigin: () => Promise<Result<void>>;
  setupLogging: () => Promise<void>;
  loadAndValidateConfig: () => Promise<Result<RunCoreConfig>>;
  checkDependencies: () => Promise<Result<void>>;
  checkSoftwareUpdates: () => Promise<void>;
  checkDiskSpace: () => Promise<Result<void>>;
  rotateLogFiles: () => Promise<void>;
  cleanupStaleTempFiles: () => Promise<void>;
  recoverStuckIssues: () => Promise<void>;
  cleanupStaleBranches: () => Promise<void>;
  checkFeatureAvailability: () => Promise<void>;

  // Health checks
  checkClaudeHealth: () => Promise<Result<{ healthy: boolean }>>;
  /**
   * Fresh (uncached) agent auth re-probe for the mid-cycle auth-outage
   * breaker (Issue #4167). The cycle-start health gate passed, but a
   * credential can die mid-cycle: one outage churned six claims in 16
   * minutes, each a billed Fable-tier run against a dead credential.
   * Optional — when absent the breaker is inert.
   */
  recheckAgentAuth?: () => Promise<{ authFailed: boolean; message?: string }>;
  checkGhAuth: () => Promise<Result<{ valid: boolean }>>;
  /**
   * Fable-availability probe (Issue #3230, parent #3217).
   *
   * Optional and best-effort: populates the `.health_cache_fable` cache
   * alongside the Claude health-check cadence so a later pre-flight reroute
   * (a separate sub-issue) can read a fresh verdict. Fable being unavailable
   * MUST NOT fail the health check or block the worker — this only sets the
   * cache. Returns the verdict; never throws.
   */
  checkFableAvailability?: () => Promise<FableAvailability>;

  /**
   * Monitored repos the worker can no longer see (Issue #4038).
   *
   * Optional test seam. When omitted the loop reads the real access-state
   * store (#4036), which is what production uses — so a host wired without
   * this dep still gets the gate.
   */
  getInaccessibleRepos?: () => string[];

  // Priority 1: PR feedback
  findAndProcessPrFeedback: () => Promise<Result<PriorityHandlerResult>>;

  // Priority 1.5: Spelling checks
  findAndProcessSpellingFailure: () => Promise<Result<PriorityHandlerResult>>;

  // Priority 1.55: CI checks
  findAndProcessCiFailure: () => Promise<Result<PriorityHandlerResult>>;

  // Priority 1.6: Update PR branches
  updateOpenPrBranches: () => Promise<Result<void>>;

  /**
   * Priority 1.61: resolve PRs stuck at `mergeable == CONFLICTING` (Issue #84).
   *
   * Runs straight after the branch updater, which detects the conflict but
   * refuses to side-pick it (Issue #4373), and before the CI nudge, which
   * would otherwise poke a PR no CI can ever run on.
   *
   * Optional — when absent the priority is a no-op, so a host wired without
   * the conflict pass runs every other priority unchanged.
   */
  findAndProcessMergeConflict?: () => Promise<Result<PriorityHandlerResult>>;

  // Priority 1.62: Nudge stalled CI on Vibe Coder PRs (Issue #2100)
  nudgeStalledCi: () => Promise<Result<void>>;

  /**
   * Priority 1.63: escalate PRs that block `work-on` issues while red or
   * carrying an unanswered authorised comment (Issue #4025).
   *
   * Optional — when absent the priority is a no-op, so a host wired
   * without the watchdog still runs every other priority unchanged.
   */
  scanBlockingPrStalls?: () => Promise<Result<void>>;

  // Priority 1.65: Auto-merge
  ensureAutoMerge: () => Promise<Result<void>>;

  // Priority 1.66: Branch cleanup
  cleanupMergedBranches: () => Promise<Result<void>>;

  // Priority 1.67: Close issues for merged PRs
  closeIssuesForMergedPrs: () => Promise<Result<void>>;

  // Priority 1.68: Recover assigned with closed PRs
  recoverAssignedWithClosedPr: () => Promise<Result<void>>;

  // Priority 1.72: Milestone branch sync (Issue #1238)
  syncMilestoneBranches: () => Promise<Result<void>>;

  // Priority 1.7: Milestone completions
  checkMilestoneCompletions: () => Promise<Result<void>>;

  // Priority 1.75: Refinement
  findAndProcessRefinement: () => Promise<Result<PriorityHandlerResult>>;

  // Priority 1.78: Grill-me iterative clarification (Issue #1615, #1619)
  findAndProcessGrillMe: () => Promise<Result<PriorityHandlerResult>>;

  /**
   * Priority 1.79: Quorum plan-off (Issue #4112, parent #4102).
   *
   * Runs **before** planning: Quorum decides what the plan is, then the
   * planning phase splits that plan into sub-issues.
   *
   * Optional — when absent the priority is a no-op, so a host wired without
   * Quorum runs every other priority unchanged.
   */
  findAndProcessQuorum?: () => Promise<Result<PriorityHandlerResult>>;

  // Priority 1.80: Planning mode
  /**
   * Issue #58: receives the dispatcher's watchdog deadline so the planning
   * run's post-publication self-repair can defer work it cannot finish.
   */
  findAndProcessPlanning: (
    opts?: HandlerExecuteOptions,
  ) => Promise<Result<PriorityHandlerResult>>;

  /**
   * Priority 1.81: Failure-Detection repair resume (Issue #60, part of #54).
   *
   * Finishes the outstanding repairs a partially-repaired planning run left
   * behind: re-gates each `needs-failure-detection-repair` parent's native
   * sub-issues, repairs what still offends, and clears the label when the set
   * is empty. Sits immediately after Planning because it consumes the state
   * Planning produces.
   *
   * Optional — when absent the priority is a no-op, so a host wired without
   * the resume pass runs every other priority unchanged.
   */
  resumeFailureDetectionRepairs?: (
    opts?: HandlerExecuteOptions,
  ) => Promise<Result<PriorityHandlerResult>>;

  // Priority 1.85: Question answering
  findAndProcessQuestion: () => Promise<Result<PriorityHandlerResult>>;

  // Priority 1.9: Stale workflow detection (Issue #1240)
  // Issue #1781: caller passes `shouldShutdown` so the rate-limit
  // pause-and-resume loop can abort cleanly on SIGTERM/SIGINT.
  scanStaleWorkflowIssues: (
    opts: { shouldShutdown: () => boolean },
  ) => Promise<Result<void>>;

  // Priority 2: Issue scanning
  /**
   * Find the next claimable issue. `options.excludeRepos` (Issue #4176):
   * repositories currently held by another slot on this host — skipped so
   * a free slot gets the next eligible issue from a different repository.
   * Absent: unchanged serial behaviour.
   *
   * `options.onScanSummary` (Issue #219): invoked with the scan's counts
   * before the result is returned, so a slot that receives `null` can log
   * how many issues were considered and which skip reasons dominated. Not
   * every implementation reports one; a caller must handle its absence.
   */
  findNextIssue: (
    options?: {
      excludeRepos?: ReadonlySet<string>;
      /**
       * Issues this cycle has already deferred for the adaptive claim floor
       * (Issue #245), keyed `owner/repo#number`. Skipped so the scan offers
       * the next candidate instead of the same doomed one; the set is
       * cycle-scoped because the runway it was judged against only shrinks.
       */
      excludeIssues?: ReadonlySet<string>;
      onScanSummary?: (summary: DiagnosticSummary) => void;
    },
  ) => Promise<Result<DiscoveredIssue | null>>;
  /**
   * Drop the cached issue list for one repository (Issue #219).
   *
   * Called by a slot that lost the acquire race, so its next scan is not
   * served the same ranking that just lost from the per-cycle cache.
   * Optional: absent means the next scan reuses whatever the cache holds.
   */
  invalidateRepoIssueCache?: (repo: string) => Promise<void>;
  processIssue: (
    issue: DiscoveredIssue,
    /**
     * Epoch-ms deadline of the current cycle (Issue #4254). Passed through
     * to the execute phase so a claim taken late cannot run a full
     * claudeTimeout past the planned shutdown. Optional — the CLI
     * single-issue path omits it.
     */
    cycleDeadlineEpochMs?: number,
  ) => Promise<
    Result<{
      success: boolean;
      skipped?: boolean;
      /**
       * Failure class (Issue #4304): "timeout" marks a run that burned its
       * whole budget and produced nothing, which feeds the escalating
       * re-claim cooldown. Absent on success/skip and ordinary failures.
       */
      failureKind?: "timeout";
      /**
       * What the run achieved (Issue #4325, part of #4291) — carried to the
       * claim-release comment. Absent on skip (the run never ran).
       */
      outcome?: RunOutcome;
    }>
  >;

  /**
   * Sweep heartbeat intervals leaked by a previous claim's processor
   * (Issue #3760).
   *
   * Called before each `processIssue` so a leaked interval is stopped —
   * and logged by the production implementation — instead of firing
   * against the next claim's reseeded write-repo allowlist forever
   * (`WRITE_REPO_BLOCKED` … `heartbeat_failure (consecutive: N)`).
   * Optional so existing test fixtures and callers are unaffected.
   */
  sweepLeakedHeartbeats?: () => Promise<void>;
  /**
   * Slot-aware variant (Issue #4178): stop only heartbeats that none of the
   * given live keys owns. The pool calls this instead of
   * `sweepLeakedHeartbeats`, so a sibling slot's healthy heartbeat is never
   * mistaken for a leak. The live set names every hold that owns a
   * heartbeat, the maintenance lane's PRs included (Issue #391).
   */
  sweepLeakedHeartbeatsExcept?: (
    live: ReadonlyArray<HeartbeatLiveKey>,
  ) => Promise<void>;
  /**
   * Host-local registry of repositories held by slots (Issue #4176). The
   * pool creates one when absent; production supplies a shared instance so
   * status rendering and heartbeat sweeps see the same holds.
   */
  inFlightRepos?: InFlightRepoRegistry;
  /**
   * Per-run record of issues already finished this run (Issue #181). Every
   * terminal outcome — success, skip, failure — is recorded here, and the
   * production `findNextIssue` excludes what it holds, so a stale cached
   * issue list (600 s TTL) can no longer re-offer an issue this run has
   * already handled or closed. Optional: absent means no exclusion, which is
   * the pre-#181 behaviour.
   */
  processedIssues?: ProcessedIssueRegistry;
  /**
   * Memory-pressure slot ceiling (Issue #4179). Optional: absent means the
   * configured `maxConcurrentIssues` is the effective count.
   */
  slotCeiling?: SlotCeiling;
  /**
   * Terminate every agent subprocess the worker is awaiting and refuse new
   * ones (Issue #4369). Called when a handler is abandoned by the watchdog
   * and when the run ends, so no agent runs detached from the loop or is
   * relaunched after "Run complete". Optional for test deps.
   */
  terminateActiveAgentRuns?: (
    reason: string,
    options?: { keepTerminating?: boolean },
  ) => Promise<void>;

  // Failure tracking
  trackFailure: (key: string) => Promise<void>;
  resetFailures: () => Promise<void>;
  shouldExitOnFailures: () => Promise<boolean>;
  recordIssueCooldown: (
    repo: string,
    issueNumber: number,
    failureKind?: "timeout",
  ) => Promise<void>;

  /**
   * Minimum seconds of cycle runway required before taking another claim
   * (Issue #4304). A claim taken with less runway than any plausible
   * completion time is doomed on arrival — the #4254 timeout bound makes
   * it fail *faster*, not succeed. Optional: absent keeps the plain
   * deadline gate.
   */
  minClaimRunwaySeconds?: number;

  /**
   * The configured execute budget (`config.claudeTimeout`, Issue #47).
   * When the cycle is long enough to ever offer this budget, the claim
   * floor above is raised to it, so a deadline-bound execute is a
   * documented exception rather than the default tail of every cycle.
   * Optional: absent keeps the plain #4304 floor.
   */
  fullExecuteBudgetSeconds?: number;

  /**
   * The configured execute budget (`config.claudeTimeout`), always supplied
   * — unlike `fullExecuteBudgetSeconds`, which production sets only under
   * the #47 opt-in. Sizes the adaptive floor an issue with evidence of a
   * long job must clear (Issue #245). Optional: absent disables that floor.
   */
  executeBudgetSeconds?: number;

  /**
   * Claim-time evidence for the adaptive floor (Issue #245): preserved WIP,
   * a prior `timeout` in `execute`, or a long-job size label. Optional —
   * absent means no issue is ever deferred and the plain floor alone
   * decides, exactly as before #245.
   */
  gatherIssueClaimEvidence?: (
    issue: DiscoveredIssue,
  ) => Promise<{ evidence: IssueClaimEvidence; lookupError?: string }>;

  /**
   * Record that the adaptive floor deferred an issue this cycle, and return
   * how many consecutive cycles it has now been deferred (Issue #375). The
   * key is `issueClaimKey(repo, number)`. Optional: absent means the floor
   * defers without a memory, exactly as before #375 — which on a host whose
   * cycle can never satisfy the floor strands the issue for ever.
   */
  recordAdaptiveFloorDeferral?: (key: string) => Promise<number>;

  /**
   * Forget an issue's deferral streak (Issue #375) — called whenever the
   * adaptive floor stops deferring it, so the next starvation run starts
   * from zero. Optional, and paired with `recordAdaptiveFloorDeferral`.
   */
  clearAdaptiveFloorDeferral?: (key: string) => Promise<void>;

  /**
   * Consecutive deferred cycles after which the adaptive floor yields and the
   * issue is claimed on whatever runway is left (Issue #375). Defaults to
   * {@link ADAPTIVE_FLOOR_STARVATION_LIMIT}; tests override it.
   */
  adaptiveFloorStarvationLimit?: number;

  /**
   * How long a shutdown (SIGTERM / SIGINT) waits for in-flight slots to
   * finish before abandoning them (Issue #4182). Only a SHUTDOWN is
   * bounded — a deadline drain always lets a slot that started before the
   * deadline complete. When the grace elapses, every outstanding claim is
   * released so nothing stays assigned to a dead worker, and the exit
   * cleanup terminates the abandoned agent subprocesses. Default 300 s.
   */
  slotDrainGraceSeconds?: number;

  // Circuit breaker
  circuitBreakerReset: () => Promise<void>;
  circuitBreakerRecordZeroProgress: () => Promise<void>;
  circuitBreakerGetSleepInterval: () => Promise<number>;
  isRateLimitActive: () => Promise<boolean>;

  /**
   * Remaining seconds in the current rate-limit signal, or 0 when the
   * signal is absent / expired. Used by the mid-loop pause-and-resume
   * branch to derive the reset epoch instead of sleeping a fixed
   * backoff (Issue #1780).
   */
  getRateLimitRemainingSeconds: () => Promise<number>;

  /**
   * Fetch the current GitHub rate-limit reset epoch (Unix seconds) via
   * the free `gh api rate_limit` endpoint. Used by the pre-flight and
   * outer-catch pause-and-resume paths (Issue #1780).
   */
  getRateLimitReset: () => Promise<number>;

  // Pre-flight GitHub rate-limit gate (free call; runs once at worker start
  // to prevent doomed respawn cycles when the primary quota is exhausted).
  preflightGitHubRateLimit: () => Promise<{
    rateLimited: boolean;
    remainingSeconds: number;
    message: string;
  }>;

  // Repo failure tracking
  // Issue #2793: these perform read-modify-write file I/O, so they return
  // promises that the loop awaits — preventing a lost-update race between
  // overlapping unsynchronised writes and surfacing any write failure.
  resetRepoFailures: () => Promise<void>;
  recordRepoFailure: (repo: string, issueNumber?: number) => Promise<void>;
  recordRepoSuccess: (repo: string) => Promise<void>;

  // Crash handling
  sendCrashNotification: (details: string) => Promise<void>;
  clearHeartbeat: () => Promise<void>;
  cleanupInProgressIssue: () => Promise<void>;

  /**
   * Release the worker's claim on a specific issue (Issue #2670): unassign
   * the worker AND clear the heartbeat/marker. Every scan-loop release path
   * (success, failure, skip-after-claim) calls this so a released issue is
   * never left assigned — clearing the heartbeat alone left the issue
   * permanently assigned and blocked all future pickup (incident #2648).
   *
   * Best-effort and idempotent: a double-unassign is harmless. Optional so
   * existing test deps can omit it; when omitted the loop falls back to
   * `clearHeartbeat()` (the previous, marker-only behaviour).
   */
  releaseClaim?: (
    repo: string,
    issueNumber: number,
    outcome?: RunOutcome,
  ) => Promise<void>;

  // Status
  setStatusIdle: () => Promise<void>;
  setStatusWorking: (details: string) => Promise<void>;
  setStatusSuccess: () => Promise<void>;
  setStatusFailure: () => Promise<void>;
  resetWindowTitle: () => void;

  // Signal handling
  addSignalListener: (signal: string, handler: () => void) => void;
  removeSignalListener: (signal: string, handler: () => void) => void;

  // Fault tolerance observability (Issue #1173)
  writeFaultToleranceSummary: () => Promise<void>;

  /**
   * Check the daily model-spend ceiling (Issue #3648).
   *
   * Called at the top of every priority-loop iteration, before any further
   * billed work is claimed. Returning `exceeded: true` stops the cycle with a
   * `[SPEND_CEILING]` error line. Optional so test deps and deployments
   * without a configured ceiling can omit it; production wires it to
   * `checkDailySpendCeiling`.
   */
  checkSpendCeiling?: () => Promise<{ exceeded: boolean; message?: string }>;
  /**
   * Host free-disk status (Issue #226). Consulted before every claim, next
   * to the spend ceiling: a `low` reading drains the pool / stops the
   * serial loop claiming, so a host short of disk finishes what it is
   * running and starts nothing new. Optional so test deps and native
   * deployments without the launcher baseline can omit it.
   */
  checkHostDisk?: () => Promise<
    { level: "ok" | "low" | "unknown"; detail: string }
  >;
  /**
   * Reclaim disposable work-volume space (Issue #242). Called once per
   * cycle when {@link RunCoreDeps.checkHostDisk} reports `low`, *before*
   * the cycle stops claiming: the work root's second tier — the sibling
   * data clones a gate pulled in as `../<name>` — is removed largest
   * first, so a host merely short of room heals itself instead of idling
   * for a cycle. `healed` is the post-reclaim disk reading: true only when
   * the host is no longer `low`. Optional; production wires it to the
   * two-tier reclaim.
   *
   * Issue #384: `bytesReclaimed` counts bytes deleted **inside the guest**.
   * On a containerised host those blocks stay allocated to the thin
   * volume image, so the host figure does not move and `healed` stays
   * false — `detail` names that condition and the remedy rather than
   * reading as a cleanup that failed.
   */
  reclaimDiskSpace?: () => Promise<
    { bytesReclaimed: number; detail: string; healed: boolean }
  >;
  /**
   * Work-volume I/O fault (Issue #229): set once a git call surfaced a
   * filesystem-level error ("Structure needs cleaning", EIO, read-only).
   * Consulted next to the host-disk status: a faulted volume claims
   * nothing new; the launcher repairs or recreates it next launch.
   */
  checkWorkVolumeFault?: () => { faulted: boolean; detail: string };
  /**
   * Standing work-volume totals by category (Issue #244), logged at cycle
   * start beside the `Concurrency:` line and again at end of run. Returns
   * the formatted line — monitored repos, side/data clones, build artefacts,
   * caches, other, with the top offenders named — so growth is visible in
   * the worker log long before the host-disk gate (Issue #226) trips.
   *
   * Issue #345: `label` names the sample and `force` skips the walk's
   * cadence, so the end-of-run line is a fresh reading of the volume at its
   * fullest rather than a replay of the cycle-start one. Optional;
   * production wires it to a depth-1 `du` walk of the work root.
   */
  reportWorkVolumeUsage?: (
    options?: { label?: string; force?: boolean },
  ) => Promise<string>;
  /**
   * Whether this host can still see its own disk (Issue #345).
   *
   * `blind` is true only when **both** disk signals have failed — the
   * host-disk reading (Issue #226) and the work-volume totals (Issue #244).
   * A host with neither signal cannot warn anybody before it fills up, which
   * is how GRQ-23 crashed out of disk with every line reading `available`,
   * so it is a health condition in its own right: the iteration marks the
   * host unhealthy and the fleet payload names it. Optional.
   */
  checkDiskTelemetry?: () => { blind: boolean; detail: string };

  // Misc
  touchPidFile: () => Promise<void>;
  sleep: (ms?: number) => Promise<void>;
  now: () => number;

  /**
   * Injected watchdog timer (Issue #2473): resolves after `ms` milliseconds.
   *
   * Used to bound each Priority 1.x handler's `execute()` so a hung call
   * cannot freeze the dispatch loop. Production wires this to `setTimeout`;
   * tests pass a controllable promise so the timeout fires deterministically
   * without a real sleep. Optional — when omitted the loop falls back to a
   * real `setTimeout`-based timer.
   */
  watchdogDelay?: (ms: number) => Promise<void>;

  /**
   * Reset iteration-scoped in-memory caches at the start of each
   * main-loop iteration (Issue #1783). Optional so test deps can omit
   * it. Called alongside `resetGhCallMetrics` so the registry mirrors
   * the same iteration boundary as the gh-call telemetry.
   */
  resetIterationCaches?: () => void;

  /**
   * Refresh the trusted-author snapshot at the top of each cycle
   * (Issue #253).
   *
   * Production currently copies the static config arrays, so the
   * snapshot's contents never change between cycles. The hook exists so
   * a later source flip (Issue #256) can replace that copy with a
   * GitHub-derived resolve without touching the loop again.
   *
   * A failed refresh is fail-closed and stricter than the spend-ceiling
   * or host-disk gates: no issue claiming, no comment-driven work, no
   * label-driven work, and no PR-invitation or escape-hatch processing
   * for that cycle. No maintenance pass is treated as trust-independent
   * — if that is not obvious for a given pass, it is skipped.
   *
   * Optional so existing test deps can omit it; when omitted the gate
   * is inert and behaviour is unchanged.
   */
  refreshTrustedAuthors?: () => Promise<RefreshOutcome>;

  /**
   * Report worker health to the private-repo-6 repository (Issue #1935).
   *
   * Invoked at the top of every priority-loop iteration as a heartbeat,
   * so the host's `last_commit_ts` row in `private-repo-6/docs/repos.json`
   * advances at least once per iteration. The previous end-of-run-only
   * heartbeat in `commands/run_core.ts` was silently lost when the
   * parent shell sent SIGTERM during the post-loop best-effort block,
   * leaving hosts flagged dead on the dashboard.
   *
   * Best-effort — failures are caught by the loop and never abort the
   * run. The underlying `helpers/repos.sh` script enforces its own 1h
   * rate-limit, so frequent calls are cheap no-ops between real pushes.
   *
   * Optional so test deps can omit it.
   */
  reportFleetHealthHeartbeat?: () => Promise<void>;

  /**
   * Fire the idle-task issue filer (Issue #2005).
   *
   * Invoked after a scan cycle ends with no claimed work. The hook
   * delegates to the `maybe-file-idle-task` Deno command, which
   * short-circuits on any monitored repo with claimable work, shuffles
   * the monitored-repo list, picks the first repo with no open
   * `idle-task` issue, and files a new GitHub issue carrying the
   * `idle-task` label and the per-template milestone. The next
   * priority-dispatch iteration claims and executes that issue via the
   * standard machinery — no in-process security-scan trigger and no
   * state files are required (Issue #2023).
   *
   * Best-effort: any error thrown is caught and logged by the caller
   * so a filer crash never aborts the worker's main loop. Optional so
   * test deps can omit it.
   */
  runIdleTaskFiler?: () => Promise<void>;

  /**
   * Idle-detection audit hook (Issue #2106).
   *
   * Invoked at the same gate as `runIdleTaskFiler` — i.e. only when
   * the Priority 2 scan returned `foundClaimableIssue === false`. The
   * audit emits per-repo `[idle-detect] ...` lines and a per-tick
   * summary so operators can verify the scan's verdict against an
   * independent probe and so concurrent multi-host idle declarations
   * are visible (each line is tagged with `host=<hostname>:<pid>`).
   *
   * `tick` is a monotonic counter incremented by the loop on every
   * iteration, so log scrapers can correlate per-repo lines with the
   * summary. `scanFoundClaimable` is forwarded verbatim from
   * `tracker.foundClaimableIssue` so the audit can raise a
   * `mis_classification` alert when its own probe disagrees with the
   * scan loop.
   *
   * Best-effort — any throw is caught by the loop and logged so an
   * audit failure never aborts the main loop. Optional so test deps
   * can omit it.
   */
  runIdleDetectAudit?: (
    info: { tick: number; scanFoundClaimable: boolean },
  ) => Promise<{ claimableTotal: number } | void>;

  /**
   * Idle-decision claimable-work census hook (Issue #2811).
   *
   * Invoked at the same gate as `runIdleTaskFiler` — i.e. when the
   * Priority 2 scan returned `foundClaimableIssue === false` and the
   * worker is about to decide whether to file an idle-task. For every
   * monitored repo the census logs a single structured block recording
   * availability, the resolved `nice` tier, the counts of open unblocked
   * `top-priority`/`work-on`/`low-priority`/`idle-task` issues, and the
   * inversion signal (any repo holding unblocked priority work while an
   * idle-task is about to be filed/selected).
   *
   * Reads through the iteration-scoped `IssueCache`/`fetchAllIssues` so a
   * quiet cycle costs no extra issue-list call. Best-effort — any throw
   * is caught by the loop and logged so a census failure never aborts the
   * main loop. Optional so test deps can omit it.
   *
   * Issue #2813: the hook now returns `{ inversionDetected }` so the loop
   * can use the same cache-backed census to *suppress* the idle-task filer
   * when any monitored repo holds an open, unblocked
   * `top-priority`/`work-on`/`low-priority` issue — even one merely
   * *deferred* this cycle by `nice`/rotation/cooldown. A `void` return (or
   * a throw) is treated as "no inversion detected" so the filer still runs.
   *
   * Issue #437: `claimScanCompleted` states whether the Priority 2 scan
   * actually finished an eligibility pass this cycle — i.e. a scan returned
   * "no eligible work" — as opposed to stopping before its next claim for
   * the cycle deadline / claim-runway floor, a shutdown, or a pool drain.
   * Only a completed pass is evidence that the scan *refused* the census's
   * claimable work, so it gates the Issue #321 escalation (never the filer
   * suppression: work the scan did not reach is still work).
   *
   * Issue #460: `claimedRepos` names the repos the scan actually claimed
   * from this cycle. GRQ#4465 was filed against a repo the scan had claimed
   * from four minutes earlier, so "the claim scan keeps refusing this work"
   * was already false when it was written. A served repo never feeds the
   * escalation streak.
   */
  runIdleDecisionCensus?: (
    info: {
      decisionPoint: "filing" | "selection";
      claimScanCompleted: boolean;
      claimedRepos: readonly string[];
    },
  ) => Promise<{ inversionDetected: boolean } | void>;

  /**
   * Combined liveness-guard observation hook (Issue #2479, the wiring for
   * the #2478 guard that closes #2472).
   *
   * Invoked best-effort at the end of every loop cycle. The production
   * implementation delegates to `liveness_guard.checkLivenessWindow`,
   * which unions the #2476 productive-work signal with the #2477
   * idle-task-claim signal across the monitored fleet and emits a single
   * `[liveness] ALERT` once a dual-silent window exceeds the threshold.
   *
   * `tick` is a monotonic per-cycle counter so the production hook can
   * bound `gh` cost by only doing real work on a cadence boundary (the
   * exact unbounded-`gh` failure mode the Issue #2106 short-circuit
   * guards against). It is purely an observation call — it never mutates
   * dispatch or filer state.
   *
   * Best-effort — any throw is caught by the loop and logged so a guard
   * failure never aborts the main loop. Optional so test deps can omit it.
   */
  checkLivenessWindow?: (info: { tick: number }) => Promise<void>;

  /**
   * Per-cycle stale-assignment recovery scan (Issue #2672).
   *
   * Runs the GitHub-side recovery scans (`detectAssignedWithoutHeartbeat`
   * and `recoverStaleGithubAssignments`, including the cross-account
   * evidence rules from Issue #2671) on every scan cycle — not just at
   * worker start-up — so a leaked assignment is recovered within a cycle
   * rather than waiting for a worker restart.
   *
   * Reuses the iteration-scoped `IssueCache` / `fetchAllIssues` (Issue
   * #1787) so a quiet cycle adds no extra issue-list API call: whichever
   * of this scan and the Priority 2 issue scan runs first populates the
   * shared `issues_all` cache and the other reads through it. Per-issue
   * lookups (marker comments, PR linkage) run only for candidates that
   * pass the cheap `updatedAt` threshold pre-check.
   *
   * Best-effort — any throw is caught and logged by the loop
   * (`Stale-assignment recovery failed (continuing): <msg>`) so a
   * recovery failure never aborts the scan loop. Quiet on a no-op: the
   * hook itself emits only the existing `[recovery-decision]` telemetry,
   * so a cycle that recovers nothing adds no extra log noise. Optional so
   * test deps can omit it.
   *
   * The start-up `recoverStuckIssues()` invocation is retained for local
   * `.heartbeat_*` crash cleanup (`detectAndRecoverStuckHeartbeats`).
   */
  recoverStaleAssignments?: () => Promise<void>;

  /**
   * Per-host scan-cursor hooks (Issue #2427).
   *
   * The cursor persists the priority level in flight when the dispatch loop
   * last advanced, so a rate-limit pause that resumes (or a quick worker
   * restart) re-enters the dispatch near where it stopped instead of always
   * restarting at Priority 1 and burning the freshly-refreshed quota.
   *
   * - `loadScanCursor` is read when the dispatch loop (re)starts — a fresh
   *   process and after each rate-limit resume.
   * - `saveScanCursor` is written as each priority is entered (cheap integer
   *   overwrite).
   * - `resetScanCursor` is written after a successful claim, so the next
   *   cycle starts at Priority 1.
   *
   * All three are best-effort: a throw is caught and logged, never aborting
   * the loop. Optional so test deps can omit them.
   */
  loadScanCursor?: () => Promise<ScanCursor | null>;
  saveScanCursor?: (priority: number) => Promise<void>;
  resetScanCursor?: () => Promise<void>;

  // Test hook — not used in production
  _callLog?: string[];
}

// ---------------------------------------------------------------------------
// Idle-task filer short-circuit bound (Issue #2475)
// ---------------------------------------------------------------------------

/**
 * Maximum number of *consecutive* audit/scan disagreement iterations the
 * idle-task filer may be short-circuited (Issue #2106 budget guard) before
 * a single filer attempt is forced through (Issue #2475).
 *
 * The #2106 guard skips the filer whenever the independent idle-detect
 * probe reports claimable work while the Priority-2 scan set
 * `foundClaimableIssue = false`, on the assumption the scan
 * mis-classified and the next iteration will pick the work up. A
 * *persistent* disagreement, however, would suppress every wrapper
 * indefinitely. Once the consecutive-disagreement streak exceeds this
 * bound the loop allows exactly ONE filer attempt and resets the streak,
 * so a durable disagreement still produces wrappers without
 * re-introducing the wrapper flooding the #2106 guard prevents.
 */
export const AUDIT_DISAGREEMENT_SKIP_LIMIT = 3;

// ---------------------------------------------------------------------------
// Liveness-guard cadence (Issue #2479)
// ---------------------------------------------------------------------------

/**
 * Run the liveness guard once every N loop cycles rather than every cycle.
 *
 * The guard makes roughly `2 × repos` `gh` calls (one productive-work probe
 * and one idle-task-activity probe per monitored repo), so invoking it every
 * cycle would multiply the loop's `gh` cost — the exact unbounded-`gh`
 * failure mode the Issue #2106 short-circuit guards against. At the default
 * ~30s cycle this cadence runs the guard about once every ten minutes, which
 * is far finer than the 8-hour stall threshold it watches for, so detection
 * latency is unaffected. The guard fires on the first cycle (`tick === 1`)
 * and every `LIVENESS_CHECK_CADENCE` cycles thereafter.
 */
export const LIVENESS_CHECK_CADENCE = 20;

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

/**
 * Create a default RunCoreConfig with sensible operational values.
 */
export function createDefaultRunCoreConfig(): RunCoreConfig {
  return {
    runDurationSeconds: 3600,
    sleepInterval: 30,
    maxConcurrentIssues: 1,
    maxConsecutiveFailures: 10,
    rateLimitBackoff: 300,
    // Issue #2473: conservative per-handler watchdog bounds. A single
    // Priority 1.x handler should never legitimately run for ten minutes,
    // so a hard timeout at 600s catches a genuine wedge without tripping
    // slow-but-healthy handlers; the 120s soft threshold surfaces slow
    // handlers in the logs first.
    handlerTimeoutSeconds: 600,
    handlerSoftTimeoutSeconds: 120,
    // Issue #62: mirrors `OPERATIONAL_DEFAULTS.planningTimeout` so Planning
    // Mode's watchdog floor tracks the agent timeout it wraps.
    planningTimeoutSeconds: OPERATIONAL_DEFAULTS.planningTimeout,
  };
}

// ---------------------------------------------------------------------------
// Work progress tracker
// ---------------------------------------------------------------------------

/**
 * Create a mutable progress tracker for the main loop.
 */
export function createWorkProgressTracker(): WorkProgressTracker {
  const tracker: WorkProgressTracker = {
    issuesProcessed: 0,
    scanHadSuccess: false,
    foundClaimableIssue: false,
    claimedRepos: new Set<string>(),
    recordClaim(repo: string) {
      // Issue #460: the claim, not its outcome. A repo the scan served is
      // not a repo the scan refused, however the run ended.
      tracker.claimedRepos.add(repo);
    },
    recordSuccess() {
      tracker.issuesProcessed++;
      tracker.scanHadSuccess = true;
      // Issue #2048: only the Priority 2 success path flips the narrow
      // "found a claimable issue" flag used to gate the idle-task filer.
      tracker.foundClaimableIssue = true;
    },
    resetScanProgress() {
      tracker.scanHadSuccess = false;
      tracker.foundClaimableIssue = false;
      tracker.claimedRepos.clear();
    },
  };
  return tracker;
}

// ---------------------------------------------------------------------------
// Sleep with jitter
// ---------------------------------------------------------------------------

/**
 * Calculate a sleep duration with ±25% random jitter.
 *
 * @param baseSeconds - Base sleep interval in seconds
 * @returns Jittered duration in seconds
 */
export function sleepWithJitter(baseSeconds: number): number {
  if (baseSeconds <= 0) return 0;
  const jitterRange = baseSeconds * 0.25;
  const jitter = (Math.random() * 2 - 1) * jitterRange;
  return Math.round(baseSeconds + jitter);
}

// ---------------------------------------------------------------------------
// Priority dispatch table
// ---------------------------------------------------------------------------

/**
 * Build the priority dispatch table from dependencies.
 *
 * Each entry maps a priority level to its handler function. Entries are
 * returned sorted by ascending priority (lowest number = highest priority).
 *
 * Repo `nice` scope (Issue #2776, part of #2771): the Priority 1–1.9 handlers
 * below maintain the worker's **already-in-flight** work — PR feedback, CI
 * fixes, branch updates, auto-merge, refinement, etc. — and intentionally do
 * **not** consult the operator-side repo `nice` resolver (`getRepoNice`).
 * `nice` gates only **new-work** selection (the Priority 2 cross-repo scan in
 * `find_oldest_issue.ts`, plus the planning and label scans — Issues #2774,
 * #2775). An open PR in a high-`nice` (deprioritised) repo must still be
 * serviced here so it does not rot; deprioritising a repo slows down picking up
 * *new* work there, never the upkeep of work already started. Regression test:
 * `tests/run_core_nice_scope_test.ts`.
 */
export function buildPriorityDispatchTable(
  deps: RunCoreDeps,
  shouldShutdown: () => boolean = () => false,
  config: RunCoreConfig = createDefaultRunCoreConfig(),
): PriorityHandler[] {
  const table: PriorityHandler[] = [
    {
      priority: 1,
      name: "PR Feedback",
      agentBacked: true,
      maintenanceLane: true,
      execute: deps.findAndProcessPrFeedback,
    },
    {
      priority: 1.5,
      name: "Spelling Fix",
      agentBacked: true,
      maintenanceLane: true,
      execute: deps.findAndProcessSpellingFailure,
    },
    {
      priority: 1.55,
      name: "CI Fix",
      agentBacked: true,
      maintenanceLane: true,
      execute: deps.findAndProcessCiFailure,
    },
    {
      priority: 1.6,
      name: "Update PR Branches",
      execute: () =>
        deps.updateOpenPrBranches().then((r) =>
          r.ok
            ? { ok: true as const, value: { processed: false } }
            : { ok: false as const, error: r.error }
        ),
    },
    {
      // Issue #84: the receiver for the hand-off Issue #4373 defers to.
      // The branch updater above detects a CONFLICTING PR and leaves it
      // untouched rather than side-picking; this priority merges the base
      // in for real. It runs before the CI nudge so a conflicting PR is
      // resolved rather than poked — GitHub runs no checks on a PR whose
      // merge commit it cannot build.
      priority: 1.61,
      name: "Resolve PR Merge Conflicts",
      agentBacked: true,
      maintenanceLane: true,
      execute: () =>
        deps.findAndProcessMergeConflict?.() ??
          Promise.resolve({
            ok: true as const,
            value: { processed: false },
          }),
    },
    {
      // Issue #2100: nudge CI on Vibe Coder PRs idle >5 min between
      // "Update PR Branches" and "Auto-Merge". Never claims an issue;
      // always returns `processed: false` so the dispatch keeps going.
      priority: 1.62,
      name: "Nudge Stalled CI",
      execute: () =>
        deps.nudgeStalledCi().then((r) =>
          r.ok
            ? { ok: true as const, value: { processed: false } }
            : { ok: false as const, error: r.error }
        ),
    },
    {
      // Issue #4025: backstop watchdog over PRs that block `work-on`
      // issues. Detects and escalates only — the fix routes stay with
      // the CI-fix and PR-feedback priorities above. Never claims an
      // issue, so it always returns `processed: false`.
      priority: 1.63,
      name: "Blocking PR Stall Watchdog",
      execute: () =>
        (deps.scanBlockingPrStalls?.() ??
          Promise.resolve({ ok: true as const, value: undefined })).then((r) =>
            r.ok
              ? { ok: true as const, value: { processed: false } }
              : { ok: false as const, error: r.error }
          ),
    },
    {
      priority: 1.65,
      name: "Auto-Merge",
      execute: () =>
        deps.ensureAutoMerge().then((r) =>
          r.ok
            ? { ok: true as const, value: { processed: false } }
            : { ok: false as const, error: r.error }
        ),
    },
    // Branch cleanup runs once at initialisation, not every cycle
    {
      priority: 1.67,
      name: "Close Issues for Merged PRs",
      execute: () =>
        deps.closeIssuesForMergedPrs().then((r) =>
          r.ok
            ? { ok: true as const, value: { processed: false } }
            : { ok: false as const, error: r.error }
        ),
    },
    {
      priority: 1.68,
      name: "Recover Assigned with Closed PRs",
      execute: () =>
        deps.recoverAssignedWithClosedPr().then((r) =>
          r.ok
            ? { ok: true as const, value: { processed: false } }
            : { ok: false as const, error: r.error }
        ),
    },
    {
      priority: 1.7,
      name: "Milestone Completions",
      execute: () =>
        deps.checkMilestoneCompletions().then((r) =>
          r.ok
            ? { ok: true as const, value: { processed: false } }
            : { ok: false as const, error: r.error }
        ),
    },
    {
      priority: 1.72,
      name: "Milestone Branch Sync",
      execute: () =>
        deps.syncMilestoneBranches().then((r) =>
          r.ok
            ? { ok: true as const, value: { processed: false } }
            : { ok: false as const, error: r.error }
        ),
    },
    {
      priority: 1.75,
      name: "Issue Refinement",
      agentBacked: true,
      execute: deps.findAndProcessRefinement,
    },
    {
      // Issue #1619: Grill-me runs before planning so a freshly-grilled
      // issue does not also enter planning in the same scan pass — the
      // single-issue progression is grill → transition → plan across runs.
      priority: 1.78,
      name: "Grill-Me Clarification",
      agentBacked: true,
      execute: deps.findAndProcessGrillMe,
    },
    {
      // Issue #4112: Quorum runs before planning — it decides *what the plan
      // is*, and planning then splits that plan into sub-issues.
      priority: 1.79,
      name: "Quorum Plan-Off",
      agentBacked: true,
      execute: () =>
        deps.findAndProcessQuorum?.() ??
          Promise.resolve({
            ok: true as const,
            value: { processed: false },
          }),
    },
    {
      priority: 1.80,
      name: "Planning Mode",
      agentBacked: true,
      // Issue #62: planning keeps working after its agent returns — the
      // Failure-Detection gate re-reads every published sub-issue and the
      // self-repair makes a Claude call per offender. The budget must cover
      // the planning agent's own timeout plus that tail, so it cannot
      // collapse onto the flat 600 s late in a cycle and kill the repair.
      agentFloorMs: agentHandlerFloorMs(
        config.planningTimeoutSeconds,
        PLANNING_TAIL_SECONDS,
      ),
      execute: deps.findAndProcessPlanning,
    },
    {
      // Issue #60: finishes the Failure-Detection repairs a partially-repaired
      // planning run left outstanding. Runs straight after Planning — it
      // consumes the `needs-failure-detection-repair` state Planning produces —
      // and is Claude-backed, so its watchdog follows the agent-backed bound.
      priority: 1.81,
      name: "Failure-Detection Repair Resume",
      agentBacked: true,
      execute: (opts) =>
        deps.resumeFailureDetectionRepairs?.(opts) ??
          Promise.resolve({
            ok: true as const,
            value: { processed: false },
          }),
    },
    {
      priority: 1.85,
      name: "Question Answering",
      agentBacked: true,
      execute: deps.findAndProcessQuestion,
    },
    {
      priority: 1.9,
      name: "Stale Workflow Detection",
      execute: () =>
        deps
          .scanStaleWorkflowIssues({ shouldShutdown })
          .then((r) =>
            r.ok
              ? { ok: true as const, value: { processed: false } }
              : { ok: false as const, error: r.error }
          ),
    },
    {
      priority: 2,
      name: "Issue Scanning",
      execute: () =>
        Promise.resolve({ ok: true as const, value: { processed: false } }),
    },
  ];

  // Sort by ascending priority (belt-and-suspenders — already in order)
  table.sort((a, b) => a.priority - b.priority);

  return table;
}

// ---------------------------------------------------------------------------
// Initialisation sequence
// ---------------------------------------------------------------------------

/**
 * Run the initialisation sequence before the main loop.
 *
 * @returns Result with error details if any step fails fatally
 */
async function runInitialisation(
  deps: RunCoreDeps,
): Promise<Result<void>> {
  // Git reset to clean state
  const gitResult = await deps.gitResetToOrigin();
  if (!gitResult.ok) {
    return {
      ok: false,
      error: new Error(`git reset failed: ${gitResult.error.message}`),
    };
  }

  // Logging setup
  await deps.setupLogging();

  // Dependency checks
  const depsResult = await deps.checkDependencies();
  if (!depsResult.ok) {
    return {
      ok: false,
      error: new Error(`dependency check failed: ${depsResult.error.message}`),
    };
  }

  // Non-fatal initialisation steps — best-effort
  try {
    await deps.checkSoftwareUpdates();
  } catch { /* best-effort */ }
  try {
    const diskResult = await deps.checkDiskSpace();
    if (!diskResult.ok) {
      deps.logError(`Disk space warning: ${diskResult.error.message}`);
    }
  } catch { /* best-effort */ }
  try {
    await deps.rotateLogFiles();
  } catch { /* best-effort */ }
  try {
    await deps.cleanupStaleTempFiles();
  } catch { /* best-effort */ }
  try {
    await deps.recoverStuckIssues();
  } catch { /* best-effort */ }
  try {
    await deps.cleanupStaleBranches();
  } catch { /* best-effort */ }
  try {
    await deps.cleanupMergedBranches();
  } catch { /* best-effort */ }
  try {
    await deps.checkFeatureAvailability();
  } catch { /* best-effort */ }

  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Priority 2 — Issue scanning inner loop
// ---------------------------------------------------------------------------

/**
 * Run the Priority 2 issue scanning inner loop.
 *
 * Implements scan continuation: after a failure, immediately tries the
 * next issue instead of sleeping. This prevents one repo's failures from
 * starving other repos.
 *
 * @returns Whether the scan had any success, and whether to exit the outer loop
 */
/**
 * Release the worker's claim on the just-processed issue (Issue #2670).
 *
 * Prefers the injected `releaseClaim` (unassign + clear heartbeat). Falls back
 * to the marker-only `clearHeartbeat()` for deps that predate the helper so
 * older test wirings keep working — production always supplies `releaseClaim`.
 */
async function releaseIssueClaim(
  deps: RunCoreDeps,
  repo: string,
  issueNumber: number,
  outcome?: RunOutcome,
): Promise<void> {
  // Log the resolved outcome kind (Issue #4325) so a worker-log grep tells
  // "outcome never computed" from "computed but not rendered".
  deps.log(
    `Releasing claim ${repo}#${issueNumber} — outcome ${
      describeRunOutcome(outcome)
    }`,
  );
  if (deps.releaseClaim) {
    await deps.releaseClaim(repo, issueNumber, outcome);
  } else {
    await deps.clearHeartbeat();
  }
}

/**
 * Mark an issue as finished for the rest of this run (Issue #181).
 *
 * Called on every terminal outcome in both the serial loop and the pool. The
 * scan excludes what this registry holds, so a cached issue list that still
 * lists the issue — the list TTL is 600 s — cannot re-offer it seconds later.
 */
function noteIssueProcessed(
  deps: RunCoreDeps,
  issue: DiscoveredIssue,
  reason: ProcessedIssueReason,
): void {
  deps.processedIssues?.record(issue.repo, issue.issueNumber, reason);
}

/**
 * How many times in a row a scan may re-offer an issue this cycle already
 * deferred (Issue #245) before the loop stops looking.
 *
 * One re-offer is ordinary: two slots can judge the same candidate at once,
 * and the loser sees the winner's deferral a moment later. A scan that keeps
 * serving it is a wiring fault — the exclusion set is not reaching the finder
 * — and claiming it would repeat the same doomed decision forever, so the
 * loop says so and stops rather than spinning silently.
 */
const MAX_DEFERRED_REOFFERS = 3;

/**
 * Adaptive claim floor (Issue #245): should this candidate be left for a
 * cycle that can host a real execute?
 *
 * The plain floor (#4304/#47) knows nothing about the issue; this one reads
 * what the issue already carries — preserved WIP, a prior `timeout` in
 * `execute`, a long-job size label — and refuses a slice that such an issue
 * cannot finish. Deferring records the issue so the next scan offers a
 * *different* candidate (the #219 rule: never park the slot), and logs the
 * reason once, the first and only time the issue is deferred this cycle.
 *
 * Returns false — claim as before — whenever the gate cannot decide: no
 * evidence lookup wired, no execute budget known, or a lookup that failed
 * (which is logged as an error, never swallowed).
 *
 * Issue #375: the deferral is **bounded**. On a host whose cycle can never
 * offer the floor's required runway (cycle length == `claude_timeout`, where a
 * claim gate is first reached twenty minutes in), the floor refused the same
 * issue every cycle for ever while wording it "leaving it for the next cycle".
 * After {@link ADAPTIVE_FLOOR_STARVATION_LIMIT} consecutive deferred cycles the
 * floor yields: the claim proceeds deadline-bound and WIP preservation carries
 * the progress, which is the regime Issue #47 already documents for this host.
 */
async function deferClaimForAdaptiveFloor(
  deps: RunCoreDeps,
  config: RunCoreConfig,
  issue: DiscoveredIssue,
  endTime: number,
  deferredClaims: Set<string>,
  log: (message: string) => void,
): Promise<boolean> {
  const budgetSeconds = deps.executeBudgetSeconds ?? 0;
  if (!deps.gatherIssueClaimEvidence || budgetSeconds <= 0) return false;

  const { evidence, lookupError } = await deps.gatherIssueClaimEvidence(issue);
  if (lookupError !== undefined) {
    deps.logError(
      `Claim-evidence lookup failed for ${issue.repo}#${issue.issueNumber}: ` +
        `${lookupError} — claiming on the plain runway floor alone ` +
        `(Issue #245).`,
    );
    return false;
  }

  const remainingRunwaySeconds = Math.max(
    0,
    Math.round((endTime - deps.now()) / 1000),
  );
  const decision = decideAdaptiveClaim({
    evidence,
    remainingRunwaySeconds,
    fullExecuteBudgetSeconds: budgetSeconds,
    cycleSeconds: config.runDurationSeconds,
  });
  const key = issueClaimKey(issue.repo, issue.issueNumber);
  if (decision.claim) {
    // The floor no longer defers this issue, so its starvation streak ends.
    await deps.clearAdaptiveFloorDeferral?.(key);
    return false;
  }

  // Issue #375: how long has the floor been refusing this issue?
  const deferredCycles = await deps.recordAdaptiveFloorDeferral?.(key) ?? 0;
  const limit = deps.adaptiveFloorStarvationLimit ??
    ADAPTIVE_FLOOR_STARVATION_LIMIT;
  if (deferredCycles >= limit) {
    log(
      formatAdaptiveFloorStarvation({
        key,
        consecutiveCycles: deferredCycles,
        limit,
        remainingRunwaySeconds,
        requiredRunwaySeconds: decision.requiredRunwaySeconds,
      }),
    );
    await deps.clearAdaptiveFloorDeferral?.(key);
    return false;
  }

  deferredClaims.add(key);
  const streak = deferredCycles > 0
    ? ` [deferred cycle ${deferredCycles} of ${limit}]`
    : "";
  log(`${issue.repo}#${issue.issueNumber} ${decision.reason}${streak}`);
  return true;
}

/**
 * Priority 2 issue-scanning inner loop.
 *
 * Issue #3648: the loop used to take `_config` (unused) and had no view of the
 * cycle deadline honoured by the outer loop, so on the failure path — which
 * `continue`s straight into the next issue with no sleep — it could keep
 * claiming and fully billing runs of up to `runDurationSeconds` each, long
 * past the planned shutdown time. It was bounded only by
 * `shouldExitOnFailures()` at 10 consecutive failures.
 *
 * Two guards close that: the `endTime` deadline is re-checked before every
 * *continuation* (matching the outer loop's own `while (now < endTime)`
 * semantics — the first pass is already in time by construction), and a run of
 * consecutive failures backs off for `sleepInterval` before the next claim. An
 * isolated failure still continues immediately, so normal scan throughput is
 * unchanged.
 *
 * @param config - Run configuration (supplies the failure back-off interval)
 * @param deps - Injected dependencies
 * @param tracker - Work progress tracker
 * @param endTime - Epoch-millisecond deadline for the current cycle
 */
async function runIssueScanLoop(
  config: RunCoreConfig,
  deps: RunCoreDeps,
  tracker: WorkProgressTracker,
  endTime: number,
  shouldShutdown: () => boolean = () => false,
): Promise<
  {
    exitOuterLoop: boolean;
    spendCeilingReached?: boolean;
    hostDiskLow?: boolean;
    workVolumeFaulted?: boolean;
    /**
     * Whether a scan completed an eligibility pass — `findNextIssue`
     * returned `null` after considering the backlog (Issue #437). `false`
     * means the loop stopped before its next claim (deadline, runway floor,
     * shutdown, drain) without ever evaluating the work, so nothing refused
     * it and the idle-inversion escalation must not fire.
     */
    eligibilityScanCompleted?: boolean;
  }
> {
  // Concurrent slots (Issue #4177, part of #4168): above one slot the pool
  // takes over. At the default of 1 the serial loop below runs unchanged —
  // exactly today's call sequence, including its shutdown timing (Issue
  // #4182 keeps single-slot behaviour byte-for-byte).
  if (config.maxConcurrentIssues > 1) {
    return await runIssueScanPool(
      config,
      deps,
      tracker,
      endTime,
      shouldShutdown,
    );
  }
  await deps.resetRepoFailures();

  /** Consecutive failures within this scan loop, for the back-off. */
  let consecutiveFailures = 0;
  let iteration = 0;

  // Claim-runway floor for this cycle (Issue #4304, raised to the full
  // execute budget by Issue #47 when the cycle can fit one). Resolved once;
  // applied before every claim below.
  const runwayFloor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: deps.minClaimRunwaySeconds ?? 0,
    fullExecuteBudgetSeconds: deps.fullExecuteBudgetSeconds,
    cycleSeconds: config.runDurationSeconds,
  });
  if (runwayFloor.exceptionReason) {
    deps.log(`Claim-runway floor: ${runwayFloor.exceptionReason}`);
  }
  // Issues this cycle deferred for the adaptive floor (Issue #245), so the
  // next scan offers a different candidate rather than the same one.
  const deferredClaims = new Set<string>();
  /** Consecutive scans that re-offered an already-deferred issue. */
  let reofferedDeferred = 0;
  /**
   * Set once a scan has considered the whole backlog and come up empty
   * (Issue #437) — the only state in which "the claim scan refused this
   * work" is a claim the idle-inversion escalation may make.
   */
  let eligibilityScanCompleted = false;

  while (true) {
    // Deadline gate (Issue #3648): never claim another billed issue run once
    // the cycle's planned shutdown time has passed. Skipped on the first pass,
    // which the outer loop has already gated on the same deadline.
    // Minimum-runway floor (Issue #4304): a claim with less runway than any
    // plausible completion time is doomed on arrival, so it is not taken —
    // the tail of the cycle goes to cheap maintenance instead. Issue #47
    // raises the floor to the full execute budget when the cycle can fit one,
    // so a deadline-bound execute is a documented exception, not the default
    // tail of every cycle.
    const minRunwayMs = runwayFloor.floorSeconds * 1000;
    const pastDeadline = iteration > 0 && deps.now() >= endTime;
    // The floor applies on EVERY pass, including the outer loop's re-entry
    // after a success — that re-entry is exactly where a doomed late claim
    // used to be taken. At a fresh cycle start the floor is trivially met.
    const belowFloor = minRunwayMs > 0 && deps.now() + minRunwayMs >= endTime;
    if (pastDeadline || belowFloor) {
      const remainingSeconds = Math.max(
        0,
        Math.round((endTime - deps.now()) / 1000),
      );
      deps.log(
        !pastDeadline
          ? `Issue scan loop stopping before the next claim: ${remainingSeconds}s ` +
            `of cycle runway left, below the ${runwayFloor.floorSeconds}s ` +
            (runwayFloor.fullBudgetGate
              ? `claim floor — the full ${runwayFloor.floorSeconds}s execute ` +
                `budget no longer fits this cycle (Issue #47).`
              : `claim floor (Issue #4304).`)
          : "Issue scan loop reached the cycle deadline — stopping before the next claim.",
      );
      break;
    }
    iteration++;

    // Find next issue
    const findResult = await deps.findNextIssue({
      excludeIssues: deferredClaims,
    });
    if (!findResult.ok) {
      // Rate limit or error during find
      deps.logError(`Issue scanning error: ${findResult.error.message}`);
      break;
    }

    const issue = findResult.value;
    if (issue === null) {
      // No more issues — the backlog was evaluated and refused (Issue #437).
      eligibilityScanCompleted = true;
      break;
    }

    // Adaptive claim floor (Issue #245): an issue already known to be a long
    // job is left for a cycle that can host a real execute, and the scan
    // moves on to the next candidate rather than parking the loop.
    if (deferredClaims.has(issueClaimKey(issue.repo, issue.issueNumber))) {
      reofferedDeferred++;
      if (reofferedDeferred > MAX_DEFERRED_REOFFERS) {
        deps.logError(
          `Issue scan loop stopping: the scan re-offered deferred issue ` +
            `${issue.repo}#${issue.issueNumber} ${reofferedDeferred} times, ` +
            `so the adaptive claim floor (Issue #245) cannot advance to ` +
            `another candidate.`,
        );
        break;
      }
      await deps.sleep(Math.max(1, config.sleepInterval) * 1000);
      continue;
    }
    reofferedDeferred = 0;
    if (
      await deferClaimForAdaptiveFloor(
        deps,
        config,
        issue,
        endTime,
        deferredClaims,
        (message) => deps.log(message),
      )
    ) {
      continue;
    }

    // Issue #3138: stamp the worker build on the claim-time log line so an
    // outdated host is detectable and a duplicate-PR miss can be attributed
    // to the exact build that claimed the issue.
    deps.log(
      `Processing issue ${issue.repo}#${issue.issueNumber}: ${issue.issueTitle} ` +
        `[${formatBuildStamp(resolveWorkerBuildInfo())}]`,
    );
    await deps.setStatusWorking(`${issue.repo}#${issue.issueNumber}`);

    // Issue #3760: stop any heartbeat interval a previous claim's processor
    // failed to close before this claim reseeds the write-repo allowlist —
    // left running, the leaked interval's marker refreshes are refused
    // indefinitely and sibling hosts' stuck-detection can steal that issue.
    if (deps.sweepLeakedHeartbeats) {
      await deps.sweepLeakedHeartbeats();
    }

    // Issue #460: record the claim before the run, not after it. The
    // outcome does not change the fact that this repo was served.
    tracker.recordClaim(issue.repo);
    // Process the issue
    const processResult = await deps.processIssue(issue, endTime);
    // The run outcome (Issue #4325) rides the claim release so the comment
    // states what happened; absent when the run never ran (skip).
    const runOutcome = processResult.ok
      ? processResult.value.outcome
      : undefined;

    if (processResult.ok && processResult.value.success) {
      // Success path
      noteIssueProcessed(deps, issue, "success");
      tracker.recordSuccess();
      // Issue #2427: a successful claim resets the scan cursor to the
      // start-of-cycle position so the next cycle dispatches from
      // Priority 1. Best-effort — a failure here must not abort the loop.
      if (deps.resetScanCursor) {
        try {
          await deps.resetScanCursor();
        } catch (cursorErr) {
          deps.log(
            `Scan cursor reset failed (continuing): ${
              cursorErr instanceof Error ? cursorErr.message : String(cursorErr)
            }`,
          );
        }
      }
      await deps.resetFailures();
      await deps.setStatusSuccess();
      await deps.recordRepoSuccess(issue.repo);
      // Issue #2670: release the claim (unassign + clear heartbeat) so a
      // completed issue is never left assigned to the worker.
      await releaseIssueClaim(
        deps,
        issue.repo,
        issue.issueNumber,
        runOutcome,
      );
      deps.log(`Successfully processed ${issue.repo}#${issue.issueNumber}`);
      break; // Exit inner loop, earn normal sleep
    }

    // Skip path — issue was not available (claim rejected, already assigned)
    // Record cooldown so findNextIssue doesn't return the same issue, but
    // don't track as a failure (no circuit breaker / repo failure impact).
    const skipped = processResult.ok && processResult.value.skipped;
    if (skipped) {
      noteIssueProcessed(deps, issue, "skip");
      await deps.recordIssueCooldown(issue.repo, issue.issueNumber);
      // Issue #2670: release any claim taken before the skip. Removing only
      // the worker's own assignment is a no-op when the claim was rejected,
      // so this never disturbs another worker holding the issue.
      await releaseIssueClaim(deps, issue.repo, issue.issueNumber);
      continue;
    }

    // Failure path (detailed reason already logged by processIssue).
    // Timeout-class failures feed the escalating cooldown (Issue #4304) so
    // the same doomed issue cannot burn consecutive hourly cycles.
    noteIssueProcessed(deps, issue, "failure");
    await deps.recordIssueCooldown(
      issue.repo,
      issue.issueNumber,
      processResult.ok ? processResult.value.failureKind : undefined,
    );
    await deps.trackFailure(`issue|${issue.repo}|${issue.issueNumber}`);
    await deps.setStatusFailure();
    await deps.recordRepoFailure(issue.repo, issue.issueNumber);

    // Check exit threshold
    const shouldExit = await deps.shouldExitOnFailures();
    if (shouldExit) {
      return { exitOuterLoop: true, eligibilityScanCompleted };
    }

    // Issue #2670 (root cause of incident #2648): the failure path used to
    // call `clearHeartbeat()` only, which invalidated the marker but left the
    // issue assigned to the worker, blocking all future pickup. Release the
    // full claim (unassign + clear heartbeat) instead.
    await releaseIssueClaim(
      deps,
      issue.repo,
      issue.issueNumber,
      runOutcome,
    );

    // Scan continuation (Issue #3648): the failure path used to `continue`
    // with no sleep, so a systematically failing repo was re-attempted
    // immediately — each attempt a fully billed run. Back off once failures
    // become consecutive; a single isolated failure still continues straight
    // to the next issue so normal throughput is unaffected.
    consecutiveFailures++;

    // Auth-outage breaker (Issue #4167): after two consecutive claim
    // failures, one fresh (uncached) auth probe decides whether the
    // credential died mid-cycle. Dead credential → one loud line and stop
    // claiming; the next cycle's health gate re-checks, so recovery is
    // automatic once auth returns. A healthy probe costs a few seconds on
    // an already-failing streak and the loop continues unchanged.
    if (consecutiveFailures >= 2 && deps.recheckAgentAuth) {
      const probe = await deps.recheckAgentAuth();
      if (probe.authFailed) {
        deps.logError(
          `ACTION REQUIRED: agent credential is failing (fresh auth probe ` +
            `after ${consecutiveFailures} consecutive claim failures)` +
            (probe.message ? ` — ${probe.message}` : "") +
            `. Stopping claims for this cycle; the next cycle's health ` +
            `gate re-checks automatically.`,
        );
        return { exitOuterLoop: true, eligibilityScanCompleted };
      }
    }

    const backoffMs = Math.max(0, config.sleepInterval) * 1000;
    if (consecutiveFailures >= 2 && backoffMs > 0) {
      deps.log(
        `${consecutiveFailures} consecutive issue failures — backing off ${
          backoffMs / 1000
        }s before the next claim.`,
      );
      await deps.sleep(backoffMs);
    }
    continue;
  }

  return { exitOuterLoop: false, eligibilityScanCompleted };
}

// ---------------------------------------------------------------------------
// Concurrent issue slots (Issue #4177, part of #4168)
// ---------------------------------------------------------------------------

/**
 * Pool-wide state shared by every slot. Deno is single-threaded, so the
 * counters here are only ever mutated between awaits — no lost updates —
 * but the *policy* is deliberately pool-wide: N slots must not multiply
 * the failure budget, and a stop signal from any slot stops them all.
 */
/** Detect the primary GitHub rate-limit message variants we treat as
 *  self-healing (Issue #1523, #1780, #42). Single-sourced in
 *  `primary_quota_latch.ts` so the chokepoint latch and the cycle loop pause
 *  on exactly the same signal; re-exported here for existing importers. */
export { isPrimaryRateLimitMessage };

/** Grace past the cycle deadline for an agent-backed handler's watchdog (Issue #4369). */
export const AGENT_HANDLER_GRACE_MS = 5 * 60 * 1000;

/**
 * Allowance in seconds for Planning Mode's **post-agent tail** (Issue #62).
 *
 * Planning does not finish when its agent returns: the Failure-Detection gate
 * re-reads every published sub-issue over the network, and the model-driven
 * self-repair then costs roughly one ~20 s Claude call per offending
 * sub-issue. Ten minutes covers a gate sweep plus a repair across a large
 * plan's fan-out (~25 sub-issues) — beyond that the watchdog should still
 * fire. Observed on GRQ-validation#835: planning ~5 min, repair ~18 s × 8
 * ≈ 2.5 min, abandoned by the 600 s floor with the repair 6/8 done.
 */
export const PLANNING_TAIL_SECONDS = 600;

/**
 * The floor a handler's watchdog budget may never drop below (Issue #62): the
 * timeout of the agent the handler wraps plus the allowance for the work it
 * does after that agent returns.
 *
 * The invariant this establishes is that a handler budget can never be smaller
 * than the agent timeout it is meant to contain. Before this, Planning Mode's
 * budget fell back to the flat `handlerTimeoutSeconds` (600 s) late in a cycle
 * — one third of planning's own 1800 s agent timeout — and the watchdog
 * abandoned the handler mid-repair.
 */
export function agentHandlerFloorMs(
  agentTimeoutSeconds: number,
  postAgentTailSeconds: number,
): number {
  return Math.max(0, agentTimeoutSeconds + postAgentTailSeconds) * 1000;
}

/**
 * The watchdog's hard timeout for one handler (Issue #4369): the flat
 * `handlerTimeoutSeconds` for a non-agent handler; for an agent-backed one,
 * at least that but otherwise the time left in the cycle plus a grace, so a
 * legitimately long agent run is never abandoned mid-flight while the cycle
 * still has room.
 *
 * `agentFloorMs` (Issue #62) raises that lower bound for an agent-backed
 * handler that declares one — `agentHandlerFloorMs()` of the agent timeout it
 * wraps plus its post-agent tail. Late in a cycle `endTime - now` is small and
 * the budget used to collapse onto the flat 600 s, which is smaller than the
 * agent timeout being wrapped. Non-agent handlers are unaffected: they keep
 * exactly the flat budget.
 */
export function handlerHardTimeoutMs(
  handlerTimeoutSeconds: number,
  agentBacked: boolean,
  endTime: number,
  now: number,
  agentFloorMs = 0,
): number {
  const flat = handlerTimeoutSeconds * 1000;
  if (!agentBacked) return flat;
  return Math.max(flat, agentFloorMs, endTime - now + AGENT_HANDLER_GRACE_MS);
}

/**
 * Dispatch one Priority-1.x handler: watchdog, `gh`-call attribution, wall
 * time, and error classification.
 *
 * Extracted by Issue #213 so the serial ladder and the concurrent
 * maintenance lane run a handler in exactly the same way — a lane that
 * dropped the watchdog, the telemetry or the rate-limit classification would
 * be a second, quietly divergent dispatcher.
 *
 * Never throws: a primary rate limit comes back as `rate-limit-error` so the
 * caller decides whether to re-throw (serial) or carry it out of the lane.
 *
 * @param handler - The dispatch-table entry to run.
 * @param config - Run configuration (watchdog budgets).
 * @param deps - Injected dependencies.
 * @param tracker - Work progress tracker; a processed handler flips it.
 * @param endTime - Epoch-millisecond deadline for the current cycle.
 * @param logPrefix - Prepended to this handler's own log lines, e.g. `[m1] `.
 */
async function executePriorityHandler(
  handler: PriorityHandler,
  config: RunCoreConfig,
  deps: RunCoreDeps,
  tracker: WorkProgressTracker,
  endTime: number,
  logPrefix = "",
): Promise<PriorityDispatchOutcome> {
  const handlerStartMs = deps.now();
  // Issue #1845: attribute this handler's `gh` calls to it. Async-scoped
  // (Issue #213) so the lane and the pool do not cross-credit each other.
  return await withPriorityContext(handler.name, async () => {
    try {
      deps.log(`${logPrefix}Priority ${handler.priority}: ${handler.name}`);
      // Issue #2473: bound the handler with a watchdog so a hung
      // `gh`/network call cannot freeze the whole dispatch loop. On a
      // hard timeout the loop logs a `[watchdog]` line and proceeds to
      // the next priority instead of awaiting forever. A rejection
      // (e.g. a primary rate-limit error) propagates unchanged to the
      // catch below, preserving the existing re-throw.
      // Agent-backed handlers (Issue #4369) are bounded by the cycle
      // deadline plus a grace, not the flat handler timeout: a CI-fix
      // or planning agent legitimately runs 10–60 min, and abandoning
      // it at 600 s left it running detached (observed live: it was
      // then SIGTERMed at run end, misread as a rate limit, and
      // relaunched after "Run complete").
      // Issue #62: a handler that keeps working after its agent
      // returns (planning's Failure-Detection gate and self-repair)
      // also carries a floor, so its budget is never smaller than the
      // agent timeout it wraps plus that tail's allowance.
      const dispatchNowMs = deps.now();
      const hardTimeoutMs = handlerHardTimeoutMs(
        config.handlerTimeoutSeconds,
        handler.agentBacked === true,
        endTime,
        dispatchNowMs,
        handler.agentFloorMs,
      );
      // Issue #58: hand the handler the instant the watchdog will
      // abandon it, derived from the very budget armed below so the
      // two cannot drift. A handler doing bounded post-work (the
      // Failure-Detection self-repair) stops cleanly and defers what it
      // cannot finish instead of being killed mid-way.
      const handlerDeadlineEpochMs = dispatchNowMs + hardTimeoutMs;
      const watch = await runWithWatchdog(
        () => handler.execute({ deadlineEpochMs: handlerDeadlineEpochMs }),
        {
          hardTimeoutMs,
          softTimeoutMs: config.handlerSoftTimeoutSeconds * 1000,
          now: deps.now,
          delay: deps.watchdogDelay ??
            ((ms) => new Promise((r) => setTimeout(r, ms))),
          onTimeout: () => {
            deps.logError(
              `${logPrefix}[watchdog] Priority ${handler.priority} (${handler.name}) ` +
                `exceeded hard timeout ${Math.round(hardTimeoutMs / 1000)}s ` +
                `— abandoning handler and continuing to next priority`,
            );
            // Nothing runs detached (Issue #4369): the agent the
            // abandoned handler spawned is terminated, and its retry
            // loop will not relaunch it.
            if (deps.terminateActiveAgentRuns) {
              // Issue #55: a handler abandonment is transient — clear
              // the terminating flag once its agents are dead so the
              // next priority can still launch its own agent.
              deps.terminateActiveAgentRuns(
                `handler ${handler.name} abandoned by the watchdog`,
                { keepTerminating: false },
              ).catch(() => {});
            }
          },
          onSoftWarning: (durationMs) =>
            deps.log(
              `${logPrefix}[watchdog] Priority ${handler.priority} (${handler.name}) ` +
                `slow: completed in ${Math.round(durationMs / 1000)}s ` +
                `(soft threshold ${config.handlerSoftTimeoutSeconds}s)`,
            ),
        },
      );
      if (watch.outcome === "timedout") {
        // Skip this handler this cycle; the caller advances to the next.
        return { kind: "completed" };
      }
      const result = watch.value!;
      if (result.ok && result.value) {
        const handlerResult = result.value as PriorityHandlerResult;
        if (handlerResult.processed) {
          tracker.scanHadSuccess = true;
        }
        if (handlerResult.rateLimited) {
          deps.log(`${logPrefix}Rate limit detected during ${handler.name}`);
          return { kind: "rate-limited" };
        }
      }
      return { kind: "completed" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Issue #1921: a thrown primary rate-limit error must
      // short-circuit the priority dispatch loop. Handed back so the
      // caller's rate-limit path owns the pause logic — without this,
      // each subsequent priority retries `gh` against an exhausted
      // quota and emits a noisy ERROR line per priority.
      if (isPrimaryRateLimitMessage(message)) {
        return {
          kind: "rate-limit-error",
          error: err instanceof Error ? err : new Error(message),
        };
      }
      deps.logError(
        `${logPrefix}Error in priority ${handler.priority} (${handler.name}): ${message}`,
      );
      return { kind: "completed" };
    } finally {
      // Issue #4299: wall time per priority, whatever the outcome.
      recordStepDuration(handler.name, deps.now() - handlerStartMs);
    }
  });
}

/**
 * Run the deferred agent-backed maintenance passes beside the issue-scan
 * pool (Issue #213).
 *
 * One pass at a time — the lane is a single extra agent alongside the N
 * issue slots, not another pool — and every pass leases the repository it
 * selects from `registry`, the pool's own in-flight registry. That lease is
 * what makes the concurrency safe: a slot and a maintenance pass otherwise
 * share the single `${WORK_DIR}/<repo>` clone, and `setupRepo` opens with
 * `reset --hard` + `clean -fd`.
 *
 * A shutdown bounds the lane exactly as it bounds the pool's drain: no new
 * pass starts once SIGTERM has landed, and a pass still running
 * `slotDrainGraceSeconds` after it is abandoned — its agent terminated —
 * rather than keeping the cycle's final await pending for the rest of the
 * hour.
 *
 * Never throws. A primary rate limit is returned so the caller can re-throw
 * it once the pool has drained too, exactly as the pool's own is.
 */
async function runMaintenanceLane(
  handlers: readonly PriorityHandler[],
  config: RunCoreConfig,
  deps: RunCoreDeps,
  tracker: WorkProgressTracker,
  endTime: number,
  registry: InFlightRepoRegistry,
  shouldShutdown: () => boolean,
): Promise<{ rateLimitError?: Error }> {
  const prefix = `[${MAINTENANCE_LANE_SLOT_ID}] `;
  const broker: MaintenanceLaneBroker = {
    // `maintenance: true` so nothing downstream mistakes the lane's hold for
    // a claimed issue — `ref` is a PR number, not an issue number.
    tryAcquire: (repo, ref) =>
      registry.tryAcquire(repo, ref, MAINTENANCE_LANE_SLOT_ID, {
        maintenance: true,
      }),
    release: (repo) => registry.release(repo),
  };
  deps.log(
    `${prefix}Maintenance lane: ${handlers.length} agent-backed pass(es) ` +
      `(${handlers.map((h) => h.name).join(", ")}) running beside the ` +
      `issue scan pool (Issue #213)`,
  );
  return await runInMaintenanceLane(broker, async () => {
    for (const handler of handlers) {
      // A shutdown stops the lane taking on more work, just as it stops a
      // slot claiming another issue.
      if (shouldShutdown()) {
        deps.log(
          `${prefix}stop reason=shutdown — ${handler.name} and any pass ` +
            `after it defer to the next run.`,
        );
        break;
      }
      // The lane never starts a pass past the cycle deadline: an
      // agent-backed watchdog budget is `endTime - now` plus a grace, so a
      // pass started late would run on borrowed time the drain must wait for.
      if (deps.now() >= endTime) {
        deps.log(
          `${prefix}stop reason=deadline — cycle deadline reached; ` +
            `${handler.name} and any pass after it defer to the next cycle.`,
        );
        break;
      }
      const dispatch = executePriorityHandler(
        handler,
        config,
        deps,
        tracker,
        endTime,
        prefix,
      );
      const bounded = await raceShutdownGrace(dispatch, deps, shouldShutdown);
      if (bounded.outcome === "abandoned") {
        // Loud, not silent: the pass is unfinished and its agent is killed.
        deps.logError(
          `${prefix}stop reason=shutdown — drain grace elapsed while ` +
            `${handler.name} was still running; abandoning the pass and ` +
            `terminating its agent. The PR is picked up again next run.`,
        );
        if (deps.terminateActiveAgentRuns) {
          await deps.terminateActiveAgentRuns(
            `maintenance lane pass ${handler.name} abandoned at shutdown`,
            { keepTerminating: true },
          ).catch(() => {});
        }
        break;
      }
      const outcome = bounded.value;
      if (outcome.kind === "rate-limit-error") {
        return { rateLimitError: outcome.error };
      }
      if (outcome.kind === "rate-limited") break;
    }
    return {};
  });
}

/**
 * Await `pass`, abandoning it once a shutdown request has outlived
 * `slotDrainGraceSeconds` (Issue #213).
 *
 * Mirrors `drainSlots`: the shutdown flag is polled on a short **real** timer
 * (the injected `sleep` is a fake clock in tests) while the grace itself is
 * measured on the injected clock, so a signal arriving mid-pass starts the
 * bounded grace from that moment.
 */
async function raceShutdownGrace<T>(
  pass: Promise<T>,
  deps: RunCoreDeps,
  shouldShutdown: () => boolean,
): Promise<{ outcome: "completed"; value: T } | { outcome: "abandoned" }> {
  const graceMs = Math.max(0, deps.slotDrainGraceSeconds ?? 300) * 1000;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = pass.then((value) => ({
    outcome: "completed" as const,
    value,
  }));
  const watch = (async () => {
    let shutdownAt: number | undefined;
    while (!settled) {
      if (shouldShutdown()) {
        const now = deps.now();
        if (shutdownAt === undefined) shutdownAt = now;
        if (now - shutdownAt >= graceMs) {
          return { outcome: "abandoned" as const };
        }
      }
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 50);
      });
    }
    return { outcome: "abandoned" as const };
  })();
  const result = await Promise.race([completed, watch]);
  settled = true;
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

interface SlotPoolState {
  /** Consecutive failures across the whole pool (drives the back-off). */
  consecutiveFailures: number;
  /** Set when any slot decides the outer loop must exit. */
  exitOuterLoop: boolean;
  /** Set when no slot may take another claim (deadline, breaker, exit). */
  draining: boolean;
  /** Repositories currently held by a slot (Issue #4176). */
  registry: InFlightRepoRegistry;
  /** Set when the pre-claim spend-ceiling gate tripped (Issue #4180). */
  spendCeilingReached: boolean;
  /** Set once the host-disk guard tripped, so it is logged once (Issue #226). */
  hostDiskLow?: boolean;
  /** Set once the work-volume fault guard tripped (Issue #229). */
  workVolumeFaulted?: boolean;
  /** SIGTERM/SIGINT seen (Issue #4182): no new claims; bounded drain. */
  shouldShutdown: () => boolean;
  /** Effective claim-runway floor for this cycle (Issues #4304, #47). */
  claimFloorSeconds: number;
  /**
   * Issues deferred this cycle by the adaptive floor (Issue #245), keyed
   * `owner/repo#number`. Pool-wide: an issue one slot judged too big for the
   * runway left is too big for its siblings too, and sharing the set keeps
   * the skip logged once per cycle rather than once per slot.
   */
  deferredClaims: Set<string>;
  /**
   * The primary rate-limit error a slot hit mid-run (Issue #4180). The pool
   * drains, then re-throws it so the cycle's existing pause-until-reset
   * path runs exactly as it does for the serial loop.
   */
  rateLimitError?: Error;
  /**
   * Set once any slot's scan considered the backlog and found nothing
   * eligible (Issue #437). A pool that only ever stopped on the deadline,
   * a shutdown or a drain leaves this `false` — it refused nothing, so the
   * idle-inversion escalation has no evidence to escalate.
   */
  eligibilityScanCompleted: boolean;
}

/**
 * The reasons a slot stops looking for work; a stop by any slot that is
 * pool-wide (`deadline`, `exit`) drains every other slot too.
 */
type SlotStop =
  | "deadline"
  | "no-work"
  | "find-error"
  | "exit"
  | "draining"
  | "shutdown";

/**
 * Run the Priority-2 issue scan as a pool of concurrent slots (Issue #4177).
 *
 * Each slot loops claim → process → release until the deadline, the
 * failure threshold, or no eligible work. What differs from the serial loop
 * is only what concurrency forces:
 *
 * - `findNextIssue` gets the set of repositories other slots hold (Issue
 *   #4176), so no two slots share a clone;
 * - the deadline / runway gate runs before EVERY claim in EVERY slot;
 * - the consecutive-failure back-off and `shouldExitOnFailures()` are
 *   pool-wide, so N slots cannot multiply the failure budget;
 * - `exitOuterLoop` from any slot drains the rest: running slots finish,
 *   no new claims;
 * - a slot that succeeds sleeps `sleepInterval` and claims again rather
 *   than retiring (Issue #178) — retiring parked it until every sibling
 *   drained, degrading two slots to one after the first completion;
 * - the pool is fully drained before this returns, so the serial
 *   priorities that follow never overlap with issue work.
 *
 * A slot that throws releases its repo and its claim in `finally` and does
 * not take its siblings down.
 */
async function runIssueScanPool(
  config: RunCoreConfig,
  deps: RunCoreDeps,
  tracker: WorkProgressTracker,
  endTime: number,
  shouldShutdown: () => boolean = () => false,
): Promise<
  {
    exitOuterLoop: boolean;
    spendCeilingReached: boolean;
    hostDiskLow: boolean;
    workVolumeFaulted: boolean;
    /** See the serial loop's field of the same name (Issue #437). */
    eligibilityScanCompleted: boolean;
  }
> {
  await deps.resetRepoFailures();
  // Claim-runway floor for this cycle (Issues #4304, #47) — resolved once,
  // applied by slotShouldStop before every claim in every slot.
  const poolRunwayFloor = resolveClaimRunwayFloor({
    minClaimRunwaySeconds: deps.minClaimRunwaySeconds ?? 0,
    fullExecuteBudgetSeconds: deps.fullExecuteBudgetSeconds,
    cycleSeconds: config.runDurationSeconds,
  });
  if (poolRunwayFloor.exceptionReason) {
    deps.log(`Claim-runway floor: ${poolRunwayFloor.exceptionReason}`);
  }
  const pool: SlotPoolState = {
    consecutiveFailures: 0,
    exitOuterLoop: false,
    draining: false,
    registry: deps.inFlightRepos ?? new InFlightRepoRegistry(),
    spendCeilingReached: false,
    shouldShutdown,
    claimFloorSeconds: poolRunwayFloor.floorSeconds,
    deferredClaims: new Set<string>(),
    eligibilityScanCompleted: false,
  };
  // Effective slots = min(configured, memory-pressure ceiling) (Issue
  // #4179): under pressure the pool STARTS fewer slots; it never cancels
  // one that is running.
  const configured = Math.max(1, config.maxConcurrentIssues);
  const slotCount = Math.max(
    1,
    Math.min(configured, await effectiveSlotCeiling(deps, configured)),
  );
  deps.log(
    `Issue scan pool: ${slotCount} concurrent slot(s)` +
      (slotCount < configured ? ` of ${configured} configured` : "") +
      " (Issue #4177)",
  );

  const slots: Promise<void>[] = [];
  for (let i = 0; i < slotCount; i++) {
    slots.push(runSlot(i, config, deps, tracker, endTime, pool));
  }
  await drainSlots(slots, deps, pool);
  // Every slot is drained; now surface the primary rate limit one of them
  // hit so the cycle pauses until reset (Issue #4180) — the same path the
  // serial loop's throw takes.
  if (pool.rateLimitError) throw pool.rateLimitError;
  return {
    exitOuterLoop: pool.exitOuterLoop,
    spendCeilingReached: pool.spendCeilingReached,
    hostDiskLow: pool.hostDiskLow === true,
    workVolumeFaulted: pool.workVolumeFaulted === true,
    eligibilityScanCompleted: pool.eligibilityScanCompleted,
  };
}

/**
 * Wait for every slot to finish (Issue #4182). A deadline or ordinary drain
 * waits as long as it takes — a slot that started before the deadline
 * completes (or is cancelled by its own run-time bound), never truncated
 * mid-write. A SHUTDOWN request bounds the wait: after
 * `slotDrainGraceSeconds` the still-running slots are abandoned, every
 * outstanding claim they hold is released so no issue stays assigned to a
 * dead worker, and the pool returns so the exit cleanup can terminate the
 * abandoned agent subprocesses.
 */
async function drainSlots(
  slots: Promise<void>[],
  deps: RunCoreDeps,
  pool: SlotPoolState,
): Promise<void> {
  const all = Promise.all(slots).then(() => "drained" as const);
  const graceMs = Math.max(0, deps.slotDrainGraceSeconds ?? 300) * 1000;
  // Watch for the shutdown flag on a short REAL timer (not the injected
  // sleep, which tests use as a fake clock) and measure the grace on the
  // injected clock, so a signal that arrives mid-drain starts the bounded
  // grace from that moment.
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () =>
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 50);
    });
  const watch = (async () => {
    let shutdownAt: number | undefined;
    while (!settled) {
      const now = deps.now();
      if (pool.shouldShutdown()) {
        if (shutdownAt === undefined) {
          shutdownAt = now;
          pool.draining = true;
          // Name every in-flight run with the deadline it is working to
          // (Issue #4297): a progress-extended run is drained like any
          // other, and the operator can see why it is still running.
          // Slot holds only (Issue #213) — the drain waits on slots; the
          // maintenance lane is awaited by the cycle, not by this grace.
          const live = pool.registry.slotHolds();
          deps.log(
            `Shutdown requested — draining ${live.length} in-flight slot(s), grace ${
              graceMs / 1000
            }s (Issue #4182)` +
              (live.length > 0
                ? `: ${
                  live.map((h) => formatInFlightHold(h, Date.now())).join(", ")
                }`
                : ""),
          );
        }
        if (now - shutdownAt >= graceMs) return "grace-elapsed" as const;
      }
      await tick();
    }
    return "drained" as const;
  })();
  const outcome = await Promise.race([all, watch]);
  settled = true;
  if (timer !== undefined) clearTimeout(timer);
  if (outcome === "grace-elapsed") {
    // Slot holds only (Issue #213): the maintenance lane's hold is a PR, not
    // a claim to release, and the lane frees its own lease in a `finally`.
    const abandoned = pool.registry.slotHolds();
    deps.logError(
      `Shutdown grace elapsed with ${abandoned.length} slot(s) still running — ` +
        `releasing their claims and abandoning the runs: ${
          abandoned.map((h) => formatInFlightHold(h, Date.now())).join(", ")
        }`,
    );
    for (const hold of abandoned) {
      // The abandoned run's release states why (Issue #4330).
      await releaseIssueClaim(
        deps,
        hold.repo,
        hold.issueNumber,
        deriveRunOutcome({
          success: false,
          phase: "shutdown",
          reason: `Run abandoned: shutdown grace (${
            graceMs / 1000
          }s) elapsed while the slot was still running`,
          elapsedSeconds: (Date.now() - hold.sinceMs) / 1000,
        }),
      );
    }
  }
}

/** One slot's claim → process → release loop. Never throws. */
async function runSlot(
  slotIndex: number,
  config: RunCoreConfig,
  deps: RunCoreDeps,
  tracker: WorkProgressTracker,
  endTime: number,
  pool: SlotPoolState,
): Promise<void> {
  const slotId = `s${slotIndex + 1}`;
  const log = (message: string) => deps.log(`[${slotId}] ${message}`);
  // Issue #219: how long an idle slot waits before scanning again. At least
  // one second, so a misconfigured `sleepInterval: 0` cannot turn the
  // re-scan into a hot loop against the GitHub API.
  const rescanMs = Math.max(1, config.sleepInterval) * 1000;
  /** Consecutive scans that re-offered an issue the pool already deferred. */
  let reofferedDeferred = 0;
  while (true) {
    const stop = await slotShouldStop(deps, endTime, pool);
    if (stop) {
      // Every slot exit states its reason (Issue #219) — a slot that stops
      // silently is indistinguishable from one that is still working.
      if (stop === "deadline") {
        pool.draining = true;
        log(
          "stop reason=deadline — reached the cycle deadline / runway floor; " +
            "stopping before the next claim.",
        );
      } else if (stop === "shutdown") {
        pool.draining = true;
        log("stop reason=shutdown — no further claims (Issue #4182).");
      } else if (stop === "exit") {
        log("stop reason=exit — the cycle is ending; no further claims.");
      } else {
        log("stop reason=drain — the pool is draining; no further claims.");
      }
      return;
    }

    // Host-wide guards before EVERY claim (Issue #4180): the serial loop
    // consults the spend ceiling and rate-limit signal once per cycle; N
    // slots re-checking between claims would otherwise let a ceiling hit
    // during slot A's run go unnoticed by slot B's next claim. A tripped
    // guard drains the whole pool — running slots finish, nobody claims.
    if (await slotPreClaimGuardTripped(slotId, deps, pool)) return;

    // Memory-pressure ceiling (Issue #4179): when it has dropped below this
    // slot's index, the slot stops before its next claim — the pool shrinks
    // by idling, never by cancelling running work.
    const ceiling = await effectiveSlotCeiling(
      deps,
      Math.max(1, config.maxConcurrentIssues),
    );
    if (slotIndex >= ceiling) {
      log(
        `memory-pressure slot ceiling is ${ceiling} — this slot stops before its next claim.`,
      );
      return;
    }

    // Find the next issue outside the repositories siblings hold.
    let scanSummary: DiagnosticSummary | undefined;
    const findResult = await deps.findNextIssue({
      excludeRepos: pool.registry.heldRepos(),
      // Issues this cycle already deferred for the adaptive floor (#245).
      excludeIssues: pool.deferredClaims,
      onScanSummary: (summary) => {
        scanSummary = summary;
      },
    });
    if (!findResult.ok) {
      deps.logError(
        `[${slotId}] stop reason=find-error — Issue scanning error: ${findResult.error.message}`,
      );
      return;
    }
    const issue = findResult.value;
    if (issue === null) {
      // The backlog was evaluated and refused (Issue #437) — the pool-wide
      // record the idle-inversion escalation reads to tell "the scan said
      // no" from "the scan never looked".
      pool.eligibilityScanCompleted = true;
      // Issue #219: an empty scan is reported with its counts, and the slot
      // retires only when nothing else is running. Returning on the first
      // null parked the slot until the whole pool drained — a two-slot pool
      // ran as one for an hour with a dozen eligible issues waiting, and
      // the log said nothing at all.
      const detail = scanSummary
        ? formatScanSummary(scanSummary)
        : "scan summary unavailable";
      // Sibling *slots* only (Issue #213): a maintenance pass running beside
      // the pool is not a reason for an idle slot to keep re-scanning for an
      // hour, so it does not count.
      const siblings = pool.registry.slotHolds()
        .filter((h) => h.slotId !== slotId).length;
      if (siblings === 0) {
        log(
          `stop reason=no-work — no eligible work: ${detail}; ` +
            "no sibling slot is running, so the pool drains and the cycle continues.",
        );
        return;
      }
      log(
        `no eligible work: ${detail} — re-scanning in ${
          rescanMs / 1000
        }s while ${siblings} sibling slot(s) work (Issue #219).`,
      );
      await deps.sleep(rescanMs);
      await yieldToEventLoop();
      continue;
    }

    // Adaptive claim floor (Issue #245): an issue with evidence that it is
    // not a short job needs a runway that can host a real execute. Deferred
    // rather than claimed, the slot looks for another candidate (#219).
    if (pool.deferredClaims.has(issueClaimKey(issue.repo, issue.issueNumber))) {
      reofferedDeferred++;
      if (reofferedDeferred > MAX_DEFERRED_REOFFERS) {
        deps.logError(
          `[${slotId}] stop reason=deferred-reoffered — the scan re-offered ` +
            `deferred issue ${issue.repo}#${issue.issueNumber} ` +
            `${reofferedDeferred} times, so the adaptive claim floor ` +
            `(Issue #245) cannot advance to another candidate.`,
        );
        return;
      }
      await deps.sleep(rescanMs);
      await yieldToEventLoop();
      continue;
    }
    reofferedDeferred = 0;
    if (
      await deferClaimForAdaptiveFloor(
        deps,
        config,
        issue,
        endTime,
        pool.deferredClaims,
        log,
      )
    ) {
      await yieldToEventLoop();
      continue;
    }

    // Atomic against sibling starts (Issue #4176): exactly one slot wins a
    // repository; a loser looks again.
    if (!pool.registry.tryAcquire(issue.repo, issue.issueNumber, slotId)) {
      // Issue #219: the ranking this scan produced has already lost, so
      // drop the repository's cached issue list before looking again —
      // otherwise the next scan can be served the same stale list.
      log(
        `lost the acquire race for ${issue.repo}#${issue.issueNumber} — ` +
          "invalidating its cached issue list before re-scanning (Issue #219).",
      );
      await invalidateRepoIssueCache(deps, slotId, issue.repo);
      await yieldToEventLoop();
      continue;
    }

    /** Set by a successful claim so the settle sleep runs holding no repo. */
    let claimSucceeded = false;
    try {
      // Every claim gets its OWN write-repo allowlist (Issue #183). The
      // per-slot context exists (#4175) but nothing wired it up here, so
      // both slots fell through to the process-wide default context:
      // `seedWriteRepoAllowlist` clears `allowed` on every claim, so the
      // slot that claimed second clobbered its sibling's allowlist and the
      // loser's agent shim was baked with the wrong repo — every GitHub
      // write from that agent was refused, including writes to its own
      // claim repo and its `needs-human` escalation.
      //
      // Per CLAIM, not per slot: each claim seeds and resets its own
      // allowlist, so a fresh context per claim keeps a heartbeat pin
      // (Issue #3760) scoped to the claim that took it.
      //
      // Every line written on behalf of this claim — the pool's own, the
      // issue phases, the agent's progress heartbeats — is attributed to
      // `[sN repo#issue]` (Issue #4181).
      const outcome = await withWriteRepoAllowlistContext(
        createWriteRepoAllowlistContext(),
        () =>
          runInSlotContext(
            {
              slotId,
              repo: issue.repo,
              issueNumber: issue.issueNumber,
              // The run publishes the deadline it is working to (Issue
              // #4297), including every progress extension, so the shutdown
              // drain sees a legitimately extended run as in-flight rather
              // than as a hang.
              onRunDeadline: (deadline) => {
                pool.registry.noteRunDeadline(issue.repo, deadline);
              },
            },
            () =>
              runSlotIssue(
                slotId,
                issue,
                config,
                deps,
                tracker,
                endTime,
                pool,
              ),
          ),
      );
      if (outcome === "exit") {
        pool.exitOuterLoop = true;
        pool.draining = true;
        return;
      }
      // A success must NOT retire the slot (Issue #178). The serial loop's
      // `break` hands back to the outer loop, which runs the maintenance
      // ladder and re-scans seconds later — cheap. In the pool a return
      // parks the slot until EVERY sibling drains, so one long execute
      // next door left `max_concurrent_issues: 2` running as one slot plus
      // an idle one for the rest of the cycle. The slot claims again after
      // the settle sleep below, re-gated by `slotShouldStop` and the
      // pre-claim guards at the top of the loop; the maintenance ladder
      // runs when the pool next drains.
      claimSucceeded = outcome === "success";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logError(
        `${
          formatSlotPrefix({
            slotId,
            repo: issue.repo,
            issueNumber: issue.issueNumber,
          })
        } slot threw: ${message}`,
      );
      // A thrown slot must not leak its claim (Issue #4178); the release
      // still states what happened (Issue #4325).
      const since = pool.registry.holds().find((h) => h.repo === issue.repo)
        ?.sinceMs;
      await releaseIssueClaim(
        deps,
        issue.repo,
        issue.issueNumber,
        deriveRunOutcome({
          success: false,
          phase: "slot",
          reason: message,
          elapsedSeconds: since === undefined ? 0 : (Date.now() - since) / 1000,
        }),
      );
      // A primary rate limit is pool-wide (Issue #4180): stop every slot
      // from claiming and let the pool re-throw once drained so the cycle
      // pauses until reset instead of N slots each discovering it.
      if (isPrimaryRateLimitMessage(message)) {
        pool.draining = true;
        pool.rateLimitError ??= err instanceof Error ? err : new Error(message);
        log(
          "primary rate limit hit — draining the pool before the cycle pauses.",
        );
      }
    } finally {
      pool.registry.release(issue.repo);
    }

    // Settle sleep after a success (Issue #178): the same `sleepInterval`
    // the serial loop earns between issues, so a slot paces its claims
    // instead of hot-looping. Taken AFTER the registry hold is released so
    // a sibling is never locked out of the repository while this slot
    // idles.
    if (claimSucceeded) {
      const settleMs = Math.max(0, config.sleepInterval) * 1000;
      if (settleMs > 0) await deps.sleep(settleMs);
    }
  }
}

/**
 * Hand control back to the event loop (Issue #219).
 *
 * A slot that re-scans without claiming only awaits injected functions, and
 * an injected `sleep` can resolve immediately. Without a macrotask boundary
 * such a loop starves a sibling slot's in-flight I/O — the idle slot would
 * spin while the working one made no progress.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Drop a repository's cached issue list (Issue #219), best effort.
 *
 * A cache that refuses to clear is reported — the next scan may then be
 * served a stale ranking — but it never retires the slot: looking again
 * with a stale list still beats idling for the rest of the cycle.
 */
async function invalidateRepoIssueCache(
  deps: RunCoreDeps,
  slotId: string,
  repo: string,
): Promise<void> {
  if (!deps.invalidateRepoIssueCache) return;
  try {
    await deps.invalidateRepoIssueCache(repo);
  } catch (err) {
    deps.logError(
      `[${slotId}] failed to invalidate the cached issue list for ${repo} ` +
        `(the next scan may be served a stale ranking): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
}

/**
 * Pre-claim host-wide guards for one slot (Issue #4180). Returns true when
 * the slot must stop; drains the pool for the pool-wide conditions.
 *
 * - Spend ceiling: reported once (`[SPEND_CEILING]`, the line the serial
 *   gate emits) and the cycle ends after the drain.
 * - Rate-limit signal: no new claim while it is active; the pool drains
 *   and the cycle-level check pauses until reset, as for the serial loop.
 * - GitHub preflight: a limited API refuses the claim the same way.
 *
 * A guard that itself throws is reported and treated as "not tripped" — a
 * monitoring fault must not silently halt the fleet.
 */
async function slotPreClaimGuardTripped(
  slotId: string,
  deps: RunCoreDeps,
  pool: SlotPoolState,
): Promise<boolean> {
  try {
    if (deps.checkSpendCeiling) {
      const ceiling = await deps.checkSpendCeiling();
      if (ceiling.exceeded) {
        if (!pool.spendCeilingReached) {
          deps.logError(
            `[SPEND_CEILING] ${
              ceiling.message ?? "Daily spend ceiling reached"
            } — draining the issue pool before claiming further work.`,
          );
        }
        pool.spendCeilingReached = true;
        pool.draining = true;
        return true;
      }
    }
    // Host disk (Issue #226): a host short of room must not start more
    // agent work — every byte the work volume gains is a byte the host
    // loses, and a full host takes the running work and the host down.
    if (deps.checkHostDisk) {
      const disk = await deps.checkHostDisk();
      if (disk.level === "low") {
        if (!pool.hostDiskLow) {
          deps.logError(
            `[HOST_DISK_LOW] ${disk.detail} — draining the issue pool before claiming further work (Issue #226).`,
          );
        }
        pool.hostDiskLow = true;
        pool.draining = true;
        return true;
      }
    }
    // Work-volume fault (Issue #229): a broken filesystem under the clones
    // fails every run the same way — stop claiming until the launcher has
    // repaired or recreated the volume.
    if (deps.checkWorkVolumeFault) {
      const fault = deps.checkWorkVolumeFault();
      if (fault.faulted) {
        if (!pool.workVolumeFaulted) {
          deps.logError(
            `[WORK_VOLUME_FAULT] ${fault.detail} — draining the issue pool; the volume is checked on the next launch (Issue #229).`,
          );
        }
        pool.workVolumeFaulted = true;
        pool.draining = true;
        return true;
      }
    }
    if (await deps.isRateLimitActive()) {
      deps.log(
        `[${slotId}] Rate limit signal active — no further claims; draining the pool.`,
      );
      pool.draining = true;
      return true;
    }
    const preflight = await deps.preflightGitHubRateLimit();
    if (preflight.rateLimited) {
      deps.log(
        `[${slotId}] GitHub preflight rate-limited (${preflight.message}) — draining the pool.`,
      );
      pool.draining = true;
      return true;
    }
  } catch (err) {
    deps.log(
      `[${slotId}] pre-claim guard check failed (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return false;
}

/** The pressure-derived slot ceiling, or the configured count when absent. */
async function effectiveSlotCeiling(
  deps: RunCoreDeps,
  configured: number,
): Promise<number> {
  if (!deps.slotCeiling) return configured;
  try {
    return Math.max(
      1,
      Math.min(configured, await deps.slotCeiling.effectiveSlots(configured)),
    );
  } catch (err) {
    deps.log(
      `Slot ceiling check failed (running the configured count): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return configured;
  }
}

/** Why a slot should not take another claim right now, or undefined. */
async function slotShouldStop(
  deps: RunCoreDeps,
  endTime: number,
  pool: SlotPoolState,
): Promise<SlotStop | undefined> {
  if (pool.exitOuterLoop) return "exit";
  if (pool.shouldShutdown()) return "shutdown";
  if (pool.draining) return "draining";
  const minRunwayMs = pool.claimFloorSeconds * 1000;
  const now = deps.now();
  if (now >= endTime || (minRunwayMs > 0 && now + minRunwayMs >= endTime)) {
    return "deadline";
  }
  return undefined;
}

/**
 * Process one claimed issue in a slot and apply the serial loop's
 * bookkeeping. Returns what the slot should do next.
 */
async function runSlotIssue(
  slotId: string,
  issue: DiscoveredIssue,
  config: RunCoreConfig,
  deps: RunCoreDeps,
  tracker: WorkProgressTracker,
  endTime: number,
  pool: SlotPoolState,
): Promise<"success" | "skip" | "failure" | "exit"> {
  const prefix = formatSlotPrefix({
    slotId,
    repo: issue.repo,
    issueNumber: issue.issueNumber,
  });
  const log = (message: string) => deps.log(`${prefix} ${message}`);
  log(
    `Processing issue ${issue.repo}#${issue.issueNumber}: ${issue.issueTitle} ` +
      `[${formatBuildStamp(resolveWorkerBuildInfo())}]`,
  );
  // The status line represents EVERY active slot (Issue #4181): rendered
  // from the live slot table, so a sibling finishing never blanks it.
  const holds = () =>
    pool.registry.holds().map((h) => ({
      slotId: h.slotId,
      repo: h.repo,
      issueNumber: h.issueNumber,
    }));
  const siblingsWorking = () => holds().some((h) => h.slotId !== slotId);
  await deps.setStatusWorking(renderSlotStatus(holds()));
  /** This slot's terminal status: siblings still working keep the line. */
  const settleStatus = async (outcome: "success" | "failure") => {
    if (siblingsWorking()) {
      await deps.setStatusWorking(
        renderSlotStatus(holds().filter((h) => h.slotId !== slotId)),
      );
    } else if (outcome === "success") {
      await deps.setStatusSuccess();
    } else {
      await deps.setStatusFailure();
    }
  };

  // Leaked-heartbeat sweep, slot-aware (Issue #4178): only heartbeats no
  // live hold owns may be stopped, so a sibling's healthy heartbeat is
  // never mistaken for a leak. `heldHeartbeatKeys()` — not `heldIssues()` —
  // because the maintenance lane takes heartbeats too, and sweeping a live
  // merge-conflict resolution's heartbeat hands its work to another worker
  // mid-edit (Issue #391). Production supplies the slot-aware sweep; the
  // legacy whole-process sweep is NOT called from the pool.
  if (deps.sweepLeakedHeartbeatsExcept) {
    await deps.sweepLeakedHeartbeatsExcept(pool.registry.heldHeartbeatKeys());
  }

  // Issue #460: see the sibling call site — the claim, not the outcome.
  tracker.recordClaim(issue.repo);
  const processResult = await deps.processIssue(issue, endTime);
  const runOutcome = processResult.ok ? processResult.value.outcome : undefined;

  if (processResult.ok && processResult.value.success) {
    noteIssueProcessed(deps, issue, "success");
    tracker.recordSuccess();
    if (deps.resetScanCursor) {
      try {
        await deps.resetScanCursor();
      } catch (cursorErr) {
        log(
          `Scan cursor reset failed (continuing): ${
            cursorErr instanceof Error ? cursorErr.message : String(cursorErr)
          }`,
        );
      }
    }
    await deps.resetFailures();
    pool.consecutiveFailures = 0;
    await settleStatus("success");
    await deps.recordRepoSuccess(issue.repo);
    await releaseIssueClaim(
      deps,
      issue.repo,
      issue.issueNumber,
      runOutcome,
    );
    log(`Successfully processed ${issue.repo}#${issue.issueNumber}`);
    return "success";
  }

  const skipped = processResult.ok && processResult.value.skipped;
  if (skipped) {
    noteIssueProcessed(deps, issue, "skip");
    await deps.recordIssueCooldown(issue.repo, issue.issueNumber);
    await releaseIssueClaim(deps, issue.repo, issue.issueNumber);
    if (siblingsWorking()) {
      await deps.setStatusWorking(
        renderSlotStatus(holds().filter((h) => h.slotId !== slotId)),
      );
    }
    return "skip";
  }

  noteIssueProcessed(deps, issue, "failure");
  await deps.recordIssueCooldown(
    issue.repo,
    issue.issueNumber,
    processResult.ok ? processResult.value.failureKind : undefined,
  );
  await deps.trackFailure(`issue|${issue.repo}|${issue.issueNumber}`);
  await settleStatus("failure");
  await deps.recordRepoFailure(issue.repo, issue.issueNumber);

  if (await deps.shouldExitOnFailures()) {
    await releaseIssueClaim(
      deps,
      issue.repo,
      issue.issueNumber,
      runOutcome,
    );
    return "exit";
  }
  await releaseIssueClaim(
    deps,
    issue.repo,
    issue.issueNumber,
    runOutcome,
  );

  // Pool-wide consecutive-failure policy (Issue #4180 keeps thresholds
  // per host): the auth-outage probe and the back-off see every slot's
  // failures, so N slots do not multiply the budget.
  pool.consecutiveFailures++;
  if (pool.consecutiveFailures >= 2 && deps.recheckAgentAuth) {
    const probe = await deps.recheckAgentAuth();
    if (probe.authFailed) {
      deps.logError(
        `${prefix} ACTION REQUIRED: agent credential is failing (fresh auth probe ` +
          `after ${pool.consecutiveFailures} consecutive claim failures)` +
          (probe.message ? ` — ${probe.message}` : "") +
          `. Stopping claims for this cycle; the next cycle's health ` +
          `gate re-checks automatically.`,
      );
      return "exit";
    }
  }
  const backoffMs = Math.max(0, config.sleepInterval) * 1000;
  if (pool.consecutiveFailures >= 2 && backoffMs > 0) {
    log(
      `${pool.consecutiveFailures} consecutive issue failures — backing off ${
        backoffMs / 1000
      }s before the next claim.`,
    );
    await deps.sleep(backoffMs);
  }
  return "failure";
}

// ---------------------------------------------------------------------------
// Main event loop
// ---------------------------------------------------------------------------

/**
 * Log the work volume's standing totals, if the hook is wired (Issue #244).
 *
 * Best-effort: a failed walk is reported loud and never blocks the cycle.
 * Sampled twice per run (Issue #345) — at cycle start, and again at end of
 * run, which is both when the volume is at its fullest and after the clones
 * the cycle-start walk may have been too early to see.
 */
async function logWorkVolumeUsage(
  deps: RunCoreDeps,
  options: { label?: string; force?: boolean } = {},
): Promise<void> {
  if (!deps.reportWorkVolumeUsage) return;
  try {
    const line = await deps.reportWorkVolumeUsage(options);
    if (line) deps.log(line);
  } catch (err) {
    deps.logError(
      `Work volume: standing totals unavailable (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Run the main worker event loop.
 *
 * This is the top-level orchestration: PID locking, initialisation, the
 * priority dispatch loop, rate limiting, circuit breaker integration,
 * and graceful shutdown.
 *
 * @param config - Loop configuration
 * @param deps - Injected dependencies
 * @returns Summary of the run
 */
export async function runCoreLoop(
  config: RunCoreConfig,
  deps: RunCoreDeps,
): Promise<RunCoreResult> {
  const tracker = createWorkProgressTracker();
  // Issue #2106: monotonic tick counter passed to the idle-detect audit
  // so its per-repo lines and per-tick summary share a correlation id
  // log scrapers can group on.
  let idleDetectTick = 0;
  // Issue #2475: count consecutive audit/scan disagreement iterations
  // (probe found claimable work while the scan reported none) so the
  // #2106 budget-guard short-circuit cannot suppress the idle-task filer
  // forever. Reset to 0 on any non-disagreement pass.
  let auditDisagreementStreak = 0;
  // Issue #2479: monotonic per-cycle counter so the liveness guard runs on
  // a bounded cadence (see LIVENESS_CHECK_CADENCE) instead of every cycle.
  let livenessTick = 0;
  const startTime = deps.now();
  // Issue #1780: pull `endTime` up so the pre-flight pause-and-resume
  // path can refuse to wait past the run-duration cap.
  const endTime = startTime + config.runDurationSeconds * 1000;

  // Log the configured concurrency once at loop start (Issue #4174). Above
  // one slot the Priority-2 scan runs as a pool (Issue #4177); the effective
  // count may be lowered under memory pressure (Issue #4179).
  deps.log(
    `Concurrency: maxConcurrentIssues=${config.maxConcurrentIssues} ` +
      (config.maxConcurrentIssues > 1
        ? `(issue pool; effective slots may be lowered under memory pressure)`
        : `(serial loop; claims run one at a time)`),
  );

  // What the work volume is holding right now (Issue #244) — the standing
  // totals beside the concurrency line, so growth is visible before the
  // host-disk gate stops the cycle claiming.
  await logWorkVolumeUsage(deps);

  let plannedShutdown = false;
  let exitedOnFailures = false;
  let shutdownRequested = false;
  /** Set when the daily spend ceiling stopped the cycle (Issue #3648). */
  let spendCeilingReached = false;
  /** Set once the low host disk has been reported this cycle (Issue #226). */
  let hostDiskLowReported = false;
  /** Set once the work-volume fault has been reported this cycle (Issue #229). */
  let workVolumeFaultReported = false;
  /** Set once blind disk telemetry has been reported (Issue #345). */
  let diskTelemetryBlindReported = false;
  // Issue #2602: tracks whether the latest iteration's health checks passed.
  // Starts false so a run that never reaches a healthy iteration (e.g. Claude
  // 401 every cycle) does not report healthy at end of run.
  let lastHealthCheckPassed = false;
  /**
   * Set once this run stopped for quota exhaustion (Issue #342): the wait
   * would outlast the run-duration cap, so the run ends and the supervisor
   * re-probes on its own fixed cadence.
   */
  let quotaPaused = false;
  /** Reset the quota pause was waiting on, in Unix seconds (Issue #342). */
  let quotaResetEpochSeconds = 0;

  // Build result helper
  function buildResult(reason: string): RunCoreResult {
    const durationSeconds = (deps.now() - startTime) / 1000;
    return {
      plannedShutdown,
      skippedDueToPidLock: false,
      exitedOnFailures,
      issuesProcessed: tracker.issuesProcessed,
      durationSeconds,
      exitReason: reason,
      quotaPaused,
      ...(quotaPaused && quotaResetEpochSeconds > 0
        ? { quotaResetEpochMs: quotaResetEpochSeconds * 1000 }
        : {}),
      lastHealthCheckPassed,
    };
  }

  /**
   * Pause until the GitHub rate-limit reset epoch, honouring shutdown
   * and the run-duration cap. Returns a discriminated outcome so each
   * call site can decide whether to retry, break, or fall through.
   * Issue #1780.
   */
  async function pauseUntilRateLimitReset(
    resetEpoch: number,
    source: string,
  ): Promise<{ outcome: "ok" | "shutdown" | "cap" | "duration" | "error" }> {
    // Refuse to wait past the run-duration cap — exit cleanly so the
    // supervisor can respawn for the next window.
    const waitMs = (resetEpoch - Math.floor(deps.now() / 1000)) * 1000;
    if (deps.now() + Math.max(0, waitMs) >= endTime) {
      // Issue #342: this is the quota-pause exit. Record it so the driver can
      // declare it to the supervisor — a clean pause that shares its exit
      // status with a crash is read as a crash, and the host then backs off
      // exponentially instead of re-probing hourly.
      quotaPaused = true;
      quotaResetEpochSeconds = resetEpoch;
      deps.log(
        `${source}: rate-limit wait would exceed run-duration cap — exiting cleanly`,
      );
      return { outcome: "duration" };
    }

    const waitResult = await waitUntilRateLimitReset(
      { resetEpoch },
      {
        now: () => Math.floor(deps.now() / 1000),
        sleep: (ms) => deps.sleep(ms),
        shouldShutdown: () => shutdownRequested,
        // Periodic heartbeat so the worker does not appear hung during
        // long rate-limit pauses (Issue #1903).
        log: (msg) => deps.log(`${source}: ${msg}`),
      },
    );
    if (!waitResult.ok) {
      deps.log(
        `${source}: rate-limit wait failed: ${waitResult.error.message}`,
      );
      return { outcome: "error" };
    }
    if (waitResult.value.aborted === "shutdown") {
      deps.log(`${source}: shutdown during rate-limit wait — exiting cleanly`);
      return { outcome: "shutdown" };
    }
    if (waitResult.value.aborted === "cap") {
      deps.log(`${source}: rate-limit wait hit safety cap — proceeding`);
      return { outcome: "cap" };
    }
    deps.log(
      `${source}: resumed after ${waitResult.value.waited}s rate-limit wait`,
    );
    return { outcome: "ok" };
  }

  /**
   * Persist the scan cursor at the given priority (Issue #2427). Best-effort —
   * a throw is logged and swallowed so cursor I/O never aborts the loop.
   */
  async function saveCursor(priority: number): Promise<void> {
    if (!deps.saveScanCursor) return;
    try {
      await deps.saveScanCursor(priority);
    } catch (cursorErr) {
      deps.log(
        `Scan cursor save failed (continuing): ${
          cursorErr instanceof Error ? cursorErr.message : String(cursorErr)
        }`,
      );
    }
  }

  // --- PID lock check ---
  const pidCheck = await deps.checkPidFile();
  if (!pidCheck.canProceed) {
    deps.log(`PID lock: ${pidCheck.message}`);
    return {
      plannedShutdown: true,
      skippedDueToPidLock: true,
      exitedOnFailures: false,
      issuesProcessed: 0,
      durationSeconds: 0,
      exitReason: pidCheck.message,
      quotaPaused: false,
      lastHealthCheckPassed: false,
    };
  }

  // Claim PID file
  await deps.claimPidFile();

  // --- Signal handling ---
  const shutdownHandler = () => {
    shutdownRequested = true;
  };
  deps.addSignalListener("SIGTERM", shutdownHandler);
  deps.addSignalListener("SIGINT", shutdownHandler);

  try {
    // --- Pre-flight GitHub rate-limit gate ---
    // `gh api rate_limit` is a free call. If the primary GraphQL quota is
    // already exhausted, pause-and-resume in place rather than exiting
    // and forcing the supervisor to respawn every 30s until the reset
    // (Issue #1780; see Issue #1523 for the original graceful exit).
    let preflight = await deps.preflightGitHubRateLimit();
    while (preflight.rateLimited && !shutdownRequested) {
      const resetEpoch = Math.floor(deps.now() / 1000) +
        Math.max(1, preflight.remainingSeconds);
      deps.log(
        `Pre-flight: ${preflight.message} — pausing until reset ${
          formatRateLimitReset(resetEpoch, Math.floor(deps.now() / 1000))
        }`,
      );
      const wait = await pauseUntilRateLimitReset(resetEpoch, "Pre-flight");
      if (wait.outcome === "shutdown") {
        return buildResult("Shutdown during pre-flight rate-limit wait");
      }
      if (wait.outcome === "duration") {
        return buildResult("Run duration expired");
      }
      // "ok", "cap", and "error" all proceed to re-check the quota.
      preflight = await deps.preflightGitHubRateLimit();
    }
    if (shutdownRequested) {
      return buildResult("Shutdown signal received");
    }

    // --- Initialisation ---
    const initResult = await runInitialisation(deps);
    if (!initResult.ok) {
      return buildResult(initResult.error.message);
    }

    // --- Main loop ---
    // `endTime` is computed once at the top of runCoreLoop so the
    // pre-flight pause-and-resume path can refuse to wait past it.
    const priorityTable = buildPriorityDispatchTable(
      deps,
      () => shutdownRequested,
      config,
    );

    // Issue #1780: the inner while is wrapped in a rate-limit retry so
    // a primary rate-limit thrown mid-cycle pauses the worker until the
    // quota refreshes instead of exiting. Non-rate-limit errors fall
    // through to the outer catch as before.
    let resumeAfterRateLimit = true;
    while (resumeAfterRateLimit) {
      resumeAfterRateLimit = false;

      // Issue #2427: consult the persisted scan cursor when the dispatch
      // loop (re)starts — on a fresh process and after every rate-limit
      // resume. When the cursor is fresh (< 60s old) the first iteration of
      // the inner while skips priorities below `cursor.priority`, so a
      // resume continues near where the rate limit fired instead of burning
      // the freshly-refreshed quota on PR feedback / spelling / CI / etc.
      // before reaching Priority 2 issue scanning. The skip applies once:
      // after the first full sweep, `skipBelowPriority` reverts to 1 so
      // subsequent iterations dispatch normally. A stale cursor (≥ 60s,
      // e.g. left by a SIGTERM/crash) resolves to 1 and is ignored.
      let skipBelowPriority = 1;
      if (deps.loadScanCursor) {
        try {
          const cursor = await deps.loadScanCursor();
          const nowSec = Math.floor(deps.now() / 1000);
          skipBelowPriority = resolveStartPriority(cursor, nowSec);
          if (cursor !== null && skipBelowPriority > 1) {
            deps.log(
              `[scan-cursor] resuming dispatch from priority ${skipBelowPriority} (cursor age ${
                nowSec - cursor.savedAt
              }s)`,
            );
          }
        } catch (cursorErr) {
          deps.log(
            `Scan cursor load failed (continuing): ${
              cursorErr instanceof Error ? cursorErr.message : String(cursorErr)
            }`,
          );
        }
      }

      try {
        while (deps.now() < endTime && !shutdownRequested) {
          resetCounters();
          // Issue #1671: reset per-iteration `gh` call telemetry so the
          // end-of-cycle summary reports just this iteration's calls.
          resetGhCallMetrics();
          // Issue #4299: per-cycle wall-time telemetry starts here.
          startCycleTimings(deps.now());
          // Issue #1783: drop the timeline-batch registry's accumulated
          // entries so the next iteration starts with a clean in-memory
          // map. Production wiring sets this; test deps may omit it.
          deps.resetIterationCaches?.();
          tracker.resetScanProgress();

          // Touch PID file for proof of life
          await deps.touchPidFile();

          // --- Trusted-author snapshot (Issue #253) ---
          // Fail-closed: a refresh failure skips every trust-dependent
          // pass for this cycle (claiming, comment-driven work,
          // label-driven work, PR invitation, escape hatch, and every
          // maintenance pass that reads fleet-author sets). No pass is
          // treated as trust-independent — if that is not obvious, it
          // is skipped. The failure is logged every cycle it persists
          // so a worker that is quietly doing nothing is not mistaken
          // for a healthy idle host. The host is marked unhealthy so
          // the end-of-run FLEET report cannot claim otherwise.
          if (deps.refreshTrustedAuthors) {
            let refresh: RefreshOutcome;
            try {
              refresh = await deps.refreshTrustedAuthors();
            } catch (refreshErr) {
              const reason = refreshErr instanceof Error
                ? refreshErr.message
                : String(refreshErr);
              refresh = { ok: false, reason };
            }
            if (!refresh.ok) {
              lastHealthCheckPassed = false;
              deps.logError(
                `[TRUST_REFRESH] ${refresh.reason} — skipping all trust-dependent processing this cycle (Issue #253).`,
              );
              await deps.sleep(config.sleepInterval * 1000);
              continue;
            }
          }

          // --- Daily spend ceiling (Issue #3648) ---
          // The credit log was append-only and never compared against a
          // threshold, so wall-clock was the only backpressure on model spend.
          // Check the ceiling before claiming any further billed work and stop
          // the cycle loudly when it is reached. A check that itself fails is
          // reported and treated as "not exceeded" — a monitoring fault must
          // not silently halt the fleet, but it must never be silent either.
          if (deps.checkSpendCeiling) {
            const ceiling = await deps.checkSpendCeiling();
            if (ceiling.exceeded) {
              deps.logError(
                `[SPEND_CEILING] ${
                  ceiling.message ?? "Daily spend ceiling reached"
                } — stopping this cycle before claiming further work.`,
              );
              spendCeilingReached = true;
              break;
            }
          }

          // --- Host disk (Issue #226) ---
          // A host short of room claims nothing new this iteration, but the
          // maintenance passes below still run — they are what lands the
          // PRs already open and what reclaims space. Reported once per
          // cycle; the pool's own pre-claim guard reports a mid-pool drop.
          let skipScanForHostDisk = false;
          if (deps.checkHostDisk) {
            const disk = await deps.checkHostDisk();
            if (disk.level === "low") {
              // Reclaim before the gate trips (Issue #242): the work
              // root's disposable tier goes largest-first, and only a
              // host still short after that stops claiming.
              let healed = false;
              if (deps.reclaimDiskSpace) {
                try {
                  const reclaim = await deps.reclaimDiskSpace();
                  healed = reclaim.healed;
                  deps.log(
                    `[HOST_DISK_LOW] reclaimed ${reclaim.bytesReclaimed} bytes of disposable space INSIDE the work volume — ${reclaim.detail} (Issue #242)`,
                  );
                } catch (err) {
                  // A reclaim that fails must be loud, never silent: the
                  // gate below still stops the cycle claiming.
                  deps.logError(
                    `[HOST_DISK_LOW] disposable-space reclaim failed (continuing to the disk gate): ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                }
              }
              if (healed) {
                hostDiskLowReported = false;
              } else {
                skipScanForHostDisk = true;
                if (!hostDiskLowReported) {
                  hostDiskLowReported = true;
                  deps.logError(
                    `[HOST_DISK_LOW] ${disk.detail} — claiming no new issues this cycle; maintenance continues (Issue #226).`,
                  );
                }
              }
            }
          }
          // Work-volume fault (Issue #229): same treatment as a low disk.
          if (deps.checkWorkVolumeFault) {
            const fault = deps.checkWorkVolumeFault();
            if (fault.faulted) {
              skipScanForHostDisk = true;
              if (!workVolumeFaultReported) {
                workVolumeFaultReported = true;
                deps.logError(
                  `[WORK_VOLUME_FAULT] ${fault.detail} — claiming no new issues this cycle; the volume is checked on the next launch (Issue #229).`,
                );
              }
            }
          }

          // Reset window title and status
          deps.resetWindowTitle();
          await deps.setStatusIdle();

          // --- Rate limit check ---
          // Issue #1780: when the signal is active, wait for the actual
          // remaining seconds (derived into a reset epoch) instead of the
          // fixed `config.rateLimitBackoff`. Falls back to the configured
          // backoff when the signal lacks a remaining-seconds value.
          const rateLimited = await deps.isRateLimitActive();
          if (rateLimited) {
            const remaining = await deps.getRateLimitRemainingSeconds();
            if (remaining > 0) {
              const resetEpoch = Math.floor(deps.now() / 1000) + remaining;
              deps.log(
                `Rate limit signal active — pausing until reset ${
                  formatRateLimitReset(
                    resetEpoch,
                    Math.floor(deps.now() / 1000),
                  )
                }`,
              );
              const wait = await pauseUntilRateLimitReset(
                resetEpoch,
                "Mid-loop signal",
              );
              if (wait.outcome === "shutdown" || wait.outcome === "duration") {
                break;
              }
            } else {
              deps.log("Rate limit active — backing off");
              await deps.sleep(config.rateLimitBackoff * 1000);
            }
            continue;
          }

          // --- Per-pass pre-flight quota gate (Issue #42) ---
          // The pre-flight gate above the main loop runs once, at process
          // start. The signal check immediately above only sees exhaustion
          // this process (or a sibling sharing the work dir) already
          // recorded — so when another worker on the same token drains the
          // primary GraphQL quota mid-run, this pass would learn about it
          // only by making a doomed call of its own. `gh api rate_limit` is
          // free and rides the core quota, so re-reading it at the top of
          // every priority pass catches an exhausted window before the pass
          // spends anything, and pauses on the same #1780 path.
          const passPreflight = await deps.preflightGitHubRateLimit();
          if (passPreflight.rateLimited) {
            const nowSec = Math.floor(deps.now() / 1000);
            const resetEpoch = nowSec +
              Math.max(1, passPreflight.remainingSeconds);
            deps.log(
              `Per-pass pre-flight: ${passPreflight.message} — pausing until reset ${
                formatRateLimitReset(resetEpoch, nowSec)
              }`,
            );
            const wait = await pauseUntilRateLimitReset(
              resetEpoch,
              "Per-pass pre-flight",
            );
            if (wait.outcome === "shutdown" || wait.outcome === "duration") {
              break;
            }
            continue;
          }

          // --- Health checks ---
          // Issue #2602: a failed check marks the worker unhealthy so neither
          // the per-iteration heartbeat below nor the end-of-run report
          // (gated on `lastHealthCheckPassed`) reports the host as healthy.
          const claudeHealth = await deps.checkClaudeHealth();
          if (!claudeHealth.ok || !claudeHealth.value.healthy) {
            lastHealthCheckPassed = false;
            deps.logError("Claude health check failed — skipping cycle");
            await deps.sleep(config.sleepInterval * 1000);
            continue;
          }

          const ghAuth = await deps.checkGhAuth();
          if (!ghAuth.ok || !ghAuth.value.valid) {
            lastHealthCheckPassed = false;
            deps.logError("GitHub auth check failed — skipping cycle");
            await deps.sleep(config.sleepInterval * 1000);
            continue;
          }

          // Issue #4038: third health condition — can this identity still see
          // the repos it is configured to monitor? In the host-3 incident
          // (#4028) `gh auth status` was valid for the *wrong* identity, so
          // both checks above passed while every monitored repo 404'd for
          // days. Deliberately does NOT `continue`: one inaccessible repo
          // marks the host unhealthy while the worker keeps working the repos
          // that remain accessible. Visibility only — nothing is filed or
          // escalated here. Recovery is automatic: the next successful probe
          // clears the store (#4036) and the following iteration is healthy
          // again, with no operator action and no restart.
          const inaccessibleRepos = deps.getInaccessibleRepos?.() ??
            getInaccessibleRepos();
          if (inaccessibleRepos.length > 0) {
            lastHealthCheckPassed = false;
            // Issue #4039: one structured, greppable line per iteration —
            // `[repo-access] host=… status=inaccessible repos=… consecutive=…`
            // — so the outage is recoverable from the log after the fact.
            // `logRepoAccessOnce` suppresses the identical line from the
            // other call sites in the same iteration (the private-repo-6
            // report), and the iteration boundary resets it.
            logRepoAccessOnce(
              inaccessibleRepos,
              (line) => deps.logError(line),
              {
                suffix:
                  "host marked unhealthy; continuing this cycle for the repos " +
                  "that remain accessible",
              },
            );
          } else {
            lastHealthCheckPassed = true;
          }

          // Issue #345: fourth health condition — can this host still see its
          // own disk? Both disk signals blind (host-disk unreadable *and* the
          // work-volume totals unmeasurable) is exactly the state GRQ-23 was
          // in for days before it crashed out of disk, with every feature line
          // still reading `available`. Visibility only, like the repo-access
          // check above: the host is marked unhealthy and the fleet payload
          // names it, but nothing is gated — a monitoring fault must not stop
          // the fleet working. Recovery is automatic on the next readable
          // probe.
          if (deps.checkDiskTelemetry) {
            const telemetry = deps.checkDiskTelemetry();
            if (telemetry.blind) {
              lastHealthCheckPassed = false;
              if (!diskTelemetryBlindReported) {
                diskTelemetryBlindReported = true;
                deps.logError(
                  `[DISK_TELEMETRY_BLIND] ${telemetry.detail} — this host cannot ` +
                    `see its own disk filling; marking it unhealthy (Issue #345).`,
                );
              }
            } else {
              diskTelemetryBlindReported = false;
            }
          }

          // Issue #3230: populate the Fable-availability cache alongside the
          // Claude health-check cadence. Best-effort — the probe only sets the
          // cache; a failure never affects the worker's overall health or the
          // loop, and it does NOT gate this cycle (routing is a later
          // sub-issue). The 15-min cache gate inside limits actual Fable calls
          // to at most one per TTL window.
          if (deps.checkFableAvailability) {
            try {
              await deps.checkFableAvailability();
            } catch (fableErr) {
              deps.logError(
                `Fable availability probe failed (continuing): ${
                  fableErr instanceof Error
                    ? fableErr.message
                    : String(fableErr)
                }`,
              );
            }
          }

          // Issue #1935: emit a private-repo-6 heartbeat once per iteration so the
          // host's row in `private-repo-6/docs/repos.json` advances even when the
          // end-of-run path is killed by SIGTERM. `helpers/repos.sh`
          // rate-limits to one push/hour, so frequent invocations are cheap
          // no-ops.
          //
          // Issue #2602: the heartbeat is reported only AFTER the Claude and
          // GitHub auth health checks pass. A worker that cannot authenticate
          // (e.g. Claude 401) must NOT report itself healthy — skipping the
          // heartbeat lets the host go stale on the dashboard so the failure
          // is visible instead of being masked by a green "healthy" row.
          // Best-effort — wrapped so a heartbeat failure cannot abort the loop.
          //
          // Issue #4038: the `lastHealthCheckPassed` guard is explicit because
          // the monitored-repo access check above falls through instead of
          // skipping the cycle. Without it, a host that cannot see its repos
          // would keep heartbeating green — the exact #4028 false-healthy
          // signature this gate exists to end.
          if (lastHealthCheckPassed && deps.reportFleetHealthHeartbeat) {
            try {
              await deps.reportFleetHealthHeartbeat();
            } catch (heartbeatErr) {
              const msg = heartbeatErr instanceof Error
                ? heartbeatErr.message
                : String(heartbeatErr);
              deps.log(`FLEET heartbeat failed (continuing): ${msg}`);
            }
          }

          // --- Per-cycle stale-assignment recovery (Issue #2672) ---
          // Run the GitHub-side recovery scans every cycle (reusing the
          // iteration-scoped issue cache) so a leaked assignment is freed
          // within a cycle rather than only at worker start-up. Placed
          // before the priority dispatch so a just-recovered issue is
          // available to the Priority 2 scan in this same cycle.
          // Best-effort — any throw is caught and logged so recovery never
          // aborts the loop. Quiet on a no-op: the hook emits only the
          // existing `[recovery-decision]` telemetry.
          if (deps.recoverStaleAssignments) {
            try {
              await deps.recoverStaleAssignments();
            } catch (recoveryErr) {
              const msg = recoveryErr instanceof Error
                ? recoveryErr.message
                : String(recoveryErr);
              deps.log(`Stale-assignment recovery failed (continuing): ${msg}`);
            }
          }

          // --- Priority dispatch (1 through 1.9) ---
          // Issue #2776: these Priority 1.x handlers maintain in-flight work
          // and are deliberately not `nice`-gated — `nice` only tiers new-work
          // selection in the Priority 2 scan below. See
          // `buildPriorityDispatchTable` for the full rationale.
          //
          // Issue #213: the agent-backed passes flagged `maintenanceLane` are
          // deferred out of this serial ladder and run beside the Priority-2
          // pool instead. Serially they held every issue slot idle for as long
          // as their agent ran — a CI fix with a 30-minute budget cost half a
          // cycle of two-slot concurrency before the pool even started. The
          // cheap non-agent passes stay here: they are `gh` calls measured in
          // seconds, and running them first keeps the pool's first scan
          // working from freshly-updated branch and merge state.
          //
          // The lane needs the pool's own in-flight registry to lease
          // repositories against; without it (a test wiring that omits
          // `inFlightRepos`) every pass stays serial rather than racing the
          // slots for a shared clone.
          const laneRegistry = deps.inFlightRepos;
          const laneEnabled = config.maxConcurrentIssues > 1 &&
            laneRegistry !== undefined;
          if (config.maxConcurrentIssues > 1 && laneRegistry === undefined) {
            deps.logError(
              "[maintenance-lane] no in-flight repo registry wired — " +
                "agent-backed maintenance runs serially ahead of the pool " +
                "and will idle the slots (Issue #213).",
            );
          }
          /** Lane passes deferred out of the ladder, in priority order. */
          const deferredLanePasses: PriorityHandler[] = [];

          for (const handler of priorityTable) {
            if (handler.priority >= 2) break; // Priority 2 handled separately

            // Issue #2427: on the first sweep after a resume, skip priorities
            // below the cursor's priority so we continue near where the rate
            // limit fired. `skipBelowPriority` is 1 on a normal cycle, so this
            // is a no-op except immediately after a fresh start / resume.
            if (handler.priority < skipBelowPriority) {
              continue;
            }

            if (laneEnabled && handler.maintenanceLane === true) {
              deferredLanePasses.push(handler);
              continue;
            }

            // Issue #2427: persist the cursor as we enter each priority so a
            // mid-cycle rate-limit pause records the priority in flight.
            await saveCursor(handler.priority);

            const dispatched = await executePriorityHandler(
              handler,
              config,
              deps,
              tracker,
              endTime,
            );
            if (dispatched.kind === "rate-limit-error") {
              // Issue #1921: hand a thrown primary rate limit to the outer
              // catch, which owns the pause-until-reset logic.
              throw dispatched.error;
            }
            if (dispatched.kind === "rate-limited") {
              break; // Stop processing further priorities this cycle
            }
          }

          // --- Priority 2: Issue scanning inner loop ---
          // Issue #2427: persist the cursor at Priority 2 so a rate limit
          // during issue scanning records that scanning was in flight. The
          // maintenance lane deliberately does NOT move the cursor: it runs
          // beside Priority 2, and recording 1.55 while scanning is in flight
          // would send a rate-limit resume backwards through the ladder.
          await saveCursor(2);
          const scanStartMs = deps.now();
          // Wrapped so any `gh` calls inside `findNextIssue` /
          // `processIssue` attribute to "Issue Scanning" (Issue #1845),
          // async-scoped (Issue #213) so the lane running beside it keeps
          // its own attribution.
          const scanTask = (async () => {
            try {
              return skipScanForHostDisk
                // A scan that never ran refused nothing (Issue #437).
                ? { exitOuterLoop: false, eligibilityScanCompleted: false }
                : await withPriorityContext(
                  "Issue Scanning",
                  () =>
                    runIssueScanLoop(
                      config,
                      deps,
                      tracker,
                      endTime,
                      () => shutdownRequested,
                    ),
                );
            } finally {
              recordStepDuration("Issue Scanning", deps.now() - scanStartMs);
            }
          })();
          // Issue #213: the deferred agent-backed passes run here, beside the
          // pool, each leasing its repository from the pool's own registry.
          const laneTask = deferredLanePasses.length > 0 && laneRegistry
            ? runMaintenanceLane(
              deferredLanePasses,
              config,
              deps,
              tracker,
              endTime,
              laneRegistry,
              () => shutdownRequested,
            )
            : Promise.resolve({} as { rateLimitError?: Error });
          // `allSettled`, not `all`: a primary rate limit thrown by the scan
          // must not abandon a maintenance agent mid-run. Both lanes finish,
          // then the error is surfaced on the same pause-until-reset path.
          const [scanSettled, laneSettled] = await Promise.allSettled([
            scanTask,
            laneTask,
          ]);
          // The lane is designed never to throw; if it ever does, say so
          // loudly rather than letting a settled-but-rejected promise pass
          // for a clean maintenance pass.
          if (laneSettled.status === "rejected") {
            const reason = laneSettled.reason;
            deps.logError(
              `[${MAINTENANCE_LANE_SLOT_ID}] maintenance lane threw: ${
                reason instanceof Error ? reason.message : String(reason)
              }`,
            );
          }
          if (scanSettled.status === "rejected") {
            throw scanSettled.reason;
          }
          const scanResult = scanSettled.value;
          if (
            laneSettled.status === "fulfilled" &&
            laneSettled.value.rateLimitError
          ) {
            throw laneSettled.value.rateLimitError;
          }
          if (scanResult.exitOuterLoop) {
            exitedOnFailures = true;
            break;
          }
          if (scanResult.spendCeilingReached) {
            // A slot's pre-claim gate found the ceiling reached (Issue
            // #4180): end the cycle the way the serial gate above does.
            spendCeilingReached = true;
            break;
          }
          if (scanResult.hostDiskLow) {
            // The pool already reported the drop (Issue #226); the next
            // iteration's own check must not repeat it.
            hostDiskLowReported = true;
          }
          if (scanResult.workVolumeFaulted) {
            workVolumeFaultReported = true;
          }

          // --- Idle-task issue filer (Issue #2005, #2023, #2048) ---
          // After a Priority 2 scan that found no claimable issue, fire
          // the framework filer so an `idle-task` issue is raised
          // against one of the monitored repos. The next
          // priority-dispatch iteration will then claim and execute it
          // like any other labelled issue. The filer shuffles the
          // monitored-repo list randomly and picks the first repo with
          // no open `idle-task` issue — no last-scan timestamps or
          // idle-cycle counters are needed. Best-effort: any throw is
          // logged and the loop continues.
          //
          // Issue #2048: gate on `foundClaimableIssue` (set only from
          // the Priority 2 success path) instead of `scanHadSuccess`
          // (which any Priority 1–1.85 handler flips). The previous
          // broad gate suppressed the filer whenever PR feedback,
          // planning, or any other priority handler processed work in
          // an adjacent repo — even when no claimable issue existed
          // anywhere — which is the symptom Issue #2046 captured.
          //
          // Issue #2018: emit a single `[idle-hooks]` decision line
          // every iteration so operators can see, from the log alone,
          // whether the filer was invoked or skipped. Both flags appear
          // in every line so operators can tell at a glance which
          // signal drove the decision.
          const flagFragment =
            `foundClaimableIssue=${tracker.foundClaimableIssue} scanHadSuccess=${tracker.scanHadSuccess}`;
          if (!tracker.foundClaimableIssue) {
            // Issue #2106: run the idle-detect audit at the same gate
            // as the filer so its `[idle-detect] ...` lines (and the
            // `mis_classification` ALERT when the probe disagrees with
            // the scan) appear in the log immediately before the filer
            // makes its decision. Best-effort — any throw is caught
            // and logged so an audit failure never aborts the loop.
            let auditClaimableTotal: number | null = null;
            if (deps.runIdleDetectAudit) {
              idleDetectTick += 1;
              try {
                const auditResult = await deps.runIdleDetectAudit({
                  tick: idleDetectTick,
                  scanFoundClaimable: tracker.foundClaimableIssue,
                });
                if (
                  auditResult !== undefined &&
                  typeof auditResult.claimableTotal === "number"
                ) {
                  auditClaimableTotal = auditResult.claimableTotal;
                }
              } catch (auditErr) {
                const msg = auditErr instanceof Error
                  ? auditErr.message
                  : String(auditErr);
                deps.log(`Idle-detect audit failed (continuing): ${msg}`);
              }
            }
            // Issue #2811: emit the per-repo claimable-work census at the
            // idle-task filing decision point so the idle-vs-work-on
            // inversion is observable from the log alone. Best-effort —
            // any throw is caught and logged, never aborting the loop
            // (mirrors the `Idle-task filer failed (continuing)` pattern).
            // Issue #2813: capture the census's fleet-global inversion
            // verdict (cache-backed — no extra issue-list call) so it can
            // suppress the filer below when real work exists anywhere in
            // the monitored set, even when it was only deferred this cycle.
            //
            // Issue #437: the census is also told whether the scan
            // completed an eligibility pass this cycle. Every VibeCoder
            // inversion alert on 2026-08-26 followed a `stop reason=deadline`
            // line by about a minute — the scan had stopped before its next
            // claim and never evaluated the backlog — yet three such cycles
            // escalated to a human as "the claim scan keeps refusing" work
            // nothing had refused.
            let censusInversionDetected = false;
            if (deps.runIdleDecisionCensus) {
              try {
                const censusResult = await deps.runIdleDecisionCensus({
                  decisionPoint: "filing",
                  claimScanCompleted:
                    scanResult.eligibilityScanCompleted === true,
                  // Issue #460: a repo the scan served is not one it refused.
                  claimedRepos: [...tracker.claimedRepos],
                });
                if (
                  censusResult !== undefined &&
                  censusResult.inversionDetected === true
                ) {
                  censusInversionDetected = true;
                }
              } catch (censusErr) {
                const msg = censusErr instanceof Error
                  ? censusErr.message
                  : String(censusErr);
                deps.log(`Idle-decision census failed (continuing): ${msg}`);
              }
            }
            // Budget guard: when the audit's independent probe already
            // sees claimable work somewhere in the monitored set, the
            // scan loop's `foundClaimableIssue=false` is almost
            // certainly mis-classification (see Issue #2106 and the
            // private-repo-10 #45-#48 incident). Filing more `idle-task`
            // wrappers won't help and burns GraphQL budget the next
            // iteration needs to actually claim the existing ones, so
            // skip the filer this iteration. The next iteration's
            // scan gets a fresh chance to pick up the existing
            // claimable issues.
            //
            // Issue #2475: bound the short-circuit so a *persistent*
            // disagreement cannot suppress filing indefinitely. Each
            // disagreement iteration increments a streak and emits a
            // structured diagnostic; while the streak stays within
            // AUDIT_DISAGREEMENT_SKIP_LIMIT the filer is skipped as
            // before, but once it exceeds the bound exactly ONE filer
            // attempt is forced through and the streak resets — so a
            // durable disagreement still produces wrappers without
            // re-introducing the #2106 wrapper flooding.
            const auditDisagrees = auditClaimableTotal !== null &&
              auditClaimableTotal > 0;
            if (censusInversionDetected) {
              // Issue #2813: the cache-backed census found an open,
              // unblocked top-priority/work-on/low-priority issue
              // somewhere in the monitored set — even if it was only
              // deferred this cycle by nice/rotation/cooldown. The fleet
              // has real work, so filing an idle-task would invert
              // priority (#2806). Suppress the filer this iteration.
              //
              // Issue #3526: the suppression participates in the same
              // #2475 bound as the audit disagreement instead of clearing
              // the streak. The census does not model every rule the scan
              // applies (open-PR blocking, milestone occupancy, TOCTOU,
              // cooldowns), so its "there is work" verdict can be wrong
              // about work the scan will never claim — in the host-23
              // incident one open PR made the whole low-priority backlog
              // unclaimable while the census counted it as available, and
              // the then-unconditional streak reset suppressed the filer
              // for hours. Once the streak exceeds the bound, exactly ONE
              // filer attempt is forced through and the streak resets, so
              // a durable census/scan divergence still produces wrappers
              // without re-introducing the #2106 wrapper flooding.
              auditDisagreementStreak += 1;
              if (
                auditDisagreementStreak > AUDIT_DISAGREEMENT_SKIP_LIMIT &&
                deps.runIdleTaskFiler
              ) {
                deps.log(
                  `[idle-hooks] ${flagFragment} invoking=idle-task-filer reason=census_inversion_bound_exceeded streak=${auditDisagreementStreak} limit=${AUDIT_DISAGREEMENT_SKIP_LIMIT}`,
                );
                auditDisagreementStreak = 0;
                try {
                  await deps.runIdleTaskFiler();
                } catch (filerErr) {
                  const msg = filerErr instanceof Error
                    ? filerErr.message
                    : String(filerErr);
                  deps.log(`Idle-task filer failed (continuing): ${msg}`);
                }
              } else {
                deps.log(
                  `[idle-hooks] ${flagFragment} skipping=idle-task-filer reason=unblocked_work_exists streak=${auditDisagreementStreak} limit=${AUDIT_DISAGREEMENT_SKIP_LIMIT}`,
                );
              }
            } else if (auditDisagrees && deps.runIdleTaskFiler) {
              auditDisagreementStreak += 1;
              // Structured diagnostic on every disagreement so the
              // scan/probe mismatch is observable per iteration.
              deps.log(
                `[idle-hooks] ${flagFragment} action=audit_scan_disagreement claimable_total=${auditClaimableTotal} streak=${auditDisagreementStreak} limit=${AUDIT_DISAGREEMENT_SKIP_LIMIT}`,
              );
              if (auditDisagreementStreak > AUDIT_DISAGREEMENT_SKIP_LIMIT) {
                // Bound exceeded: force a single filer attempt, then
                // reset the streak so we do not file again until the
                // disagreement persists for another full bound.
                deps.log(
                  `[idle-hooks] ${flagFragment} invoking=idle-task-filer reason=audit_disagreement_bound_exceeded streak=${auditDisagreementStreak} limit=${AUDIT_DISAGREEMENT_SKIP_LIMIT}`,
                );
                auditDisagreementStreak = 0;
                try {
                  await deps.runIdleTaskFiler();
                } catch (filerErr) {
                  const msg = filerErr instanceof Error
                    ? filerErr.message
                    : String(filerErr);
                  deps.log(`Idle-task filer failed (continuing): ${msg}`);
                }
              } else {
                deps.log(
                  `[idle-hooks] ${flagFragment} skipping=idle-task-filer reason=audit_found_claimable claimable_total=${auditClaimableTotal} streak=${auditDisagreementStreak}`,
                );
              }
            } else if (deps.runIdleTaskFiler) {
              // No disagreement (probe agreed, audit unavailable, or no
              // positive claimable total) — reset the streak and file as
              // usual.
              auditDisagreementStreak = 0;
              deps.log(
                `[idle-hooks] ${flagFragment} invoking=idle-task-filer`,
              );
              try {
                await deps.runIdleTaskFiler();
              } catch (filerErr) {
                const msg = filerErr instanceof Error
                  ? filerErr.message
                  : String(filerErr);
                deps.log(`Idle-task filer failed (continuing): ${msg}`);
              }
            } else {
              deps.log(
                `[idle-hooks] ${flagFragment} skipping=idle-task-filer reason=no_hook`,
              );
            }
          } else {
            // Issue #2475: the scan found claimable work, so there is no
            // disagreement to bound — clear the streak.
            auditDisagreementStreak = 0;
            deps.log(
              `[idle-hooks] ${flagFragment} skipping=idle-task-filer reason=found-issue`,
            );
          }

          // --- Per-iteration `gh` call telemetry summary (Issue #1671) ---
          // One structured line per loop iteration so we can baseline the
          // reduce-gh-calls work (#1662) and verify subsequent caching
          // changes actually reduce calls.
          deps.log(formatGhCallSummary());
          // Issue #4299: where the cycle's wall time went, longest first.
          deps.log(formatCycleTimingsSummary(deps.now()));
          // Issue #1845: per-priority breakdown lets a future regression
          // surface the responsible priority directly in the worker log.
          deps.log(formatGhCallsByPrioritySummary());
          // Issue #1924: GraphQL-specific breakdown — the 5000-point/hour
          // GraphQL quota is metered separately from REST, and the
          // worker has been observed exhausting it every cycle. This
          // line names the hottest GraphQL call site so operators can
          // see at a glance which path is burning the budget.
          deps.log(formatGraphQLSummary());

          // --- Liveness guard (Issue #2479) ---
          // Best-effort end-of-cycle observation. The combined #2478 guard
          // unions productive work (#2476) with idle-task claims (#2477)
          // across the fleet and alerts on a dual-silent 8h window. Run on
          // a bounded cadence so the guard's `2 × repos` `gh` probes do not
          // multiply the loop's API cost every cycle. Any throw is caught
          // and logged so the guard can never abort the loop.
          if (deps.checkLivenessWindow) {
            livenessTick += 1;
            if (livenessTick % LIVENESS_CHECK_CADENCE === 1) {
              try {
                await deps.checkLivenessWindow({ tick: livenessTick });
              } catch (livenessErr) {
                const msg = livenessErr instanceof Error
                  ? livenessErr.message
                  : String(livenessErr);
                deps.log(`Liveness guard failed (continuing): ${msg}`);
              }
            }
          }

          // --- End-of-cycle sleep ---
          if (tracker.scanHadSuccess) {
            await deps.circuitBreakerReset();
            const jitteredSleep = sleepWithJitter(config.sleepInterval);
            await deps.sleep(jitteredSleep * 1000);
          } else {
            await deps.circuitBreakerRecordZeroProgress();
            const backoffInterval = await deps.circuitBreakerGetSleepInterval();
            const jitteredSleep = sleepWithJitter(backoffInterval);
            await deps.sleep(jitteredSleep * 1000);
          }

          // Issue #2427: the resume skip applies once. After a full sweep
          // completes, subsequent iterations dispatch from Priority 1.
          skipBelowPriority = 1;
        }
      } catch (innerErr) {
        // Issue #1780: a primary rate-limit thrown mid-cycle pauses the
        // worker until the quota refreshes, then re-enters the inner
        // while. Other errors fall through to the outer catch.
        const innerMessage = innerErr instanceof Error
          ? innerErr.message
          : String(innerErr);
        if (!isPrimaryRateLimitMessage(innerMessage)) {
          throw innerErr;
        }
        let resetEpoch: number;
        try {
          resetEpoch = await deps.getRateLimitReset();
        } catch (resetErr) {
          const msg = resetErr instanceof Error
            ? resetErr.message
            : String(resetErr);
          deps.log(
            `Failed to fetch rate-limit reset (${msg}) — falling back to a 1h wait`,
          );
          resetEpoch = Math.floor(deps.now() / 1000) + 3600;
        }
        deps.log(
          `Primary rate limit hit mid-cycle — pausing until reset ${
            formatRateLimitReset(resetEpoch, Math.floor(deps.now() / 1000))
          }. ${innerMessage}`,
        );
        const wait = await pauseUntilRateLimitReset(
          resetEpoch,
          "Main loop catch",
        );
        if (wait.outcome === "ok" || wait.outcome === "cap") {
          // Quota cleared (or cap reached — try anyway). Re-enter the
          // inner while to keep working without a respawn.
          resumeAfterRateLimit = true;
        }
        // "shutdown" and "duration" fall through to the planned-shutdown
        // path so the run ends cleanly.
      }
    }

    // The run is ending (Issue #4369): terminate any agent still running
    // (an abandoned handler's, an in-flight retry's) and refuse relaunches,
    // BEFORE the exit cleanup's descendant sweep — otherwise the sweep's
    // SIGTERM is misread downstream and the agent is spawned again after
    // "Run complete".
    if (deps.terminateActiveAgentRuns) {
      try {
        await deps.terminateActiveAgentRuns("run ending");
      } catch { /* best-effort */ }
    }

    // --- Planned shutdown ---
    if (!exitedOnFailures) {
      plannedShutdown = true;
    }

    // Measure where the bytes actually are (Issue #345): the cycle-start
    // walk lands ~2 minutes in, before the clones a cycle creates exist, so
    // it can describe an empty work root. End of run is when the volume is
    // at its fullest — the sample that would have warned before GRQ-23
    // filled up. `force` skips the walk's cadence so this is a fresh
    // reading, not a replay of the cycle-start one.
    await logWorkVolumeUsage(deps, {
      label: "Work volume (end of run)",
      force: true,
    });

    // Write fault tolerance summary (Issue #1173)
    const counterSummary = formatCounterSummary();
    if (counterSummary) {
      deps.log(counterSummary);
    }
    await deps.writeFaultToleranceSummary();

    deps.logWorkerSummary(
      tracker.issuesProcessed,
      (deps.now() - startTime) / 1000,
    );
    deps.log("Run duration complete. Exiting for refresh.");

    return buildResult(
      exitedOnFailures
        ? "Consecutive failure threshold reached"
        : spendCeilingReached
        ? "Daily spend ceiling reached"
        : shutdownRequested
        ? "Shutdown signal received"
        : "Run duration expired",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Issue #1523 (graceful exit) → Issue #1780 (pause-and-resume).
    // Primary rate-limit errors are handled by the inner-catch retry
    // loop above and never reach this outer catch. Anything that does
    // reach here is either an unexpected error from outside the inner
    // while (e.g. preflight, init) or a non-rate-limit fatal error —
    // crash-notify and exit.
    if (isPrimaryRateLimitMessage(message)) {
      // Issue #342: the run is ending because the quota is gone, not because
      // anything broke — the same scheduled outcome as the in-loop pause.
      quotaPaused = true;
      let resetFragment = "";
      try {
        const resetEpoch = await deps.getRateLimitReset();
        quotaResetEpochSeconds = resetEpoch;
        resetFragment = ` — quota resets ${
          formatRateLimitReset(resetEpoch, Math.floor(deps.now() / 1000))
        }`;
      } catch {
        // Best-effort enrichment only — fall back to the bare log if the
        // free `gh api rate_limit` lookup fails (e.g. transient gh error).
      }
      deps.log(
        `Main loop halting: primary rate limit reached outer catch${resetFragment} — will retry on next cycle. ${message}`,
      );
      return buildResult("Primary rate limit exhausted");
    }

    // Unexpected fatal error
    deps.logError(`Fatal error in main loop: ${message}`);
    try {
      await deps.sendCrashNotification(message);
    } catch { /* best-effort */ }
    return buildResult(`Fatal error: ${message}`);
  } finally {
    // --- Cleanup ---
    // Issue #2670 (shutdown/rate-limit path): the per-issue claim is released
    // inside the scan loop (success/failure/skip). For an issue interrupted
    // mid-processing, `cleanupInProgressIssue()` unassigns the worker — so the
    // shutdown path also leaves nothing assigned. The `clearHeartbeat()` below
    // only clears the generic run-core marker (no specific issue in scope).
    try {
      await deps.cleanupInProgressIssue();
    } catch { /* best-effort */ }
    try {
      await deps.clearHeartbeat();
    } catch { /* best-effort */ }
    try {
      deps.resetWindowTitle();
    } catch { /* best-effort */ }
    try {
      await deps.setStatusIdle();
    } catch { /* best-effort */ }
    try {
      await deps.releasePidFile();
    } catch { /* best-effort */ }

    // Remove signal listeners
    try {
      deps.removeSignalListener("SIGTERM", shutdownHandler);
      deps.removeSignalListener("SIGINT", shutdownHandler);
    } catch { /* best-effort */ }
  }
}
