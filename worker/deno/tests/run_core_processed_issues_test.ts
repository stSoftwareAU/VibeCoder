/**
 * Tests for the per-run processed-issue exclusion in the scan loop
 * (Issue #181).
 *
 * The issue-list cache has a 600 s TTL, so a stale list keeps offering an
 * issue the worker has already finished with (NEAT-AI-Forests#21 was
 * "processed" three times after being closed). Every terminal outcome must
 * therefore be recorded in a per-run registry that the next `findNextIssue`
 * excludes, in both the serial loop and the concurrent pool.
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
import { ProcessedIssueRegistry } from "../lib/processed_issue_registry.ts";

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
    cleanupMergedBranches: () => Promise.resolve({ ok: true, value: undefined }),
    closeIssuesForMergedPrs: () =>
      Promise.resolve({ ok: true, value: undefined }),
    recoverAssignedWithClosedPr: () =>
      Promise.resolve({ ok: true, value: undefined }),
    syncMilestoneBranches: () => Promise.resolve({ ok: true, value: undefined }),
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

/**
 * A never-shrinking candidate list, exactly like the cached `issues_all`
 * ranking production reads: entries disappear only when the run's own
 * registry excludes them.
 */
function staleQueue(
  registry: ProcessedIssueRegistry,
  issues: DiscoveredIssue[],
) {
  return (options?: { excludeRepos?: ReadonlySet<string> }) => {
    const next = issues.find((i) =>
      !options?.excludeRepos?.has(i.repo) &&
      !registry.has(i.repo, i.issueNumber)
    ) ?? null;
    return Promise.resolve({ ok: true as const, value: next });
  };
}

/** Run one cycle: the loop ends when the clock passes the deadline. */
async function runOneCycle(deps: RunCoreDeps, maxConcurrentIssues: number) {
  const config = { ...createDefaultRunCoreConfig(), maxConcurrentIssues };
  await runCoreLoop(config, deps);
}

/**
 * Hard cap on processIssue calls, so a regression (an issue re-offered
 * forever by the stale list) fails the assertion instead of hanging the
 * suite: once the cap is hit the clock jumps past the cycle deadline and
 * every slot stops before its next claim.
 */
const PROCESS_CAP = 12;

Deno.test("processed exclusion - serial loop never re-processes an issue it finished (Issue #181)", async () => {
  const registry = new ProcessedIssueRegistry();
  const processed: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    processedIssues: registry,
    findNextIssue: staleQueue(registry, [
      issue("o/a", 21),
      issue("o/b", 22),
      issue("o/c", 23),
    ]),
    processIssue: (i) => {
      processed.push(`${i.repo}#${i.issueNumber}`);
      now += config.runDurationSeconds * 400; // 40% of the cycle each
      if (processed.length >= PROCESS_CAP) {
        now = config.runDurationSeconds * 1000 + 1;
      }
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });

  await runOneCycle(deps, 1);

  assertEquals(
    processed.length,
    new Set(processed).size,
    `an issue was processed twice: ${processed.join(", ")}`,
  );
  assert(processed.includes("o/a#21"));
  assert(registry.has("o/a", 21));
});

Deno.test("processed exclusion - a bounced (skipped) issue is not re-offered this run (Issue #181)", async () => {
  const registry = new ProcessedIssueRegistry();
  const processed: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    processedIssues: registry,
    findNextIssue: staleQueue(registry, [
      issue("o/a", 21),
      issue("o/b", 22),
    ]),
    processIssue: (i) => {
      processed.push(`${i.repo}#${i.issueNumber}`);
      now += config.runDurationSeconds * 400;
      if (processed.length >= PROCESS_CAP) {
        now = config.runDurationSeconds * 1000 + 1;
      }
      // #21 bounces; #22 succeeds.
      return Promise.resolve(
        i.issueNumber === 21
          ? { ok: true, value: { success: false, skipped: true } }
          : { ok: true, value: { success: true } },
      );
    },
  });

  await runOneCycle(deps, 1);

  assertEquals(processed.filter((p) => p === "o/a#21").length, 1);
  assert(processed.includes("o/b#22"), "the other issue was reached");
  assertEquals(registry.reasonFor("o/a", 21), "skip");
});

Deno.test("processed exclusion - a failed issue is recorded and not retried this run (Issue #181)", async () => {
  const registry = new ProcessedIssueRegistry();
  const processed: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    processedIssues: registry,
    findNextIssue: staleQueue(registry, [issue("o/a", 21), issue("o/b", 22)]),
    processIssue: (i) => {
      processed.push(`${i.repo}#${i.issueNumber}`);
      now += config.runDurationSeconds * 400;
      if (processed.length >= PROCESS_CAP) {
        now = config.runDurationSeconds * 1000 + 1;
      }
      return Promise.resolve(
        i.issueNumber === 21
          ? { ok: true, value: { success: false } }
          : { ok: true, value: { success: true } },
      );
    },
  });

  await runOneCycle(deps, 1);

  assertEquals(processed.filter((p) => p === "o/a#21").length, 1);
  assertEquals(registry.reasonFor("o/a", 21), "failure");
});

Deno.test("processed exclusion - two slots, one bouncing issue: the pool advances through the rest (Issue #181)", async () => {
  const registry = new ProcessedIssueRegistry();
  const processed: string[] = [];
  let now = 0;
  const config = createDefaultRunCoreConfig();
  const candidates = [
    issue("o/a", 21), // the bouncer
    issue("o/b", 22),
    issue("o/c", 23),
    issue("o/d", 24),
  ];
  const deps = createMockDeps({
    now: () => now,
    sleep: (ms?: number) => {
      now += ms ?? 30_000;
      return Promise.resolve();
    },
    processedIssues: registry,
    findNextIssue: staleQueue(registry, candidates),
    processIssue: async (i) => {
      processed.push(`${i.repo}#${i.issueNumber}`);
      await new Promise((r) => setTimeout(r, 5));
      if (processed.length >= PROCESS_CAP) {
        now = config.runDurationSeconds * 1000 + 1;
      }
      if (i.issueNumber === 21) {
        // A bounce costs almost no time — this is what re-entered the pool
        // seconds later and re-read the stale list.
        return { ok: true, value: { success: false, skipped: true } };
      }
      now += config.runDurationSeconds * 400;
      return { ok: true, value: { success: true } };
    },
  });

  await runOneCycle(deps, 2);

  assertEquals(
    processed.filter((p) => p === "o/a#21").length,
    1,
    `the bouncer was re-processed: ${processed.join(", ")}`,
  );
  assert(
    processed.length > 1,
    "the sibling slot advanced to other claimable issues",
  );
});
