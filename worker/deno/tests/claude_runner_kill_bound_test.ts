/**
 * Tests for the bounded post-kill wait (Issue #4254).
 *
 * Observed on host-25: after the hard watchdog fired and killed the process
 * tree, `runClaudeWithTimeout` still awaited `child.status` and the stream
 * pumps with no bound — 1 h 40 m and 8 h 37 m holes in the log, and one
 * cycle stretched to 11 h 30 m holding its claim the whole time. The classic
 * trigger is an orphaned grandchild that survives the tree kill (it
 * re-parented to init before the sweep) and holds the stdout pipe open, so
 * the pumps never finish even though the agent itself is dead.
 *
 * The clock is injected (PR #1170 follow-up). Both watchdogs and the
 * kill-completion cap now expire because the test moved the clock there, so
 * "the wait was abandoned at the cap" is an exact figure rather than an
 * elapsed reading bounded at twelve seconds — this file was one of the two
 * that went red in #1170's own loaded run.
 *
 * The contract these tests pin:
 * - After a watchdog kill, the runner waits at most the kill-completion cap
 *   for the child to settle, then abandons the wait, logs the evidence, and
 *   returns the timed-out result with `killIncompleteSeconds` set.
 * - The cap never drops below the floor, so production kills always get a
 *   real grace window.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  KILL_COMPLETION_FLOOR_SECONDS,
  KILL_COMPLETION_MULTIPLIER,
  killCompletionCapMs,
  runClaudeWithTimeout,
} from "../lib/claude_runner.ts";
import { TIMEOUT_EXIT_CODE } from "../lib/claude_executor.ts";
import type { Logger } from "../types.ts";
import { agentStubGate, createAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

Deno.test("killCompletionCapMs - scales with the grace period but never below the floor (Issue #4254)", () => {
  assertEquals(
    killCompletionCapMs(30),
    30 * KILL_COMPLETION_MULTIPLIER * 1000,
    "a normal grace period scales by the multiplier",
  );
  assertEquals(
    killCompletionCapMs(1),
    KILL_COMPLETION_FLOOR_SECONDS * 1000,
    "a tiny grace period still gets the floor",
  );
});

Deno.test({
  name:
    "runClaudeWithTimeout - abandons the post-kill wait when an orphan holds stdout open (Issue #4254)",
  // The orphan deliberately survives the tree kill and holds the pipe; the
  // abandoned pumps and child handle are the exact condition under test.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Double-fork: the subshell exits immediately, so the sleeper re-parents
    // to init before the watchdog's descendant sweep runs — it survives the
    // kill and keeps the inherited stdout pipe open, exactly the host-25
    // hang shape. The agent itself then waits at a gate it is never let
    // through, so the only thing that ends this run is the runner.
    const stub = await createAgentStub(
      "( sleep 15 & )\n" +
        `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
        agentStubGate(),
      { prefix: "claude_kill_bound_stub_" },
    );

    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    } as unknown as Logger;

    try {
      const clock = fakeClock();
      const firstChunk = Promise.withResolvers<void>();
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        killCompletionCapSeconds: 2,
        logger,
        agentBinaryPath: stub.path,
        onActivity: () => firstChunk.resolve(),
      });
      // The agent is up and the watchdogs are armed.
      await firstChunk.promise;
      // The hard deadline expires and the tree kill fires.
      await clock.advance(1_000);
      // Two more seconds — the kill-completion cap — during which the orphan
      // still holds the pipe, so the runner abandons the wait.
      await clock.advance(2_000);
      const result = await run;

      assert(result.ok, "the runner must return a result, not an error");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(result.value.timeoutReason, "hard-timeout");
      assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
      assertEquals(
        result.value.killIncompleteSeconds,
        2,
        "the abandoned wait is recorded, and it is exactly the cap",
      );
      assert(
        logs.some((m) => m.includes("did not complete")),
        "abandoning the wait must be logged with evidence",
      );
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a clean kill still settles normally with no killIncompleteSeconds (Issue #4254)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const stub = await createAgentStub(
      `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
        agentStubGate(),
      { prefix: "claude_kill_clean_stub_" },
    );

    try {
      const clock = fakeClock();
      const firstChunk = Promise.withResolvers<void>();
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        killCompletionCapSeconds: 30,
        logger: undefined,
        agentBinaryPath: stub.path,
        onActivity: () => firstChunk.resolve(),
      });
      await firstChunk.promise;
      // The deadline expires and the kill lands. Nothing holds the pipe, so
      // the child settles on its own and the cap is never reached — the test
      // never advances the clock to it, which is the point.
      await clock.advance(1_000);
      const result = await run;
      assert(result.ok);
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(
        result.value.killIncompleteSeconds,
        undefined,
        "a kill that completes must not be flagged as incomplete",
      );
    } finally {
      await stub.dispose();
    }
  },
});

/**
 * Wait until the pid the stub recorded has been reaped.
 *
 * A dead-but-unreaped process is still a live pid to `kill -0`, so a `false`
 * here means the kernel has released it and `child.status` has settled — the
 * precondition the #471 case is about. Bounded, so a stub that never records
 * its pid fails the case rather than hanging the suite.
 */
