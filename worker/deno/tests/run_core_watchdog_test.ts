/**
 * Tests for the per-iteration handler watchdog wired into the dispatch loop
 * (Issue #2473).
 *
 * Verifies that:
 *   1. A Priority 1.x handler whose `execute()` never resolves is abandoned on
 *      the hard timeout — the loop logs a `[watchdog]` line and proceeds to the
 *      next priority (and on to Priority 2 scanning) instead of awaiting
 *      forever. Uses an injected timer, so there is no real sleep.
 *   2. A handler resolving just under the soft threshold logs no warning; one
 *      just over logs a `[watchdog]` soft-warning.
 *   3. The abandonment the loop wires to `onTimeout` — `terminateActiveAgentRuns`
 *      with `keepTerminating: false` — ends a `runClaudeWithRetry` ladder that
 *      is asleep between attempts, while still clearing the terminating flag
 *      for the next priority (Issue #1667, preserving Issue #55).
 *
 * A minimal RunCoreDeps mock is rebuilt locally so the file is self-contained.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import {
  isAgentRunsTerminating,
  resetAgentRunsTerminating,
  runClaudeWithRetry,
  terminateActiveAgentRuns,
} from "../lib/claude_runner.ts";
import type { Logger } from "../types.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

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

Deno.test(
  "run_core watchdog - a never-resolving Priority 1 handler is abandoned and the loop advances",
  async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    let now = 0;
    let scanCount = 0;
    let refinementRan = false;
    let shutdownHandler: (() => void) | null = null;

    const deps = createMockDeps({
      log: (m) => logs.push(m),
      logError: (m) => errors.push(m),
      addSignalListener: (signal, handler) => {
        if (signal === "SIGTERM") shutdownHandler = handler;
      },
      now: () => now,
      // Injected timer fires immediately and advances the clock past the
      // hard timeout — no real sleep.
      watchdogDelay: (ms) => {
        now += ms;
        return Promise.resolve();
      },
      // Priority 1 (PR feedback) wedges forever.
      findAndProcessPrFeedback: () => new Promise(() => {}),
      // A later Priority 1.x handler must still run after the wedge.
      findAndProcessRefinement: () => {
        refinementRan = true;
        return Promise.resolve({ ok: true, value: { processed: false } });
      },
      findNextIssue: () => {
        scanCount++;
        // End the loop once the scan is reached after the wedged handler.
        if (shutdownHandler) shutdownHandler();
        return Promise.resolve({ ok: true, value: null });
      },
    });

    const config = createDefaultRunCoreConfig();

    await runCoreLoop(config, deps);

    const watchdogLine = errors.find((m) => m.includes("[watchdog]"));
    assert(
      watchdogLine !== undefined,
      `expected a [watchdog] timeout log, got errors: ${errors.join(" | ")}`,
    );
    assert(
      watchdogLine!.includes("Priority 1") &&
        watchdogLine!.includes("hard timeout"),
      `watchdog line must name the priority and hard timeout: ${watchdogLine}`,
    );
    assert(
      refinementRan,
      "loop must advance to a later priority after abandoning the wedged handler",
    );
    assert(
      scanCount >= 1,
      "loop must reach Priority 2 scanning after the wedge",
    );
  },
);

Deno.test(
  "run_core watchdog - soft threshold: under logs no warning, over logs a soft-warning",
  async () => {
    async function runWithDuration(
      handlerMs: number,
    ): Promise<string[]> {
      const logs: string[] = [];
      let now = 0;
      let shutdownHandler: (() => void) | null = null;

      const deps = createMockDeps({
        log: (m) => logs.push(m),
        addSignalListener: (signal, handler) => {
          if (signal === "SIGTERM") shutdownHandler = handler;
        },
        now: () => now,
        // Timer never fires — the handler always wins the race.
        watchdogDelay: () => new Promise<void>(() => {}),
        // Priority 1 (PR feedback) returns after advancing the clock.
        findAndProcessPrFeedback: () => {
          now += handlerMs;
          return Promise.resolve({ ok: true, value: { processed: false } });
        },
        findNextIssue: () => {
          if (shutdownHandler) shutdownHandler();
          return Promise.resolve({ ok: true, value: null });
        },
      });

      const config = createDefaultRunCoreConfig();
      // Soft threshold 120s by default; assert against it explicitly.
      assertEquals(config.handlerSoftTimeoutSeconds, 120);
      await runCoreLoop(config, deps);
      return logs;
    }

    // Just under the 120s soft threshold → no soft-warning.
    const underLogs = await runWithDuration(119_000);
    assert(
      !underLogs.some((m) => m.includes("[watchdog]")),
      `no [watchdog] line expected just under threshold: ${
        underLogs.filter((m) => m.includes("watchdog")).join(" | ")
      }`,
    );

    // Just over the soft threshold → soft-warning.
    const overLogs = await runWithDuration(130_000);
    const warning = overLogs.find((m) => m.includes("[watchdog]"));
    assert(
      warning !== undefined && warning.includes("slow"),
      `expected a [watchdog] soft-warning over threshold, got: ${
        overLogs.join(" | ")
      }`,
    );
  },
);

/** Basename the Issue #1667 stub appends one line to per spawn. */
const SPAWN_LOG = "spawns.log";

