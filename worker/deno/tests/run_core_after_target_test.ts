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
  type RunCoreResult,
} from "../lib/run_core.ts";
import {
  DEFAULT_RUN_TARGET_SECONDS,
  resetRunTimelineForTests,
} from "../lib/run_timeline.ts";
import { fakeClock } from "./support/fake_clock.ts";

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
      1,
    );

    assertEquals(findCallsPastTarget, 0);
    assertEquals(processCalls, 0);
    // The refusal logs one line, and it names the claim that was deferred.
    const claimStops = logs.filter((line) =>
      line.includes("stopping before the next claim")
    );
    assertEquals(claimStops.length, 1);
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

/**
 * Run a serial scan where the scan finds nothing, so the idle hooks are
 * reached, and the clock passes the target before the Priority ladder. The
 * serial scan has no sibling slot, so the outer-cycle observer answers.
 *
 * @returns The filer and claim counts, and the refusal lines logged.
 */
async function runIdleFilerPastTarget(): Promise<{
  filerCalls: number;
  claimCalls: number;
  refusals: number;
}> {
  const clock: Clock = { now: START_MS };
  let filerCalls = 0;
  let claimCalls = 0;
  const { logs } = await runLoop(
    clock,
    {
      ...crossTargetBeforeLadder(clock),
      processIssue: () => {
        claimCalls++;
        return Promise.resolve({ ok: true, value: { success: true } });
      },
      runIdleTaskFiler: () => {
        filerCalls++;
        return Promise.resolve();
      },
    },
    1,
  );
  const refusals =
    logs.filter((line) => line.includes("reason=past_run_target")).length;
  return { filerCalls, claimCalls, refusals };
}

/**
 * The slot path, with a busy sibling. A slot with no sibling holding a claim
 * drains the pool instead of reaching its idle hooks (Issue #219), so the
 * fixture has slot s1 claim an issue before the target and park inside
 * processIssue. Slot s2 then scans, and the clock passes the target during that
 * scan: s2 finds nothing, reaches its idle hooks with s1 still holding its
 * claim, and is refused there.
 *
 * The cycle ends at the target (both come from `runDurationSeconds`), so after
 * its one refused observation s2 stops at the cycle deadline rather than
 * scanning again. The sibling is released on that re-scan wait, which is the
 * only point the idle slot reaches after the refusal.
 *
 * @returns The filer and claim counts, and the log lines written.
 */
async function runSlotIdleFilerPastTarget(): Promise<{
  filerCalls: number;
  claimCalls: number;
  logs: string[];
}> {
  const clock: Clock = { now: START_MS };
  let openBusy: () => void = () => {};
  const busy = new Promise<void>((resolve) => {
    openBusy = resolve;
  });
  let openStarted: () => void = () => {};
  const busyStarted = new Promise<void>((resolve) => {
    openStarted = resolve;
  });
  let claimable = true;
  let filerCalls = 0;
  let claimCalls = 0;
  const { logs } = await runLoop(clock, {
    findNextIssue: () => {
      if (claimable) {
        claimable = false;
        return Promise.resolve({ ok: true as const, value: CLAIMABLE_ISSUE });
      }
      // The idle slot scans only once its sibling is inside processIssue, and
      // the target passes during this scan.
      return busyStarted.then(() => {
        clock.now = PAST_TARGET_MS;
        return { ok: true as const, value: null };
      });
    },
    processIssue: () => {
      claimCalls++;
      openStarted();
      return busy.then(() => ({ ok: true as const, value: { success: true } }));
    },
    runIdleTaskFiler: () => {
      filerCalls++;
      return Promise.resolve();
    },
    sleep: () => {
      // The idle slot's re-scan wait, after its refusal: release the sibling.
      openBusy();
      return Promise.resolve();
    },
  }, 2);
  return { filerCalls, claimCalls, logs };
}

Deno.test(
  "run_core after target - the idle-task filer neither fires nor claims past the target, outer-cycle path (Issue #4243)",
  async () => {
    const { filerCalls, claimCalls, refusals } = await runIdleFilerPastTarget();

    assertEquals(claimCalls, 0);
    assertEquals(filerCalls, 0);
    // The refusal is logged once, so the gate was reached and not vacuous.
    assertEquals(refusals, 1);
  },
);