async function waitForReaped(pidFile: string): Promise<void> {
  let pid = 0;
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (pid === 0) {
      try {
        pid = Number((await Deno.readTextFile(pidFile)).trim());
      } catch {
        pid = 0;
      }
    }
    if (pid > 0) {
      const out = await new Deno.Command("kill", {
        args: ["-0", String(pid)],
        stdout: "null",
        stderr: "null",
      }).output();
      if (!out.success) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the agent pid in ${pidFile} was never reaped`);
}

Deno.test({
  name:
    "runClaudeWithTimeout - a watchdog waking after the child was reaped sends no signal and keeps the child's real status (Issue #471)",
  // The orphan deliberately outlives the agent and holds the pipe; the
  // abandoned pump and child handle are the condition under test.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // The agent exits straight away, so it is REAPED almost immediately. A
    // double-forked orphan inherits stdout and holds it open, so the runner
    // is still in its bounded stream drain when the 1s hard deadline expires.
    // That is the window in which the watchdog used to fire at a pid the
    // kernel was already free to reuse — and the stray group signal is what
    // took the CI runner down mid-suite.
    const stub = await createAgentStub(
      "( sleep 4 & )\n" +
        `echo $$ > "$(dirname "$0")/agent.pid"\n` +
        `printf '%s\\n' '{"type":"result","result":"done"}'\n`,
      { prefix: "claude_reaped_pid_stub_" },
    );
    const agentPidFile = `${stub.dir}/agent.pid`;

    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
      debug: (m: string) => logs.push(m),
    } as unknown as Logger;

    try {
      const clock = fakeClock();
      const firstChunk = Promise.withResolvers<void>();
      const run = runClaudeWithTimeout({
        clock,
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        streamDrainCapSeconds: 3,
        logger,
        agentBinaryPath: stub.path,
        onActivity: () => firstChunk.resolve(),
      });
      await firstChunk.promise;
      // Wait until the agent's pid is genuinely gone. A zombie still answers
      // `kill -0`, so it stops answering only once it has been reaped — which
      // is exactly the state the watchdog must find. Polling for it, rather
      // than sleeping past it, is what makes the window under test the one
      // the case is named after on every host.
      await waitForReaped(agentPidFile);
      // The hard deadline expires inside the drain: the watchdog wakes with
      // nothing left to signal.
      await clock.advance(1_000);
      // The drain cap ends the run; the orphan still holds the pipe.
      await clock.advance(3_000);
      const result = await run;

      assert(result.ok, "the runner must return a result, not an error");
      if (!result.ok) return;
      // The child reported its own status before the deadline, so a watchdog
      // waking during the drain must not reclassify the run as a timeout.
      assertEquals(
        result.value.timedOut,
        false,
        "a run whose child exited cleanly must not be reported as timed out",
      );
      assertEquals(result.value.exitCode, 0);
      assert(
        !logs.some((m) => m.includes("Watchdog kill failed")),
        "no kill may be attempted against the reaped pid",
      );
    } finally {
      await stub.dispose();
    }
  },
});
