/**
 * The idle hooks defer idle-task filing while the GraphQL quota is below the
 * polling gate's idle floor (Issue #3628).
 *
 * The scan already deferred idle-task collection under the same reading, so
 * nothing the filer could raise would be claimable before the window resets —
 * and the filer's decision walk costs ~800 of the fleet's shared GraphQL
 * points a cycle (the Issue #1915 measurement). These tests drive
 * `runCoreLoop` exactly as `run_core_week_pace_idle_hooks_1915_test.ts`
 * does: the filer is never invoked while the verdict defers, the persisted
 * disagreement streak does not advance, and a null verdict changes nothing.
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
  loadIdleDisagreementState,
} from "../lib/idle_disagreement_streak.ts";

// ---------------------------------------------------------------------------
// Test helpers — the same minimal-deps factory as the week-pace sibling test.
// ---------------------------------------------------------------------------

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

    findNextIssue: () => Promise.resolve({ ok: true as const, value: null }),
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

/** The liveness-guard cadence: how far apart idle observations arrive. */
const OBSERVATION_GAP_MS = 9 * 60 * 1000;

/** One simulated worker run over a work directory that outlives it. */
function idleRunDeps(opts: {
  runSeconds: number;
  observations: number;
  logs: string[];
  quotaReason: string | null;
  onFile: () => void;
  onQuotaAsk: () => void;
  weekPaceEngaged?: boolean;
}): RunCoreDeps {
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
    weekPaceEngaged: () => opts.weekPaceEngaged === true,
    idleFilerQuotaDeferred: () => {
      opts.onQuotaAsk();
      return Promise.resolve(opts.quotaReason);
    },
    runIdleDetectAudit: () => {
      seen++;
      nowValue += OBSERVATION_GAP_MS;
      return Promise.resolve({ claimableTotal: 0 });
    },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - a quota deferral verdict skips the idle filer and clears the disagreement streak (Issue #3628)",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "idle_quota_gate_" });
    try {
      const logs: string[] = [];
      let filerRuns = 0;
      let quotaAsks = 0;
      await runCoreLoop(
        idleRunConfig(workDir, 3600),
        idleRunDeps({
          runSeconds: 3600,
          observations: 5,
          logs,
          quotaReason: "remaining=312/5000 below idle_floor=500",
          onFile: () => filerRuns++,
          onQuotaAsk: () => quotaAsks++,
        }),
      );

      assertEquals(
        filerRuns,
        0,
        "below the idle floor the scan already deferred idle collection, so " +
          "the filer must not run",
      );
      assert(
        quotaAsks > 0,
        "the quota verdict must be asked for at each idle observation",
      );
      const deferred = logs.filter((m) =>
        m.includes("[idle-hooks]") &&
        m.includes("skipping=idle-task-filer") &&
        m.includes("reason=graphql_quota_below_idle_floor")
      );
      assertEquals(
        deferred.length,
        quotaAsks,
        "one deferral line per observation, naming the reason",
      );
      assert(
        deferred[0]!.includes("remaining=312/5000 below idle_floor=500"),
        `the deferral line must carry the reading: ${deferred[0]}`,
      );
      assertEquals(
        (await loadIdleDisagreementState(
          `${workDir}/${IDLE_DISAGREEMENT_STATE_FILE}`,
        ))[IDLE_CYCLE_OBSERVER_ID],
        undefined,
        "a deliberate deferral is agreement, not a disagreement to accumulate",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - a null quota verdict runs the filer as before (Issue #3628)",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "idle_quota_null_" });
    try {
      const logs: string[] = [];
      let filerRuns = 0;
      await runCoreLoop(
        idleRunConfig(workDir, 3600),
        idleRunDeps({
          runSeconds: 3600,
          observations: 2,
          logs,
          quotaReason: null,
          onFile: () => filerRuns++,
          onQuotaAsk: () => {},
        }),
      );

      assert(
        filerRuns > 0,
        `expected the filer to run with a null verdict; got ${filerRuns}`,
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
  "run_core - the week-pace guard short-circuits before the quota verdict is asked (Issue #3628)",
  async () => {
    const workDir = await Deno.makeTempDir({ prefix: "idle_quota_pace_" });
    try {
      const logs: string[] = [];
      let quotaAsks = 0;
      await runCoreLoop(
        idleRunConfig(workDir, 3600),
        idleRunDeps({
          runSeconds: 3600,
          observations: 1,
          weekPaceEngaged: true,
          logs,
          quotaReason: "remaining=312/5000 below idle_floor=500",
          onFile: () => {},
          onQuotaAsk: () => quotaAsks++,
        }),
      );

      assertEquals(
        quotaAsks,
        0,
        "the free week-pace check runs first, so the quota probe is only " +
          "paid when pace is not engaged",
      );
      assert(
        logs.some((m) => m.includes("reason=week_pace_engaged")),
        `expected the pace deferral line; got ${
          JSON.stringify(logs.slice(-8))
        }`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);
