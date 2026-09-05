/**
 * Tests for the call-scoped invocation budget in `runClaudeWithRetry()`
 * (SEC-ad10b8e14896, Issue #3648).
 *
 * `retryCount` and `totalWaitTime` are reset on every rung of the
 * model-fallback ladder, so neither bounds the total spend of a call: with the
 * default `maxRetries = 2` and a four-tier ladder a single call could bill
 * roughly a dozen `claude` invocations. `maxTotalInvocations` is the counter
 * that never resets.
 *
 * The harness mirrors `claude_runner_rate_limit_fallback_test.ts`: a stub
 * agent, named by path rather than installed on `PATH` (Issue #959), that
 * records every invocation and always returns a rate-limit non-zero exit, so
 * the loop walks the whole ladder without ever sleeping.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_MAX_TOTAL_INVOCATIONS,
  runClaudeWithRetry,
} from "../lib/claude_runner.ts";
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
 * Build a stub `claude` script whose body records the `--model` argument of
 * each invocation (one per line) to `modelLog`, prints a stream-json result
 * whose text matches the rate-limit detector, and exits with `exitCode`.
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

Deno.test({
  name:
    "SEC-ad10b8e14896 - the default invocation budget caps a full ladder walk",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withRateLimitStub(1, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          clock: fakeClock(),
          prompt: "test",
          model: "fable",
          agentBinaryPath: stub.path,
          enableModelFallback: true,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        // maxRetries = 2 gives 3 invocations per tier; four tiers would bill
        // 12 without the budget.
        { maxRetries: 2, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, models: await readModelSequence(stub.modelLog) };
    });

    assert(result.ok, `expected ok result, got ${!result.ok && result.error}`);
    if (!result.ok) return;

    assertEquals(
      models.length,
      DEFAULT_MAX_TOTAL_INVOCATIONS,
      `expected the ladder walk to stop at the ${DEFAULT_MAX_TOTAL_INVOCATIONS}-invocation budget, got ${models.length}: ${
        models.join(", ")
      }`,
    );
    assertEquals(result.value.exitCode, 2);
  },
});

Deno.test({
  name: "SEC-ad10b8e14896 - an explicit invocation budget is honoured",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withRateLimitStub(1, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          clock: fakeClock(),
          prompt: "test",
          model: "fable",
          agentBinaryPath: stub.path,
          enableModelFallback: true,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        {
          maxRetries: 0,
          maxWaitSeconds: 1,
          initialWaitInterval: 0,
          maxTotalInvocations: 2,
        },
      );
      return { result, models: await readModelSequence(stub.modelLog) };
    });

    assert(result.ok, `expected ok result, got ${!result.ok && result.error}`);
    if (!result.ok) return;

    assertEquals(models, ["fable", "opus"]);
    assertEquals(result.value.exitCode, 2);
  },
});

Deno.test({
  name:
    "SEC-ad10b8e14896 - a budget wide enough for the ladder leaves it intact",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withRateLimitStub(1, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          clock: fakeClock(),
          prompt: "test",
          model: "fable",
          agentBinaryPath: stub.path,
          enableModelFallback: true,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        {
          maxRetries: 0,
          maxWaitSeconds: 1,
          initialWaitInterval: 0,
          maxTotalInvocations: 10,
        },
      );
      return { result, models: await readModelSequence(stub.modelLog) };
    });

    assert(result.ok, `expected ok result, got ${!result.ok && result.error}`);
    if (!result.ok) return;

    assertEquals(models, ["fable", "opus", "sonnet", "haiku"]);
    assertEquals(result.value.fallbackModel, "haiku");
  },
});

Deno.test({
  name: "SEC-ad10b8e14896 - a successful first invocation spends one unit",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, models } = await withRateLimitStub(0, async (stub) => {
      const result = await runClaudeWithRetry(
        {
          clock: fakeClock(),
          prompt: "test",
          model: "sonnet",
          agentBinaryPath: stub.path,
          enableModelFallback: true,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 0 },
      );
      return { result, models: await readModelSequence(stub.modelLog) };
    });

    assert(result.ok);
    if (!result.ok) return;
    assertEquals(models, ["sonnet"]);
    assertEquals(result.value.exitCode, 0);
  },
});
