/**
 * Tests for Issue #4369: an agent SIGTERMed by the worker's own cleanup or
 * a handler abandonment is "terminated" — never a rate limit, never
 * retried, never relaunched after the run ends — and agent-backed handlers
 * are bounded by the cycle deadline, not the flat handler timeout.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  isAgentRunsTerminating,
  listActiveAgentRuns,
  markAgentRunsTerminating,
  resetAgentRunsTerminating,
  runClaudeWithRetry,
  terminateActiveAgentRuns,
} from "../lib/claude_runner.ts";
import {
  AGENT_HANDLER_GRACE_MS,
  createDefaultRunCoreConfig,
  handlerHardTimeoutMs,
  type RunCoreDeps,
  runCoreLoop,
} from "../lib/run_core.ts";

/** Stub `claude` on PATH that records spawns and runs `body`. */
async function withStubClaude<T>(
  body: string,
  fn: (spawnLog: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "claude_stub_term_" });
  const spawnLog = `${dir}/spawns.log`;
  await Deno.writeTextFile(
    `${dir}/claude`,
    `#!/usr/bin/env bash\necho spawn >> "${spawnLog}"\n${body}\n`,
  );
  await Deno.chmod(`${dir}/claude`, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  try {
    return await fn(spawnLog);
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function spawnCount(spawnLog: string): Promise<number> {
  try {
    return (await Deno.readTextFile(spawnLog)).split("\n").filter((l) =>
      l === "spawn"
    ).length;
  } catch {
    return 0;
  }
}

Deno.test({
  name:
    "claude runner - an agent that dies from a SIGTERM the worker never requested, with 'rate limit exceeded' in its output, is an external kill, not rate-limited: one spawn, no wait, no retry (Issue #4369, Issue #46)",
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAgentRunsTerminating();
    // The agent prints text that matches the primary rate-limit pattern
    // (a CI-fix agent grepping the runner source does exactly this), then
    // SIGTERMs itself. Nothing set the terminating flag, so this is an
    // EXTERNAL kill (Issue #46) — but the #4369 invariant still holds: a
    // SIGTERM's output must never reach the rate-limit path.
    const body = [
      `printf '%s\\n' '{"type":"assistant","message":"grep: rate limit exceeded credit quota"}'`,
      `kill -TERM $$`,
    ].join("\n");
    const startedAt = Date.now();
    await withStubClaude(body, async (spawnLog) => {
      const result = await runClaudeWithRetry(
        {
          prompt: "P",
          model: "m",
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          cwd: await Deno.makeTempDir({ prefix: "term-cwd-" }),
          mcpConfig: false,
        },
        { maxRetries: 2, maxWaitSeconds: 600, initialWaitInterval: 300 },
      );
      assert(result.ok, "runner resolves");
      assertEquals(
        result.value.externalSigterm,
        true,
        JSON.stringify(result.value),
      );
      assertEquals(result.value.terminated, undefined, "not our shutdown");
      assertEquals(result.value.exitCode, 143);
      assertEquals(await spawnCount(spawnLog), 1, "no retry spawn");
      assert(Date.now() - startedAt < 20_000, "no rate-limit wait");
      assertEquals(listActiveAgentRuns().length, 0, "run unregistered");
    });
  },
});

Deno.test({
  name:
    "claude runner - once agent runs are terminating, a retry loop does not launch the agent at all (Issue #4369)",
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAgentRunsTerminating();
    markAgentRunsTerminating();
    try {
      await withStubClaude(
        `printf '%s\\n' '{"type":"result","result":"done"}'`,
        async (spawnLog) => {
          const result = await runClaudeWithRetry(
            {
              prompt: "P",
              model: "m",
              timeoutSeconds: 30,
              killAfterSeconds: 2,
              mcpConfig: false,
            },
            { maxRetries: 2, maxWaitSeconds: 0, initialWaitInterval: 0 },
          );
          assert(result.ok);
          assertEquals(result.value.terminated, true);
          assertEquals(await spawnCount(spawnLog), 0, "never spawned");
        },
      );
    } finally {
      resetAgentRunsTerminating();
    }
  },
});

