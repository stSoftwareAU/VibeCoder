/**
 * The main loop runs the cross-repo open-PR prefetch every cycle (Issue #1486).
 *
 * The prefetch collapses ~130 per-repo per-author `gh pr list` calls into one
 * search per owner, but only if the loop actually calls it — and only if a
 * failing search cannot take the cycle down with it. Both facts live in
 * `runCoreLoop` and nowhere else, so they are asserted here:
 *
 *   (a) the hook fires once per scan cycle, after the trusted-author refresh
 *       whose `allowed_authors` decide which logins are searched;
 *   (b) a throw from the hook is logged and the cycle carries on, because the
 *       per-repo listings still answer every consumer.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal RunCoreDeps factory — fully-idle by default. */
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

/**
 * Build a `sleep` that ends the loop after `cycles` end-of-cycle sleeps by
 * advancing the injected clock past the run-duration cap.
 */
function makeCycleLimitedSleep(
  cycles: number,
  nowRef: { value: number },
): () => Promise<void> {
  let count = 0;
  return () => {
    count++;
    if (count >= cycles) nowRef.value += 4000 * 1000;
    return Promise.resolve();
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - the cross-repo PR prefetch runs on every scan cycle (Issue #1486)",
  async () => {
    const nowRef = { value: 0 };
    const order: string[] = [];
    let prefetchCalls = 0;
    const deps = createMockDeps({
      now: () => nowRef.value,
      sleep: makeCycleLimitedSleep(3, nowRef),
      refreshTrustedAuthors: () => {
        order.push("trust");
        return Promise.resolve({ ok: true as const });
      },
      prefetchFleetOpenPrs: () => {
        prefetchCalls++;
        order.push("prefetch");
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(prefetchCalls, 3, "expected one prefetch per scan cycle");
    // The author sets it searches for come from the refresh, so the order
    // matters: a prefetch before the refresh would search the empty seed.
    assertEquals(order.slice(0, 2), ["trust", "prefetch"]);
  },
);

Deno.test(
  "run_core - a failing prefetch is logged and the cycle continues (Issue #1486)",
  async () => {
    const nowRef = { value: 0 };
    const errors: string[] = [];
    let issuesScanned = 0;
    const deps = createMockDeps({
      now: () => nowRef.value,
      sleep: makeCycleLimitedSleep(2, nowRef),
      logError: (message: string) => errors.push(message),
      prefetchFleetOpenPrs: () =>
        Promise.reject(new Error("search unavailable")),
      findNextIssue: () => {
        issuesScanned++;
        return Promise.resolve({ ok: true, value: null });
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assert(
      errors.some((e) =>
        e.includes("fleet-pr-prefetch") && e.includes("search unavailable")
      ),
      `the failure must be reported, not swallowed; got: ${errors.join(" | ")}`,
    );
    assert(
      issuesScanned > 0,
      "the cycle must carry on scanning via the per-repo listings",
    );
  },
);
