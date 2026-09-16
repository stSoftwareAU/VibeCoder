/**
 * Tests for the call-storm stall guard in the runner (Issue #2230).
 *
 * GRQ-23 slot s2 spent an hour and roughly 700 billed turns polling a
 * background `deno task test` — `pgrep`, `tail`, `echo w252` — without
 * changing one byte of the checkout. The silence watchdog saw output every
 * second and the progress extension only declined to extend, so nothing
 * stopped it until the execute budget ran out.
 *
 * What these tests pin:
 *
 * - a storming run is stopped at the interim check, with
 *   `timeoutReason: "call-storm"` and a log line naming the loop;
 * - a run whose checkout keeps advancing is never stopped, however many tool
 *   calls it makes;
 * - without the policy the behaviour is unchanged — the guard is opt-in at
 *   the runner seam, exactly like the progress extension it rides on.
 *
 * The agent is a stub script named by path (Issue #959) and the clock is
 * injected (PR #1170), so nothing here sleeps or depends on host load.
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
import type {
  ProgressExtensionPolicy,
  TreeProgressState,
} from "../lib/progress_extension.ts";
import type { CallStormPolicy } from "../lib/call_storm.ts";
import type { Logger } from "../types.ts";

/** One poll of a background job — the shape of the loop under test. */
function pollLine(marker: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        name: "Bash",
        input: { command: `echo ${marker}` },
      }],
    },
  });
}

/** A stub that fires a burst of polls and then waits to be released. */
function stormThenWait(polls: number): string {
  const lines = Array.from({ length: polls }, (_, i) => pollLine(`w${i}`));
  // One printf, so the whole burst reaches the tracker as a single chunk and
  // the test never has to guess how the pipe split it.
  return `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")}\n` +
    agentStubGate();
}

function installStub(body: string): Promise<AgentStub> {
  return createAgentStub(body, { prefix: "claude_call_storm_" });
}

/** Collect log lines so the stall reason can be asserted on. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  } as unknown as Logger;
  return { logger, lines };
}

/** A probe that answers the same verdict every time and counts its calls. */
function steadyProbe(verdict: TreeProgressState, clock: FakeClock) {
  const calls: number[] = [];
  const startedMs = clock.now();
  return {
    calls,
    probe: (): Promise<TreeProgressState> => {
      calls.push(clock.now() - startedMs);
      return Promise.resolve(verdict);
    },
  };
}

/** One-second checks, so a whole window passes in one clock advance. */
const POLICY: ProgressExtensionPolicy = {
  enabled: true,
  grantSeconds: 60,
  activityStallSeconds: 60,
  checkSeconds: 1,
};

/** Three calls in a one-second window is a storm, for test purposes. */
const CALL_STORM: CallStormPolicy = {
  enabled: true,
  windowSeconds: 1,
  callThreshold: 3,
};

/** Resolves when the nth stdout chunk has reached the progress tracker. */
function chunkRendezvous() {
  const chunks: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  let seen = 0;
  const at = (
    index: number,
  ) => (chunks[index] ??= Promise.withResolvers<void>());
  return {
    onActivity: () => at(seen++).resolve(),
    chunk: (n: number) => at(n - 1).promise,
  };
}

Deno.test({
  name:
    "runClaudeWithTimeout - a call storm with an unchanged tree is stopped at the interim check (Issue #2230)",
  fn: async () => {
    // Never released: the agent polls and then sits at the gate, exactly as
    // the GRQ-23 run did while it waited on a background test suite.
    const stub = await installStub(stormThenWait(4));
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const { calls, probe } = steadyProbe("unchanged", clock);
    const meet = chunkRendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        // A whole minute of budget left: the deadline is not what stops this
        // run — the interim check one second in is.
        timeoutSeconds: 60,
        killAfterSeconds: 1,
        logger,
        onActivity: meet.onActivity,
        progressExtension: {
          policy: POLICY,
          treeProbe: probe,
          callStorm: CALL_STORM,
        },
      });

      await meet.chunk(1);
      // One check interval, which is also one call-storm window.
      await clock.advance(1_000);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        true,
        "a storming run must be stopped",
      );
      assertEquals(
        result.value.timeoutReason,
        "call-storm",
        "the result must name the guard that stopped it, not a plain timeout",
      );
      assertEquals(
        calls.length,
        1,
        "the stop must land on the first interim check, not the deadline",
      );
      const stall = lines.find((l) => l.includes("[call-storm]")) ?? "";
      assert(stall, `the stall must be logged, got: ${JSON.stringify(lines)}`);
      assert(
        stall.includes("4 calls in 1s"),
        `the reason must name the rate: ${stall}`,
      );
      assert(
        stall.includes("tree unchanged"),
        `the reason must name the unchanged tree: ${stall}`,
      );
      assert(
        stall.includes("echo w3"),
        `the reason must name the loop's last call: ${stall}`,
      );
      // The elapsed seconds the guard reports are the run's own, so the
      // operator can tell a one-minute storm from an hour of one.
      assert(
        stall.includes("after 1s"),
        `the reason must say how long the run had been going: ${stall}`,
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a busy run that keeps changing the tree is never stopped (Issue #2230)",
  fn: async () => {
    const stub = await installStub(
      stormThenWait(10) +
        `printf '%s\\n' '{"type":"result","result":"done"}'\n`,
    );
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const { probe } = steadyProbe("advanced", clock);
    const meet = chunkRendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 60,
        killAfterSeconds: 1,
        logger,
        onActivity: meet.onActivity,
        progressExtension: {
          policy: POLICY,
          treeProbe: probe,
          callStorm: CALL_STORM,
        },
      });

      await meet.chunk(1);
      // Two whole windows of checks: the calls are there, but so is the work.
      await clock.advance(1_000);
      await clock.advance(1_000);
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a run whose checkout advances must not be stopped",
      );
      assertEquals(result.value.exitCode, 0);
      assertEquals(
        lines.filter((l) => l.includes("[call-storm]")),
        [],
        "nothing may be reported as a storm",
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - without the policy a storming run keeps its budget (Issue #2230)",
  fn: async () => {
    const stub = await installStub(
      stormThenWait(50) +
        `printf '%s\\n' '{"type":"result","result":"done"}'\n`,
    );
    const { logger, lines } = recordingLogger();
    const clock = fakeClock();
    const { probe } = steadyProbe("unchanged", clock);
    const meet = chunkRendezvous();
    try {
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        agentBinaryPath: stub.path,
        timeoutSeconds: 60,
        killAfterSeconds: 1,
        logger,
        onActivity: meet.onActivity,
        // No `callStorm`: the pre-#2230 wiring, unchanged.
        progressExtension: { policy: POLICY, treeProbe: probe },
      });

      await meet.chunk(1);
      await clock.advance(1_000);
      await clock.advance(1_000);
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "with no policy wired nothing may stop the run early",
      );
      assertEquals(result.value.exitCode, 0);
      assertEquals(lines.filter((l) => l.includes("[call-storm]")), []);
    } finally {
      await stub.dispose();
    }
  },
});
