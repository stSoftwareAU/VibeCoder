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
  RetryOptions,
  RunClaudeOptions,
} from "../lib/claude_runner.ts";
import {
  getIdleTaskRunContext,
  IDLE_TASK_NO_OUTPUT_TIMEOUT_SECONDS,
  IDLE_TASK_TIMEOUT_SECONDS,
  resolveIdleTaskBudget,
  runIdleTaskClaude,
  withIdleTaskBudget,
  withIdleTaskRunContext,
} from "../lib/idle_task_claude_budget.ts";
import { OPERATIONAL_DEFAULTS } from "../lib/config_defaults.ts";
import { EXECUTE_TIMEOUT_FLOOR_SECONDS } from "../lib/execute_timeout.ts";
import type { Logger } from "../types.ts";

/** Logger that records the messages the budget emits. */
function recordingLogger(lines: string[]): Logger {
  return {
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m),
    debug: (m) => lines.push(m),
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

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

// ---------------------------------------------------------------------------
// Cycle-deadline bound (Issue #186)
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

Deno.test("withIdleTaskBudget bounds the scan to the runway left in the cycle", async () => {
  // The incident shape: a scan claimed five minutes before the deadline used
  // to get the full hour, so it ran ~55 min past the cycle.
  const deadline = NOW + 300_000;
  await withIdleTaskRunContext({ cycleDeadlineEpochMs: deadline }, () => {
    const opts = withIdleTaskBudget(
      { prompt: "scan", phase: "security_scan" },
      NOW,
    );
    // 300s of runway plus the kill grace — never the flat 3600s.
    assertEquals(
      opts.timeoutSeconds,
      300 + OPERATIONAL_DEFAULTS.claudeKillAfter,
    );
    return Promise.resolve();
  });
});

Deno.test("withIdleTaskBudget keeps the full budget when the cycle has runway", async () => {
  const deadline = NOW + 4 * 3600 * 1000;
  await withIdleTaskRunContext({ cycleDeadlineEpochMs: deadline }, () => {
    const opts = withIdleTaskBudget({ prompt: "scan" }, NOW);
    assertEquals(opts.timeoutSeconds, IDLE_TASK_TIMEOUT_SECONDS);
    return Promise.resolve();
  });
});

Deno.test("withIdleTaskBudget bounds an explicit caller timeout too", async () => {
  // A template asking for 1800s past the deadline is still refused it — the
  // deadline is an external commitment the launcher acts on.
  const deadline = NOW + 120_000;
  await withIdleTaskRunContext({ cycleDeadlineEpochMs: deadline }, () => {
    const opts = withIdleTaskBudget(
      { prompt: "scan", timeoutSeconds: 1800 },
      NOW,
    );
    assertEquals(
      opts.timeoutSeconds,
      120 + OPERATIONAL_DEFAULTS.claudeKillAfter,
    );
    return Promise.resolve();
  });
});

Deno.test("withIdleTaskBudget floors a past deadline rather than returning zero", async () => {
  const deadline = NOW - 600_000;
  await withIdleTaskRunContext({ cycleDeadlineEpochMs: deadline }, () => {
    const opts = withIdleTaskBudget({ prompt: "scan" }, NOW);
    assertEquals(opts.timeoutSeconds, EXECUTE_TIMEOUT_FLOOR_SECONDS);
    return Promise.resolve();
  });
});

Deno.test("withIdleTaskBudget announces the clamp on the context logger", async () => {
  const lines: string[] = [];
  await withIdleTaskRunContext(
    { cycleDeadlineEpochMs: NOW + 300_000, logger: recordingLogger(lines) },
    () => {
      withIdleTaskBudget({ prompt: "scan", phase: "security_scan" }, NOW);
      return Promise.resolve();
    },
  );
  assertEquals(lines.length, 1);
  assertEquals(lines[0]!.includes("security_scan"), true);
  assertEquals(lines[0]!.includes("cycle deadline"), true);
});

Deno.test("withIdleTaskBudget stays silent when the deadline does not bind", async () => {
  const lines: string[] = [];
  await withIdleTaskRunContext(
    {
      cycleDeadlineEpochMs: NOW + 4 * 3600 * 1000,
      logger: recordingLogger(lines),
    },
    () => {
      withIdleTaskBudget({ prompt: "scan" }, NOW);
      return Promise.resolve();
    },
  );
  assertEquals(lines, []);
});

Deno.test("resolveIdleTaskBudget reports whether the deadline bound the run", async () => {
  await withIdleTaskRunContext({ cycleDeadlineEpochMs: NOW + 300_000 }, () => {
    assertEquals(
      resolveIdleTaskBudget({ prompt: "scan" }, NOW).deadlineBound,
      true,
    );
    return Promise.resolve();
  });
  assertEquals(
    resolveIdleTaskBudget({ prompt: "scan" }, NOW).deadlineBound,
    false,
  );
});

// ---------------------------------------------------------------------------
// Progress logging (Issue #186)
// ---------------------------------------------------------------------------

Deno.test("idle-task scans always reach the runner with a logger", async () => {
  // Without a logger the runner's AgentProgressTracker sink is a no-op, so a
  // 20-minute scan logged nothing between claim and result.
  const lines: string[] = [];
  const logger = recordingLogger(lines);
  const captured: RunClaudeOptions[] = [];
  await withIdleTaskRunContext({ logger }, () =>
    runIdleTaskClaude(
      { prompt: "scan", phase: "security_scan" },
      undefined,
      fakeRunner(captured),
    ));
  assertEquals(captured[0]!.logger, logger);
});

Deno.test("an explicit caller logger outranks the run context", async () => {
  const contextLines: string[] = [];
  const callerLines: string[] = [];
  const callerLogger = recordingLogger(callerLines);
  const captured: RunClaudeOptions[] = [];
  await withIdleTaskRunContext(
    { logger: recordingLogger(contextLines) },
    () =>
      runIdleTaskClaude(
        { prompt: "scan", logger: callerLogger },
        undefined,
        fakeRunner(captured),
      ),
  );
  assertEquals(captured[0]!.logger, callerLogger);
});

Deno.test("a scan outside any run context still gets a logger", () => {
  const opts = withIdleTaskBudget({ prompt: "scan" }, NOW);
  assertEquals(typeof opts.logger?.info, "function");
});

// ---------------------------------------------------------------------------
// Run-context lifecycle (Issue #186)
// ---------------------------------------------------------------------------

Deno.test("withIdleTaskRunContext removes its context even when the body throws", async () => {
  assertEquals(getIdleTaskRunContext(), {});
  let threw = false;
  try {
    await withIdleTaskRunContext(
      { cycleDeadlineEpochMs: NOW },
      () => Promise.reject(new Error("scan blew up")),
    );
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(getIdleTaskRunContext(), {});
});

Deno.test("a concurrent slot finishing first leaves its sibling bounded", async () => {
  // Two slots (Issue #4177) run idle tasks at once. The first to finish must
  // not strip the deadline from the one still running.
  const deadline = NOW + 300_000;
  let releaseSlow: () => void = () => {};
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let slowTimeout: number | undefined;

  const slow = withIdleTaskRunContext(
    { cycleDeadlineEpochMs: deadline },
    async () => {
      await slowGate;
      slowTimeout = withIdleTaskBudget({ prompt: "slow" }, NOW).timeoutSeconds;
    },
  );
  await withIdleTaskRunContext(
    { cycleDeadlineEpochMs: deadline },
    () => Promise.resolve(),
  );
  releaseSlow();
  await slow;

  assertEquals(slowTimeout, 300 + OPERATIONAL_DEFAULTS.claudeKillAfter);
  assertEquals(getIdleTaskRunContext(), {});
});

Deno.test("runIdleTaskClaude suppresses retries once the deadline binds", async () => {
  // The timeout is resolved once and reused by every attempt, so a retry
  // after a rate-limit back-off would run the bounded budget again from past
  // the deadline.
  const captured: RunClaudeOptions[] = [];
  let seenRetry: RetryOptions | undefined;
  await withIdleTaskRunContext(
    { cycleDeadlineEpochMs: Date.now() + 120_000 },
    () =>
      runIdleTaskClaude(
        { prompt: "scan" },
        { maxRetries: 2, maxTotalInvocations: 3 },
        (opts, retry) => {
          seenRetry = retry;
          return fakeRunner(captured)(opts);
        },
      ),
  );
  assertEquals(seenRetry?.maxRetries, 0);
  // Unrelated retry settings survive.
  assertEquals(seenRetry?.maxTotalInvocations, 3);
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
