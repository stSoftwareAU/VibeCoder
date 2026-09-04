/**
 * Tests for the cycle-start work-volume standing totals (Issue #244).
 *
 * Every disk problem on GRQ-23 was invisible until the host hit 95 %: the
 * worker log said nothing about what the work volume held. The loop now
 * logs the standing totals by category beside the `Concurrency:` line, and
 * a failed walk is reported loud instead of silently skipped.
 *
 * Mock harness mirrors run_core_liveness_test.ts.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createLogger } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

/** Deps that finish the loop after one cycle. */
function oneCycleDeps(overrides?: Partial<RunCoreDeps>): RunCoreDeps {
  let cycleCount = 0;
  let nowValue = 0;
  return createMockDeps({
    now: () => nowValue,
    sleep: () => {
      cycleCount++;
      if (cycleCount >= 1) nowValue += 4000 * 1000;
      return Promise.resolve();
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("run_core - logs the work volume's standing totals beside the Concurrency line (Issue #244)", async () => {
  const logs: string[] = [];
  const line = "Work volume: total 18.4 GB — monitored repos 2.1 GB (15) · " +
    "side/data clones 15.2 GB (8: GRQ-shareprices2026Q2 7.3, …) · " +
    "build artefacts 6.3 GB (4 target dirs) · caches 0.6 GB · other 0.2 GB";
  let calls = 0;
  const deps = oneCycleDeps({
    log: (m: string) => logs.push(m),
    reportWorkVolumeUsage: () => {
      calls++;
      return Promise.resolve(line);
    },
  });
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);

  assertEquals(result.plannedShutdown, true);
  // Issue #345 changed this from one walk to two: cycle start, and again at
  // end of run where the volume is at its fullest. Still never per claim.
  assertEquals(
    calls,
    2,
    "the walk runs at cycle start and end of run, not per claim",
  );
  const concurrency = logs.findIndex((m) => m.startsWith("Concurrency:"));
  const usage = logs.indexOf(line);
  assert(concurrency >= 0, "expected the concurrency line");
  assertEquals(
    usage,
    concurrency + 1,
    "expected the standing totals immediately after the concurrency line",
  );
});

Deno.test("run_core - samples the work volume again at end of run, where the bytes are (Issue #345)", async () => {
  const logs: string[] = [];
  const calls: Array<{ label?: string; force?: boolean }> = [];
  const deps = oneCycleDeps({
    log: (m: string) => logs.push(m),
    reportWorkVolumeUsage: (options?: { label?: string; force?: boolean }) => {
      calls.push(options ?? {});
      return Promise.resolve(
        `${
          options?.label ?? "Work volume"
        }: total 18.4 GB — monitored repos 2.1 GB (15)`,
      );
    },
  });
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  await runCoreLoop(config, deps);

  assertEquals(calls.length, 2, "cycle start and end of run");
  assertEquals(calls[0]?.label, undefined);
  assertEquals(calls[1]?.label, "Work volume (end of run)");
  assertEquals(
    calls[1]?.force,
    true,
    "the end-of-run sample must be fresh, not a replay of the cycle-start walk",
  );
  assert(
    logs.some((m) => m.startsWith("Work volume (end of run): total ")),
    `expected the end-of-run totals in the log, got: ${logs.join(" | ")}`,
  );
});

Deno.test("run_core - two blind disk signals mark the host unhealthy, once per cycle (Issue #345)", async () => {
  const errors: string[] = [];
  const deps = oneCycleDeps({
    logError: (m: string) => errors.push(m),
    checkDiskTelemetry: () => ({
      blind: true,
      detail:
        "host-disk unknown (no launch baseline and df unreadable) and work-volume totals unknown",
    }),
  });
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);

  assertEquals(
    result.lastHealthCheckPassed,
    false,
    "a host that cannot see its own disk is not healthy",
  );
  const blind = errors.filter((m) => m.includes("[DISK_TELEMETRY_BLIND]"));
  assertEquals(
    blind.length,
    1,
    `expected exactly one line, got ${blind.length}`,
  );
  assert(blind[0]!.includes("df unreadable"), blind[0]);
});

Deno.test("run_core - one readable disk signal keeps the host healthy (Issue #345)", async () => {
  const errors: string[] = [];
  const deps = oneCycleDeps({
    logError: (m: string) => errors.push(m),
    checkDiskTelemetry: () => ({
      blind: false,
      detail: "both signals readable",
    }),
  });
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);

  assertEquals(result.lastHealthCheckPassed, true);
  assertEquals(errors.some((m) => m.includes("[DISK_TELEMETRY_BLIND]")), false);
});

Deno.test("run_core - a failed work-volume walk is reported loud and never stops the cycle (Issue #244)", async () => {
  const errors: string[] = [];
  const deps = oneCycleDeps({
    logError: (m: string) => errors.push(m),
    reportWorkVolumeUsage: () =>
      Promise.reject(new Error("du: cannot read directory")),
  });
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);

  assertEquals(result.plannedShutdown, true);
  assert(
    errors.some((m) =>
      m.includes("Work volume: standing totals unavailable") &&
      m.includes("du: cannot read directory")
    ),
    `expected the walk failure to be logged loud, got: ${errors.join(" | ")}`,
  );
});

