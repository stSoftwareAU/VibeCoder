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
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import type { ProbedIssue } from "../lib/idle_detect_diagnostics.ts";

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

Deno.test(
  "run_core - the audit's live issue snapshot reaches the census (Issue #3897)",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const received: Array<
      Readonly<Record<string, readonly ProbedIssue[]>> | undefined
    > = [];
    const probed: ProbedIssue[] = [{
      number: 3871,
      labels: ["work-on"],
      assignees: ["stservice"],
      milestone: "#3861",
    }];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      runIdleDetectAudit: () =>
        Promise.resolve({
          claimableTotal: 0,
          issuesByRepo: { "stSoftwareAU/NEAT-AI": probed },
        }),
      runIdleDecisionCensus: ({ issuesByRepo }) => {
        received.push(issuesByRepo);
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(received.length, 1);
    // Same snapshot, not a same-shaped one read a minute later from a cache:
    // that timing gap is what held `inversion_signal=true` on NEAT-AI while
    // the scan was right.
    assertEquals(received[0], { "stSoftwareAU/NEAT-AI": probed });
  },
);

Deno.test(
  "run_core - an audit with no snapshot leaves the census on its own read (Issue #3897)",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const received: Array<
      Readonly<Record<string, readonly ProbedIssue[]>> | undefined
    > = [];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      // A worker built before #3897 — and every probe_error repo — returns
      // no snapshot. The census must still run, from the cache.
      runIdleDetectAudit: () => Promise.resolve({ claimableTotal: 0 }),
      runIdleDecisionCensus: ({ issuesByRepo }) => {
        received.push(issuesByRepo);
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(received.length, 1);
    assertEquals(received[0], undefined);
  },
);
