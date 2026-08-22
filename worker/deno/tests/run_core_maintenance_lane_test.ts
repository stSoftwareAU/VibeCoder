/**
 * Tests for the concurrent maintenance lane in the dispatch loop (Issue #213).
 *
 * The regression: the agent-backed Priority-1.x passes ran serially ahead of
 * the Priority-2 pool, so a CI fix with a 30–60 minute agent budget held both
 * issue slots idle for up to half the cycle. These tests assert the observable
 * outcome — the pool starts while the CI fix is still running — rather than
 * the mechanism.
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
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { InFlightRepoRegistry } from "../lib/in_flight_repos.ts";
import { acquireMaintenanceRepoLease } from "../lib/maintenance_lane.ts";

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

/** Resolves after `ticks` macrotasks, so real interleaving is observable. */
function afterTicks(ticks: number): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < ticks; i++) {
    chain = chain.then(() => new Promise<void>((r) => setTimeout(r, 1)));
  }
  return chain;
}

Deno.test("dispatch table - the repo-clone agent passes are lane-eligible, the rest are not (Issue #213)", () => {
  const table = buildPriorityDispatchTable(createMockDeps());
  const lane = table.filter((h) => h.maintenanceLane === true).map((h) =>
    h.priority
  );
  // Exactly the passes whose wiring takes a repo lease before it checks out
  // `${WORK_DIR}/<repo>`: PR feedback, spelling, CI fix, merge conflict.
  assertEquals(lane, [1, 1.5, 1.55, 1.61]);

  // Planning and the other label-driven agents stay serial: they run from the
  // work-dir root with no repo lease, so they must not race a slot.
  const planning = table.find((h) => h.priority === 1.8);
  assertEquals(planning?.maintenanceLane, undefined);
});

Deno.test("maintenance lane - a slow CI fix no longer delays the pool (Issue #213)", async () => {
  // The pool must be able to make progress while the CI fix is mid-agent.
  // `processIssue` therefore waits (bounded) for the CI fix to start and then
  // records whether it was still running. Serially — the old behaviour — the
  // fix has already finished by the time any issue is claimed, so the flag
  // stays false.
  let signalCiFixStarted: () => void = () => {};
  const ciFixStarted = new Promise<void>((r) => {
    signalCiFixStarted = r;
  });
  let ciFixRunning = false;
  let poolRanDuringCiFix = false;
  let issuesClaimed = 0;
  let now = 0;
  const config = createDefaultRunCoreConfig();

  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    inFlightRepos: new InFlightRepoRegistry(),
    // The CI fix takes a long time — the whole point of the issue.
    findAndProcessCiFailure: async () => {
      ciFixRunning = true;
      signalCiFixStarted();
      await afterTicks(20);
      ciFixRunning = false;
      return { ok: true, value: { processed: true } };
    },
    findNextIssue: issueQueue([issue("o/a", 1), issue("o/b", 2)]),
    processIssue: async () => {
      issuesClaimed++;
      await Promise.race([ciFixStarted, afterTicks(40)]);
      if (ciFixRunning) poolRanDuringCiFix = true;
      await afterTicks(1);
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });

  await runCoreLoop({ ...config, maxConcurrentIssues: 2 }, deps);

  assert(issuesClaimed > 0, "the pool must have claimed at least one issue");
  assert(
    poolRanDuringCiFix,
    "issue work must run while the CI fix agent is still going",
  );
});

