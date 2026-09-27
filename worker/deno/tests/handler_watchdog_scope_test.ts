/**
 * Tests for Issue #2720: the maintenance-handler watchdog.
 *
 * 1. Abandoning a handler terminates only the agent runs that handler
 *    started — never an issue slot's run beside it.
 * 2. A handler whose agent is still making progress is not abandoned at the
 *    base hard timeout; it is abandoned at the absolute ceiling. A stalled
 *    handler is still abandoned at the base timeout.
 * 3. The abandonment ERROR line names the work item the handler was on.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  currentAgentRunOwner,
  newAgentRunOwner,
  noteAgentRunWorkItem,
  runAsAgentRunOwner,
} from "../lib/handler_watchdog.ts";
import {
  agentRunActivity,
  listActiveAgentRuns,
  resetAgentRunsTerminating,
  runClaudeWithRetry,
  terminateActiveAgentRuns,
} from "../lib/claude_runner.ts";
import { decideHandlerExtension } from "../lib/progress_extension.ts";
import {
  createDefaultRunCoreConfig,
  HANDLER_PROGRESS_CEILING_MS,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const POLICY = { enabled: true, grantSeconds: 900, activityStallSeconds: 300 };

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

Deno.test("decideHandlerExtension - a live agent inside the stall window earns a grant from now", () => {
  const decision = decideHandlerExtension({
    nowMs: 1_000_000,
    activity: { lastToolCallAtMs: 990_000, lastChunkAtMs: 999_000 },
    ceilingMs: 10_000_000,
  }, POLICY);
  assertEquals(decision.action, "extend");
  if (decision.action === "extend") {
    assertEquals(decision.newDeadlineMs, 1_000_000 + 900_000);
  }
});

Deno.test("decideHandlerExtension - the grant is clamped to the ceiling, and no runway left abandons", () => {
  const clamped = decideHandlerExtension({
    nowMs: 1_000_000,
    activity: { lastToolCallAtMs: 999_000, lastChunkAtMs: 999_000 },
    ceilingMs: 1_200_000,
  }, POLICY);
  assertEquals(clamped.action, "extend");
  if (clamped.action === "extend") {
    assertEquals(clamped.newDeadlineMs, 1_200_000);
  }
  const atCeiling = decideHandlerExtension({
    nowMs: 1_200_000,
    activity: { lastToolCallAtMs: 1_199_000, lastChunkAtMs: 1_199_000 },
    ceilingMs: 1_200_000,
  }, POLICY);
  assertEquals(atCeiling.action, "kill");
  assert(atCeiling.reason.includes("ceiling"), atCeiling.reason);
});

Deno.test("decideHandlerExtension - a stalled agent, no agent, or the feature off abandons", () => {
  const stalled = decideHandlerExtension({
    nowMs: 1_000_000,
    activity: { lastToolCallAtMs: 600_000, lastChunkAtMs: 650_000 },
    ceilingMs: 10_000_000,
  }, POLICY);
  assertEquals(stalled.action, "kill");
  assert(stalled.reason.includes("stale"), stalled.reason);

  const none = decideHandlerExtension({
    nowMs: 1_000_000,
    activity: undefined,
    ceilingMs: 10_000_000,
  }, POLICY);
  assertEquals(none.action, "kill");

  const off = decideHandlerExtension({
    nowMs: 1_000_000,
    activity: { lastToolCallAtMs: 999_000, lastChunkAtMs: 999_000 },
    ceilingMs: 10_000_000,
  }, { ...POLICY, enabled: false });
  assertEquals(off.action, "kill");
});

// ---------------------------------------------------------------------------
// The runner: a scoped termination kills only the owner's runs
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "terminateActiveAgentRuns - an owner-scoped termination kills the handler's own agent and leaves an issue-slot agent running (Issue #2720)",
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAgentRunsTerminating();
    try {
      await withAgentStub(
        `echo spawn >> "$(dirname "$0")/spawns.log"\nsleep 60\n`,
        async (stub) => {
          const options = {
            clock: fakeClock(),
            prompt: "P",
            model: "m",
            agentBinaryPath: stub.path,
            timeoutSeconds: 120,
            killAfterSeconds: 2,
            mcpConfig: false,
          };
          const retry = {
            maxRetries: 2,
            maxWaitSeconds: 0,
            initialWaitInterval: 0,
          };
          const owner = newAgentRunOwner("PR Feedback");
          const handlerRun = runAsAgentRunOwner(
            owner,
            () =>
              runClaudeWithRetry({ ...options, phase: "pr_feedback" }, retry),
          );
          const slotRun = runClaudeWithRetry(
            { ...options, phase: "execute" },
            retry,
          );
          // Both registered AND running (each spawn line is on disk), so the
          // kill lands on a live agent — as the #4369 test waits.
          const spawns = async () => {
            try {
              return (await Deno.readTextFile(`${stub.dir}/spawns.log`))
                .split("\n").filter((l) => l === "spawn").length;
            } catch {
              return 0;
            }
          };
          for (
            let i = 0;
            i < 200 &&
            (listActiveAgentRuns().length < 2 || (await spawns()) < 2);
            i++
          ) {
            await new Promise((r) => setTimeout(r, 50));
          }
          assertEquals(listActiveAgentRuns().length, 2, "both agents live");
          assert(
            agentRunActivity(owner.id) !== undefined,
            "the handler's own agent reports activity",
          );

          const killed = await terminateActiveAgentRuns(
            "handler PR Feedback abandoned by the watchdog",
            undefined,
            { keepTerminating: false, owner: owner.id },
          );
          assertEquals(killed.length, 1, "only the handler's agent");
          const handlerResult = await handlerRun;
          assert(handlerResult.ok);
          assertEquals(
            handlerResult.value.terminated,
            true,
            JSON.stringify(handlerResult.value),
          );

          const left = listActiveAgentRuns();
          assertEquals(left.length, 1, "the issue-slot agent is still alive");
          assert(left[0]!.label.startsWith("execute"), left[0]!.label);
          assertEquals(agentRunActivity(owner.id), undefined);

          // Clean up the slot's agent with the run-ending termination.
          await terminateActiveAgentRuns("test cleanup");
          const slotResult = await slotRun;
          assert(slotResult.ok);
        },
        { prefix: "handler_watchdog_scope_" },
      );
    } finally {
      resetAgentRunsTerminating();
    }
  },
});

// ---------------------------------------------------------------------------
// run_core: the dispatcher wiring
// ---------------------------------------------------------------------------

function baseDeps(overrides: Partial<RunCoreDeps>): RunCoreDeps {
  const noop = () => Promise.resolve();
  const okVoid = () => Promise.resolve({ ok: true as const, value: undefined });
  const notProcessed = () =>
    Promise.resolve({ ok: true as const, value: { processed: false } });
  return {
    log: () => {},
    logError: () => {},
    logTiming: () => {},
    logWorkerSummary: () => {},
    checkPidFile: () => Promise.resolve({ canProceed: true, message: "OK" }),
    claimPidFile: noop,
    releasePidFile: noop,
    gitResetToOrigin: okVoid,
    setupLogging: noop,
    loadAndValidateConfig: () =>
      Promise.resolve({ ok: true, value: createDefaultRunCoreConfig() }),
    checkDependencies: okVoid,
    checkSoftwareUpdates: noop,
    checkDiskSpace: okVoid,
    rotateLogFiles: noop,
    cleanupStaleTempFiles: noop,
    recoverStuckIssues: noop,
    cleanupStaleBranches: noop,
    checkFeatureAvailability: noop,
    checkClaudeHealth: () =>
      Promise.resolve({ ok: true, value: { healthy: true } }),
    checkGhAuth: () => Promise.resolve({ ok: true, value: { valid: true } }),
    findAndProcessPrFeedback: notProcessed,
    findAndProcessSpellingFailure: notProcessed,
    findAndProcessCiFailure: notProcessed,
    updateOpenPrBranches: okVoid,
    nudgeStalledCi: okVoid,
    ensureAutoMerge: okVoid,
    cleanupMergedBranches: okVoid,
    closeIssuesForMergedPrs: okVoid,
    recoverAssignedWithClosedPr: okVoid,
    syncMilestoneBranches: okVoid,
    checkMilestoneCompletions: okVoid,
    findAndProcessRefinement: notProcessed,
    findAndProcessGrillMe: notProcessed,
    findAndProcessQuestion: notProcessed,
    findAndProcessPlanning: notProcessed,
    scanStaleWorkflowIssues: okVoid,
    findNextIssue: () => Promise.resolve({ ok: true, value: null }),
    processIssue: () => Promise.resolve({ ok: true, value: { success: true } }),
    trackFailure: noop,
    resetFailures: noop,
    shouldExitOnFailures: () => Promise.resolve(false),
    recordIssueCooldown: noop,
    circuitBreakerReset: noop,
    circuitBreakerRecordZeroProgress: noop,
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
    resetRepoFailures: noop,
    recordRepoFailure: noop,
    recordRepoSuccess: noop,
    sendCrashNotification: noop,
    clearHeartbeat: noop,
    cleanupInProgressIssue: noop,
    setStatusIdle: noop,
    setStatusWorking: noop,
    setStatusSuccess: noop,
    setStatusFailure: noop,
    resetWindowTitle: () => {},
    addSignalListener: () => {},
    removeSignalListener: () => {},
    writeFaultToleranceSummary: noop,
    touchPidFile: noop,
    sleep: noop,
    now: () => 0,
    ...overrides,
  } as RunCoreDeps;
}

/** A PR Feedback handler that notes its work item and never returns. */
function wedgedPrFeedback(
  seen: { ownerId?: string },
): RunCoreDeps["findAndProcessPrFeedback"] {
  return () => {
    seen.ownerId = currentAgentRunOwner()?.id;
    noteAgentRunWorkItem("stSoftwareAU/GRQ-taxation#740 review 5329450436");
    return new Promise(() => {});
  };
}

