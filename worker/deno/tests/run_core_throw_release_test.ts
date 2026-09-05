/**
 * A `processIssue` that throws must release its claim (Issue #1222).
 *
 * The serial loop used to dispatch the failure callbacks and re-throw without
 * unassigning, so the issue sat assigned with a heartbeat that had already
 * stopped — parked until the 30-minute assigned-without-heartbeat recovery
 * noticed. Both work streams are covered here: the serial loop and the slot
 * pool, which owns its own throw path.
 *
 * A minimal RunCoreDeps mock is rebuilt locally, matching the convention in
 * the other run_core test files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import type { RunOutcome } from "../lib/run_outcome.ts";

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

/** A one-shot issue queue honouring the pool's exclusion set. */
function issueQueue(issues: DiscoveredIssue[]) {
  const pending = [...issues];
  return (options?: { excludeRepos?: ReadonlySet<string> }) => {
    const idx = pending.findIndex((i) => !options?.excludeRepos?.has(i.repo));
    if (idx < 0) return Promise.resolve({ ok: true as const, value: null });
    const [next] = pending.splice(idx, 1);
    return Promise.resolve({ ok: true as const, value: next! });
  };
}

/** Records every claim release the loop performs. */
function releases() {
  const seen: { repo: string; issueNumber: number; outcome?: RunOutcome }[] =
    [];
  return {
    seen,
    releaseClaim: (repo: string, issueNumber: number, outcome?: RunOutcome) => {
      seen.push({ repo, issueNumber, outcome });
      return Promise.resolve();
    },
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

Deno.test("run_core claim release - a serial-loop throw releases the claim before it propagates", async () => {
  const { seen, releaseClaim } = releases();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    releaseClaim,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      throw new Error("the serial run exploded after the claim");
    },
  });

  await runCoreLoop(
    { ...createDefaultRunCoreConfig(), maxConcurrentIssues: 1 },
    deps,
  );

  assertEquals(seen.map((r) => `${r.repo}#${r.issueNumber}`), ["o/a#1"]);
  // The release states what happened (Issue #4325), so the release comment
  // says the run died rather than going out blank.
  assertEquals(seen[0]?.outcome?.kind, "no_pr");
});

Deno.test("run_core claim release - a slot throw releases the claim", async () => {
  const { seen, releaseClaim } = releases();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    releaseClaim,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      throw new Error("the slot run exploded after the claim");
    },
  });

  await runCoreLoop(
    { ...createDefaultRunCoreConfig(), maxConcurrentIssues: 2 },
    deps,
  );

  assertEquals(seen.map((r) => `${r.repo}#${r.issueNumber}`), ["o/a#1"]);
  assertEquals(seen[0]?.outcome?.kind, "no_pr");
});
