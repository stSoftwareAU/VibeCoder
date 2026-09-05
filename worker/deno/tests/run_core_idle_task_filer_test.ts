/**
 * Tests for the idle-task filer hook in run_core.ts (Issue #2005).
 *
 * Proves that:
 *   (a) `runIdleTaskFiler` is invoked after a fully-idle scan pass,
 *   (b) it is NOT invoked when an issue was processed successfully
 *       (i.e. `tracker.scanHadSuccess === true`),
 *   (c) a throw from the hook does not abort the main loop — the error
 *       is logged and the loop continues to planned shutdown.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import {
  IDLE_CYCLE_OBSERVER_ID,
  IDLE_DISAGREEMENT_BOUND_MS,
  IDLE_DISAGREEMENT_STATE_FILE,
  type IdleDisagreementState,
  loadIdleDisagreementState,
} from "../lib/idle_disagreement_streak.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal RunCoreDeps factory for these tests. Mirrors the helper in
 * `run_core_test.ts` but is kept locally so a future change to that
 * helper cannot silently alter the contract under test here.
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

// ---------------------------------------------------------------------------
// Issue #1051 — the bound in elapsed time, per starved observer, across runs
// ---------------------------------------------------------------------------

/**
 * How far apart idle observations actually arrive on the fleet: the
 * liveness-guard cadence, about nine minutes. The bound this replaced counted
 * three observations, which silently meant "roughly thirty-six minutes"; the
 * clock here moves at the real cadence so these tests state, in time, exactly
 * what they are asserting.
 */
const OBSERVATION_GAP_MS = 9 * 60 * 1000;

/** What the idle hooks should be told on every observation. */
type Disagreement = "audit" | "census" | "none";

/** One simulated worker run over a work directory that outlives it. */
interface IdleRunOptions {
  /** Epoch millis this run starts at — a restart continues the clock. */
  startMs: number;
  /** Run duration in seconds; the run stops once the clock passes it. */
  runSeconds: number;
  /** Idle observations to allow before the run's deadline lands. */
  observations: number;
  /** Milliseconds between observations (default: the liveness cadence). */
  gapMs?: number;
  disagreement: Disagreement;
  logs: string[];
  onFile: () => void;
}

/**
 * Deps for one simulated run.
 *
 * The clock moves only inside the idle-detect audit — one call per idle
 * observation — so elapsed disagreement is exactly `observations x gap` and
 * nothing else can drift it. The end-of-cycle sleep after the last allowed
 * observation carries the clock past this run's own deadline, which is how
 * an hourly worker stops.
 */
function idleRunDeps(opts: IdleRunOptions): RunCoreDeps {
  const endMs = opts.startMs + opts.runSeconds * 1000;
  const gapMs = opts.gapMs ?? OBSERVATION_GAP_MS;
  let nowValue = opts.startMs;
  let seen = 0;
  return createMockDeps({
    now: () => nowValue,
    sleep: () => {
      if (seen >= opts.observations) nowValue = Math.max(nowValue, endMs + 1);
      return Promise.resolve();
    },
    log: (m: string) => opts.logs.push(m),
    findNextIssue: () => Promise.resolve({ ok: true as const, value: null }),
    runIdleDetectAudit: () => {
      seen++;
      nowValue += gapMs;
      return Promise.resolve({
        claimableTotal: opts.disagreement === "audit" ? 4 : 0,
      });
    },
    runIdleDecisionCensus: () =>
      Promise.resolve({ inversionDetected: opts.disagreement === "census" }),
    runIdleTaskFiler: () => {
      opts.onFile();
      return Promise.resolve();
    },
  });
}

/** A serial config pinned to `workDir`, so the streak has somewhere to live. */
function idleRunConfig(workDir: string, runSeconds: number) {
  const config = createDefaultRunCoreConfig();
  config.runDurationSeconds = runSeconds;
  config.maxConcurrentIssues = 1;
  config.workDir = workDir;
  return config;
}

