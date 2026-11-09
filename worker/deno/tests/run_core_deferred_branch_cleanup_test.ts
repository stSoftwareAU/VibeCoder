/**
 * Deferred startup branch cleanup (Issue #4822).
 *
 * The stale and merged branch cleanups used to run to completion before the
 * main loop, so a slow `cleanupMergedBranches` (2 minutes on GRQ-23, deleting
 * nothing) delayed the first claim. They now start as one background sweep
 * alongside the main loop, and the run gives any still going a bounded grace
 * once the loop has ended.
 *
 * Covered here:
 *   1. The main loop reaches its first issue scan while the merged cleanup is
 *      still blocked, and the run's result arrives only after that cleanup
 *      has finished.
 *   2. Both cleanups still run, stale before merged.
 *   3. A rejecting stale cleanup is logged, does not change the run's result,
 *      and does not stop the merged cleanup.
 *   4. A cleanup that never finishes does not hang the run: once the grace
 *      expires the abandoned sweep is logged and the run returns.
 *   5. A failed Result from the merged cleanup is logged, not dropped.
 *
 * No wall-clock sleeps: the grace timer is injected, and the event loop is
 * drained with zero-delay macrotask turns. No fixed /tmp paths.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
  type RunCoreResult,
} from "../lib/run_core.ts";
import type { SweepTimer } from "../lib/deferred_startup_sweep.ts";
import type { Result } from "../types.ts";

/** Grace timer that never expires: the sweep is always waited for. */
const neverExpiresTimer: SweepTimer = {
  start: () => ({
    expired: new Promise<void>(() => {}),
    cancel: () => {},
  }),
};

/** Grace timer that has already expired: the sweep is abandoned at once. */
const alreadyExpiredTimer: SweepTimer = {
  start: () => ({
    expired: Promise.resolve(),
    cancel: () => {},
  }),
};

/**
 * Drain pending work with one zero-delay macrotask turn. Every fake here
 * resolves through microtasks, so one turn lets the chain run as far as it
 * can without any wall-clock delay.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Minimal happy-path deps; overrides tailor each scenario. */
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
 * Deps whose first issue scan requests a planned shutdown, so the run goes
 * through initialisation, one pass of the main loop, and then the exit path.
 * `onScan` runs at the scan, before the shutdown is requested.
 */
