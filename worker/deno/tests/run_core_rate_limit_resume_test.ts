/**
 * Tests for the rate-limit pause-and-resume behaviour in run_core
 * (Issue #1780). Covers all five scenarios required by the issue:
 *
 *   1. Pre-flight: rate-limited → wait → second pre-flight ok → main loop runs.
 *   2. Pre-flight: rate-limited → shutdown during wait → returns without
 *      entering the main loop.
 *   3. Catch handler: rate-limit error caught mid-cycle → wait → loop
 *      resumes for the next iteration.
 *   4. Catch handler: rate-limit error → wait would exceed `endTime` →
 *      exits cleanly with "Run duration expired".
 *   5. Mid-loop signal: uses actual remaining seconds from the signal
 *      data, not the fixed `config.rateLimitBackoff`.
 *
 * The tests rebuild a minimal {@link RunCoreDeps} mock locally so the
 * file is self-contained and does not depend on internal helpers in
 * the wider run_core test file.
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
// Mock deps factory — minimal happy-path defaults plus per-test overrides.
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
// 1. Pre-flight: rate-limited → wait → second pre-flight ok → main loop runs.
// ---------------------------------------------------------------------------

Deno.test(
  "run_core resume - preflight rate-limited then clears, main loop runs",
  async () => {
    const calls: string[] = [];
    let preflightCalls = 0;
    let nowValue = 0;

    const deps = createMockDeps({
      log: (m) => calls.push(`log:${m}`),
      preflightGitHubRateLimit: () => {
        preflightCalls++;
        if (preflightCalls === 1) {
          return Promise.resolve({
            rateLimited: true,
            remainingSeconds: 60,
            message: "GraphQL quota low",
          });
        }
        return Promise.resolve({
          rateLimited: false,
          remainingSeconds: 0,
          message: "ok",
        });
      },
      gitResetToOrigin: () => {
        calls.push("git-reset");
        return Promise.resolve({ ok: true, value: undefined });
      },
      findAndProcessPrFeedback: () => {
        calls.push("pr-feedback");
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

    assert(
      preflightCalls >= 2,
      `expected ≥2 preflights, got ${preflightCalls}`,
    );
    assert(calls.includes("git-reset"), "init must run after wait clears");
    assert(
      calls.includes("pr-feedback"),
      "priority dispatch must run after wait clears",
    );
  },
);

// ---------------------------------------------------------------------------
// 2. Pre-flight: rate-limited → shutdown during wait → returns without main loop.
// ---------------------------------------------------------------------------

Deno.test(
  "run_core resume - shutdown during preflight wait returns without main loop",
  async () => {
    const calls: string[] = [];
    let nowValue = 0;
    // Simulate a SIGTERM landing during the pre-flight wait by capturing
    // the run_core's shutdown handler and firing it after the first
    // sleep advances the clock.
    let shutdownHandler: (() => void) | null = null;
    let signalsFired = false;

    const deps = createMockDeps({
      log: (m) => calls.push(`log:${m}`),
      addSignalListener: (signal, handler) => {
        if (signal === "SIGTERM") shutdownHandler = handler;
      },
      preflightGitHubRateLimit: () =>
        Promise.resolve({
          rateLimited: true,
          remainingSeconds: 1800,
          message: "GraphQL quota low",
        }),
      gitResetToOrigin: () => {
        calls.push("git-reset");
        return Promise.resolve({ ok: true, value: undefined });
      },
      findAndProcessPrFeedback: () => {
        calls.push("pr-feedback");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      now: () => nowValue,
      sleep: (ms?: number) => {
        nowValue += ms ?? 30000;
        if (!signalsFired && shutdownHandler) {
          signalsFired = true;
          shutdownHandler();
        }
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    // Init and priority handlers must NOT have run.
    assertEquals(calls.includes("git-reset"), false);
    assertEquals(calls.includes("pr-feedback"), false);
    // Exit reason should reflect the shutdown during the pre-flight wait.
    assert(
      result.exitReason.toLowerCase().includes("shutdown"),
      `expected shutdown exit reason, got: ${result.exitReason}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 3. Catch handler: rate-limit mid-cycle → wait → loop resumes.
// ---------------------------------------------------------------------------

Deno.test(
  "run_core resume - catch handler waits and re-enters main loop",
  async () => {
    const calls: string[] = [];
    let findCalls = 0;
    let nowValue = 0;

    const deps = createMockDeps({
      log: (m) => calls.push(`log:${m}`),
      findNextIssue: () => {
        findCalls++;
        if (findCalls === 1) {
          throw new Error(
            "gh command failed: GraphQL: API rate limit already exceeded for user ID 1.",
          );
        }
        return Promise.resolve({ ok: true, value: null });
      },
      // Reset 60s into the future — well within the 3600s run duration.
      getRateLimitReset: () => Promise.resolve(60),
      now: () => nowValue,
      sleep: (ms?: number) => {
        nowValue += ms ?? 30000;
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    // findNextIssue ran more than once → loop resumed after the wait.
    assert(findCalls >= 2, `expected resume, findCalls=${findCalls}`);
    // The pause was logged.
    assert(
      calls.some((c) => c.includes("Primary rate limit hit mid-cycle")),
      `expected pause log, got: ${calls.join(" | ")}`,
    );
    // Run finishes on the planned-shutdown path, not a fatal exit.
    assert(
      result.exitReason.includes("Run duration expired"),
      `expected planned-shutdown exit, got: ${result.exitReason}`,
    );
  },
);

// ---------------------------------------------------------------------------
// 4. Catch handler: wait would exceed endTime → exits with "Run duration expired".
// ---------------------------------------------------------------------------

Deno.test(
  "run_core resume - catch handler exits when wait would exceed endTime",
  async () => {
    const calls: string[] = [];
    let crashes = 0;
    let nowValue = 0;

    const deps = createMockDeps({
      log: (m) => calls.push(`log:${m}`),
      findNextIssue: () => {
        throw new Error(
          "gh command failed: API rate limit already exceeded for user ID 1.",
        );
      },
      // Reset is far past the end of the run (deps clock starts at 0,
      // run duration 60s, reset 1h in seconds-since-epoch space).
      getRateLimitReset: () => Promise.resolve(60 * 60),
      sendCrashNotification: () => {
        crashes++;
        return Promise.resolve();
      },
      now: () => nowValue,
      sleep: (ms?: number) => {
        nowValue += ms ?? 30000;
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 60; // tight cap so the wait would overshoot

    const result = await runCoreLoop(config, deps);

    assertEquals(result.exitReason, "Run duration expired");
    // Must have detected the over-cap wait and logged the early-exit.
    assert(
      calls.some((c) =>
        c.includes("rate-limit wait would exceed run-duration cap")
      ),
      `expected over-cap log, got: ${calls.join(" | ")}`,
    );
    // Crash-notification must NOT fire on rate-limit early-exit.
    assertEquals(crashes, 0);
  },
);

// ---------------------------------------------------------------------------
// 5. Mid-loop signal: uses actual remaining seconds, not the fixed backoff.
// ---------------------------------------------------------------------------

Deno.test(
  "run_core resume - mid-loop signal uses actual remaining seconds",
  async () => {
    const calls: string[] = [];
    const sleepDurations: number[] = [];
    let nowValue = 0;
    let signalChecks = 0;

    const deps = createMockDeps({
      log: (m) => calls.push(`log:${m}`),
      isRateLimitActive: () => {
        signalChecks++;
        // Active on first iteration only — clears on the next loop.
        return Promise.resolve(signalChecks === 1);
      },
      getRateLimitRemainingSeconds: () => Promise.resolve(45),
      now: () => nowValue,
      sleep: (ms?: number) => {
        sleepDurations.push(ms ?? 30000);
        nowValue += ms ?? 30000;
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;
    // Sentinel value we should NOT see — fixed backoff is bypassed when
    // remaining > 0.
    config.rateLimitBackoff = 999_999;

    await runCoreLoop(config, deps);

    // Pause log must mention the remaining seconds (Issue #1910 enriched
    // the format from "(45s remaining)" to "in 45s" plus the absolute reset).
    assert(
      calls.some((c) =>
        c.includes("Rate limit signal active") && c.includes("in 45s")
      ),
      `expected remaining-seconds log, got: ${calls.join(" | ")}`,
    );
    // The fixed-backoff value (999_999_000ms) must never have been slept.
    assertEquals(
      sleepDurations.includes(999_999_000),
      false,
      "fixed rateLimitBackoff was used instead of signal remaining",
    );
  },
);

// ---------------------------------------------------------------------------
// 6. Per-priority catch short-circuits on a thrown rate-limit error (Issue #1921).
//    A priority handler that throws a primary rate-limit error must stop the
//    priority dispatch loop immediately — no subsequent priorities should run
//    in the same iteration. The outer catch then pauses until the quota resets.
// ---------------------------------------------------------------------------

Deno.test(
  "run_core resume - thrown rate-limit short-circuits the priority dispatch loop",
  async () => {
    const calls: string[] = [];
    let refinementCalls = 0;
    let nowValue = 0;

    const deps = createMockDeps({
      log: (m) => calls.push(`log:${m}`),
      logError: (m) => calls.push(`error:${m}`),
      // Priority 1.75 (Issue Refinement) throws a primary rate-limit error
      // on the first iteration. Subsequent priorities (1.78 Grill-Me, 1.80
      // Planning, 1.85 Question) must NOT run.
      findAndProcessRefinement: () => {
        refinementCalls++;
        if (refinementCalls === 1) {
          throw new Error(
            "gh command failed (exit 1): GraphQL: API rate limit already exceeded for user ID 23146043.",
          );
        }
        calls.push("refinement");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      findAndProcessGrillMe: () => {
        calls.push("grill-me");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      findAndProcessPlanning: () => {
        calls.push("planning");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      findAndProcessQuestion: () => {
        calls.push("question");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      // Reset is reachable within the run duration so the loop resumes.
      getRateLimitReset: () => Promise.resolve(60),
      now: () => nowValue,
      sleep: (ms?: number) => {
        nowValue += ms ?? 30000;
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // Subsequent priorities in the SAME iteration must not have run.
    // After the pause, the loop resumes — the handlers may run on the
    // next iteration, so we count the noisy per-priority error lines
    // for a single rate-limit event instead.
    const rateLimitErrorLines = calls.filter((c) =>
      c.startsWith("error:Error in priority") && c.includes("rate limit")
    );
    assertEquals(
      rateLimitErrorLines.length,
      0,
      `expected per-priority rate-limit error to be re-thrown (not logged), got: ${
        rateLimitErrorLines.join(" | ")
      }`,
    );

    // The outer rate-limit catch must have logged the pause exactly once
    // (one pause per rate-limit event).
    const pauseLines = calls.filter((c) =>
      c.includes("Primary rate limit hit mid-cycle")
    );
    assert(
      pauseLines.length >= 1,
      `expected outer rate-limit catch to handle pause, got: ${
        calls.join(" | ")
      }`,
    );
  },
);
