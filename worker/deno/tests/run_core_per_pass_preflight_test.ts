/**
 * Per-pass pre-flight quota gate (Issue #42).
 *
 * The process-start pre-flight gate only runs once. When a sibling worker
 * sharing the same token exhausts the primary GraphQL quota mid-run, this
 * process learns about it only when one of its own calls fails — the very
 * doomed call the Issue #42 latch exists to avoid. `gh api rate_limit` is
 * free and rides the core quota, so the gate is re-run at the top of every
 * priority pass.
 *
 * Covered here:
 *   1. Quota exhausted at the top of a pass → the pass pauses before it
 *      dispatches any priority handler, then resumes once the quota clears.
 *   2. A healthy quota never pauses the pass.
 *   3. Shutdown during the per-pass wait exits cleanly without dispatching.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";

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

// ---------------------------------------------------------------------------
// 1. Quota exhausted at the top of a pass → pause before dispatching.
// ---------------------------------------------------------------------------

Deno.test(
  "per-pass preflight - exhausted quota pauses the pass before any priority runs",
  async () => {
    const events: string[] = [];
    let preflightCalls = 0;
    let nowValue = 0;

    const deps = createMockDeps({
      log: (m) => events.push(`log:${m}`),
      preflightGitHubRateLimit: () => {
        preflightCalls++;
        // Call 1 is the process-start gate: healthy, so the run starts.
        // Call 2 is the per-pass gate: a sibling worker has exhausted the
        // shared quota since start-up.
        if (preflightCalls === 2) {
          events.push("preflight:rate-limited");
          return Promise.resolve({
            rateLimited: true,
            remainingSeconds: 120,
            message: "GraphQL quota low: 0/5000 remaining",
          });
        }
        return Promise.resolve({
          rateLimited: false,
          remainingSeconds: 0,
          message: "ok",
        });
      },
      findAndProcessPrFeedback: () => {
        events.push("pr-feedback");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      checkGhAuth: () => {
        events.push("gh-auth");
        return Promise.resolve({ ok: true, value: { valid: true } });
      },
      now: () => nowValue,
      sleep: (ms?: number) => {
        nowValue += ms ?? 30000;
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    const limitedAt = events.indexOf("preflight:rate-limited");
    assert(limitedAt >= 0, "per-pass gate must have been consulted");

    // No priority handler and no quota-spending health check may run between
    // the exhausted read and the pause.
    const firstDispatch = events.findIndex(
      (e, i) => i > limitedAt && (e === "pr-feedback" || e === "gh-auth"),
    );
    const pauseAt = events.findIndex(
      (e, i) => i > limitedAt && e.includes("log:Per-pass pre-flight"),
    );
    assert(
      pauseAt >= 0,
      `expected a per-pass pause log, got: ${events.join(" | ")}`,
    );
    assert(
      firstDispatch === -1 || pauseAt < firstDispatch,
      `pass dispatched work against a dead quota: ${events.join(" | ")}`,
    );

    // The pass resumes once the quota clears — the dispatch runs afterwards.
    assert(
      events.slice(pauseAt).includes("pr-feedback"),
      `expected the pass to resume after the wait, got: ${events.join(" | ")}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 2. Healthy quota never pauses the pass.
// ---------------------------------------------------------------------------

Deno.test(
  "per-pass preflight - healthy quota dispatches without pausing",
  async () => {
    const events: string[] = [];
    let nowValue = 0;

    const deps = createMockDeps({
      log: (m) => events.push(`log:${m}`),
      findAndProcessPrFeedback: () => {
        events.push("pr-feedback");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      now: () => nowValue,
      sleep: (ms?: number) => {
        nowValue += ms ?? 30000;
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assert(events.includes("pr-feedback"), "priority dispatch must run");
    assertEquals(
      events.some((e) => e.includes("Per-pass pre-flight")),
      false,
      "a healthy quota must not log a pause",
    );
  },
);

// ---------------------------------------------------------------------------
// 3. Shutdown during the per-pass wait exits cleanly without dispatching.
// ---------------------------------------------------------------------------

Deno.test(
  "per-pass preflight - shutdown during the wait exits without dispatching",
  async () => {
    const events: string[] = [];
    let nowValue = 0;
    let preflightCalls = 0;
    let shutdownHandler: (() => void) | null = null;
    let fired = false;

    const deps = createMockDeps({
      log: (m) => events.push(`log:${m}`),
      addSignalListener: (signal, handler) => {
        if (signal === "SIGTERM") shutdownHandler = handler;
      },
      preflightGitHubRateLimit: () => {
        preflightCalls++;
        if (preflightCalls === 1) {
          return Promise.resolve({
            rateLimited: false,
            remainingSeconds: 0,
            message: "ok",
          });
        }
        return Promise.resolve({
          rateLimited: true,
          remainingSeconds: 900,
          message: "GraphQL quota low: 0/5000 remaining",
        });
      },
      findAndProcessPrFeedback: () => {
        events.push("pr-feedback");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      now: () => nowValue,
      sleep: (ms?: number) => {
        nowValue += ms ?? 30000;
        if (!fired && shutdownHandler) {
          fired = true;
          shutdownHandler();
        }
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    assertEquals(
      events.includes("pr-feedback"),
      false,
      "no priority may dispatch against a dead quota",
    );
    assert(
      result.plannedShutdown,
      `expected a clean shutdown, got: ${result.exitReason}`,
    );
  },
);
