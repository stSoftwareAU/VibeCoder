/**
 * The scan loop's post-run callback dispatch (Issue #806, parent #796).
 *
 * Drives the real `runCoreLoop` through the injected deps and asserts what
 * the callback layer is handed: the outcome split, exactly-once per claim,
 * no callback for a skip, isolation between concurrent slots, and that a
 * callback fault never changes the run's own bookkeeping.
 *
 * A minimal RunCoreDeps mock is rebuilt locally, matching the convention in
 * the other run_core test files.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type DiscoveredIssue,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import type { TerminalIssueRun } from "../lib/run_callbacks.ts";

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

/** Collects every terminal run the loop reports to the callback layer. */
function recorder() {
  const runs: TerminalIssueRun[] = [];
  return {
    runs,
    runIssueCallbacks: (run: TerminalIssueRun) => {
      runs.push(run);
      return Promise.resolve();
    },
  };
}

function key(run: TerminalIssueRun): string {
  return `${run.repo}#${run.issueNumber}:${run.result}`;
}

async function runCycle(
  deps: RunCoreDeps,
  maxConcurrentIssues = 1,
): Promise<void> {
  await runCoreLoop(
    { ...createDefaultRunCoreConfig(), maxConcurrentIssues },
    deps,
  );
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

Deno.test("run_core callbacks - a successful run reports a success terminal run", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runCycle(deps);

  assertEquals(runs.map(key), ["o/a#1:success"]);
});

Deno.test("run_core callbacks - a failed run reports a failure terminal run", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({ ok: true, value: { success: false } });
    },
  });

  await runCycle(deps);

  assertEquals(runs.map(key), ["o/a#1:failure"]);
});

Deno.test("run_core callbacks - a skipped issue reports no terminal run", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({
        ok: true,
        value: { success: false, skipped: true },
      });
    },
  });

  await runCycle(deps);

  assertEquals(runs, []);
});

Deno.test("run_core callbacks - a claim reports exactly one terminal run", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runCycle(deps);

  assertEquals(runs.length, 1);
});

Deno.test("run_core callbacks - an exception after the claim takes the failure path once", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      throw new Error("the run exploded after the claim");
    },
  });

  // The pool owns the slot-level catch, so the thrown run is released and
  // reported there rather than escaping the cycle.
  await runCycle(deps, 2);

  assertEquals(runs.map(key), ["o/a#1:failure"]);
});

Deno.test("run_core callbacks - the terminal run carries the run's token telemetry", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({
        ok: true,
        value: {
          success: true,
          telemetry: {
            inputTokens: 10,
            outputTokens: 4,
            estimatedCostUsd: 0.5,
          },
        },
      });
    },
  });

  await runCycle(deps);

  assertEquals(runs[0]?.telemetry, {
    inputTokens: 10,
    outputTokens: 4,
    estimatedCostUsd: 0.5,
  });
});

Deno.test("run_core callbacks - the terminal run bounds the wall clock of the claim", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runCycle(deps);

  const run = runs[0]!;
  assert(
    run.finishedAtEpochMs > run.startedAtEpochMs,
    `expected the run to span time, got ${run.startedAtEpochMs}..${run.finishedAtEpochMs}`,
  );
});

Deno.test("run_core callbacks - a callback fault never changes the run's outcome", async () => {
  const time = clock();
  let successes = 0;
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks: () => Promise.reject(new Error("hook layer exploded")),
    recordRepoSuccess: () => {
      successes++;
      return Promise.resolve();
    },
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  // The loop completes and the success is still recorded.
  await runCycle(deps);

  assertEquals(successes, 1);
});

Deno.test("run_core callbacks - concurrent slots report isolated terminal runs", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const results: Record<string, boolean> = { "o/a": true, "o/b": false };
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1), issue("o/b", 2)]),
    processIssue: async (i) => {
      await new Promise((r) => setTimeout(r, 10));
      time.burnCycle();
      return { ok: true, value: { success: results[i.repo] ?? false } };
    },
  });

  await runCycle(deps, 2);

  assertEquals(
    new Set(runs.map(key)),
    new Set(["o/a#1:success", "o/b#2:failure"]),
  );
  assertEquals(runs.length, 2);
});

Deno.test("run_core callbacks - a deps wiring without the hook still runs the loop", async () => {
  const time = clock();
  let processed = 0;
  const deps = createMockDeps({
    ...time,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      processed++;
      time.burnCycle();
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runCycle(deps);

  assertEquals(processed, 1);
});

Deno.test("run_core callbacks - a throw after the run reported does not repeat the callbacks", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  let firstFailure = true;
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({ ok: true, value: { success: false } });
    },
    // Thrown *after* runSlotIssue released and reported the failed run, so
    // the slot catch reaches the dispatch a second time for the same claim.
    sleep: (ms?: number) => {
      if (firstFailure) {
        firstFailure = false;
        throw new Error("settle sleep exploded after the release");
      }
      return time.sleep(ms);
    },
  });

  await runCycle(deps, 2);

  assertEquals(runs.map(key), ["o/a#1:failure"]);
});

Deno.test("run_core callbacks - a serial-loop throw reports the failed run before it propagates", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      throw new Error("the serial run exploded after the claim");
    },
  });

  // One slot is the serial loop, which has no slot-level catch: its own
  // `catch` around processIssue is the only thing that reports the thrown
  // run before the throw unwinds to the cycle's fatal handler (Issue #796 —
  // a `main` sync merge deleted that catch twice, and no test held it).
  await runCycle(deps, 1);

  assertEquals(runs.map(key), ["o/a#1:failure"]);
});

Deno.test("run_core callbacks - the exit-threshold branch reports the failed run before unwinding", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({ ok: true, value: { success: false } });
    },
    // The failure threshold trips, so the serial loop returns before it
    // reaches the release that normally carries the dispatch.
    shouldExitOnFailures: () => Promise.resolve(true),
  });

  await runCycle(deps, 1);

  assertEquals(runs.map(key), ["o/a#1:failure"]);
});

Deno.test("run_core callbacks - a throw before the run starts reports nothing", async () => {
  const { runs, runIssueCallbacks } = recorder();
  const time = clock();
  const deps = createMockDeps({
    ...time,
    runIssueCallbacks,
    findNextIssue: issueQueue([issue("o/a", 1)]),
    // Thrown inside runSlotIssue *before* processIssue is entered: the
    // claim never ran, so it is an unclaimed cycle, not a failed run.
    setStatusWorking: () => {
      throw new Error("status write exploded before the run started");
    },
    processIssue: () => {
      time.burnCycle();
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runCycle(deps, 2);

  assertEquals(runs, []);
});