function depsThatShutDownAtFirstScan(
  overrides: Partial<RunCoreDeps>,
  onScan: () => void = () => {},
): RunCoreDeps {
  let requestShutdown: () => void = () => {};
  return createMockDeps({
    addSignalListener: (_signal: string, handler: () => void) => {
      requestShutdown = handler;
    },
    findNextIssue: () => {
      onScan();
      requestShutdown();
      return Promise.resolve({ ok: true, value: null });
    },
    deferredSweepTimer: neverExpiresTimer,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. The loop starts while the merged cleanup is blocked; the result waits.
// ---------------------------------------------------------------------------

Deno.test(
  "run core deferred branch cleanup - loop scans while merged cleanup is blocked, and the result waits for it",
  async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let mergedStarted = false;
    let mergedFinished = false;
    let scanned = false;

    const deps = depsThatShutDownAtFirstScan(
      {
        cleanupMergedBranches: async () => {
          mergedStarted = true;
          await gate;
          mergedFinished = true;
          return { ok: true, value: undefined };
        },
      },
      () => {
        scanned = true;
      },
    );

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    // Record, at the moment the run resolves, whether the merged cleanup had
    // finished. Read in the same continuation, not after a later await.
    const runDone = runCoreLoop(config, deps).then((result) => ({
      result,
      mergedFinishedAtResolve: mergedFinished,
    }));

    try {
      for (let turn = 0; turn < 20 && !scanned; turn++) {
        await yieldToEventLoop();
      }
      assert(
        scanned,
        "main loop must reach its first issue scan while the merged cleanup is still blocked",
      );
      assert(
        mergedStarted,
        "the merged cleanup must have started in the background",
      );
      assertEquals(
        mergedFinished,
        false,
        "the merged cleanup must still be blocked when the loop scans",
      );
    } finally {
      releaseGate();
    }

    const { result, mergedFinishedAtResolve } = await runDone;
    assertEquals(
      mergedFinishedAtResolve,
      true,
      "the run's result must not resolve before the merged cleanup finishes",
    );
    assertEquals(result.exitReason, "Shutdown signal received");
  },
);

// ---------------------------------------------------------------------------
// 2. Both cleanups still run, stale before merged.
// ---------------------------------------------------------------------------

Deno.test(
  "run core deferred branch cleanup - both cleanups still run, stale before merged",
  async () => {
    const calls: string[] = [];
    const deps = depsThatShutDownAtFirstScan({
      cleanupStaleBranches: () => {
        calls.push("stale");
        return Promise.resolve();
      },
      cleanupMergedBranches: () => {
        calls.push("merged");
        return Promise.resolve({ ok: true, value: undefined });
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;
    await runCoreLoop(config, deps);

    assertEquals(calls, ["stale", "merged"]);
  },
);

// ---------------------------------------------------------------------------
// 3. A rejecting stale cleanup is logged; the result and merged cleanup hold.
// ---------------------------------------------------------------------------

Deno.test(
  "run core deferred branch cleanup - a rejecting stale cleanup is logged and does not stop the merged cleanup or change the result",
  async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const deps = depsThatShutDownAtFirstScan({
      logError: (message: string) => errors.push(message),
      cleanupStaleBranches: () => {
        calls.push("stale");
        return Promise.reject(new Error("stale boom"));
      },
      cleanupMergedBranches: () => {
        calls.push("merged");
        return Promise.resolve({ ok: true, value: undefined });
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;
    const result: RunCoreResult = await runCoreLoop(config, deps);

    assertEquals(calls, ["stale", "merged"]);
    assertEquals(result.exitReason, "Shutdown signal received");
    assertEquals(result.exitedOnFailures, false);
    assert(
      errors.some((e) =>
        e.includes("Stale branch cleanup failed") && e.includes("stale boom")
      ),
      `expected the stale failure to be logged, got: ${errors.join(" | ")}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 4. A cleanup that never finishes is abandoned after the grace, not waited on.
// ---------------------------------------------------------------------------

Deno.test(
  "run core deferred branch cleanup - a cleanup that never finishes does not hang the run and is logged as abandoned",
  async () => {
    const errors: string[] = [];
    const deps = depsThatShutDownAtFirstScan({
      logError: (message: string) => errors.push(message),
      deferredSweepTimer: alreadyExpiredTimer,
      cleanupMergedBranches: () => new Promise<Result<void>>(() => {}),
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    // Bounded by zero-delay turns, so a run that hangs fails the test rather
    // than blocking the runner.
    let settled = false;
    const runDone = runCoreLoop(config, deps).then((value) => {
      settled = true;
      return value;
    });
    for (let turn = 0; turn < 20 && !settled; turn++) {
      await yieldToEventLoop();
    }
    assert(settled, "the run must not hang on a cleanup that never finishes");
    const result = await runDone;

    assertEquals(result.exitReason, "Shutdown signal received");
    assert(
      errors.some((e) =>
        e.includes("still running after") &&
        e.includes("startup-branch-cleanup")
      ),
      `expected the abandoned sweep to be logged, got: ${errors.join(" | ")}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 5. A failed Result from the merged cleanup is logged, not dropped.
// ---------------------------------------------------------------------------

Deno.test(
  "run core deferred branch cleanup - a failed merged cleanup Result is logged and does not change the result",
  async () => {
    const errors: string[] = [];
    const deps = depsThatShutDownAtFirstScan({
      logError: (message: string) => errors.push(message),
      cleanupMergedBranches: () =>
        Promise.resolve({
          ok: false,
          error: new Error("merged gh unavailable"),
        }),
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;
    const result = await runCoreLoop(config, deps);

    assertEquals(result.exitReason, "Shutdown signal received");
    assert(
      errors.some((e) =>
        e.includes("Merged branch cleanup failed") &&
        e.includes("merged gh unavailable")
      ),
      `expected the merged failure to be logged, got: ${errors.join(" | ")}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 6. The logged text is exact for an Error and for a non-Error rejection.
// ---------------------------------------------------------------------------

Deno.test(
  "run core deferred branch cleanup - thrown Errors log their message and thrown non-Errors log their string form",
  async () => {
    const cases: {
      stale: unknown;
      merged: unknown;
      expected: string[];
    }[] = [
      {
        stale: new Error("stale boom"),
        merged: new Error("merged boom"),
        expected: [
          "Stale branch cleanup failed (continuing): stale boom",
          "Merged branch cleanup failed (continuing): merged boom",
        ],
      },
      {
        stale: "stale plain",
        merged: "merged plain",
        expected: [
          "Stale branch cleanup failed (continuing): stale plain",
          "Merged branch cleanup failed (continuing): merged plain",
        ],
      },
    ];

    for (const { stale, merged, expected } of cases) {
      const errors: string[] = [];
      const deps = depsThatShutDownAtFirstScan({
        logError: (message: string) => errors.push(message),
        cleanupStaleBranches: () => Promise.reject(stale),
        cleanupMergedBranches: () => Promise.reject(merged),
      });

      const config = createDefaultRunCoreConfig();
      config.runDurationSeconds = 3600;
      await runCoreLoop(config, deps);

      assertEquals(
        errors.filter((e) => e.includes("branch cleanup failed")),
        expected,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// 7. The sweep's own sink reports through the run's logError.
// ---------------------------------------------------------------------------

Deno.test(
  "run core deferred branch cleanup - a failure inside the failure log is reported through the sweep sink",
  async () => {
    const errors: string[] = [];
    let first = true;
    const deps = depsThatShutDownAtFirstScan({
      logError: (message: string) => {
        errors.push(message);
        if (first && message.startsWith("Stale branch cleanup failed")) {
          first = false;
          throw new Error("log sink down");
        }
      },
      cleanupStaleBranches: () => Promise.reject(new Error("stale boom")),
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;
    await runCoreLoop(config, deps);

    assert(
      errors.some((e) =>
        e.includes("[deferred-sweep] startup-branch-cleanup failed") &&
        e.includes("log sink down")
      ),
      `expected the sweep sink to report the failure, got: ${
        errors.join(" | ")
      }`,
    );
  },
);
