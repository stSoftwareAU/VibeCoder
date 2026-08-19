/**
 * Tests for orphaned-Claude-tail cleanup (Issue #1906).
 *
 * Background: Claude Code spawns `tail -f /private/tmp/claude-${uid}/.../tasks/<id>.output`
 * subprocesses to monitor task output. When the worker exits unexpectedly
 * (e.g. `kill -9` from the user), those tails get reparented to PID 1
 * and survive indefinitely, holding file descriptors on long-deleted
 * task output files. This module provides:
 *
 *   - `isOrphanedClaudeTailLine` — a pure predicate that classifies a
 *     `ps`-style line as an orphaned Claude tail.
 *   - `cleanupOrphanedClaudeTails` — runs `ps`, filters via the predicate,
 *     and kills each matching PID.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  cleanupOrphanedClaudeTails,
  isOrphanedClaudeTailLine,
} from "../lib/claude_tail_cleanup.ts";

// ===========================================================================
// isOrphanedClaudeTailLine — pure predicate
// ===========================================================================

Deno.test("isOrphanedClaudeTailLine - matches the canonical orphaned tail (Issue #1906)", () => {
  const line =
    "39805 1 tail -f /private/tmp/claude-501/-Users-nigel-auto-issue-work-VibeCoder/4b8b17d4-74d4-4b6f-8b03-fb3c1feb3b2c/tasks/b7rtxwmgb.output";
  assertEquals(isOrphanedClaudeTailLine(line), 39805);
});

Deno.test("isOrphanedClaudeTailLine - matches Linux-style /tmp/claude-${uid} path", () => {
  const line = "42 1 tail -f /tmp/claude-1000/session-abc/tasks/xyz.output";
  assertEquals(isOrphanedClaudeTailLine(line), 42);
});

Deno.test("isOrphanedClaudeTailLine - matches tail -F (capital, follow rename)", () => {
  const line = "100 1 tail -F /private/tmp/claude-501/session/tasks/x.output";
  assertEquals(isOrphanedClaudeTailLine(line), 100);
});

Deno.test("isOrphanedClaudeTailLine - tolerates extra whitespace", () => {
  const line =
    "  100   1   tail -f /private/tmp/claude-501/session/tasks/x.output";
  assertEquals(isOrphanedClaudeTailLine(line), 100);
});

Deno.test("isOrphanedClaudeTailLine - rejects tails with a real parent (not orphaned)", () => {
  const line =
    "39805 12345 tail -f /private/tmp/claude-501/session/tasks/x.output";
  assertEquals(isOrphanedClaudeTailLine(line), null);
});

Deno.test("isOrphanedClaudeTailLine - rejects unrelated tail commands", () => {
  const line = "39805 1 tail -f /var/log/system.log";
  assertEquals(isOrphanedClaudeTailLine(line), null);
});

Deno.test("isOrphanedClaudeTailLine - rejects tail without follow flag", () => {
  const line = "39805 1 tail /private/tmp/claude-501/session/tasks/x.output";
  assertEquals(isOrphanedClaudeTailLine(line), null);
});

Deno.test("isOrphanedClaudeTailLine - rejects non-tail commands with claude-* in path", () => {
  const line = "39805 1 cat /private/tmp/claude-501/session/tasks/x.output";
  assertEquals(isOrphanedClaudeTailLine(line), null);
});

Deno.test("isOrphanedClaudeTailLine - rejects blank lines", () => {
  assertEquals(isOrphanedClaudeTailLine(""), null);
  assertEquals(isOrphanedClaudeTailLine("   "), null);
});

Deno.test("isOrphanedClaudeTailLine - rejects header line from ps", () => {
  assertEquals(
    isOrphanedClaudeTailLine("  PID  PPID COMMAND"),
    null,
  );
});

Deno.test("isOrphanedClaudeTailLine - rejects path that lacks the /tasks/ segment", () => {
  const line = "39805 1 tail -f /private/tmp/claude-501/session/logs/x.output";
  assertEquals(isOrphanedClaudeTailLine(line), null);
});

Deno.test("isOrphanedClaudeTailLine - rejects path that does not end with .output", () => {
  const line = "39805 1 tail -f /private/tmp/claude-501/session/tasks/x.txt";
  assertEquals(isOrphanedClaudeTailLine(line), null);
});

// ===========================================================================
// cleanupOrphanedClaudeTails — full sweep with injectable deps
// ===========================================================================

Deno.test("cleanupOrphanedClaudeTails - kills matching orphaned PIDs and returns them", async () => {
  const killed: number[] = [];
  const psOutput = [
    "39805 1 tail -f /private/tmp/claude-501/session/tasks/a.output",
    "39806 12345 tail -f /private/tmp/claude-501/session/tasks/b.output",
    "39807 1 tail -f /var/log/system.log",
    "39808 1 tail -F /tmp/claude-1000/session/tasks/c.output",
  ].join("\n");

  const result = await cleanupOrphanedClaudeTails({
    runPs: () => Promise.resolve(psOutput),
    kill: (pid) => {
      killed.push(pid);
      return Promise.resolve();
    },
  });

  assertEquals(result.killed.sort((a, b) => a - b), [39805, 39808]);
  assertEquals(killed.sort((a, b) => a - b), [39805, 39808]);
});

Deno.test("cleanupOrphanedClaudeTails - returns empty when nothing matches", async () => {
  const result = await cleanupOrphanedClaudeTails({
    runPs: () => Promise.resolve("39805 12345 tail -f /var/log/x"),
    kill: () => Promise.reject(new Error("kill should not be invoked")),
  });
  assertEquals(result.killed, []);
});

Deno.test("cleanupOrphanedClaudeTails - swallows kill errors and reports survivors", async () => {
  const psOutput = [
    "39805 1 tail -f /private/tmp/claude-501/session/tasks/a.output",
    "39806 1 tail -f /private/tmp/claude-501/session/tasks/b.output",
  ].join("\n");

  const result = await cleanupOrphanedClaudeTails({
    runPs: () => Promise.resolve(psOutput),
    kill: (pid) => {
      if (pid === 39805) return Promise.reject(new Error("EPERM"));
      return Promise.resolve();
    },
  });

  // Both PIDs are targeted; the failed kill is reported separately.
  assertEquals(result.killed, [39806]);
  assertEquals(result.failed.map((f) => f.pid), [39805]);
});

Deno.test("cleanupOrphanedClaudeTails - returns empty when ps fails", async () => {
  const result = await cleanupOrphanedClaudeTails({
    runPs: () => Promise.reject(new Error("ps not found")),
    kill: () => Promise.reject(new Error("should not be invoked")),
  });
  assertEquals(result.killed, []);
  assertEquals(result.failed, []);
});
