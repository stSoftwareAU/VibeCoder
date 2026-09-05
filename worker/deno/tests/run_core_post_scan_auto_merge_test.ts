/**
 * Post-scan auto-merge sweep — cycle ordering (Issue #1136).
 *
 * The priority 1.65 sweep runs before the Priority 2 issue scan, and the
 * issue scan is what raises PRs. So a PR raised by cycle N was structurally
 * invisible to cycle N's own sweep and waited for cycle N+1 — up to an hour,
 * blocking every sibling issue in its work stream while it waited.
 *
 * These tests assert on the *ordering* inside one cycle, never on wall-clock:
 * after the issue-scan pool drains, the cycle sweeps again. The behaviour
 * under test is the sequence of events, so a slower host changes nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";

/** Minimal RunCoreDeps factory — fully-idle by default. */
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

/**
 * One cycle in which the issue scan claims one issue, whose work raises a PR.
 * Returns the ordered event trace and the `refreshOpenPrs` flag each sweep
 * was given.
 */
async function runOneCycle(
  options: { claimIssue: boolean },
): Promise<{ events: string[]; refreshFlags: (boolean | undefined)[] }> {
  const events: string[] = [];
  const refreshFlags: (boolean | undefined)[] = [];
  let findCalls = 0;
  let cycleCount = 0;
  let nowValue = 0;

  const deps = createMockDeps({
    now: () => nowValue,
    sleep: () => {
      events.push("cycle-end");
      cycleCount++;
      // Exit the loop cleanly after the first cycle's end-of-cycle sleep.
      if (cycleCount >= 1) nowValue += 4000 * 1000;
      return Promise.resolve();
    },
    ensureAutoMerge: (opts?: { refreshOpenPrs?: boolean }) => {
      events.push("sweep");
      refreshFlags.push(opts?.refreshOpenPrs);
      return Promise.resolve({ ok: true as const, value: undefined });
    },
    findNextIssue: () => {
      findCalls++;
      if (options.claimIssue && findCalls === 1) {
        return Promise.resolve({
          ok: true as const,
          value: {
            repo: "org/repo",
            issueNumber: 1136,
            issueTitle: "An issue whose work raises a PR",
            milestoneTitle: "",
          },
        });
      }
      return Promise.resolve({ ok: true as const, value: null });
    },
    processIssue: () => {
      // The issue's work is what raises the PR the sweep must see.
      events.push("pr-created");
      return Promise.resolve({ ok: true as const, value: { success: true } });
    },
  });

  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;
  await runCoreLoop(config, deps);

  return { events, refreshFlags };
}

Deno.test(
  "run_core - a PR raised by this cycle's issue work is swept in the same cycle (Issue #1136)",
  async () => {
    const { events } = await runOneCycle({ claimIssue: true });

    const created = events.indexOf("pr-created");
    assert(created >= 0, `expected a PR to be raised: ${events.join(" → ")}`);
    const cycleEnd = events.indexOf("cycle-end");
    assert(cycleEnd >= 0, `expected the cycle to end: ${events.join(" → ")}`);

    // The priority 1.65 sweep runs before the scan; that one cannot see the
    // PR. What matters is that another sweep follows the PR's creation
    // *within the same cycle* — before the cycle-end sleep.
    const sweptAfter = events.findIndex((e, i) => e === "sweep" && i > created);
    assert(
      sweptAfter >= 0 && sweptAfter < cycleEnd,
      `expected a sweep between the PR and the end of the cycle: ${
        events.join(" → ")
      }`,
    );
  },
);

Deno.test(
  "run_core - the post-scan sweep bypasses the cached open-PR list (Issue #1136)",
  async () => {
    const { refreshFlags } = await runOneCycle({ claimIssue: true });

    // The iteration-scoped `prs_${author}` cache was populated by the 1.65
    // sweep, before the PR existed. A second sweep reading that cache would
    // see the same stale list and change nothing.
    assertEquals(
      refreshFlags.some((flag) => flag === true),
      true,
      "expected the post-scan sweep to force a live open-PR listing",
    );
  },
);

