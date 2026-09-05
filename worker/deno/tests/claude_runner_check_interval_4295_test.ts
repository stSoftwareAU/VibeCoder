/**
 * Tests for the progress-extension check interval in the runner
 * (Issue #4295, part of #4290).
 *
 * With `checkSeconds` set the watchdog wakes on the check interval as well as
 * on the deadline. An interim wake only *samples* the working tree — it can
 * never kill, because the budget has not run out — so the deadline decision
 * reads a verdict describing the last check window instead of the whole grant.
 *
 * The agent is a stub script named by path (Issue #959) and the tree probe
 * is injected, so no test needs a git repository and nothing here touches
 * the process-wide `PATH`. The clock is injected too (PR #1170 follow-up):
 * each interim wake happens because the test moved the clock one interval on,
 * so "the tree was sampled three times" is a count rather than a hope about
 * how many 200 ms ticks fitted into two seconds of a loaded host.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  type AgentStub,
  agentStubGate,
  createAgentStub,
  releaseAgentStub,
} from "./support/agent_stub.ts";
import { type FakeClock, fakeClock } from "./support/fake_clock.ts";
import type { TreeProgressState } from "../lib/progress_extension.ts";
import type { Logger } from "../types.ts";

/** One stream-json line carrying a tool call, so the activity signal moves. */
const TOOL_LINE =
  `{"type":"assistant","message":{"content":[{"type":"tool_use",` +
  `"name":"Edit","input":{"file_path":"worker/deno/lib/x.ts"}}]}}`;

/**
 * Write a stub agent and return its path.
 *
 * Named by path rather than installed on the process-wide `PATH`
 * (Issue #959), so the file no longer races the rest of the suite.
 *
 * The stub runs in the `deno test` process group — deliberately, so the
 * watchdog signals its PID and descendants and never a process GROUP
 * (Issue #471; see the note in {@link file://../../../CODING-STANDARDS.md}).
 * `terminateProcessTree` already refuses a group signal for a target sharing
 * our group, and `terminateDescendants` still reaps the stub's children, so
 * the kill under test is exercised end to end without a signal that can
 * escape the tree.
 *
 * @param body - Bash body of the stub, after the shebang.
 */
function installStub(body: string): Promise<AgentStub> {
  return createAgentStub(body, { prefix: "claude_check_interval_" });
}

/** A stub that reports one tool call, waits at the gate, then finishes. */
function toolThenFinish(): string {
  return `printf '%s\\n' '${TOOL_LINE}'\n` +
    agentStubGate() +
    `printf '%s\\n' '{"type":"result","result":"done"}'\n`;
}

/** Discard log lines — these tests assert on outcomes, not on the log. */
function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

/**
 * A probe that records when each call landed — as milliseconds since the run
 * started — and always answers `verdict`.
 */
function countingProbe(verdict: TreeProgressState, clock: FakeClock) {
  const startedMs = clock.now();
  const calls: number[] = [];
  return {
    calls,
    probe: (): Promise<TreeProgressState> => {
      calls.push(clock.now() - startedMs);
      return Promise.resolve(verdict);
    },
  };
}

Deno.test({
  name:
    "runClaudeWithTimeout - the tree is sampled on the check interval, not only at the deadline (Issue #4295)",
  fn: async () => {
    // ~2 s of steady tool calls against a 1 s budget with 0.2 s checks: the
    // deadline alone would produce a single probe call (Issue #4296).
    const stub = await installStub(toolThenFinish());
    const clock = fakeClock();
    const { calls, probe } = countingProbe("advanced", clock);
    const firstChunk = Promise.withResolvers<void>();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        logger: silentLogger(),
        onActivity: () => firstChunk.resolve(),
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 10,
            activityStallSeconds: 60,
            checkSeconds: 0.2,
          },
          treeProbe: probe,
        },
      });
      await firstChunk.promise;
      // Three check intervals inside the one-second budget: each is an
      // interim sample, and the deadline itself is never reached.
      for (let sample = 0; sample < 3; sample++) {
        const rearmed = clock.nextArm();
        await clock.advance(200);
        await rearmed;
      }
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a progressing run must not be killed",
      );
      assertEquals(
        calls,
        [200, 400, 600],
        "the tree is sampled on the check interval, not only at the deadline",
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - an interim check gathers evidence only and never kills (Issue #4295)",
  fn: async () => {
    // The tree never advances, but the run finishes well inside its budget:
    // the interim checks must not kill it, because the budget is what the
    // deadline guards — the checks only sample.
    const stub = await installStub(toolThenFinish());
    const clock = fakeClock();
    const { calls, probe } = countingProbe("unchanged", clock);
    const firstChunk = Promise.withResolvers<void>();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 5,
        killAfterSeconds: 1,
        logger: silentLogger(),
        onActivity: () => firstChunk.resolve(),
        progressExtension: {
          policy: {
            enabled: true,
            grantSeconds: 5,
            activityStallSeconds: 60,
            checkSeconds: 0.1,
          },
          treeProbe: probe,
        },
      });
      await firstChunk.promise;
      for (let sample = 0; sample < 2; sample++) {
        const rearmed = clock.nextArm();
        await clock.advance(100);
        await rearmed;
      }
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "an unchanged tree inside the budget is not a reason to kill",
      );
      assertEquals(
        calls,
        [100, 200],
        "the interim checks ran, and neither of them killed the run",
      );
    } finally {
      await stub.dispose();
    }
  },
});