/** The persisted streak, as the next worker process would read it. */
function readStreakState(workDir: string): Promise<IdleDisagreementState> {
  return loadIdleDisagreementState(
    `${workDir}/${IDLE_DISAGREEMENT_STATE_FILE}`,
  );
}

Deno.test(
  "run_core - the disagreement streak survives a worker restart (Issue #1051)",
  async () => {
    // The defect: the streak lived in `runCoreLoop`'s own memory and the
    // worker restarts roughly hourly, so the count began at zero every hour
    // and the Issue #3526 bound could never be reached. Three disagreeing
    // observations, a restart, two more — the bound must trip.
    const workDir = await Deno.makeTempDir({ prefix: "idle_streak_restart_" });
    try {
      const logs: string[] = [];
      let filerRuns = 0;
      const onFile = () => filerRuns++;

      // Run one: three observations, 9 minutes apart, then the deadline.
      await runCoreLoop(
        idleRunConfig(workDir, 1800),
        idleRunDeps({
          startMs: 0,
          runSeconds: 1800,
          observations: 3,
          disagreement: "audit",
          logs,
          onFile,
        }),
      );
      assertEquals(
        filerRuns,
        0,
        "27 minutes of disagreement is inside the 20-minute bound only for " +
          "the first three observations; none should have forced a file yet",
      );
      const afterFirstRun = await readStreakState(workDir);
      assertEquals(
        afterFirstRun[IDLE_CYCLE_OBSERVER_ID] !== undefined,
        true,
        `expected the run to be persisted; got ${
          JSON.stringify(afterFirstRun)
        }`,
      );

      // Run two: a fresh worker process on the same volume, the clock
      // carrying on from where the first run stopped.
      await runCoreLoop(
        idleRunConfig(workDir, 1800),
        idleRunDeps({
          startMs: 1_800_001,
          runSeconds: 1800,
          observations: 2,
          disagreement: "audit",
          logs,
          onFile,
        }),
      );

      assertEquals(
        filerRuns,
        1,
        "expected the restarted run to inherit the streak and force exactly " +
          `one filer attempt; got ${filerRuns}`,
      );
      const forced = logs.filter((m) =>
        m.includes("invoking=idle-task-filer") &&
        m.includes("reason=audit_disagreement_bound_exceeded")
      );
      assertEquals(forced.length, 1, JSON.stringify(logs.slice(-8)));
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - a sibling slot's claim does not clear an idle slot's starvation (Issues #1051, #925)",
  async () => {
    // The second half of the defect: one counter shared by the whole pool,
    // cleared whenever *the fleet* claimed anything. In a two-slot pool the
    // busy slot's claims wiped out the starvation its idle sibling was
    // accumulating — the same fault `slot_idle_accounting.ts` removed from
    // the accounting half, where "half the fleet was invisible".
    //
    // Four eight-minute runs of a two-slot pool. In each, `s1` claims the
    // one repository that has work and `s2` is shown an empty backlog and
    // idles. `s2` must reach the bound even though the fleet claimed
    // something on every single run.
    const workDir = await Deno.makeTempDir({ prefix: "idle_streak_slots_" });
    const BUSY_REPO = "org/busy";
    /** Wall seconds per run — four of them span more than the bound. */
    const RUN_SECONDS = 480;
    try {
      const logs: string[] = [];
      let filerRuns = 0;

      /** One run of a two-slot pool: one slot claims, its sibling starves. */
      const runPool = async (startMs: number) => {
        const endMs = startMs + RUN_SECONDS * 1000;
        let nowValue = startMs;
        let observed = 0;
        let claims = 0;
        /**
         * Ends the busy slot's claim. Held until its sibling has made its
         * idle observation, because a slot only idles while a sibling is
         * working — the pool otherwise drains on "no eligible work" and the
         * starved slot is never seen at all.
         */
        let finishClaim: (() => void) | undefined;
        const deps = createMockDeps({
          now: () => nowValue,
          sleep: () => {
            // The starved slot re-scans until the deadline, so once it has
            // made its observation the run is carried to its own deadline —
            // an hourly worker stopping with the fleet still divided.
            if (observed > 0) nowValue = Math.max(nowValue, endMs + 1);
            return Promise.resolve();
          },
          log: (m: string) => logs.push(m),
          // One repository, one issue in it per run. The slot that wins it
          // holds it; its sibling is shown an empty backlog.
          findNextIssue: (options) =>
            Promise.resolve({
              ok: true as const,
              value: claims > 0 || options?.excludeRepos?.has(BUSY_REPO)
                ? null
                : {
                  repo: BUSY_REPO,
                  issueNumber: 1051,
                  issueTitle: "busy",
                  milestoneTitle: "",
                },
            }),
          processIssue: () => {
            claims++;
            return new Promise((resolve) => {
              const done = () =>
                resolve({ ok: true as const, value: { success: true } });
              if (observed > 0) done();
              else finishClaim = done;
            });
          },
          runIdleDetectAudit: () => {
            observed++;
            nowValue += 4 * 60 * 1000;
            finishClaim?.();
            finishClaim = undefined;
            return Promise.resolve({ claimableTotal: 4 });
          },
          runIdleDecisionCensus: () =>
            Promise.resolve({ inversionDetected: false }),
          runIdleTaskFiler: () => {
            filerRuns++;
            return Promise.resolve();
          },
        });
        const config = idleRunConfig(workDir, RUN_SECONDS);
        config.maxConcurrentIssues = 2;
        await runCoreLoop(config, deps);
        assertEquals(claims, 1, "the sibling must have claimed this run");
        assertEquals(observed, 1, "the starved slot must have observed once");
      };

      let clock = 0;
      for (let run = 1; run <= 3; run++) {
        await runPool(clock);
        clock += RUN_SECONDS * 1000 + 1;
        assertEquals(
          filerRuns,
          0,
          `run ${run} is inside the bound; nothing should have been forced`,
        );
      }

      // The starvation survived three runs in which the fleet claimed work.
      const persisted = await readStreakState(workDir);
      const starved = Object.keys(persisted).filter((id) =>
        id !== IDLE_CYCLE_OBSERVER_ID
      );
      assertEquals(
        starved.length,
        1,
        `expected exactly one starved slot to be counted; got ${
          JSON.stringify(persisted)
        }`,
      );
      assertEquals(
        persisted[IDLE_CYCLE_OBSERVER_ID],
        undefined,
        "the cycle gate saw the fleet claim work, so its own run — and only " +
          "its own — must have been cleared",
      );

      // A fourth run carries the starved slot past the bound.
      await runPool(clock);

      assertEquals(
        filerRuns,
        1,
        "expected the starved slot to force exactly one filer attempt " +
          `despite its sibling claiming on every run; logs: ${
            JSON.stringify(logs.filter((m) => m.includes("[idle-hooks]")))
          }`,
      );
      const forced = logs.filter((m) =>
        m.includes("invoking=idle-task-filer") &&
        m.includes("reason=audit_disagreement_bound_exceeded")
      );
      assertEquals(forced.length, 1);
      assertEquals(
        forced[0]!.includes(`observer=${starved[0]}`),
        true,
        `the forced attempt must name the starved slot; got ${forced[0]}`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - a fast cadence still forces one file per bound, not one per cycle (Issues #1051, #2106)",
  async () => {
    // The flooding direction. Expressed in cycles, the bound fired every
    // fourth observation — at the 30-second scan cadence that is a wrapper
    // every two minutes. Expressed in time, the same 45 observations over
    // 22.5 minutes force exactly one.
    const workDir = await Deno.makeTempDir({ prefix: "idle_streak_flood_" });
    try {
      const logs: string[] = [];
      let filerRuns = 0;
      const observations = 45;
      const gapMs = 30 * 1000;

      await runCoreLoop(
        idleRunConfig(workDir, 7200),
        idleRunDeps({
          startMs: 0,
          runSeconds: 7200,
          observations,
          gapMs,
          disagreement: "audit",
          logs,
          onFile: () => filerRuns++,
        }),
      );

      // 45 observations 30s apart span 22 minutes — one bound, one file.
      assertEquals(
        (observations - 1) * gapMs > IDLE_DISAGREEMENT_BOUND_MS,
        true,
        "the test must span more than one bound or it proves nothing",
      );
      assertEquals(
        filerRuns,
        1,
        `expected exactly one forced attempt across ${observations} ` +
          `observations; got ${filerRuns}`,
      );
      assertEquals(
        logs.filter((m) => m.includes("action=audit_scan_disagreement")).length,
        observations,
        "every observation must still emit its diagnostic",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - a clean fleet keeps no streak and files as usual (Issue #1051)",
  async () => {
    // No disagreement at all: the filer runs every cycle and nothing is
    // counted, so a quiet fleet cannot accumulate its way into a forced
    // attempt later.
    const workDir = await Deno.makeTempDir({ prefix: "idle_streak_clean_" });
    try {
      const logs: string[] = [];
      let filerRuns = 0;

      await runCoreLoop(
        idleRunConfig(workDir, 1800),
        idleRunDeps({
          startMs: 0,
          runSeconds: 1800,
          observations: 3,
          disagreement: "none",
          logs,
          onFile: () => filerRuns++,
        }),
      );

      assertEquals(filerRuns, 3, "an undisputed idle cycle always files");
      assertEquals(
        logs.filter((m) => m.includes("action=audit_scan_disagreement")).length,
        0,
        "nothing disagreed, so nothing may be reported as a disagreement",
      );
      assertEquals(
        await readStreakState(workDir),
        {},
        "a clean fleet leaves no run behind",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - a state file from an older version is read, not fatal (Issue #1051)",
  async () => {
    // A launcher that dies parsing its own state file is worse than the bug
    // it was tracking. The pre-#1051 shape carried `{count, lastCycleId}`
    // and no timestamps; a half-written file carries nothing parseable at
    // all. Both must read as "no run recorded" and the worker must run.
    const workDir = await Deno.makeTempDir({ prefix: "idle_streak_stale_" });
    const statePath = `${workDir}/${IDLE_DISAGREEMENT_STATE_FILE}`;
    try {
      const olderShape = JSON.stringify({
        s1: { count: 5, lastCycleId: "cycle-7" },
        cycle: "not-an-entry",
        s2: null,
      });
      await Deno.writeTextFile(statePath, olderShape);
      assertEquals(
        await loadIdleDisagreementState(statePath),
        {},
        "an entry with no timestamps is not an entry — its observer starts " +
          "a fresh run rather than inheriting a count in another unit",
      );

      const logs: string[] = [];
      let filerRuns = 0;
      const result = await runCoreLoop(
        idleRunConfig(workDir, 1800),
        idleRunDeps({
          startMs: 0,
          runSeconds: 1800,
          observations: 2,
          disagreement: "audit",
          logs,
          onFile: () => filerRuns++,
        }),
      );

      assertEquals(result.plannedShutdown, true, "the run must complete");
      assertEquals(
        filerRuns,
        0,
        "an unreadable file starts a fresh run rather than forcing a file",
      );

      // A truncated file is the other half of the same promise: the read
      // that would have thrown must not.
      const truncated = '{"cycle": {"sinceMs": ';
      assertThrows(() => JSON.parse(truncated));
      await Deno.writeTextFile(statePath, truncated);
      assertEquals(await loadIdleDisagreementState(statePath), {});
      const second = await runCoreLoop(
        idleRunConfig(workDir, 1800),
        idleRunDeps({
          startMs: 1_800_001,
          runSeconds: 1800,
          observations: 2,
          disagreement: "audit",
          logs,
          onFile: () => filerRuns++,
        }),
      );
      assertEquals(second.plannedShutdown, true);
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - idle pass invokes runIdleTaskFiler (Issue #2005)",
  async () => {
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        // After the first cycle's end-of-cycle sleep, advance the clock
        // past `endTime` so the loop exits cleanly.
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);
    // On a fully-idle cycle the filer hook must be invoked at least once.
    assertEquals(invocations >= 1, true);
  },
);

Deno.test(
  "run_core - successful issue cycle skips runIdleTaskFiler (Issue #2005)",
  async () => {
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    let findCalls = 0;
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
        if (findCalls === 1) {
          return Promise.resolve({
            ok: true as const,
            value: {
              repo: "org/repo",
              issueNumber: 1,
              issueTitle: "Issue 1",
              milestoneTitle: "",
            },
          });
        }
        return Promise.resolve({ ok: true as const, value: null });
      },
      processIssue: () =>
        Promise.resolve({ ok: true as const, value: { success: true } }),
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);
    // A cycle that processed an issue is not idle — the filer stays silent.
    assertEquals(invocations, 0);
  },
);

Deno.test(
  "run_core - runIdleTaskFiler failure does not break main loop (Issue #2005)",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      runIdleTaskFiler: () =>
        Promise.reject(new Error("simulated filer crash")),
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);
    // The loop must complete cleanly — the filer crash is logged but
    // does not abort the main loop.
    assertEquals(result.plannedShutdown, true);
    assertEquals(
      logs.some((m) =>
        m.includes("Idle-task filer failed") &&
        m.includes("simulated filer crash")
      ),
      true,
      "expected the filer crash to be logged",
    );
  },
);

// Note (Issue #2023): the legacy `runIdleSecurityScan` hook was removed.
// The framework-side `runIdleTaskFiler` is now the sole idle hook, so the
// "both hooks fire" and "scan-throw does not block filer" coexistence tests
// from PR #2005 are obsolete and have been deleted.

Deno.test(
  "run_core - Priority 1 processed work does not suppress filer when Priority 2 is empty (Issue #2048)",
  async () => {
    // Regression for Issue #2048: previously the filer was gated on the
    // broad `scanHadSuccess` flag, so any Priority 1–1.85 handler
    // returning `{ processed: true }` suppressed the filer even when
    // the Priority 2 scan found no claimable issue. The new gate is
    // `foundClaimableIssue`, set only from the Priority 2 success
    // path — so a busy PR-feedback handler must not stop idle-task
    // filing when there is genuinely nothing to claim.
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      // Priority 1 (PR Feedback) processed work this cycle.
      findAndProcessPrFeedback: () =>
        Promise.resolve({ ok: true, value: { processed: true } }),
      // Priority 2 found no claimable issue.
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      invocations >= 1,
      true,
      "expected the filer to fire when Priority 2 found nothing, even though Priority 1 processed work",
    );

    // And the decision line must surface both flags: scanHadSuccess=true
    // (because Priority 1 ran), foundClaimableIssue=false (because no
    // issue was claimed) — proving the new gate is what fired the filer.
    const invokingLine = logs.find((m) =>
      m.includes("[idle-hooks]") &&
      m.includes("invoking=idle-task-filer") &&
      m.includes("foundClaimableIssue=false") &&
      m.includes("scanHadSuccess=true")
    );
    assertEquals(
      invokingLine !== undefined,
      true,
      `expected an [idle-hooks] invoking line with foundClaimableIssue=false scanHadSuccess=true; got: ${
        JSON.stringify(logs)
      }`,
    );
  },
);

Deno.test(
  "run_core - census inversion suppresses the idle-task filer (Issue #2813)",
  async () => {
    // The cache-backed idle-decision census reports that an open,
    // unblocked top-priority/work-on/low-priority issue exists somewhere
    // in the monitored set — even if it was only deferred this cycle by
    // nice/rotation/cooldown. The filer must be suppressed so an idle-task
    // is not filed while real work waits (the filing half of #2806).
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      log: (m: string) => logs.push(m),
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleDecisionCensus: () => Promise.resolve({ inversionDetected: true }),
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      invocations,
      0,
      "expected the filer to be suppressed when the census detects unblocked work",
    );
    const skipLine = logs.find((m) =>
      m.includes("[idle-hooks]") &&
      m.includes("skipping=idle-task-filer") &&
      m.includes("reason=unblocked_work_exists")
    );
    assertEquals(
      skipLine !== undefined,
      true,
      `expected an [idle-hooks] skip line with reason=unblocked_work_exists; got: ${
        JSON.stringify(logs)
      }`,
    );
  },
);

Deno.test(
  "run_core - persistent census inversion forces one filer attempt after the bound (Issue #3526)",
  async () => {
    // Regression for Issue #3526 (host-23 starvation incident): the census
    // counted PR-blocked issues as "unblocked work" and its inversion
    // verdict both suppressed the filer AND reset the #2475 disagreement
    // streak, so the bounded escape could never fire — the worker sat idle
    // for hours, neither claiming work nor filing idle-tasks. The census
    // branch must participate in the streak: once the disagreement has run
    // for longer than the bound, exactly one filer attempt is forced
    // through and the run restarts (Issue #1051 made the bound elapsed
    // time rather than a cycle count).
    const workDir = await Deno.makeTempDir({ prefix: "idle_streak_census_" });
    try {
      const logs: string[] = [];
      let invocations = 0;

      // Four observations, nine minutes apart: 27 minutes of uninterrupted
      // inversion against a 20-minute bound.
      await runCoreLoop(
        idleRunConfig(workDir, 3600),
        idleRunDeps({
          startMs: 0,
          runSeconds: 3600,
          observations: 4,
          disagreement: "census",
          logs,
          onFile: () => invocations++,
        }),
      );

      assertEquals(
        invocations,
        1,
        "expected exactly one forced filer attempt once the inversion had " +
          "run for longer than the bound",
      );
      const suppressed = logs.filter((m) =>
        m.includes("skipping=idle-task-filer") &&
        m.includes("reason=unblocked_work_exists")
      );
      assertEquals(
        suppressed.length,
        3,
        "expected every observation inside the bound to be suppressed",
      );
      const forced = logs.find((m) =>
        m.includes("invoking=idle-task-filer") &&
        m.includes("reason=census_inversion_bound_exceeded")
      );
      assertEquals(
        forced !== undefined,
        true,
        `expected an [idle-hooks] invoking line with reason=census_inversion_bound_exceeded; got: ${
          JSON.stringify(logs.filter((m) => m.includes("[idle-hooks]")))
        }`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - census-inversion streak resets after the forced filer attempt (Issue #3526)",
  async () => {
    // After the bound forces a filer attempt the run must restart, so the
    // next forced attempt only happens after another full bound of
    // suppressed observations — wrapper flooding stays impossible.
    const workDir = await Deno.makeTempDir({ prefix: "idle_streak_reset_" });
    try {
      const logs: string[] = [];
      let invocations = 0;

      // Seven observations nine minutes apart: the bound is crossed at the
      // fourth (27 minutes) and again at the seventh (27 more).
      await runCoreLoop(
        idleRunConfig(workDir, 7200),
        idleRunDeps({
          startMs: 0,
          runSeconds: 7200,
          observations: 7,
          disagreement: "census",
          logs,
          onFile: () => invocations++,
        }),
      );

      assertEquals(
        invocations,
        2,
        "expected one forced attempt per full bound of suppressed cycles",
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - census without inversion still files the idle-task (Issue #2813)",
  async () => {
    // Regression guard: when the census reports no inversion the filer must
    // still fire on a fully-idle cycle.
    let invocations = 0;
    let cycleCount = 0;
    let nowValue = 0;
    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) {
          nowValue += 4000 * 1000;
        }
        return Promise.resolve();
      },
      findNextIssue: () => Promise.resolve({ ok: true, value: null }),
      runIdleDecisionCensus: () =>
        Promise.resolve({ inversionDetected: false }),
      runIdleTaskFiler: () => {
        invocations++;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(
      invocations >= 1,
      true,
      "expected the filer to fire when the census reports no inversion",
    );
  },
);
