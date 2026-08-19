/**
 * Tests for the scan-cursor resume behaviour in run_core (Issue #2427).
 *
 * Verifies that when the dispatch loop (re)starts:
 *   1. A fresh cursor makes the first sweep skip priorities below the cursor's
 *      priority, then revert to normal dispatch on the next iteration.
 *   2. A stale cursor (≥ 60s old) is ignored — dispatch starts at Priority 1.
 *   3. A successful claim resets the cursor.
 *   4. The cursor is persisted as each priority is entered.
 *
 * A minimal RunCoreDeps mock is rebuilt locally so the file is self-contained.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import type { ScanCursor } from "../lib/scan_cursor.ts";

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

const issue: DiscoveredIssue = {
  repo: "org/repo",
  issueNumber: 1,
  issueTitle: "demo",
  milestoneTitle: "",
};

Deno.test(
  "run_core scan cursor - fresh cursor skips earlier priorities on the first sweep only",
  async () => {
    const calls: string[] = [];
    let nowValue = 0;
    let scanCount = 0;
    let shutdownHandler: (() => void) | null = null;

    const deps = createMockDeps({
      addSignalListener: (signal, handler) => {
        if (signal === "SIGTERM") shutdownHandler = handler;
      },
      // Fresh cursor at Priority 2 (savedAt now → age 0).
      loadScanCursor: () =>
        Promise.resolve(
          { priority: 2, repoIndex: 0, savedAt: 0 } as ScanCursor,
        ),
      findAndProcessPrFeedback: () => {
        calls.push("pr");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      findNextIssue: () => {
        scanCount++;
        calls.push("scan");
        // End the loop after the second iteration's scan.
        if (scanCount >= 2 && shutdownHandler) shutdownHandler();
        return Promise.resolve({ ok: true, value: null });
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

    // First iteration: scanning runs before any PR-feedback (priorities below
    // 2 skipped). Second iteration: PR-feedback runs normally.
    assertEquals(calls[0], "scan");
    assert(calls.includes("pr"), "PR feedback must run on a later sweep");
    assert(
      calls.indexOf("scan") < calls.indexOf("pr"),
      `expected first sweep to skip PR feedback, got: ${calls.join(",")}`,
    );
  },
);

Deno.test(
  "run_core scan cursor - stale cursor is ignored, dispatch starts at Priority 1",
  async () => {
    const calls: string[] = [];
    let nowValue = 0;
    let shutdownHandler: (() => void) | null = null;

    const deps = createMockDeps({
      addSignalListener: (signal, handler) => {
        if (signal === "SIGTERM") shutdownHandler = handler;
      },
      // Stale cursor: savedAt 100s in the past (age 100 > 60).
      loadScanCursor: () =>
        Promise.resolve(
          { priority: 2, repoIndex: 0, savedAt: -100 } as ScanCursor,
        ),
      findAndProcessPrFeedback: () => {
        calls.push("pr");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      findNextIssue: () => {
        calls.push("scan");
        if (shutdownHandler) shutdownHandler();
        return Promise.resolve({ ok: true, value: null });
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

    // PR feedback ran before scanning on the first (and only) iteration.
    assertEquals(calls[0], "pr");
    assert(
      calls.indexOf("pr") < calls.indexOf("scan"),
      `expected normal Priority 1-first dispatch, got: ${calls.join(",")}`,
    );
  },
);

Deno.test(
  "run_core scan cursor - a successful claim resets the cursor",
  async () => {
    let resetCalls = 0;
    const savedPriorities: number[] = [];
    let nowValue = 0;
    let issueReturned = false;
    let shutdownHandler: (() => void) | null = null;

    const deps = createMockDeps({
      addSignalListener: (signal, handler) => {
        if (signal === "SIGTERM") shutdownHandler = handler;
      },
      loadScanCursor: () => Promise.resolve(null),
      saveScanCursor: (priority: number) => {
        savedPriorities.push(priority);
        return Promise.resolve();
      },
      resetScanCursor: () => {
        resetCalls++;
        if (shutdownHandler) shutdownHandler();
        return Promise.resolve();
      },
      findNextIssue: () => {
        if (!issueReturned) {
          issueReturned = true;
          return Promise.resolve({ ok: true, value: issue });
        }
        return Promise.resolve({ ok: true, value: null });
      },
      processIssue: () =>
        Promise.resolve({ ok: true, value: { success: true } }),
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
      resetCalls >= 1,
      `expected cursor reset on claim, got ${resetCalls}`,
    );
    // The cursor was persisted as priorities were entered, including 2.
    assert(
      savedPriorities.includes(2),
      `expected cursor saved at Priority 2, got: ${savedPriorities.join(",")}`,
    );
    assert(
      savedPriorities.includes(1),
      `expected cursor saved at Priority 1, got: ${savedPriorities.join(",")}`,
    );
  },
);
