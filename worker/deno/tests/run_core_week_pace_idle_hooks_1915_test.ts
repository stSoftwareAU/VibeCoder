/**
 * The idle hooks defer idle-task filing while the week-pace guard is engaged
 * (Issue #1915).
 *
 * On GRQ-25 the pace guard (Issue #1885) refused every `low-priority` and
 * `idle-task` pickup, so the scan claimed nothing although 87 issues were
 * eligible. The idle-decision audit read those 87 as claimable, every cycle
 * counted as a scan/probe disagreement, and once the 1200 s bound was
 * exceeded the idle-task filer walked every monitored repository — ~800
 * GraphQL points out of the fleet's shared 5,000 — to file work that the
 * guard forbids picking up for the rest of the week.
 *
 * These tests drive `runCoreLoop` over a work directory that outlives the
 * run, so both halves are observable: the filer is never invoked while the
 * guard is engaged, and the persisted disagreement streak does not advance.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import {
  IDLE_CYCLE_OBSERVER_ID,
  IDLE_DISAGREEMENT_STATE_FILE,
  type IdleDisagreementState,
  loadIdleDisagreementState,
} from "../lib/idle_disagreement_streak.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal RunCoreDeps factory, kept local so a change to another test's
 * helper cannot silently alter the contract under test here.
 */
