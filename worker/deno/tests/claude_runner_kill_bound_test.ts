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
    const dir = await Deno.makeTempDir({ prefix: "claude_kill_bound_stub_" });
    // Double-fork: the subshell exits immediately, so the sleeper re-parents
    // to init before the watchdog's descendant sweep runs — it survives the
    // kill and keeps the inherited stdout pipe open, exactly the host-25
    // hang shape.
    const stubPath = `${dir}/claude`;
    await Deno.writeTextFile(
      stubPath,
      "#!/usr/bin/env bash\n( sleep 15 & )\n" +
        `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
        "sleep 60\n",
    );
    await Deno.chmod(stubPath, 0o755);
    const originalPath = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", `${dir}:${originalPath}`);

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
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - a clean kill still settles normally with no killIncompleteSeconds (Issue #4254)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "claude_kill_clean_stub_" });
    const stubPath = `${dir}/claude`;
    await Deno.writeTextFile(
      stubPath,
      "#!/usr/bin/env bash\n" +
        `printf '%s\\n' '{"type":"result","result":"working"}'\n` +
        "sleep 60\n",
    );
    await Deno.chmod(stubPath, 0o755);
    const originalPath = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", `${dir}:${originalPath}`);

    try {
      const result = await runClaudeWithTimeout({
        prompt: "test",
        timeoutSeconds: 1,
        killAfterSeconds: 1,
        killCompletionCapSeconds: 30,
        logger: undefined,
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
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
  },
});