Deno.test("maintenance lane - the lane and a slot never work one repo at once (Issue #213)", async () => {
  // The safety invariant the lease exists for: every flow checks out into the
  // single `${WORK_DIR}/<repo>` clone, and `setupRepo` opens with
  // `reset --hard` + `clean -fd`. Two writers in one tree destroy each other.
  // Whoever reaches o/a first wins; the other must not run there concurrently.
  const registry = new InFlightRepoRegistry();
  const activeInRepo = new Set<string>();
  let overlapped = false;
  let laneWorkedInRepoA = false;
  let slotWorkedInRepoA = false;
  let now = 0;
  const config = createDefaultRunCoreConfig();

  const enter = (repo: string, who: string) => {
    if (activeInRepo.has(repo)) overlapped = true;
    activeInRepo.add(`${repo}`);
    if (repo === "o/a" && who === "lane") laneWorkedInRepoA = true;
    if (repo === "o/a" && who === "slot") slotWorkedInRepoA = true;
  };

  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    inFlightRepos: registry,
    // Exactly the production shape: lease the repo, then touch its clone.
    findAndProcessCiFailure: async () => {
      const lease = acquireMaintenanceRepoLease("o/a", 3804);
      if (lease === null) {
        return { ok: true as const, value: { processed: false } };
      }
      try {
        enter("o/a", "lane");
        await afterTicks(10);
        activeInRepo.delete("o/a");
        return { ok: true as const, value: { processed: true } };
      } finally {
        lease.release();
      }
    },
    // Only o/a has issues, so the pool competes for the very same clone.
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: async (i) => {
      enter(i.repo, "slot");
      await afterTicks(6);
      activeInRepo.delete(i.repo);
      now += config.runDurationSeconds * 1000;
      return { ok: true, value: { success: true } };
    },
  });

  await runCoreLoop({ ...config, maxConcurrentIssues: 2 }, deps);

  assert(
    laneWorkedInRepoA || slotWorkedInRepoA,
    "one of the two must have worked o/a, or the test proves nothing",
  );
  assertEquals(
    overlapped,
    false,
    "a maintenance pass and an issue slot must never hold one clone at once",
  );
});

Deno.test("maintenance lane - a maintenance pass defers when a slot already holds the repo (Issue #213)", async () => {
  const registry = new InFlightRepoRegistry();
  let ciFixRan = false;
  let leaseRefused = false;
  let now = 0;
  const config = createDefaultRunCoreConfig();

  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    inFlightRepos: registry,
    findAndProcessCiFailure: async () => {
      ciFixRan = true;
      // Give the slot time to take o/a first.
      await afterTicks(3);
      const lease = acquireMaintenanceRepoLease("o/a", 3804);
      if (lease === null) {
        leaseRefused = true;
        return { ok: true as const, value: { processed: false } };
      }
      lease.release();
      return { ok: true as const, value: { processed: true } };
    },
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: async () => {
      await afterTicks(10);
      now += config.runDurationSeconds * 1000;
      return { ok: true, value: { success: true } };
    },
  });

  await runCoreLoop({ ...config, maxConcurrentIssues: 2 }, deps);

  assert(ciFixRan, "the lane must still dispatch the CI-fix pass");
  assert(
    leaseRefused,
    "a repository an issue slot is working must be refused to the lane",
  );
});

Deno.test("maintenance lane - at max_concurrent_issues 1 every pass stays serial (Issue #213)", async () => {
  const order: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();

  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    inFlightRepos: new InFlightRepoRegistry(),
    findAndProcessCiFailure: async () => {
      order.push("ci-fix:start");
      await afterTicks(4);
      order.push("ci-fix:end");
      return { ok: true, value: { processed: true } };
    },
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: (i) => {
      order.push(`issue:${i.repo}`);
      now += config.runDurationSeconds * 1000;
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runCoreLoop({ ...config, maxConcurrentIssues: 1 }, deps);

  assert(
    order.indexOf("ci-fix:end") < order.indexOf("issue:o/a"),
    `the serial loop must be unchanged; order was ${order.join(" → ")}`,
  );
});

Deno.test("maintenance lane - the lane is disabled and reported when no registry is wired (Issue #213)", async () => {
  const errors: string[] = [];
  const order: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();

  const deps = createMockDeps({
    now: () => now,
    logError: (m: string) => errors.push(m),
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    // Deliberately no `inFlightRepos`.
    findAndProcessCiFailure: async () => {
      order.push("ci-fix:start");
      await afterTicks(4);
      order.push("ci-fix:end");
      return { ok: true, value: { processed: true } };
    },
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: (i) => {
      order.push(`issue:${i.repo}`);
      now += config.runDurationSeconds * 1000;
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runCoreLoop({ ...config, maxConcurrentIssues: 2 }, deps);

  // Fails loud rather than silently racing two writers on one clone.
  assert(
    errors.some((e) => e.includes("[maintenance-lane]")),
    `a disabled lane must be reported; errors were ${errors.join(" | ")}`,
  );
  assert(
    order.indexOf("ci-fix:end") < order.indexOf("issue:o/a"),
    `without a registry the pass must stay serial; order was ${
      order.join(" → ")
    }`,
  );
});