Deno.test("run_core watchdog - abandoning PR Feedback terminates only its own agent runs, names the PR it was on, and issue work carries no handler owner (Issue #2720)", async () => {
  const errors: string[] = [];
  const terminations: { reason: string; owner?: string }[] = [];
  const seen: { ownerId?: string } = {};
  let issueOwner: string | undefined = "unset";
  let now = 0;
  let shutdown: (() => void) | undefined;
  let served = false;
  const deps = baseDeps({
    logError: (m) => errors.push(m),
    now: () => now,
    addSignalListener: (signal, handler) => {
      if (signal === "SIGTERM") shutdown = handler;
    },
    watchdogDelay: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    terminateActiveAgentRuns: (reason, options) => {
      terminations.push({ reason, owner: options?.owner });
      return Promise.resolve();
    },
    findAndProcessPrFeedback: wedgedPrFeedback(seen),
    findNextIssue: () => {
      if (served) {
        shutdown?.();
        return Promise.resolve({ ok: true, value: null });
      }
      served = true;
      return Promise.resolve({
        ok: true as const,
        value: {
          repo: "stSoftwareAU/GRQ-AutoTrader",
          issueNumber: 1451,
          issueTitle: "t",
          milestoneTitle: "",
        },
      });
    },
    processIssue: () => {
      issueOwner = currentAgentRunOwner()?.id;
      return Promise.resolve({ ok: true, value: { success: true } });
    },
  });
  await runCoreLoop(createDefaultRunCoreConfig(), deps);

  assert(seen.ownerId?.startsWith("PR Feedback#"), String(seen.ownerId));
  const abandon = terminations.find((t) => t.reason.includes("PR Feedback"));
  assert(abandon, JSON.stringify(terminations));
  assertEquals(abandon.owner, seen.ownerId, "scoped to the handler's owner");
  assertEquals(
    terminations.find((t) => t.reason === "run ending")?.owner,
    undefined,
    "the run-ending termination still reaches every run",
  );
  assertEquals(issueOwner, undefined, "an issue run is owned by no handler");

  const line = errors.find((e) =>
    e.includes("(PR Feedback)") && e.includes("hard timeout")
  );
  assert(line, errors.join(" | "));
  assert(
    line.includes("stSoftwareAU/GRQ-taxation#740 review 5329450436"),
    line,
  );
});