function createMockDeps(overrides?: Partial<RunCoreDeps>): RunCoreDeps {
  return {
    log: () => {},
    logError: () => {},
    logTiming: () => {},
    logWorkerSummary: () => {},

    checkPidFile: () => Promise.resolve({ canProceed: true, message: "OK" }),
    claimPidFile: () => Promise.resolve(),
    releasePidFile: () => Promise.resolve(),

    gitResetToOrigin: () => Promise.resolve({ ok: true, value: undefined }),
    setupLogging: () => Promise.resolve(),
    loadAndValidateConfig: () =>
      Promise.resolve({ ok: true, value: createDefaultRunCoreConfig() }),
    checkDependencies: () => Promise.resolve({ ok: true, value: undefined }),
    checkSoftwareUpdates: () => Promise.resolve(),
    checkDiskSpace: () => Promise.resolve({ ok: true, value: undefined }),
    rotateLogFiles: () => Promise.resolve(),
    cleanupStaleTempFiles: () => Promise.resolve(),
    recoverStuckIssues: () => Promise.resolve(),
    cleanupStaleBranches: () => Promise.resolve(),
    checkFeatureAvailability: () => Promise.resolve(),

    checkClaudeHealth: () =>
      Promise.resolve({ ok: true, value: { healthy: true } }),
    checkGhAuth: () => Promise.resolve({ ok: true, value: { valid: true } }),

    findAndProcessPrFeedback: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessSpellingFailure: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessCiFailure: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    updateOpenPrBranches: () => Promise.resolve({ ok: true, value: undefined }),
    nudgeStalledCi: () => Promise.resolve({ ok: true, value: undefined }),
    ensureAutoMerge: () => Promise.resolve({ ok: true, value: undefined }),
    cleanupMergedBranches: () =>
      Promise.resolve({ ok: true, value: undefined }),
    closeIssuesForMergedPrs: () =>
      Promise.resolve({ ok: true, value: undefined }),
    recoverAssignedWithClosedPr: () =>
      Promise.resolve({ ok: true, value: undefined }),
    syncMilestoneBranches: () =>
      Promise.resolve({ ok: true, value: undefined }),
    checkMilestoneCompletions: () =>
      Promise.resolve({ ok: true, value: undefined }),
    findAndProcessRefinement: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessGrillMe: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessQuestion: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessPlanning: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),

    scanStaleWorkflowIssues: () =>
      Promise.resolve({ ok: true, value: undefined }),

    findNextIssue: () => Promise.resolve({ ok: true, value: null }),
    processIssue: () => Promise.resolve({ ok: true, value: { success: true } }),

    trackFailure: () => Promise.resolve(),
    resetFailures: () => Promise.resolve(),
    shouldExitOnFailures: () => Promise.resolve(false),
    recordIssueCooldown: () => Promise.resolve(),

    circuitBreakerReset: () => Promise.resolve(),
    circuitBreakerRecordZeroProgress: () => Promise.resolve(),
    circuitBreakerGetSleepInterval: () => Promise.resolve(30),
    isRateLimitActive: () => Promise.resolve(false),
    getRateLimitRemainingSeconds: () => Promise.resolve(0),
    getRateLimitReset: () =>
      Promise.resolve(Math.floor(Date.now() / 1000) + 3600),
    preflightGitHubRateLimit: () =>
      Promise.resolve({
        rateLimited: false,
        remainingSeconds: 0,
        message: "ok",
      }),

    resetRepoFailures: () => Promise.resolve(),
    recordRepoFailure: () => Promise.resolve(),
    recordRepoSuccess: () => Promise.resolve(),

    sendCrashNotification: () => Promise.resolve(),
    clearHeartbeat: () => Promise.resolve(),
    cleanupInProgressIssue: () => Promise.resolve(),

    setStatusIdle: () => Promise.resolve(),
    setStatusWorking: () => Promise.resolve(),
    setStatusSuccess: () => Promise.resolve(),
    setStatusFailure: () => Promise.resolve(),
    resetWindowTitle: () => {},

    addSignalListener: () => {},
    removeSignalListener: () => {},

    writeFaultToleranceSummary: () => Promise.resolve(),

    touchPidFile: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
    now: () => Date.now(),

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Simulated idle run
// ---------------------------------------------------------------------------

/** The liveness-guard cadence: how far apart idle observations arrive. */
const OBSERVATION_GAP_MS = 9 * 60 * 1000;

/** One simulated worker run over a work directory that outlives it. */
interface IdleRunOptions {
  /** Run duration in seconds; the run stops once the clock passes it. */
  runSeconds: number;
  /** Idle observations to allow before the run's deadline lands. */
  observations: number;
  /** Whether the week-pace guard is engaged for this run. */
  weekPaceEngaged: boolean;
  /** Claimable total the idle-detect audit reports on each observation. */
  auditClaimableTotal: number;
  logs: string[];
  onFile: () => void;
}

/**
 * Deps for one simulated run. The clock moves only inside the idle-detect
 * audit — one call per idle observation — so elapsed disagreement is exactly
 * `observations x gap` and nothing else can drift it.
 */
function idleRunDeps(opts: IdleRunOptions): RunCoreDeps {
  const endMs = opts.runSeconds * 1000;
  let nowValue = 0;
  let seen = 0;
  return createMockDeps({
    now: () => nowValue,
    sleep: () => {
      if (seen >= opts.observations) nowValue = Math.max(nowValue, endMs + 1);
      return Promise.resolve();
    },
    log: (m: string) => opts.logs.push(m),
    findNextIssue: () => Promise.resolve({ ok: true as const, value: null }),
    weekPaceEngaged: () => opts.weekPaceEngaged,
    runIdleDetectAudit: () => {
      seen++;
      nowValue += OBSERVATION_GAP_MS;
      return Promise.resolve({ claimableTotal: opts.auditClaimableTotal });
    },
    runIdleDecisionCensus: () => Promise.resolve({ inversionDetected: false }),
    runIdleTaskFiler: () => {
      opts.onFile();
      return Promise.resolve();
    },
  });
}

/** A serial config pinned to `workDir`, so the streak has somewhere to live. */
function idleRunConfig(workDir: string, runSeconds: number) {
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = runSeconds;
  config.maxConcurrentIssues = 1;
  config.workDir = workDir;
  return config;
}

/** The persisted streak, as the next worker process would read it. */
function readStreakState(workDir: string): Promise<IdleDisagreementState> {
  return loadIdleDisagreementState(
    `${workDir}/${IDLE_DISAGREEMENT_STATE_FILE}`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - the pace guard defers idle-task filing and never advances the disagreement streak (Issue #1915)",
  async () => {
    // GRQ-25 exactly: the audit still reports a positive claimable total
    // (whatever it counts, work the guard refuses is not work the filer can
    // supply), five observations spanning 45 minutes — more than twice the
    // 20-minute bound. The filer must not run once.
    const workDir = await Deno.makeTempDir({ prefix: "idle_week_pace_" });
    try {
      const logs: string[] = [];
      let filerRuns = 0;
      await runCoreLoop(
        idleRunConfig(workDir, 3600),
        idleRunDeps({
          runSeconds: 3600,
          observations: 5,
          weekPaceEngaged: true,
          auditClaimableTotal: 87,
          logs,
          onFile: () => filerRuns++,
        }),
      );

      assertEquals(
        filerRuns,
        0,
        "the pace guard forbids idle-task pickup all week, so nothing the " +
          "filer files can be claimed — it must not run",
      );
      const deferred = logs.filter((m) =>
        m.includes("[idle-hooks]") &&
        m.includes("skipping=idle-task-filer") &&
        m.includes("reason=week_pace_engaged")
      );
      assert(
        deferred.length > 0,
        `expected a week_pace_engaged deferral line; got ${
          JSON.stringify(logs.slice(-8))
        }`,
      );
      assertEquals(
        (await readStreakState(workDir))[IDLE_CYCLE_OBSERVER_ID],
        undefined,
        "a cycle whose eligible work is entirely pace-suppressed is " +
          "agreement, not a disagreement to accumulate",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - with the pace guard off the filer runs as before (Issue #1915)",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "idle_week_pace_off_" });
    try {
      const logs: string[] = [];
      let filerRuns = 0;
      await runCoreLoop(
        idleRunConfig(workDir, 3600),
        idleRunDeps({
          runSeconds: 3600,
          observations: 2,
          weekPaceEngaged: false,
          auditClaimableTotal: 0,
          logs,
          onFile: () => filerRuns++,
        }),
      );

      assert(
        filerRuns > 0,
        `expected the filer to run with the guard off; got ${filerRuns}`,
      );
      assert(
        logs.some((m) =>
          m.includes("[idle-hooks]") && m.includes("invoking=idle-task-filer")
        ),
        `expected an invoking line; got ${JSON.stringify(logs.slice(-8))}`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - with the pace guard off a durable audit disagreement still forces a filer attempt (Issue #1915)",
  async () => {
    // The Issue #2475 / #3526 bound is untouched by the pace gate: five
    // observations of a real disagreement, 45 minutes, must still force
    // exactly one attempt through.
    const workDir = await Deno.makeTempDir({ prefix: "idle_week_pace_bound_" });
    try {
      const logs: string[] = [];
      let filerRuns = 0;
      await runCoreLoop(
        idleRunConfig(workDir, 3600),
        idleRunDeps({
          runSeconds: 3600,
          observations: 5,
          weekPaceEngaged: false,
          auditClaimableTotal: 87,
          logs,
          onFile: () => filerRuns++,
        }),
      );

      assert(
        filerRuns > 0,
        `expected the disagreement bound to force an attempt; got ${filerRuns}`,
      );
      assert(
        logs.some((m) =>
          m.includes("reason=audit_disagreement_bound_exceeded")
        ),
        `expected the bound-exceeded line; got ${
          JSON.stringify(logs.slice(-8))
        }`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