/** How many times the stub was spawned (0 when it never ran). */
async function spawnCount(stubDir: string): Promise<number> {
  try {
    const text = await Deno.readTextFile(`${stubDir}/${SPAWN_LOG}`);
    return text.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * How long a bounded rendezvous waits before failing the test. Never a sleep:
 * it only elapses when the awaited thing never arrives, and then the test
 * fails loudly instead of hanging the shard.
 */
const RENDEZVOUS_TIMEOUT_MS = 30_000;

/** Await `promise`, failing with `label` rather than hanging if it never settles. */
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let guard: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    guard = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      RENDEZVOUS_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(guard);
  }
}

// ---------------------------------------------------------------------------
// Issue #1667 — the abandonment path the loop wires up (`onTimeout` →
// `terminateActiveAgentRuns({ keepTerminating: false })`) must also end a
// retry ladder that is asleep between attempts. Such a ladder owns no pid, so
// before this the kill loop reached nothing and it woke minutes later — after
// the flag had been cleared — to spawn an attempt the watchdog had abandoned.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "run_core watchdog - abandonment ends a sleeping retry ladder and still clears the flag (Issue #1667)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAgentRunsTerminating();
    try {
      // A stub agent that records each spawn and always reports a rate
      // limit, so the ladder backs off and a relaunch is countable.
      const stubBody = [
        `printf 'spawn\\n' >> "$(dirname "$0")/${SPAWN_LOG}"`,
        `printf '%s\\n' '{"type":"result","result":"Credit balance is too low - rate limit exceeded"}'`,
        `exit 1`,
      ].join("\n");

      await withAgentStub(stubBody, async (stub) => {
        const clock = fakeClock();
        const sleeping = Promise.withResolvers<void>();
        const logger = {
          info: (m: string) => {
            if (m.includes("Retry 1 of 5")) sleeping.resolve();
          },
          warn: () => {},
          error: () => {},
          debug: () => {},
          security: () => {},
          skipReason: () => {},
          timing: () => {},
          scanSummary: () => {},
          workerSummary: () => {},
        } satisfies Logger;

        // The handler the watchdog will abandon: it never resolves on its own
        // because the ladder is asleep on a clock nobody advances.
        const ladder = runClaudeWithRetry(
          {
            clock,
            logger,
            prompt: "test",
            agentBinaryPath: stub.path,
            model: "haiku",
            enableModelFallback: false,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
          },
          { maxRetries: 5, maxWaitSeconds: 100_000, initialWaitInterval: 300 },
        );
        await within(sleeping.promise, "the ladder's first backoff");

        // Drive the real dispatch loop, wired to the real
        // `terminateActiveAgentRuns` — so the test proves run_core's own
        // `onTimeout` reaches the ladder, rather than mirroring it.
        const errors: string[] = [];
        let shutdownHandler: (() => void) | null = null;
        let now = 0;
        // Issue #55 is about what the NEXT priority sees, so sample the flag
        // there. The loop's own run-end cleanup sets it again afterwards.
        let terminatingAtNextPriority: boolean | undefined;
        const deps = createMockDeps({
          logError: (m) => errors.push(m),
          addSignalListener: (signal, handler) => {
            if (signal === "SIGTERM") shutdownHandler = handler;
          },
          now: () => now,
          watchdogDelay: (ms) => {
            now += ms;
            return Promise.resolve();
          },
          terminateActiveAgentRuns: async (reason, options) => {
            await terminateActiveAgentRuns(reason, undefined, options);
          },
          // Priority 1 is the abandoned handler: its ladder is asleep.
          findAndProcessPrFeedback: () =>
            ladder.then(() => ({
              ok: true as const,
              value: { processed: false },
            })),
          findAndProcessRefinement: () => {
            terminatingAtNextPriority = isAgentRunsTerminating();
            return Promise.resolve({ ok: true, value: { processed: false } });
          },
          findNextIssue: () => {
            if (shutdownHandler) shutdownHandler();
            return Promise.resolve({ ok: true, value: null });
          },
        });

        await within(
          runCoreLoop(createDefaultRunCoreConfig(), deps),
          "the dispatch loop to finish",
        );
        assert(
          errors.some((m) =>
            m.includes("[watchdog]") && m.includes("hard timeout")
          ),
          `expected a [watchdog] abandonment log, got: ${errors.join(" | ")}`,
        );

        // Issue #55 preserved: the next priority can still launch an agent.
        assertEquals(
          terminatingAtNextPriority,
          false,
          "the terminating flag is clear for the next priority",
        );

        // Issue #1667: the abandoned ladder has actually exited — no advance
        // of the clock, no further spawn, the run-end result shape.
        const result = await within(ladder, "the abandoned ladder to end");
        assert(result.ok);
        if (!result.ok) return;
        assertEquals(
          result.value.terminated,
          true,
          JSON.stringify(result.value),
        );
        assertEquals(result.value.exitCode, 143);
        assertEquals(
          await spawnCount(stub.dir),
          1,
          "the abandoned ladder never spawned again",
        );
      }, { prefix: "run_core_watchdog_ladder_" });
    } finally {
      resetAgentRunsTerminating();
    }
  },
});
