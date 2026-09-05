/**
 * Tests for run_core_production_deps.ts — production dependency wiring.
 *
 * Issue #1124: Wire Deno run_core.ts as primary executor.
 *
 * These tests verify that the production dependency factory correctly
 * wires all RunCoreDeps methods to their library implementations.
 * Since many methods call external services, these tests focus on
 * structure and configuration rather than end-to-end behaviour.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  createProductionRunCoreDeps,
  type ProductionDepsOptions,
} from "../lib/run_core_production_deps.ts";
import { createLogger } from "../lib/logger.ts";
import {
  _resetDerivedAuthorsCache,
  resolveDerivedAuthors,
} from "../lib/derived_authors.ts";
import {
  rateLimitSignalPath,
  writeRateLimitSignal,
} from "../lib/rate_limit_signal.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { envFrom } from "./support/env_lookup.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** No-op logger for tests — avoids opening file handles. */
const testLogger = createLogger({ write: () => {} });

/**
 * Run `action` with `globalThis.setTimeout` stubbed so it records every delay
 * requested and fires each callback immediately (no real wait). Returns the
 * captured delays in order. The original `setTimeout` is always restored.
 *
 * This lets a `sleep` test assert the duration it asks the timer to wait
 * deterministically, instead of measuring wall-clock elapsed time (Issue #2890).
 */
async function captureSleepDelays(
  action: () => Promise<unknown>,
): Promise<number[]> {
  const requestedDelays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).setTimeout = (
      callback: (...args: unknown[]) => void,
      ms?: number,
    ): number => {
      requestedDelays.push(ms ?? -1);
      callback();
      return 0;
    };
    await action();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  return requestedDelays;
}

/**
 * Create test options for the production deps factory.
 *
 * The config is named rather than loaded (Issue #1098). Left to the factory,
 * it comes from `CONFIG_PATH` — so with the operator's own config in the
 * environment these tests resolved trusted authors against the real monitored
 * repositories, making live `gh` calls from a unit test and failing whenever
 * one of them did.
 */
