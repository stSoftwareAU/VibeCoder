/**
 * Tests for the idle-detect audit hook in run_core.ts (Issue #2106).
 *
 * Proves that:
 *   1. On an idle pass (`foundClaimableIssue === false`), the loop
 *      invokes `runIdleDetectAudit` with a monotonic tick counter and
 *      the current `scanFoundClaimable` flag — before the existing
 *      `runIdleTaskFiler` hook fires, so its `[idle-detect] ...` lines
 *      precede the filer's `[idle-task] ...` lines in the worker log.
 *   2. On a busy pass (a Priority 2 issue was claimed and processed),
 *      `runIdleDetectAudit` is NOT invoked — the audit only runs when
 *      the gate is open.
 *   3. The tick counter increments across idle cycles.
 *   4. A throw from the audit hook is caught and logged so the main
 *      loop continues uninterrupted.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createDefaultRunCoreConfig,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import {
  IDLE_CYCLE_OBSERVER_ID,
  IDLE_DISAGREEMENT_BOUND_MS,
  idleDisagreementStatePath,
  loadIdleDisagreementState,
} from "../lib/idle_disagreement_streak.ts";

/**
 * How far apart idle observations arrive on the fleet — the liveness-guard
 * cadence. Since Issue #1051 the disagreement bound is elapsed time, so the
 * cycles below advance a mock clock at the real cadence: four observations
 * nine minutes apart span 27 minutes against a 20-minute bound.
 */
const OBSERVATION_GAP_MS = 9 * 60 * 1000;

// ---------------------------------------------------------------------------
// Test helper — reuses the shape from run_core_idle_hooks_visibility_test.ts.
// ---------------------------------------------------------------------------

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
 * Deps that drive `cycles` idle observations at the fleet's cadence, every one
 * of them a probe/scan disagreement, then push the clock past the run's end.
 *
 * The disagreement cases below differ only in how many observations they drive
 * and what they read back afterwards, so the deps are built once here.
 *
 * @param cycles - Observations before the clock jumps past the run's end.
 * @param counters - `filerRuns` counts the attempts the bound forced through.
 * @param logs - Collects the worker log; omit when a case reads none of it.
 * @returns Mock deps ready to hand to `runCoreLoop`.
 */
function createDisagreementDeps(
  cycles: number,
  counters: { filerRuns: number },
  logs: string[] = [],
): RunCoreDeps {
  let observed = 0;
  let nowValue = 0;
  return createMockDeps({
    now: () => nowValue,
    sleep: () => {
      if (observed >= cycles) nowValue += 4000 * 1000;
      return Promise.resolve();
    },
    log: (m) => logs.push(m),
    runIdleDetectAudit: () => {
      observed++;
      nowValue += OBSERVATION_GAP_MS;
      return Promise.resolve({ claimableTotal: 4 });
    },
    runIdleTaskFiler: () => {
      counters.filerRuns += 1;
      return Promise.resolve();
    },
  });
}

/** The disagreement diagnostics a run emitted, in order. */
function disagreementLines(logs: string[]): string[] {
  return logs.filter((l) => l.includes("action=audit_scan_disagreement"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - idle pass invokes runIdleDetectAudit before runIdleTaskFiler",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    const auditCalls: Array<{ tick: number; scanFoundClaimable: boolean }> = [];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      // Each hook emits its representative diagnostic line into the worker
      // log, mirroring what the real `runIdleDetectAudit` / `runIdleTaskFiler`
      // deps do — so the test can assert against the observable artefact.
      runIdleDetectAudit: ({ tick, scanFoundClaimable }) => {
        logs.push("[idle-detect] audit probe complete");
        auditCalls.push({ tick, scanFoundClaimable });
        return Promise.resolve();
      },
      runIdleTaskFiler: () => {
        logs.push("[idle-task] filing wrapper");
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(auditCalls.length, 1);
    assertEquals(auditCalls[0]!.tick, 1);
    assertEquals(auditCalls[0]!.scanFoundClaimable, false);
    // Observable contract: the audit's `[idle-detect] ...` diagnostic line
    // appears before the filer's `[idle-task] ...` line in the worker log, so
    // an operator reading the log sees audit diagnostics first. Asserting
    // against the captured log output (the observable artefact) rather than an
    // internal call-order array keeps the test robust to behaviour-preserving
    // refactors of the dispatch sequence.
    const auditLine = logs.findIndex((l) => l.includes("[idle-detect]"));
    const filerLine = logs.findIndex((l) => l.includes("[idle-task]"));
    assert(
      auditLine !== -1,
      "expected an [idle-detect] line in the worker log",
    );
    assert(filerLine !== -1, "expected an [idle-task] line in the worker log");
    assert(
      auditLine < filerLine,
      `expected audit log before filer log; got: ${logs.join("\n")}`,
    );
  },
);

Deno.test(
  "run_core - busy pass (claimable issue found) does NOT invoke runIdleDetectAudit",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    let findCalls = 0;
    let auditCalls = 0;

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
              issueNumber: 42,
              issueTitle: "An issue",
              milestoneTitle: "",
            },
          });
        }
        return Promise.resolve({ ok: true as const, value: null });
      },
      processIssue: () =>
        Promise.resolve({ ok: true as const, value: { success: true } }),
      runIdleDetectAudit: () => {
        auditCalls += 1;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(auditCalls, 0);
  },
);