Deno.test(
  "run_core after target - the idle-task filer neither fires nor claims past the target, slot path (Issue #4243)",
  async () => {
    const { filerCalls, claimCalls, logs } = await runSlotIdleFilerPastTarget();

    // The one claim is the sibling's, begun before the target. The idle slot
    // never claims, and the filer never runs.
    assertEquals(claimCalls, 1);
    assertEquals(filerCalls, 0);
    // The slot's own refusal is prefixed `[sN] `, which only the slot path
    // adds; the outer-cycle observer logs with no prefix and is not counted.
    // Exactly one: the slot observes once, in the scan the target crosses, and
    // then stops at the cycle deadline, which is the target itself.
    const slotRefusals = logs.filter((line) =>
      /^\[s\d+\] \[idle-hooks\] skipping=idle-task-filer reason=past_run_target/
        .test(line)
    );
    assertEquals(slotRefusals.length, 1);
  },
);

/**
 * A run with live process, GitHub-claim and PID-lock services. Their state is
 * visible before shutdown and cleanup changes it, so completion proves more
 * than invoking a cleanup stub. The fake clock controls every cycle sleep.
 */
function startShutdownRun(
  progressed: boolean,
  livenessAt: number,
  overrides: Partial<RunCoreDeps> = {},
) {
  const clock = fakeClock(START_MS);
  const signals = new Map<string, () => void>();
  const processes = new Set([7319]);
  const claims = new Set(["owner/repo#1"]);
  let pidHeld = false;
  const logs: string[] = [];
  const errors: string[] = [];
  const atLiveness = Promise.withResolvers<void>();
  const continueCycle = Promise.withResolvers<void>();
  const sleepAdmitted = Promise.withResolvers<void>();
  let completed: { at: number; result: RunCoreResult } | undefined;
  const config = { ...createDefaultRunCoreConfig(), maxConcurrentIssues: 1 };
  const deps = createMockDeps({
    now: clock.now,
    sleep: (ms, signal) => {
      const sleeping = clock.sleep(ms ?? 30_000, signal);
      sleepAdmitted.resolve();
      return sleeping;
    },
    log: (message) => logs.push(message),
    logError: (message) => errors.push(message),
    loadAndValidateConfig: () => Promise.resolve({ ok: true, value: config }),
    findAndProcessPrFeedback: () =>
      Promise.resolve({ ok: true, value: { processed: progressed } }),
    addSignalListener: (signal, handler) => signals.set(signal, handler),
    removeSignalListener: (signal) => signals.delete(signal),
    claimPidFile: async () => {
      pidHeld = true;
    },
    terminateActiveAgentRuns: async () => {
      processes.clear();
    },
    cleanupInProgressIssue: async () => {
      claims.clear();
    },
    releasePidFile: async () => {
      pidHeld = false;
    },
    checkLivenessWindow: async () => {
      await clock.advance(livenessAt - clock.now());
      atLiveness.resolve();
      await continueCycle.promise;
    },
    ...overrides,
  });
  const run = runCoreLoop(config, deps).then((result) => {
    completed = { at: clock.now(), result };
    return result;
  });
  return {
    clock,
    logs,
    errors,
    ready: atLiveness.promise,
    resume: () => continueCycle.resolve(),
    signal: (name: "SIGTERM" | "SIGINT") => signals.get(name)!(),
    state: () => ({
      processes: [...processes],
      claims: [...claims],
      pidHeld,
    }),
    completion: () => completed,
    // Synchronisation only: a broken implementation may admit a sleep when it
    // should finish. Let either path reach an externally observable state.
    cycleSettledOrSleeping: () => Promise.race([run, sleepAdmitted.promise]),
    async dispose() {
      continueCycle.resolve();
      signals.get("SIGTERM")?.();
      // Release an uncancelled/overshooting sleep even after a failed assertion.
      await clock.advance(24 * 60 * 60 * 1000);
      await run;
      resetRunTimelineForTests();
    },
  };
}

const LIVE_SHUTDOWN_STATE = {
  processes: [7319],
  claims: ["owner/repo#1"],
  pidHeld: true,
};
const RELEASED_SHUTDOWN_STATE = { processes: [], claims: [], pidHeld: false };

