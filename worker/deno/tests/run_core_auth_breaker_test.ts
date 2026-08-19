/**
 * Tests for the mid-cycle auth-outage breaker (Issue #4167).
 *
 * A transient account-level auth outage made every claude call fail in ~3 s;
 * the cycle-start health gate had already passed, so the claim loop churned
 * six claims in 16 minutes, each a billed Fable-tier run against a dead
 * credential. After two consecutive claim failures the loop now runs one
 * fresh auth probe and, on a dead credential, stops claiming with a single
 * ACTION REQUIRED line — the next cycle's health gate re-checks, so recovery
 * is automatic.
 *
 * Mock harness mirrors run_core_spend_guards_3648_test.ts.
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
// Issue #4167 — auth-outage breaker
// ---------------------------------------------------------------------------

function failingIssueDeps(
  overrides: Partial<RunCoreDeps>,
): { deps: RunCoreDeps; counters: { claims: number; probes: number } } {
  const counters = { claims: 0, probes: 0 };
  // The mock clock advances one sixth of the cycle per claim, so with no
  // breaker the deadline gate ends the loop after ~6 claims — the churn
  // shape from the live incident, bounded for the test.
  let now = 0;
  const perRunMs = (createDefaultRunCoreConfig().runDurationSeconds * 1000) /
    6;
  const deps = createMockDeps({
    now: () => now,
    findNextIssue: () =>
      Promise.resolve({
        ok: true,
        value: {
          repo: "o/r",
          issueNumber: counters.claims + 1,
          issueTitle: "always fails",
          milestoneTitle: "",
        },
      }),
    processIssue: () => {
      counters.claims++;
      now += perRunMs;
      return Promise.resolve({ ok: true, value: { success: false } });
    },
    ...overrides,
  });
  return { deps, counters };
}

Deno.test("auth breaker - a dead credential stops the claim churn after two failures (Issue #4167)", async () => {
  const errors: string[] = [];
  const { deps, counters } = failingIssueDeps({
    logError: (m) => errors.push(m),
  });
  deps.recheckAgentAuth = () => {
    counters.probes++;
    return Promise.resolve({
      authFailed: true,
      message: "claude requires login",
    });
  };

  await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assertEquals(
    counters.claims,
    2,
    "the third and later claims must never happen against a dead credential",
  );
  assertEquals(counters.probes, 1, "one probe decides");
  assert(
    errors.some((m) =>
      m.includes("ACTION REQUIRED") && m.includes("claude requires login")
    ),
    `the outage must be loud: ${errors.join(" | ")}`,
  );
});

Deno.test("auth breaker - a healthy probe leaves the failure loop unchanged (Issue #4167)", async () => {
  const { deps, counters } = failingIssueDeps({});
  deps.recheckAgentAuth = () => {
    counters.probes++;
    return Promise.resolve({ authFailed: false });
  };

  await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assert(
    counters.claims >= 5,
    `non-auth failures must keep the existing behaviour (claims: ${counters.claims})`,
  );
  assert(counters.probes >= 1, "the probe ran on the streak");
});

Deno.test("auth breaker - absent dep keeps the breaker inert (Issue #4167)", async () => {
  const { deps, counters } = failingIssueDeps({});
  delete deps.recheckAgentAuth;

  await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assert(
    counters.claims >= 5,
    `without the dep nothing changes (claims: ${counters.claims})`,
  );
});
