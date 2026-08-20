/**
 * Tests for the two Issue #3648 run-loop spend guards:
 *
 *   SEC-769865133420 — `runIssueScanLoop` had no view of the cycle deadline
 *     and its failure path `continue`d with no sleep, so a systematically
 *     failing repo could bill back-to-back runs past the planned shutdown.
 *   SEC-888ae4c269f9 — no cost/credit/spend ceiling existed anywhere; the
 *     credit log was append-only and never compared against a threshold.
 *
 * A minimal RunCoreDeps mock is rebuilt locally so the file is self-contained,
 * matching the convention in the other run_core test files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
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

// ---------------------------------------------------------------------------
// SEC-769865133420 — scan loop must honour the cycle deadline
// ---------------------------------------------------------------------------

Deno.test(
  "SEC-769865133420 - the scan loop stops claiming once the cycle deadline passes",
  async () => {
    const logs: string[] = [];
    let now = 0;
    let claims = 0;
    const config = createDefaultRunCoreConfig();
    // Each failed issue run consumes half the cycle, so the third claim would
    // start well past `endTime`.
    const perRunMs = (config.runDurationSeconds * 1000) / 2;

    const deps = createMockDeps({
      log: (m) => logs.push(m),
      now: () => now,
      sleep: () => Promise.resolve(),
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 1,
            issueTitle: "always fails",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        claims++;
        now += perRunMs;
        return Promise.resolve({ ok: true, value: { success: false } });
      },
    });

    await runCoreLoop(config, deps);

    assertEquals(
      claims,
      2,
      `the deadline must stop the loop after the cycle budget is spent, got ${claims} claims`,
    );
    assert(
      logs.some((m) => m.includes("cycle deadline")),
      `expected a deadline log line, got: ${logs.join(" | ")}`,
    );
  },
);

Deno.test(
  "SEC-769865133420 - the failure path backs off before the next claim",
  async () => {
    const sleeps: number[] = [];
    let now = 0;
    let claims = 0;
    const config = createDefaultRunCoreConfig();

    const deps = createMockDeps({
      now: () => now,
      sleep: (ms?: number) => {
        sleeps.push(ms ?? 0);
        return Promise.resolve();
      },
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 2,
            issueTitle: "fails",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        claims++;
        // Two failures, then stop the loop by exhausting the cycle.
        if (claims >= 2) now += config.runDurationSeconds * 1000;
        return Promise.resolve({ ok: true, value: { success: false } });
      },
    });

    await runCoreLoop(config, deps);

    assert(
      sleeps.includes(config.sleepInterval * 1000),
      `failure path must sleep the configured scan interval, saw: ${
        sleeps.join(", ")
      }`,
    );
  },
);

Deno.test(
  "SEC-769865133420 - a successful claim is unaffected by the back-off",
  async () => {
    const sleeps: number[] = [];
    let now = 0;
    let claims = 0;
    const config = createDefaultRunCoreConfig();

    const deps = createMockDeps({
      now: () => now,
      sleep: (ms?: number) => {
        sleeps.push(ms ?? 0);
        return Promise.resolve();
      },
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 3,
            issueTitle: "succeeds",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        claims++;
        now += config.runDurationSeconds * 1000;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
    });

    await runCoreLoop(config, deps);

    assertEquals(claims, 1);
  },
);

// ---------------------------------------------------------------------------
// SEC-888ae4c269f9 — the spend ceiling is a real stop signal
// ---------------------------------------------------------------------------

Deno.test(
  "SEC-888ae4c269f9 - an exceeded spend ceiling stops the cycle before any claim",
  async () => {
    const errors: string[] = [];
    let claims = 0;

    const deps = createMockDeps({
      logError: (m) => errors.push(m),
      checkSpendCeiling: () =>
        Promise.resolve({
          exceeded: true,
          message: "Daily spend ceiling reached: $80.00 against $50.00.",
        }),
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 4,
            issueTitle: "costly",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        claims++;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
    });

    const result = await runCoreLoop(createDefaultRunCoreConfig(), deps);

    assertEquals(claims, 0, "no work may be claimed once the ceiling is hit");
    assertEquals(result.exitReason, "Daily spend ceiling reached");
    assert(
      errors.some((m) => m.includes("[SPEND_CEILING]")),
      `expected a loud [SPEND_CEILING] error line, got: ${errors.join(" | ")}`,
    );
  },
);

Deno.test(
  "SEC-888ae4c269f9 - an unexceeded ceiling leaves the cycle running",
  async () => {
    let now = 0;
    let claims = 0;
    let ceilingChecks = 0;
    const config = createDefaultRunCoreConfig();

    const deps = createMockDeps({
      now: () => now,
      checkSpendCeiling: () => {
        ceilingChecks++;
        return Promise.resolve({ exceeded: false });
      },
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 5,
            issueTitle: "cheap",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        claims++;
        now += config.runDurationSeconds * 1000;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
    });

    const result = await runCoreLoop(config, deps);

    assertEquals(claims, 1);
    assert(ceilingChecks >= 1, "the ceiling must be checked each iteration");
    assertEquals(result.exitReason, "Run duration expired");
  },
);

Deno.test(
  "SEC-888ae4c269f9 - deps without a ceiling hook behave exactly as before",
  async () => {
    let now = 0;
    let claims = 0;
    const config = createDefaultRunCoreConfig();

    const deps = createMockDeps({
      now: () => now,
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 6,
            issueTitle: "unmetered",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        claims++;
        now += config.runDurationSeconds * 1000;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
    });

    const result = await runCoreLoop(config, deps);

    assertEquals(claims, 1);
    assertEquals(result.exitReason, "Run duration expired");
  },
);

// ---------------------------------------------------------------------------
// Issue #4304 — escalating re-claim cooldown and the minimum-runway floor
// ---------------------------------------------------------------------------

Deno.test(
  "Issue #4304 - a timeout-class failure passes its kind to recordIssueCooldown",
  async () => {
    let now = 0;
    const kinds: Array<string | undefined> = [];
    const config = createDefaultRunCoreConfig();
    const perRunMs = (config.runDurationSeconds * 1000) / 2;

    const deps = createMockDeps({
      now: () => now,
      sleep: () => Promise.resolve(),
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 4281,
            issueTitle: "always times out",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        now += perRunMs;
        return Promise.resolve({
          ok: true,
          value: { success: false, failureKind: "timeout" as const },
        });
      },
      recordIssueCooldown: (_repo, _issueNumber, failureKind) => {
        kinds.push(failureKind);
        return Promise.resolve();
      },
    });

    await runCoreLoop(config, deps);

    assert(kinds.length >= 1, "expected at least one cooldown record");
    assert(
      kinds.every((k) => k === "timeout"),
      `every failure was a timeout, got: ${JSON.stringify(kinds)}`,
    );
  },
);

Deno.test(
  "Issue #4304 - the minimum-runway floor stops claiming before the deadline",
  async () => {
    const logs: string[] = [];
    let now = 0;
    let claims = 0;
    const config = createDefaultRunCoreConfig();
    const cycleMs = config.runDurationSeconds * 1000;
    // Each run leaves 40% of the cycle: past halfway, under the huge floor.
    const perRunMs = cycleMs * 0.6;

    const deps = createMockDeps({
      log: (m) => logs.push(m),
      now: () => now,
      // The outer loop sleeps out the refused tail of the cycle — the mock
      // must advance the clock or the loop would spin forever.
      sleep: (ms?: number) => {
        now += ms ?? 30_000;
        return Promise.resolve();
      },
      // Floor bigger than the remaining 40%: the second claim is refused
      // even though the deadline itself has not passed.
      minClaimRunwaySeconds: config.runDurationSeconds * 0.5,
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 2,
            issueTitle: "long run",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        claims++;
        now += perRunMs;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
    });

    await runCoreLoop(config, deps);

    assertEquals(
      claims,
      1,
      `floor must refuse the second claim, got ${claims}`,
    );
    assert(
      logs.some((m) => m.includes("claim floor")),
      `expected a claim-floor log line, got: ${logs.join(" | ")}`,
    );
  },
);

Deno.test(
  "Issue #47 - the claim floor is raised to the full execute budget when the cycle fits one",
  async () => {
    const logs: string[] = [];
    let now = 0;
    let claims = 0;
    const config = createDefaultRunCoreConfig();
    const cycleMs = config.runDurationSeconds * 1000;
    // Each run leaves 35% of the cycle — above the plain 10% floor, but
    // below the 40%-of-cycle execute budget: only the #47 gate refuses it.
    const perRunMs = cycleMs * 0.65;

    const deps = createMockDeps({
      log: (m) => logs.push(m),
      now: () => now,
      sleep: (ms?: number) => {
        now += ms ?? 30_000;
        return Promise.resolve();
      },
      minClaimRunwaySeconds: config.runDurationSeconds * 0.1,
      fullExecuteBudgetSeconds: config.runDurationSeconds * 0.4,
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 3,
            issueTitle: "feature",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        claims++;
        now += perRunMs;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
    });

    await runCoreLoop(config, deps);

    assertEquals(
      claims,
      1,
      `the full-budget gate must refuse the second claim, got ${claims}`,
    );
    assert(
      logs.some((m) => m.includes("no longer fits this cycle (Issue #47)")),
      `expected the #47 refusal log line, got: ${logs.join(" | ")}`,
    );
  },
);

Deno.test(
  "Issue #47 - a cycle shorter than the budget keeps the plain floor and logs the exception",
  async () => {
    const logs: string[] = [];
    let now = 0;
    let claims = 0;
    const config = createDefaultRunCoreConfig();
    const cycleMs = config.runDurationSeconds * 1000;
    // Two half-cycle runs fit under the plain 10% floor; the budget being
    // twice the cycle must NOT refuse them — it is the documented exception.
    const perRunMs = cycleMs * 0.5;

    const deps = createMockDeps({
      log: (m) => logs.push(m),
      now: () => now,
      sleep: (ms?: number) => {
        now += ms ?? 30_000;
        return Promise.resolve();
      },
      minClaimRunwaySeconds: config.runDurationSeconds * 0.1,
      fullExecuteBudgetSeconds: config.runDurationSeconds * 2,
      findNextIssue: () =>
        Promise.resolve({
          ok: true,
          value: {
            repo: "o/r",
            issueNumber: 4,
            issueTitle: "small fix",
            milestoneTitle: "",
          },
        }),
      processIssue: () => {
        claims++;
        now += perRunMs;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
    });

    await runCoreLoop(config, deps);

    assert(
      claims >= 1,
      `claims must not be blocked outright on a short-cycle host, got ${claims}`,
    );
    assert(
      logs.some((m) => m.includes("can never offer")),
      `expected the documented-exception log line, got: ${logs.join(" | ")}`,
    );
  },
);
