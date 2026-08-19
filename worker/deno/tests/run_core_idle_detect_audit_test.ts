/**
 * Tests for the idle-detect audit hook in run_core.ts (Issue #2106).
 *
 * Proves that:
 *   1. On an idle pass (`foundClaimableIssue === false`), the loop
 *      invokes `runIdleDetectAudit` with a monotonic tick counter and
 *      the current `scanFoundClaimable` flag — before the existing
 *      `runIdleTaskFiler` hook fires, so its `[idle-detect] ...` lines
 *      precede the filer's `[idle-task] ...` lines in the worker log.
 *   2. On a busy pass (a Priority 2 issue was claimed and processed),
 *      `runIdleDetectAudit` is NOT invoked — the audit only runs when
 *      the gate is open.
 *   3. The tick counter increments across idle cycles.
 *   4. A throw from the audit hook is caught and logged so the main
 *      loop continues uninterrupted.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  AUDIT_DISAGREEMENT_SKIP_LIMIT,
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";

// ---------------------------------------------------------------------------
// Test helper — reuses the shape from run_core_idle_hooks_visibility_test.ts.
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
  "run_core - idle pass invokes runIdleDetectAudit before runIdleTaskFiler",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    const auditCalls: Array<{ tick: number; scanFoundClaimable: boolean }> = [];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      // Each hook emits its representative diagnostic line into the worker
      // log, mirroring what the real `runIdleDetectAudit` / `runIdleTaskFiler`
      // deps do — so the test can assert against the observable artefact.
      runIdleDetectAudit: ({ tick, scanFoundClaimable }) => {
        logs.push("[idle-detect] audit probe complete");
        auditCalls.push({ tick, scanFoundClaimable });
        return Promise.resolve();
      },
      runIdleTaskFiler: () => {
        logs.push("[idle-task] filing wrapper");
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(auditCalls.length, 1);
    assertEquals(auditCalls[0]!.tick, 1);
    assertEquals(auditCalls[0]!.scanFoundClaimable, false);
    // Observable contract: the audit's `[idle-detect] ...` diagnostic line
    // appears before the filer's `[idle-task] ...` line in the worker log, so
    // an operator reading the log sees audit diagnostics first. Asserting
    // against the captured log output (the observable artefact) rather than an
    // internal call-order array keeps the test robust to behaviour-preserving
    // refactors of the dispatch sequence.
    const auditLine = logs.findIndex((l) => l.includes("[idle-detect]"));
    const filerLine = logs.findIndex((l) => l.includes("[idle-task]"));
    assert(
      auditLine !== -1,
      "expected an [idle-detect] line in the worker log",
    );
    assert(filerLine !== -1, "expected an [idle-task] line in the worker log");
    assert(
      auditLine < filerLine,
      `expected audit log before filer log; got: ${logs.join("\n")}`,
    );
  },
);

Deno.test(
  "run_core - busy pass (claimable issue found) does NOT invoke runIdleDetectAudit",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    let findCalls = 0;
    let auditCalls = 0;

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
      runIdleDetectAudit: () => {
        auditCalls += 1;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(auditCalls, 0);
  },
);

Deno.test(
  "run_core - tick counter advances monotonically across consecutive idle cycles",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const ticks: number[] = [];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        // Advance the clock just enough each iteration so the inner
        // while keeps spinning. After 3 cycles, jump past endTime.
        nowValue += 100;
        if (cycleCount >= 3) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      runIdleDetectAudit: ({ tick }) => {
        ticks.push(tick);
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assert(ticks.length >= 3, `expected at least 3 ticks, got ${ticks.length}`);
    // Strictly increasing.
    for (let i = 1; i < ticks.length; i++) {
      assert(
        ticks[i]! > ticks[i - 1]!,
        `tick counter regressed: ${ticks.join(",")}`,
      );
    }
    assertEquals(ticks[0], 1);
  },
);

Deno.test(
  "run_core - filer is skipped when audit reports claimableTotal > 0 (budget guard)",
  async () => {
    // Mis-classification budget guard: when the independent audit probe
    // sees claimable work but the scan loop reports `foundClaimableIssue
    // = false`, the next iteration's GraphQL budget is more valuable
    // than filing yet another wrapper. Skipping the filer here is what
    // breaks the rate-limit-burning loop observed against FLEET-validation
    // #45-#48.
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    let filerRan = false;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      log: (m) => logs.push(m),
      runIdleDetectAudit: () => Promise.resolve({ claimableTotal: 4 }),
      runIdleTaskFiler: () => {
        filerRan = true;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(filerRan, false);
    const skipLine = logs.find((l) =>
      l.includes("[idle-hooks]") &&
      l.includes("skipping=idle-task-filer") &&
      l.includes("reason=audit_found_claimable") &&
      l.includes("claimable_total=4")
    );
    assert(
      skipLine !== undefined,
      `expected budget-guard skip line; got: ${logs.join("\n")}`,
    );
  },
);

Deno.test(
  "run_core - filer still runs when audit reports claimableTotal === 0",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    let filerRan = false;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      runIdleDetectAudit: () => Promise.resolve({ claimableTotal: 0 }),
      runIdleTaskFiler: () => {
        filerRan = true;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(filerRan, true);
  },
);

Deno.test(
  "run_core - persistent audit/scan disagreement eventually forces one filer attempt and emits a diagnostic (Issue #2475)",
  async () => {
    // Drive exactly AUDIT_DISAGREEMENT_SKIP_LIMIT + 1 idle cycles, each
    // with the probe reporting claimable work while the scan reports
    // none. The first LIMIT cycles must skip; the bound-exceeding cycle
    // must force a single filer attempt. Without the #2475 bound the
    // filer would be suppressed forever.
    const cycles = AUDIT_DISAGREEMENT_SKIP_LIMIT + 1;
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    let filerRuns = 0;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= cycles) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      log: (m) => logs.push(m),
      runIdleDetectAudit: () => Promise.resolve({ claimableTotal: 4 }),
      runIdleTaskFiler: () => {
        filerRuns += 1;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // Exactly one filer attempt across the whole run — the bound forced
    // it through once, no more.
    assertEquals(filerRuns, 1);

    // A disagreement diagnostic on every idle cycle.
    const diagnostics = logs.filter((l) =>
      l.includes("action=audit_scan_disagreement")
    );
    assertEquals(diagnostics.length, cycles);

    // The bound-exceeded forced-attempt line is present exactly once.
    const forced = logs.filter((l) =>
      l.includes("invoking=idle-task-filer") &&
      l.includes("reason=audit_disagreement_bound_exceeded")
    );
    assertEquals(forced.length, 1);
  },
);

Deno.test(
  "run_core - bounded short-circuit allows at most one filer attempt per disagreement run (no flooding) (Issue #2475)",
  async () => {
    // Over a full bound window the filer must fire at most once — the
    // remaining cycles stay skipped. This guards against re-introducing
    // the wrapper flooding the #2106 budget guard prevents.
    const cycles = AUDIT_DISAGREEMENT_SKIP_LIMIT + 1;
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    let filerRuns = 0;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= cycles) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      log: (m) => logs.push(m),
      runIdleDetectAudit: () => Promise.resolve({ claimableTotal: 4 }),
      runIdleTaskFiler: () => {
        filerRuns += 1;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // At most one attempt across the bound window.
    assertEquals(filerRuns, 1);

    // The remaining (LIMIT) cycles were skipped via the budget guard.
    const skips = logs.filter((l) =>
      l.includes("skipping=idle-task-filer") &&
      l.includes("reason=audit_found_claimable")
    );
    assertEquals(skips.length, AUDIT_DISAGREEMENT_SKIP_LIMIT);
  },
);

Deno.test(
  "run_core - disagreement streak resets after a forced attempt so a second window fires again (Issue #2475)",
  async () => {
    // Two full bound windows → exactly two forced attempts. Proves the
    // streak resets after each forced attempt rather than firing every
    // cycle thereafter.
    const cycles = (AUDIT_DISAGREEMENT_SKIP_LIMIT + 1) * 2;
    let cycleCount = 0;
    let nowValue = 0;
    let filerRuns = 0;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= cycles) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      runIdleDetectAudit: () => Promise.resolve({ claimableTotal: 4 }),
      runIdleTaskFiler: () => {
        filerRuns += 1;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(filerRuns, 2);
  },
);

Deno.test(
  "run_core - audit hook throwing does not abort the main loop; filer still runs",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    let filerRan = false;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      log: (m) => logs.push(m),
      runIdleDetectAudit: () => Promise.reject(new Error("probe blew up")),
      runIdleTaskFiler: () => {
        filerRan = true;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);
    assertEquals(result.plannedShutdown, true);
    assertEquals(filerRan, true);
    const failureLine = logs.find((l) =>
      l.includes("Idle-detect audit failed") && l.includes("probe blew up")
    );
    assert(
      failureLine !== undefined,
      `expected continuation log; got: ${logs.join("\n")}`,
    );
  },
);
