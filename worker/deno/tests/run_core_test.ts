/**
 * Tests for run_core.ts — main event loop with priority dispatch.
 *
 * Issue #968: Part of the Deno worker orchestration migration (#918).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPriorityDispatchTable,
  createDefaultRunCoreConfig,
  createWorkProgressTracker,
  type RunCoreDeps,
  runCoreLoop,
  sleepWithJitter,
} from "../lib/run_core.ts";
import {
  recordRepoProbe,
  resetRepoAccessState,
} from "../lib/monitored_repo_access.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a mock RunCoreDeps for testing. */
function createMockDeps(overrides?: Partial<RunCoreDeps>): RunCoreDeps {
  const callLog: string[] = [];

  return {
    log: (_msg: string) => {},
    logError: (_msg: string) => {},
    logTiming: (_op: string, _dur: number) => {},
    logWorkerSummary: (_processed: number, _dur: number) => {},

    // PID management
    checkPidFile: () => Promise.resolve({ canProceed: true, message: "OK" }),
    claimPidFile: () => Promise.resolve(),
    releasePidFile: () => Promise.resolve(),

    // Initialisation
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

    // Health checks
    checkClaudeHealth: () =>
      Promise.resolve({ ok: true, value: { healthy: true } }),
    checkGhAuth: () => Promise.resolve({ ok: true, value: { valid: true } }),

    // Priority handlers
    findAndProcessPrFeedback: () => {
      callLog.push("pr-feedback");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessSpellingFailure: () => {
      callLog.push("spelling");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessCiFailure: () => {
      callLog.push("ci-failure");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    updateOpenPrBranches: () => {
      callLog.push("update-branches");
      return Promise.resolve({ ok: true, value: undefined });
    },
    nudgeStalledCi: () => {
      callLog.push("nudge-ci");
      return Promise.resolve({ ok: true, value: undefined });
    },
    ensureAutoMerge: () => {
      callLog.push("auto-merge");
      return Promise.resolve({ ok: true, value: undefined });
    },
    cleanupMergedBranches: () => {
      callLog.push("cleanup-merged");
      return Promise.resolve({ ok: true, value: undefined });
    },
    closeIssuesForMergedPrs: () => {
      callLog.push("close-issues");
      return Promise.resolve({ ok: true, value: undefined });
    },
    recoverAssignedWithClosedPr: () => {
      callLog.push("recover-assigned");
      return Promise.resolve({ ok: true, value: undefined });
    },
    syncMilestoneBranches: () => {
      callLog.push("milestone-sync");
      return Promise.resolve({ ok: true, value: undefined });
    },
    checkMilestoneCompletions: () => {
      callLog.push("milestones");
      return Promise.resolve({ ok: true, value: undefined });
    },
    findAndProcessRefinement: () => {
      callLog.push("refinement");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessGrillMe: () => {
      callLog.push("grill-me");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessQuestion: () => {
      callLog.push("question");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessPlanning: () => {
      callLog.push("planning");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },

    // Stale workflow detection (Priority 1.9)
    scanStaleWorkflowIssues: (_opts) => {
      callLog.push("stale-workflow");
      return Promise.resolve({ ok: true, value: undefined });
    },

    // Issue scanning (Priority 2)
    findNextIssue: () => Promise.resolve({ ok: true, value: null }),
    processIssue: () => Promise.resolve({ ok: true, value: { success: true } }),

    // Failure tracking
    trackFailure: () => Promise.resolve(),
    resetFailures: () => Promise.resolve(),
    shouldExitOnFailures: () => Promise.resolve(false),
    recordIssueCooldown: () => Promise.resolve(),

    // Circuit breaker
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

    // Repo failure tracking
    resetRepoFailures: () => Promise.resolve(),
    recordRepoFailure: () => Promise.resolve(),
    recordRepoSuccess: () => Promise.resolve(),

    // Crash handling
    sendCrashNotification: () => Promise.resolve(),
    clearHeartbeat: () => Promise.resolve(),
    cleanupInProgressIssue: () => Promise.resolve(),

    // Status
    setStatusIdle: () => Promise.resolve(),
    setStatusWorking: () => Promise.resolve(),
    setStatusSuccess: () => Promise.resolve(),
    setStatusFailure: () => Promise.resolve(),
    resetWindowTitle: () => {},

    // Signal handling
    addSignalListener: () => {},
    removeSignalListener: () => {},

    // Fault tolerance observability
    writeFaultToleranceSummary: () => Promise.resolve(),

    // Misc
    touchPidFile: () => Promise.resolve(),
    sleep: () => Promise.resolve(),
    now: () => Date.now(),

    // Issue #1935: private-repo-6 heartbeat — best-effort no-op by default.
    reportFleetHealthHeartbeat: () => Promise.resolve(),

    // Expose call log for testing
    _callLog: callLog,

    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — Configuration
// ---------------------------------------------------------------------------

Deno.test("run_core - createDefaultRunCoreConfig returns valid defaults", () => {
  const config = createDefaultRunCoreConfig();
  assertEquals(config.runDurationSeconds, 3600);
  assertEquals(config.sleepInterval, 30);
  assertEquals(typeof config.maxConsecutiveFailures, "number");
  assertEquals(config.maxConsecutiveFailures > 0, true);
});

// ---------------------------------------------------------------------------
// Tests — Priority dispatch table
// ---------------------------------------------------------------------------

Deno.test("run_core - buildPriorityDispatchTable returns all priorities in correct order", () => {
  const deps = createMockDeps();
  const table = buildPriorityDispatchTable(deps);

  // Must have at least 12 priority entries
  assertEquals(table.length >= 12, true);

  // Priorities must be in ascending order
  for (let i = 1; i < table.length; i++) {
    assertEquals(
      table[i]!.priority >= table[i - 1]!.priority,
      true,
      `Priority ${table[i]!.priority} should be >= ${table[i - 1]!.priority}`,
    );
  }

  // Verify key priorities exist
  const priorities = table.map((h) => h.priority);
  assertEquals(priorities.includes(1), true, "Must include Priority 1");
  assertEquals(priorities.includes(1.5), true, "Must include Priority 1.5");
  assertEquals(priorities.includes(1.55), true, "Must include Priority 1.55");
  assertEquals(priorities.includes(1.6), true, "Must include Priority 1.6");
  assertEquals(priorities.includes(2), true, "Must include Priority 2");
});

Deno.test("run_core - priority dispatch calls handlers in correct order", async () => {
  const callOrder: string[] = [];
  const deps = createMockDeps({
    findAndProcessPrFeedback: () => {
      callOrder.push("pr-feedback");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessSpellingFailure: () => {
      callOrder.push("spelling");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessCiFailure: () => {
      callOrder.push("ci-failure");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    updateOpenPrBranches: () => {
      callOrder.push("update-branches");
      return Promise.resolve({ ok: true, value: undefined });
    },
    nudgeStalledCi: () => {
      callOrder.push("nudge-ci");
      return Promise.resolve({ ok: true, value: undefined });
    },
    ensureAutoMerge: () => {
      callOrder.push("auto-merge");
      return Promise.resolve({ ok: true, value: undefined });
    },
    cleanupMergedBranches: () => {
      callOrder.push("cleanup-merged");
      return Promise.resolve({ ok: true, value: undefined });
    },
    closeIssuesForMergedPrs: () => {
      callOrder.push("close-issues");
      return Promise.resolve({ ok: true, value: undefined });
    },
    recoverAssignedWithClosedPr: () => {
      callOrder.push("recover-assigned");
      return Promise.resolve({ ok: true, value: undefined });
    },
    checkMilestoneCompletions: () => {
      callOrder.push("milestones");
      return Promise.resolve({ ok: true, value: undefined });
    },
    findAndProcessRefinement: () => {
      callOrder.push("refinement");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessGrillMe: () => {
      callOrder.push("grill-me");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessQuestion: () => {
      callOrder.push("question");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessPlanning: () => {
      callOrder.push("planning");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
  });

  const table = buildPriorityDispatchTable(deps);
  for (const handler of table) {
    if (handler.priority < 2) {
      await handler.execute();
    }
  }

  // Verify order: PR feedback < spelling < CI < branches < auto-merge ...
  // Branch cleanup runs once at initialisation, not per cycle.
  // Issue #1619: grill-me is dispatched between refinement and planning
  // so a freshly-grilled issue does not also enter planning the same pass.
  assertEquals(callOrder[0], "pr-feedback");
  assertEquals(callOrder[1], "spelling");
  assertEquals(callOrder[2], "ci-failure");
  assertEquals(callOrder[3], "update-branches");
  // Issue #2100: nudge-ci sits at priority 1.62 between update-branches
  // and auto-merge.
  assertEquals(callOrder[4], "nudge-ci");
  assertEquals(callOrder[5], "auto-merge");
  assertEquals(callOrder[6], "close-issues");
  assertEquals(callOrder[7], "recover-assigned");
  assertEquals(callOrder[8], "milestones");
  assertEquals(callOrder[9], "refinement");
  assertEquals(callOrder[10], "grill-me");
  assertEquals(callOrder[11], "planning");
  assertEquals(callOrder[12], "question");
});

// Issue #1619: explicit dispatch-order test for the grill-me wiring.
Deno.test("run_core - grill-me dispatched after refinement and before planning (Issue #1619)", () => {
  const deps = createMockDeps();
  const table = buildPriorityDispatchTable(deps);

  const refinementIdx = table.findIndex((h) => h.name === "Issue Refinement");
  const grillMeIdx = table.findIndex((h) =>
    h.name === "Grill-Me Clarification"
  );
  const planningIdx = table.findIndex((h) => h.name === "Planning Mode");
  const questionIdx = table.findIndex((h) => h.name === "Question Answering");

  assertEquals(refinementIdx >= 0, true, "Refinement handler must exist");
  assertEquals(grillMeIdx >= 0, true, "Grill-me handler must exist");
  assertEquals(planningIdx >= 0, true, "Planning handler must exist");
  assertEquals(questionIdx >= 0, true, "Question handler must exist");

  assertEquals(
    refinementIdx < grillMeIdx,
    true,
    "Grill-me must dispatch after refinement",
  );
  assertEquals(
    grillMeIdx < planningIdx,
    true,
    "Grill-me must dispatch before planning so a grilled issue is not also planned in the same pass",
  );
  assertEquals(
    planningIdx < questionIdx,
    true,
    "Planning must dispatch before question per Issue #1619 acceptance criteria",
  );
});

// ---------------------------------------------------------------------------
// Tests — Main loop
// ---------------------------------------------------------------------------

Deno.test("run_core - main loop terminates after duration expires", async () => {
  let nowValue = 1000000;
  const deps = createMockDeps({
    now: () => {
      // Advance time by 4000 seconds each call to exceed 1-hour duration
      const val = nowValue;
      nowValue += 4000 * 1000;
      return val;
    },
    sleep: () => Promise.resolve(),
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600; // 1 hour

  const result = await runCoreLoop(config, deps);
  assertEquals(result.plannedShutdown, true);
  assertEquals(typeof result.issuesProcessed, "number");
  assertEquals(typeof result.durationSeconds, "number");
});

Deno.test("run_core - main loop processes priority handlers each cycle", async () => {
  let cycleCount = 0;
  let nowValue = 0;
  const handlerCalls: string[] = [];

  const deps = createMockDeps({
    now: () => {
      const val = nowValue;
      return val;
    },
    sleep: () => {
      // After first cycle, advance time past duration
      cycleCount++;
      if (cycleCount >= 1) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
    findAndProcessPrFeedback: () => {
      handlerCalls.push("pr-feedback");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    findAndProcessSpellingFailure: () => {
      handlerCalls.push("spelling");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);
  assertEquals(handlerCalls.includes("pr-feedback"), true);
  assertEquals(handlerCalls.includes("spelling"), true);
});

// ---------------------------------------------------------------------------
// Tests — Rate limit detection
// ---------------------------------------------------------------------------

Deno.test("run_core - rate limit detection triggers backoff", async () => {
  let sleepCalls = 0;
  let nowValue = 0;

  const deps = createMockDeps({
    now: () => {
      const val = nowValue;
      return val;
    },
    isRateLimitActive: () => Promise.resolve(true),
    sleep: (_ms?: number) => {
      sleepCalls++;
      // First call should be rate-limit backoff, second ends the loop
      if (sleepCalls >= 1) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);
  // Should have slept at least once due to rate limit
  assertEquals(sleepCalls >= 1, true);
  assertEquals(result.plannedShutdown, true);
});

Deno.test(
  "run_core - preflight rate limit pauses until quota clears, then runs init (Issue #1780)",
  async () => {
    // The pre-flight reports rate-limited on the first call and healthy
    // on the second. The pause-and-resume loop must wait, re-check, see
    // the quota cleared, and proceed to init + priority dispatch.
    const callLog: string[] = [];
    let preflightCalls = 0;
    let nowValue = 0;
    const deps = createMockDeps({
      preflightGitHubRateLimit: () => {
        preflightCalls++;
        callLog.push("preflight");
        if (preflightCalls === 1) {
          return Promise.resolve({
            rateLimited: true,
            remainingSeconds: 60,
            message: "GraphQL quota low",
          });
        }
        return Promise.resolve({
          rateLimited: false,
          remainingSeconds: 0,
          message: "ok",
        });
      },
      gitResetToOrigin: () => {
        callLog.push("git-reset");
        return Promise.resolve({ ok: true, value: undefined });
      },
      findAndProcessPrFeedback: () => {
        callLog.push("pr-feedback");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      now: () => nowValue,
      sleep: (ms?: number) => {
        nowValue += ms ?? 30000;
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // Preflight fired at least twice (initial rate-limited, then re-check).
    assertEquals(preflightCalls >= 2, true);
    // After the wait, init and priority dispatch DO run.
    assertEquals(callLog.includes("git-reset"), true);
    assertEquals(callLog.includes("pr-feedback"), true);
  },
);

Deno.test("run_core - preflight healthy allows normal execution", async () => {
  const callLog: string[] = [];
  let nowValue = 0;
  const deps = createMockDeps({
    preflightGitHubRateLimit: () => {
      callLog.push("preflight");
      return Promise.resolve({
        rateLimited: false,
        remainingSeconds: 0,
        message: "ok",
      });
    },
    gitResetToOrigin: () => {
      callLog.push("git-reset");
      return Promise.resolve({ ok: true, value: undefined });
    },
    findAndProcessPrFeedback: () => {
      callLog.push("pr-feedback");
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    now: () => nowValue,
    sleep: () => {
      nowValue += 4000 * 1000;
      return Promise.resolve();
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  // Preflight should precede init and priority dispatch.
  const preflightIdx = callLog.indexOf("preflight");
  const gitResetIdx = callLog.indexOf("git-reset");
  const prFeedbackIdx = callLog.indexOf("pr-feedback");
  assertEquals(preflightIdx >= 0, true);
  assertEquals(gitResetIdx > preflightIdx, true);
  assertEquals(prFeedbackIdx > gitResetIdx, true);
});

// ---------------------------------------------------------------------------
// Tests — Circuit breaker
// ---------------------------------------------------------------------------

Deno.test("run_core - circuit breaker activates after zero-progress cycles", async () => {
  let zeroProgressRecorded = 0;
  let circuitBreakerSleepRequested = false;
  let nowValue = 0;
  let cycleCount = 0;

  const deps = createMockDeps({
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 2) {
        nowValue += 4000 * 1000; // End loop after 2 cycles
      }
      return Promise.resolve();
    },
    circuitBreakerRecordZeroProgress: () => {
      zeroProgressRecorded++;
      return Promise.resolve();
    },
    circuitBreakerGetSleepInterval: () => {
      circuitBreakerSleepRequested = true;
      return Promise.resolve(120); // Extended backoff
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  // Zero-progress should have been recorded at least once
  assertEquals(zeroProgressRecorded >= 1, true);
  assertEquals(circuitBreakerSleepRequested, true);
});

// ---------------------------------------------------------------------------
// Tests — Signal handling
// ---------------------------------------------------------------------------

Deno.test("run_core - signal handling setup registers listeners", async () => {
  const registeredSignals: string[] = [];

  let nowValue = 0;
  const deps = createMockDeps({
    addSignalListener: (signal: string) => {
      registeredSignals.push(signal);
    },
    now: () => {
      const val = nowValue;
      nowValue += 5000 * 1000;
      return val;
    },
    sleep: () => Promise.resolve(),
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 1;

  await runCoreLoop(config, deps);
  assertEquals(registeredSignals.includes("SIGTERM"), true);
  assertEquals(registeredSignals.includes("SIGINT"), true);
});

// ---------------------------------------------------------------------------
// Tests — Scan continuation after failure
// ---------------------------------------------------------------------------

Deno.test("run_core - scan continuation: after issue failure, tries next issue", async () => {
  let findCalls = 0;
  let processCalls = 0;
  let nowValue = 0;
  let cycleCount = 0;

  const deps = createMockDeps({
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
    findNextIssue: () => {
      findCalls++;
      if (findCalls <= 2) {
        return Promise.resolve({
          ok: true as const,
          value: {
            repo: "org/repo",
            issueNumber: findCalls,
            issueTitle: `Issue ${findCalls}`,
            milestoneTitle: "",
          },
        });
      }
      return Promise.resolve({ ok: true as const, value: null });
    },
    processIssue: () => {
      processCalls++;
      // First issue fails, second succeeds
      if (processCalls === 1) {
        return Promise.resolve({
          ok: true as const,
          value: { success: false },
        });
      }
      return Promise.resolve({ ok: true as const, value: { success: true } });
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  // Should have tried to find at least 2 issues (continuation after first failure)
  assertEquals(findCalls >= 2, true);
  assertEquals(processCalls >= 2, true);
});

// ---------------------------------------------------------------------------
// Tests — leaked-heartbeat sweep at the claim boundary (Issue #3760)
//
// A heartbeat interval leaked by a previous claim's processor keeps writing
// marker comments to that claim's repo. The scan loop must sweep such leaks
// before processing the next claim, so the leak is stopped (and logged by the
// production dep) rather than left firing against a reseeded allowlist.
// ---------------------------------------------------------------------------

Deno.test("run_core - sweeps leaked heartbeats before processing a claim (Issue #3760)", async () => {
  const order: string[] = [];
  let findCalls = 0;
  let nowValue = 1_000_000;
  let cycleCount = 0;

  const deps = createMockDeps({
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) nowValue += 4000 * 1000;
      return Promise.resolve();
    },
    findNextIssue: () => {
      findCalls++;
      if (findCalls === 1) {
        return Promise.resolve({
          ok: true as const,
          value: {
            repo: "org/repo",
            issueNumber: 3760,
            issueTitle: "Issue 3760",
            milestoneTitle: "",
          },
        });
      }
      return Promise.resolve({ ok: true as const, value: null });
    },
    processIssue: () => {
      order.push("process");
      return Promise.resolve({ ok: true as const, value: { success: true } });
    },
    sweepLeakedHeartbeats: () => {
      order.push("sweep");
      return Promise.resolve();
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;
  await runCoreLoop(config, deps);

  assertEquals(
    order[0],
    "sweep",
    "leaked heartbeats must be swept before the claim is processed",
  );
  assertEquals(
    order.includes("process"),
    true,
    "claim must still be processed",
  );
});

// ---------------------------------------------------------------------------
// Tests — claim-release on every scan-loop path (Issue #2670)
//
// Every path that releases a claim must unassign the worker, not just clear
// the heartbeat. Regression cover for incident #2648: the failure path used to
// call clearHeartbeat() only, leaving the issue permanently assigned.
// ---------------------------------------------------------------------------

/**
 * Drive a single-issue scan cycle with the given processIssue result and
 * capture which release helper the loop invoked.
 */
async function runSingleIssueScan(
  processValue: { success: boolean; skipped?: boolean },
  releaseClaim?: (repo: string, issueNumber: number) => Promise<void>,
): Promise<{ clearHeartbeatCalls: number }> {
  let findCalls = 0;
  let clearHeartbeatCalls = 0;
  let nowValue = 1_000_000;
  let cycleCount = 0;

  const deps = createMockDeps({
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) nowValue += 4000 * 1000;
      return Promise.resolve();
    },
    findNextIssue: () => {
      findCalls++;
      if (findCalls === 1) {
        return Promise.resolve({
          ok: true as const,
          value: {
            repo: "org/repo",
            issueNumber: 2648,
            issueTitle: "Issue 2648",
            milestoneTitle: "",
          },
        });
      }
      return Promise.resolve({ ok: true as const, value: null });
    },
    processIssue: () =>
      Promise.resolve({ ok: true as const, value: processValue }),
    clearHeartbeat: () => {
      clearHeartbeatCalls++;
      return Promise.resolve();
    },
    releaseClaim,
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;
  await runCoreLoop(config, deps);

  return { clearHeartbeatCalls };
}

Deno.test("run_core - failure path releases the claim (unassign + clear) — Issue #2648 regression", async () => {
  const released: Array<{ repo: string; issueNumber: number }> = [];
  await runSingleIssueScan(
    { success: false },
    (repo, issueNumber) => {
      released.push({ repo, issueNumber });
      return Promise.resolve();
    },
  );

  // The leak: the failure path must unassign the worker, not just clear the
  // heartbeat marker.
  assertEquals(
    released.length >= 1,
    true,
    "failure path must release the claim",
  );
  assertEquals(released[0], { repo: "org/repo", issueNumber: 2648 });
});

Deno.test("run_core - success path releases the claim (unassign + clear)", async () => {
  const released: Array<{ repo: string; issueNumber: number }> = [];
  await runSingleIssueScan(
    { success: true },
    (repo, issueNumber) => {
      released.push({ repo, issueNumber });
      return Promise.resolve();
    },
  );

  assertEquals(
    released.length >= 1,
    true,
    "success path must release the claim",
  );
  assertEquals(released[0], { repo: "org/repo", issueNumber: 2648 });
});

Deno.test("run_core - skip-after-claim path releases the claim", async () => {
  const released: Array<{ repo: string; issueNumber: number }> = [];
  await runSingleIssueScan(
    { success: false, skipped: true },
    (repo, issueNumber) => {
      released.push({ repo, issueNumber });
      return Promise.resolve();
    },
  );

  assertEquals(released.length >= 1, true, "skip path must release the claim");
  assertEquals(released[0], { repo: "org/repo", issueNumber: 2648 });
});

Deno.test("run_core - a skip is cooled down and not counted as a processed issue (Issue #175)", async () => {
  // The merged-PR pre-check bounce arrives here as a skip. It must record the
  // retry cooldown (so neither slot re-claims the same issue on the next
  // scan) and must NOT reach WORKER_SUMMARY's processed count or failure
  // tracking — reporting it as a success is what livelocked the pool.
  const cooldowns: Array<{ repo: string; issueNumber: number }> = [];
  const failures: string[] = [];
  const summaries: number[] = [];
  let findCalls = 0;
  let nowValue = 1_000_000;
  let cycleCount = 0;

  const deps = createMockDeps({
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) nowValue += 4000 * 1000;
      return Promise.resolve();
    },
    findNextIssue: () => {
      findCalls++;
      if (findCalls === 1) {
        return Promise.resolve({
          ok: true as const,
          value: {
            repo: "org/repo",
            issueNumber: 4173,
            issueTitle: "Feed completion signal",
            milestoneTitle: "",
          },
        });
      }
      return Promise.resolve({ ok: true as const, value: null });
    },
    processIssue: () =>
      Promise.resolve({
        ok: true as const,
        value: { success: false, skipped: true },
      }),
    recordIssueCooldown: (repo: string, issueNumber: number) => {
      cooldowns.push({ repo, issueNumber });
      return Promise.resolve();
    },
    trackFailure: (key: string) => {
      failures.push(key);
      return Promise.resolve();
    },
    logWorkerSummary: (processed: number) => {
      summaries.push(processed);
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;
  const result = await runCoreLoop(config, deps);

  assertEquals(cooldowns, [{ repo: "org/repo", issueNumber: 4173 }]);
  assertEquals(failures, []);
  assertEquals(result.issuesProcessed, 0);
  assertEquals(summaries.every((n) => n === 0), true);
});

Deno.test("run_core - falls back to clearHeartbeat when releaseClaim dep is absent", async () => {
  // Backwards compatibility: deps that predate releaseClaim still clear the
  // heartbeat on the failure path.
  const { clearHeartbeatCalls } = await runSingleIssueScan(
    { success: false },
    undefined,
  );
  assertEquals(clearHeartbeatCalls >= 1, true);
});

// ---------------------------------------------------------------------------
// Note (Issue #2023): the in-process idle-driven security-scan trigger has
// been retired. The framework-side `runIdleTaskFiler` is now the sole
// idle hook — its tests live in `run_core_idle_task_filer_test.ts`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests — Work progress tracker
// ---------------------------------------------------------------------------

Deno.test("run_core - createWorkProgressTracker tracks issue counts", () => {
  const tracker = createWorkProgressTracker();
  assertEquals(tracker.issuesProcessed, 0);

  tracker.recordSuccess();
  assertEquals(tracker.issuesProcessed, 1);

  tracker.recordSuccess();
  assertEquals(tracker.issuesProcessed, 2);
});

Deno.test("run_core - createWorkProgressTracker tracks scan success", () => {
  const tracker = createWorkProgressTracker();
  assertEquals(tracker.scanHadSuccess, false);

  tracker.recordSuccess();
  assertEquals(tracker.scanHadSuccess, true);

  tracker.resetScanProgress();
  assertEquals(tracker.scanHadSuccess, false);
});

Deno.test(
  "run_core - createWorkProgressTracker tracks foundClaimableIssue (Issue #2048)",
  () => {
    const tracker = createWorkProgressTracker();
    assertEquals(tracker.foundClaimableIssue, false);

    // Only the Priority 2 success path (`recordSuccess`) flips the
    // narrow flag used to gate the idle-task filer.
    tracker.recordSuccess();
    assertEquals(tracker.foundClaimableIssue, true);
    assertEquals(tracker.scanHadSuccess, true);

    tracker.resetScanProgress();
    assertEquals(tracker.foundClaimableIssue, false);
    assertEquals(tracker.scanHadSuccess, false);
  },
);

// ---------------------------------------------------------------------------
// Tests — Sleep with jitter
// ---------------------------------------------------------------------------

Deno.test("run_core - sleepWithJitter produces value within expected range", () => {
  // Jitter should be ±25% of base
  for (let i = 0; i < 20; i++) {
    const jittered = sleepWithJitter(100);
    assertEquals(jittered >= 75, true, `Jittered ${jittered} should be >= 75`);
    assertEquals(
      jittered <= 125,
      true,
      `Jittered ${jittered} should be <= 125`,
    );
  }
});

Deno.test("run_core - sleepWithJitter handles zero base", () => {
  const jittered = sleepWithJitter(0);
  assertEquals(jittered, 0);
});

// ---------------------------------------------------------------------------
// Tests — Consecutive failure exit
// ---------------------------------------------------------------------------

Deno.test("run_core - consecutive failures trigger exit", async () => {
  const nowValue = 0;
  let findCalls = 0;
  let exitTriggered = false;

  const deps = createMockDeps({
    now: () => nowValue,
    sleep: () => Promise.resolve(),
    findNextIssue: () => {
      findCalls++;
      return Promise.resolve({
        ok: true as const,
        value: {
          repo: "org/repo",
          issueNumber: findCalls,
          issueTitle: `Issue ${findCalls}`,
          milestoneTitle: "",
        },
      });
    },
    processIssue: () =>
      Promise.resolve({ ok: true as const, value: { success: false } }),
    shouldExitOnFailures: () => {
      exitTriggered = true;
      return Promise.resolve(true); // Signal exit threshold
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);

  assertEquals(exitTriggered, true);
  assertEquals(result.exitedOnFailures, true);
});

// ---------------------------------------------------------------------------
// Tests — Initialisation
// ---------------------------------------------------------------------------

Deno.test("run_core - PID file conflict prevents start", async () => {
  const deps = createMockDeps({
    checkPidFile: () =>
      Promise.resolve({
        canProceed: false,
        message: "Another instance running",
      }),
  });

  const config = createDefaultRunCoreConfig();
  const result = await runCoreLoop(config, deps);

  assertEquals(result.plannedShutdown, true);
  assertEquals(result.skippedDueToPidLock, true);
});

Deno.test("run_core - git reset failure prevents start", async () => {
  const deps = createMockDeps({
    gitResetToOrigin: () =>
      Promise.resolve({ ok: false, error: new Error("git fetch failed") }),
  });

  const config = createDefaultRunCoreConfig();
  const result = await runCoreLoop(config, deps);

  assertEquals(result.plannedShutdown, false);
  assertStringIncludes(result.exitReason, "git");
});

Deno.test("run_core - dependency check failure prevents start", async () => {
  const deps = createMockDeps({
    checkDependencies: () =>
      Promise.resolve({ ok: false, error: new Error("gh not found") }),
  });

  const config = createDefaultRunCoreConfig();
  const result = await runCoreLoop(config, deps);

  assertEquals(result.plannedShutdown, false);
  assertStringIncludes(result.exitReason, "dependenc");
});

// ---------------------------------------------------------------------------
// Tests — Graceful rate-limit exit (Issue #1523)
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - primary rate limit in main loop pauses then resumes (Issues #1523, #1780)",
  async () => {
    // Issue #1523 made primary rate-limit errors a graceful exit (no
    // crash notification). Issue #1780 takes the next step: the inner
    // catch waits for the quota to refresh and re-enters the main loop
    // instead of returning early. The legacy guarantees still hold:
    //   - no crash notification fires for primary rate-limit errors;
    //   - no "Fatal error" log line is emitted;
    // and one new guarantee:
    //   - after the wait succeeds, the inner while is re-entered.
    let crashNotifications = 0;
    const logLines: string[] = [];
    const errorLines: string[] = [];
    let nowValue = 0;
    let findNextIssueCalls = 0;

    const deps = createMockDeps({
      log: (msg: string) => logLines.push(msg),
      logError: (msg: string) => errorLines.push(msg),
      findNextIssue: () => {
        findNextIssueCalls++;
        if (findNextIssueCalls === 1) {
          // First scan throws the primary rate-limit message that used
          // to exit the worker (worker-37068.log trigger).
          throw new Error(
            "gh command failed (exit 1): GraphQL: API rate limit already exceeded for user ID 23146043.",
          );
        }
        // Subsequent scans return cleanly so the loop exits normally
        // on the run-duration cap.
        return Promise.resolve({ ok: true, value: null });
      },
      sendCrashNotification: () => {
        crashNotifications++;
        return Promise.resolve();
      },
      now: () => nowValue,
      // Advance the virtual clock during sleeps so the wait helper
      // makes progress and eventually the run-duration cap fires.
      sleep: (ms?: number) => {
        nowValue += ms ?? 30000;
        return Promise.resolve();
      },
      // Reset is 60s in the (deps-clock) future — well inside the
      // 3600s run duration so the wait completes normally.
      getRateLimitReset: () => Promise.resolve(60),
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    // Crash-notification path must not fire on primary rate-limit.
    assertEquals(crashNotifications, 0);
    const hasFatalLog = errorLines.some((l) =>
      l.includes("Fatal error in main loop")
    );
    assertEquals(
      hasFatalLog,
      false,
      `unexpected fatal log: ${errorLines.join(" | ")}`,
    );

    // The inner catch must have logged the pause.
    const hasPauseLog = logLines.some((l) =>
      l.includes("Primary rate limit hit mid-cycle")
    );
    assertEquals(
      hasPauseLog,
      true,
      `expected pause log, got: ${logLines.join(" | ")}`,
    );

    // After the wait, the loop must have resumed and called findNextIssue
    // again (so it ran more than once before duration expired).
    assertEquals(
      findNextIssueCalls >= 2,
      true,
      `expected resume after pause, findNextIssueCalls=${findNextIssueCalls}`,
    );

    // Exit reason should be the planned run-duration end, not a fatal
    // path or rate-limit early-exit.
    assertStringIncludes(result.exitReason, "Run duration expired");
  },
);

Deno.test("run_core - non-rate-limit errors still hit fatal path", async () => {
  let crashNotifications = 0;
  const errorLines: string[] = [];
  let nowValue = 0;

  const deps = createMockDeps({
    logError: (msg: string) => errorLines.push(msg),
    findNextIssue: () => {
      throw new Error("unexpected panic: segfault in native code");
    },
    sendCrashNotification: () => {
      crashNotifications++;
      return Promise.resolve();
    },
    now: () => nowValue,
    sleep: () => {
      nowValue += 4000 * 1000;
      return Promise.resolve();
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);

  // Non-rate-limit errors must still go through the fatal path.
  assertEquals(crashNotifications, 1);
  const hasFatalLog = errorLines.some((l) =>
    l.includes("Fatal error in main loop")
  );
  assertEquals(hasFatalLog, true);
  assertStringIncludes(result.exitReason, "Fatal");
  // Issue #563: the crash must reach the launcher. A run that died in its
  // main loop reported `COMPLETED` and exit 0, so the supervisor's backoff,
  // escalation and self-heal all read it as a clean run.
  assertEquals(result.fatalError, true);
});

Deno.test("run_core - a clean run does not claim a fatal error (Issue #563)", async () => {
  let nowValue = 0;
  const deps = createMockDeps({
    now: () => nowValue,
    sleep: () => {
      // One cycle, then past the run duration so the loop ends cleanly.
      nowValue += 4000 * 1000;
      return Promise.resolve();
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);

  assertEquals(result.fatalError, false);
});

// ---------------------------------------------------------------------------
// Tests — Per-iteration gh call telemetry (Issue #1671)
// ---------------------------------------------------------------------------

Deno.test("run_core - logs gh-calls summary line each iteration (Issue #1671)", async () => {
  const { recordGhCall, resetGhCallMetrics } = await import(
    "../lib/gh_call_metrics.ts"
  );

  const logLines: string[] = [];
  let nowValue = 0;
  let cycleCount = 0;

  const deps = createMockDeps({
    log: (msg: string) => logLines.push(msg),
    now: () => nowValue,
    findAndProcessPrFeedback: () => {
      // Simulate a `gh` call having been made during the iteration
      recordGhCall(["issue", "list", "--repo", "o/r"]);
      recordGhCall(["pr", "view", "1"]);
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
  });

  resetGhCallMetrics();
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  // Exactly one summary line should be emitted per completed iteration.
  const summaryLines = logLines.filter((l) => l.startsWith("gh-calls:"));
  assertEquals(
    summaryLines.length >= 1,
    true,
    "at least one gh-calls summary expected",
  );
  // The summary should reflect the calls made this iteration
  assertStringIncludes(summaryLines[0]!, "2 total");
  assertStringIncludes(summaryLines[0]!, "issue-list=1");
  assertStringIncludes(summaryLines[0]!, "pr-view=1");
});

Deno.test("run_core - resets gh-call metrics at start of each iteration (Issue #1671)", async () => {
  const { recordGhCall, getGhCallMetrics, resetGhCallMetrics } = await import(
    "../lib/gh_call_metrics.ts"
  );

  // Pre-pollute metrics from a previous iteration.
  resetGhCallMetrics();
  recordGhCall(["issue", "list"]);
  recordGhCall(["issue", "list"]);
  assertEquals(getGhCallMetrics().total, 2);

  const logLines: string[] = [];
  let nowValue = 0;
  let cycleCount = 0;

  const deps = createMockDeps({
    log: (msg: string) => logLines.push(msg),
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  // The summary line for the iteration should NOT include the pre-loop calls.
  const summaryLines = logLines.filter((l) => l.startsWith("gh-calls:"));
  assertEquals(summaryLines.length >= 1, true);
  assertStringIncludes(summaryLines[0]!, "0 total");
});

// ---------------------------------------------------------------------------
// Tests — Per-priority gh call breakdown (Issue #1845)
// ---------------------------------------------------------------------------

Deno.test("run_core - emits gh-calls-by-priority line each iteration (Issue #1845)", async () => {
  const { recordGhCall, resetGhCallMetrics } = await import(
    "../lib/gh_call_metrics.ts"
  );

  const logLines: string[] = [];
  let nowValue = 0;
  let cycleCount = 0;

  const deps = createMockDeps({
    log: (msg: string) => logLines.push(msg),
    now: () => nowValue,
    findAndProcessPrFeedback: () => {
      // Three calls inside the PR Feedback priority context.
      recordGhCall(["issue", "list"]);
      recordGhCall(["pr", "view", "1"]);
      recordGhCall(["pr", "view", "2"]);
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    ensureAutoMerge: () => {
      // One call inside the Auto-Merge priority context.
      recordGhCall(["pr", "list"]);
      return Promise.resolve({ ok: true, value: undefined });
    },
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
  });

  resetGhCallMetrics();
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  const breakdownLines = logLines.filter((l) =>
    l.startsWith("gh-calls-by-priority:")
  );
  assertEquals(
    breakdownLines.length >= 1,
    true,
    "at least one gh-calls-by-priority line expected",
  );
  // PR Feedback (3) appears before Auto-Merge (1) — descending sort.
  const line = breakdownLines[0]!;
  assertStringIncludes(line, "pr-feedback=3");
  assertStringIncludes(line, "auto-merge=1");
  const prPos = line.indexOf("pr-feedback=3");
  const amPos = line.indexOf("auto-merge=1");
  assertEquals(prPos < amPos, true, "PR Feedback must precede Auto-Merge");
});

Deno.test("run_core - empty iteration emits gh-calls-by-priority: none (Issue #1845)", async () => {
  const { resetGhCallMetrics } = await import("../lib/gh_call_metrics.ts");

  const logLines: string[] = [];
  let nowValue = 0;
  let cycleCount = 0;

  const deps = createMockDeps({
    log: (msg: string) => logLines.push(msg),
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
  });

  resetGhCallMetrics();
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  const breakdownLines = logLines.filter((l) =>
    l.startsWith("gh-calls-by-priority:")
  );
  assertEquals(breakdownLines.length >= 1, true);
  assertStringIncludes(breakdownLines[0]!, "none");
});

Deno.test("run_core - emits graphql-calls line each iteration (Issue #1924)", async () => {
  const {
    enterGraphQLSource,
    exitGraphQLSource,
    recordGhCall,
    resetGhCallMetrics,
  } = await import("../lib/gh_call_metrics.ts");

  const logLines: string[] = [];
  let nowValue = 0;
  let cycleCount = 0;

  const deps = createMockDeps({
    log: (msg: string) => logLines.push(msg),
    now: () => nowValue,
    findAndProcessPrFeedback: () => {
      // One GraphQL call attributed to "pr-linkage".
      enterGraphQLSource("pr-linkage");
      try {
        recordGhCall(["api", "graphql", "-f", "query=Q1"]);
      } finally {
        exitGraphQLSource();
      }
      // Two GraphQL calls attributed to "milestone-health".
      enterGraphQLSource("milestone-health");
      try {
        recordGhCall(["api", "graphql", "-f", "query=Q2"]);
        recordGhCall(["api", "graphql", "-f", "query=Q3"]);
      } finally {
        exitGraphQLSource();
      }
      return Promise.resolve({ ok: true, value: { processed: false } });
    },
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
  });

  resetGhCallMetrics();
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  const graphqlLines = logLines.filter((l) => l.startsWith("graphql-calls:"));
  assertEquals(
    graphqlLines.length >= 1,
    true,
    "at least one graphql-calls line expected",
  );
  const line = graphqlLines[0]!;
  assertStringIncludes(line, "3 total");
  assertStringIncludes(line, "milestone-health=2");
  assertStringIncludes(line, "pr-linkage=1");
});

Deno.test("run_core - empty iteration emits graphql-calls: 0 total (Issue #1924)", async () => {
  const { resetGhCallMetrics } = await import("../lib/gh_call_metrics.ts");

  const logLines: string[] = [];
  let nowValue = 0;
  let cycleCount = 0;

  const deps = createMockDeps({
    log: (msg: string) => logLines.push(msg),
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
  });

  resetGhCallMetrics();
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  const graphqlLines = logLines.filter((l) => l.startsWith("graphql-calls:"));
  assertEquals(graphqlLines.length >= 1, true);
  assertStringIncludes(graphqlLines[0]!, "0 total");
});

// ---------------------------------------------------------------------------
// Tests — private-repo-6 heartbeat (Issue #1935)
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - reportFleetHealthHeartbeat is invoked once per iteration (Issue #1935)",
  async () => {
    let heartbeatCalls = 0;
    let cycleCount = 0;
    let nowValue = 0;

    const deps = createMockDeps({
      reportFleetHealthHeartbeat: () => {
        heartbeatCalls++;
        return Promise.resolve();
      },
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        // After two iterations, advance past the run-duration cap so the
        // loop exits cleanly.
        if (cycleCount >= 2) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // Heartbeat called once per iteration (at the top of the while loop)
    // — assert it fired at least as many times as we ran cycles.
    assertEquals(
      heartbeatCalls >= cycleCount,
      true,
      `heartbeat fired ${heartbeatCalls} times across ${cycleCount} cycles`,
    );
    assertEquals(heartbeatCalls >= 2, true, "heartbeat must fire each cycle");
  },
);

Deno.test(
  "run_core - heartbeat failure does not exit the priority loop (Issue #1935)",
  async () => {
    let heartbeatCalls = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const logLines: string[] = [];

    const deps = createMockDeps({
      log: (msg: string) => logLines.push(msg),
      reportFleetHealthHeartbeat: () => {
        heartbeatCalls++;
        return Promise.reject(new Error("simulated heartbeat outage"));
      },
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 2) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    // The loop completed normally despite every heartbeat throwing.
    assertEquals(result.plannedShutdown, true);
    assertEquals(result.exitedOnFailures, false);
    // Heartbeat was attempted on every cycle.
    assertEquals(heartbeatCalls >= 2, true);
    // The loop logged the failure (so silent loss like the original bug
    // cannot happen again).
    const heartbeatLogs = logLines.filter((l) =>
      l.includes("FLEET heartbeat failed")
    );
    assertEquals(heartbeatLogs.length >= 2, true);
    assertStringIncludes(heartbeatLogs[0]!, "simulated heartbeat outage");
  },
);

Deno.test(
  "run_core - heartbeat is NOT reported when Claude health check fails (Issue #2602)",
  async () => {
    let heartbeatCalls = 0;
    let cycleCount = 0;
    let nowValue = 0;

    const deps = createMockDeps({
      // Claude is not authorised — simulate the 401 path.
      checkClaudeHealth: () =>
        Promise.resolve({ ok: true, value: { healthy: false } }),
      reportFleetHealthHeartbeat: () => {
        heartbeatCalls++;
        return Promise.resolve();
      },
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 2) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // The whole point of #2602: an unauthorised worker must NOT report
    // itself healthy. With Claude failing every cycle, the heartbeat must
    // never fire so the host goes stale on the private-repo-6 dashboard.
    assertEquals(
      heartbeatCalls,
      0,
      "heartbeat must not fire while Claude health check is failing",
    );
    assertEquals(cycleCount >= 2, true, "loop must still cycle and skip");
  },
);

Deno.test(
  "run_core - heartbeat is NOT reported when GitHub auth check fails (Issue #2602)",
  async () => {
    let heartbeatCalls = 0;
    let cycleCount = 0;
    let nowValue = 0;

    const deps = createMockDeps({
      checkGhAuth: () => Promise.resolve({ ok: true, value: { valid: false } }),
      reportFleetHealthHeartbeat: () => {
        heartbeatCalls++;
        return Promise.resolve();
      },
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 2) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      heartbeatCalls,
      0,
      "heartbeat must not fire while GitHub auth check is failing",
    );
    assertEquals(cycleCount >= 2, true, "loop must still cycle and skip");
  },
);

Deno.test(
  "run_core - heartbeat fires before priority dispatch within an iteration (Issue #1935)",
  async () => {
    const sequence: string[] = [];
    let cycleCount = 0;
    let nowValue = 0;

    const deps = createMockDeps({
      reportFleetHealthHeartbeat: () => {
        sequence.push("heartbeat");
        return Promise.resolve();
      },
      findAndProcessPrFeedback: () => {
        sequence.push("pr-feedback");
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    const heartbeatIdx = sequence.indexOf("heartbeat");
    const prFeedbackIdx = sequence.indexOf("pr-feedback");
    assertEquals(heartbeatIdx >= 0, true, "heartbeat must fire");
    assertEquals(prFeedbackIdx >= 0, true, "pr-feedback must fire");
    assertEquals(
      heartbeatIdx < prFeedbackIdx,
      true,
      "heartbeat must fire before priority dispatch begins",
    );
  },
);

// ---------------------------------------------------------------------------
// Tests — monitored-repo accessibility health gate (Issue #4038)
// ---------------------------------------------------------------------------

/**
 * Build deps that run exactly `cycles` iterations, then let the loop exit on
 * the run-duration cap. Records whether the Priority 2 scan hook fired.
 */
function createAccessGateDeps(
  cycles: number,
  overrides: Partial<RunCoreDeps>,
): { deps: RunCoreDeps; scanCalls: () => number; iterations: () => number } {
  let scanCalls = 0;
  let cycleCount = 0;
  let nowValue = 0;

  const deps = createMockDeps({
    findNextIssue: () => {
      scanCalls++;
      return Promise.resolve({ ok: true, value: null });
    },
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= cycles) {
        nowValue += 4000 * 1000;
      }
      return Promise.resolve();
    },
    ...overrides,
  });

  return { deps, scanCalls: () => scanCalls, iterations: () => cycleCount };
}

Deno.test(
  "run_core - all monitored repos accessible keeps the worker healthy (Issue #4038)",
  async () => {
    const { deps, scanCalls } = createAccessGateDeps(2, {
      getInaccessibleRepos: () => [],
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    assertEquals(
      result.lastHealthCheckPassed,
      true,
      "an all-accessible fleet must stay healthy, unchanged from today",
    );
    assertEquals(scanCalls() >= 1, true, "the scan must run");
  },
);

Deno.test(
  "run_core - one inaccessible monitored repo marks the host unhealthy WITHOUT skipping the cycle (Issue #4038)",
  async () => {
    const errorLines: string[] = [];
    let heartbeatCalls = 0;
    const { deps, scanCalls } = createAccessGateDeps(2, {
      logError: (msg: string) => errorLines.push(msg),
      reportFleetHealthHeartbeat: () => {
        heartbeatCalls++;
        return Promise.resolve();
      },
      // One of several monitored repos has lost access.
      getInaccessibleRepos: () => ["stSoftwareAU/repo-b"],
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    assertEquals(
      result.lastHealthCheckPassed,
      false,
      "an inaccessible monitored repo must mark the host unhealthy",
    );
    // The dangerous mis-implementation: copying the `continue` from the
    // Claude/gh-auth branches would silently stop work on every repo that
    // is still accessible.
    assertEquals(
      scanCalls() >= 1,
      true,
      "the iteration must fall through to the scan so accessible repos keep being worked",
    );
    assertEquals(
      heartbeatCalls,
      0,
      "an unhealthy host must not heartbeat as healthy (the #4028 signature)",
    );
    const accessLines = errorLines.filter((l) => l.includes("repo-access"));
    assertEquals(accessLines.length >= 1, true, "the gate must log the repos");
    assertStringIncludes(accessLines[0]!, "stSoftwareAU/repo-b");
  },
);

Deno.test(
  "run_core - health recovers on the next iteration once the repo is accessible again (Issue #4038)",
  async () => {
    let probeCall = 0;
    const { deps, iterations } = createAccessGateDeps(2, {
      // First iteration: inaccessible. Second: the store has cleared.
      getInaccessibleRepos: () => {
        probeCall++;
        return probeCall === 1 ? ["stSoftwareAU/repo-b"] : [];
      },
    });

    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    assertEquals(iterations() >= 2, true, "the loop must run both iterations");
    assertEquals(
      result.lastHealthCheckPassed,
      true,
      "health must recover automatically, with no restart and no operator action",
    );
  },
);

Deno.test(
  "run_core - a transient probe failure below the threshold does not flip health (Issue #4038)",
  async () => {
    resetRepoAccessState();
    try {
      // One access-denied probe only — below ACCESS_FAILURE_THRESHOLD, so the
      // store (#4036) does not report the repo inaccessible. No dep override:
      // this exercises the real store wiring the gate uses in production.
      recordRepoProbe("stSoftwareAU/repo-a", "access_denied", 1000);
      recordRepoProbe("stSoftwareAU/repo-b", "transient", 1000);

      const { deps } = createAccessGateDeps(2, {});

      const config = createDefaultRunCoreConfig();
      config.runDurationSeconds = 3600;

      const result = await runCoreLoop(config, deps);

      assertEquals(
        result.lastHealthCheckPassed,
        true,
        "a single blip must not flip the fleet unhealthy",
      );
    } finally {
      resetRepoAccessState();
    }
  },
);

// ---------------------------------------------------------------------------
// Issue #460 — a repo the scan claimed from was still escalated
// ---------------------------------------------------------------------------
//
// GRQ#4465 was filed while the scan claimed GRQ#4463 from that very repo and
// worked it to the cycle deadline. `recordSuccess()` is the wrong signal for
// this: #4463 ended `no_pr:timeout:execute`, a failure, so a success-only
// flag would still have called the repo "refused". What matters is that the
// scan *claimed* from it.

Deno.test("#460 - the tracker records which repos the scan claimed from", () => {
  const tracker = createWorkProgressTracker();
  assertEquals(tracker.claimedRepos.size, 0);

  tracker.recordClaim("stSoftwareAU/GRQ");
  assert(tracker.claimedRepos.has("stSoftwareAU/GRQ"));
});

Deno.test("#460 - a claim that then fails still counts as claimed", () => {
  const tracker = createWorkProgressTracker();
  tracker.recordClaim("stSoftwareAU/GRQ");
  // No recordSuccess() — the run timed out at the cycle deadline.
  assertEquals(tracker.foundClaimableIssue, false);
  assert(
    tracker.claimedRepos.has("stSoftwareAU/GRQ"),
    "GRQ#4463 was claimed and worked for 13 minutes before it timed out",
  );
});

Deno.test("#460 - claimed repos reset with the scan cycle", () => {
  const tracker = createWorkProgressTracker();
  tracker.recordClaim("stSoftwareAU/GRQ");
  tracker.resetScanProgress();
  assertEquals(tracker.claimedRepos.size, 0);
});

Deno.test("#460 - the same repo claimed twice is recorded once", () => {
  const tracker = createWorkProgressTracker();
  tracker.recordClaim("stSoftwareAU/GRQ");
  tracker.recordClaim("stSoftwareAU/GRQ");
  assertEquals(tracker.claimedRepos.size, 1);
});
