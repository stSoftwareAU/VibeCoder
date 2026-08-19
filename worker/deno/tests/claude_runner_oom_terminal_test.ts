/**
 * End-to-end tests for the terminal out-of-memory (OOM) handling inside
 * `runClaudeWithRetry()` (Issue #2741, parent #2721).
 *
 * The pure detector (`detectOutOfMemory`) is covered in
 * `claude_executor_test.ts`. What is exercised here is the *wiring* inside the
 * run loop: that an OOM short-circuits out of the wait-and-retry loop with the
 * dedicated {@link OOM_EXIT_CODE} and `outOfMemory: true` flag, that it never
 * consults the rate-limit path (the stub is invoked exactly once — no retry,
 * no sleep), and that a `137` exit is routed to OOM only when there is memory
 * evidence (otherwise it keeps timeout semantics).
 *
 * Each test runs the loop against a stub `claude` on PATH that records its
 * invocation count, emits a configurable last line, and exits with a chosen
 * code. The recorded count proves no retry occurred. A deliberately long
 * `initialWaitInterval` would make any accidental retry sleep long enough to
 * trip the test's own bounded run, so a fast completion is itself evidence
 * that no wait accrued.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { OOM_EXIT_CODE, runClaudeWithRetry } from "../lib/claude_runner.ts";
import { TIMEOUT_EXIT_CODE } from "../lib/claude_executor.ts";

// ---------------------------------------------------------------------------
// Stub harness — a fake `claude` on PATH that records how many times it ran,
// prints a chosen final line, and exits with a chosen code.
// ---------------------------------------------------------------------------

interface StubClaude {
  /** Directory holding the stub, prepended to PATH. */
  dir: string;
  /** Path the stub appends one line to per invocation (for the run count). */
  runLog: string;
}

/**
 * Build a stub `claude` whose body records one line per invocation to
 * `runLog`, prints `lastLine` as a stream-json result, and exits with
 * `exitCode`. The recorded count lets a test assert the loop ran the stub
 * exactly once (no retry).
 */
function buildOomStubBody(
  runLog: string,
  lastLine: string,
  exitCode: number,
): string {
  return [
    `printf 'run\\n' >> '${runLog}'`,
    `printf '%s\\n' '{"type":"result","result":"${lastLine}"}'`,
    `exit ${exitCode}`,
  ].join("\n");
}

/**
 * Create a temporary stub `claude` on PATH for the duration of `fn`, then
 * restore PATH and clean up.
 */
async function withOomStub<T>(
  lastLine: string,
  exitCode: number,
  fn: (stub: StubClaude) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "claude_oom_stub_" });
  const runLog = `${dir}/runs.log`;
  const stubPath = `${dir}/claude`;
  await Deno.writeTextFile(
    stubPath,
    `#!/usr/bin/env bash\n${buildOomStubBody(runLog, lastLine, exitCode)}\n`,
  );
  await Deno.chmod(stubPath, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  try {
    return await fn({ dir, runLog });
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true }).catch(() => {
      /* best-effort */
    });
  }
}

/** Count how many times the stub ran (0 if it never did). */
async function readRunCount(runLog: string): Promise<number> {
  try {
    const text = await Deno.readTextFile(runLog);
    return text.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

// A retry config whose wait would be long enough to overrun a bounded run if
// the loop ever entered the rate-limit path — proving no wait accrued on OOM.
const SLOW_IF_RETRIED = {
  maxRetries: 3,
  maxWaitSeconds: 600,
  initialWaitInterval: 300,
} as const;

const COMMON_OPTS = {
  prompt: "test",
  model: "sonnet",
  enableModelFallback: true,
  timeoutSeconds: 30,
  killAfterSeconds: 2,
} as const;

// ---------------------------------------------------------------------------
// (a) OOM output is terminal — no retry, no wait.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - OOM output returns immediately with no retry or wait (Issue #2741)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, runs } = await withOomStub(
      "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory",
      1,
      async (stub) => {
        const result = await runClaudeWithRetry(COMMON_OPTS, SLOW_IF_RETRIED);
        return { result, runs: await readRunCount(stub.runLog) };
      },
    );

    assert(result.ok, `expected ok result, got ${!result.ok && result.error}`);
    if (!result.ok) return;

    // Terminal OOM signal: dedicated exit code + flag, not a timeout/rate limit.
    assertEquals(result.value.exitCode, OOM_EXIT_CODE);
    assertEquals(result.value.outOfMemory, true);
    assertEquals(result.value.timedOut, false);

    // The stub ran exactly once: the loop never re-entered for a retry, so no
    // wait could have accrued.
    assertEquals(runs, 1);
  },
});