Deno.test("run_core - omitting the work-volume hook is a no-op (Issue #244)", async () => {
  const logs: string[] = [];
  const deps = oneCycleDeps({ log: (m: string) => logs.push(m) });
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = 3600;

  const result = await runCoreLoop(config, deps);

  assertEquals(result.plannedShutdown, true);
  assertEquals(logs.some((m) => m.startsWith("Work volume:")), false);
});

Deno.test("production deps report work-volume degraded when the walk cannot measure (Issue #345)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // A work root that cannot be walked at all: a path *through* a file.
    await Deno.writeTextFile(`${tmp}/not-a-directory`, "x");
    const lines: string[] = [];
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir: tmp,
      workDir: `${tmp}/not-a-directory/work`,
      githubUser: "test-user",
      logger: createLogger({ write: (line: string) => lines.push(line) }),
      config: {
        ...buildDefaultWorkerConfig(),
        repos: ["stSoftwareAU/VibeCoder"],
      },
    });
    try {
      await deps.checkFeatureAvailability();
      assert(
        lines.some((l) => l.includes("Feature work-volume: degraded")),
        `expected a degraded work-volume feature, got: ${lines.join(" | ")}`,
      );
      assert(
        !lines.some((l) => l.includes("Feature work-volume: available")),
        "a blind probe must never be advertised as available",
      );
      const telemetry = deps.checkDiskTelemetry!();
      assert(
        telemetry.detail.includes("work-volume telemetry blind") ||
          telemetry.detail.includes("both disk signals blind"),
        `expected the blind volume to be named, got: ${telemetry.detail}`,
      );
    } finally {
      cleanup();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("production deps report both disk signals readable on a measurable host (Issue #345)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/VibeCoder`);
    await Deno.writeFile(
      `${tmp}/VibeCoder/payload.bin`,
      new Uint8Array(2 * 1024 * 1024),
    );
    const lines: string[] = [];
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir: tmp,
      workDir: tmp,
      githubUser: "test-user",
      logger: createLogger({ write: (line: string) => lines.push(line) }),
      config: {
        ...buildDefaultWorkerConfig(),
        repos: ["stSoftwareAU/VibeCoder"],
      },
    });
    try {
      await deps.checkFeatureAvailability();
      assert(
        lines.some((l) => l.includes("Feature work-volume: available")),
        `expected a measurable volume to be available, got: ${
          lines.join(" | ")
        }`,
      );
      const telemetry = deps.checkDiskTelemetry!();
      assertEquals(telemetry.blind, false);
    } finally {
      cleanup();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("production deps wire the standing totals to the real work root (Issue #244)", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/VibeCoder`);
    await Deno.mkdir(`${tmp}/GRQ-listing`);
    const { deps, cleanup } = await createProductionRunCoreDeps({
      repoDir: tmp,
      workDir: tmp,
      githubUser: "test-user",
      logger: createLogger({ write: () => {} }),
      config: {
        ...buildDefaultWorkerConfig(),
        repos: ["stSoftwareAU/VibeCoder"],
      },
    });
    try {
      assertEquals(typeof deps.reportWorkVolumeUsage, "function");
      const line = await deps.reportWorkVolumeUsage!();
      assert(
        line.startsWith("Work volume: total "),
        `unexpected line: ${line}`,
      );
      assert(line.includes("monitored repos"), line);
      assert(line.includes("(1: GRQ-listing "), line);
    } finally {
      cleanup();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
