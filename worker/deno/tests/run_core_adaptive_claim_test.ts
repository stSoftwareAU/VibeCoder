/**
 * Tests for the adaptive claim floor in the scan loop (Issue #245).
 *
 * The pure decision lives in `claim_runway_evidence.ts`; these drive the
 * wiring: an evidenced issue offered on a runway that cannot host a real
 * execute is deferred, the slot claims the *next* candidate instead of
 * parking (the #219 rule), and the deferral is logged once per cycle.
 *
 * A minimal RunCoreDeps mock is rebuilt locally so the file is self-contained,
 * matching the convention in the other run_core test files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import type { IssueClaimEvidence } from "../lib/claim_runway_evidence.ts";

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

function issue(repo: string, issueNumber: number): DiscoveredIssue {
  return {
    repo,
    issueNumber,
    issueTitle: `issue ${issueNumber}`,
    milestoneTitle: "",
  };
}

/**
 * The scan-loop scenario: the cycle is nearly over, the first candidate is a
 * known long job (#222), the second a fresh one-file fix (#9).
 *
 * The clock starts at 0 so `runCoreLoop` derives its deadline from the full
 * cycle, then jumps to the point where only `remainingSeconds` are left as
 * soon as the first scan runs. A claim consumes the rest of the cycle, which
 * is what ends the run.
 */
async function runScenario(options: {
  evidenceByIssue: Record<number, IssueClaimEvidence>;
  remainingSeconds: number;
  gatherFails?: boolean;
  maxConcurrentIssues?: number;
  /** Issue #375: consecutive cycles the floor has already deferred each issue. */
  deferredCycles?: Record<number, number>;
  adaptiveFloorStarvationLimit?: number;
  cleared?: string[];
}): Promise<{ claimed: number[]; logs: string[]; errors: string[] }> {
  const config = createDefaultRunCoreConfig();
  if (options.maxConcurrentIssues !== undefined) {
    config.maxConcurrentIssues = options.maxConcurrentIssues;
  }
  const cycleMs = config.runDurationSeconds * 1000;
  const scanStart = cycleMs - options.remainingSeconds * 1000;
  let now = 0;
  const claimed: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const queue = [issue("o/r", 222), issue("o/r", 9)];
  const done = new Set<number>();

  const deps = createMockDeps({
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
    now: () => now,
    executeBudgetSeconds: 3600,
    findNextIssue: (findOptions) => {
      now = Math.max(now, scanStart);
      const next = queue.find((candidate) =>
        !done.has(candidate.issueNumber) &&
        !findOptions?.excludeIssues?.has(
          `${candidate.repo}#${candidate.issueNumber}`,
        )
      );
      return Promise.resolve({ ok: true, value: next ?? null });
    },
    gatherIssueClaimEvidence: (candidate) =>
      options.gatherFails
        ? Promise.resolve({ evidence: {}, lookupError: "gh: rate limited" })
        : Promise.resolve({
          evidence: options.evidenceByIssue[candidate.issueNumber] ?? {},
        }),
    processIssue: (candidate) => {
      claimed.push(candidate.issueNumber);
      done.add(candidate.issueNumber);
      // The claim runs to the cycle deadline, so the run ends after it.
      now = cycleMs;
      return Promise.resolve({ ok: true, value: { success: true } });
    },
    sleep: () => Promise.resolve(),
    ...(options.deferredCycles
      ? {
        recordAdaptiveFloorDeferral: (key: string) => {
          const number = Number(key.split("#")[1]);
          const seen = (options.deferredCycles![number] ?? 0) + 1;
          options.deferredCycles![number] = seen;
          return Promise.resolve(seen);
        },
      }
      : {}),
    ...(options.cleared
      ? {
        clearAdaptiveFloorDeferral: (key: string) => {
          options.cleared!.push(key);
          return Promise.resolve();
        },
      }
      : {}),
    ...(options.adaptiveFloorStarvationLimit !== undefined
      ? { adaptiveFloorStarvationLimit: options.adaptiveFloorStarvationLimit }
      : {}),
  });

  await runCoreLoop(config, deps);
  return { claimed, logs, errors };
}

