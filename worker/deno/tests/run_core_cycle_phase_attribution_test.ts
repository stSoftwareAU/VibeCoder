/**
 * Priority attribution for the cycle phases outside priority dispatch
 * (Issue #1587, parent #1571).
 *
 * `executePriorityHandler` and the issue-scan loop already enter a named
 * priority context, but the rest of the cycle did not: initialisation, the
 * post-scan auto-merge sweep, the post-run issue callbacks and the idle-work
 * hooks all issued `gh` calls that landed in `gh-calls:` and in no
 * `gh-calls-by-priority:` bucket at all. These tests drive the real
 * `runCoreLoop` with deps that record a `gh` call and assert the bucket the
 * call was credited to at the moment it was made.
 *
 * The snapshot is taken inside the stub because the loop resets the metrics
 * at the top of every iteration — initialisation's counts are cleared before
 * the first end-of-cycle summary is emitted.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import {
  getGhCallMetrics,
  recordGhCall,
  resetGhCallMetrics,
} from "../lib/gh_call_metrics.ts";

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

/** A clock that advances on every sleep so one cycle terminates. */
function clock(config = createDefaultRunCoreConfig()) {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    burnCycle: () => {
      now += config.runDurationSeconds * 400;
    },
  };
}

function issue(repo: string, n: number): DiscoveredIssue {
  return { repo, issueNumber: n, issueTitle: `t${n}`, milestoneTitle: "" };
}

/**
 * The end-of-cycle `gh-calls-by-priority:` line for a cycle that ran the
 * phase must name its bucket. A quiet cycle afterwards reports `none`, so
 * the assertion is over every summary the run emitted.
 */
function assertNamedInSummary(logs: string[], bucket: string): void {
  const summaries = logs.filter((l) => l.startsWith("gh-calls-by-priority:"));
  assert(summaries.length > 0, "expected a by-priority summary line");
  assert(
    summaries.some((l) => l.includes(`${bucket}=`)),
    `no summary named ${bucket}: ${summaries.join(" | ")}`,
  );
}

/**
 * A recorder for one phase: issues a `gh` call and snapshots the priority
 * buckets at that instant, before the next iteration clears them.
 */
function ghProbe() {
  const snapshots: Record<string, number>[] = [];
  return {
    snapshots,
    fire: () => {
      recordGhCall(["issue", "list", "--repo", "o/a"]);
      snapshots.push(getGhCallMetrics().byPriority);
    },
    /** Buckets credited at least one call across every snapshot taken. */
    credited: () => new Set(snapshots.flatMap((s) => Object.keys(s))),
  };
}

Deno.test("run_core phase attribution - initialisation credits its own bucket (Issue #1587)", async () => {
  resetGhCallMetrics();
  const probe = ghProbe();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    recoverStuckIssues: () => {
      probe.fire();
      time.burnCycle();
      return Promise.resolve();
    },
  });

  await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assertEquals([...probe.credited()], ["initialisation"]);
});

Deno.test("run_core phase attribution - the post-scan sweep credits its own bucket (Issue #1587)", async () => {
  resetGhCallMetrics();
  const probe = ghProbe();
  const time = clock();
  const logs: string[] = [];
  const deps = createMockDeps({
    ...time,
    log: (message: string) => logs.push(message),
    ensureAutoMerge: (options?: { refreshOpenPrs?: boolean }) => {
      // Only the post-scan sweep refreshes the open-PR list; the priority
      // 1.65 pass is dispatched and already carries its own attribution.
      if (options?.refreshOpenPrs) {
        probe.fire();
        time.burnCycle();
      }
      return Promise.resolve({ ok: true, value: undefined });
    },
    findNextIssue: (() => {
      let served = false;
      return () => {
        if (served) return Promise.resolve({ ok: true as const, value: null });
        served = true;
        return Promise.resolve({ ok: true as const, value: issue("o/a", 1) });
      };
    })(),
  });

  await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assertEquals([...probe.credited()], ["post-scan-auto-merge"]);
  assertNamedInSummary(logs, "post-scan-auto-merge");
});