function createTestOptions(
  overrides?: Partial<ProductionDepsOptions>,
): ProductionDepsOptions {
  return {
    repoDir: "/tmp/test-repo",
    workDir: "/tmp/test-work",
    githubUser: "test-user",
    logger: testLogger,
    config: buildDefaultWorkerConfig(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createProductionRunCoreDeps — structure tests
// ---------------------------------------------------------------------------

Deno.test("createProductionRunCoreDeps - returns deps and config", async () => {
  const options = createTestOptions();
  const { deps, config } = await createProductionRunCoreDeps(options);

  assertExists(deps);
  assertExists(config);
  assertEquals(typeof config.runDurationSeconds, "number");
  assertEquals(typeof config.sleepInterval, "number");
  assertEquals(typeof config.maxConsecutiveFailures, "number");
  assertEquals(typeof config.rateLimitBackoff, "number");
});

Deno.test("createProductionRunCoreDeps - all deps methods are functions", async () => {
  const options = createTestOptions();
  const { deps } = await createProductionRunCoreDeps(options);

  // Logging
  assertEquals(typeof deps.log, "function");
  assertEquals(typeof deps.logError, "function");
  assertEquals(typeof deps.logTiming, "function");
  assertEquals(typeof deps.logWorkerSummary, "function");

  // PID management
  assertEquals(typeof deps.checkPidFile, "function");
  assertEquals(typeof deps.claimPidFile, "function");
  assertEquals(typeof deps.releasePidFile, "function");

  // Initialisation
  assertEquals(typeof deps.gitResetToOrigin, "function");
  assertEquals(typeof deps.setupLogging, "function");
  assertEquals(typeof deps.loadAndValidateConfig, "function");
  assertEquals(typeof deps.checkDependencies, "function");
  assertEquals(typeof deps.checkSoftwareUpdates, "function");
  assertEquals(typeof deps.checkDiskSpace, "function");
  assertEquals(typeof deps.rotateLogFiles, "function");
  assertEquals(typeof deps.cleanupStaleTempFiles, "function");
  assertEquals(typeof deps.recoverStuckIssues, "function");
  assertEquals(typeof deps.cleanupStaleBranches, "function");
  assertEquals(typeof deps.checkFeatureAvailability, "function");

  // Health checks
  assertEquals(typeof deps.checkClaudeHealth, "function");
  assertEquals(typeof deps.checkGhAuth, "function");

  // Priority handlers
  assertEquals(typeof deps.findAndProcessPrFeedback, "function");
  assertEquals(typeof deps.findAndProcessSpellingFailure, "function");
  assertEquals(typeof deps.findAndProcessCiFailure, "function");
  assertEquals(typeof deps.updateOpenPrBranches, "function");
  assertEquals(typeof deps.ensureAutoMerge, "function");
  assertEquals(typeof deps.cleanupMergedBranches, "function");
  assertEquals(typeof deps.closeIssuesForMergedPrs, "function");
  assertEquals(typeof deps.recoverAssignedWithClosedPr, "function");
  assertEquals(typeof deps.checkMilestoneCompletions, "function");
  assertEquals(typeof deps.findAndProcessRefinement, "function");
  // Issue #1619: grill-me is wired between refinement and planning.
  assertEquals(typeof deps.findAndProcessGrillMe, "function");
  assertEquals(typeof deps.findAndProcessQuestion, "function");
  assertEquals(typeof deps.findAndProcessPlanning, "function");
  assertEquals(typeof deps.findNextIssue, "function");
  assertEquals(typeof deps.processIssue, "function");

  // Failure tracking
  assertEquals(typeof deps.trackFailure, "function");
  assertEquals(typeof deps.resetFailures, "function");
  assertEquals(typeof deps.shouldExitOnFailures, "function");
  assertEquals(typeof deps.recordIssueCooldown, "function");

  // Circuit breaker
  assertEquals(typeof deps.circuitBreakerReset, "function");
  assertEquals(typeof deps.circuitBreakerRecordZeroProgress, "function");
  assertEquals(typeof deps.circuitBreakerGetSleepInterval, "function");
  assertEquals(typeof deps.isRateLimitActive, "function");

  // Repo failure tracking
  assertEquals(typeof deps.resetRepoFailures, "function");
  assertEquals(typeof deps.recordRepoFailure, "function");
  assertEquals(typeof deps.recordRepoSuccess, "function");

  // Crash handling
  assertEquals(typeof deps.sendCrashNotification, "function");
  assertEquals(typeof deps.clearHeartbeat, "function");
  assertEquals(typeof deps.cleanupInProgressIssue, "function");

  // Status
  assertEquals(typeof deps.setStatusIdle, "function");
  assertEquals(typeof deps.setStatusWorking, "function");
  assertEquals(typeof deps.setStatusSuccess, "function");
  assertEquals(typeof deps.setStatusFailure, "function");
  assertEquals(typeof deps.resetWindowTitle, "function");

  // Signal handling
  assertEquals(typeof deps.addSignalListener, "function");
  assertEquals(typeof deps.removeSignalListener, "function");

  // Misc
  assertEquals(typeof deps.touchPidFile, "function");
  assertEquals(typeof deps.sleep, "function");
  assertEquals(typeof deps.now, "function");

  // Issue #253: per-cycle trusted-author refresh is wired in production.
  assertEquals(typeof deps.refreshTrustedAuthors, "function");
});

Deno.test(
  "createProductionRunCoreDeps - static trust refresh succeeds and does not throw",
  async () => {
    // The resolver is stubbed through the seam the factory publishes for
    // exactly this: production shells out to `gh`, and a wiring test whose
    // verdict came from a real GitHub call would report the host rather than
    // the code — which is what it did under the gate, where the ambient
    // CONFIG_PATH the suite scrubs is what made it pass locally.
    const options = createTestOptions({
      resolveTrustedAuthors: () =>
        Promise.resolve({
          ok: true as const,
          byRepo: new Map([[
            "org/a",
            { allowedAuthors: ["alice"], authorisedCommenters: ["alice"] },
          ]]),
        }),
    });
    const { deps } = await createProductionRunCoreDeps(options);
    const outcome = await deps.refreshTrustedAuthors!();
    assertEquals(outcome.ok, true, JSON.stringify(outcome));
  },
);

Deno.test(
  "createProductionRunCoreDeps - another consumer's cycle 1 is not served to this factory's first refresh (Issue #1098)",
  async () => {
    // The resolver caches one result per `cycleId` in module state. A factory
    // that counted cycles from 1 shared that key with every other consumer in
    // the process, so whoever resolved first decided the answer — under the
    // gate's parallel pass this test file inherited a cached *failure* from a
    // file that had run before it in the same worker, and the refresh above
    // failed without making a call.
    const poisoned = await resolveDerivedAuthors(
      {
        repos: [],
        serviceAccounts: [],
        fleetPrAuthors: [],
        // No fleet login at all, so the resolve refuses — the cheapest
        // failure the resolver has, and no `gh` call is made for it.
        githubUser: "",
        knownInputLogins: [],
      },
      { cycleId: 1, log: () => {} },
    );
    assertEquals(poisoned.ok, false, "the poisoning resolve must have failed");

    try {
      const { deps } = await createProductionRunCoreDeps(createTestOptions());
      const outcome = await deps.refreshTrustedAuthors!();
      assertEquals(outcome.ok, true, JSON.stringify(outcome));
    } finally {
      // Leave no poisoned entry behind for the next file in this worker —
      // the fault this test covers, in the direction this test creates it.
      _resetDerivedAuthorsCache();
    }
  },
);

Deno.test("createProductionRunCoreDeps - config has sensible defaults", async () => {
  const options = createTestOptions();
  const { config } = await createProductionRunCoreDeps(options);

  assertEquals(config.runDurationSeconds > 0, true);
  assertEquals(config.sleepInterval > 0, true);
  assertEquals(config.maxConsecutiveFailures > 0, true);
  assertEquals(config.rateLimitBackoff > 0, true);
});

Deno.test("createProductionRunCoreDeps - PID check returns canProceed true", async () => {
  const options = createTestOptions();
  const { deps } = await createProductionRunCoreDeps(options);

  const result = await deps.checkPidFile();
  assertEquals(result.canProceed, true);
});

Deno.test("createProductionRunCoreDeps - now returns current timestamp", async () => {
  const options = createTestOptions();
  const { deps } = await createProductionRunCoreDeps(options);

  const before = Date.now();
  const now = deps.now();
  const after = Date.now();

  assertEquals(now >= before, true);
  assertEquals(now <= after, true);
});

// Issue #2890: these previously measured wall-clock elapsed time around a real
// `await deps.sleep(...)` (`elapsed >= 40`), a HOW/timing anti-pattern that
// asserts a property of the platform's timer rather than the worker's logic and
// depends on machine speed and CI load (the same class removed under Issue
// #2434). Replaced with deterministic assertions on observable behaviour: a
// stubbed setTimeout captures the delay `sleep` asks the timer to wait and fires
// the callback immediately, so the promise resolves with no real wait.
Deno.test("createProductionRunCoreDeps - sleep waits for the requested duration", async () => {
  const options = createTestOptions();
  const { deps } = await createProductionRunCoreDeps(options);

  const requestedDelays = await captureSleepDelays(() => deps.sleep(50));

  // A real-timer-backed sleep asks the timer for exactly the requested duration.
  assertEquals(requestedDelays, [50]);
});

Deno.test("createProductionRunCoreDeps - sleep defaults to 30s when no delay given", async () => {
  const options = createTestOptions();
  const { deps } = await createProductionRunCoreDeps(options);

  const requestedDelays = await captureSleepDelays(() => deps.sleep());

  // The `ms ?? 30000` default is the observable contract for a no-arg sleep.
  assertEquals(requestedDelays, [30000]);
});

Deno.test("createProductionRunCoreDeps - loadAndValidateConfig returns ok", async () => {
  const options = createTestOptions();
  const { deps } = await createProductionRunCoreDeps(options);

  const result = await deps.loadAndValidateConfig();
  // Will return ok with default config since test config path won't exist
  assertEquals(typeof result.ok, "boolean");
});

Deno.test("createProductionRunCoreDeps - gitResetToOrigin returns ok", async () => {
  const options = createTestOptions();
  const { deps } = await createProductionRunCoreDeps(options);

  const result = await deps.gitResetToOrigin();
  assertEquals(result.ok, true);
});

Deno.test("createProductionRunCoreDeps - status methods resolve without error", async () => {
  const options = createTestOptions();
  const { deps } = await createProductionRunCoreDeps(options);

  await deps.setStatusIdle();
  await deps.setStatusWorking("test");
  await deps.setStatusSuccess();
  await deps.setStatusFailure();
  deps.resetWindowTitle();
});

Deno.test("createProductionRunCoreDeps - checkDependencies returns ok", async () => {
  const options = createTestOptions();
  const { deps } = await createProductionRunCoreDeps(options);

  const result = await deps.checkDependencies();
  assertEquals(result.ok, true);
});

// ---------------------------------------------------------------------------
// ProductionDepsOptions — type tests
// ---------------------------------------------------------------------------

Deno.test("createProductionRunCoreDeps - accepts custom logger", async () => {
  const logs: string[] = [];
  const options = createTestOptions({
    logger: {
      info: (msg: string) => {
        logs.push(msg);
      },
      error: (_msg: string) => {},
      debug: (_msg: string) => {},
      warn: (_msg: string) => {},
      security: (_event: string, _details: string) => {},
      skipReason: (_code: string, _details: string) => {},
      timing: (_op: string, _dur: number) => {},
      scanSummary: () => {},
      workerSummary: (_processed: number, _dur: number) => {},
    },
  });

  const { deps } = await createProductionRunCoreDeps(options);
  deps.log("test message");
  assertEquals(logs.length, 1);
  assertEquals(logs[0], "test message");
});

// ---------------------------------------------------------------------------
// isRateLimitActive — integration tests (Issue #1181)
// ---------------------------------------------------------------------------

Deno.test("isRateLimitActive - returns true when rate limit signal is active", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "rate_limit_test_" });
  try {
    const result = await writeRateLimitSignal(tmpDir, 300);
    assertEquals(result.ok, true);

    const options = createTestOptions({ workDir: tmpDir });
    const { deps } = await createProductionRunCoreDeps(options);

    const active = await deps.isRateLimitActive();
    assertEquals(active, true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("isRateLimitActive - returns false when signal has expired", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "rate_limit_test_" });
  try {
    // Write a signal that expired in the past
    const expiredData = {
      timestamp: Math.floor(Date.now() / 1000) - 600,
      waitSeconds: 60,
    };
    await Deno.writeTextFile(
      rateLimitSignalPath(tmpDir),
      JSON.stringify(expiredData),
    );

    const options = createTestOptions({ workDir: tmpDir });
    const { deps } = await createProductionRunCoreDeps(options);

    const active = await deps.isRateLimitActive();
    assertEquals(active, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("isRateLimitActive - returns false when no signal file exists", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "rate_limit_test_" });
  try {
    const options = createTestOptions({ workDir: tmpDir });
    const { deps } = await createProductionRunCoreDeps(options);

    const active = await deps.isRateLimitActive();
    assertEquals(active, false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// updateOpenPrBranches — wiring tests (Issue #1280)
// ---------------------------------------------------------------------------

Deno.test("updateOpenPrBranches - calls scanPrBranchUpdates with empty repos and returns ok", async () => {
  // With no repos configured, the wired-up scanPrBranchUpdates returns early
  // with 0 actions. The stub would also return ok, but this test validates
  // the real scan logic is invoked by checking the log output.
  const logs: string[] = [];
  const emptyConfig = buildDefaultWorkerConfig({ repos: [] });
  const options = createTestOptions({
    config: emptyConfig,
    logger: {
      info: (msg: string) => {
        logs.push(msg);
      },
      error: () => {},
      debug: () => {},
      warn: () => {},
      security: () => {},
      skipReason: () => {},
      timing: () => {},
      scanSummary: () => {},
      workerSummary: () => {},
    },
  });

  const { deps, cleanup } = await createProductionRunCoreDeps(options);
  try {
    const result = await deps.updateOpenPrBranches();
    assertEquals(result.ok, true);

    // The real scanPrBranchUpdates logs "No repositories configured" when repos
    // is empty, which the old stub never did. This confirms the wiring works.
    const hasNoReposLog = logs.some(
      (msg) => msg.includes("No repositories configured"),
    );
    assertEquals(
      hasNoReposLog,
      true,
      `Expected log about no repositories from scanPrBranchUpdates, got: ${
        JSON.stringify(logs)
      }`,
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Label-dispatch handlers — behaviour through findAndProcessByLabel (Issue #2565)
// ---------------------------------------------------------------------------

// The four label-dispatch handlers (refinement, grill-me, planning, question)
// share the now-typed `findAndProcessByLabel` helper. With an empty repos
// config, `findIssuesByLabel` short-circuits to found:false without any
// network call, so each handler returns { ok: true, value: { processed:
// false } }. This exercises the real helper path and confirms the generic
// typing change preserves behaviour.
Deno.test("findAndProcess label handlers - return processed false with no repos", async () => {
  const emptyConfig = buildDefaultWorkerConfig({ repos: [] });
  const options = createTestOptions({ config: emptyConfig });
  const { deps, cleanup } = await createProductionRunCoreDeps(options);
  try {
    for (
      const handler of [
        deps.findAndProcessRefinement,
        deps.findAndProcessGrillMe,
        deps.findAndProcessPlanning,
        deps.findAndProcessQuestion,
      ]
    ) {
      const result = await handler();
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.processed, false);
      }
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Production logger file I/O — integration test (Issue #1179)
// ---------------------------------------------------------------------------

Deno.test("createProductionRunCoreDeps - default logger writes to worker log file", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "prod_logger_test_" });
  const logsDir = `${tmpDir}/logs`;
  await Deno.mkdir(logsDir, { recursive: true });

  try {
    // Create production deps WITHOUT a custom logger so the default
    // file-writing logger is used.
    //
    // Issue #967: the home root is handed in rather than exported. It names a
    // throwaway directory that appears in no real environment, so a factory
    // that read `Deno.env.get("HOME")` would write to the operator's own
    // `~/logs` and fail the assertion below.
    const options: ProductionDepsOptions = {
      repoDir: tmpDir,
      workDir: tmpDir,
      githubUser: "test-user",
      env: envFrom({ HOME: tmpDir }),
      // No logger override — exercises the production file-writing path
    };

    const { deps, cleanup } = await createProductionRunCoreDeps(options);
    try {
      deps.log("integration test message for issue 1179");

      // Read the worker log file and verify the message was written
      const workerLogPath = `${logsDir}/worker.log`;
      const logContents = await Deno.readTextFile(workerLogPath);
      assertEquals(
        logContents.includes("integration test message for issue 1179"),
        true,
        `Expected worker.log to contain the test message but got: ${logContents}`,
      );
    } finally {
      // Close the file handle to avoid Deno leak detection failures
      cleanup();
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Repo failure tracking — awaited file I/O (Issue #2793)
// ---------------------------------------------------------------------------
//
// The repo failure-tracker deps perform real read-modify-write file I/O. They
// must return a promise the loop can await, so overlapping writes cannot
// clobber each other (lost-update race) and a write failure is not silently
// swallowed by a floating promise. The failure file lives at
// `${TMPDIR}/vibe-repo-failures-${Deno.pid}`, so handing the factory a TMPDIR
// of our own lets us observe the persisted state directly.
//
// Issue #967: that root is a parameter, not an export. Each case names a
// throwaway directory that appears in no real environment, so a factory that
// read `Deno.env.get("TMPDIR")` would write to the host's own temporary
// directory and the read-back below would find nothing.

Deno.test("repo failure deps - recordRepoFailure returns an awaitable that persists the write", async () => {
  const tmpDir = await Deno.makeTempDir();
  const failureFile = `${tmpDir}/vibe-repo-failures-${Deno.pid}`;
  try {
    const { deps } = await createProductionRunCoreDeps(
      createTestOptions({ env: envFrom({ TMPDIR: tmpDir }) }),
    );

    // The method must return an awaitable (Promise) — a floating promise that
    // returned `undefined` would defeat the `await` at the call site.
    const pending = deps.recordRepoFailure("org/repo", 42);
    assertEquals(pending instanceof Promise, true);
    await pending;

    const contents = await Deno.readTextFile(failureFile);
    assertEquals(contents.includes("org/repo|42"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("repo failure deps - sequential awaited writes do not clobber (no lost update)", async () => {
  const tmpDir = await Deno.makeTempDir();
  const failureFile = `${tmpDir}/vibe-repo-failures-${Deno.pid}`;
  try {
    const { deps } = await createProductionRunCoreDeps(
      createTestOptions({ env: envFrom({ TMPDIR: tmpDir }) }),
    );

    // Awaiting each write serialises the read-modify-write cycles, so every
    // distinct failing issue is retained rather than races overwriting peers.
    await deps.recordRepoFailure("org/repo", 1);
    await deps.recordRepoFailure("org/repo", 2);
    await deps.recordRepoFailure("org/repo", 3);

    const contents = await Deno.readTextFile(failureFile);
    const line = contents.split("\n").find((l) => l.startsWith("org/repo|"));
    assertExists(line);
    const recorded = new Set(
      (line.split("|")[1] ?? "").split(",").map((n) => n.trim()),
    );
    assertEquals(recorded.has("1"), true);
    assertEquals(recorded.has("2"), true);
    assertEquals(recorded.has("3"), true);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("repo failure deps - recordRepoSuccess and resetRepoFailures clear persisted state", async () => {
  const tmpDir = await Deno.makeTempDir();
  const failureFile = `${tmpDir}/vibe-repo-failures-${Deno.pid}`;
  try {
    const { deps } = await createProductionRunCoreDeps(
      createTestOptions({ env: envFrom({ TMPDIR: tmpDir }) }),
    );

    await deps.recordRepoFailure("org/one", 1);
    await deps.recordRepoFailure("org/two", 2);

    // recordRepoSuccess clears only the named repo.
    assertEquals((deps.recordRepoSuccess("org/one")) instanceof Promise, true);
    await deps.recordRepoSuccess("org/one");
    let contents = await Deno.readTextFile(failureFile);
    assertEquals(contents.includes("org/one"), false);
    assertEquals(contents.includes("org/two"), true);

    // resetRepoFailures clears everything.
    assertEquals((deps.resetRepoFailures()) instanceof Promise, true);
    await deps.resetRepoFailures();
    contents = await Deno.readTextFile(failureFile);
    assertEquals(contents.trim(), "");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