Deno.test(
  "run_core - tick counter advances monotonically across consecutive idle cycles",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const ticks: number[] = [];

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        // Advance the clock just enough each iteration so the inner
        // while keeps spinning. After 3 cycles, jump past endTime.
        nowValue += 100;
        if (cycleCount >= 3) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      runIdleDetectAudit: ({ tick }) => {
        ticks.push(tick);
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assert(ticks.length >= 3, `expected at least 3 ticks, got ${ticks.length}`);
    // Strictly increasing.
    for (let i = 1; i < ticks.length; i++) {
      assert(
        ticks[i]! > ticks[i - 1]!,
        `tick counter regressed: ${ticks.join(",")}`,
      );
    }
    assertEquals(ticks[0], 1);
  },
);

Deno.test(
  "run_core - filer is skipped when audit reports claimableTotal > 0 (budget guard)",
  async () => {
    // Mis-classification budget guard: when the independent audit probe
    // sees claimable work but the scan loop reports `foundClaimableIssue
    // = false`, the next iteration's GraphQL budget is more valuable
    // than filing yet another wrapper. Skipping the filer here is what
    // breaks the rate-limit-burning loop observed against private-repo-10
    // #45-#48.
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    let filerRan = false;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      log: (m) => logs.push(m),
      runIdleDetectAudit: () => Promise.resolve({ claimableTotal: 4 }),
      runIdleTaskFiler: () => {
        filerRan = true;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(filerRan, false);
    const skipLine = logs.find((l) =>
      l.includes("[idle-hooks]") &&
      l.includes("skipping=idle-task-filer") &&
      l.includes("reason=audit_found_claimable") &&
      l.includes("claimable_total=4")
    );
    assert(
      skipLine !== undefined,
      `expected budget-guard skip line; got: ${logs.join("\n")}`,
    );
  },
);

Deno.test(
  "run_core - filer still runs when audit reports claimableTotal === 0",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    let filerRan = false;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      runIdleDetectAudit: () => Promise.resolve({ claimableTotal: 0 }),
      runIdleTaskFiler: () => {
        filerRan = true;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    assertEquals(filerRan, true);
  },
);

Deno.test(
  "run_core - persistent audit/scan disagreement eventually forces one filer attempt and emits a diagnostic (Issue #2475)",
  async () => {
    // Drive idle cycles at the real observation cadence, each with the
    // probe reporting claimable work while the scan reports none. Every
    // cycle inside the bound must skip; the first past it must force a
    // single filer attempt. Without the #2475 bound the filer would be
    // suppressed forever. Since Issue #1051 the bound is elapsed time,
    // so the clock — not the cycle count — is what drives it.
    const cycles = 4;
    const logs: string[] = [];
    const counters = { filerRuns: 0 };
    const deps = createDisagreementDeps(cycles, counters, logs);
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    // The drive has to outlast the bound or it proves nothing.
    assert((cycles - 1) * OBSERVATION_GAP_MS > IDLE_DISAGREEMENT_BOUND_MS);

    await runCoreLoop(config, deps);

    // Exactly one filer attempt across the whole run — the bound forced
    // it through once, no more.
    assertEquals(counters.filerRuns, 1);

    // A disagreement diagnostic on every idle cycle.
    assertEquals(disagreementLines(logs).length, cycles);

    // The bound-exceeded forced-attempt line is present exactly once.
    const forced = logs.filter((l) =>
      l.includes("invoking=idle-task-filer") &&
      l.includes("reason=audit_disagreement_bound_exceeded")
    );
    assertEquals(forced.length, 1);
  },
);

Deno.test(
  "run_core - bounded short-circuit allows at most one filer attempt per disagreement run (no flooding) (Issue #2475)",
  async () => {
    // Over a full bound window the filer must fire at most once — the
    // remaining cycles stay skipped. This guards against re-introducing
    // the wrapper flooding the #2106 budget guard prevents.
    const cycles = 4;
    const logs: string[] = [];
    const counters = { filerRuns: 0 };
    const deps = createDisagreementDeps(cycles, counters, logs);
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    await runCoreLoop(config, deps);

    // At most one attempt across the bound window.
    assertEquals(counters.filerRuns, 1);

    // Every cycle inside the bound was skipped via the budget guard.
    const skips = logs.filter((l) =>
      l.includes("skipping=idle-task-filer") &&
      l.includes("reason=audit_found_claimable")
    );
    assertEquals(skips.length, cycles - 1);
  },
);

Deno.test(
  "run_core - disagreement streak resets after a forced attempt so a second window fires again (Issue #2475)",
  async () => {
    // Two full bound windows → exactly two forced attempts. Proves the
    // run restarts after each forced attempt rather than firing every
    // cycle thereafter.
    const counters = { filerRuns: 0 };
    const deps = createDisagreementDeps(7, counters);
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 7200;

    await runCoreLoop(config, deps);

    assertEquals(counters.filerRuns, 2);
  },
);

// ---------------------------------------------------------------------------
// Issue #1177 — the streak's work directory is an argument, never the ambient
// environment. The two cases above failed roughly three parallel runs in five
// because the loop fell back to `WORK_DIR` and every test process then shared
// the live fleet's `idle_disagreement_streak.json`; `resolveRunStateWorkDir`
// carries that story. Measured here: six concurrent runs of this file failed
// six times with the variable set and passed six times with it unset.
//
// These four cases hold the fix — a planted `WORK_DIR` resolves to nothing, no
// directory means no file, a named directory still persists, and two loops
// that name none cannot reach each other's streak.
// ---------------------------------------------------------------------------

Deno.test(
  "run_core - a planted WORK_DIR never becomes the loop's state directory (Issue #1177)",
  async () => {
    // The guard the other three cannot give on their own: they only go red on
    // a host that exports `WORK_DIR`, and the gate scrubs it from the test
    // stage (Issue #1098), so re-introducing the fallback would merge green.
    // The variable is planted in a child process rather than in this one —
    // mutating the runner's own environment is what the parallel-unsafe
    // manifest exists to keep out of this pass — and the child asks the real
    // resolver what the loop would use.
    const planted = "/planted/by/the/parent/work-dir";
    const named = "/named/by/the/caller";
    const module = import.meta.resolve("../lib/run_core.ts");
    const script = `
      const core = await import(${JSON.stringify(module)});
      const base = core.createDefaultRunCoreConfig();
      console.log(JSON.stringify({
        own: Deno.env.get("WORK_DIR") ?? "ABSENT-IN-CHILD",
        unnamed: core.resolveRunStateWorkDir(base) ?? "ABSENT",
        named: core.resolveRunStateWorkDir(
          { ...base, workDir: ${JSON.stringify(named)} },
        ) ?? "ABSENT",
      }));
    `;
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", "--no-check", "--allow-env", "--allow-read", script],
      env: { ...Deno.env.toObject(), WORK_DIR: planted },
      stdout: "piped",
      stderr: "piped",
    });
    const result = await child.output();
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 0, stderr);

    const observed = JSON.parse(
      new TextDecoder().decode(result.stdout).trim().split("\n").at(-1)!,
    );
    assertEquals(
      observed.own,
      planted,
      "the child must carry the planted variable, or this proves nothing",
    );
    assertEquals(
      observed.unnamed,
      "ABSENT",
      "a config naming no work directory must resolve to none, whatever " +
        "WORK_DIR says",
    );
    // And the argument still works: this is a removed fallback, not removed
    // persistence.
    assertEquals(observed.named, named);
  },
);

