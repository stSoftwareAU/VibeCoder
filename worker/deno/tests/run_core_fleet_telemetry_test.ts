/**
 * Loop-integration tests for fleet telemetry (Issue #855).
 *
 * Proves that the main loop actually emits the numbers the issue asked
 * for — idle time attributed to the census's reason, blocked time split
 * between GitHub rate limits and model usage limits, and a success rate
 * broken down by failure class — rather than leaving them to a `grep`
 * over rotated logs.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

/** A clock that ends the run after the first end-of-cycle sleep. */
function oneCycleClock() {
  const clock = { nowValue: 0, sleeps: 0 };
  return {
    now: () => clock.nowValue,
    sleep: (ms?: number) => {
      clock.nowValue += ms ?? 0;
      clock.sleeps += 1;
      if (clock.sleeps >= 1) clock.nowValue += 4000 * 1000;
      return Promise.resolve();
    },
    state: clock,
  };
}

/** The last `fleet-summary:` line the loop logged. */
function lastFleetSummary(logs: readonly string[]): string {
  const summaries = logs.filter((line) => line.startsWith("fleet-summary:"));
  assert(summaries.length > 0, "expected at least one fleet-summary line");
  return summaries[summaries.length - 1] as string;
}

Deno.test(
  "run_core - an idle cycle books its idle seconds against the census reason",
  async () => {
    const logs: string[] = [];
    const clock = oneCycleClock();
    const deps = createMockDeps({
      now: clock.now,
      sleep: clock.sleep,
      log: (line: string) => logs.push(line),
      runIdleDecisionCensus: () =>
        Promise.resolve({
          inversionDetected: false,
          idleReason: "host_disk_low" as const,
        }),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    const summary = lastFleetSummary(logs);
    assertStringIncludes(summary, "idle_by_reason=host_disk_low=");
    assertStringIncludes(summary, "claims=0");
    assertStringIncludes(summary, "success_rate=n/a");
    assertStringIncludes(summary, "token_blocked=0s");
    assertStringIncludes(summary, "rate_limited=0s");
  },
);

Deno.test(
  "run_core - a served cycle records the claim, the success and its stream",
  async () => {
    const logs: string[] = [];
    const clock = oneCycleClock();
    let findCalls = 0;
    const deps = createMockDeps({
      now: clock.now,
      sleep: clock.sleep,
      log: (line: string) => logs.push(line),
      findNextIssue: () => {
        findCalls += 1;
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
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    const summary = lastFleetSummary(logs);
    assertStringIncludes(summary, "claims=1");
    assertStringIncludes(summary, "successes=1");
    assertStringIncludes(summary, "failures=0");
    assertStringIncludes(summary, "success_rate=1.00");
    assertStringIncludes(summary, "utilisation=serial=");
  },
);

Deno.test(
  "run_core - a failed run is counted against the phase it died at",
  async () => {
    const logs: string[] = [];
    const clock = oneCycleClock();
    let findCalls = 0;
    const deps = createMockDeps({
      now: clock.now,
      sleep: clock.sleep,
      log: (line: string) => logs.push(line),
      findNextIssue: () => {
        findCalls += 1;
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
        Promise.resolve({
          ok: true as const,
          value: { success: false, failurePhase: "execute" },
        }),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    const summary = lastFleetSummary(logs);
    assertStringIncludes(summary, "failures=1");
    assertStringIncludes(summary, "successes=0");
    assertStringIncludes(summary, "success_rate=0.00");
    assertStringIncludes(summary, "failures_by_class=execute=1");
  },
);

Deno.test(
  "run_core - a timeout failure is classed as timeout, not as its phase",
  async () => {
    const logs: string[] = [];
    const clock = oneCycleClock();
    let findCalls = 0;
    const deps = createMockDeps({
      now: clock.now,
      sleep: clock.sleep,
      log: (line: string) => logs.push(line),
      findNextIssue: () => {
        findCalls += 1;
        if (findCalls === 1) {
          return Promise.resolve({
            ok: true as const,
            value: {
              repo: "org/repo",
              issueNumber: 7,
              issueTitle: "An issue",
              milestoneTitle: "",
            },
          });
        }
        return Promise.resolve({ ok: true as const, value: null });
      },
      processIssue: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            success: false,
            failureKind: "timeout" as const,
            failurePhase: "execute",
          },
        }),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertStringIncludes(
      lastFleetSummary(logs),
      "failures_by_class=timeout=1",
    );
  },
);

Deno.test(
  "run_core - a GitHub rate-limit pause is recorded as rate-limited time",
  async () => {
    const logs: string[] = [];
    const clock = oneCycleClock();
    let active = true;
    const deps = createMockDeps({
      now: clock.now,
      sleep: clock.sleep,
      log: (line: string) => logs.push(line),
      isRateLimitActive: () => {
        const wasActive = active;
        active = false;
        return Promise.resolve(wasActive);
      },
      getRateLimitRemainingSeconds: () => Promise.resolve(120),
      getRateLimitBlockKind: () => Promise.resolve("github" as const),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 7200;

    await runCoreLoop(config, deps);

    const summary = lastFleetSummary(logs);
    assertStringIncludes(summary, "rate_limit_waits=1");
    assertStringIncludes(summary, "token_blocked=0s");
    assert(
      /rate_limited=[1-9]\d*s/.test(summary),
      `expected non-zero rate_limited seconds in: ${summary}`,
    );
  },
);

Deno.test(
  "run_core - a model usage-limit pause is recorded as token-blocked time",
  async () => {
    const logs: string[] = [];
    const clock = oneCycleClock();
    let active = true;
    const deps = createMockDeps({
      now: clock.now,
      sleep: clock.sleep,
      log: (line: string) => logs.push(line),
      isRateLimitActive: () => {
        const wasActive = active;
        active = false;
        return Promise.resolve(wasActive);
      },
      getRateLimitRemainingSeconds: () => Promise.resolve(120),
      getRateLimitBlockKind: () => Promise.resolve("usage" as const),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 7200;

    await runCoreLoop(config, deps);

    const summary = lastFleetSummary(logs);
    assertStringIncludes(summary, "token_blocked_waits=1");
    assertStringIncludes(summary, "rate_limited=0s");
    assert(
      /token_blocked=[1-9]\d*s/.test(summary),
      `expected non-zero token_blocked seconds in: ${summary}`,
    );
  },
);

Deno.test(
  "run_core - the fleet telemetry sidecar is written every cycle and at exit",
  async () => {
    const clock = oneCycleClock();
    let writes = 0;
    const deps = createMockDeps({
      now: clock.now,
      sleep: clock.sleep,
      writeFleetTelemetrySummary: () => {
        writes += 1;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(writes, 2);
  },
);

Deno.test(
  "run_core - a fatal error still emits the run's fleet summary and sidecar",
  async () => {
    const logs: string[] = [];
    const clock = oneCycleClock();
    let writes = 0;
    const deps = createMockDeps({
      now: clock.now,
      sleep: clock.sleep,
      log: (line: string) => logs.push(line),
      writeFleetTelemetrySummary: () => {
        writes += 1;
        return Promise.resolve();
      },
      // Thrown from inside the cycle, before any summary is emitted.
      findNextIssue: () => {
        throw new Error("the disk went away");
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // The numbers of a run that died are exactly the ones an operator
    // needs, so the summary must survive the abnormal exit.
    assertEquals(writes, 1);
    lastFleetSummary(logs);
  },
);

Deno.test(
  "run_core - a sidecar write failure is logged, never fatal",
  async () => {
    const logs: string[] = [];
    const clock = oneCycleClock();
    const deps = createMockDeps({
      now: clock.now,
      sleep: clock.sleep,
      log: (line: string) => logs.push(line),
      writeFleetTelemetrySummary: () => {
        throw new Error("disk gone");
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    assertEquals(result.plannedShutdown, true);
    assert(
      logs.some((line) =>
        line.includes("Fleet telemetry write failed") &&
        line.includes("disk gone")
      ),
      "expected the failed sidecar write to be reported in the log",
    );
  },
);
