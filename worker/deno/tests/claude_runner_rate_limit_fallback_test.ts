/**
 * End-to-end tests for the rate-limit model-fallback loop inside
 * `runClaudeWithRetry()` (Issue #2708, parent #2698).
 *
 * The pure helpers (`getCheaperModel`, `resolveCurrentModel`,
 * `attemptModelFallback`) are covered elsewhere
 * (`model_fallback_test.ts`, `model_fallback_retry_test.ts`). What was
 * untested is the *wiring* inside `runClaudeWithRetry()` that actually drives
 * the downgrade: the mutation of `currentOptions.model` to the cheaper tier,
 * the per-tier retry-state reset, the `fable → opus → sonnet → haiku → null`
 * termination, and the `enableModelFallback: false` short-circuit.
 *
 * These tests run the loop against a stub agent — named by path rather than
 * installed on `PATH` (Issue #959) — that always emits a rate-limit result
 * and exits non-zero. The stub records the `--model`
 * argument of every invocation to a log file, so the test can assert the exact
 * tier-by-tier downgrade sequence — proving there is no upgrade and no infinite
 * loop. Small `maxRetries`/`maxWaitSeconds` keep the run well under the
 * 120s unit-test budget (the loop never sleeps because the give-up/fallback
 * branch is taken on the first rate limit of each tier).
 *
 * Issue #1667 adds the two ladder boundaries: a ladder abandoned by the
 * watchdog while it sleeps between attempts ends there rather than waking to
 * spawn again, and the ladder gives up before scheduling a wait that would
 * reach `maxWaitSeconds` — the handler watchdog's own budget.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  isAgentRunsTerminating,
  resetAgentRunsTerminating,
  runClaudeWithRetry,
  terminateActiveAgentRuns,
} from "../lib/claude_runner.ts";
import type { Clock } from "../lib/clock.ts";
import type { Logger } from "../types.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

// ---------------------------------------------------------------------------
// Stub harness — a fake agent, named by path (Issue #959), that records its
// --model arg and always returns a rate-limit non-zero exit.
// ---------------------------------------------------------------------------

interface StubClaude {
  /** Absolute path to the stub, passed to the runner as `agentBinaryPath`. */
  path: string;
  /** Path the stub appends each invocation's --model value to. */
  modelLog: string;
}

/** Basename of the file the stub records each invocation's model in. */
const MODEL_LOG = "models.log";

/**
 * Build a stub agent script whose body records the `--model` argument of each
 * invocation (one per line), prints a stream-json result whose text matches
 * the rate-limit detector, and exits with `exitCode`.
 */