Deno.test(
  "run_core - a config naming no workDir keeps the streak in memory, whatever WORK_DIR says (Issue #1177)",
  async () => {
    const counters = { filerRuns: 0 };
    const logs: string[] = [];
    const deps = createDisagreementDeps(4, counters, logs);
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;
    assertEquals(config.workDir, undefined);

    await runCoreLoop(config, deps);

    // Every diagnostic says the run behind it is not on a volume — which is
    // the whole claim: an ambient `WORK_DIR` is not a work directory this
    // caller asked for, so nothing is written and nothing is shared.
    const lines = disagreementLines(logs);
    assert(
      lines.length > 0,
      `expected disagreement lines; got: ${logs.join("\n")}`,
    );
    for (const line of lines) {
      assert(
        line.includes("persisted=false"),
        `expected an in-memory streak; got: ${line}`,
      );
    }
    // In memory is still a streak: the bound still forces its one attempt.
    assertEquals(counters.filerRuns, 1);
  },
);

Deno.test(
  "run_core - a config naming a workDir still persists the streak there (Issue #1177)",
  async () => {
    // The other half of the contract. Dropping the environment fallback must
    // not quietly drop persistence — the run that names a directory writes to
    // it, which is what lets the bound survive the hourly restart (#1051).
    const workDir = await Deno.makeTempDir({ prefix: "run_core_streak_" });
    try {
      const counters = { filerRuns: 0 };
      const logs: string[] = [];
      const deps = createDisagreementDeps(4, counters, logs);
      const config = createDefaultRunCoreConfig();
      config.runDurationSeconds = 3600;
      config.workDir = workDir;

      await runCoreLoop(config, deps);

      const lines = disagreementLines(logs);
      assert(
        lines.length > 0,
        `expected disagreement lines; got: ${logs.join("\n")}`,
      );
      for (const line of lines) {
        assert(
          line.includes("persisted=true"),
          `expected a persisted streak; got: ${line}`,
        );
      }
      assertEquals(counters.filerRuns, 1);

      const state = await loadIdleDisagreementState(
        idleDisagreementStatePath(workDir),
      );
      assert(
        state[IDLE_CYCLE_OBSERVER_ID] !== undefined,
        `expected the cycle observer's run in ${
          idleDisagreementStatePath(workDir)
        }; got ${JSON.stringify(state)}`,
      );
    } finally {
      await Deno.remove(workDir, { recursive: true });
    }
  },
);