/**
 * The laptop host's incident (Issue #2720): PR Feedback dispatched late in
 * the cycle, so its base hard timeout was 925 s — the 625 s left in the
 * cycle plus the five-minute grace.
 */
const LATE_CYCLE = {
  ...createDefaultRunCoreConfig(),
  runDurationSeconds: 625,
};
const BASE_MS = 925_000;

/** Drive a wedged PR Feedback whose agent activity is `activity(now)`. */
async function runWithActivity(
  activity: (
    now: number,
  ) => { lastToolCallAtMs?: number; lastChunkAtMs: number } | undefined,
): Promise<{ abandonedAtMs?: number; errors: string[]; logs: string[] }> {
  const errors: string[] = [];
  const logs: string[] = [];
  const seen: { ownerId?: string } = {};
  let now = 0;
  let abandonedAtMs: number | undefined;
  let shutdown: (() => void) | undefined;
  const deps = baseDeps({
    log: (m) => logs.push(m),
    logError: (m) => {
      errors.push(m);
      if (m.includes("(PR Feedback)") && m.includes("hard timeout")) {
        abandonedAtMs = now;
      }
    },
    now: () => now,
    addSignalListener: (signal, handler) => {
      if (signal === "SIGTERM") shutdown = handler;
    },
    watchdogDelay: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    terminateActiveAgentRuns: () => Promise.resolve(),
    agentRunActivity: (owner) =>
      owner === seen.ownerId ? activity(now) : undefined,
    findAndProcessPrFeedback: wedgedPrFeedback(seen),
    findNextIssue: () => {
      shutdown?.();
      return Promise.resolve({ ok: true, value: null });
    },
  });
  await runCoreLoop(LATE_CYCLE, deps);
  return { abandonedAtMs, errors, logs };
}

