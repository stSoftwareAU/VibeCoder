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
 * - a storming run is stopped once two consecutive interim checks agree,
 *   with `timeoutReason: "call-storm"` and a log line naming the loop — one
 *   window is a warning, because a read-heavy investigation can reach the
 *   rate before its first edit;
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

/**
 * One burst of polls as a single `printf`, so the whole burst reaches the
 * tracker as one chunk and the test never guesses how the pipe split it.
 */
function burst(count: number, from = 0): string {
  const lines = Array.from(
    { length: count },
    (_, i) => pollLine(`w${i + from}`),
  );
  return `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")}\n`;
}

/** A stub that fires a burst of polls and then waits to be released. */
function stormThenWait(polls: number): string {
  return burst(polls) + agentStubGate();
}

/**
 * A stub that keeps polling: a burst, a pause, then another burst — which is
 * what a run waiting on a background job actually looks like. The sliding
 * window is genuinely sliding, so the second check sees fresh calls rather
 * than the first burst counted twice.
 */
function sustainedStorm(polls: number): string {
  return burst(polls) + agentStubGate("second") + burst(polls, polls) +
    agentStubGate();
}

function installStub(body: string): Promise<AgentStub> {
  return createAgentStub(body, { prefix: "claude_call_storm_" });
}

/**
 * Collect log lines, and let a test wait for one.
 *
 * The guard's own log line is the rendezvous: it is written after the check
 * has decided, so waiting on it proves the check completed rather than
 * guessing that an `advance` was enough. Nothing here sleeps.
 */
function recordingLogger(): {
  logger: Logger;
  lines: string[];
  waitFor(fragment: string): Promise<string>;
} {
  const lines: string[] = [];
  const waiters: { fragment: string; resolve: (line: string) => void }[] = [];
  const record = (message: string) => {
    lines.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter && message.includes(waiter.fragment)) {
        waiters.splice(i, 1);
        waiter.resolve(message);
      }
    }
  };
  const logger = {
    info: record,
    warn: record,
    error: record,
  } as unknown as Logger;
  return {
    logger,
    lines,
    waitFor: (fragment: string) => {
      const existing = lines.find((l) => l.includes(fragment));
      if (existing) return Promise.resolve(existing);
      return new Promise<string>((resolve) => {
        waiters.push({ fragment, resolve });
      });
    },
  };
}

/** A probe that answers the same verdict every time and counts its calls. */
function steadyProbe(verdict: TreeProgressState, clock: FakeClock) {
  const calls: number[] = [];
  const startedMs = clock.now();
  let waiters: (() => void)[] = [];
  return {
    calls,
    probe: (): Promise<TreeProgressState> => {
      calls.push(clock.now() - startedMs);
      const due = waiters;
      waiters = [];
      due.forEach((resolve) => resolve());
      return Promise.resolve(verdict);
    },
    /** Resolves once the probe has been asked at least `n` times. */
    called: (n: number): Promise<void> => {
      if (calls.length >= n) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const check = () => {
          if (calls.length >= n) resolve();
          else waiters.push(check);
        };
        waiters.push(check);
      });
    },
  };
}

/** A probe that replays a scripted verdict sequence. */
function scriptedProbe(verdicts: TreeProgressState[], clock: FakeClock) {
  const calls: number[] = [];
  const startedMs = clock.now();
  return {
    calls,
    probe: (): Promise<TreeProgressState> => {
      const verdict = verdicts[calls.length] ?? verdicts.at(-1) ?? "unknown";
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
    "runClaudeWithTimeout - a call storm with an unchanged tree is stopped once two checks agree (Issue #2230)",
  fn: async () => {
    // Never released: the agent polls and then sits at the gate, exactly as
    // the GRQ-23 run did while it waited on a background test suite.
    const stub = await installStub(sustainedStorm(4));
    const { logger, lines, waitFor } = recordingLogger();
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
      // One check interval, which is also one call-storm window. The first
      // storm window only warns — the run must still be alive.
      const warned = waitFor("check 1 of 2");
      await clock.advance(1_000);
      const warning = await warned;
      assert(
        warning.includes("[call-storm]"),
        `the first storm window must warn: ${warning}`,
      );
      // The loop keeps polling, so the next window has its own calls.
      await releaseAgentStub(stub, "second");
      await meet.chunk(2);
      // The second consecutive storm window is the stop.
      const stopped = waitFor("[call-storm] stopping the agent");
      await clock.advance(1_000);
      await stopped;
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) {
        return;
      }
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
        2,
        "the stop must land on the second interim check, not the deadline",
      );
      const stall = lines.find((l) =>
        l.includes("[call-storm] stopping the agent")
      ) ?? "";
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
        stall.includes("echo w7"),
        `the reason must name the loop's last call: ${stall}`,
      );
      // The elapsed seconds the guard reports are the run's own, so the
      // operator can tell a one-minute storm from an hour of one.
      assert(
        stall.includes("after 2s"),
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
    const { calls, probe, called } = steadyProbe("advanced", clock);
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
      await called(1);
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
      assert(calls.length >= 1, "an interim check must have run");
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
    const { calls, probe, called } = steadyProbe("unchanged", clock);
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
      await called(1);
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
      assert(calls.length >= 1, "an interim check must have run");
      assertEquals(lines.filter((l) => l.includes("[call-storm]")), []);
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a storm window followed by a working window does not stop the run (Issue #2230)",
  fn: async () => {
    // The streak has to be consecutive: one window of polling followed by a
    // window in which the checkout moved is an agent that went back to work,
    // and must not be stopped on the next storm window either.
    const stub = await installStub(
      sustainedStorm(4) +
        `printf '%s\\n' '{"type":"result","result":"done"}'\n`,
    );
    const { logger, lines, waitFor } = recordingLogger();
    const clock = fakeClock();
    const { calls, probe } = scriptedProbe(["unchanged", "advanced"], clock);
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
      const warned = waitFor("check 1 of 2");
      await clock.advance(1_000);
      await warned;
      // The agent commits something, so the next check is not a storm and
      // the streak is spent.
      await releaseAgentStub(stub, "second");
      await meet.chunk(2);
      await clock.advance(1_000);
      await releaseAgentStub(stub);
      const result = await run;

      assert(result.ok, "the runner must return a result");
      if (!result.ok) return;
      assertEquals(
        result.value.timedOut,
        false,
        "a run that went back to work must not be stopped",
      );
      assertEquals(result.value.exitCode, 0);
      assertEquals(
        calls.length >= 2,
        true,
        `both checks must have run, got ${JSON.stringify(calls)}`,
      );
      assertEquals(
        lines.filter((l) => l.includes("stopping the agent")),
        [],
        "the run must never be stopped on a non-consecutive streak",
      );
    } finally {
      await stub.dispose();
    }
  },
});
