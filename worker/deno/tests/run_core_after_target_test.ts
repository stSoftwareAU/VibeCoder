/**
 * Tests that nothing new starts once the run's one-hour target has passed
 * (Issue #4243).
 *
 * Proves that, with an injected clock past the target:
 *   1. the Priority ladder refuses to dispatch the next handler, logs exactly
 *      one `stop reason=deadline` line naming it, and that handler never runs;
 *   2. when a ladder handler carries the clock past the target, that handler
 *      still completes and the ladder dispatches nothing after it;
 *   3. a handler already running when the target passes is not interrupted:
 *      it finishes normally, with no watchdog abandon;
 *   4. no slot takes a new claim past the target, with one slot (serial scan)
 *      and with two (pool), and a claim already running finishes;
 *   5. the idle-task filer neither fires nor claims an idle-task issue past
 *      the target.
 *
 * The clock is injected throughout: no real sleeps, no environment mutation,
 * and no fixed paths.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import {
  DEFAULT_RUN_TARGET_SECONDS,
  resetRunTimelineForTests,
} from "../lib/run_timeline.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal RunCoreDeps factory for these tests. Mirrors the helper in
 * `run_core_run_timeline_test.ts`, kept locally so a change to another
 * suite's helper cannot silently alter the contract under test here.
 */
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

/** Start of the simulated run: 2026-10-24T09:00:00Z, in epoch-ms. */
const START_MS = Date.UTC(2026, 9, 24, 9, 0, 0);

/** The target instant: start plus the default one hour. */
const TARGET_MS = START_MS + DEFAULT_RUN_TARGET_SECONDS * 1000;

/** A clock reading comfortably past the target, still before the finish. */
const PAST_TARGET_MS = TARGET_MS + 60 * 1000;

/** The injected clock. Tests move it forward; nothing sleeps for real. */
interface Clock {
  now: number;
}

/** The sinks a run writes to, captured for assertions. */
interface RunOutcome {
  logs: string[];
  errors: string[];
}

/**
 * Carry the clock past the target before the Priority ladder is reached.
 *
 * `isRateLimitActive` is read once per cycle ahead of the ladder. The
 * priority-0.9 entry is skipped on a normal cycle (`skipBelowPriority` is 1),
 * so no ladder handler runs before PR Feedback and this is the first point at
 * which a test can move the clock without a handler running.
 *
 * @param clock - The injected clock, moved past the target.
 * @returns The dependency override that does it.
 */
function crossTargetBeforeLadder(clock: Clock): Partial<RunCoreDeps> {
  return {
    isRateLimitActive: () => {
      clock.now = PAST_TARGET_MS;
      return Promise.resolve(false);
    },
  };
}

/**
 * Run the loop once from the clock's reading with the given dependency
 * overrides. The sleep moves the clock past the target, so the outer loop
 * ends after one cycle rather than spinning.
 *
 * @param clock - The injected clock, read and moved by the run.
 * @param overrides - Dependency overrides for this test.
 * @param maxConcurrentIssues - Slots: 1 is the serial scan, above 1 the pool.
 * @returns The log and error lines the run wrote.
 */
async function runLoop(
  clock: Clock,
  overrides: Partial<RunCoreDeps>,
  maxConcurrentIssues = 1,
): Promise<RunOutcome> {
  const logs: string[] = [];
  const errors: string[] = [];
  const config = { ...createDefaultRunCoreConfig(), maxConcurrentIssues };
  const deps = createMockDeps({
    now: () => clock.now,
    sleep: () => {
      clock.now = PAST_TARGET_MS;
      return Promise.resolve();
    },
    log: (message: string) => logs.push(message),
    logError: (message: string) => errors.push(message),
    loadAndValidateConfig: () => Promise.resolve({ ok: true, value: config }),
    ...overrides,
  });
  try {
    await runCoreLoop(config, deps);
  } finally {
    resetRunTimelineForTests();
  }
  return { logs, errors };
}