Deno.test("run_core watchdog - a handler whose agent keeps making progress is not abandoned at the base timeout, but is at the absolute ceiling (Issue #2720)", async () => {
  const { abandonedAtMs, errors, logs } = await runWithActivity((now) => ({
    lastToolCallAtMs: now - 10_000,
    lastChunkAtMs: now - 1_000,
  }));
  assert(abandonedAtMs !== undefined, errors.join(" | "));
  assert(abandonedAtMs > BASE_MS, `not at the base: ${abandonedAtMs}`);
  assertEquals(
    abandonedAtMs,
    HANDLER_PROGRESS_CEILING_MS,
    "abandoned at the ceiling",
  );
  assert(
    logs.some((m) => m.includes("[watchdog]") && m.includes("extended")),
    logs.join(" | "),
  );
  const line = errors.find((e) => e.includes("hard timeout"))!;
  assert(line.includes("ceiling"), line);
});

Deno.test("run_core watchdog - a stalled handler is still abandoned at the base timeout (Issue #2720)", async () => {
  const stalled = await runWithActivity(() => ({
    lastToolCallAtMs: 0,
    lastChunkAtMs: 0,
  }));
  assertEquals(stalled.abandonedAtMs, BASE_MS, stalled.errors.join(" | "));
  const line = stalled.errors.find((e) => e.includes("hard timeout"))!;
  assert(line.includes("925s"), line);
  assert(line.includes("stale"), line);

  // No live agent at all: the same.
  const idle = await runWithActivity(() => undefined);
  assertEquals(idle.abandonedAtMs, BASE_MS, idle.errors.join(" | "));
});
