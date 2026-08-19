/**
 * Tests for the shared idle-task Claude budget (SEC-2d46e408d10c, Issue #3657).
 *
 * Idle-task scans used to reach `runClaudeWithRetry` without a
 * `timeoutSeconds` or a `noOutputTimeout`, inheriting the library defaults
 * (a four-hour hard cap and a disabled silence watchdog). These tests pin the
 * shared budget and the wrapper that applies it.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import type { Result } from "../types.ts";
import type {
  ClaudeRunResult,
  RunClaudeOptions,
} from "../lib/claude_runner.ts";
import {
  IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS,
  IDLE_TASK_TIMEOUT_SECONDS,
  runIdleTaskClaude,
  withIdleTaskBudget,
} from "../lib/idle_task_claude_budget.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";

/** Capture the options a fake runner was handed. */
function fakeRunner(captured: RunClaudeOptions[]) {
  return (opts: RunClaudeOptions): Promise<Result<ClaudeRunResult>> => {
    captured.push(opts);
    return Promise.resolve({
      ok: true,
      value: { exitCode: 0, output: "", timedOut: false },
    });
  };
}

Deno.test("idle-task budget matches the configured issue-work budget", () => {
  assertEquals(IDLE_TASK_TIMEOUT_SECONDS, OPERATIONAL_DEFAULTS.claudeTimeout);
  assertEquals(
    IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS,
    OPERATIONAL_DEFAULTS.claudeNoOutputTimeout,
  );
});

Deno.test("idle-task budget is well below the 4-hour library default", () => {
  // The library default is 14400s with the silence watchdog disabled; the
  // whole point of Issue #3657 is that idle tasks must not inherit it.
  assertEquals(IDLE_TASK_TIMEOUT_SECONDS < 14400, true);
  assertEquals(IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS > 0, true);
});

Deno.test("withIdleTaskBudget fills in both bounds when omitted", () => {
  const opts = withIdleTaskBudget({ prompt: "scan", phase: "dead_code" });
  assertEquals(opts.timeoutSeconds, IDLE_TASK_TIMEOUT_SECONDS);
  assertEquals(opts.noOutputTimeout, IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS);
  // Unrelated fields survive untouched.
  assertEquals(opts.prompt, "scan");
  assertEquals(opts.phase, "dead_code");
});

Deno.test("withIdleTaskBudget honours an explicit caller override", () => {
  const opts = withIdleTaskBudget({
    prompt: "scan",
    timeoutSeconds: 900,
    noOutputTimeout: 120,
  });
  assertEquals(opts.timeoutSeconds, 900);
  assertEquals(opts.noOutputTimeout, 120);
});

Deno.test("withIdleTaskBudget honours a deliberate watchdog opt-out", () => {
  // `0` is a caller's explicit decision, not an omission — it must survive.
  const opts = withIdleTaskBudget({ prompt: "scan", noOutputTimeout: 0 });
  assertEquals(opts.noOutputTimeout, 0);
});

Deno.test("runIdleTaskClaude hands the budgeted options to the runner", async () => {
  const captured: RunClaudeOptions[] = [];
  const result = await runIdleTaskClaude(
    { prompt: "scan", cwd: "/tmp/repo", phase: "test_audit" },
    undefined,
    fakeRunner(captured),
  );

  assertEquals(result.ok, true);
  assertEquals(captured.length, 1);
  const seen = captured[0]!;
  assertEquals(seen.timeoutSeconds, IDLE_TASK_TIMEOUT_SECONDS);
  assertEquals(seen.noOutputTimeout, IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS);
  assertEquals(seen.cwd, "/tmp/repo");
});

Deno.test("runIdleTaskClaude forwards retry options unchanged", async () => {
  const captured: RunClaudeOptions[] = [];
  let seenRetry: unknown;
  await runIdleTaskClaude(
    { prompt: "scan" },
    { maxRetries: 1, maxTotalInvocations: 3 },
    (opts, retry) => {
      seenRetry = retry;
      return fakeRunner(captured)(opts);
    },
  );

  assertEquals(seenRetry, { maxRetries: 1, maxTotalInvocations: 3 });
});
