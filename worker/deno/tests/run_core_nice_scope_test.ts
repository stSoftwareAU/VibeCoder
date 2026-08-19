/**
 * Repo `nice` scope-boundary regression tests (Issue #2776, part of #2771).
 *
 * `nice` gates **new-work** selection only — the Priority 2 cross-repo scan
 * (`find_oldest_issue.ts`) and the planning/label scans. It must **not** gate
 * maintenance of work already in flight: the Priority 1.x handlers (PR
 * feedback, CI fixes, branch updates, auto-merge, …) service the worker's own
 * already-open PRs and assigned issues and never route through the
 * `nice`-tiered finders. An open PR in a high-`nice` (deprioritised) repo must
 * still be serviced so it does not rot.
 *
 * These tests drive the real `runCoreLoop` dispatch with an injected dep set
 * (no real sleeps, no network) and assert that:
 *   1. A Priority 1.x handler servicing in-flight work in a high-`nice` repo
 *      runs to completion even when a lower-`nice` repo has pending new work —
 *      and runs before the `nice`-tiered Priority 2 new-work scan.
 *   2. Priority 1.x maintenance and Priority 2 new-work selection stay
 *      independent: processing in-flight work in a high-`nice` repo does not
 *      suppress the subsequent nice-aware Priority 2 scan.
 *
 * A minimal RunCoreDeps mock is rebuilt locally so the file is self-contained,
 * mirroring `run_core_watchdog_test.ts`.
 *
 * Uses Australian English throughout (behaviour, prioritised, organisation).
 */

import { assert } from "@std/assert";
import {
  createDefaultRunCoreConfig,
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

// Operator `nice` preference for the scenario: the high-`nice` repo is
// deprioritised for *new* work; the low-`nice` repo is prioritised.
const HIGH_NICE_REPO = "owner/deprioritised";
const LOW_NICE_REPO = "owner/prioritised";
const REPO_NICE: Readonly<Record<string, number>> = {
  [HIGH_NICE_REPO]: 19,
  [LOW_NICE_REPO]: 0,
};

Deno.test(
  "run_core nice scope - Priority 1.x services in-flight work in a high-nice repo before the nice-tiered Priority 2 scan",
  async () => {
    const events: string[] = [];
    let shutdownHandler: (() => void) | null = null;

    const deps = createMockDeps({
      addSignalListener: (signal, handler) => {
        if (signal === "SIGTERM") shutdownHandler = handler;
      },
      // Priority 1: PR feedback services an in-flight PR in the HIGH-nice
      // (deprioritised) repo. `nice` slows down picking up *new* work there
      // but must never gate this upkeep — the PR would otherwise rot.
      findAndProcessPrFeedback: () => {
        events.push(
          `pr-feedback:${HIGH_NICE_REPO}:nice=${REPO_NICE[HIGH_NICE_REPO]}`,
        );
        return Promise.resolve({ ok: true, value: { processed: true } });
      },
      // Priority 1.55: a CI fix on another in-flight PR, also in the
      // high-nice repo. Same contract — serviced regardless of `nice`.
      findAndProcessCiFailure: () => {
        events.push(
          `ci-fix:${HIGH_NICE_REPO}:nice=${REPO_NICE[HIGH_NICE_REPO]}`,
        );
        return Promise.resolve({ ok: true, value: { processed: true } });
      },
      // Priority 2: the nice-aware new-work scan would select the LOW-nice
      // repo's pending work. End the loop once it is reached.
      findNextIssue: () => {
        events.push(
          `scan:select:${LOW_NICE_REPO}:nice=${REPO_NICE[LOW_NICE_REPO]}`,
        );
        if (shutdownHandler) shutdownHandler();
        return Promise.resolve({ ok: true, value: null });
      },
    });

    const config = createDefaultRunCoreConfig();
    await runCoreLoop(config, deps);

    const prEvent = `pr-feedback:${HIGH_NICE_REPO}:nice=19`;
    const ciEvent = `ci-fix:${HIGH_NICE_REPO}:nice=19`;

    assert(
      events.includes(prEvent),
      `Priority 1 PR feedback must service the high-nice repo's in-flight PR; got: ${
        events.join(" | ")
      }`,
    );
    assert(
      events.includes(ciEvent),
      `Priority 1.55 CI fix must service the high-nice repo's in-flight PR; got: ${
        events.join(" | ")
      }`,
    );

    const prIdx = events.indexOf(prEvent);
    const ciIdx = events.indexOf(ciEvent);
    const scanIdx = events.findIndex((e) => e.startsWith("scan:select:"));

    assert(scanIdx >= 0, "the nice-tiered Priority 2 scan must be reached");
    // In-flight maintenance for the deprioritised repo runs before the
    // nice-aware new-work selection for the prioritised repo.
    assert(
      prIdx < scanIdx && ciIdx < scanIdx,
      `Priority 1.x maintenance must run before the Priority 2 new-work scan; got: ${
        events.join(" | ")
      }`,
    );
  },
);

Deno.test(
  "run_core nice scope - processing in-flight work in a high-nice repo does not suppress the nice-aware Priority 2 scan",
  async () => {
    let prFeedbackRan = false;
    let scanRan = false;
    let shutdownHandler: (() => void) | null = null;

    const deps = createMockDeps({
      addSignalListener: (signal, handler) => {
        if (signal === "SIGTERM") shutdownHandler = handler;
      },
      // Priority 1 processed in-flight work in the deprioritised repo
      // (`processed: true`). Priority 1.x maintenance and Priority 2 new-work
      // selection are independent, so the nice-aware scan must still run.
      findAndProcessPrFeedback: () => {
        prFeedbackRan = true;
        return Promise.resolve({ ok: true, value: { processed: true } });
      },
      findNextIssue: () => {
        scanRan = true;
        if (shutdownHandler) shutdownHandler();
        return Promise.resolve({ ok: true, value: null });
      },
    });

    const config = createDefaultRunCoreConfig();
    await runCoreLoop(config, deps);

    assert(prFeedbackRan, "Priority 1 PR feedback must run");
    assert(
      scanRan,
      "the nice-tiered Priority 2 scan must still run after Priority 1.x processed in-flight work",
    );
  },
);