/** Allow the immediate fake services' promise chains to settle without time passing. */
async function flushShutdownPromises(
  clock: ReturnType<typeof fakeClock>,
): Promise<void> {
  await clock.sleep(0);
}

function assertShutdownCompleted(
  fixture: ReturnType<typeof startShutdownRun>,
  at: number,
  signalled: boolean,
): void {
  const completed = fixture.completion();
  assertEquals(
    completed?.at,
    at,
    "the loop completes at the controlled instant",
  );
  assertEquals(
    completed?.result.exitReason,
    signalled ? "Shutdown signal received" : "Run duration expired",
  );
  assertEquals(completed?.result.plannedShutdown, true);
  assertEquals(completed?.result.fatalError, false);
  assertEquals(completed?.result.durationSeconds, (at - START_MS) / 1000);
  assertEquals(fixture.state(), RELEASED_SHUTDOWN_STATE);
  assertEquals(fixture.errors, []);
  assertEquals(
    fixture.logs.includes("Shutdown signal received. Exiting for refresh."),
    signalled,
  );
  assertEquals(
    fixture.logs.includes("Run duration complete. Exiting for refresh."),
    !signalled,
  );
}

for (const progressed of [false, true]) {
  for (const stop of ["target", "deadline", "shutdown", "running"] as const) {
    Deno.test(`run_core - final cycle does not delay shutdown for ${stop}, progress=${progressed} (Issue #5544)`, async () => {
      const at = stop === "target"
        ? TARGET_MS
        : stop === "deadline"
        ? START_MS + 3 * 60 * 60 * 1000
        : TARGET_MS - 1000;
      const fixture = startShutdownRun(progressed, at);
      try {
        await fixture.ready;
        assertEquals(fixture.state(), LIVE_SHUTDOWN_STATE);
        assertEquals(fixture.completion(), undefined);
        if (stop === "shutdown") fixture.signal("SIGTERM");
        fixture.resume();
        await fixture.cycleSettledOrSleeping();
        if (stop === "running") {
          await fixture.clock.advance(999);
          assertEquals(fixture.completion(), undefined);
          assertEquals(fixture.state(), LIVE_SHUTDOWN_STATE);
          await fixture.clock.advance(1);
          await flushShutdownPromises(fixture.clock);
        }
        assertShutdownCompleted(
          fixture,
          stop === "running" ? TARGET_MS : at,
          stop === "shutdown",
        );
      } finally {
        await fixture.dispose();
      }
    });
  }
}

for (const progressed of [false, true]) {
  Deno.test(`run_core - cycle sleep stops at the target, progress=${progressed} (Issue #5544)`, async () => {
    const fixture = startShutdownRun(progressed, TARGET_MS - 1);
    try {
      await fixture.ready;
      assertEquals(fixture.state(), LIVE_SHUTDOWN_STATE);
      fixture.resume();
      await fixture.cycleSettledOrSleeping();
      assertEquals(fixture.completion(), undefined);
      assertEquals(fixture.state(), LIVE_SHUTDOWN_STATE);
      await fixture.clock.advance(1);
      await flushShutdownPromises(fixture.clock);
      assertShutdownCompleted(fixture, TARGET_MS, false);
    } finally {
      await fixture.dispose();
    }
  });
}

for (const signalName of ["SIGTERM", "SIGINT"] as const) {
  Deno.test(`run_core - ${signalName} wakes an admitted cycle sleep (Issue #5544)`, async () => {
    const fixture = startShutdownRun(false, TARGET_MS - 1000);
    try {
      await fixture.ready;
      fixture.resume();
      await fixture.cycleSettledOrSleeping();
      await fixture.clock.advance(1);
      assertEquals(fixture.completion(), undefined);
      assertEquals(fixture.state(), LIVE_SHUTDOWN_STATE);
      fixture.signal(signalName);
      await flushShutdownPromises(fixture.clock);
      assertShutdownCompleted(fixture, TARGET_MS - 999, true);
    } finally {
      await fixture.dispose();
    }
  });
}