Deno.test("run_core phase attribution - post-run issue callbacks credit their own bucket (Issue #1587)", async () => {
  resetGhCallMetrics();
  const probe = ghProbe();
  const time = clock();
  const logs: string[] = [];
  const deps = createMockDeps({
    ...time,
    log: (message: string) => logs.push(message),
    findNextIssue: (() => {
      let served = false;
      return () => {
        if (served) return Promise.resolve({ ok: true as const, value: null });
        served = true;
        return Promise.resolve({ ok: true as const, value: issue("o/a", 1) });
      };
    })(),
    runIssueCallbacks: () => {
      probe.fire();
      time.burnCycle();
      return Promise.resolve();
    },
  });

  await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assertEquals([...probe.credited()], ["issue-callbacks"]);
  assertNamedInSummary(logs, "issue-callbacks");
});

Deno.test("run_core phase attribution - the idle work hooks credit their own bucket (Issue #1587)", async () => {
  resetGhCallMetrics();
  const probe = ghProbe();
  const time = clock();
  const logs: string[] = [];
  const deps = createMockDeps({
    ...time,
    log: (message: string) => logs.push(message),
    runIdleDetectAudit: () => {
      probe.fire();
      time.burnCycle();
      return Promise.resolve();
    },
  });

  await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assertEquals([...probe.credited()], ["idle-work-hooks"]);
  assertNamedInSummary(logs, "idle-work-hooks");
});

Deno.test("run_core phase attribution - a dispatched handler keeps its own name (Issue #1587)", async () => {
  resetGhCallMetrics();
  const probe = ghProbe();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    checkMilestoneCompletions: () => {
      probe.fire();
      time.burnCycle();
      return Promise.resolve({ ok: true, value: undefined });
    },
  });

  await runCoreLoop(createDefaultRunCoreConfig(), deps);

  // Exactly one bucket: the dispatched handler's own, never a second name
  // added by a phase wrapper around it.
  assertEquals([...probe.credited()], ["milestone-completions"]);
});

/**
 * The outer-loop audit (Issue #1587) wrapped four further gh-issuing phases
 * that priority dispatch never covered. Each is driven through the real
 * loop and must credit its own bucket.
 */
const AUDITED_PHASES: {
  bucket: string;
  wire: (fire: () => void, burn: () => void) => Partial<RunCoreDeps>;
}[] = [
  {
    bucket: "trust-refresh",
    wire: (fire, burn) => ({
      refreshTrustedAuthors: () => {
        fire();
        burn();
        return Promise.resolve({ ok: true as const });
      },
    }),
  },
  {
    bucket: "fleet-pr-prefetch",
    wire: (fire, burn) => ({
      prefetchFleetOpenPrs: () => {
        fire();
        burn();
        return Promise.resolve();
      },
    }),
  },
  {
    bucket: "stale-assignment-recovery",
    wire: (fire, burn) => ({
      recoverStaleAssignments: () => {
        fire();
        burn();
        return Promise.resolve();
      },
    }),
  },
  {
    bucket: "github-auth-check",
    wire: (fire, burn) => ({
      checkGhAuth: () => {
        fire();
        burn();
        return Promise.resolve({ ok: true as const, value: { valid: true } });
      },
    }),
  },
  {
    bucket: "liveness-guard",
    wire: (fire, burn) => ({
      checkLivenessWindow: () => {
        fire();
        burn();
        return Promise.resolve();
      },
    }),
  },
];

for (const phase of AUDITED_PHASES) {
  Deno.test(
    `run_core phase attribution - ${phase.bucket} credits its own bucket (Issue #1587)`,
    async () => {
      resetGhCallMetrics();
      const probe = ghProbe();
      const time = clock();
      const deps = createMockDeps({
        ...time,
        ...phase.wire(probe.fire, time.burnCycle),
      });

      await runCoreLoop(createDefaultRunCoreConfig(), deps);

      assertEquals([...probe.credited()], [phase.bucket]);
    },
  );
}
