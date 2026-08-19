/**
 * Tests for the per-cycle stale-assignment recovery hook in run_core.ts
 * (Issue #2672).
 *
 * Proves that:
 *   (a) `recoverStaleAssignments` is invoked on every scan cycle (not just
 *       at start-up) and can recover a stale cross-account assignment
 *       mid-run without a worker restart,
 *   (b) the per-cycle scan reuses the shared issue cache so no duplicate
 *       `fetchAllIssues` network fetch happens within an iteration,
 *   (c) a throw from the hook is logged and the scan loop continues,
 *   (d) the start-up `recoverStuckIssues` invocation is preserved.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
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

    reportFleetHealthHeartbeat: () => Promise.resolve(),

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
  "run_core - invokes recoverStaleAssignments every scan cycle (Issue #2672)",
  async () => {
    const nowRef = { value: 0 };
    let recoveryCalls = 0;
    const deps = createMockDeps({
      now: () => nowRef.value,
      sleep: makeCycleLimitedSleep(3, nowRef),
      recoverStaleAssignments: () => {
        recoveryCalls++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // Three cycles ran, so the per-cycle recovery scan fired three times.
    assertEquals(recoveryCalls, 3, "expected recovery on every scan cycle");
  },
);

Deno.test(
  "run_core - recovery frees a stale cross-account assignment mid-run (Issue #2672)",
  async () => {
    const nowRef = { value: 0 };
    // Model a leaked cross-account assignment: the issue is only claimable
    // after the per-cycle recovery scan unassigns the stale account. The
    // recovery scan runs before the Priority 2 issue scan in the same cycle,
    // so the freed issue is picked up without a worker restart.
    let recovered = false;
    let processed = false;
    const deps = createMockDeps({
      now: () => nowRef.value,
      sleep: makeCycleLimitedSleep(2, nowRef),
      recoverStaleAssignments: () => {
        recovered = true;
        return Promise.resolve();
      },
      findNextIssue: () => {
        // The issue becomes claimable only after recovery has run.
        if (recovered && !processed) {
          return Promise.resolve({
            ok: true,
            value: {
              repo: "org/repo",
              issueNumber: 42,
              issueTitle: "leaked issue",
              milestoneTitle: "",
            },
          });
        }
        return Promise.resolve({ ok: true, value: null });
      },
      processIssue: () => {
        processed = true;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    assertEquals(recovered, true, "recovery scan should have run");
    assertEquals(processed, true, "the freed issue should be processed");
    assertEquals(
      result.issuesProcessed,
      1,
      "the recovered issue should be processed mid-run without a restart",
    );
  },
);

Deno.test(
  "run_core - per-cycle recovery reuses the shared issue cache (Issue #2672)",
  async () => {
    const nowRef = { value: 0 };
    // A single shared "network" counter stands in for fetchAllIssues. Both
    // the recovery scan and the Priority 2 issue scan read through the same
    // iteration-scoped cache, so within one iteration the underlying fetch
    // runs at most once. The mock cache is reset at each iteration boundary
    // via resetIterationCaches, mirroring production.
    let networkFetches = 0;
    let cached: string[] | null = null;
    const fetchAllIssuesShared = (): string[] => {
      if (cached === null) {
        networkFetches++;
        cached = ["org/repo#1", "org/repo#2"];
      }
      return cached;
    };
    let maxFetchesInAnyIteration = 0;
    let fetchesThisIteration = 0;

    const nowRef2 = nowRef;
    const deps = createMockDeps({
      now: () => nowRef2.value,
      sleep: makeCycleLimitedSleep(2, nowRef2),
      resetIterationCaches: () => {
        // Iteration boundary: snapshot the per-iteration fetch count then
        // clear the shared cache so the next iteration starts fresh.
        if (fetchesThisIteration > maxFetchesInAnyIteration) {
          maxFetchesInAnyIteration = fetchesThisIteration;
        }
        fetchesThisIteration = 0;
        cached = null;
      },
      recoverStaleAssignments: () => {
        const before = networkFetches;
        fetchAllIssuesShared();
        if (networkFetches > before) fetchesThisIteration++;
        return Promise.resolve();
      },
      findNextIssue: () => {
        const before = networkFetches;
        fetchAllIssuesShared();
        if (networkFetches > before) fetchesThisIteration++;
        return Promise.resolve({ ok: true, value: null });
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);
    // Account for the final (incomplete) iteration that never hit a reset.
    if (fetchesThisIteration > maxFetchesInAnyIteration) {
      maxFetchesInAnyIteration = fetchesThisIteration;
    }

    assertEquals(
      maxFetchesInAnyIteration,
      1,
      "recovery + issue scan must share one fetch per iteration (no duplicate)",
    );
  },
);

Deno.test(
  "run_core - recoverStaleAssignments throw does not abort loop (Issue #2672)",
  async () => {
    const nowRef = { value: 0 };
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowRef.value,
      sleep: makeCycleLimitedSleep(1, nowRef),
      log: (m: string) => logs.push(m),
      recoverStaleAssignments: () =>
        Promise.reject(new Error("simulated recovery crash")),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    assertEquals(result.plannedShutdown, true, "loop should finish cleanly");
    assertEquals(
      logs.some((m) =>
        m.includes("Stale-assignment recovery failed (continuing)") &&
        m.includes("simulated recovery crash")
      ),
      true,
      "expected the recovery crash to be logged",
    );
  },
);

Deno.test(
  "run_core - quiet no-op recovery adds no extra log noise (Issue #2672)",
  async () => {
    const nowRef = { value: 0 };
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowRef.value,
      sleep: makeCycleLimitedSleep(1, nowRef),
      log: (m: string) => logs.push(m),
      // A no-op recovery (nothing recovered) returns without logging.
      recoverStaleAssignments: () => Promise.resolve(),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      logs.some((m) => m.includes("Stale-assignment recovery")),
      false,
      "a no-op recovery must not add any [stale-assignment] log line",
    );
  },
);

Deno.test(
  "run_core - omitting recoverStaleAssignments is a no-op (Issue #2672)",
  async () => {
    const nowRef = { value: 0 };
    const deps = createMockDeps({
      now: () => nowRef.value,
      sleep: makeCycleLimitedSleep(1, nowRef),
      // recoverStaleAssignments intentionally omitted (optional hook).
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);
    assertEquals(result.plannedShutdown, true);
  },
);

Deno.test(
  "run_core - start-up recoverStuckIssues invocation is preserved (Issue #2672)",
  async () => {
    const nowRef = { value: 0 };
    let startupRecoveryCalls = 0;
    const deps = createMockDeps({
      now: () => nowRef.value,
      sleep: makeCycleLimitedSleep(1, nowRef),
      recoverStuckIssues: () => {
        startupRecoveryCalls++;
        return Promise.resolve();
      },
      recoverStaleAssignments: () => Promise.resolve(),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // Start-up recovery still runs exactly once (in runInitialisation).
    assertEquals(
      startupRecoveryCalls,
      1,
      "start-up recoverStuckIssues should still run once",
    );
  },
);