// ---------------------------------------------------------------------------
// (b) A "heap limit" OOM that matches the secondary rate-limit regex is now
//     classified as OOM, not rate-limited.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - 'heap limit' OOM is OOM, not a secondary rate limit (Issue #2741)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // "Reached heap limit Allocation failed" contains "limit", which the
    // secondary rate-limit pattern /(try again|retry|limit)/i would match.
    const { result, runs } = await withOomStub(
      "FATAL ERROR: Reached heap limit Allocation failed - process out of memory",
      1,
      async (stub) => {
        const result = await runClaudeWithRetry(COMMON_OPTS, SLOW_IF_RETRIED);
        return { result, runs: await readRunCount(stub.runLog) };
      },
    );

    assert(result.ok);
    if (!result.ok) return;

    // Classified as OOM — exit code 2 (rate-limit give-up) is never returned.
    assertEquals(result.value.exitCode, OOM_EXIT_CODE);
    assertEquals(result.value.outOfMemory, true);
    assert(
      result.value.exitCode !== 2,
      "OOM must not be classified as a rate limit (exit code 2)",
    );
    assertEquals(runs, 1);
  },
});

// ---------------------------------------------------------------------------
// (c) Exit code 137: OOM evidence → OOM; no memory evidence → timeout.
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - exit 137 with OOM evidence is classified as OOM (Issue #2741)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { result, runs } = await withOomStub(
      "JavaScript heap out of memory",
      137,
      async (stub) => {
        const result = await runClaudeWithRetry(COMMON_OPTS, SLOW_IF_RETRIED);
        return { result, runs: await readRunCount(stub.runLog) };
      },
    );

    assert(result.ok);
    if (!result.ok) return;

    assertEquals(result.value.exitCode, OOM_EXIT_CODE);
    assertEquals(result.value.outOfMemory, true);
    assertEquals(result.value.timedOut, false);
    assertEquals(runs, 1);
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - exit 137 without memory evidence is killed, never a timeout (Issues #2741, #4202)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // A deliberate SIGKILL with no memory evidence. This used to keep
    // "timeout semantics" (remapped to 124, timedOut fabricated), which is
    // exactly the evidence-destruction Issue #4202 closes: observed live, a
    // VM OOM-kill at 539 s of a 3600 s budget was reported as a timeout.
    const { result } = await withOomStub(
      "Process killed by operator",
      137,
      async (stub) => {
        const result = await runClaudeWithRetry(COMMON_OPTS, SLOW_IF_RETRIED);
        return { result, runs: await readRunCount(stub.runLog) };
      },
    );

    assert(result.ok);
    if (!result.ok) return;

    // Faithful evidence: the kill keeps its own exit code and flag.
    assertEquals(result.value.exitCode, 137);
    assertEquals(result.value.killed, true);
    assertEquals(result.value.timedOut, false);
    assert(
      result.value.exitCode !== TIMEOUT_EXIT_CODE,
      "a kill must not be remapped onto the timeout exit code",
    );
    assert(
      result.value.outOfMemory !== true,
      "a 137 with no memory evidence must not be classified as OOM",
    );
  },
});
