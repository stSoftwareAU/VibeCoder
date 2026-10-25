/**
 * The scan loop's hard-kill reporting hook (Issue #4254).
 *
 * The launcher watchdog leaves evidence of a hard-killed container; the
 * worker reports it once, at the start of the first scan cycle. These tests
 * drive the real `runCoreLoop` and assert that the kill is counted in the
 * first cycle's `fleetSummary.failures` (and not again), and that a fault in
 * the hook never stops the loop.
 *
 * A minimal RunCoreDeps mock is rebuilt locally, matching the convention in
 * the other run_core test files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { recordOutcome } from "../lib/fleet_telemetry.ts";
import type { TerminalScanCycle } from "../lib/run_callbacks.ts";

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
    now: () => 0,
    ...overrides,
  };
}

/**
 * A clock that advances on every sleep, so each idle cycle takes time. The
 * run is ended on demand by `endRun`, which moves the clock past the run's
 * deadline, so the loop stops after exactly the cycles a test wants.
 */
function cycleClock(runDurationSeconds: number) {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    endRun: () => {
      now += runDurationSeconds * 1000;
    },
  };
}

Deno.test("run_core hard kills - the first cycle callback counts the kill in its failures (Issue #4254)", async () => {
  const config = createDefaultRunCoreConfig();
  const time = cycleClock(config.runDurationSeconds);
  const cycles: TerminalScanCycle[] = [];
  let hardKillCalls = 0;
  const deps = createMockDeps({
    ...time,
    reportHardKills: () => {
      hardKillCalls++;
      recordOutcome("failure", "hard_kill");
      return Promise.resolve();
    },
    runCycleCallback: (cycle) => {
      cycles.push(cycle);
      if (cycles.length === 2) time.endRun();
      return Promise.resolve();
    },
  });

  await runCoreLoop(config, deps);

  assert(cycles.length >= 2, `expected two cycles, got ${cycles.length}`);
  assertEquals(cycles[0]!.fleetSummary.failures, 1);
  assertEquals(cycles[1]!.fleetSummary.failures, 0);
  assertEquals(hardKillCalls, 1, "the hook must run once per process");
});

Deno.test("run_core hard kills - a throwing hook is logged and the loop still fires its cycle callback (Issue #4254)", async () => {
  const config = createDefaultRunCoreConfig();
  const time = cycleClock(config.runDurationSeconds);
  const errors: string[] = [];
  const cycles: TerminalScanCycle[] = [];
  const deps = createMockDeps({
    ...time,
    logError: (message) => errors.push(message),
    reportHardKills: () => Promise.reject(new Error("boom")),
    runCycleCallback: (cycle) => {
      cycles.push(cycle);
      time.endRun();
      return Promise.resolve();
    },
  });

  await runCoreLoop(config, deps);

  assert(cycles.length >= 1, `expected a cycle callback, got ${cycles.length}`);
  assertEquals(cycles[0]!.fleetSummary.failures, 0);
  assert(
    errors.some((line) =>
      line === "Hard-kill reporting faulted: boom. The scan cycle continues."
    ),
    errors.join("\n"),
  );
});

Deno.test("run_core hard kills - an absent hook leaves the loop unaffected (Issue #4254)", async () => {
  const config = createDefaultRunCoreConfig();
  const time = cycleClock(config.runDurationSeconds);
  const errors: string[] = [];
  const cycles: TerminalScanCycle[] = [];
  const deps = createMockDeps({
    ...time,
    logError: (message) => errors.push(message),
    runCycleCallback: (cycle) => {
      cycles.push(cycle);
      time.endRun();
      return Promise.resolve();
    },
  });

  await runCoreLoop(config, deps);

  assert(cycles.length >= 1, `expected a cycle callback, got ${cycles.length}`);
  assertEquals(cycles[0]!.fleetSummary.failures, 0);
  assert(
    !errors.some((line) => line.includes("Hard-kill")),
    errors.join("\n"),
  );
});