Deno.test({
  name:
    "claude runner - terminateActiveAgentRuns kills a live agent, its runner reports terminated, and later spawns are refused (Issue #4369)",
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAgentRunsTerminating();
    try {
      await withStubClaude(`sleep 60`, async (spawnLog) => {
        const running = runClaudeWithRetry(
          {
            prompt: "P",
            model: "m",
            timeoutSeconds: 120,
            killAfterSeconds: 2,
            mcpConfig: false,
          },
          { maxRetries: 2, maxWaitSeconds: 0, initialWaitInterval: 0 },
        );
        // Wait until the agent is registered AND has started running (its
        // spawn line is on disk), so the kill lands on a live agent.
        for (
          let i = 0;
          i < 200 &&
          (listActiveAgentRuns().length === 0 ||
            (await spawnCount(spawnLog)) === 0);
          i++
        ) {
          await new Promise((r) => setTimeout(r, 50));
        }
        assertEquals(
          listActiveAgentRuns().length,
          1,
          "agent registered while running",
        );
        const killed = await terminateActiveAgentRuns(
          "test: handler abandoned",
        );
        assertEquals(killed.length, 1);
        assertEquals(isAgentRunsTerminating(), true);
        const result = await running;
        assert(result.ok);
        assertEquals(
          result.value.terminated,
          true,
          JSON.stringify(result.value),
        );
        assertEquals(
          await spawnCount(spawnLog),
          1,
          "no relaunch after termination",
        );
      });
    } finally {
      resetAgentRunsTerminating();
    }
  },
});

// ---------------------------------------------------------------------------
// run_core: agent-backed handlers and the watchdog
// ---------------------------------------------------------------------------

