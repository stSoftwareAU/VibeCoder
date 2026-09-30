/**
 * Tests for the shared-clone ref sweep dispatch entry and the host-disk
 * maintenance-lane pause (Issue #2889).
 *
 * A minimal RunCoreDeps mock is rebuilt locally, matching the convention in
 * the other run_core test files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildPriorityDispatchTable,
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreConfig,
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

function issue(repo: string, n: number): DiscoveredIssue {
  return { repo, issueNumber: n, issueTitle: `t${n}`, milestoneTitle: "" };
}

/** A queue of issues across distinct repos, honouring the exclusion set. */
function issueQueue(issues: DiscoveredIssue[]) {
  const pending = [...issues];
  return (options?: { excludeRepos?: ReadonlySet<string> }) => {
    const idx = pending.findIndex((i) => !options?.excludeRepos?.has(i.repo));
    if (idx < 0) return Promise.resolve({ ok: true as const, value: null });
    const [next] = pending.splice(idx, 1);
    return Promise.resolve({ ok: true as const, value: next! });
  };
}

/** Run one cycle: the loop ends when the clock passes the deadline. */
async function runOneCycle(
  deps: RunCoreDeps,
  maxConcurrentIssues: number,
  overrides: Partial<RunCoreConfig> = {},
) {
  const config = {
    ...createDefaultRunCoreConfig(),
    maxConcurrentIssues,
    ...overrides,
  };
  await runCoreLoop(config, deps);
}

// ============================================================================
// Dispatch table entry (Issue #2889)
// ============================================================================

Deno.test("dispatch table - Shared Clone Ref Sweep is maintenance-lane and calls the dep (Issue #2889)", async () => {
  let calls = 0;
  const table = buildPriorityDispatchTable(
    createMockDeps({
      sweepSharedCloneRefs: () => {
        calls++;
        return Promise.resolve({ ok: true, value: undefined });
      },
    }),
  );
  const handler = table.find((h) => h.name === "Shared Clone Ref Sweep");
  assert(handler, "the dispatch table must contain the sweep entry");
  assertEquals(handler?.maintenanceLane, true);
  assertEquals(handler?.agentBacked, undefined);

  const result = await handler!.execute();
  assertEquals(calls, 1, "executing the handler must call the dep");
  assertEquals(result, { ok: true, value: { processed: false } });
});

Deno.test("dispatch table - Shared Clone Ref Sweep with the dep absent still returns ok (Issue #2889)", async () => {
  const table = buildPriorityDispatchTable(createMockDeps());
  const handler = table.find((h) => h.name === "Shared Clone Ref Sweep");
  assert(handler, "the dispatch table must contain the sweep entry");

  const result = await handler!.execute();
  assertEquals(result, { ok: true, value: { processed: false } });
});

Deno.test("dispatch table - Shared Clone Ref Sweep propagates an error Result (Issue #2889)", async () => {
  const boom = new Error("sweep failed");
  const table = buildPriorityDispatchTable(
    createMockDeps({
      sweepSharedCloneRefs: () => Promise.resolve({ ok: false, error: boom }),
    }),
  );
  const handler = table.find((h) => h.name === "Shared Clone Ref Sweep");
  assert(handler, "the dispatch table must contain the sweep entry");

  const result = await handler!.execute();
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error, boom);
  }
});

// ============================================================================
// Maintenance-lane pause while the host disk is low (Issue #2889)
// ============================================================================

Deno.test("host disk low - maintenance-lane passes are paused; the existing HOST_DISK_LOW warning covers it (Issue #2889)", async () => {
  let now = 0;
  let syncCalls = 0;
  let sweepCalls = 0;
  const warnings: string[] = [];
  const deps = createMockDeps({
    now: () => now,
    logWarn: (m) => warnings.push(m),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1)]),
    checkHostDisk: () =>
      Promise.resolve({
        level: "low" as const,
        detail: "18.0 GB free — below the floor",
      }),
    // No reclaimDiskSpace: the reclaim never heals, so the lane pause holds.
    syncMilestoneBranches: () => {
      syncCalls++;
      return Promise.resolve({ ok: true, value: undefined });
    },
    sweepSharedCloneRefs: () => {
      sweepCalls++;
      return Promise.resolve({ ok: true, value: undefined });
    },
    processIssue: () => Promise.resolve({ ok: true, value: { success: true } }),
  });

  await runOneCycle(deps, 1);

  assertEquals(
    syncCalls,
    0,
    "a maintenance-lane handler must not run while the host disk is low",
  );
  assertEquals(
    sweepCalls,
    0,
    "the shared-clone ref sweep must not run while the host disk is low",
  );
  // No separate warn line per cycle: the one-time HOST_DISK_LOW warning
  // (asserted elsewhere in the host-disk tests) already says so, and it is
  // gated to fire once per episode, not once per pass or per cycle.
  assertEquals(
    warnings.filter((m) => m.startsWith("[HOST_DISK_LOW]")).length,
    1,
    "the low disk is reported once, not once per paused pass",
  );
  assert(
    warnings.some((m) => m.includes("pausing maintenance-lane passes")),
    warnings.join("\n"),
  );
});

Deno.test("host disk ok - maintenance-lane passes run normally (Issue #2889)", async () => {
  let now = 0;
  let syncCalls = 0;
  let sweepCalls = 0;
  const warnings: string[] = [];
  const deps = createMockDeps({
    now: () => now,
    logWarn: (m) => warnings.push(m),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1)]),
    checkHostDisk: () =>
      Promise.resolve({ level: "ok" as const, detail: "200 GB free" }),
    syncMilestoneBranches: () => {
      syncCalls++;
      return Promise.resolve({ ok: true, value: undefined });
    },
    sweepSharedCloneRefs: () => {
      sweepCalls++;
      return Promise.resolve({ ok: true, value: undefined });
    },
    processIssue: () => Promise.resolve({ ok: true, value: { success: true } }),
  });

  await runOneCycle(deps, 1);

  assert(syncCalls > 0, "the milestone sync must run when the disk is ok");
  assert(
    sweepCalls > 0,
    "the shared-clone ref sweep must run when the disk is ok",
  );
  assert(
    !warnings.some((m) => m.startsWith("[HOST_DISK_LOW]")),
    warnings.join("\n"),
  );
});
