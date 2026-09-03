/**
 * Loop-integration tests for the idle-decision census hook (Issue #2811).
 *
 * Proves that:
 *   1. On an idle pass (`foundClaimableIssue === false`), the loop invokes
 *      `runIdleDecisionCensus` with `decisionPoint: "filing"`, after the
 *      idle-detect audit and before/around the filer (it sits at the same
 *      gate), so its `[idle-census] ...` lines appear in the idle window.
 *   2. On a busy pass (a Priority 2 issue was claimed and processed), the
 *      census hook is NOT invoked — it only runs at the idle gate.
 *   3. A throw from the census hook is caught and logged so the main loop
 *      continues uninterrupted.
 *   4. Issue #437: the hook is told whether the claim scan actually
 *      completed an eligibility pass. A scan that came up empty reports
 *      `claimScanCompleted: true`; a loop that stopped before its next claim
 *      (cycle deadline / claim-runway floor) reports `false`, so the
 *      idle-inversion escalation cannot blame a scan that never looked.
 *
 * Australian English spelling used throughout (behaviour, organisation).
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
    now: () => Date.now(),

    ...overrides,
  };
}

Deno.test(
  "run_core - idle pass invokes runIdleDecisionCensus with decisionPoint=filing",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const censusCalls: Array<{ decisionPoint: string }> = [];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      runIdleDecisionCensus: ({ decisionPoint }) => {
        censusCalls.push({ decisionPoint });
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(censusCalls.length, 1);
    assertEquals(censusCalls[0]!.decisionPoint, "filing");
  },
);

Deno.test(
  "run_core - busy pass does NOT invoke runIdleDecisionCensus",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    let findCalls = 0;
    let censusCalls = 0;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      findNextIssue: () => {
        findCalls++;
        if (findCalls === 1) {
          return Promise.resolve({
            ok: true as const,
            value: {
              repo: "org/repo",
              issueNumber: 42,
              issueTitle: "An issue",
              milestoneTitle: "",
            },
          });
        }
        return Promise.resolve({ ok: true as const, value: null });
      },
      processIssue: () =>
        Promise.resolve({ ok: true as const, value: { success: true } }),
      runIdleDecisionCensus: () => {
        censusCalls += 1;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(censusCalls, 0);
  },
);

Deno.test(
  "run_core - a throw from runIdleDecisionCensus is caught and the loop continues",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    let filerCalls = 0;
    const logs: string[] = [];

    const deps = createMockDeps({
      now: () => nowValue,
      log: (line: string) => logs.push(line),
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      runIdleDecisionCensus: () => {
        throw new Error("boom");
      },
      runIdleTaskFiler: () => {
        filerCalls += 1;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // The filer still ran after the census threw — the loop was not aborted.
    assertEquals(filerCalls, 1);
    assert(
      logs.some((l) => l.includes("Idle-decision census failed (continuing)")),
    );
  },
);

// ---------------------------------------------------------------------------
// Issue #437: the census must know whether the scan actually refused the work
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - an empty scan reports claimScanCompleted=true (Issue #437)",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const calls: boolean[] = [];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      // The scan considers the backlog and finds nothing eligible.
      findNextIssue: () => Promise.resolve({ ok: true as const, value: null }),
      runIdleDecisionCensus: ({ claimScanCompleted }) => {
        calls.push(claimScanCompleted);
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(calls, [true]);
  },
);

Deno.test(
  "run_core - a claim-runway stop reports claimScanCompleted=false (Issue #437)",
  async () => {
    let nowValue = 0;
    let findCalls = 0;
    const calls: boolean[] = [];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: (ms?: number) => {
        nowValue += ms ?? 4000 * 1000;
        return Promise.resolve();
      },
      // A floor as long as the whole hard-cap runway: the loop stops before
      // its first claim, so the backlog is never evaluated (Issue #425).
      minClaimRunwaySeconds: 3600,
      claimHardCap: { ceilingMs: 3600 * 1000, windowSeconds: 3600 },
      findNextIssue: () => {
        findCalls += 1;
        return Promise.resolve({ ok: true as const, value: null });
      },
      runIdleDecisionCensus: ({ claimScanCompleted }) => {
        calls.push(claimScanCompleted);
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(findCalls, 0, "the scan must not have evaluated the backlog");
    assert(calls.length >= 1, "the census must still run at the idle gate");
    assert(
      calls.every((c) => c === false),
      `every census call must report an incomplete scan, got: ${calls}`,
    );
  },
);

Deno.test(
  "run_core - a concurrent pool's empty scan reports claimScanCompleted=true (Issue #437)",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const calls: boolean[] = [];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      findNextIssue: () => Promise.resolve({ ok: true as const, value: null }),
      runIdleDecisionCensus: ({ claimScanCompleted }) => {
        calls.push(claimScanCompleted);
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;
    config.maxConcurrentIssues = 2;

    await runCoreLoop(config, deps);

    assertEquals(calls, [true]);
  },
);
