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
 * `claude` on PATH that records every invocation and always returns a
 * rate-limit non-zero exit, so the loop walks the whole ladder without ever
 * sleeping.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_MAX_TOTAL_INVOCATIONS,
  runClaudeWithRetry,
} from "../lib/claude_runner.ts";

// ---------------------------------------------------------------------------
// Stub harness — a fake `claude` on PATH that records its --model arg and
// always returns a rate-limit non-zero exit.
// ---------------------------------------------------------------------------

interface StubClaude {
  /** Directory holding the stub, prepended to PATH. */
  dir: string;
  /** Path the stub appends each invocation's --model value to. */
  modelLog: string;
}

/**
 * Build a stub `claude` script whose body records the `--model` argument of
 * each invocation (one per line) to `modelLog`, prints a stream-json result
 * whose text matches the rate-limit detector, and exits with `exitCode`.
 */
function buildRateLimitStubBody(modelLog: string, exitCode: number): string {
  // Walk the args to find the value following `--model`. Append it to the
  // log so the test can assert the downgrade sequence across re-invocations.
  return [
    `prev=""`,
    `for arg in "$@"; do`,
    `  if [ "$prev" = "--model" ]; then`,
    `    printf '%s\\n' "$arg" >> '${modelLog}'`,
    `  fi`,
    `  prev="$arg"`,
    `done`,
    // stream-json result line; the text matches detectRateLimit().
    `printf '%s\\n' '{"type":"result","result":"Credit balance is too low - rate limit exceeded"}'`,
    `exit ${exitCode}`,
  ].join("\n");
}

/**
 * Create a temporary stub `claude` on PATH for the duration of `fn`, then
 * restore PATH and clean up. Mirrors the `withStubClaude` helper in
 * `claude_runner_test.ts` but also wires up the per-invocation model log.
 */
async function withRateLimitStub<T>(
  exitCode: number,
  fn: (stub: StubClaude) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "claude_rl_stub_" });
  const modelLog = `${dir}/models.log`;
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash\n${buildRateLimitStubBody(modelLog, exitCode)}\n`,
  );
  await Deno.chmod(stubPath, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  try {
    return await fn({ dir, modelLog });
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true }).catch(() => {
      /* best-effort */
    });
  }
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
          prompt: "test",
          model: "fable",
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
          prompt: "test",
          model: "fable",
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
          prompt: "test",
          model: "fable",
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
          prompt: "test",
          model: "sonnet",
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
