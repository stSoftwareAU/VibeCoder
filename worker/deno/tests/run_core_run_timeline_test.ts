/**
 * Tests for the run timeline that runCoreLoop resolves at start (Issue #4242).
 *
 * Proves that:
 *   (a) the loop logs `Run timeline: target=<start+1h> finish=<start+2h>
 *       hard-kill=<ISO>` once at start, with the hard kill read from
 *       VIBE_HARD_KILL_AT_EPOCH,
 *   (b) with no hard-kill variable and no supervisor cap, the line says
 *       `hard-kill=none (` and names the reason,
 *   (c) a malformed VIBE_HARD_KILL_AT_EPOCH is warned to the warn sink, quoting
 *       the value,
 *   (d) the resolved timeline is published via getRunTimeline() after the loop,
 *   (e) createDefaultRunCoreConfig() carries the 1 h target and 2 h finish.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import {
  DEFAULT_RUN_FINISH_SECONDS,
  DEFAULT_RUN_TARGET_SECONDS,
  getRunTimeline,
  HARD_KILL_AT_EPOCH_ENV,
  resetRunTimelineForTests,
} from "../lib/run_timeline.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal RunCoreDeps factory for these tests. Mirrors the helper in
 * `run_core_idle_task_filer_test.ts`, kept locally so a change to another
 * suite's helper cannot silently alter the contract under test here.
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

/** Start of the simulated run: 2026-10-24T09:00:00Z, in epoch-ms. */
const START_MS = Date.UTC(2026, 9, 24, 9, 0, 0);

/** The target instant: start plus one hour. */
const TARGET_ISO = new Date(START_MS + 3600 * 1000).toISOString();

/** The finish instant: start plus two hours. */
const FINISH_ISO = new Date(START_MS + 7200 * 1000).toISOString();

/**
 * The watchdog's kill, in epoch-seconds: 11:30Z. Clear of the finish plus the
 * kill grace and WIP reserve, so the finish is not clamped.
 */
const HARD_KILL_EPOCH_S = Date.UTC(2026, 9, 24, 11, 30, 0) / 1000;
const HARD_KILL_ISO = new Date(HARD_KILL_EPOCH_S * 1000).toISOString();

/**
 * Run the loop once from START_MS with the given environment and capture its
 * log, warning and error sinks. The clock jumps past the finish at the first
 * sleep, so the loop stops after one pass.
 */
async function runLoopCapturing(
  env: (name: string) => string | undefined,
): Promise<{ logs: string[]; warns: string[]; errors: string[] }> {
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  let nowValue = START_MS;
  const deps = createMockDeps({
    now: () => nowValue,
    sleep: () => {
      nowValue = START_MS + (DEFAULT_RUN_FINISH_SECONDS + 1) * 1000;
      return Promise.resolve();
    },
    env,
    log: (m: string) => logs.push(m),
    logWarn: (m: string) => warns.push(m),
    logError: (m: string) => errors.push(m),
  });
  await runCoreLoop(createDefaultRunCoreConfig(), deps);
  return { logs, warns, errors };
}

/** The `Run timeline:` lines the loop logged, in order. */
function timelineLines(logs: string[]): string[] {
  return logs.filter((line) => line.startsWith("Run timeline: "));
}

/** An environment that publishes the watchdog's kill and nothing else. */
function envWithHardKill(name: string): string | undefined {
  return name === HARD_KILL_AT_EPOCH_ENV
    ? String(HARD_KILL_EPOCH_S)
    : undefined;
}

/** An environment with nothing set. */
function envEmpty(_name: string): string | undefined {
  return undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - run timeline logs target, finish and the watchdog hard kill (Issue #4242)",
  async () => {
    try {
      const { logs } = await runLoopCapturing(envWithHardKill);
      assertEquals(timelineLines(logs), [
        `Run timeline: target=${TARGET_ISO} finish=${FINISH_ISO} ` +
        `hard-kill=${HARD_KILL_ISO}`,
      ]);
    } finally {
      resetRunTimelineForTests();
    }
  },
);

Deno.test(
  "run_core - run timeline with no hard kill says none and names the reason (Issue #4242)",
  async () => {
    try {
      const { logs } = await runLoopCapturing(envEmpty);
      const lines = timelineLines(logs);
      assertEquals(lines.length, 1);
      const line = lines[0] ?? "";
      assertStringIncludes(
        line,
        `Run timeline: target=${TARGET_ISO} finish=${FINISH_ISO} ` +
          `hard-kill=none (`,
      );
      assertStringIncludes(line, "VIBE_HARD_KILL_AT_EPOCH is not set");
    } finally {
      resetRunTimelineForTests();
    }
  },
);

Deno.test(
  "run_core - a malformed VIBE_HARD_KILL_AT_EPOCH is warned with its value quoted (Issue #4242)",
  async () => {
    try {
      const { warns, errors } = await runLoopCapturing((name) =>
        name === HARD_KILL_AT_EPOCH_ENV ? "soon" : undefined
      );
      assertEquals(
        warns.some((line) => line.includes(`${HARD_KILL_AT_EPOCH_ENV}="soon"`)),
        true,
      );
      assertEquals(
        errors.some((line) => line.includes("soon")),
        false,
      );
    } finally {
      resetRunTimelineForTests();
    }
  },
);

Deno.test(
  "run_core - the resolved run timeline is published after the loop starts (Issue #4242)",
  async () => {
    try {
      await runLoopCapturing(envWithHardKill);
      const timeline = getRunTimeline();
      assertEquals(
        timeline?.targetMs,
        START_MS + DEFAULT_RUN_TARGET_SECONDS * 1000,
      );
      assertEquals(
        timeline?.finishMs,
        START_MS + DEFAULT_RUN_FINISH_SECONDS * 1000,
      );
      assertEquals(timeline?.hardKillMs, HARD_KILL_EPOCH_S * 1000);
    } finally {
      resetRunTimelineForTests();
    }
  },
);

Deno.test(
  "run_core - default config carries the 1 h target, 2 h finish and kill grace (Issue #4242)",
  () => {
    const config = createDefaultRunCoreConfig();
    assertEquals(config.runDurationSeconds, 3600);
    assertEquals(config.runFinishSeconds, 7200);
    assertEquals(
      config.claudeKillAfterSeconds,
      OPERATIONAL_DEFAULTS.claudeKillAfter,
    );
  },
);
