/**
 * Tests for the `[idle-hooks]` heartbeat lines added in run_core.ts
 * (Issue #2018, updated for Issue #2023).
 *
 * Proves that every priority-loop iteration emits a structured decision
 * line for the idle-task filer hook, regardless of whether the hook
 * actually runs. Without these lines a silent failure in the hook is
 * invisible in the worker log — see Issue #2018 for the production
 * symptom. Issue #2023 retired the in-process `runIdleSecurityScan`
 * hook, leaving `runIdleTaskFiler` as the only idle hook.
 *
 * The lines have the shape (Issue #2048 — both flags always present):
 *
 *   [idle-hooks] foundClaimableIssue=false scanHadSuccess=false invoking=idle-task-filer
 *   [idle-hooks] foundClaimableIssue=true scanHadSuccess=true skipping=idle-task-filer reason=found-issue
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - idle pass emits [idle-hooks] invoking line for the filer (Issue #2018)",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      runIdleTaskFiler: () => Promise.resolve(),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    const filerLine = logs.find((m) =>
      m.includes("[idle-hooks]") &&
      m.includes("invoking=idle-task-filer") &&
      m.includes("foundClaimableIssue=false") &&
      m.includes("scanHadSuccess=false")
    );
    assert(
      filerLine !== undefined,
      `expected [idle-hooks] invoking=idle-task-filer line with both flags; got: ${
        JSON.stringify(logs)
      }`,
    );
  },
);

Deno.test(
  "run_core - successful issue cycle emits [idle-hooks] skipping line for the filer (Issue #2018)",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    let findCalls = 0;
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      findNextIssue: () => {
        findCalls++;
        if (findCalls === 1) {
          return Promise.resolve({
            ok: true as const,
            value: {
              repo: "org/repo",
              issueNumber: 1,
              issueTitle: "Issue 1",
              milestoneTitle: "",
            },
          });
        }
        return Promise.resolve({ ok: true as const, value: null });
      },
      processIssue: () =>
        Promise.resolve({ ok: true as const, value: { success: true } }),
      runIdleTaskFiler: () => {
        throw new Error("filer should not run on a busy cycle");
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    const filerSkipped = logs.find((m) =>
      m.includes("[idle-hooks]") &&
      m.includes("skipping=idle-task-filer") &&
      m.includes("foundClaimableIssue=true") &&
      m.includes("scanHadSuccess=true") &&
      m.includes("reason=found-issue")
    );
    assert(
      filerSkipped !== undefined,
      `expected [idle-hooks] skipping=idle-task-filer reason=found-issue line with both flags; got: ${
        JSON.stringify(logs)
      }`,
    );
  },
);

Deno.test(
  "run_core - [idle-hooks] line is emitted even when filer hook is undefined (Issue #2018)",
  async () => {
    // When the filer hook is not wired (e.g. an older or stripped-down
    // test deps), the decision line must still record the gate state.
    // This keeps the heartbeat unconditional — the absence of a hook is
    // its own signal, recorded with `reason=no_hook`, rather than
    // producing a silent iteration.
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      // Filer hook deliberately omitted.
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    const filerLine = logs.find((m) =>
      m.includes("[idle-hooks]") &&
      m.includes("idle-task-filer")
    );
    assert(
      filerLine !== undefined,
      `expected an [idle-hooks] line for idle-task-filer; got: ${
        JSON.stringify(logs)
      }`,
    );
  },
);

Deno.test(
  "run_core - filer crash leaves the [idle-hooks] invoking line in the log (Issue #2018)",
  async () => {
    // If the filer hook throws, the heartbeat line that recorded the
    // decision to invoke it must still be present — so an operator can
    // tie the subsequent `Idle-task filer failed (continuing): ...`
    // line back to a recorded attempt. Establishes that the heartbeat
    // is emitted BEFORE the hook runs, not afterwards.
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      runIdleTaskFiler: () =>
        Promise.reject(new Error("simulated filer crash")),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);
    assertEquals(result.plannedShutdown, true);

    const invokingIdx = logs.findIndex((m) =>
      m.includes("[idle-hooks]") &&
      m.includes("invoking=idle-task-filer")
    );
    assert(
      invokingIdx >= 0,
      `expected an [idle-hooks] invoking=idle-task-filer line; got: ${
        JSON.stringify(logs)
      }`,
    );

    const failureIdx = logs.findIndex((m) =>
      m.includes("Idle-task filer failed") &&
      m.includes("simulated filer crash")
    );
    assert(
      failureIdx >= 0,
      `expected the filer crash to be logged; got: ${JSON.stringify(logs)}`,
    );
    assertEquals(
      invokingIdx < failureIdx,
      true,
      "expected [idle-hooks] invoking line to precede the crash log",
    );
  },
);
