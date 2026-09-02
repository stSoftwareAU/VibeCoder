/**
 * Production dependency wiring for the run-core main event loop.
 *
 * Connects the RunCoreDeps interface to real Deno library implementations,
 * replacing the shell priority dispatch that was previously in run_core.sh
 * (lines 576–1086).
 *
 * Issue #1124: Wire Deno run_core.ts as primary executor.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitHubClient, Logger, WorkerConfig } from "../types.ts";
import { isTimeoutClassFailureReason } from "./failure_diagnosis.ts";
import {
  isExpectedSkipResult,
  type IssueContext,
} from "./issue_worker_types.ts";
import type {
  DiscoveredIssue,
  HandlerExecuteOptions,
  PriorityHandlerResult,
  RunCoreConfig,
  RunCoreDeps,
} from "./run_core.ts";
import { createDefaultRunCoreConfig } from "./run_core.ts";
import { acquireMaintenanceRepoLease } from "./maintenance_lane.ts";
import { drainConflictingPrs } from "./merge_conflict_drain.ts";
import { reactivePhaseTimeout } from "./reactive_phase_timeout.ts";

// Config & logging
import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { buildDefaultWorkerConfig } from "./config_defaults.ts";
import {
  setSuppressionAuthorAllowlist,
  setSuppressionFleetLogins,
} from "./suppression_comments.ts";
import {
  setPhaseEffortConfigOverrides,
  setPhaseModelConfigOverrides,
} from "./claude_executor.ts";
import {
  setCodexPhaseEffortConfigOverrides,
  setCodexPhaseModelConfigOverrides,
} from "./codex_executor.ts";
import { setGeminiPhaseModelConfigOverrides } from "./gemini_executor.ts";
import { setDeepSeekPhaseModelConfigOverrides } from "./deepseek_executor.ts";

// Health checks
import {
  checkClaudeHealth as claudeHealthCheck,
  checkFableAvailability as probeFableAvailability,
} from "./claude_runner.ts";
import { checkGhAuth as ghAuthCheck } from "./gh_auth.ts";
import {
  createSpendCeilingCheck,
  CREDIT_LOG_DIR_ENV,
  resolveCreditLogDir,
  resolveSpendCeilingUsd,
  SPEND_CEILING_ENV,
} from "./spend_ceiling.ts";
import {
  invalidateHealthCache,
  isHealthCacheValid,
  recordHealthCheckSuccess,
} from "./health_check_cache.ts";

// Issue finding
import { findIssuesByLabel, findOldestIssue } from "./issue_finder.ts";
import { IssueCache } from "./issue_cache.ts";
import type {
  BlockedCandidateInfo,
  DiagnosticSummary,
} from "./issue_finder_logger.ts";
import {
  fetchAllOpenPRs,
  fetchOpenPRsByUser,
  fetchRecentlyClosedPRsForFleet,
} from "./issue_query.ts";
import { TimelineCache } from "./timeline_cache.ts";
import { TimelineBatchRegistry } from "./timeline_batch_registry.ts";
import { clearCommentCache } from "./comment_cache.ts";
import { resetRepoAccessLogState } from "./monitored_repo_access.ts";

// Issue processing
import { stopAllHeartbeats, stopHeartbeatsExcept } from "./heartbeat.ts";
import { workOnIssue } from "./issue_worker.ts";
import { createDefaultDeps, type WorkerDeps } from "./issue_worker_wiring.ts";
import { fetchIssueData, type IssueData } from "./issue_data.ts";
import { stripDiscoveryLabelsOnEscalation } from "./escalation_cleanup.ts";
import { routeIdleTaskInProcessIssue } from "./idle_task_process_issue_route.ts";
import { verifyPickupContentIntegrity } from "./pickup_content_integrity.ts";
import { routeAddRepoInProcessIssue } from "./add_repo_process_issue_route.ts";
import { routeSeedIdleTasksInProcessIssue } from "./seed_idle_tasks_process_issue_route.ts";

// PR maintenance
import {
  findFailedCiChecks,
  findFailedPrChecks,
  findPrCommentsToFix,
} from "./pr_maintenance.ts";
import { processPrFeedback } from "./pr_feedback_processor.ts";
import { maybeFileIdleTaskCommand } from "../commands/maybe_file_idle_task.ts";
import { runIdleTaskFilerCycle } from "./idle_task_filer_run.ts";
import {
  readScanCursor,
  resetScanCursor,
  scanCursorPath,
  writeScanCursor,
} from "./scan_cursor.ts";
import { processSpellingFailure } from "./pr_spelling_processor.ts";
import { processCiFailure } from "./pr_ci_processor.ts";
import { resolveMaxAutoFixAttempts } from "./auto_fix_attempt_tracker.ts";
import {
  findPrsNeedingCiNudge,
  processCiNudgeCandidate,
} from "./pr_ci_nudge_scan.ts";
import { scanBlockingPrStalls as libScanBlockingPrStalls } from "./blocking_pr_stall_detector.ts";
import { findConflictingPr } from "./pr_merge_conflict_scan.ts";
import { processMergeConflict } from "./pr_merge_conflict_processor.ts";
import { cleanupMergedPrBranches } from "./branch_cleanup.ts";
import {
  mergedReconcileWatermarkPath,
  mergedSweepWatermarkPath,
} from "./merged_sweep_watermark.ts";
import { emitSelfHealEventAuto } from "./self_heal_events.ts";
import {
  executePrBranchUpdates,
  isWorkerPr,
  makeGhPrStateFetcher,
  type PrBranchEntry,
  type PrBranchStateEntry,
  scanPrBranchUpdates,
} from "./pr_branch_update.ts";
import { fetchPRBranchStateBatch } from "./pr_branch_state.ts";
import { prBranchFailureStatePath } from "./pr_branch_update_failure_streak.ts";
import { getRepoDefaultBranch } from "./shell_helpers.ts";
import { setupRepo } from "../commands/git_operations.ts";
import { ensureRepoClone } from "./ensure_repo_clone.ts";
import {
  detachLaneWorktreeHead,
  ensureLaneWorktree,
  PR_BRANCH_UPDATE_LANE_ID,
} from "./lane_worktree.ts";
import { updatePrBranch } from "./git_pull.ts";
import { runGitCommand } from "./git_timeout.ts";
import {
  buildCheckoutArgs,
  buildFetchArgs,
  buildPullArgs,
} from "./git_ref_args.ts";
import { getWorkerUniqueId } from "./worker_identity.ts";
import {
  buildQualityInstructions,
  getCustomInstructions,
  getRepoNice,
} from "./repo_config.ts";
import { fetchAllIssues } from "./issue_query.ts";
import {
  buildIdleDecisionCensus,
  formatIdleDecisionCensus,
  type RepoCensusSkipReason,
} from "./idle_decision_census.ts";

// Label-based processors
import { processIssueRefinement } from "./refinement_processor.ts";
import { processIssueQuestion } from "./question_processor.ts";
import { processIssuePlanning } from "./planning_processor.ts";
import { processGrillMe } from "./grill_me_processor.ts";
import { processQuorum } from "./quorum_processor.ts";

// Failure & circuit breaker
import {
  type FailureTrackerConfig,
  resetFailures as failureTrackerReset,
  shouldExitOnFailures as failureTrackerShouldExit,
  trackFailure as failureTrackerTrack,
} from "./failure_tracker.ts";
import {
  type CooldownConfig,
  loadState as loadCooldownState,
  recordIssueCooldown as cooldownRecordFn,
} from "./cooldown_state.ts";
// Adaptive claim floor (Issue #245): the evidence lookup and the key the
// per-cycle deferral set is written with.
import { fetchIssueClaimEvidence } from "./claim_evidence_lookup.ts";
import {
  adaptiveFloorStatePath,
  clearAdaptiveFloorDeferral,
  recordAdaptiveFloorDeferral,
} from "./adaptive_floor_starvation.ts";
import { issueClaimKey } from "./claim_runway_evidence.ts";
import type { ClaimHardCap } from "./claim_runway.ts";
import { resolveRunHardCap } from "./run_hard_cap.ts";
import {
  type CircuitBreakerConfig,
  getSleepInterval as circuitBreakerGetSleep,
  recordZeroProgress,
  reset as circuitBreakerResetFn,
} from "./circuit_breaker.ts";
import {
  recordRepoFailure as repoTrackerRecordFailure,
  recordRepoSuccess as repoTrackerRecordSuccess,
  type RepoFailureTrackerConfig,
  resetRepoFailures as repoTrackerReset,
} from "./repo_failure_tracker.ts";
import {
  isRateLimitActive as rateLimitSignalIsActive,
  writeRateLimitSignal,
} from "./rate_limit_signal.ts";
import { preflightGitHubRateLimit } from "./github_rate_limit_preflight.ts";
import { runGhCommandRaw } from "./github.ts";

// Liveness guard (Issue #2479)
import { checkLivenessWindow } from "./liveness_guard.ts";

// Crash handling
import { cleanupInProgressIssue as crashCleanupFn } from "./crash_cleanup.ts";
import {
  type CrashNotificationConfig,
  resolveCrashStateDir,
  sendCrashNotification as crashNotifyFn,
} from "./crash_notification.ts";
import { resolveCiCheckStateDir } from "./ci_check_state_dir.ts";
import {
  clearHeartbeat as libClearHeartbeat,
  detectAndRecoverStuckIssues as recoverStuckFn,
  detectAssignedWithClosedPr as recoverClosedPrFn,
  detectAssignedWithoutHeartbeat as recoverNoHeartbeatFn,
  type HeartbeatMarkerOptions,
  recordHeartbeat as libRecordHeartbeat,
  recordMilestone as libRecordMilestone,
  recoverStaleGithubAssignments as recoverStaleAssignmentsFn,
  releaseClaim as libReleaseClaim,
  type StuckIssueConfig,
} from "./stuck_issue_detector.ts";
import {
  deleteResumeState,
  resumeStateSurvivesRelease,
} from "./resume_state_store.ts";
import {
  type FleetAuthorSetInput,
  resolveFleetPrAuthorSet,
  resolveSuppressionExcludedLogins,
} from "./fleet_authors.ts";
import {
  clearIdleInversion,
  idleInversionStatePath,
  recordIdleInversion,
} from "./idle_inversion_streak.ts";
import { resolveRunId } from "./audit_journal.ts";
import { createTrustSnapshotHolder } from "./trust_snapshot.ts";
import { readQuotaOutage } from "./rate_limit_signal.ts";
import { formatCoarseDuration } from "./rate_limit_wait.ts";
/**
 * A quota outage at least this long makes the host unhealthy (Issue #333).
 * Six hours: longer than the five-hour subscription window, so an ordinary
 * mid-cycle lapse never flags a host, and any weekly limit always does.
 */
const QUOTA_OUTAGE_UNHEALTHY_SECONDS = 6 * 3600;

import {
  formatDerivedAuthorsFoldSummary,
  intersectDerivedAuthors,
  resolveDerivedAuthors,
} from "./derived_authors.ts";
import { getMachineId } from "./machine_id.ts";

// Fault tolerance observability (Issue #1173)
import { writeSummary as writeFtSummary } from "./fault_tolerance_counters.ts";

// Infrastructure
import {
  checkAndCleanupDiskSpace,
  DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD,
  DEFAULT_DISK_CLEANUP_THRESHOLD,
  type DiskCheckOptions,
  type DiskCheckResult,
} from "./disk_space.ts";
import { checkAndRotateLog } from "./log_rotation.ts";
import { shuffleArray } from "./array_utils.ts";
import { isRepoAllowed } from "./config_validator.ts";
import { isAuthorisedCommenter } from "./security.ts";
import { createGitHubClient, runGhCommand } from "./github.ts";
import { InFlightRepoRegistry } from "./in_flight_repos.ts";
import { setLiveSlotHolds } from "./live_slot_holds.ts";
import { setScanCacheForCloseInvalidation } from "./issue_close_notifier.ts";
import { sharedProcessedIssues } from "./processed_issue_registry.ts";
import { SlotGovernor } from "./slot_governor.ts";
import type { RunOutcome } from "./run_outcome.ts";
import {
  resetAgentRunsTerminating,
  terminateActiveAgentRuns,
} from "./claude_runner.ts";
import { fileRunFailureIssue } from "./run_failure_issue.ts";
import { setMarkerReleaseHook } from "./claim_release.ts";
import { readMarkerState } from "./heartbeat_storage.ts";
import { probeHostMemoryPressure } from "./memory_pressure.ts";
import { escalateToHuman } from "./needs_human_escalation.ts";
import { runFailureDetectionResumePass } from "./failure_detection_resume.ts";
import { ensureLabelExists as ensureLabelExistsFn } from "./label_operations.ts";
import {
  createFeatureRegistry,
  registerBuiltinFeatures,
} from "./feature_availability.ts";
import {
  checkSoftwareUpdates,
  softwareUpdateOptionsFromEnv,
} from "./software_updates.ts";
import { enableAutoMerge, logAutoMergeOutcome } from "./pr_auto_merge.ts";
import { closeIssuesForMergedPrs as prIssueCloseForMerged } from "./pr_issue_linking.ts";
import { formatGb, HostDiskMonitor } from "./host_disk.ts";
import { assessDiskTelemetry } from "./disk_telemetry.ts";
import {
  reclaimWorkVolumeTiers,
  summariseWorkVolumeTiers,
} from "./work_volume_tiers.ts";
import { workVolumeFault } from "./work_volume_fault.ts";
import { WorkVolumeMonitor } from "./work_volume_monitor.ts";
import { describeGuestReclaimToHost } from "./work_volume_ratchet.ts";