const cycleEndWaits = [
  { step: "callback", dep: "runCycleCallback", progressed: false },
  { step: "breaker_reset", dep: "circuitBreakerReset", progressed: true },
  {
    step: "breaker_record",
    dep: "circuitBreakerRecordZeroProgress",
    progressed: false,
  },
  {
    step: "breaker_interval",
    dep: "circuitBreakerGetSleepInterval",
    progressed: false,
  },
  { step: "quota_probe", dep: "readGraphqlQuota", progressed: true },
  { step: "summary", dep: "writeFleetTelemetrySummary", progressed: false },
] as const;

for (const { step, dep, progressed } of cycleEndWaits) {
  for (const signalled of [false, true]) {
    Deno.test(`run_core - pending ${step} is identifiable after liveness, shutdown=${signalled} (Issue #5544)`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      const overrides: Partial<RunCoreDeps> = dep === "readGraphqlQuota"
        ? {
          readGraphqlQuota: async () => {
            await wait();
            return { limit: 5000, remaining: 1353, reset: 1795512695 };
          },
        }
        : dep === "circuitBreakerGetSleepInterval"
        ? {
          circuitBreakerGetSleepInterval: async () => {
            await wait();
            return 30;
          },
        }
        : { [dep]: wait };
      const fixture = startShutdownRun(progressed, TARGET_MS, overrides);
      const phase = `[phase] cycle_end_${step}:`;
      try {
        await fixture.ready;
        fixture.resume();
        await entered.promise;
        assertEquals(fixture.state(), LIVE_SHUTDOWN_STATE);
        assertEquals(fixture.completion(), undefined);
        assertEquals(
          fixture.logs.filter((line) => line.startsWith(phase)),
          [`${phase} started`],
          "the pending main-loop operation is named before it settles",
        );
        if (signalled) fixture.signal("SIGTERM");
        release.resolve();
        await fixture.cycleSettledOrSleeping();
        assertShutdownCompleted(fixture, TARGET_MS, signalled);
        assertEquals(
          fixture.logs.filter((line) => line.startsWith(phase)),
          [`${phase} started`, `${phase} completed in 0s`],
        );
      } finally {
        release.resolve();
        await fixture.dispose();
      }
    });
  }
}

Deno.test("run_core - cycle callback fault remains reported and cleanup completes (Issue #5544)", async () => {
  const fixture = startShutdownRun(false, TARGET_MS, {
    runCycleCallback: () =>
      Promise.reject(new Error("hook context unavailable")),
  });
  try {
    await fixture.ready;
    fixture.resume();
    await fixture.cycleSettledOrSleeping();
    assertEquals(fixture.state(), RELEASED_SHUTDOWN_STATE);
    assertEquals(fixture.completion()?.result.fatalError, false);
    assertEquals(
      fixture.completion()?.result.exitReason,
      "Run duration expired",
    );
    assertEquals(fixture.errors, [
      "Cycle callback faulted: hook context unavailable. The scan cycle's own outcome is unchanged.",
    ]);
    assertEquals(
      fixture.logs.filter((line) =>
        line.startsWith("[phase] cycle_end_callback:")
      ),
      [
        "[phase] cycle_end_callback: started",
        "[phase] cycle_end_callback: completed in 0s",
      ],
    );
  } finally {
    await fixture.dispose();
  }
});

Deno.test("run_core - admitted sleep identifies its wait and settlement on shutdown (Issue #5544)", async () => {
  const fixture = startShutdownRun(false, TARGET_MS - 1000);
  try {
    await fixture.ready;
    fixture.resume();
    await fixture.cycleSettledOrSleeping();
    assertEquals(fixture.completion(), undefined);
    assertEquals(
      fixture.logs.filter((line) =>
        line.startsWith("[phase] cycle_end_sleep:")
      ),
      ["[phase] cycle_end_sleep: started"],
    );
    fixture.signal("SIGINT");
    await flushShutdownPromises(fixture.clock);
    assertShutdownCompleted(fixture, TARGET_MS - 1000, true);
    assertEquals(
      fixture.logs.filter((line) =>
        line.startsWith("[phase] cycle_end_sleep:")
      ),
      [
        "[phase] cycle_end_sleep: started",
        "[phase] cycle_end_sleep: completed in 0s",
      ],
    );
  } finally {
    await fixture.dispose();
  }
});