Deno.test("adaptive claim #245 - a long job on a doomed slice is skipped and the next candidate is claimed", async () => {
  const { claimed, logs } = await runScenario({
    evidenceByIssue: {
      222: { previousExecuteTimeout: true, longJobLabels: ["size/L"] },
    },
    remainingSeconds: 933,
  });

  assert(
    !claimed.includes(222),
    `#222 must not be claimed with 933s of runway, got ${claimed.join(", ")}`,
  );
  assert(
    claimed.includes(9),
    `the slot must move on to the fresh issue, got ${claimed.join(", ")}`,
  );
  const skip = logs.find((m) => m.includes("o/r#222"));
  assert(
    skip !== undefined,
    `expected a skip log line, got: ${logs.join(" | ")}`,
  );
  assertStringIncludes(skip!, "timed out in the execute phase");
  assertStringIncludes(skip!, "leaving it for the next cycle");
  assertEquals(
    logs.filter((m) => m.includes("o/r#222") && m.includes("adaptive floor"))
      .length,
    1,
    "the deferral must be logged once per cycle",
  );
});

Deno.test("adaptive claim #245 - a fresh issue with no evidence still claims late in the cycle", async () => {
  const { claimed } = await runScenario({
    evidenceByIssue: {},
    remainingSeconds: 933,
  });
  assertEquals(claimed[0], 222);
});

Deno.test("adaptive claim #245 - an evidenced issue claims once the runway can host an execute", async () => {
  const { claimed } = await runScenario({
    evidenceByIssue: {
      222: { preservedWip: true },
    },
    remainingSeconds: 3400,
  });
  assertEquals(claimed[0], 222);
});

Deno.test("adaptive claim #245 - a failed evidence lookup is logged and the claim proceeds", async () => {
  const { claimed, errors } = await runScenario({
    evidenceByIssue: {},
    remainingSeconds: 933,
    gatherFails: true,
  });
  assertEquals(claimed[0], 222);
  assert(
    errors.some((m) => m.includes("Claim-evidence lookup failed")),
    `expected the lookup failure to be logged, got: ${errors.join(" | ")}`,
  );
});

Deno.test("adaptive claim #245 - the pool defers and claims the next candidate too", async () => {
  const { claimed, logs } = await runScenario({
    evidenceByIssue: {
      222: { preservedWip: true },
    },
    remainingSeconds: 933,
    maxConcurrentIssues: 2,
  });

  assert(
    !claimed.includes(222),
    `#222 must not be claimed by a slot, got ${claimed.join(", ")}`,
  );
  assert(
    claimed.includes(9),
    `a slot must claim the fresh issue, got ${claimed.join(", ")}`,
  );
  assert(
    logs.some((m) => m.includes("[s1]") && m.includes("o/r#222")) ||
      logs.some((m) => m.includes("[s2]") && m.includes("o/r#222")),
    `expected a slot-prefixed skip line, got: ${logs.join(" | ")}`,
  );
});

Deno.test("adaptive floor #375 - an issue starved for the limit is claimed on the runway that is left", async () => {
  // The floor has already refused #222 on the two previous cycles; this is the
  // third. On a host whose cycle can never meet the floor, deferring again
  // strands it for ever — so the floor yields.
  const { claimed, logs } = await runScenario({
    evidenceByIssue: {
      222: { preservedWip: true, previousExecuteTimeout: true },
    },
    remainingSeconds: 933,
    deferredCycles: { 222: 2 },
  });

  assert(
    claimed.includes(222),
    `the starved issue must be claimed, got ${claimed.join(", ")}`,
  );
  const alert = logs.find((m) => m.includes("ALERT starvation"));
  assert(
    alert !== undefined,
    `expected the starvation alert, got: ${logs.join(" | ")}`,
  );
  assertStringIncludes(alert!, "issue=o/r#222");
  assertStringIncludes(alert!, "deferred_cycles=3");
  assertStringIncludes(alert!, "runway=933s");
});