function buildRateLimitStubBody(exitCode: number): string {
  // Walk the args to find the value following `--model`. Append it to the
  // log — beside the stub, located from `$0` so no path is baked in — so the
  // test can assert the downgrade sequence across re-invocations.
  return [
    `log="$(dirname "$0")/${MODEL_LOG}"`,
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then`,
    `    printf '%s\\n' "$arg" >> "$log"`,
    `  fi`,
    `  prev="$arg"`,
    `done`,
    // stream-json result line; the text matches detectRateLimit().
    `printf '%s\\n' '{"type":"result","result":"Credit balance is too low - rate limit exceeded"}'`,
    `exit ${exitCode}`,
  ].join("\n");
}

/**
 * Create a temporary stub agent for the duration of `fn`, then clean up.
 * The runner is handed the stub's path (Issue #959), so nothing here touches
 * the process-wide `PATH`.
 */
function withRateLimitStub<T>(
  exitCode: number,
  fn: (stub: StubClaude) => Promise<T>,
): Promise<T> {
  return withAgentStub(
    buildRateLimitStubBody(exitCode),
    (stub) => fn({ path: stub.path, modelLog: `${stub.dir}/${MODEL_LOG}` }),
    { prefix: "claude_rl_stub_" },
  );
}

/** Read the recorded per-invocation model sequence (empty if never run). */
async function readModelSequence(modelLog: string): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(modelLog);
    return text.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

// Fast retry config — with maxRetries=0 the loop takes the fallback/give-up
// branch on the first rate limit of each tier, so no wait ever happens.
const FAST_RETRY = {
  maxRetries: 0,
  maxWaitSeconds: 1,
  initialWaitInterval: 0,
} as const;

// ---------------------------------------------------------------------------
// Trigger + tier-by-tier downgrade + termination
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - downgrades fable → opus → sonnet → haiku then gives up with exitCode 2 (Issue #2708)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withRateLimitStub(1, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          clock: fakeClock(),
          prompt: "test",
          agentBinaryPath: stub.path,
          model: "fable",
          enableModelFallback: true,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        FAST_RETRY,
      );
      return { result, models: await readModelSequence(stub.modelLog) };
    });

    assert(result.ok, `expected ok result, got ${!result.ok && result.error}`);
    if (!result.ok) return;

    // Termination: the chain ends at the cheapest tier with the give-up code.
    assertEquals(result.value.exitCode, 2);
    // The final result carries the last (cheapest) fallback tier.
    assertEquals(result.value.fallbackModel, "haiku");
    assertEquals(result.value.timedOut, false);

    // Tier-by-tier downgrade, no upgrade, no infinite loop: each tier is run
    // exactly once and the order is strictly cheaper each step.
    assertEquals(models, ["fable", "opus", "sonnet", "haiku"]);
  },
});

// ---------------------------------------------------------------------------
// Starting mid-chain — the loop downgrades from wherever it begins.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - downgrades sonnet → haiku then gives up (Issue #2708)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withRateLimitStub(1, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          clock: fakeClock(),
          prompt: "test",
          agentBinaryPath: stub.path,
          model: "sonnet",
          enableModelFallback: true,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        FAST_RETRY,
      );
      return { result, models: await readModelSequence(stub.modelLog) };
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.exitCode, 2);
    assertEquals(result.value.fallbackModel, "haiku");
    assertEquals(models, ["sonnet", "haiku"]);
  },
});

// ---------------------------------------------------------------------------
// enableModelFallback: false short-circuits to give-up with no downgrade.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - enableModelFallback:false gives up immediately with no downgrade (Issue #2708)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withRateLimitStub(1, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          clock: fakeClock(),
          prompt: "test",
          agentBinaryPath: stub.path,
          model: "fable",
          enableModelFallback: false,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        FAST_RETRY,
      );
      return { result, models: await readModelSequence(stub.modelLog) };
    });

    assert(result.ok);
    if (!result.ok) return;
    // Give-up branch: exitCode 2 with no model mutation at all.
    assertEquals(result.value.exitCode, 2);
    assertEquals(result.value.fallbackModel, undefined);
    // The stub was invoked exactly once, on the original model — no downgrade.
    assertEquals(models, ["fable"]);
  },
});

// ---------------------------------------------------------------------------
// Issue #1667 — a ladder abandoned by the watchdog while it sleeps between
// attempts must end there, and must never sleep into its budget's last second.
// ---------------------------------------------------------------------------

/** Retry config that actually sleeps: two rungs before the retry cap. */
const SLEEPING_RETRY = {
  maxRetries: 5,
  maxWaitSeconds: 100_000,
  initialWaitInterval: 300,
} as const;

/**
 * How long a bounded rendezvous waits before failing the test.
 *
 * Never a sleep — it only elapses when the thing being waited for never
 * arrives, and then the test fails loudly instead of hanging the shard.
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

/** Every backoff wait the ladder announced, in seconds, oldest first. */
interface LadderLog {
  logger: Logger;
  /** Resolves with the wait in seconds the ladder is about to serve on rung `n`. */
  waitOnRung(n: number): Promise<number>;
  /** Every line the ladder logged so far. */
  lines: string[];
}

/**
 * A logger that reports each backoff wait the ladder announces.
 *
 * The runner logs `Retry N of M. Waiting Ss (jittered from …)` immediately
 * before `clock.sleep`, so the line names both the rung the ladder has
 * reached and the exact delay its sleep timer will be armed for — which is
 * what {@link FakeClock.armedFor} needs to rendezvous with that timer instead
 * of guessing at it.
 */
function ladderLog(): LadderLog {
  const lines: string[] = [];
  const rungs = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<number>>
  >();
  const rung = (n: number) => {
    const existing = rungs.get(n);
    if (existing) return existing;
    const created = Promise.withResolvers<number>();
    rungs.set(n, created);
    return created;
  };
  const record = (message: string) => {
    lines.push(message);
    const match = message.match(/Retry (\d+) of \d+\. Waiting (\d+)s/);
    if (match) rung(Number(match[1])).resolve(Number(match[2]));
  };
  const logger = {
    info: record,
    warn: record,
    error: record,
    debug: record,
    security: (event: string, details: string) =>
      record(`[SECURITY] [${event}] ${details}`),
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  } satisfies Logger;
  return { logger, waitOnRung: (n) => rung(n).promise, lines };
}

Deno.test({
  name:
    "runClaudeWithRetry - a ladder abandoned mid-sleep ends without spawning again (Issue #1667)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAgentRunsTerminating();
    try {
      const { result, models, lines } = await withRateLimitStub(
        1,
        async (stub) => {
          const { logger, waitOnRung, lines } = ladderLog();
          const clock = fakeClock();
          const running = runClaudeWithRetry(
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
            SLEEPING_RETRY,
          );
          // Rung one: wait for its sleep to be armed, then advance by exactly
          // that delay — never by a guess, which would pre-expire the run's
          // own watchdogs and wedge the ladder.
          const firstWait = await within(waitOnRung(1), "the first backoff");
          await within(clock.armedFor(firstWait * 1000), "the first sleep");
          await clock.advance(firstWait * 1000);
          // Rung two: the ladder has spawned again and is back asleep.
          const secondWait = await within(waitOnRung(2), "the second backoff");
          await within(clock.armedFor(secondWait * 1000), "the second sleep");
          // The watchdog abandons the handler: kill its agents, clear the
          // flag (Issue #55). The ladder is asleep and owns no pid.
          await terminateActiveAgentRuns(
            "handler abandoned by the watchdog",
            undefined,
            { keepTerminating: false },
          );
          // Drive time past the remaining wait. A cancelled ladder has no
          // timer left to fire, so this is a no-op; an uncancelled one would
          // wake here and spawn its third agent.
          await clock.advance(secondWait * 1000);
          const result = await within(running, "the abandoned ladder to end");
          return {
            result,
            models: await readModelSequence(stub.modelLog),
            lines,
          };
        },
      );

      assert(
        result.ok,
        `expected ok result, got ${!result.ok && result.error}`,
      );
      if (!result.ok) return;
      // The abandoned ladder returns the run-end shape, not another attempt.
      assertEquals(result.value.terminated, true, JSON.stringify(result.value));
      assertEquals(result.value.exitCode, 143);
      assertEquals(result.value.rawExitCode, 143);
      // Two spawns happened before the abandonment; there is never a third.
      assertEquals(models.length, 2, `spawns: ${models.join(", ")}`);
      // Issue #55 preserved: the next priority may still launch its agent.
      assertEquals(isAgentRunsTerminating(), false);
      assert(
        !lines.some((l) => l.includes("retry_count=3")),
        `no third rate-limit rung: ${lines.join(" | ")}`,
      );
    } finally {
      resetAgentRunsTerminating();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - gives up rather than sleeping into the maxWaitSeconds ceiling (Issue #1667)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const base = fakeClock();
    const sleptMs: number[] = [];
    // Record every wait the ladder schedules, then resolve it at once, so an
    // unfixed ladder reports the wait it would have served rather than hanging.
    const clock: Clock = {
      ...base,
      sleep: (delayMs, signal) => {
        sleptMs.push(delayMs);
        return base.sleep(0, signal);
      },
    };

    const { result, models } = await withRateLimitStub(1, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          clock,
          prompt: "test",
          agentBinaryPath: stub.path,
          model: "haiku",
          enableModelFallback: false,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        // Every jittered wait (±30% of 1000s → [700, 1300]) already exceeds
        // the 600s ceiling, so the first rung must give up with no sleep.
        { maxRetries: 5, maxWaitSeconds: 600, initialWaitInterval: 1000 },
      );
      return { result, models: await readModelSequence(stub.modelLog) };
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.exitCode, 2, "the ladder logs its own give-up");
    assertEquals(
      sleptMs,
      [],
      `no wait may be scheduled: ${sleptMs.join(", ")}`,
    );
    assertEquals(models.length, 1, `one spawn only: ${models.join(", ")}`);
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - the total served wait stays strictly below maxWaitSeconds (Issue #1667)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const base = fakeClock();
    const sleptMs: number[] = [];
    const clock: Clock = {
      ...base,
      sleep: (delayMs, signal) => {
        sleptMs.push(delayMs);
        return base.sleep(0, signal);
      },
    };

    const result = await withRateLimitStub(1, (stub) =>
      runClaudeWithRetry(
        {
          clock,
          prompt: "test",
          agentBinaryPath: stub.path,
          model: "haiku",
          enableModelFallback: false,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        // 100s doubling per rung: 100, 200, 400 … the ladder must stop before
        // the accumulated wait can reach 600s, not clamp onto it.
        { maxRetries: 20, maxWaitSeconds: 600, initialWaitInterval: 100 },
      ));

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.exitCode, 2);
    const totalWaitSeconds = sleptMs.reduce((sum, ms) => sum + ms, 0) / 1000;
    assert(
      totalWaitSeconds < 600,
      `total wait ${totalWaitSeconds}s must stay under the 600s ceiling ` +
        `(waits: ${sleptMs.join(", ")})`,
    );
  },
});
