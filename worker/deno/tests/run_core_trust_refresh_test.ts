/**
 * Tests for the per-cycle trusted-author refresh gate (Issue #253).
 *
 * A failed `refreshTrustedAuthors` skips every trust-dependent pass —
 * claiming, comment-driven work, label-driven work, PR invitation and
 * the escape hatch — and logs the failure on every affected cycle. A
 * host wedged on refresh failures must not report itself healthy.
 *
 * Uses Australian English throughout (behaviour, authorised).
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

/** Advance `now` after `cycles` sleeps so a short run ends. */
function endAfterCycles(
  config: ReturnType<typeof createDefaultRunCoreConfig>,
  cycles: number,
): { now: () => number; sleep: () => Promise<void> } {
  let now = 0;
  let sleeps = 0;
  return {
    now: () => now,
    sleep: () => {
      sleeps++;
      if (sleeps >= cycles) now += config.runDurationSeconds * 1000;
      return Promise.resolve();
    },
  };
}

Deno.test(
  "Issue #253 - a failing refreshTrustedAuthors skips claiming and trust-dependent passes",
  async () => {
    const config = createDefaultRunCoreConfig();
    const clock = endAfterCycles(config, 1);
    let claims = 0;
    let feedback = 0;
    let planning = 0;
    let questions = 0;
    const errors: string[] = [];

    const result = await runCoreLoop(
      config,
      createMockDeps({
        ...clock,
        logError: (m) => errors.push(m),
        refreshTrustedAuthors: () =>
          Promise.resolve({
            ok: false,
            reason: "collaborator fetch 403",
          }),
        findNextIssue: () => {
          claims++;
          return Promise.resolve({ ok: true, value: null });
        },
        findAndProcessPrFeedback: () => {
          feedback++;
          return Promise.resolve({ ok: true, value: { processed: false } });
        },
        findAndProcessPlanning: () => {
          planning++;
          return Promise.resolve({ ok: true, value: { processed: false } });
        },
        findAndProcessQuestion: () => {
          questions++;
          return Promise.resolve({ ok: true, value: { processed: false } });
        },
      }),
    );

    assertEquals(claims, 0, "a failed refresh must not claim");
    assertEquals(feedback, 0, "PR-feedback is trust-dependent");
    assertEquals(planning, 0, "planning is trust-dependent");
    assertEquals(questions, 0, "question answering is trust-dependent");
    assertEquals(
      result.lastHealthCheckPassed,
      false,
      "a host wedged on trust-refresh failures must not report itself healthy",
    );
    assert(
      errors.some((m) =>
        m.includes("[TRUST_REFRESH]") && m.includes("collaborator fetch 403")
      ),
      `expected a loud [TRUST_REFRESH] error, got: ${errors.join(" | ")}`,
    );
  },
);

Deno.test(
  "Issue #253 - a successful refreshTrustedAuthors runs a normal cycle",
  async () => {
    const config = createDefaultRunCoreConfig();
    const clock = endAfterCycles(config, 1);
    let refreshes = 0;
    let claims = 0;
    let feedback = 0;

    await runCoreLoop(
      config,
      createMockDeps({
        ...clock,
        refreshTrustedAuthors: () => {
          refreshes++;
          return Promise.resolve({ ok: true });
        },
        findNextIssue: () => {
          claims++;
          return Promise.resolve({ ok: true, value: null });
        },
        findAndProcessPrFeedback: () => {
          feedback++;
          return Promise.resolve({ ok: true, value: { processed: false } });
        },
      }),
    );

    assertEquals(refreshes, 1);
    assert(claims >= 1, "a successful refresh must reach the claim scan");
    assert(feedback >= 1, "a successful refresh must run Priority 1");
  },
);

Deno.test(
  "Issue #253 - a refresh failure is logged on every affected cycle, not only the first",
  async () => {
    const config = createDefaultRunCoreConfig();
    const clock = endAfterCycles(config, 2);
    const errors: string[] = [];

    await runCoreLoop(
      config,
      createMockDeps({
        ...clock,
        logError: (m) => errors.push(m),
        refreshTrustedAuthors: () =>
          Promise.resolve({ ok: false, reason: "team fetch 404" }),
      }),
    );

    const refreshErrors = errors.filter((m) => m.includes("[TRUST_REFRESH]"));
    assertEquals(
      refreshErrors.length,
      2,
      `failure must be logged every cycle, got ${refreshErrors.length}: ${
        errors.join(" | ")
      }`,
    );
  },
);

Deno.test(
  "Issue #253 - a thrown refreshTrustedAuthors is fail-closed, not a crash",
  async () => {
    const config = createDefaultRunCoreConfig();
    const clock = endAfterCycles(config, 1);
    let claims = 0;
    const errors: string[] = [];

    const result = await runCoreLoop(
      config,
      createMockDeps({
        ...clock,
        logError: (m) => errors.push(m),
        refreshTrustedAuthors: () => {
          throw new Error("resolver exploded");
        },
        findNextIssue: () => {
          claims++;
          return Promise.resolve({ ok: true, value: null });
        },
      }),
    );

    assertEquals(claims, 0);
    assertEquals(result.lastHealthCheckPassed, false);
    assert(
      errors.some((m) =>
        m.includes("[TRUST_REFRESH]") && m.includes("resolver exploded")
      ),
      `expected the thrown reason in the error log, got: ${errors.join(" | ")}`,
    );
  },
);