Deno.test(
  "run_core - an idle cycle raises no PR, so it does not sweep twice (Issue #1136)",
  async () => {
    const { events } = await runOneCycle({ claimIssue: false });

    const cycleEnd = events.indexOf("cycle-end");
    const sweeps = events.slice(0, cycleEnd).filter((e) => e === "sweep");
    assertEquals(
      sweeps.length,
      1,
      `an idle cycle creates nothing to sweep: ${events.join(" → ")}`,
    );
  },
);

Deno.test(
  "run_core - a claim that then FAILED is still swept (Issue #1136)",
  async () => {
    // The PR this pass exists for is most likely to be unarmed exactly when
    // the run that raised it did not finish cleanly — the security gate
    // refused, or the watchdog took the run at the deadline. Such a run
    // records a claim and no success, so a success-gated sweep would skip
    // the one cycle that needed it.
    const events: string[] = [];
    let findCalls = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        events.push("cycle-end");
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      ensureAutoMerge: (opts?: { refreshOpenPrs?: boolean }) => {
        events.push(
          opts?.refreshOpenPrs === true ? "post-scan-sweep" : "sweep",
        );
        return Promise.resolve({ ok: true as const, value: undefined });
      },
      findNextIssue: () => {
        findCalls++;
        if (findCalls === 1) {
          return Promise.resolve({
            ok: true as const,
            value: {
              repo: "org/repo",
              issueNumber: 1136,
              issueTitle: "An issue whose PR is raised, then the run fails",
              milestoneTitle: "",
            },
          });
        }
        return Promise.resolve({ ok: true as const, value: null });
      },
      processIssue: () => {
        events.push("pr-created");
        // The PR exists; the run itself did not succeed.
        return Promise.resolve({
          ok: true as const,
          value: { success: false },
        });
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    const created = events.indexOf("pr-created");
    const cycleEnd = events.indexOf("cycle-end");
    const swept = events.indexOf("post-scan-sweep");
    assert(
      created >= 0 && swept > created && swept < cycleEnd,
      `expected a post-scan sweep after the failed run's PR: ${
        events.join(" → ")
      }`,
    );
  },
);

Deno.test(
  "run_core - the post-scan sweep says what it did, and why when it skips (Issue #1136)",
  async () => {
    const logs: string[] = [];
    let cycleCount = 0;
    let nowValue = 0;
    const deps = createMockDeps({
      now: () => nowValue,
      log: (m: string) => logs.push(m),
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assert(
      logs.some((m) =>
        m.includes("[post-scan-auto-merge]") && m.includes("skipped")
      ),
      "expected the skipped post-scan sweep to name its reason",
    );
  },
);

Deno.test(
  "run_core - a failing post-scan sweep is loud and does not abort the cycle (Issue #1136)",
  async () => {
    const errors: string[] = [];
    let cycleCount = 0;
    let nowValue = 0;
    let findCalls = 0;
    const deps = createMockDeps({
      now: () => nowValue,
      logError: (m: string) => errors.push(m),
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      ensureAutoMerge: (opts?: { refreshOpenPrs?: boolean }) =>
        opts?.refreshOpenPrs === true
          ? Promise.reject(new Error("simulated sweep crash"))
          : Promise.resolve({ ok: true as const, value: undefined }),
      findNextIssue: () => {
        findCalls++;
        if (findCalls === 1) {
          return Promise.resolve({
            ok: true as const,
            value: {
              repo: "org/repo",
              issueNumber: 1136,
              issueTitle: "An issue whose work raises a PR",
              milestoneTitle: "",
            },
          });
        }
        return Promise.resolve({ ok: true as const, value: null });
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);

    assertEquals(result.plannedShutdown, true);
    assert(
      errors.some((m) =>
        m.includes("[post-scan-auto-merge]") &&
        m.includes("simulated sweep crash")
      ),
      `expected the crash to be logged: ${errors.join(" | ")}`,
    );
  },
);
