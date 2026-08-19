/**
 * Tests for the idle-task filer hook in run_core.ts (Issue #2005).
 *
 * Proves that:
 *   (a) `runIdleTaskFiler` is invoked after a fully-idle scan pass,
 *   (b) it is NOT invoked when an issue was processed successfully
 *       (i.e. `tracker.scanHadSuccess === true`),
 *   (c) a throw from the hook does not abort the main loop — the error
 *       is logged and the loop continues to planned shutdown.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  AUDIT_DISAGREEMENT_SKIP_LIMIT,
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal RunCoreDeps factory for these tests. Mirrors the helper in
 * `run_core_test.ts` but is kept locally so a future change to that
 * helper cannot silently alter the contract under test here.
 */
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
  "run_core - idle pass invokes runIdleTaskFiler (Issue #2005)",
  async () => {
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        // After the first cycle's end-of-cycle sleep, advance the clock
        // past `endTime` so the loop exits cleanly.
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);
    // On a fully-idle cycle the filer hook must be invoked at least once.
    assertEquals(invocations >= 1, true);
  },
);

Deno.test(
  "run_core - successful issue cycle skips runIdleTaskFiler (Issue #2005)",
  async () => {
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    let findCalls = 0;
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
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
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);
    // A cycle that processed an issue is not idle — the filer stays silent.
    assertEquals(invocations, 0);
  },
);

Deno.test(
  "run_core - runIdleTaskFiler failure does not break main loop (Issue #2005)",
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
      runIdleTaskFiler: () =>
        Promise.reject(new Error("simulated filer crash")),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);
    // The loop must complete cleanly — the filer crash is logged but
    // does not abort the main loop.
    assertEquals(result.plannedShutdown, true);
    assertEquals(
      logs.some((m) =>
        m.includes("Idle-task filer failed") &&
        m.includes("simulated filer crash")
      ),
      true,
      "expected the filer crash to be logged",
    );
  },
);

// Note (Issue #2023): the legacy `runIdleSecurityScan` hook was removed.
// The framework-side `runIdleTaskFiler` is now the sole idle hook, so the
// "both hooks fire" and "scan-throw does not block filer" coexistence tests
// from PR #2005 are obsolete and have been deleted.

Deno.test(
  "run_core - Priority 1 processed work does not suppress filer when Priority 2 is empty (Issue #2048)",
  async () => {
    // Regression for Issue #2048: previously the filer was gated on the
    // broad `scanHadSuccess` flag, so any Priority 1–1.85 handler
    // returning `{ processed: true }` suppressed the filer even when
    // the Priority 2 scan found no claimable issue. The new gate is
    // `foundClaimableIssue`, set only from the Priority 2 success
    // path — so a busy PR-feedback handler must not stop idle-task
    // filing when there is genuinely nothing to claim.
    let invocations = 0;
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
      // Priority 1 (PR Feedback) processed work this cycle.
      findAndProcessPrFeedback: () =>
        Promise.resolve({ ok: true, value: { processed: true } }),
      // Priority 2 found no claimable issue.
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      invocations >= 1,
      true,
      "expected the filer to fire when Priority 2 found nothing, even though Priority 1 processed work",
    );

    // And the decision line must surface both flags: scanHadSuccess=true
    // (because Priority 1 ran), foundClaimableIssue=false (because no
    // issue was claimed) — proving the new gate is what fired the filer.
    const invokingLine = logs.find((m) =>
      m.includes("[idle-hooks]") &&
      m.includes("invoking=idle-task-filer") &&
      m.includes("foundClaimableIssue=false") &&
      m.includes("scanHadSuccess=true")
    );
    assertEquals(
      invokingLine !== undefined,
      true,
      `expected an [idle-hooks] invoking line with foundClaimableIssue=false scanHadSuccess=true; got: ${
        JSON.stringify(logs)
      }`,
    );
  },
);

Deno.test(
  "run_core - census inversion suppresses the idle-task filer (Issue #2813)",
  async () => {
    // The cache-backed idle-decision census reports that an open,
    // unblocked top-priority/work-on/low-priority issue exists somewhere
    // in the monitored set — even if it was only deferred this cycle by
    // nice/rotation/cooldown. The filer must be suppressed so an idle-task
    // is not filed while real work waits (the filing half of #2806).
    let invocations = 0;
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
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleDecisionCensus: () => Promise.resolve({ inversionDetected: true }),
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      invocations,
      0,
      "expected the filer to be suppressed when the census detects unblocked work",
    );
    const skipLine = logs.find((m) =>
      m.includes("[idle-hooks]") &&
      m.includes("skipping=idle-task-filer") &&
      m.includes("reason=unblocked_work_exists")
    );
    assertEquals(
      skipLine !== undefined,
      true,
      `expected an [idle-hooks] skip line with reason=unblocked_work_exists; got: ${
        JSON.stringify(logs)
      }`,
    );
  },
);

Deno.test(
  "run_core - persistent census inversion forces one filer attempt after the bound (Issue #3526)",
  async () => {
    // Regression for Issue #3526 (host-23 starvation incident): the census
    // counted PR-blocked issues as "unblocked work" and its inversion
    // verdict both suppressed the filer AND reset the #2475 disagreement
    // streak, so the bounded escape could never fire — the worker sat idle
    // for hours, neither claiming work nor filing idle-tasks. The census
    // branch must now participate in the streak: after
    // AUDIT_DISAGREEMENT_SKIP_LIMIT consecutive suppressed cycles, exactly
    // one filer attempt is forced through and the streak resets.
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const idleCycles = AUDIT_DISAGREEMENT_SKIP_LIMIT + 1;
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= idleCycles) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleDecisionCensus: () => Promise.resolve({ inversionDetected: true }),
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      invocations,
      1,
      `expected exactly one forced filer attempt after ${AUDIT_DISAGREEMENT_SKIP_LIMIT} suppressed cycles`,
    );
    const suppressed = logs.filter((m) =>
      m.includes("skipping=idle-task-filer") &&
      m.includes("reason=unblocked_work_exists")
    );
    assertEquals(
      suppressed.length,
      AUDIT_DISAGREEMENT_SKIP_LIMIT,
      "expected the first cycles within the bound to be suppressed",
    );
    const forced = logs.find((m) =>
      m.includes("invoking=idle-task-filer") &&
      m.includes("reason=census_inversion_bound_exceeded")
    );
    assertEquals(
      forced !== undefined,
      true,
      `expected an [idle-hooks] invoking line with reason=census_inversion_bound_exceeded; got: ${
        JSON.stringify(logs.filter((m) => m.includes("[idle-hooks]")))
      }`,
    );
  },
);

Deno.test(
  "run_core - census-inversion streak resets after the forced filer attempt (Issue #3526)",
  async () => {
    // After the bound forces a filer attempt the streak must reset, so the
    // next forced attempt only happens after another full bound of
    // suppressed cycles — wrapper flooding stays impossible.
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const idleCycles = (AUDIT_DISAGREEMENT_SKIP_LIMIT + 1) * 2;
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= idleCycles) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleDecisionCensus: () => Promise.resolve({ inversionDetected: true }),
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      invocations,
      2,
      "expected one forced attempt per full bound of suppressed cycles",
    );
  },
);

Deno.test(
  "run_core - census without inversion still files the idle-task (Issue #2813)",
  async () => {
    // Regression guard: when the census reports no inversion the filer must
    // still fire on a fully-idle cycle.
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleDecisionCensus: () =>
        Promise.resolve({ inversionDetected: false }),
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      invocations >= 1,
      true,
      "expected the filer to fire when the census reports no inversion",
    );
  },
);
