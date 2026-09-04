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
import { createAgentStub } from "./support/agent_stub.ts";

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
    // hang shape.
    const stub = await createAgentStub(
      "( sleep 15 & )\n" +
        `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
        "sleep 60\n",
      { prefix: "claude_kill_bound_stub_" },
    );

    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    } as unknown as Logger;

    try {
      const started = Date.now();
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        killCompletionCapSeconds: 2,
        logger,
        agentBinaryPath: stub.path,
      });
      const elapsedSeconds = (Date.now() - started) / 1000;

      assert(result.ok, "the runner must return a result, not an error");
      if (!result.ok) return;
      assertEquals(result.value.timedOut, true);
      assertEquals(result.value.timeoutReason, "hard-timeout");
      assertEquals(result.value.exitCode, TIMEOUT_EXIT_CODE);
      assert(
        result.value.killIncompleteSeconds !== undefined &&
          result.value.killIncompleteSeconds >= 1,
        "the abandoned wait must be recorded in killIncompleteSeconds",
      );
      assert(
        elapsedSeconds < 12,
        `the runner must return within the cap, not hang (took ${elapsedSeconds}s)`,
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
        "sleep 60\n",
      { prefix: "claude_kill_clean_stub_" },
    );

    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        killCompletionCapSeconds: 30,
        logger: undefined,
        agentBinaryPath: stub.path,
      });
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
        `printf '%s\\n' '{"type":"result","result":"done"}'\n`,
      { prefix: "claude_reaped_pid_stub_" },
    );

    const logs: string[] = [];
    const logger = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
      debug: (m: string) => logs.push(m),
    } as unknown as Logger;

    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        streamDrainCapSeconds: 3,
        logger,
        agentBinaryPath: stub.path,
      });

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
