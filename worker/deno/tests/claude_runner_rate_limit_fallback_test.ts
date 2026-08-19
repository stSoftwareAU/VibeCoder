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
 * These tests run the loop against a stub `claude` on PATH that always emits a
 * rate-limit result and exits non-zero. The stub records the `--model`
 * argument of every invocation to a log file, so the test can assert the exact
 * tier-by-tier downgrade sequence — proving there is no upgrade and no infinite
 * loop. Small `maxRetries`/`maxWaitSeconds` keep the run well under the
 * 120s unit-test budget (the loop never sleeps because the give-up/fallback
 * branch is taken on the first rate limit of each tier).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";

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
          prompt: "test",
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
          prompt: "test",
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
          prompt: "test",
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