/** The exact ladder deadline line naming a handler. */
function ladderDeadlineLine(handlerName: string): string {
  return `stop reason=deadline — ${handlerName} and any after it defer to the next cycle.`;
}

/** Every line the run logged that ends a ladder deadline refusal. */
function ladderDeadlineLines(logs: string[]): string[] {
  return logs.filter((line) => line.includes("defer to the next cycle."));
}

/** A claimable issue, as the serial scan and the pool see one. */
const CLAIMABLE_ISSUE = {
  repo: "owner/repo",
  issueNumber: 1,
  issueTitle: "Claimable issue",
  milestoneTitle: "",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "run_core after target - a ladder handler reached past the target is never dispatched and one deadline line names it (Issue #4243)",
  async () => {
    const clock: Clock = { now: START_MS };
    let prFeedbackCalls = 0;
    const { logs } = await runLoop(clock, {
      ...crossTargetBeforeLadder(clock),
      findAndProcessPrFeedback: () => {
        prFeedbackCalls++;
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
    });

    assertEquals(prFeedbackCalls, 0);
    assertEquals(logs.includes("Priority 1: PR Feedback"), false);
    assertEquals(
      ladderDeadlineLines(logs),
      [ladderDeadlineLine("PR Feedback")],
    );
  },
);

Deno.test(
  "run_core after target - a crossing mid-ladder lets the running handler finish and dispatches nothing after it (Issue #4243)",
  async () => {
    const clock: Clock = { now: START_MS };
    let spellingCalls = 0;
    let ciFixCalls = 0;
    let updateBranchesCalls = 0;
    const { logs, errors } = await runLoop(clock, {
      findAndProcessSpellingFailure: () => {
        spellingCalls++;
        // The clock crosses the target while this handler is running.
        clock.now = PAST_TARGET_MS;
        return Promise.resolve({ ok: true, value: { processed: true } });
      },
      findAndProcessCiFailure: () => {
        ciFixCalls++;
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      updateOpenPrBranches: () => {
        updateBranchesCalls++;
        return Promise.resolve({ ok: true, value: undefined });
      },
    });

    // The early handler ran to completion and was dispatched once.
    assertEquals(spellingCalls, 1);
    assertEquals(logs.includes("Priority 1.5: Spelling Fix"), true);
    assertEquals(errors.some((line) => line.includes("abandoning")), false);
    // Nothing after it in the ladder was dispatched.
    assertEquals(ciFixCalls, 0);
    assertEquals(updateBranchesCalls, 0);
    assertEquals(logs.includes("Priority 1.55: CI Fix"), false);
    // Exactly one deadline line, naming the first undispatched handler.
    assertEquals(ladderDeadlineLines(logs), [ladderDeadlineLine("CI Fix")]);
  },
);

Deno.test(
  "run_core after target - a handler already running when the target passes is not interrupted (Issue #4243)",
  async () => {
    const clock: Clock = { now: START_MS };
    let prFeedbackCalls = 0;
    const terminateReasons: string[] = [];
    const { logs, errors } = await runLoop(clock, {
      findAndProcessPrFeedback: async () => {
        prFeedbackCalls++;
        // The target passes while this handler is mid-flight.
        clock.now = PAST_TARGET_MS;
        await Promise.resolve();
        await Promise.resolve();
        return { ok: true, value: { processed: true } };
      },
      terminateActiveAgentRuns: (reason: string) => {
        terminateReasons.push(reason);
        return Promise.resolve();
      },
    });

    // It finished normally: one call, and no watchdog abandon. The slow
    // notice (`slow: completed in ...`) is a log line, not an abandon, and
    // is allowed here because the clock jumped during the handler.
    assertEquals(prFeedbackCalls, 1);
    assertEquals(logs.some((line) => line.includes("abandoning")), false);
    assertEquals(errors.some((line) => line.includes("[watchdog]")), false);
    // The only terminate is the end-of-run call, never an abandon of the
    // running handler.
    const abandonTerminates = terminateReasons.filter((reason) =>
      reason !== "run ending"
    );
    assertEquals(abandonTerminates, []);
    // The ladder then refuses the next handler, once.
    assertEquals(
      ladderDeadlineLines(logs),
      [ladderDeadlineLine("Spelling Fix")],
    );
  },
);

Deno.test(
  "run_core after target - with one slot no new claim is taken past the target (Issue #4243)",
  async () => {
    const clock: Clock = { now: START_MS };
    let findCallsPastTarget = 0;
    let processCalls = 0;
    await runLoop(
      clock,
      {
        ...crossTargetBeforeLadder(clock),
        findNextIssue: () => {
          if (clock.now >= TARGET_MS) findCallsPastTarget++;
          return Promise.resolve({ ok: true, value: CLAIMABLE_ISSUE });
        },
        processIssue: () => {
          processCalls++;
          return Promise.resolve({ ok: true, value: { success: true } });
        },
      },
      1,
    );

    assertEquals(findCallsPastTarget, 0);
    assertEquals(processCalls, 0);
  },
);

Deno.test(
  "run_core after target - with two slots no new claim is taken and each slot stops once (Issue #4243)",
  async () => {
    const clock: Clock = { now: START_MS };
    let findCallsPastTarget = 0;
    let processCalls = 0;
    const { logs } = await runLoop(
      clock,
      {
        ...crossTargetBeforeLadder(clock),
        findNextIssue: () => {
          if (clock.now >= TARGET_MS) findCallsPastTarget++;
          return Promise.resolve({ ok: true, value: CLAIMABLE_ISSUE });
        },
        processIssue: () => {
          processCalls++;
          return Promise.resolve({ ok: true, value: { success: true } });
        },
      },
      2,
    );

    assertEquals(findCallsPastTarget, 0);
    assertEquals(processCalls, 0);
    // One slot-level stop line per slot.
    const slotStops = logs.filter((line) =>
      line.includes(
        "reached the cycle deadline; stopping before the next claim",
      )
    );
    assertEquals(slotStops.length, 2);
  },
);

Deno.test(
  "run_core after target - a claim already running when the target passes finishes and its slot takes no further claim (Issue #4243)",
  async () => {
    const clock: Clock = { now: START_MS };
    let processCalls = 0;
    let claimsAfterTarget = 0;
    let issueClaimed = false;
    const { errors } = await runLoop(
      clock,
      {
        findNextIssue: () => {
          if (clock.now >= TARGET_MS) {
            claimsAfterTarget++;
            return Promise.resolve({ ok: true, value: null });
          }
          if (issueClaimed) {
            return Promise.resolve({ ok: true, value: null });
          }
          issueClaimed = true;
          return Promise.resolve({ ok: true, value: CLAIMABLE_ISSUE });
        },
        processIssue: () => {
          processCalls++;
          // The target passes while this claim is running.
          clock.now = PAST_TARGET_MS;
          return Promise.resolve({ ok: true, value: { success: true } });
        },
      },
      2,
    );

    // The claim ran to completion, once, and no claim followed it.
    assertEquals(processCalls, 1);
    assertEquals(claimsAfterTarget, 0);
    assertEquals(errors.some((line) => line.includes("abandoning")), false);
  },
);

Deno.test(
  "run_core after target - the idle-task filer neither fires nor claims an idle-task issue past the target (Issue #4243)",
  async () => {
    const clock: Clock = { now: START_MS };
    let filerCalls = 0;
    let claimCalls = 0;
    await runLoop(clock, {
      ...crossTargetBeforeLadder(clock),
      // Nothing claimable, so the cycle reaches the idle hooks. A claim is
      // counted whatever its labels: `DiscoveredIssue` carries none, so no
      // narrower idle-task match is possible here.
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      processIssue: () => {
        claimCalls++;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
      runIdleTaskFiler: () => {
        filerCalls++;
        return Promise.resolve();
      },
    });

    assertEquals(claimCalls, 0);
    assertEquals(filerCalls, 0);
  },
);