Deno.test(
  "run_core - two concurrent loops without a workDir do not share a streak (Issue #1177)",
  async () => {
    // The flake in miniature, and the reason the fallback had to go rather
    // than the suites being told to name a temp directory each: two runs of
    // the loop that name no work directory must not be able to reach each
    // other's bookkeeping, whichever process they are in. Sharing one file,
    // the observer id is the same (`cycle`) for both, so one run's restart
    // lands on the other's entry and its forced attempt never comes.
    const first = { filerRuns: 0 };
    const second = { filerRuns: 0 };
    const firstLogs: string[] = [];
    const secondLogs: string[] = [];
    const configFor = () => {
      const config = createDefaultRunCoreConfig();
      config.runDurationSeconds = 3600;
      return config;
    };

    await Promise.all([
      runCoreLoop(configFor(), createDisagreementDeps(4, first, firstLogs)),
      runCoreLoop(configFor(), createDisagreementDeps(4, second, secondLogs)),
    ]);

    assertEquals(first.filerRuns, 1);
    assertEquals(second.filerRuns, 1);

    // Each loop counted only its own observations. Sharing one entry, the
    // observations of the two interleave and neither reads 1,2,3,4 — which is
    // what the `streak=` fragment is there to make visible.
    for (const logs of [firstLogs, secondLogs]) {
      const streaks = disagreementLines(logs).map((line) =>
        Number(line.match(/streak=(\d+)/)?.[1])
      );
      assertEquals(
        streaks,
        [1, 2, 3, 4],
        `interleaved run: ${logs.join("\n")}`,
      );
    }
  },
);

Deno.test(
  "run_core - audit hook throwing does not abort the main loop; filer still runs",
  async () => {
    let cycleCount = 0;
    let nowValue = 0;
    const logs: string[] = [];
    let filerRan = false;

    const deps = createMockDeps({
      now: () => nowValue,
      sleep: () => {
        cycleCount++;
        if (cycleCount >= 1) nowValue += 4000 * 1000;
        return Promise.resolve();
      },
      log: (m) => logs.push(m),
      runIdleDetectAudit: () => Promise.reject(new Error("probe blew up")),
      runIdleTaskFiler: () => {
        filerRan = true;
        return Promise.resolve();
      },
    });
    const config = createDefaultRunCoreConfig();
    config.runDurationSeconds = 3600;

    const result = await runCoreLoop(config, deps);
    assertEquals(result.plannedShutdown, true);
    assertEquals(filerRan, true);
    const failureLine = logs.find((l) =>
      l.includes("Idle-detect audit failed") && l.includes("probe blew up")
    );
    assert(
      failureLine !== undefined,
      `expected continuation log; got: ${logs.join("\n")}`,
    );
  },
);
