/**
 * The scan loop ends on a root-filesystem fault (Issue #3179).
 *
 * Drives the real `runCoreLoop` through injected deps: a faulted filesystem
 * ends the run within one cycle, before the provider health check, with the
 * named ERROR line, a `host_fault` cycle callback and the fault on the
 * result; a healthy filesystem with a failing health check behaves exactly as
 * before.
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

/** A clock that advances on every sleep so the run reaches its end. */
function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
  };
}

Deno.test("runCoreLoop - a read-only root ends the run within one cycle, before the health check (Issue #3179)", async () => {
  const errors: string[] = [];
  const endReasons: string[] = [];
  let probes = 0;
  let healthChecks = 0;
  const deps = createMockDeps({
    ...clock(),
    logError: (message) => errors.push(message),
    checkRootFilesystem: () => {
      probes++;
      return Promise.resolve({
        path: "/tmp",
        detail: "Read-only file system (os error 30)",
      });
    },
    checkClaudeHealth: () => {
      healthChecks++;
      return Promise.resolve({ ok: true, value: { healthy: false } });
    },
    runCycleCallback: (cycle) => {
      endReasons.push(cycle.endReason);
      return Promise.resolve();
    },
  });

  const result = await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assertEquals(probes, 1, "the run must end on the first faulted cycle");
  assertEquals(healthChecks, 0, "a dead filesystem is not a provider failure");
  assertEquals(result.rootFilesystemFault, {
    path: "/tmp",
    detail: "Read-only file system (os error 30)",
  });
  assertEquals(result.lastHealthCheckPassed, false);
  assertEquals(endReasons, ["host_fault"]);
  const named = errors.filter((line) => line.startsWith("[ROOT_FS_READ_ONLY]"));
  assertEquals(named.length, 1, errors.join("\n"));
  assert(
    !errors.some((line) => line.includes("health check failed")),
    errors.join("\n"),
  );
});

Deno.test("runCoreLoop - a health-check failure on a healthy filesystem behaves as before (Issue #3179)", async () => {
  const errors: string[] = [];
  let probes = 0;
  const deps = createMockDeps({
    ...clock(),
    logError: (message) => errors.push(message),
    checkRootFilesystem: () => {
      probes++;
      return Promise.resolve(null);
    },
    checkClaudeHealth: () =>
      Promise.resolve({ ok: true, value: { healthy: false } }),
  });

  const result = await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assert(probes > 1, `the run must keep cycling, probed ${probes} time(s)`);
  assertEquals(result.rootFilesystemFault, undefined);
  assert(
    errors.includes("Claude health check failed — skipping cycle"),
    errors.join("\n"),
  );
  assert(!errors.some((line) => line.includes("ROOT_FS_READ_ONLY")));
});