// FLEET health
import { claimSuppressedNote } from "./claim_gate_health_note.ts";
import {
  buildFleetHealthConfig,
  createProductionFleetHealthDeps,
  fleetHealthCheckoutDirName,
  runFleetHealthReporting,
} from "./fleet_health.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for creating production RunCoreDeps. */
export interface ProductionDepsOptions {
  /** Repository root directory. */
  repoDir: string;
  /** Worker work directory. */
  workDir: string;
  /** GitHub username. */
  githubUser: string;
  /** Optional logger override. */
  logger?: Logger;
  /** Optional config override. */
  config?: WorkerConfig;
  /**
   * Override the derived-author resolver (Issue #256). Production leaves
   * this unset and gets {@link resolveDerivedAuthors}, which shells out to
   * `gh`. Tests inject a stub: the no-fallback rule is the security
   * guarantee of this sub-issue, and a test that proved it by letting a
   * real `gh` call fail would prove nothing on a host where `gh` works.
   */
  resolveTrustedAuthors?: typeof resolveDerivedAuthors;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * The claim gate's view of the supervisor hard cap (Issues #421/#425).
 *
 * A cap smaller than the kill-and-checkpoint reserve puts the ceiling at or
 * before the run's start, so `windowSeconds` is 0 and every claim is refused —
 * the fail-safe direction, and loudly: the slot logs `stop reason=hard-cap`.
 *
 * @param killAfterSeconds - The worker's own SIGTERM→SIGKILL grace.
 * @returns The cap, or undefined when this run is uncapped.
 */
function resolveClaimHardCap(
  killAfterSeconds: number,
): ClaimHardCap | undefined {
  const resolution = resolveRunHardCap({ killAfterSeconds });
  if (!resolution.capped) return undefined;
  const { ceilingMs, startedMs } = resolution.cap;
  return {
    ceilingMs,
    windowSeconds: Math.max(0, Math.round((ceilingMs - startedMs) / 1000)),
  };
}

/**
 * Create production RunCoreDeps wired to real implementations.
 *
 * This factory connects every RunCoreDeps method to its corresponding
 * Deno library function, replacing the shell-level orchestration that
 * previously existed in run_core.sh.
 */
export async function createProductionRunCoreDeps(
  options: ProductionDepsOptions,
): Promise<{ deps: RunCoreDeps; config: RunCoreConfig; cleanup: () => void }> {
  const { repoDir, workDir, githubUser } = options;

  // Load config
  const configPath = Deno.env.get("CONFIG_PATH") ?? `${repoDir}/.config.json`;
  let config: WorkerConfig;
  try {
    config = options.config ?? await loadConfig(configPath);
  } catch {
    config = buildDefaultWorkerConfig();
  }
  // Apply phase model config overrides (Issue #1265)
  setPhaseModelConfigOverrides(config.phaseModelOverrides);
  // Apply phase effort config overrides (Issue #1403)
  setPhaseEffortConfigOverrides(config.phaseEffortOverrides);
  // Apply the Codex phase model/effort config overrides (Issue #363)
  setCodexPhaseModelConfigOverrides(config.codexPhaseModelOverrides);
  setCodexPhaseEffortConfigOverrides(config.codexPhaseEffortOverrides);
  // Apply the Gemini phase model config overrides (Issue #364)
  setGeminiPhaseModelConfigOverrides(config.geminiPhaseModelOverrides);
  // Apply the DeepSeek phase model config overrides (Issue #413)
  setDeepSeekPhaseModelConfigOverrides(config.deepseekPhaseModelOverrides);
  // Wire the suppression author allowlist from the trusted-author snapshot
  // (Issue #253). Unconfigured, the suppression gate fails closed
  // (Issue #3941). Re-applied on every refresh so a later source flip
  // cannot leave the gate holding a start-up copy.

  // Logger writes to both stderr and ~/logs/worker.log (symlinked to the
  // per-PID log file by run_core.sh). No env var or config needed.
  let logger: Logger;
  let logFileHandle: Deno.FsFile | undefined;
  if (options.logger) {
    logger = options.logger;
  } else {
    const home = Deno.env.get("HOME") ?? "~";
    const workerLogPath = `${home}/logs/worker.log`;
    try {
      logFileHandle = await Deno.open(workerLogPath, {
        write: true,
        append: true,
        create: true,
      });
    } catch { /* fall back to stderr-only */ }
    const encoder = new TextEncoder();
    const handle = logFileHandle;
    logger = createLogger({
      debug: Deno.env.get("DEBUG") === "true",
      write: handle
        ? (msg: string) => {
          console.error(msg);
          try {
            handle.writeSync(encoder.encode(msg + "\n"));
          } catch { /* best-effort */ }
        }
        : undefined,
    });
  }

  // --- Daily spend ceiling (Issue #3684) ---
  // Opt-in: unset or `0` leaves the hook unwired and behaviour unchanged. A
  // malformed value throws here, failing the run at start-up rather than
  // silently disabling the guard.
  const spendCeilingUsd = resolveSpendCeilingUsd(
    Deno.env.get(SPEND_CEILING_ENV),
  );
  const creditLogDir = resolveCreditLogDir(
    workDir,
    Deno.env.get(CREDIT_LOG_DIR_ENV),
  );
  const checkSpendCeiling = createSpendCeilingCheck({
    logDir: creditLogDir,
    ceilingUsd: spendCeilingUsd,
    logError: (msg: string) => logger.error(msg),
  });
  if (checkSpendCeiling) {
    logger.info(
      `Daily spend ceiling: $${
        spendCeilingUsd.toFixed(2)
      } (credit log: ${creditLogDir})`,
    );
  }

  // Create worker deps for issue processing
  // Share the file-backed logger (Issue #4320): without it every
  // issue-phase line — including the #4169/#4305 progress heartbeats —
  // reached the console but never worker.log, so the file read as a
  // wedged worker while the run was fine.
  const workerDeps = createDefaultDeps({ logger });
  const inFlightRepos = new InFlightRepoRegistry();
  // The recovery and cleanup passes consult these holds before unassigning
  // anything (Issue #214), so an in-flight claim's assignee is only ever
  // removed by the owning slot's release.
  setLiveSlotHolds(() => inFlightRepos.heldIssues());
  // One process is one run: a fresh run may spawn agents again (Issue #4369).
  resetAgentRunsTerminating();
  let lastStatusLine: string | undefined;
  // Memory-pressure slot governor (Issue #4179): portable probe, bounded
  // cadence; transitions are logged with the reading.
  const slotCeiling = new SlotGovernor({
    probe: () => probeHostMemoryPressure(),
    log: (message: string) => logger.info(message),
  });
  // Host free-disk monitor (Issue #226): the launcher's df baseline plus
  // the work volume's growth since launch; native mode reads df directly.
  const hostDisk = new HostDiskMonitor({
    workDir,
    log: (message: string) => logger.info(message),
    // Issue #732: the floor this deployment states, so the worker claims at
    // the floor the launcher heals at — `.config.json` first, then the
    // environment override, then the default.
    floors: {
      ...(config.hostDiskLowFloorGb === undefined
        ? {}
        : { hostDiskLowFloorGb: config.hostDiskLowFloorGb }),
      ...(config.hostDiskLowFloorPercent === undefined
        ? {}
        : { hostDiskLowFloorPercent: config.hostDiskLowFloorPercent }),
    },
  });
  // Work-volume standing totals (Issues #244, #345): one shared reading feeds
  // the log line, the feature report and the fleet-health payload, so a probe
  // that cannot produce a value can never be advertised as `available`.
  const workVolume = new WorkVolumeMonitor({
    workDir,
    monitoredRepos: config.repos ?? [],
  });
  // Cache directories live on the durable work volume (Issue #4303) so a
  // relaunch inside the TTL — restart storms, back-to-back cycles — starts
  // warm instead of re-fetching everything. workDir is user-owned (not a
  // world-writable TMPDIR), so the tmp-privacy hardening is not needed here.
  const issueCache = new IssueCache(
    config.workDir ? `${config.workDir}/.gh-scan-cache` : undefined,
  );
  // Issue #181: a close the worker performs drops that repo's stale scan-cache
  // entries, so the next scan cannot rank an issue this run already closed.
  setScanCacheForCloseInvalidation(issueCache);
  // Issue #181: issues this run has already finished with. One process is one
  // run, so the shared registry is exactly this run's history — the `gh`
  // chokepoint records closes into it and `findNextIssue` excludes them.
  const processedIssues = sharedProcessedIssues();
  // Issue #1673: dedicated TTL cache for issue-timeline label events.
  const timelineCache = new TimelineCache(
    config.timelineCacheTtlSeconds,
    config.workDir ? `${config.workDir}/.gh-timeline-cache` : undefined,
  );
  // Issue #1783: iteration-scoped registry that coalesces timeline-batch
  // GraphQL calls across the four candidate collectors. Reset by
  // `resetIterationCaches` at every iteration boundary.
  const timelineBatchRegistry = new TimelineBatchRegistry();

  // Replace heartbeat functions with machineId-bound wrappers so every
  // production heartbeat publishes a GitHub marker (Issue #1454).

  // Config objects for sub-systems
  const failureConfig: FailureTrackerConfig = {
    workDir,
    maxConsecutiveFailures: 10,
    stateExpirySeconds: 3600,
  };

  const repoFailureFile = `${
    Deno.env.get("TMPDIR") ?? "/tmp"
  }/vibe-repo-failures-${Deno.pid}`;
  const repoFailureConfig: RepoFailureTrackerConfig = {
    failureFile: repoFailureFile,
    threshold: 3,
  };

  // Issue #580: the CI-check state lives on the work volume, not on a relative
  // path under the read-only checkout. The volume root rather than a repo
  // clone, so the counters survive a re-clone.
  //
  // Issue #552: resolved ONCE and shared, because the scanner and the
  // processor must address the same store. While the scanner kept the old
  // relative default it read retry counters that were never written there and
  // its green-build sweep cleared auto-fix budgets in a directory the
  // processor never touched — so a spent budget was never reset and the lane
  // escalated to a human instead of fixing the check.
  const ciCheckStateDir = resolveCiCheckStateDir(workDir);

  // Stable machine identifier used by GitHub heartbeat markers (Issue #1454)
  const machineId = await getMachineId(workDir);
  // Issue #253: trusted-author sets are a per-cycle snapshot, not values
  // captured once at start-up. The production refresh still copies the
  // static config arrays, so observable behaviour is unchanged; the
  // derived fleet-author sets are recomputed on every apply so they
  // cannot drift from the raw arrays (#4023/#4079).
  //
  // Issue #256: under `author_source: "github"` the seed is **empty**, not
  // the local arrays. The construction-time seed is live until the first
  // refresh lands, so seeding it from `allowed_authors` would make a
  // populated local list genuinely trusted for that window — the exact thing
  // the derived source is supposed to make impossible. Trust starts closed
  // and is opened only by a successful resolve; if the first resolve fails,
  // the skip-cycle gate stands the cycle down with nobody trusted, which is
  // the correct end state rather than a stale-list fallback.
  const trustSeed = config.authorSource === "github"
    ? { allowedAuthors: [], authorisedCommenters: [] }
    : {
      allowedAuthors: config.allowedAuthors ?? [],
      authorisedCommenters: config.authorisedCommenters ?? [],
    };
  const trustHolder = createTrustSnapshotHolder(
    {
      githubUser,
      fleetPrAuthors: config.fleetPrAuthors ?? [],
    },
    trustSeed,
  );
  // Issue #3164: only heartbeat/claim markers posted by a fleet account
  // suppress stale-assignment recovery. Resolve the same fleet-author union
  // (host login + allowed_authors + fleet_pr_authors) the label-authorship
  // and open-PR guards use so a forged marker from a non-fleet commenter
  // cannot pin an issue "in progress".
  let fleetAuthors = trustHolder.read().fleetAuthors;
  // Issue #4024: the single source of truth for "the PRs the fleet owns in
  // this repo". Every PR scan takes its author inputs from this object, and
  // `findOldestIssue` takes the resolved set so the blocking guard and the
  // maintenance scans are checked against each other once per iteration
  // rather than drifting in silence (#4023).
  const fleetPrAuthorInput = {
    githubUser,
    allowedAuthors: trustHolder.read().allowedAuthors,
    fleetPrAuthors: config.fleetPrAuthors ?? [],
  } satisfies FleetAuthorSetInput;
  // Issue #4079: the divergence check is only meaningful when it is fed the
  // set the maintenance scans genuinely use. Since #4076 that is the
  // push-capable set (host + `fleet_pr_authors`), so resolve it the same way
  // the scans do — feeding the wider fleet-owned set here would also make
  // the blocking-PR line's `in-maintenance-set=` flag claim a human's PR is
  // maintained when no scan touches it.
  let maintenanceAuthors = trustHolder.read().maintenanceAuthors;
  // Site 927 historically classified PR-feedback authors against
  // `allowedAuthors` (the const was named `authorisedCommenters`). Keep
  // that binding so this refactor is behaviour-neutral; the snapshot's
  // `authorisedCommenters` is what the comment-trust path (site 1616)
  // already read from `config.authorisedCommenters`.
  let authorisedCommenters = trustHolder.read().allowedAuthors;
  // The same union gates heartbeat marker adoption (Issue #3751) so a run
  // reuses the fleet's existing marker comment and never adopts a forged one.
  const defaultMarkerOptions: HeartbeatMarkerOptions = {
    machineId,
    allowedAuthors: fleetAuthors,
  };

  const stuckIssueConfig: StuckIssueConfig = {
    workDir,
    stuckIssueTimeout: 7200,
    assignedNoHeartbeatTimeout: 1800,
    staleAssignmentTimeout: 14400,
    repos: config.repos ?? [],
    machineId,
    fleetAuthors,
  };

  /**
   * Push a new snapshot into every consumer that used to hold a
   * construction-time copy (Issue #253).
   */
  function applyTrustSnapshot(sets: {
    allowedAuthors: string[];
    authorisedCommenters: string[];
  }): void {
    const snap = trustHolder.apply(sets);
    fleetAuthors = snap.fleetAuthors;
    authorisedCommenters = snap.allowedAuthors;
    fleetPrAuthorInput.allowedAuthors = snap.allowedAuthors;
    maintenanceAuthors = snap.maintenanceAuthors;
    defaultMarkerOptions.allowedAuthors = snap.fleetAuthors;
    stuckIssueConfig.fleetAuthors = snap.fleetAuthors;
    setSuppressionAuthorAllowlist(snap.allowedAuthors);
    // Issue #334: the service accounts belong in `allowed_authors` for
    // PR-dedup, so the allowlist above will contain them — but the fleet must
    // not be able to waive findings in code it wrote. The exclusion set is
    // `github_user ∪ fleet_pr_authors`, matching #3426: `allowed_authors`
    // itself would strip the humans who legitimately suppress.
    // Issues #334, #338: every fleet identity, including siblings configured
    // under `service_accounts` alone (#209). Hosts run under different git
    // users, so a login omitted from this set can suppress on every host but
    // its own.
    setSuppressionFleetLogins(
      resolveSuppressionExcludedLogins({
        githubUser,
        fleetPrAuthors: config.fleetPrAuthors,
        serviceAccounts: config.serviceAccounts,
      }),
    );
  }

  // Issue #256: identifies the cycle for the resolver's per-cycle cache, so
  // repeated reads inside one cycle cost no further `gh` calls.
  let trustRefreshCycle = 0;

  applyTrustSnapshot(trustSeed);

  // Bind default marker options so every recordHeartbeat/clearHeartbeat call
  // from the processors automatically publishes and maintains the GitHub
  // heartbeat marker (Issue #1454). Callers can still override by passing
  // their own markerOptions.
  const boundRecordHeartbeat: typeof libRecordHeartbeat = (
    w,
    r,
    i,
    nowFn,
    markerOpts,
  ) => libRecordHeartbeat(w, r, i, nowFn, markerOpts ?? defaultMarkerOptions);
  const boundClearHeartbeat: typeof libClearHeartbeat = (
    w,
    r,
    i,
    markerOpts,
  ) => libClearHeartbeat(w, r, i, markerOpts ?? defaultMarkerOptions);
  // Milestones (Issue #3753) share the same marker options so a progress
  // entry PATCHes the heartbeat comment this run already owns.
  const boundRecordMilestone: typeof libRecordMilestone = (
    w,
    r,
    i,
    text,
    markerOpts,
    nowFn,
  ) =>
    libRecordMilestone(
      w,
      r,
      i,
      text,
      markerOpts ?? defaultMarkerOptions,
      nowFn ?? (() => Math.floor(Date.now() / 1000)),
    );
  workerDeps.crashHandling.recordHeartbeat = boundRecordHeartbeat;
  workerDeps.crashHandling.clearHeartbeat = boundClearHeartbeat;
  workerDeps.crashHandling.recordMilestone = boundRecordMilestone;
  // The non-coding processors' shared release helper forwards the run
  // outcome to the marker path (Issue #4330) so their release comments say
  // what happened, exactly as the coding path's do.
  setMarkerReleaseHook(async (repo, issueNumber, outcome) => {
    await libClearHeartbeat(
      workDir,
      repo,
      issueNumber,
      defaultMarkerOptions,
      undefined,
      outcome,
    );
  });

  const crashConfig: CrashNotificationConfig = {
    workerName: "Vibe Coder",
    cooldownSeconds: 600,
    logTailMaxBytes: 50000,
    // The work volume inside the container, ~/.vibe-coder on the host: the
    // in-container ~/.vibe-coder is the root-owned image layer (Issue #515).
    stateDir: resolveCrashStateDir(workDir),
  };

  const cooldownConfig: CooldownConfig = {
    workDir,
    issueRetryCooldown: 600,
  };

  /**
   * The holds this run puts on an issue whatever GitHub says (Issue #655):
   * the persisted retry cooldown, plus this run's processed-issue registry.
   *
   * One source of truth for two readers — the claim scan filters its
   * candidates against it, and the idle-decision census models it. They
   * diverged before: the registry's entries live as long as the process, so
   * `stSoftwareAU/VibeCoder` logged `work_on=2 inversion_signal=true` cycle
   * after cycle for two issues the scan was silently and correctly refusing,
   * and escalated it to a human as a bug in the scan.
   */
  const loadRunLocalHolds = async (): Promise<
    (repo: string, issueNumber: number) => boolean
  > => {
    const cooldownState = await loadCooldownState(
      cooldownConfig.workDir,
      cooldownConfig.issueRetryCooldown,
    );
    const cooldownSet = new Set(
      cooldownState.entries.map((e) => `${e.repo}|${e.issueNumber}`),
    );
    return (repo, issueNumber) =>
      cooldownSet.has(`${repo}|${issueNumber}`) ||
      processedIssues.has(repo, issueNumber);
  };

  const circuitBreakerConfig: CircuitBreakerConfig = {
    workDir,
    threshold: 5,
    sleepInterval: config.sleepInterval ?? 30,
    creditWaitInterval: config.creditWaitInterval ?? 300,
    stateExpirySeconds: 3600,
    operationBackoffThreshold: 3,
  };

  // Health cache working directory
  const healthCacheDir = workDir;

  // Build RunCoreConfig
  const runCoreConfig = createDefaultRunCoreConfig();
  const coreConfig: RunCoreConfig = {
    runDurationSeconds: runCoreConfig.runDurationSeconds,
    sleepInterval: config.sleepInterval ?? runCoreConfig.sleepInterval,
    maxConcurrentIssues: config.maxConcurrentIssues ??
      runCoreConfig.maxConcurrentIssues,
    maxConsecutiveFailures: runCoreConfig.maxConsecutiveFailures,
    rateLimitBackoff: runCoreConfig.rateLimitBackoff,
    // Issue #2473: per-handler watchdog bounds (conservative defaults).
    handlerTimeoutSeconds: runCoreConfig.handlerTimeoutSeconds,
    handlerSoftTimeoutSeconds: runCoreConfig.handlerSoftTimeoutSeconds,
    // Issue #62: the operator's planning agent timeout sizes Planning Mode's
    // watchdog floor, so a longer `planning_timeout` widens the handler
    // budget with it rather than being clipped by the flat 600 s.
    planningTimeoutSeconds: config.planningTimeout ??
      runCoreConfig.planningTimeoutSeconds,
  };

  const repos = config.repos ?? [];

  /**
   * A repo's closed/merged fleet PRs, read through the same iteration-scoped
   * `prs_closed_*` cache the Priority 2 scan populates (GRQ#4419).
   *
   * The idle-detect audit and the idle-decision census both need it to model
   * the scan's *permanent* `merged-pr-permanent` gate (Issue #3151). Whichever
   * of the scan, the audit and the census runs first pays for the fetch, so
   * the gate adds no API call on a warm iteration. Best-effort — both callers
   * treat a rejection as "no merged-PR data" and fall back to the pre-GRQ#4419
   * over-count rather than reporting a repo as having nothing to do.
   */
  const fetchMergedPRsForCensus = (repo: string) =>
    fetchRecentlyClosedPRsForFleet(
      repo,
      resolveFleetPrAuthorSet({
        githubUser,
        allowedAuthors: config.allowedAuthors,
        fleetPrAuthors: config.fleetPrAuthors ?? [],
      }),
      config.closedPrCooldownSeconds ?? 3600,
      issueCache,
    );

  // Issue #1935: build the private-repo-6 config + deps once so the
  // per-iteration heartbeat does not re-resolve env vars / hostname on
  // every loop. The heartbeat itself is registered below in the deps
  // object so it can be replaced under test.
  //
  // Issue #2015: pass the shared worker logger into the private-repo-6 deps so
  // heartbeat info/warning lines land in `~/logs/worker-*.log` alongside
  // the rest of the loop. Without this the deps log via raw `console.log`,
  // which goes to the inherited tty and is silently lost — masking any
  // failure mode (the original 17h-stale-dashboard symptom that prompted
  // this fix).
  const fleetHealthConfig = buildFleetHealthConfig(repoDir);
  // Issue #226: name a low host disk on the fleet-health payload.
  // Issue #333: the quota outage is read once per cycle rather than inside
  // `hostNotes`, which is synchronous. A stale reading is harmless — the note
  // exists to name a multi-day outage, not to be second-accurate.
  /**
   * The claim scan's per-issue skip reasons from the most recent scan
   * (Issue #460). Read once at the idle-task filing decision point so the
   * idle-inversion escalation can name the gate that refused each issue the
   * census counted as claimable — the question GRQ#4465 asked a human to
   * answer from a log that never recorded it. Diagnostics only: a stale
   * reading names a gate one scan out of date, never blocks a claim.
   */
  let lastScanBlockedDetails: BlockedCandidateInfo[] = [];

  let quotaOutageNote: string | null = null;
  const refreshQuotaOutageNote = async () => {
    const outage = await readQuotaOutage(workDir);
    // Only a *long* outage is a health condition. A five-hour window that
    // lapses mid-cycle is ordinary operation and must not flag the host.
    quotaOutageNote = outage !== null &&
        outage.remainingSeconds >= QUOTA_OUTAGE_UNHEALTHY_SECONDS
      ? `out of Claude quota for ${
        formatCoarseDuration(outage.remainingSeconds)
      } — the window reopens at ${
        new Date(outage.resetEpochMs).toISOString()
      }; this host needs a different account or a topped-up plan`
      : null;
  };

  /**
   * The two disk signals' shared verdict (Issue #345). A work-volume probe
   * that has not run yet is not a blind probe — only a walk that ran and
   * could not produce a measurement counts against the host.
   */
  const diskTelemetry = () =>
    assessDiskTelemetry({
      hostDiskKnown: hostDisk.status.level !== "unknown",
      hostDiskDetail: hostDisk.status.detail,
      workVolumeKnown: !workVolume.status.probed || workVolume.status.known,
      workVolumeDetail: workVolume.status.reason ??
        `total ${formatGb(workVolume.status.totalBytes ?? 0)}`,
    });

  /**
   * Why the claim scan stopped, for the census (Issue #479).
   *
   * Reads the same two host-level gates the fleet-board note does, so the
   * board and the census can never disagree about why this host is idle.
   * Neither gate active means the scan really did run out of cycle, which is
   * #437's deferral and keeps its historical reason.
   */
  const claimGateReason = (): RepoCensusSkipReason => {
    if (hostDisk.status.level === "low") return "host_disk_low";
    if (workVolumeFault() !== null) return "work_volume_fault";
    return "cycle_deadline";
  };

  fleetHealthConfig.hostNotes = () => {
    const notes: string[] = [];
    const status = hostDisk.status;
    const fault = workVolumeFault();
    // Issue #477: lead with the consequence. These are exactly the two gates
    // that make the cycle skip the claim scan outright ("claiming no new
    // issues this cycle"), so a host reporting either is declining every
    // issue in the fleet — an outage, not the housekeeping note that
    // `host-disk low: …` alone reads as. The gate detail is carried inside
    // the note, so nothing #226 or #229 reported is lost.
    const gateNote = claimSuppressedNote([
      ...(status.level === "low"
        ? [{ id: "host-disk-low", detail: status.detail }]
        : []),
      ...(fault !== null
        ? [{ id: "work-volume-fault", detail: fault.detail }]
        : []),
    ]);
    if (gateNote !== null) notes.push(gateNote);
    // Issue #345: a host that has lost its disk telemetry says so on the
    // fleet board *before* it fills up, not after the crash.
    notes.push(...diskTelemetry().notes);
    // Issue #333: "unhealthy" alone does not say which host to fix.
    if (quotaOutageNote !== null) notes.push(quotaOutageNote);
    return notes;
  };
  // Issue #410: the health checkout is gated on the host figure this monitor
  // already maintains — never on a `df` taken inside the guest, which
  // describes the thin-provisioned work volume and reports plenty of room
  // while the host is full. `status` is the last sampled verdict, so the gate
  // costs nothing and cannot disagree with the reclaimer acting on the same
  // monitor. `unknown` is not `low`: an unprobed host must not silently
  // switch health reporting off.
  const fleetHealthDeps = createProductionFleetHealthDeps(
    logger,
    () => Promise.resolve(hostDisk.status.level === "low"),
  );

  /**
   * Helper: wrap find-by-label + process into PriorityHandlerResult.
   *
   * Issue #2565: the callback was typed `(ctx: any, deps: any) => Promise<any>`,
   * which erased type checking at every call site. The four processors
   * (refinement, grill-me, planning, question) all take `ctx: IssueContext`
   * and a structurally-identical `*ProcessorDeps` shape, and each returns a
   * `Promise<Result<…>>`. Typing `ctx` as `IssueContext`, the deps as the
   * shared shape, and the result generically over `R extends { ok: boolean }`
   * validates the inline `ctx` literal and `processResult.ok` against real
   * types and removes the `deno-lint-ignore no-explicit-any`.
   */
  async function findAndProcessByLabel<R extends { ok: boolean }>(
    label: string,
    processFn: (
      ctx: IssueContext,
      deps: { ghClient: GitHubClient; logger: Logger; deps: WorkerDeps },
    ) => Promise<R>,
    /** Watchdog deadline for the calling handler, epoch-ms (Issue #58). */
    handlerDeadlineEpochMs?: number,
  ): Promise<PriorityHandlerResult> {
    const result = await findIssuesByLabel(config, label, false, {
      githubUser,
      ghCommandFn: runGhCommand,
      cache: issueCache,
      timelineCache,
      timelineBatchRegistry,
    });

    if (!result.found || !result.output) {
      return { processed: false };
    }

    const firstLine = result.output.split("\n")[0];
    if (!firstLine) return { processed: false };

    const parts = firstLine.split("|");
    const repo = parts[0] ?? "";
    const issueNumber = parseInt(parts[1] ?? "0", 10);
    // parts[2] = url, parts[3] = milestoneTitle (Issue #1300)
    const milestoneTitle = parts[3] ?? "";
    const issueTitle = parts.slice(4).join("|");

    if (!repo || !issueNumber) return { processed: false };

    logger.info(`Processing ${label} issue: ${repo}#${issueNumber}`);

    const issueData: IssueData = await fetchIssueData(repo, issueNumber);
    const ghClient = createGitHubClient(logger);
    const processorDeps = { ghClient, logger, deps: workerDeps };

    const ctx: IssueContext = {
      repo,
      issueNumber,
      issueTitle,
      issueBody: issueData.body ?? "",
      issueLabels: issueData.labels ?? [],
      issueComments: "",
      githubUser,
      // Issue #1300: Pass milestone so label-based processors can use it
      milestoneTitle: milestoneTitle || issueData.milestoneTitle || undefined,
      config,
      ...(handlerDeadlineEpochMs !== undefined
        ? { handlerDeadlineEpochMs }
        : {}),
    };

    const processResult = await processFn(ctx, processorDeps);
    return { processed: processResult?.ok ?? false };
  }

  const deps: RunCoreDeps = {
    // -- Logging --
    log: (msg) => logger.info(msg),
    logError: (msg) => logger.error(msg),
    logTiming: (op, dur) => logger.timing(op, dur),
    logWorkerSummary: (processed, dur) => logger.workerSummary(processed, dur),

    // -- PID management (delegated to shell orchestration) --
    checkPidFile: () =>
      Promise.resolve({
        canProceed: true,
        message: "PID check delegated to shell",
      }),
    claimPidFile: () => Promise.resolve(),
    releasePidFile: () => Promise.resolve(),

    // -- Initialisation (some delegated to shell) --
    gitResetToOrigin: () => Promise.resolve({ ok: true, value: undefined }),
    setupLogging: () => Promise.resolve(),
    async loadAndValidateConfig() {
      try {
        await loadConfig(configPath);
        return { ok: true, value: coreConfig };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    checkDependencies: () => Promise.resolve({ ok: true, value: undefined }),
    async checkSoftwareUpdates() {
      try {
        // Issue #2622: per-tool version floors trigger an immediate update
        // when the installed version is below the floor, bypassing the
        // interval gate. Issue #3655: one shared env builder so the skip
        // flags and the release-age quarantine window apply identically on
        // every entry point.
        await checkSoftwareUpdates(
          logger,
          softwareUpdateOptionsFromEnv(config),
        );
      } catch (err) {
        // Best-effort for the cycle, but never silent (Issue #625): a frozen
        // host whose pinned install failed is running on a version its
        // operator did not choose, and swallowing that leaves no trace.
        logger.error(
          `Software update check failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    async checkDiskSpace() {
      try {
        const { result, detail } = await runProductionDiskCheck(workDir);
        if (detail.tier !== "none") {
          logger.info(`Disk space: ${detail.message}`);
        }
        return result;
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    async rotateLogFiles() {
      const logDir = `${Deno.env.get("HOME") ?? "~"}/logs`;
      const maxSizeBytes = 10 * 1024 * 1024; // 10 MB
      const maxRotations = 3;
      try {
        await checkAndRotateLog(
          `${logDir}/run_core.log`,
          maxSizeBytes,
          maxRotations,
        );
      } catch { /* best-effort */ }
    },
    cleanupStaleTempFiles: () => Promise.resolve(),
    async recoverStuckIssues() {
      // Issue #1787: pass `issueCache` so the stuck-recovery scans
      // share the per-iteration `issues_all` cache.
      try {
        await recoverStuckFn(
          stuckIssueConfig,
          githubUser,
          undefined,
          issueCache,
        );
      } catch { /* best-effort */ }
    },
    cleanupStaleBranches: () => Promise.resolve(),
    async recoverStaleAssignments() {
      // Issue #2672: per-cycle GitHub-side stale-assignment recovery.
      // Only the two GitHub scans run here — the local `.heartbeat_*`
      // crash cleanup (`detectAndRecoverStuckHeartbeats`) stays at
      // start-up via `recoverStuckIssues()`. Pass the shared `issueCache`
      // so this reuses the iteration-scoped `issues_all` cache and adds no
      // extra issue-list API call on a quiet cycle. Best-effort — the
      // run-core loop catches and logs any throw.
      await recoverNoHeartbeatFn(
        stuckIssueConfig,
        githubUser,
        undefined,
        undefined,
        issueCache,
      );
      await recoverStaleAssignmentsFn(
        stuckIssueConfig,
        githubUser,
        undefined,
        undefined,
        issueCache,
      );
    },
    async checkFeatureAvailability() {
      const registry = createFeatureRegistry();
      registerBuiltinFeatures(registry);
      // Issue #226: the host's disk is a feature like any other — a `low`
      // reading shows as `Feature host-disk: degraded` in the startup log.
      // Issue #345: so does an `unknown` one. A probe that cannot produce a
      // value is degraded, never available — GRQ-23 advertised `available`
      // with `df` unreadable right up to the crash.
      const disk = await hostDisk.check();
      registry.register(
        "host-disk",
        () => disk.level === "ok",
        `Host filesystem has room for new work — ${disk.detail}`,
      );
      // Issue #229: a work volume that has surfaced an I/O fault.
      // Issue #345: or whose standing totals are not a measurement — an
      // all-zero walk reads as "plenty of room" and is worth less than no
      // reading at all.
      const volume = await workVolume.probe();
      registry.register(
        "work-volume",
        () => workVolumeFault() === null && volume.known,
        volume.known
          ? "Work volume filesystem has surfaced no I/O fault and its standing totals are measurable"
          : `Work volume telemetry is blind — ${volume.reason}`,
      );
      const results = registry.checkAll();
      for (const featureResult of results) {
        logger.info(`Feature ${featureResult.name}: ${featureResult.status}`);
      }
    },

    // -- Health checks --
    async checkClaudeHealth() {
      const cacheType = "claude";
      const cacheResult = isHealthCacheValid(
        healthCacheDir,
        cacheType,
        config.healthCacheTtl,
      );
      if (cacheResult.ok && cacheResult.value) {
        return { ok: true, value: { healthy: true } };
      }
      try {
        const result = await claudeHealthCheck(30, logger);
        if (result.healthy) {
          recordHealthCheckSuccess(healthCacheDir, cacheType);
          return { ok: true, value: { healthy: true } };
        }
        invalidateHealthCache(healthCacheDir, cacheType);
        // Rate/usage limited (Issue #4315): write the durable signal so
        // the loop's existing rate-limit pause takes over — instead of
        // re-running this billed probe every sleepInterval for the whole
        // window — and every other worker on the volume waits too.
        if (result.exitCode === 3 && result.pauseSeconds) {
          const signal = await writeRateLimitSignal(
            workDir,
            result.pauseSeconds,
          );
          if (!signal.ok) {
            logger.warn(
              `Could not write the limit signal after the health check: ${signal.error.message}`,
            );
          } else {
            logger.warn(
              `Agent health check reports a rate/usage limit — pausing agent ` +
                `work for ${result.pauseSeconds}s (signal written)`,
            );
          }
        }
        return { ok: true, value: { healthy: false } };
      } catch (err) {
        invalidateHealthCache(healthCacheDir, cacheType);
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    async recheckAgentAuth() {
      // Issue #4167: always a fresh probe — the cached "healthy" from the
      // cycle-start gate is exactly what a mid-cycle outage invalidates.
      try {
        const result = await claudeHealthCheck(30, logger);
        if (!result.healthy) {
          invalidateHealthCache(healthCacheDir, "claude");
        }
        return {
          authFailed: !result.healthy && result.exitCode === 2,
          ...(result.message ? { message: result.message } : {}),
        };
      } catch (err) {
        // A probe that cannot run is not auth evidence — stay inert.
        return {
          authFailed: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async checkGhAuth() {
      const cacheType = "gh";
      const cacheResult = isHealthCacheValid(
        healthCacheDir,
        cacheType,
        config.healthCacheTtl,
      );
      if (cacheResult.ok && cacheResult.value) {
        return { ok: true, value: { valid: true } };
      }
      try {
        const result = await ghAuthCheck();
        if (result.ok) {
          recordHealthCheckSuccess(healthCacheDir, cacheType);
          return { ok: true, value: { valid: true } };
        }
        invalidateHealthCache(healthCacheDir, cacheType);
        return { ok: true, value: { valid: false } };
      } catch (err) {
        invalidateHealthCache(healthCacheDir, cacheType);
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    async checkFableAvailability() {
      // Issue #3230: cached Fable-availability probe. Reuses the same
      // healthCacheTtl gate as the boolean caches so it adds at most one extra
      // Fable call per TTL window. Best-effort — Fable being unavailable only
      // sets the cache; it never fails the health check or blocks the worker,
      // so any error is logged and treated as "available" (optimistic).
      try {
        return await probeFableAvailability({
          workDir: healthCacheDir,
          ttlSeconds: config.healthCacheTtl,
          logger,
        });
      } catch (err) {
        logger.warn(
          `Fable availability check failed (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return "available";
      }
    },

    // -- Priority 1: PR feedback (Issue #1297 — repo setup + cwd fix) --
    async findAndProcessPrFeedback() {
      const result = await findPrCommentsToFix({
        githubUser,
        repos,
        logger,
        isRepoAllowed: (repo) => isRepoAllowed(repos, repo),
        isAuthorisedCommenter: (author) =>
          isAuthorisedCommenter(author, authorisedCommenters),
        ghCommandFn: runGhCommand,
        // Shared PR-list cache (Issue #4303): one superset listing per
        // repo×author serves every Priority-1.x scan this cycle.
        cache: issueCache,
        shuffleRepos: shuffleArray,
        trustedReviewBots: config.trustedReviewBots ?? [],
        prAuthors: fleetPrAuthorInput.fleetPrAuthors,
        allowedAuthors: fleetPrAuthorInput.allowedAuthors,
      });

      if (!result.ok || result.value === null) {
        return { ok: true, value: { processed: false } };
      }

      const comment = result.value;

      // Issue #213: in the maintenance lane this pass runs beside the issue
      // slots, and both check out into the same `${WORK_DIR}/<repo>` clone.
      // Lease the repository before touching it — a slot already working
      // there means this PR waits for the next cycle rather than fighting it
      // for the working tree. Outside the lane the lease is uncontended.
      const lease = acquireMaintenanceRepoLease(comment.repo, comment.prNumber);
      if (lease === null) {
        logger.info(
          "Deferring PR feedback: an issue slot holds the repository",
          { repo: comment.repo, prNumber: comment.prNumber },
        );
        return { ok: true, value: { processed: false } };
      }
      try {
        // Set up the target repository so Claude runs with correct context.
        // Without this, Claude runs in the worker directory instead of
        // the target repo with the PR branch checked out (Issue #1297).
        const repoSetupResult = await setupRepo(comment.repo, workDir);
        if (!repoSetupResult.success) {
          logger.error("Failed to set up repo for PR feedback", {
            repo: comment.repo,
            error: repoSetupResult.message,
          });
          return { ok: true, value: { processed: false } };
        }
        const repoWorkDir = repoSetupResult.message;

        // Checkout and sync the PR branch
        const branchName = comment.branchName;
        try {
          await runGitCommand(
            buildFetchArgs("origin", branchName),
            { cwd: repoWorkDir },
          );
          await runGitCommand(
            buildCheckoutArgs(branchName),
            { cwd: repoWorkDir },
          );
          await runGitCommand(
            buildPullArgs("origin", branchName),
            { cwd: repoWorkDir },
          );
        } catch (err) {
          logger.error("Failed to checkout PR branch for feedback", {
            repo: comment.repo,
            branch: branchName,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ok: true, value: { processed: false } };
        }

        // Decode base64-encoded body
        let decodedBody: string;
        try {
          decodedBody = atob(comment.encodedBody);
        } catch {
          decodedBody = comment.encodedBody;
        }

        // Load quality and custom instructions for this repo
        const qualityInstructions = buildQualityInstructions(
          config.repoConfig,
          comment.repo,
        );
        const customInstructions = getCustomInstructions(
          config.repoConfig,
          comment.repo,
        );

        // Issue #1072: Pass workerId for distributed PR comment claiming
        const workerId = getWorkerUniqueId(config.workerName);

        const feedbackResult = await processPrFeedback(
          {
            repo: comment.repo,
            prNumber: comment.prNumber,
            branchName: comment.branchName,
            commentType: comment.commentType,
            commentId: comment.commentId,
            commentBody: decodedBody,
          },
          {
            logger,
            deps: workerDeps,
            workDir: repoWorkDir,
            qualityInstructions,
            customInstructions,
            // Issue #213: the dedicated reactive budget, not the issue-work
            // `claude_timeout` this dispatch path used to pass.
            claudeTimeout: reactivePhaseTimeout(config, "pr-feedback"),
            claudeNoOutputTimeout: config.claudeNoOutputTimeout,
            maxRateLimitRetries: config.maxRateLimitRetries,
            workerId,
            // Issue #185: lets the escape-hatch verifier recognise a follow-up
            // the worker filed under its own login as trusted.
            githubUser,
            trustedReviewBots: config.trustedReviewBots ?? [],
            repoConfigs: config.repoConfig,
          },
        );

        return { ok: true, value: { processed: feedbackResult.ok } };
      } finally {
        lease.release();
      }
    },

    // -- Priority 1.5: Spelling checks (Issue #1297 — repo setup + cwd fix) --
    async findAndProcessSpellingFailure() {
      const result = await findFailedPrChecks({
        githubUser,
        repos,
        logger,
        isRepoAllowed: (repo) => isRepoAllowed(repos, repo),
        isAuthorisedCommenter: () => true,
        ghCommandFn: runGhCommand,
        // Shared PR-list cache (Issue #4303): one superset listing per
        // repo×author serves every Priority-1.x scan this cycle.
        cache: issueCache,
        shuffleRepos: shuffleArray,
        prAuthors: fleetPrAuthorInput.fleetPrAuthors,
        allowedAuthors: fleetPrAuthorInput.allowedAuthors,
      });

      if (!result.ok || result.value === null) {
        return { ok: true, value: { processed: false } };
      }

      const check = result.value;

      // Issue #213: lease the shared `${WORK_DIR}/<repo>` clone before the
      // checkout, so this pass and an issue slot never write one tree.
      const lease = acquireMaintenanceRepoLease(check.repo, check.prNumber);
      if (lease === null) {
        logger.info(
          "Deferring spelling fix: an issue slot holds the repository",
          { repo: check.repo, prNumber: check.prNumber },
        );
        return { ok: true, value: { processed: false } };
      }
      try {
        // Set up repo and checkout PR branch (Issue #1297)
        const repoSetupResult = await setupRepo(check.repo, workDir);
        if (!repoSetupResult.success) {
          logger.error("Failed to set up repo for spelling fix", {
            repo: check.repo,
            error: repoSetupResult.message,
          });
          return { ok: true, value: { processed: false } };
        }
        const repoWorkDir = repoSetupResult.message;

        try {
          await runGitCommand(
            buildFetchArgs("origin", check.branchName),
            { cwd: repoWorkDir },
          );
          await runGitCommand(
            buildCheckoutArgs(check.branchName),
            { cwd: repoWorkDir },
          );
          await runGitCommand(
            buildPullArgs("origin", check.branchName),
            { cwd: repoWorkDir },
          );
        } catch (err) {
          logger.error("Failed to checkout PR branch for spelling fix", {
            repo: check.repo,
            branch: check.branchName,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ok: true, value: { processed: false } };
        }

        const fixResult = await processSpellingFailure(
          {
            repo: check.repo,
            prNumber: check.prNumber,
            branchName: check.branchName,
            checkRunId: check.checkId,
            checkName: check.checkName,
            encodedAnnotations: check.encodedAnnotations,
          },
          {
            logger,
            deps: workerDeps,
            workDir: repoWorkDir,
            claudeTimeout: config.claudeTimeout,
            claudeNoOutputTimeout: config.claudeNoOutputTimeout,
            maxRateLimitRetries: config.maxRateLimitRetries,
            repoConfigs: config.repoConfig,
          },
        );

        return { ok: true, value: { processed: fixResult.ok } };
      } finally {
        lease.release();
      }
    },

    // -- Priority 1.55: CI checks (Issue #1297 — repo setup + cwd fix) --
    async findAndProcessCiFailure() {
      const result = await findFailedCiChecks({
        githubUser,
        repos,
        logger,
        isRepoAllowed: (repo) => isRepoAllowed(repos, repo),
        isAuthorisedCommenter: () => true,
        ghCommandFn: runGhCommand,
        // Shared PR-list cache (Issue #4303): one superset listing per
        // repo×author serves every Priority-1.x scan this cycle.
        cache: issueCache,
        shuffleRepos: shuffleArray,
        maxRetries: 3,
        // Issue #552: the same store the processor below writes, so the
        // retry cap is actually observed and a green build really does clear
        // the auto-fix budget recorded against that PR.
        stateDir: ciCheckStateDir,
        prAuthors: fleetPrAuthorInput.fleetPrAuthors,
        allowedAuthors: fleetPrAuthorInput.allowedAuthors,
      });

      if (!result.ok || result.value === null) {
        return { ok: true, value: { processed: false } };
      }

      const check = result.value;

      // Issue #213: lease the shared `${WORK_DIR}/<repo>` clone before the
      // checkout, so this pass and an issue slot never write one tree.
      const lease = acquireMaintenanceRepoLease(check.repo, check.prNumber);
      if (lease === null) {
        logger.info("Deferring CI fix: an issue slot holds the repository", {
          repo: check.repo,
          prNumber: check.prNumber,
        });
        return { ok: true, value: { processed: false } };
      }
      try {
        // Set up repo and checkout PR branch (Issue #1297)
        const repoSetupResult = await setupRepo(check.repo, workDir);
        if (!repoSetupResult.success) {
          logger.error("Failed to set up repo for CI fix", {
            repo: check.repo,
            error: repoSetupResult.message,
          });
          return { ok: true, value: { processed: false } };
        }
        const repoWorkDir = repoSetupResult.message;

        try {
          await runGitCommand(
            buildFetchArgs("origin", check.branchName),
            { cwd: repoWorkDir },
          );
          await runGitCommand(
            buildCheckoutArgs(check.branchName),
            { cwd: repoWorkDir },
          );
          await runGitCommand(
            buildPullArgs("origin", check.branchName),
            { cwd: repoWorkDir },
          );
        } catch (err) {
          logger.error("Failed to checkout PR branch for CI fix", {
            repo: check.repo,
            branch: check.branchName,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ok: true, value: { processed: false } };
        }

        const fixResult = await processCiFailure(
          {
            repo: check.repo,
            prNumber: check.prNumber,
            branchName: check.branchName,
            checkRunId: check.checkId,
            checkName: check.checkName,
            encodedAnnotations: check.encodedAnnotations,
          },
          {
            logger,
            deps: workerDeps,
            workDir: repoWorkDir,
            // Issue #213: the dedicated reactive budget, not the issue-work
            // `claude_timeout` — this dispatch path passing `claudeTimeout` is
            // why a host with `claude_timeout: 3600` logged "Running Claude
            // Code with 3600s timeout" for a CI fix the docs cap at 1800.
            claudeTimeout: reactivePhaseTimeout(config, "ci-fix"),
            claudeNoOutputTimeout: config.claudeNoOutputTimeout,
            maxRateLimitRetries: config.maxRateLimitRetries,
            // Issue #3582: cap auto-fix attempts per stable failure signature.
            maxAutoFixAttempts: resolveMaxAutoFixAttempts(config, check.repo),
            // Issue #580: the retry counters live on the work volume, not on
            // a relative path under the read-only checkout. Issue #552: the
            // same store the scan above reads.
            stateDir: ciCheckStateDir,
            repoConfigs: config.repoConfig,
            // Issue #3754: cross-host PR lock so two hosts cannot fix the
            // same PR's CI failure concurrently.
            workerId: getWorkerUniqueId(config.workerName),
          },
        );

        return { ok: true, value: { processed: fixResult.ok } };
      } finally {
        lease.release();
      }
    },

    // -- Priority 1.6: Update PR branches (Issue #1280) --
    async updateOpenPrBranches() {
      try {
        const getDefaultBranch = async (repo: string): Promise<string> => {
          const branchResult = await getRepoDefaultBranch(repo);
          if (branchResult.ok) return branchResult.value;
          return "main"; // allow-hardcoded-branch — fallback after dynamic detection
        };

        // Phase 1: Scan for PRs that need updating
        const scanResult = await scanPrBranchUpdates({
          repos: shuffleArray([...repos]),
          logger,
          isRepoAllowed: (repo: string) => isRepoAllowed(repos, repo),
          getDefaultBranch,
          listPrs: async (repo: string): Promise<PrBranchEntry[]> => {
            // Issue #1787: route through `fetchAllOpenPRs` so the
            // open-PR list shares the iteration-scoped cache used by
            // pr-link / branch-cleanup helpers.
            try {
              const prs = await fetchAllOpenPRs(
                repo,
                issueCache,
                50,
                runGhCommand,
              );
              // Filter for worker PRs by body marker (not author) so
              // identity changes don't orphan existing PRs.
              return prs
                .filter((pr) => isWorkerPr(pr.body, pr.headRefName))
                .map(({ number, headRefName, baseRefName }) => ({
                  number,
                  headRefName,
                  baseRefName,
                }));
            } catch {
              return [];
            }
          },
          getBehindBy: async (
            repo: string,
            baseBranch: string,
            headBranch: string,
          ): Promise<number> => {
            const output = await runGhCommand([
              "api",
              `repos/${repo}/compare/${baseBranch}...${headBranch}`,
              "--jq",
              ".behind_by // 0",
            ]);
            return Number(output.trim()) || 0;
          },
          getMergeableStatus: async (
            repo: string,
            prNumber: number,
          ): Promise<string> => {
            const output = await runGhCommand([
              "pr",
              "view",
              String(prNumber),
              "--repo",
              repo,
              "--json",
              "mergeable",
              "--jq",
              ".mergeable",
            ]);
            return output.trim();
          },
          // Issue #1807: collapse 2N REST calls to one GraphQL call per
          // repo. On any failure (including outage / unsupported field)
          // return null so the scanner falls back to the REST pair above.
          fetchBranchStateBatch: async (
            repo: string,
            prs: readonly PrBranchEntry[],
          ): Promise<Map<number, PrBranchStateEntry> | null> => {
            const result = await fetchPRBranchStateBatch(
              repo,
              prs.map((pr) => ({
                number: pr.number,
                baseRefName: pr.baseRefName || "main", // allow-hardcoded-branch — safe fallback
                // Issue #470: orients the ahead/behind comparison.
                headRefName: pr.headRefName,
              })),
              runGhCommand,
              issueCache,
            );
            if (!result.ok) {
              logger.debug(
                "PR branch-state batch fetch failed; falling back to REST",
                {
                  repo,
                  error: result.error.message,
                },
              );
              return null;
            }
            const out = new Map<number, PrBranchStateEntry>();
            for (const [num, state] of result.states) {
              out.set(num, {
                behindBy: state.behindBy,
                mergeable: state.mergeable,
              });
            }
            return out;
          },
        });

        if (!scanResult.ok) {
          return { ok: false, error: scanResult.error };
        }

        const { actions } = scanResult.value;
        if (actions.length === 0) {
          return { ok: true, value: undefined };
        }

        // Phase 2: Execute updates (scan + execute pattern from pr_maintenance.ts)
        // Issue #1281: Pass workerId for distributed lock acquisition
        const workerId = getWorkerUniqueId(config.workerName);
        const execResult = await executePrBranchUpdates(actions, {
          workDir,
          logger,
          workerId,
          // Issue #335: count consecutive failures per (repo, branch) so a
          // branch that can never be updated is escalated once instead of
          // retried at WARNING on every cycle.
          failureStreak: {
            statePath: prBranchFailureStatePath(workDir),
            cycleId: resolveRunId(),
            ghFn: (args: string[]) => runGhCommand(args),
          },
          // Issue #386: re-check the PR is still open at the point of the
          // push. A PR that merged inside the scan→push window is a no-op,
          // not the `(stale info)` push failure it used to be reported as.
          getPrState: makeGhPrStateFetcher(runGhCommand),
          // Issue #394: this lane works in its **own** worktree, never in the
          // shared `${WORK_DIR}/<repo>` clone. `setupRepo` opens with
          // `reset --hard` + `clean -fd` + `checkout <default>`, so running it
          // here threw away whatever an issue slot had in that tree and moved
          // `HEAD` under it. `ensureRepoClone` only clones when the clone is
          // genuinely missing, and the worktree gives this lane its own HEAD,
          // index and checkout off the same object store.
          setupRepo: async (repo: string, wd: string) => {
            const clone = await ensureRepoClone(repo, wd);
            if (!clone.ok) {
              return {
                ok: false as const,
                error: new Error(
                  clone.message ?? `Could not clone ${repo} into ${wd}`,
                ),
              };
            }
            return await ensureLaneWorktree({
              workDir: wd,
              repo,
              laneId: PR_BRANCH_UPDATE_LANE_ID,
              repoPath: clone.repoPath,
            });
          },
          getDefaultBranch,
          performBranchUpdate: async (params: {
            repoPath: string;
            branchName: string;
            baseBranch: string;
            defaultBranch: string;
            reason: "behind" | "conflicting";
          }) => {
            const gitOptions = { cwd: params.repoPath };

            const fetchBase = await runGitCommand(
              buildFetchArgs("origin", params.baseBranch),
              gitOptions,
            );
            if (!fetchBase.ok || fetchBase.value.code !== 0) {
              return {
                ok: false as const,
                error: new Error(
                  `Failed to fetch base branch '${params.baseBranch}'`,
                ),
              };
            }

            // Update the PR branch (rebase + force-push). It checks the branch
            // out at its remote head itself (Issue #211), so a stale local
            // branch can no longer invent a conflict the remote PR lacks.
            // Issue #1313: Pass the reason so conflicting PRs are handled
            // even when behindCount is 0 locally.
            const updateResult = await updatePrBranch(
              params.branchName,
              params.baseBranch,
              gitOptions,
              params.reason,
            );

            // Issue #394: leave the lane's worktree detached rather than on
            // the default branch. Branches are shared between worktrees, so a
            // lane parked on `<default>` would block every other lane from
            // moving it — and `git checkout <default>` is itself refused when
            // the shared clone already has it out. Detaching frees the PR
            // branch this pass just used, whatever the outcome.
            await detachLaneWorktreeHead(params.repoPath);

            return updateResult;
          },
        });

        if (!execResult.ok) {
          return { ok: false, error: execResult.error };
        }

        const {
          updatedCount,
          failedCount,
          mergedCount = 0,
          contendedCount = 0,
        } = execResult.value;
        // Issue #1799: invalidate the iteration-scoped open-PR cache for
        // every repo we touched — branch updates may have closed/changed
        // PRs, so the next reader inside the same iteration must see
        // current state. Issue #386: a PR that merged mid-cycle makes the
        // cache stale in exactly the same way.
        if (updatedCount > 0 || mergedCount > 0) {
          const touchedRepos = new Set(actions.map((a) => a.repo));
          await Promise.all(
            [...touchedRepos].map((repo) =>
              issueCache.invalidate(repo, "prs_open_all")
            ),
          );
        }
        // Issue #386: mid-cycle merges are named separately so a genuine
        // push failure is the only thing counted as failed.
        const mergedSuffix = mergedCount > 0
          ? `, ${mergedCount} merged mid-update`
          : "";
        // Issue #394: contention is named in the summary too, so a pass that
        // deferred PRs to another lane is not read as a pass that failed them.
        const contendedSuffix = contendedCount > 0
          ? `, ${contendedCount} deferred (clone held by another lane)`
          : "";
        logger.info(
          `PR branch update complete: ${updatedCount} updated, ${failedCount} failed${mergedSuffix}${contendedSuffix}`,
        );
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    // -- Priority 1.61: Resolve conflicting PRs (Issue #84) --
    //
    // Drains the queue rather than taking one PR per cycle (Issue #561) —
    // see `merge_conflict_drain.ts` for the bounds and why they are what
    // they are. This wiring supplies the three side effects: the scan, the
    // repository lease, and one resolution.
    async findAndProcessMergeConflict(opts?: HandlerExecuteOptions) {
      const drain = await drainConflictingPrs({
        logger,
        ...(opts?.deadlineEpochMs !== undefined
          ? { deadlineEpochMs: opts.deadlineEpochMs }
          : {}),
        findNext: async (exclude) => {
          const scan = await findConflictingPr({
            githubUser,
            allowedAuthors: fleetPrAuthorInput.allowedAuthors,
            fleetPrAuthors: fleetPrAuthorInput.fleetPrAuthors,
            repos,
            logger,
            isRepoAllowed: (repo: string) => isRepoAllowed(repos, repo),
            ghCommandFn: runGhCommand,
            // Shared PR-list cache (Issue #4303): one superset listing per
            // repo×author serves every Priority-1.x scan this cycle.
            cache: issueCache,
            shuffleRepos: shuffleArray,
            // Issue #395: the scan escalates a repeatedly disrupted conflict
            // itself, so it needs the configured escalation label.
            needsHumanLabel: config.needsHumanLabel,
            exclude,
          });
          return scan.ok ? scan.value : null;
        },
        // Issue #213: lease the shared `${WORK_DIR}/<repo>` clone before the
        // merge, so this pass and an issue slot never write one tree.
        acquireLease: (conflict) =>
          acquireMaintenanceRepoLease(conflict.repo, conflict.prNumber),
        resolve: async (conflict) => {
          const repoSetupResult = await setupRepo(conflict.repo, workDir);
          if (!repoSetupResult.success) {
            logger.error(
              "Failed to set up repo for merge-conflict resolution",
              { repo: conflict.repo, error: repoSetupResult.message },
            );
            return null;
          }

          const result = await processMergeConflict(conflict, {
            logger,
            deps: workerDeps,
            workDir: repoSetupResult.message,
            qualityInstructions: buildQualityInstructions(
              config.repoConfig,
              conflict.repo,
            ),
            customInstructions: getCustomInstructions(
              config.repoConfig,
              conflict.repo,
            ),
            claudeTimeout: config.claudeTimeout,
            claudeNoOutputTimeout: config.claudeNoOutputTimeout,
            maxRateLimitRetries: config.maxRateLimitRetries,
            workerId: getWorkerUniqueId(config.workerName),
            needsHumanLabel: config.needsHumanLabel,
            repoConfigs: config.repoConfig,
          });

          if (!result.ok) {
            logger.error("Merge-conflict resolution failed", {
              repo: conflict.repo,
              prNumber: conflict.prNumber,
              error: result.error.message,
            });
            return null;
          }

          // A pushed merge changes the PR's state, so the iteration-scoped
          // open-PR cache must not serve the stale listing (Issue #1799).
          if (result.value.merged) {
            await issueCache.invalidate(conflict.repo, "prs_open_all");
          }

          logger.info(result.value.summary, {
            repo: conflict.repo,
            prNumber: conflict.prNumber,
          });
          return {
            processed: result.value.processed,
            merged: result.value.merged,
          };
        },
      });

      return { ok: true, value: { processed: drain.processed } };
    },

    // -- Priority 1.62: Nudge stalled CI on Vibe Coder PRs (Issue #2100) --
    async nudgeStalledCi() {
      try {
        const scan = await findPrsNeedingCiNudge({
          githubUser,
          allowedAuthors: fleetPrAuthorInput.allowedAuthors,
          fleetPrAuthors: fleetPrAuthorInput.fleetPrAuthors,
          repos,
          ghCommandFn: runGhCommand,
          // Shared PR-list cache (Issue #4303): reuses the superset
          // listing the earlier Priority-1.x scans already fetched.
          cache: issueCache,
          log: (m) => logger.info(m),
        });
        if (!scan.ok) {
          // Treat scan failures as best-effort: log and continue without
          // failing the priority — this handler never blocks the loop.
          logger.warn("CI nudge scan failed", { error: scan.error.message });
          return { ok: true, value: undefined };
        }

        for (const candidate of scan.value) {
          // For the `none` path, the nudge library needs a checked-out
          // working tree on the PR branch so it can create the empty
          // commit and push. Set up the repo and checkout the PR branch
          // before invoking the nudge.
          let repoWorkDir: string | undefined;
          if (candidate.status === "none") {
            const repoSetupResult = await setupRepo(candidate.repo, workDir);
            if (!repoSetupResult.success) {
              logger.warn("CI nudge: failed to set up repo", {
                repo: candidate.repo,
                error: repoSetupResult.message,
              });
              continue;
            }
            repoWorkDir = repoSetupResult.message;
            try {
              await runGitCommand(
                buildFetchArgs("origin", candidate.headBranch),
                { cwd: repoWorkDir },
              );
              await runGitCommand(
                buildCheckoutArgs(candidate.headBranch),
                { cwd: repoWorkDir },
              );
              // Issue #52: the checkout selects the LOCAL branch from an
              // earlier claim, which is behind origin (PR feedback or a human
              // pushed since). The empty commit would then land on a stale tip
              // and the push is rejected non-fast-forward every pass. The nudge
              // owns nothing local, so hard-reset to the tip we just fetched —
              // the empty commit lands on the current remote head and the push
              // fast-forwards.
              const resetResult = await runGitCommand(
                ["reset", "--hard", "FETCH_HEAD"],
                { cwd: repoWorkDir },
              );
              if (!resetResult.ok || resetResult.value.code !== 0) {
                logger.warn(
                  "CI nudge: could not fast-forward the PR branch to origin — " +
                    "skipping (not nudged)",
                  {
                    repo: candidate.repo,
                    branch: candidate.headBranch,
                    error: resetResult.ok
                      ? resetResult.value.stderr.trim()
                      : resetResult.error.message,
                  },
                );
                continue;
              }
            } catch (err) {
              logger.warn("CI nudge: failed to checkout PR branch", {
                repo: candidate.repo,
                branch: candidate.headBranch,
                error: err instanceof Error ? err.message : String(err),
              });
              continue;
            }
          }

          // Git runner bound to the right cwd for the `none` path; the
          // `queued` path does not need git. Rejects on either an
          // execution failure or a non-zero git exit code so the
          // nudge library's try/catch sees the failure.
          const boundGit = async (args: string[]): Promise<string> => {
            const r = await runGitCommand(
              args,
              repoWorkDir ? { cwd: repoWorkDir } : {},
            );
            if (!r.ok) throw r.error;
            if (r.value.code !== 0) {
              throw new Error(
                `git ${
                  args.join(" ")
                } exited ${r.value.code}: ${r.value.stderr.trim()}`,
              );
            }
            return r.value.stdout;
          };

          const processed = await processCiNudgeCandidate(candidate, {
            ghCommandFn: runGhCommand,
            gitCommandFn: boundGit,
            log: (m) => logger.info(m),
          });
          if (!processed.ok) {
            logger.warn("CI nudge: processing failed", {
              repo: candidate.repo,
              prNumber: candidate.prNumber,
              error: processed.error.message,
            });
            continue;
          }
          logger.info(
            `CI nudge: ${candidate.repo}#${candidate.prNumber} ` +
              `action=${processed.value.nudge.action} ` +
              `commentPosted=${processed.value.commentPosted}`,
          );
        }
        return { ok: true, value: undefined };
      } catch (err) {
        // Never throw out of this handler — the priority must not block
        // the main loop. Log and report success-with-no-action.
        logger.warn("CI nudge: unexpected error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: true, value: undefined };
      }
    },

    // -- Priority 1.63: Blocking-PR stall watchdog (Issue #4025) --
    async scanBlockingPrStalls() {
      try {
        const scan = await libScanBlockingPrStalls({
          repos,
          workOnLabel: config.workOnLabel,
          fleetAuthors,
          // Issue #4133: only a fleet-authored PR can block a `work-on`
          // issue, so only a fleet-authored PR can stall one.
          pushCapableAuthors: maintenanceAuthors,
          authorisedCommenters: trustHolder.read().authorisedCommenters,
          config,
          needsHumanLabel: config.needsHumanLabel,
          githubUser,
          ghCommandFn: runGhCommand,
          // Share the iteration-scoped cache: the watchdog reuses the
          // `issues_all` / `prs_${author}` entries other priorities
          // already fetched.
          cache: issueCache,
          logger,
          log: (m) => logger.info(m),
        });
        if (!scan.ok) {
          logger.warn("Blocking-PR stall scan failed", {
            error: scan.error.message,
          });
        }
        return { ok: true, value: undefined };
      } catch (err) {
        // Never throw out of this handler — a watchdog must not be the
        // reason the main loop stops.
        logger.warn("Blocking-PR stall scan: unexpected error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: true, value: undefined };
      }
    },

    // -- Priority 1.65: Auto-merge --
    async ensureAutoMerge() {
      try {
        for (const repo of repos) {
          if (!isRepoAllowed(repos, repo)) continue;
          // Issue #1787: list open worker PRs through the cached
          // `fetchOpenPRsByUser` helper so the auto-merge sweep
          // shares the iteration-scoped `prs_${user}` cache.
          try {
            const prs = await fetchOpenPRsByUser(
              repo,
              githubUser,
              issueCache,
              runGhCommand,
            );
            let mutated = false;
            for (const pr of prs) {
              try {
                // Issue #3909: pass the head branch so the milestone
                // open-children gate needs no extra lookup.
                const outcome = await enableAutoMerge({
                  repo,
                  prNumber: pr.number,
                  headRefName: pr.headRefName,
                  // Issue #4375: the base decides between GitHub's --auto
                  // (protected: waits for checks) and the gated direct
                  // merge (unprotected: --auto would merge immediately).
                  baseRefName: pr.baseRefName,
                  log: (message: string) => logger.warn(message),
                });
                // Issue #470: this outcome used to be discarded. A gate that
                // refused every merge in the fleet was therefore invisible —
                // the priority logged its name and a duration while nothing
                // merged, no milestone child closed, and no milestone ever
                // completed. A gate may refuse; it may not refuse silently.
                logAutoMergeOutcome(logger, repo, pr.number, outcome);
                mutated = true;
              } catch (err) {
                // Best-effort per PR — but say so. A silent catch here is how
                // the same class of failure hides next time (Issue #470).
                logger.warn("Auto-merge attempt threw", {
                  repo,
                  prNumber: pr.number,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            // Issue #1799: enabling auto-merge can immediately close a
            // PR when all checks already pass. Invalidate the cached
            // open-PR list for this repo so the next reader inside the
            // same iteration sees current state.
            if (mutated) {
              await issueCache.invalidate(repo, `prs_${githubUser}`);
            }
          } catch { /* best-effort per repo */ }
        }
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    // -- Priority 1.66: Branch cleanup --
    async cleanupMergedBranches() {
      // Issue #1787: pass `issueCache` so the merged-PR fetch and the
      // per-branch open-PR safety check share the iteration-scoped
      // cache. Issue #4255: the persisted watermark skips PRs already
      // swept on earlier cycles, and the summary line makes this step's
      // cost visible — it used to be a 12–20 minute silent hole.
      const startedAt = Date.now();
      const result = await cleanupMergedPrBranches(
        repos,
        githubUser,
        {
          cache: issueCache,
          watermarkPath: mergedSweepWatermarkPath(workDir),
        },
      );
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      if (result.ok) {
        const v = result.value;
        logger.info(
          `[startup] cleanupMergedBranches: ${repos.length} repos, ` +
            `${v.deletedCount} deleted, ` +
            `${v.skippedMissingCount ?? 0} skipped-missing, ` +
            `${v.assessedCount ?? 0} assessed, ` +
            `${v.skippedCount} skipped-unsafe, ${seconds}s`,
        );
      }
      return result.ok
        ? { ok: true, value: undefined }
        : { ok: false, error: result.error };
    },

    // -- Priority 1.67: Close issues for merged PRs --
    async closeIssuesForMergedPrs() {
      try {
        // Issue #1787: pass `issueCache` so the merged-PR list reuses
        // `prs_merged_${user}`. Issue #4256: the reconcile watermark
        // skips PRs already reconciled on earlier cycles — this priority
        // used to spend 4–6 minutes and up to 840 GraphQL issue views
        // per cycle re-discovering that old issues are still closed.
        const startedAt = Date.now();
        const closed = await prIssueCloseForMerged(
          repos,
          githubUser,
          undefined,
          config.planningLabel,
          issueCache,
          { watermarkPath: mergedReconcileWatermarkPath(workDir) },
        );
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        logger.info(
          `Close Issues for Merged PRs: ${repos.length} repos, ` +
            `${closed} closed, ${seconds}s`,
        );
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    // -- Priority 1.68: Recover assigned with closed PRs --
    async recoverAssignedWithClosedPr() {
      try {
        // Issue #1787: pass `issueCache` so the assigned-issue and
        // merged-PR scans reuse the iteration-scoped cache.
        await recoverClosedPrFn(
          stuckIssueConfig,
          githubUser,
          config.planningLabel,
          undefined,
          issueCache,
        );
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    // -- Priority 1.72: Milestone branch sync (Issue #1238) --
    async syncMilestoneBranches() {
      if (!config.syncMilestoneBranches) {
        return { ok: true, value: undefined };
      }
      try {
        await syncMilestoneBranchesFn(repos, config, logger);
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    // -- Priority 1.7: Milestone completions --
    async checkMilestoneCompletions() {
      try {
        await checkAndHandleMilestoneCompletionsFn(
          repos,
          logger,
          config.serviceAccounts ?? [],
          issueCache,
        );
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    // -- Priority 1.75: Refinement --
    async findAndProcessRefinement() {
      const result = await findAndProcessByLabel(
        config.refineIssueLabel,
        processIssueRefinement,
      );
      return { ok: true, value: result };
    },

    // -- Priority 1.78: Grill-me clarification (Issue #1619) --
    async findAndProcessGrillMe() {
      const result = await findAndProcessByLabel(
        config.grillMeLabel,
        processGrillMe,
      );
      return { ok: true, value: result };
    },

    // -- Priority 1.79: Quorum plan-off (Issue #4112) --
    // Ahead of planning: Quorum decides what the plan is, planning splits it.
    async findAndProcessQuorum() {
      const result = await findAndProcessByLabel(
        config.quorumLabel,
        processQuorum,
      );
      return { ok: true, value: result };
    },

    // -- Priority 1.80: Planning --
    async findAndProcessPlanning(opts) {
      // Issue #58: the dispatcher's watchdog deadline rides into the planning
      // context so the post-publication Failure-Detection self-repair defers
      // offenders it cannot finish rather than being killed mid-repair.
      const result = await findAndProcessByLabel(
        config.planningLabel,
        processIssuePlanning,
        opts?.deadlineEpochMs,
      );
      return { ok: true, value: result };
    },

    // -- Priority 1.81: Failure-Detection repair resume (Issue #60) --
    // Finishes what a partially-repaired planning run left outstanding: it
    // re-gates each labelled parent's native sub-issues and repairs only what
    // still offends, so a sub-issue fixed by hand costs no Claude call at all.
    async resumeFailureDetectionRepairs(opts) {
      try {
        const result = await runFailureDetectionResumePass({
          repos,
          ghClient: createGitHubClient(logger),
          ghCommandFn: runGhCommand,
          runClaude: (repairPrompt: string) =>
            workerDeps.claude.runClaudeWithRetry(
              {
                prompt: repairPrompt,
                timeoutSeconds: config.planningTimeout,
                killAfterSeconds: config.planningKillAfter,
                phase: "planning",
                cwd: config.workDir,
                logger,
              },
              { maxRetries: config.maxRateLimitRetries },
            ),
          logger,
          needsHumanLabel: config.needsHumanLabel,
          githubUser,
          // Issue #58: the dispatcher's watchdog deadline bounds the repair so
          // offenders it cannot finish are deferred, not killed mid-flight.
          ...(opts?.deadlineEpochMs !== undefined
            ? { deadlineMs: opts.deadlineEpochMs }
            : {}),
        });
        return {
          ok: true,
          value: { processed: result.outcomes.length > 0 },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    // -- Priority 1.85: Question answering --
    async findAndProcessQuestion() {
      const result = await findAndProcessByLabel(
        config.questionLabel,
        processIssueQuestion,
      );
      return { ok: true, value: result };
    },

    // -- Priority 1.9: Stale workflow detection (Issue #1240) --
    async scanStaleWorkflowIssues(opts) {
      try {
        await scanStaleWorkflowIssuesFn(
          repos,
          config,
          logger,
          opts.shouldShutdown,
          issueCache,
        );
        return { ok: true, value: undefined };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },

    // -- Priority 2: Issue scanning --
    processedIssues,

    // Issue #219: a slot that lost the acquire race drops the winner's
    // cached issue list, so its next scan re-reads that repo instead of
    // being served the same ranking from the 600 s cache.
    async invalidateRepoIssueCache(repo: string) {
      await issueCache.invalidateRepo(repo);
    },

    async findNextIssue(options?: {
      excludeRepos?: ReadonlySet<string>;
      excludeIssues?: ReadonlySet<string>;
      onScanSummary?: (summary: DiagnosticSummary) => void;
    }) {
      // Load the run-local holds once before scanning (synchronous check
      // per issue). Issue #655: the same set the census models.
      const runLocalHold = await loadRunLocalHolds();
      const result = await findOldestIssue(config, {
        githubUser,
        ghCommandFn: runGhCommand,
        cache: issueCache,
        timelineCache,
        timelineBatchRegistry,
        // Issue #181: the persisted cooldown OR this run's own memory. The
        // cached issue list has a 600 s TTL, so without the second term an
        // issue this run just finished — or closed — is re-offered seconds
        // later by the very same stale list.
        // Issue #245: an issue this cycle deferred for the adaptive claim
        // floor is skipped by the same per-issue filter, so the scan ranks
        // the next candidate instead of re-offering the one that cannot fit
        // the runway left. The worker log states the real reason; the
        // finder's own counts tally it with the cooldown skips.
        isIssueInCooldown: (repo, num) =>
          runLocalHold(repo, num) ||
          options?.excludeIssues?.has(issueClaimKey(repo, num)) === true,
        // Repositories held by sibling slots (Issue #4176): skipped so no
        // two slots share a clone.
        ...(options?.excludeRepos
          ? { excludeRepos: options.excludeRepos }
          : {}),
        closedPrCooldownSeconds: config.closedPrCooldownSeconds,
        // Issue #4024: the set the PR-maintenance scans actually use, so
        // any divergence from the blocking guard warns this iteration.
        maintenanceAuthors,
      });

      // Issue #460: keep the scan's own per-issue skip reasons so the
      // idle-inversion escalation can name the gate that refused each issue
      // the census called claimable. Diagnostics only — overwritten by each
      // scan, read once at the filing decision point.
      lastScanBlockedDetails = result.blockedDetails ?? [];

      // Issue #219: hand the scan's counts to the caller before returning,
      // so a slot that gets nothing back logs why rather than retiring in
      // silence.
      if (result.diagnosticSummary) {
        options?.onScanSummary?.(result.diagnosticSummary);
      }

      if (!result.found || !result.output) {
        return { ok: true, value: null };
      }

      const parts = result.output.split("|");
      const repo = parts[0] ?? "";
      const issueNumber = parseInt(parts[1] ?? "0", 10);
      const milestoneTitle = parts[3] ?? "";
      const issueTitle = parts.slice(4).join("|");

      if (!repo || !issueNumber) {
        return { ok: true, value: null };
      }

      return {
        ok: true,
        value: { repo, issueNumber, issueTitle, milestoneTitle },
      };
    },

    // Issue #3760: claim-boundary safety net. A heartbeat interval still
    // active here was leaked by a previous claim's processor (every
    // start/stop pair should have closed it in a `finally`). Left running,
    // its marker refreshes are refused once the next claim reseeds the
    // write-repo allowlist — `WRITE_REPO_BLOCKED` … `heartbeat_failure
    // (consecutive: N)` — and sibling hosts' stuck-detection can steal the
    // issue. Stop and log each leak so the offending processor is
    // identifiable from the worker log.
    // One registry of held repositories for the whole process (Issue
    // #4176): the pool, the slot-aware heartbeat sweep and the status line
    // all read the same holds.
    inFlightRepos,
    slotCeiling,
    checkHostDisk: () => hostDisk.check(),
    // Issue #242: before the disk gate stops this cycle claiming, drop the
    // work root's disposable tier — the sibling/data clones a gate pulled
    // in — largest first, then re-read the disk so a host that healed
    // claims normally.
    reclaimDiskSpace: async () => {
      if (config.repos.length === 0) {
        // Without a monitored list every clone would read as disposable —
        // fail loud rather than reclaim the wrong tier.
        return {
          bytesReclaimed: 0,
          detail:
            "no monitored repositories — refusing to tier the work root (Issue #242)",
          healed: false,
        };
      }
      const result = await reclaimWorkVolumeTiers({
        workDir,
        monitoredRepos: config.repos,
        mode: "disk-low",
        bytesNeeded: hostDisk.shortfallBytes,
        // Issue #477: the fleet-health checkout is a side clone by shape, so
        // this sweep used to delete it to win back space — after which #410
        // refused to clone it back while the host stayed below the floor, and
        // the host reported nothing to the fleet board for as long as the
        // condition lasted. It is the instrument that reports this fault, and
        // megabytes never buy back a floor measured in gigabytes.
        protectedNames: [
          fleetHealthCheckoutDirName(fleetHealthConfig.healthDir),
        ],
        log: (message: string) => logger.info(message),
      });
      const after = await hostDisk.check({ force: true });
      // Issue #384: on a containerised host the sweep above deleted files
      // INSIDE the volume image, and the floor it is measured against is on
      // the host — the image keeps every block it was ever allocated. Say
      // that plainly instead of logging a reclaim that reads as a failure;
      // on a native host `df` is the host, so the bytes are genuinely free
      // and there is nothing to explain away.
      const hostReturn = after.source === "launch-baseline"
        ? ` — ${
          describeGuestReclaimToHost(
            result.bytesReclaimed,
            hostDisk.workVolumeRatchet,
          )
        }`
        : "";
      return {
        bytesReclaimed: result.bytesReclaimed,
        detail: `${
          summariseWorkVolumeTiers(result)
        }${hostReturn} — host disk now ${after.level}: ${after.detail}`,
        healed: after.level !== "low",
      };
    },
    // Issue #244: what the volume is holding right now, one depth-1 `du`
    // walk per top-level directory under a single 120 s budget. Logged at
    // cycle start next to `Concurrency:` so growth is visible in the worker
    // log before the disk gate trips, and again at end of run (Issue #345)
    // where the volume is at its fullest.
    reportWorkVolumeUsage: (options) => workVolume.report(options),
    // Issue #345: both disk signals blind is a health condition — the state
    // GRQ-23 was in for days before it crashed out of disk.
    checkDiskTelemetry: () => diskTelemetry(),
    checkWorkVolumeFault: () => {
      const fault = workVolumeFault();
      return fault === null
        ? { faulted: false, detail: "" }
        : { faulted: true, detail: `${fault.detail} (${fault.command})` };
    },
    // Issue #4369: no agent runs detached or is relaunched after run end.
    terminateActiveAgentRuns: async (
      reason: string,
      options?: { keepTerminating?: boolean },
    ) => {
      await terminateActiveAgentRuns(reason, logger, options);
    },

    // Minimum claim runway (Issues #4304/#425, VibeCoder#170): default 5
    // minutes — only a claim that cannot even finish setup is refused. Since
    // Issue #420 a claim keeps its full execute budget however late in the
    // cycle it is taken, so the floor is measured against the supervisor hard
    // cap below, not the cycle deadline. 0 disables the floor.
    //
    // Resolved by `loadConfig` (Issue #289) from `.config.json`
    // `min_claim_runway_seconds`, falling back to MIN_CLAIM_RUNWAY_SECONDS.
    // Reading the environment here was inert on a containerised host:
    // `container_launch.ts` forwards only the five variables it sets itself,
    // so an operator's override never crossed the boundary and the floor
    // stayed at its default while the docs said otherwise.
    minClaimRunwaySeconds: config.minClaimRunwaySeconds,

    // The supervisor cap both runway floors measure against (Issues
    // #421/#425), published by loop.sh as VIBE_RUN_MAX_SECONDS and anchored
    // by VIBE_RUN_STARTED_EPOCH. Absent env — a CLI run, a host that disabled
    // the cap — leaves both floors inert, which the scan loop logs once.
    claimHardCap: resolveClaimHardCap(config.claudeKillAfter),

    // Adaptive claim floor (Issues #245/#425): the configured execute budget
    // sizes the runway an issue with evidence of a long job must have to the
    // hard cap before it is claimed.
    executeBudgetSeconds: config.claudeTimeout,

    // The evidence that floor reads: one `gh issue view` per candidate,
    // trusting only fleet-authored comments (Issue #245).
    gatherIssueClaimEvidence: (issue: DiscoveredIssue) =>
      fetchIssueClaimEvidence({
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        ghCommandFn: runGhCommand,
        fleetAuthors,
        longJobLabels: config.claimLongJobLabels,
      }),

    // Issue #375: the floor's deferral gets a memory, so a host whose cycle
    // can never satisfy it stops stranding the issue for ever. Counted per
    // *cycle* — `resolveRunId()` is stable for the whole run — because a slot
    // re-scans every 30 s.
    recordAdaptiveFloorDeferral: (key: string) =>
      recordAdaptiveFloorDeferral({
        statePath: adaptiveFloorStatePath(workDir),
        key,
        cycleId: resolveRunId(),
        log: (message: string) => logger.warn(message),
      }),
    clearAdaptiveFloorDeferral: (key: string) =>
      clearAdaptiveFloorDeferral(
        adaptiveFloorStatePath(workDir),
        key,
        (message: string) => logger.warn(message),
      ),

    // Slot-aware sweep (Issue #4178): only heartbeats no live hold owns are
    // stopped, so a sibling slot's — or the maintenance lane's (Issue #391) —
    // healthy heartbeat is never mistaken for a leak. The pool calls this;
    // the serial loop keeps the variant below.
    async sweepLeakedHeartbeatsExcept(live) {
      const leaked = await stopHeartbeatsExcept(live);
      for (const handle of leaked) {
        logger.warn(
          `Swept leaked heartbeat before next claim: ${handle.kind} ` +
            `${handle.repo}#${handle.issueNumber} — its owning processor ` +
            `failed to stop it (Issue #3760); live holds: ${live.length}`,
        );
      }
    },
    async sweepLeakedHeartbeats() {
      const leaked = await stopAllHeartbeats();
      for (const handle of leaked) {
        logger.warn(
          `Swept leaked heartbeat before next claim: ${handle.repo}#${handle.issueNumber} — ` +
            `its owning processor failed to stop it (Issue #3760)`,
        );
      }
    },

    async processIssue(
      issue: DiscoveredIssue,
      cycleDeadlineEpochMs?: number,
    ) {
      const issueData: IssueData = await fetchIssueData(
        issue.repo,
        issue.issueNumber,
      );

      // Issue #3878: verify — and then use — the title this fetch observed,
      // not the one captured during discovery. The scan-time title was never
      // re-read, so a title-only edit hashed as unchanged and the unapproved
      // text still reached the prompt.
      const issueTitle = issueData.title;

      // Issue #3647: re-verify the content-approval snapshot against the
      // bytes just fetched — the scan-time check (Issue #1341) verified a
      // different, earlier copy and discarded it, leaving a TOCTOU window
      // of tens of seconds to minutes of fleet-wide scanning. The pair
      // checked here is exactly the pair that reaches the model.
      const integrity = await verifyPickupContentIntegrity({
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        issueTitle,
        issueBody: issueData.body ?? "",
        issueLabels: issueData.labels ?? [],
        issueAuthor: issueData.author,
        config,
      }, { ghFn: runGhCommand, timelineCache });
      if (integrity.blocked) {
        logger.warn(
          `Skipped ${issue.repo}#${issue.issueNumber}: ${integrity.reason}`,
        );
        return { ok: true, value: { success: false, skipped: true } };
      }

      // Issue #2118: route idle-task wrappers through the template
      // runner before the standard issue pipeline. Without this branch
      // the orchestrator's `idle_task_guard` (in `issue_worker.ts`)
      // refuses every wrapper claimed by the main loop — the routing
      // previously only lived in the `work-on-issue` CLI command path,
      // which the main loop bypasses.
      const idleRoute = await routeIdleTaskInProcessIssue(
        {
          repo: issue.repo,
          issueNumber: issue.issueNumber,
          issueTitle,
          issueLabels: issueData.labels ?? [],
          issueBody: issueData.body ?? "",
          workDir: config.workDir,
          // Issue #186: the scan is bounded by the cycle deadline, exactly as
          // the execute phase is (Issue #4254) — a wrapper claimed minutes
          // before the deadline must not hold its slot past it.
          ...(cycleDeadlineEpochMs !== undefined
            ? { cycleDeadlineEpochMs }
            : {}),
        },
        { logger },
      );
      if (idleRoute.routed) {
        return {
          ok: true,
          value: { success: idleRoute.success, skipped: false },
        };
      }

      // Issue #2579: route a claimed `work-on` issue titled
      // `add-repo: owner/repo` to the `process-add-repo` command instead
      // of the standard coding/PR flow (which would try to open a code
      // PR — wrong for an add-repo request). The allowed-author gate on
      // the claim path already applies; the slug is re-validated
      // downstream by `process-add-repo` (defence in depth).
      const addRepoRoute = await routeAddRepoInProcessIssue(
        {
          repo: issue.repo,
          issueNumber: issue.issueNumber,
          issueTitle,
          config,
        },
        { logger },
      );
      if (addRepoRoute.routed) {
        return {
          ok: true,
          value: { success: addRepoRoute.success, skipped: false },
        };
      }

      // Issue #3860: route a claimed issue titled
      // `seed-idle-tasks: owner/repo` to `process-seed-idle-tasks` instead
      // of the standard coding/PR flow. The agent's baked `gh` allowlist
      // carries only this issue's own repo (#3643), so an agent-driven
      // sweep of another repo is refused with WRITE_REPO_BLOCKED. The
      // worker performs the seeding itself, after re-validating the target
      // against the operator-controlled `.config.json` `repos` list.
      const seedRoute = await routeSeedIdleTasksInProcessIssue(
        {
          repo: issue.repo,
          issueNumber: issue.issueNumber,
          issueTitle,
          config,
        },
        { logger },
      );
      if (seedRoute.routed) {
        return {
          ok: true,
          value: { success: seedRoute.success, skipped: false },
        };
      }

      const ctx = {
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        issueTitle,
        issueBody: issueData.body ?? "",
        issueLabels: issueData.labels ?? [],
        issueComments: "",
        githubUser,
        milestoneTitle: issue.milestoneTitle || undefined,
        config,
        // Issue #4254: bound the execute timeout by the cycle deadline.
        cycleDeadlineEpochMs,
      };

      const result = await workOnIssue(ctx, workerDeps);
      // Issue #175: a phase can declare its own bounce (`expectedSkip`) — a
      // run that neither resolved the issue nor failed. It cools the issue
      // down without failure tracking and without counting as processed.
      const isExpectedSkip = isExpectedSkipResult(result);
      if (!result.success) {
        if (isExpectedSkip) {
          logger.warn(
            `Skipped ${issue.repo}#${issue.issueNumber}: ${result.reason}`,
          );
        } else {
          logger.error(
            `Issue ${issue.repo}#${issue.issueNumber} failed at phase '${result.phase}': ${result.reason}`,
          );
        }
      }

      // Issue #1487: if the worker escalated by adding `needs-human` during
      // this run (success or failure), strip the discovery labels so the
      // issue is not re-picked on the next scan. The label_security layer
      // treats the worker's own label adds as untrusted and removes them
      // from the in-memory label list — removing the discovery labels on
      // the server side keeps the issue out of `fetchIssuesByLabel` results
      // entirely.
      await stripDiscoveryLabelsOnEscalation(
        issue.repo,
        issue.issueNumber,
        config,
      );

      // Timeout-class classification (Issue #4304): a run that burned its
      // whole budget and produced nothing feeds the escalating re-claim
      // cooldown; every other failure keeps the flat base cooldown.
      // A deadline-bound timeout is exempt (VibeCoder#174): the cycle ended
      // with WIP preserved, so the next cycle should resume it, not wait 2 h.
      const failureKind = !result.success && !isExpectedSkip &&
          isTimeoutClassFailureReason(result.reason)
        ? "timeout" as const
        : undefined;

      return {
        ok: true,
        value: {
          success: result.success,
          skipped: isExpectedSkip,
          ...(failureKind ? { failureKind } : {}),
          // The run outcome travels to the claim release (Issue #4325);
          // a skip is not an outcome of a run that never ran.
          ...(result.outcome && !isExpectedSkip
            ? { outcome: result.outcome }
            : {}),
        },
      };
    },

    // -- Failure tracking --
    async trackFailure(key: string) {
      await failureTrackerTrack(failureConfig, key);
    },
    async resetFailures() {
      await failureTrackerReset(failureConfig);
    },
    async shouldExitOnFailures() {
      return await failureTrackerShouldExit(failureConfig);
    },
    async recordIssueCooldown(
      repo: string,
      issueNumber: number,
      failureKind?: "timeout",
    ) {
      const recorded = await cooldownRecordFn(
        cooldownConfig,
        repo,
        issueNumber,
        failureKind,
      );
      // Third consecutive timeout inside the escalation window
      // (Issue #4304): retrying stops being credible — hand the issue to
      // a human with the attempt evidence instead of burning a fourth
      // cycle. Best-effort: the cooldown itself already blocks re-claims
      // for 24 h even if the escalation cannot be posted.
      if (
        failureKind === "timeout" && recorded.ok &&
        recorded.value.consecutiveTimeouts >= 3
      ) {
        try {
          const ghClient = createGitHubClient(logger);
          await escalateToHuman({
            ghClient,
            repo,
            target: { kind: "issue", number: issueNumber },
            needsHumanLabel: config.needsHumanLabel,
            heading: "Repeated execute timeouts",
            reason:
              `This issue has now timed out ${recorded.value.consecutiveTimeouts} ` +
              `times in a row within 48 h — each attempt burned a full agent ` +
              `run and produced no changes. The worker has stopped retrying ` +
              `(24 h escalating cooldown, Issue #4304).`,
            nextStep:
              "Split the issue into smaller pieces, raise its timeout budget, " +
              "or investigate why the agent cannot finish it (see the worker " +
              "logs for the per-attempt progress lines).",
            dedupKey: `timeout-escalation-${issueNumber}`,
            githubUser,
            deps: { github: { ensureLabelExists: ensureLabelExistsFn } },
            logger,
          });
        } catch (err) {
          logger.warn("Timeout-escalation handoff failed (non-fatal)", {
            repo,
            issueNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },

    // -- Circuit breaker --
    async circuitBreakerReset() {
      await circuitBreakerResetFn(circuitBreakerConfig);
    },
    async circuitBreakerRecordZeroProgress() {
      await recordZeroProgress(circuitBreakerConfig);
    },
    async circuitBreakerGetSleepInterval() {
      return await circuitBreakerGetSleep(circuitBreakerConfig);
    },
    async isRateLimitActive() {
      const signalResult = await rateLimitSignalIsActive(workDir);
      if (signalResult.ok && signalResult.value.active) {
        return true;
      }
      return false;
    },

    async getRateLimitRemainingSeconds() {
      const signalResult = await rateLimitSignalIsActive(workDir);
      if (signalResult.ok && signalResult.value.active) {
        return signalResult.value.remainingSeconds;
      }
      return 0;
    },

    async getRateLimitReset() {
      // `gh api rate_limit` is a free call (does not consume quota and
      // works while rate-limited), so it is safe to invoke from inside
      // a rate-limit handler. Issue #1780.
      try {
        const raw = await runGhCommand(["api", "rate_limit"]);
        const parsed = JSON.parse(raw) as {
          resources?: {
            graphql?: { reset?: number };
            core?: { reset?: number };
          };
        };
        const reset = parsed.resources?.graphql?.reset ??
          parsed.resources?.core?.reset;
        if (typeof reset === "number" && Number.isFinite(reset)) {
          return reset;
        }
      } catch { /* fall through to default */ }
      return Math.floor(Date.now() / 1000) + 3600;
    },

    async preflightGitHubRateLimit() {
      // Issue #1675: env var escape hatch to disable the file-backed cache
      // (e.g. for debugging or when an operator wants every cycle to do a
      // fresh round-trip). Defaults to cache-enabled.
      const noCacheEnv = Deno.env.get("VIBE_PREFLIGHT_NO_CACHE");
      const noCache = noCacheEnv === "1" || noCacheEnv === "true";
      return await preflightGitHubRateLimit({
        workDir,
        nowSeconds: () => Math.floor(Date.now() / 1000),
        runGhRateLimit: () => runGhCommandRaw(["api", "rate_limit"]),
        log: (m) => logger.info(m),
        noCache,
      });
    },

    // -- Repo failure tracking --
    // Issue #2793: await the read-modify-write file I/O so overlapping calls
    // cannot clobber each other (lost-update race) and a write failure is not
    // silently swallowed by a floating promise.
    async resetRepoFailures() {
      await repoTrackerReset(repoFailureConfig);
    },
    async recordRepoFailure(repo: string, issueNumber?: number) {
      await repoTrackerRecordFailure(repoFailureConfig, repo, issueNumber);
    },
    async recordRepoSuccess(repo: string) {
      await repoTrackerRecordSuccess(repoFailureConfig, repo);
    },

    // -- Crash handling --
    async sendCrashNotification(details: string) {
      try {
        await crashNotifyFn(crashConfig, {
          exitCode: 1,
          plannedShutdown: false,
          repo: "",
          issueNumber: 0,
          logTail: details,
          claudeOutput: "",
          workStage: "run-core",
          workStartTime: Math.floor(Date.now() / 1000),
        });
      } catch { /* best-effort */ }
    },
    async clearHeartbeat() {
      try {
        await libClearHeartbeat(workDir, "", 0);
      } catch { /* best-effort */ }
    },
    // Issue #2670: release a specific issue's claim — unassign the worker AND
    // clear the heartbeat/marker. Wired with the real githubUser and the
    // machineId-bound marker options so the failure path no longer leaves the
    // issue assigned (root cause of incident #2648). Best-effort.
    async releaseClaim(
      repo: string,
      issueNumber: number,
      outcome?: RunOutcome,
    ) {
      try {
        await libReleaseClaim(workDir, repo, issueNumber, {
          githubUser,
          markerOptions: defaultMarkerOptions,
          ...(outcome ? { outcome } : {}),
        });
      } catch { /* best-effort */ }
      // Code-fixable no-PR failures raise a deduped worker-fault issue
      // (Issue #4329). Strictly after the claim release and best-effort:
      // the helper never throws, and nothing here may stop the release.
      if (outcome?.kind === "no_pr") {
        try {
          const marker = await readMarkerState(workDir, repo, issueNumber);
          const decision = await fileRunFailureIssue({
            report: {
              sourceRepo: repo,
              sourceIssueNumber: issueNumber,
              outcome,
              machineId,
              ...(marker?.commentId
                ? {
                  releaseCommentUrl:
                    `https://github.com/${repo}/issues/${issueNumber}#issuecomment-${marker.commentId}`,
                }
                : {}),
            },
            ghFn: runGhCommandRaw,
            workDir,
            log: (message) => logger.info(message),
          });
          if (
            decision.action === "suppressed" && decision.reason === "gh_failed"
          ) {
            logger.warn(
              `Run-failure issue filing failed for ${repo}#${issueNumber} (class ${decision.failureClass}) — the release comment carries the diagnosis`,
            );
          }
        } catch { /* best-effort — never blocks the release */ }
      }
      // Issue #4170: a released claim ends the attempt deliberately, so the
      // durable resume state must not make the next attempt "resume" it.
      // Issue #148 carves out the one release that did NOT end deliberately:
      // a timed-out run that preserved its work as a WIP commit on the issue
      // branch. There the pointer is how the next claim finds that commit, so
      // deleting it would leave the work stranded on the branch.
      if (resumeStateSurvivesRelease(outcome)) {
        logger.info(
          `Keeping the resume state for ${repo}#${issueNumber} — the run ` +
            `preserved WIP on its issue branch, so the next claim resumes ` +
            `from it (Issue #148)`,
        );
      } else {
        await deleteResumeState(workDir, repo, issueNumber);
      }
    },
    async cleanupInProgressIssue() {
      try {
        await crashCleanupFn({
          repo: "",
          issueNumber: 0,
          githubUser,
          workDir,
        });
      } catch { /* best-effort */ }
    },

    // -- Status (best-effort, non-blocking) --
    // The aggregate slot table (Issue #4181) is the one status worth a
    // log line: `Status: s1 o/a#1 | s2 o/b#2`, written when it changes so
    // an operator reading worker.log can see every live slot at a glance.
    // Idle/success/failure transitions stay silent — the phase lines
    // already say so.
    setStatusIdle: () => {
      lastStatusLine = undefined;
      return Promise.resolve();
    },
    setStatusWorking: (details: string) => {
      if (details !== lastStatusLine) {
        lastStatusLine = details;
        if (details.includes(" | ")) logger.info(`Status: ${details}`);
      }
      return Promise.resolve();
    },
    setStatusSuccess: () => Promise.resolve(),
    setStatusFailure: () => Promise.resolve(),
    resetWindowTitle() {/* Terminal title — shell concern */},

    // -- Signal handling --
    addSignalListener(signal: string, handler: () => void) {
      try {
        if (signal === "SIGTERM" || signal === "SIGINT") {
          Deno.addSignalListener(signal as Deno.Signal, handler);
        }
      } catch { /* May not be available in all environments */ }
    },
    removeSignalListener(signal: string, handler: () => void) {
      try {
        if (signal === "SIGTERM" || signal === "SIGINT") {
          Deno.removeSignalListener(signal as Deno.Signal, handler);
        }
      } catch { /* best-effort */ }
    },

    // -- Fault tolerance observability (Issue #1173) --
    async writeFaultToleranceSummary() {
      try {
        await writeFtSummary(workDir);
      } catch { /* best-effort */ }
    },

    // -- Daily spend ceiling (Issue #3684) --
    // Present only when an operator configured a ceiling; otherwise the run
    // loop skips the check entirely.
    ...(checkSpendCeiling ? { checkSpendCeiling } : {}),

    // -- Misc --
    touchPidFile: () => Promise.resolve(),
    sleep: (ms?: number) =>
      new Promise((resolve) => setTimeout(resolve, ms ?? 30000)),
    now: () => Date.now(),

    // Issue #2473: watchdog timer for the per-handler hard timeout. The timer
    // is unref'd so a handler that completes quickly (the common case) leaves
    // behind a pending timer that never delays process exit — the loop moves
    // on without awaiting it.
    watchdogDelay: (ms: number) =>
      new Promise<void>((resolve) => {
        const id = setTimeout(resolve, ms);
        Deno.unrefTimer(id);
      }),

    // Issue #1783: drop the timeline-batch registry's accumulated
    // entries at the iteration boundary. Run-core calls this just
    // after `resetGhCallMetrics`.
    // Issue #1841: also clear the per-iteration comment cache so
    // entries from the previous iteration cannot leak into this one.
    // Issue #4039: and forget the last `[repo-access]` status line, so an
    // ongoing outage logs exactly one line per iteration — no more
    // (per-call-site spam) and no less (a silent, unrecoverable outage).
    resetIterationCaches: () => {
      timelineBatchRegistry.reset();
      clearCommentCache();
      resetRepoAccessLogState();
    },

    // Issue #256: the per-cycle trusted-author refresh, now source-aware.
    //
    // `author_source: "config"` keeps the static arrays — unchanged, and
    // still the default, so no host flips trust models by upgrading.
    //
    // `"github"` resolves write/maintain/admin collaborators minus
    // exclusions (Issue #254) and folds them to the fleet-wide set. Three
    // rules, all of them the parent issue's:
    //
    //  1. A resolve failure returns `{ ok: false }`. It never falls back to
    //     the local arrays, even when those arrays are populated — the
    //     skip-cycle gate in run_core then stands the cycle down. A
    //     fallback would mean a GitHub outage silently restores whatever
    //     stale list sits in `.config.json`, which is the failure mode the
    //     whole sub-issue exists to prevent.
    //  2. The fold is an intersection, not a union: write access on one
    //     monitored repo must not confer trust on another.
    //  3. `applyTrustSnapshot` is the only way in, so the comment-trust
    //     path, the fleet-PR guards, the heartbeat marker allowlist and
    //     the suppression allowlist all move together or not at all.
    refreshTrustedAuthors: async () => {
      if (config.authorSource !== "github") {
        applyTrustSnapshot({
          allowedAuthors: config.allowedAuthors ?? [],
          authorisedCommenters: config.authorisedCommenters ?? [],
        });
        return { ok: true as const };
      }

      trustRefreshCycle++;
      const resolve = options.resolveTrustedAuthors ?? resolveDerivedAuthors;
      const resolved = await resolve(
        {
          repos: config.repos ?? [],
          serviceAccounts: config.serviceAccounts ?? [],
          githubUser,
          exclusionTeamSlug: config.exclusionTeam,
        },
        {
          cycleId: trustRefreshCycle,
          log: (message: string) => logger.info(message),
        },
      );

      if (!resolved.ok) {
        return {
          ok: false as const,
          reason:
            `author_source=github: could not resolve trusted authors from ` +
            `${resolved.failedSource}: ${resolved.reason} — refusing to fall ` +
            `back to the local allowed_authors arrays`,
        };
      }

      const folded = intersectDerivedAuthors(resolved.byRepo);
      logger.info(formatDerivedAuthorsFoldSummary(resolved.byRepo, folded));
      applyTrustSnapshot(folded);
      return { ok: true as const };
    },

    // Issue #1935: per-iteration private-repo-6 heartbeat. The end-of-run
    // call in `commands/run_core.ts` was silently lost when the parent
    // shell sent SIGTERM during the post-loop block, leaving the host
    // flagged dead on the dashboard. Reporting from the top of every
    // priority-loop iteration keeps the heartbeat alive for the lifetime
    // of the run. Best-effort — `runFleetHealthReporting` already swallows
    // its own errors, but we additionally guard here so any unexpected
    // throw is logged and the loop continues.
    reportFleetHealthHeartbeat: async () => {
      try {
        // Issue #333: refresh before reporting so a multi-day quota outage is
        // named on the heartbeat that carries it.
        await refreshQuotaOutageNote();
        await runFleetHealthReporting(fleetHealthConfig, fleetHealthDeps);
      } catch { /* best-effort */ }
    },

    // Issue #2005, #2023: idle-task issue filer. Invoked from the main
    // loop after a fully-idle pass (no priority work and no claimable
    // issue). The filer shuffles the monitored-repo list, picks the
    // first repo with no open `idle-task` issue, and files a real
    // `idle-task` issue — no last-scan timestamps or idle-cycle counters
    // are required. The next iteration claims it through the standard
    // priority dispatch. Best-effort — any throw is caught here and
    // logged via `logger.warn` so a filer crash never aborts the main
    // loop.
    runIdleTaskFiler: async () => {
      try {
        // Issue #2158: rescue any orphan `Run a security scan` wrappers
        // (filed unlabelled when the per-issue retry in
        // `maybe-file-idle-task` exhausted its REAPPLY_MAX_ATTEMPTS
        // budget) before deciding whether to file a new one. The
        // sweep is the same helper #2131 wired into `setup.sh`, but
        // run on every idle tick so mean-time-to-rescue drops from
        // "next worker restart" to "next idle tick".
        await runIdleTaskFilerCycle({
          repos,
          log: (line) => logger.info(line),
          fileFn: async () => {
            await maybeFileIdleTaskCommand.execute(
              {
                "monitored-repos": repos.join(","),
                "github-user": githubUser,
                "worker-user": githubUser,
                // Issue #2467: the `worker-repo`/queue-gate (#2082) arg
                // was removed because the gate fired on every open
                // `work-on` issue in the worker repo and starved
                // idle-task creation across the monitored set. Other
                // gates (#2092, #2104, #2054/#2440, #2441) already
                // bound overcreation.
                // Issue #2018: route the filer's `[idle-task] ...` progress
                // lines through the shared worker Logger so they land in
                // `~/logs/worker-*.log` alongside everything else. The
                // command otherwise logs via `console.log`, which Deno
                // inherits from the parent shell's tty and never reaches
                // the worker log — making "filer never fires" indistinguishable
                // from "filer fired but silently failed". Same root cause
                // and same fix shape as PR #2016 for the private-repo-6
                // heartbeat.
                __testDeps: { log: (line: string) => logger.info(line) },
              },
              config,
            );
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Idle-task filer trigger failed", { error: msg });
      }
    },

    // Issue #2106: idle-detection audit. Invoked from the loop at the
    // same gate as `runIdleTaskFiler` so its `[idle-detect] ...` lines
    // appear immediately before the filer's `[idle-task] ...` lines in
    // the worker log. The audit probes every monitored repo
    // independently of the Priority 2 scan and raises a
    // `mis_classification` alert when its verdict disagrees with the
    // scan's `foundClaimableIssue` flag. Logs route through the shared
    // `logger.info` for the same reason as the filer above.
    runIdleDetectAudit: async ({ tick, scanFoundClaimable }) => {
      const { auditClaimableState } = await import(
        "./idle_detect_diagnostics.ts"
      );
      try {
        // Issue #655: the same holds the claim scan and the census read, so
        // the audit stops counting work this run is itself withholding — the
        // over-count that kept `mis_classification` firing, and the audit's
        // own `claimableTotal` suppressing the idle-task filer, for the life
        // of the process.
        const runLocalHold = await loadRunLocalHolds();
        const result = await auditClaimableState({
          repos,
          workerUser: githubUser,
          tick,
          scanFoundClaimable,
          // Issue #4223: read each repo's open PRs through the same shared
          // `prs_open_all` cache the census uses (Issue #3526), so the audit
          // stops counting PR-blocked work as claimable. Whichever of the two
          // runs first populates the cache, so the gate adds no API call.
          // `auditClaimableState` catches a rejection itself and falls back to
          // no PR blocking.
          openPRsFn: (repo: string) => fetchAllOpenPRs(repo, issueCache),
          // GRQ#4419: an issue named by a merged fleet PR is refused
          // permanently by the scan, so counting it as claimable kept the
          // `mis_classification` ALERT firing against a scan that was right.
          mergedPRsFn: fetchMergedPRsForCensus,
          // Issue #655: this run's persisted retry cooldown and its
          // processed-issue registry, resolved above from the one hold set
          // `findNextIssue` filters its candidates against.
          runLocalHoldFn: runLocalHold,
          // Issue #479: while a host-level gate is active the scan never ran,
          // so `mis_classification` is guaranteed to fire and says nothing.
          // Read from the same signals the census and the fleet-board note
          // use, so all three agree about why this host is idle.
          claimGateActive: claimGateReason() !== "cycle_deadline",
          log: (line: string) => logger.info(line),
        });
        // Return the claimable total so the run-core gate can skip
        // the idle-task filer this iteration when the audit already
        // sees claimable work (Issue #2106 + private-repo-10 #45-#48
        // budget guard).
        return { claimableTotal: result.claimableTotal };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Idle-detect audit failed (continuing)", { error: msg });
        return undefined;
      }
    },

    // Issue #2811: idle-decision claimable-work census. Invoked at the
    // idle-task filing decision point so the idle-vs-work-on inversion is
    // observable from the log alone. For every monitored repo it logs a
    // structured `[idle-census] ...` block recording availability, the
    // resolved `nice` tier, the open unblocked priority/work-on/
    // low-priority/idle-task counts, and the inversion signal. Reads
    // through the iteration-scoped `IssueCache`/`fetchAllIssues` so a
    // quiet cycle adds no extra issue-list call (whichever of this and the
    // Priority 2 scan ran first populates the shared `issues_all` cache).
    // Logs route through `logger.info` for the same visibility reason as
    // the filer and audit above. Best-effort — any throw is caught here
    // and logged so a census failure never reaches the loop's catch.
    runIdleDecisionCensus: async (
      { decisionPoint, claimScanCompleted, claimedRepos },
    ) => {
      try {
        const host = `${Deno.hostname()}:${Deno.pid}`;
        // Issue #655: the same holds the claim scan filtered its candidates
        // against, so the two instruments cannot disagree about them.
        const runLocalHold = await loadRunLocalHolds();
        const perRepo = await Promise.all(
          repos.map(async (repo) => {
            const issues = await fetchAllIssues(repo, issueCache);
            // Issue #3526: read the repo's open PRs (through the shared
            // `prs_open_all` cache) so the census can exclude issues the
            // Priority 2 scan would refuse under getBlockingPRForIssue —
            // otherwise a PR-blocked backlog raises the inversion signal
            // and starves the idle-task filer. Best-effort: on a fetch
            // failure the census falls back to no PR blocking, which at
            // worst files an idle-task while work exists (bounded harm).
            let openPRs: Awaited<ReturnType<typeof fetchAllOpenPRs>> = [];
            try {
              openPRs = await fetchAllOpenPRs(repo, issueCache);
            } catch {
              openPRs = [];
            }
            // GRQ#4419: read the repo's merged fleet PRs so an issue the scan
            // refuses permanently (`merged-pr-permanent`, Issue #3151) stops
            // holding `inversion_signal=true` for ever — the exact strand that
            // filed GRQ#4419 and VibeCoder#429. Same best-effort contract as
            // the open-PR fetch above.
            let mergedPRs: Awaited<
              ReturnType<typeof fetchRecentlyClosedPRsForFleet>
            > = [];
            try {
              mergedPRs = await fetchMergedPRsForCensus(repo);
            } catch {
              mergedPRs = [];
            }
            return {
              repo,
              monitored: true,
              // Issue #437: honest about what the claim scan actually did.
              // The pool stops before its next claim on the cycle deadline /
              // runway floor, a shutdown or a drain — on such a cycle the
              // backlog was never evaluated, so the repo was not scanned and
              // its claimable work was deferred rather than refused.
              scannedThisCycle: claimScanCompleted,
              // Issue #479: name the gate that actually refused the work. A
              // host below its disk floor (#226) or carrying a work-volume
              // fault (#229) stops claiming for the whole host, and
              // recording that as `cycle_deadline` is what let GRQ-23 sit
              // gated for three days — #437's carve-out declined to escalate
              // because "nothing refused the work", true of a deadline and
              // false of a gate, so the real cause was never named and an
              // operator reading the census went looking at cycle duration.
              ...(claimScanCompleted ? {} : { skipReason: claimGateReason() }),
              nice: getRepoNice(config.repoConfig, repo),
              issues: issues.map((i) => ({
                number: i.number,
                labels: i.labels,
                assignees: i.assignees,
                milestone: i.milestone,
                // Issue #460: `fetchAllIssues` already requests `body`, so
                // the census's dependency gate costs no extra call.
                body: i.body,
              })),
              openPRs,
              mergedPRs,
              // Issue #655: the candidates `find_oldest_issue.ts` drops after
              // every collector has passed them — a persisted retry cooldown,
              // or an issue this run has already finished with. Unmodelled,
              // they held `inversion_signal=true` open for the life of the
              // process.
              runLocalHolds: new Set(
                issues
                  .filter((i) => runLocalHold(repo, i.number))
                  .map((i) => i.number),
              ),
            };
          }),
        );
        const census = buildIdleDecisionCensus({
          decisionPoint,
          workerUser: githubUser,
          repos: perRepo,
          // Issue #460: a repo the scan claimed from this cycle was served,
          // not refused — whatever the run's outcome. The census withdraws
          // it from the escalation set and reports it as served.
          claimedRepos,
        });
        const censusLines = formatIdleDecisionCensus(census, host);
        for (const line of censusLines) {
          logger.info(line);
        }

        // Issue #321: give the signal a memory. These ALERT lines fired on
        // every cycle for over a day while VibeCoder#187/#188 sat
        // unclaimable, and escalated to nothing — the cause (Issue #319) was
        // found by a human asking why, not by the alert. Count consecutive
        // *cycles* (the census runs several times per cycle) and file one
        // issue against a repo whose inversion persists. Best-effort: the
        // idle path must never fail because its own reporting did.
        //
        // Issue #437: count only the repos the claim scan actually evaluated
        // this cycle. A cycle that ended on the deadline refused nothing, so
        // it is neither evidence for the streak nor a clean cycle that clears
        // it — such a repo is left exactly as it was.
        try {
          const statePath = idleInversionStatePath(workDir);
          const cycleId = resolveRunId();
          const served = new Set(census.servedInversionRepos);
          const escalating = new Set(census.escalationRepos);
          for (const repo of census.escalationRepos) {
            const snapshot = census.perRepo.find((r) => r.repo === repo);
            const decision = await recordIdleInversion({
              statePath,
              cycleId,
              report: {
                repo,
                claimable: snapshot
                  ? snapshot.unblocked.topPriority +
                    snapshot.unblocked.workOn +
                    snapshot.unblocked.lowPriority
                  : 0,
                claimableIssues: snapshot?.claimableIssues ?? [],
                // Issue #460: the scan's own reason for refusing each issue
                // the census called claimable — the disagreement, named.
                scanSkips: lastScanBlockedDetails
                  .filter((b) =>
                    b.repo === repo &&
                    (snapshot?.claimableIssues ?? []).includes(b.issueNumber)
                  )
                  .map((b) => ({ issue: b.issueNumber, reason: b.reason })),
                detail: censusLines.filter((l) => l.includes(repo)).join("\n"),
              },
              ghFn: (args: string[]) => runGhCommand(args),
              log: (message: string) => logger.warn(message),
            });
            if (decision.action === "filed") {
              logger.warn(
                "Idle inversion escalated: filed an issue for a repo the " +
                  "claim scan keeps refusing (Issue #321)",
                {
                  repo,
                  issue: decision.issueNumber,
                  consecutiveCycles: decision.count,
                },
              );
            } else if (decision.action === "counted") {
              logger.warn(
                "Idle inversion persisting (Issue #321)",
                { repo, consecutiveCycles: decision.count },
              );
            }
          }
          // A repo that scanned cleanly this cycle has nothing to escalate.
          // An unscanned repo is left untouched (Issue #437): the cycle
          // proves neither a refusal nor a clean pass.
          for (const snapshot of census.perRepo) {
            // Issue #460: a served repo clears its streak — the next cycle
            // starts from zero rather than resuming a stale count.
            if (
              (snapshot.scannedThisCycle || served.has(snapshot.repo)) &&
              !escalating.has(snapshot.repo)
            ) {
              await clearIdleInversion(
                statePath,
                snapshot.repo,
                (m) => logger.warn(m),
              );
            }
          }
        } catch (err) {
          logger.warn("Idle-inversion escalation failed (continuing)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Issue #2813: hand the fleet-global inversion verdict back to the
        // loop so it can suppress the idle-task filer when an open,
        // unblocked top-priority/work-on/low-priority issue exists
        // anywhere in the monitored set — even one merely deferred this
        // cycle by nice/rotation/cooldown. Cache-backed: this reuses the
        // issues already read through `fetchAllIssues`/`IssueCache` above,
        // so no extra issue-list call is made.
        return { inversionDetected: census.inversionDetected };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Idle-decision census failed (continuing)", {
          error: msg,
        });
        // A census failure is treated as "no inversion detected" so the
        // filer still runs — never silently disabled by a transient hiccup.
        return;
      }
    },

    // Issue #2479: combined liveness guard. Invoked best-effort at the end
    // of every loop cycle (run-core bounds the real `gh` cost to one run per
    // LIVENESS_CHECK_CADENCE cycles). Unions the #2476 productive-work signal
    // with the #2477 idle-task-claim signal across the monitored fleet and
    // alerts once a dual-silent window exceeds the 8h threshold. The guard's
    // own signal collectors and `gh` runner default to the production
    // implementations; we thread the shared logger so the `[liveness] ALERT`
    // line and the per-tick decision line land in `~/logs/worker-*.log`
    // rather than the inherited tty (same fix shape as the idle-task filer
    // and private-repo-6 heartbeat). Best-effort: any throw is caught here and
    // logged so a guard failure never reaches the loop's catch.
    checkLivenessWindow: async ({ tick }: { tick: number }) => {
      try {
        const result = await checkLivenessWindow({
          workDir,
          repos,
          ghCommandFn: runGhCommand,
          log: (line: string) => logger.info(line),
        });
        if (result.ok) {
          const v = result.value;
          // Per-tick decision line so operators can confirm from the log
          // alone that the guard ran this cadence tick and what it saw.
          logger.info(
            `[liveness] tick=${tick} alerted=${v.alerted} ` +
              `live_epoch=${v.liveEpoch ?? "none"} ` +
              `last_idle_claimed=${v.lastIdleClaimedEpoch ?? "none"} ` +
              `last_productive=${v.lastProductiveEpoch ?? "none"}`,
          );
        } else {
          logger.warn("Liveness guard write failed (continuing)", {
            error: result.error.message,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("Liveness guard failed (continuing)", { error: msg });
      }
    },

    // Issue #2427: per-host scan cursor. The filename embeds the hostname
    // (not the PID) so the cursor survives a worker restart and two workers
    // on different hosts never trample each other. WORK_DIR holds the file.
    loadScanCursor: () => readScanCursor(scanCursorPath(workDir)),
    saveScanCursor: async (priority: number) => {
      await writeScanCursor(scanCursorPath(workDir), {
        priority,
        repoIndex: 0,
      });
    },
    resetScanCursor: async () => {
      await resetScanCursor(scanCursorPath(workDir));
    },
  };

  /** Close the log file handle (if any) to avoid resource leaks. */
  const cleanup = () => {
    if (logFileHandle) {
      try {
        logFileHandle.close();
      } catch { /* already closed */ }
    }
  };

  return { deps, config: coreConfig, cleanup };
}

/**
 * Persistent sync state for milestone branch sync (Issue #1238).
 *
 * This Map survives across loop cycles within a single worker run,
 * providing the cooldown guard. It is reset when the worker process
 * restarts (planned shutdown / PID refresh).
 */
const milestoneSyncLastTimes = new Map<string, number>();

/** Helper: sync milestone branches using lib function (Issue #1238). */
async function syncMilestoneBranchesFn(
  repos: string[],
  config: WorkerConfig,
  logger: Logger,
): Promise<void> {
  const { syncMilestoneBranches } = await import("./milestone_branch_sync.ts");
  const { milestoneSyncStreakPath } = await import(
    "./milestone_sync_streak.ts"
  );
  const { selfHealMilestoneBranches } = await import(
    "./milestone_branch_self_heal.ts"
  );
  const { syncMilestoneBranchWithDefault } = await import("./git_pull.ts");
  const { ensureMilestoneBranchExists } = await import("./git_branch.ts");
  const { ensureDefaultBranchCurrent } = await import("./git_push.ts");

  const workDir = config.workDir || Deno.env.get("HOME") || ".";

  // Issue #1519: skip repos that have not been cloned locally.
  const localCloneExistsFn = async (repo: string): Promise<boolean> => {
    const path = `${workDir}/${repo.split("/")[1]}/.git`;
    try {
      const info = await Deno.stat(path);
      return info.isDirectory || info.isFile;
    } catch {
      return false;
    }
  };

  // Issue #3912: repair before syncing — an open milestone that gained
  // children after its branch was merged and deleted has no branch to sync,
  // and its child PRs are stranded on the default branch.
  await selfHealMilestoneBranches({
    repos,
    ghCommandFn: runGhCommand,
    defaultBranchFn: getRepoDefaultBranch,
    ensureBranchFn: async (repo, milestoneBranch, defaultBranch) =>
      await ensureMilestoneBranchExists(
        milestoneBranch,
        defaultBranch,
        { cwd: `${workDir}/${repo.split("/")[1]}` },
        ensureDefaultBranchCurrent,
      ),
    localCloneExistsFn,
    log: (msg: string) => logger.info(msg),
  });

  await syncMilestoneBranches({
    repos,
    ghCommandFn: runGhCommand,
    defaultBranchFn: getRepoDefaultBranch,
    syncBranchFn: async (repo, milestoneBranch, defaultBranch) => {
      return await syncMilestoneBranchWithDefault(
        milestoneBranch,
        defaultBranch,
        { cwd: `${workDir}/${repo.split("/")[1]}` },
        // Issue #589: named so the sync can raise a PR when a repository
        // rule refuses the direct push.
        repo,
      );
    },
    localCloneExistsFn,
    log: (msg: string) => logger.info(msg),
    cooldownSeconds: config.milestoneSyncCooldownSeconds ?? 3600,
    lastSyncTimes: milestoneSyncLastTimes,
    // Issue #4260: every failed sync leaves a forensic self-heal record,
    // and a branch stuck for consecutive cycles escalates once to its
    // tracking issue (proposal 2).
    emitSelfHealEvent: (event) => emitSelfHealEventAuto(event),
    streakPath: milestoneSyncStreakPath(workDir),
  });
}

/** Helper: check and handle milestone completions using lib function. */
async function checkAndHandleMilestoneCompletionsFn(
  repos: string[],
  logger: Logger,
  serviceAccounts: string[],
  cache?: IssueCache,
): Promise<void> {
  const { checkAndHandleMilestoneCompletions } = await import(
    "./milestone_completion.ts"
  );
  const { getGithubUser } = await import("./claude_runner.ts");
  const result = await checkAndHandleMilestoneCompletions({
    repos,
    ghCommandFn: runGhCommand,
    defaultBranchFn: getRepoDefaultBranch,
    cache,
    // Issue #3528: re-check the live `gh` login against the service-account
    // allowlist before any milestone write.
    serviceAccounts,
    resolveActualLogin: async () => {
      const r = await getGithubUser();
      return r.ok ? r.value : null;
    },
    log: (msg: string) => logger.info(msg),
  });
  // Fail loud — never let an identity mismatch (ok: false) be silently
  // dropped by ignoring the returned Result (Issue #3528).
  if (!result.ok) {
    throw result.error;
  }
}

/** Helper: scan for stale workflow issues using lib function (Issue #1240). */
async function scanStaleWorkflowIssuesFn(
  repos: string[],
  config: WorkerConfig,
  logger: Logger,
  shouldShutdown: () => boolean,
  issueCache: IssueCache,
): Promise<void> {
  const {
    scanForStaleWorkflowIssues,
    STALE_WORKFLOW_DEFAULTS,
  } = await import("./stale_workflow_detector.ts");
  const { fetchIssuesByLabel } = await import("./issue_query.ts");

  const ghClient = createGitHubClient(logger);

  // Issue #1784: route through the shared `issues_all` cache so stale-
  // workflow no longer fires its own per-label `gh issue list` for every
  // repo on every iteration. The cache's projection now includes
  // `updatedAt` (see `fetchAllIssues`), which is the only field stale-
  // workflow needs beyond what was already cached.
  const listIssuesByLabel = async (
    repo: string,
    label: string,
  ): Promise<Array<import("../types.ts").GitHubIssue>> => {
    const issues = await fetchIssuesByLabel(repo, label, issueCache);
    return issues.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      labels: i.labels,
      author: i.author,
      assignees: i.assignees,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt ?? "",
    }));
  };

  await scanForStaleWorkflowIssues(
    {
      repos,
      // Issue #2031: needs-clarification reminder/close branch retired.
      labels: {
        failed: config.failedLabel ?? "failed",
        failedOnce: config.failedOnceLabel ?? "failed-once",
        planning: config.planningLabel ?? "planning",
      },
      thresholds: {
        failedDiagnosticDays: config.staleFailedDiagnosticDays ??
          STALE_WORKFLOW_DEFAULTS.failedDiagnosticDays,
        planningWarningDays: config.stalePlanningWarningDays ??
          STALE_WORKFLOW_DEFAULTS.planningWarningDays,
      },
    },
    {
      listIssuesByLabel,
      getIssueComments: (repo, issueNumber) =>
        ghClient.getIssueComments(repo, issueNumber),
      postComment: async (repo, issueNumber, body) => {
        // Adapter: drop the GitHubComment return value so the
        // StaleWorkflowDeps shape (Promise<void>) is satisfied.
        await ghClient.postComment(repo, issueNumber, body);
      },
      closeIssue: async (repo, issueNumber) => {
        await runGhCommand([
          "issue",
          "close",
          String(issueNumber),
          "--repo",
          repo,
        ]);
      },
      log: (msg: string) => logger.info(msg),
      now: () => Date.now(),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      shouldShutdown,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      getRateLimitReset: async () => {
        const raw = await runGhCommand(["api", "rate_limit"]);
        const parsed = JSON.parse(raw) as {
          resources?: {
            graphql?: { reset?: number };
            core?: { reset?: number };
          };
        };
        const reset = parsed.resources?.graphql?.reset ??
          parsed.resources?.core?.reset;
        if (typeof reset !== "number" || !Number.isFinite(reset)) {
          return Math.floor(Date.now() / 1000) + 3600;
        }
        return reset;
      },
    },
  );
}

/**
 * Run FLEET health reporting at the end of a worker run.
 *
 * This is called after the main loop exits, replacing the shell
 * implementation at lines 1118–1141 of run_core.sh.
 */
export async function runEndOfRunHealthReport(repoDir: string): Promise<void> {
  const fleetConfig = buildFleetHealthConfig(repoDir);
  const fleetDeps = createProductionFleetHealthDeps();
  await runFleetHealthReporting(fleetConfig, fleetDeps);
}

// ---------------------------------------------------------------------------
// Disk-check helpers (Issue #2000)
// ---------------------------------------------------------------------------

/**
 * Build the {@link DiskCheckOptions} for the production disk-cleanup call.
 *
 * Wires both the aggressive threshold (90%) and the gentle threshold (80%)
 * so the two-tier policy from Issue #1499 engages from the main loop.
 */
export function buildProductionDiskCheckOptions(
  workDir: string,
): DiskCheckOptions {
  return {
    workDir,
    threshold: DEFAULT_DISK_CLEANUP_THRESHOLD,
    gentleThreshold: DEFAULT_DISK_CLEANUP_GENTLE_THRESHOLD,
  };
}

/** Shape returned by {@link runProductionDiskCheck}. */
export interface ProductionDiskCheckOutcome {
  result: { ok: true; value: undefined } | { ok: false; error: Error };
  detail: DiskCheckResult;
}

/**
 * Run the two-tier disk-cleanup check for the given work directory.
 *
 * @param workDir  The root work directory to check.
 * @param runner   Injected runner (defaults to {@link checkAndCleanupDiskSpace}).
 *                 Tests pass a fake here to avoid touching the filesystem.
 */
export async function runProductionDiskCheck(
  workDir: string,
  runner: (opts: DiskCheckOptions) => Promise<DiskCheckResult> =
    checkAndCleanupDiskSpace,
): Promise<ProductionDiskCheckOutcome> {
  const opts = buildProductionDiskCheckOptions(workDir);
  const detail = await runner(opts);

  if (detail.tier === "aggressive") {
    return {
      result: {
        ok: false,
        error: new Error(detail.message),
      },
      detail,
    };
  }

  return { result: { ok: true, value: undefined }, detail };
}