Deno.test("adaptive floor #375 - below the limit the issue is still deferred, with the streak named", async () => {
  const { claimed, logs } = await runScenario({
    evidenceByIssue: {
      222: { preservedWip: true },
    },
    remainingSeconds: 933,
    deferredCycles: { 222: 0 },
  });

  assert(
    !claimed.includes(222),
    `#222 must still be deferred on its first cycle, got ${claimed.join(", ")}`,
  );
  assert(claimed.includes(9), "the slot must move on to the fresh issue");
  const skip = logs.find((m) => m.includes("o/r#222"));
  assert(skip !== undefined, `expected a skip line, got: ${logs.join(" | ")}`);
  assertStringIncludes(skip!, "leaving it for the next cycle");
  assertStringIncludes(skip!, "[deferred cycle 1 of 3]");
});

Deno.test("adaptive floor #375 - the limit is configurable and honoured", async () => {
  const { claimed } = await runScenario({
    evidenceByIssue: {
      222: { preservedWip: true },
    },
    remainingSeconds: 933,
    deferredCycles: { 222: 0 },
    adaptiveFloorStarvationLimit: 1,
  });
  assertEquals(claimed[0], 222, "a limit of 1 claims on the first deferral");
});

Deno.test("adaptive floor #375 - an issue the floor accepts has its streak cleared", async () => {
  const cleared: string[] = [];
  const { claimed } = await runScenario({
    evidenceByIssue: {
      222: { preservedWip: true },
    },
    remainingSeconds: 3400,
    deferredCycles: { 222: 2 },
    cleared,
  });
  assertEquals(claimed[0], 222);
  assert(
    cleared.includes("o/r#222"),
    `expected the streak to be cleared, got: ${cleared.join(", ")}`,
  );
});

Deno.test("adaptive floor #375 - with no streak tracking wired the floor defers as before", async () => {
  const { claimed, logs } = await runScenario({
    evidenceByIssue: {
      222: { preservedWip: true, previousExecuteTimeout: true },
    },
    remainingSeconds: 933,
  });
  assert(
    !claimed.includes(222),
    `without tracking the pre-#375 deferral stands, got ${claimed.join(", ")}`,
  );
  assert(
    !logs.some((m) => m.includes("ALERT starvation")),
    "no starvation alert without streak tracking",
  );
});

Deno.test("adaptive claim #245 - a scan that keeps re-offering a deferred issue stops the loop loudly", async () => {
  const config = createDefaultRunCoreConfig();
  const cycleMs = config.runDurationSeconds * 1000;
  const scanStart = cycleMs - 933 * 1000;
  let now = 0;
  let scans = 0;
  const errors: string[] = [];
  let claims = 0;

  const deps = createMockDeps({
    logError: (m) => errors.push(m),
    executeBudgetSeconds: 3600,
    now: () => now,
    // Ignores `excludeIssues` — the wiring fault this guard exists for. The
    // clock advances per scan so the cycle still ends.
    findNextIssue: () => {
      now = Math.max(now, scanStart) + (scans++ > 0 ? 60_000 : 0);
      return Promise.resolve({ ok: true, value: issue("o/r", 222) });
    },
    gatherIssueClaimEvidence: () =>
      Promise.resolve({ evidence: { preservedWip: true } }),
    processIssue: () => {
      claims++;
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runCoreLoop(config, deps);

  assertEquals(claims, 0, "a re-offered deferred issue must never be claimed");
  assert(
    errors.some((m) => m.includes("re-offered deferred issue")),
    `expected a loud stop, got: ${errors.join(" | ")}`,
  );
});