function baseDeps(overrides: Partial<RunCoreDeps>): RunCoreDeps {
  // Reuse the slot-pool test's mock shape by importing lazily would create a
  // circular fixture; a minimal inline mock keeps this file standalone.
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

Deno.test("run_core watchdog - an agent-backed handler (CI Fix) running past 600 s is NOT abandoned while the cycle has time; a non-agent handler at 600 s still is (Issue #4369)", async () => {
  const errors: string[] = [];
  const terminations: string[] = [];
  let now = 0;
  let shutdown: (() => void) | undefined;
  let ciFixCompleted = false;
  const config = createDefaultRunCoreConfig(); // runDurationSeconds 3600, handlerTimeout 600
  const deps = baseDeps({
    logError: (m) => {
      errors.push(m);
    },
    now: () => now,
    addSignalListener: (signal, handler) => {
      if (signal === "SIGTERM") shutdown = handler;
    },
    // The injected watchdog timer advances the clock by exactly the wait,
    // so a handler that "runs" 1500 s is modelled by resolving after the
    // timer would have fired at 600 s but before one at 3600 s + grace.
    watchdogDelay: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    terminateActiveAgentRuns: (reason) => {
      terminations.push(reason);
      return Promise.resolve();
    },
    // CI Fix: agent-backed, takes 1500 s (never resolves before a 600 s
    // watchdog timer, resolves before the cycle-bounded one).
    findAndProcessCiFailure: () =>
      new Promise((resolve) => {
        const check = () => {
          if (now >= 1500) {
            ciFixCompleted = true;
            resolve({ ok: true, value: { processed: true } });
          } else setTimeout(check, 1);
        };
        check();
      }),
    // Update PR Branches: not agent-backed, wedges forever → abandoned at 600 s.
    updateOpenPrBranches: () => new Promise(() => {}),
    findNextIssue: () => {
      shutdown?.();
      return Promise.resolve({ ok: true, value: null });
    },
  });
  await runCoreLoop(config, deps);
  const abandoned = errors.filter((e) =>
    e.includes("[watchdog]") && e.includes("hard timeout")
  );
  assertEquals(
    abandoned.some((e) => e.includes("(CI Fix)")),
    false,
    `CI Fix must not be abandoned: ${abandoned.join(" | ")}`,
  );
  assert(ciFixCompleted, "CI Fix ran to completion");
  assert(
    abandoned.some((e) =>
      e.includes("(Update PR Branches)") && e.includes("600s")
    ),
    `non-agent handler still bounded at 600 s: ${abandoned.join(" | ")}`,
  );
  // An abandonment terminates any agent the handler spawned, and the run
  // end terminates the rest.
  assert(
    terminations.some((r) => r.includes("Update PR Branches")),
    terminations.join(" | "),
  );
  assert(terminations.includes("run ending"), terminations.join(" | "));
});

Deno.test("run_core watchdog - an agent-backed handler that outlives the cycle deadline plus grace IS abandoned, and its agent is terminated (Issue #4369)", async () => {
  const errors: string[] = [];
  const terminations: string[] = [];
  let now = 0;
  let shutdown: (() => void) | undefined;
  const config = createDefaultRunCoreConfig();
  const deps = baseDeps({
    logError: (m) => {
      errors.push(m);
    },
    now: () => now,
    addSignalListener: (signal, handler) => {
      if (signal === "SIGTERM") shutdown = handler;
    },
    watchdogDelay: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    terminateActiveAgentRuns: (reason) => {
      terminations.push(reason);
      return Promise.resolve();
    },
    findAndProcessPlanning: () => new Promise(() => {}), // wedged agent handler
    findNextIssue: () => {
      shutdown?.();
      return Promise.resolve({ ok: true, value: null });
    },
  });
  await runCoreLoop(config, deps);
  const line = errors.find((e) =>
    e.includes("(Planning Mode)") && e.includes("hard timeout")
  );
  assert(
    line,
    `planning abandoned once past the cycle deadline: ${errors.join(" | ")}`,
  );
  assert(
    terminations.some((r) => r.includes("Planning Mode")),
    terminations.join(" | "),
  );
});

Deno.test("run_core watchdog - handlerHardTimeoutMs: flat for non-agent handlers; cycle-remaining plus grace (never below flat) for agent-backed ones (Issue #4369)", () => {
  const flat = 600;
  assertEquals(handlerHardTimeoutMs(flat, false, 3_600_000, 0), 600_000);
  assertEquals(
    handlerHardTimeoutMs(flat, false, 3_600_000, 3_500_000),
    600_000,
  );
  // Cycle start: the whole run plus grace.
  assertEquals(
    handlerHardTimeoutMs(flat, true, 3_600_000, 0),
    3_600_000 + AGENT_HANDLER_GRACE_MS,
  );
  // Late in the cycle: what is left plus grace…
  assertEquals(
    handlerHardTimeoutMs(flat, true, 3_600_000, 3_000_000),
    600_000 + AGENT_HANDLER_GRACE_MS,
  );
  // …but never below the flat timeout.
  assertEquals(
    handlerHardTimeoutMs(flat, true, 3_600_000, 3_599_000),
    Math.max(600_000, 1000 + AGENT_HANDLER_GRACE_MS),
  );
  assertEquals(
    handlerHardTimeoutMs(flat, true, 1000, 5000),
    600_000,
    "past the deadline: flat",
  );
});

// ---------------------------------------------------------------------------
// Issue #55 — a watchdog HANDLER abandonment must not disable agent launches
// for the rest of the run. The terminating flag is transient for that case.
// ---------------------------------------------------------------------------

Deno.test("terminateActiveAgentRuns - a handler abandonment (keepTerminating:false) clears the flag (Issue #55)", async () => {
  resetAgentRunsTerminating();
  await terminateActiveAgentRuns(
    "handler Planning Mode abandoned by the watchdog",
    undefined,
    { keepTerminating: false },
  );
  assertEquals(
    isAgentRunsTerminating(),
    false,
    "the flag is cleared once the abandoned agents are dead",
  );
});

Deno.test("terminateActiveAgentRuns - the run-ending case (default) leaves the flag set (Issue #4369)", async () => {
  resetAgentRunsTerminating();
  await terminateActiveAgentRuns("run ending");
  assertEquals(
    isAgentRunsTerminating(),
    true,
    "at run end the flag stays set, refusing every further launch",
  );
  resetAgentRunsTerminating();
});

Deno.test({
  name:
    "claude runner - a later priority's agent launch proceeds after a watchdog abandonment (Issue #55)",
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAgentRunsTerminating();
    // The watchdog abandons a handler: terminate its agents but clear the flag.
    await terminateActiveAgentRuns(
      "handler Planning Mode abandoned by the watchdog",
      undefined,
      { keepTerminating: false },
    );
    assertEquals(isAgentRunsTerminating(), false);
    // The next priority must actually spawn its agent, not be refused.
    await withStubClaude(
      `printf '%s\\n' '{"type":"result","result":"done"}'`,
      async (spawnLog) => {
        const result = await runClaudeWithRetry(
          {
            prompt: "P",
            model: "m",
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            cwd: await Deno.makeTempDir({ prefix: "post-abandon-" }),
            mcpConfig: false,
          },
          { maxRetries: 2, maxWaitSeconds: 600, initialWaitInterval: 300 },
        );
        assert(result.ok, "runner resolves");
        assertEquals(result.value.exitCode, 0, "the later agent ran normally");
        assertEquals(
          await spawnCount(spawnLog),
          1,
          "the later agent was launched, not refused",
        );
      },
    );
  },
});
