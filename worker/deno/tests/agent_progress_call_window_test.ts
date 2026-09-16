/**
 * Tests for the tracker's sliding tool-call window (Issue #2230).
 *
 * The call-storm guard asks the progress tracker one question — "how many
 * tool calls in the last N minutes?" — so the window must count real
 * stream-json events, drop what has aged out, and stay bounded on a run that
 * calls tools as fast as it can.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  AgentProgressTracker,
  TOOL_CALL_HISTORY_MS,
} from "../lib/agent_progress.ts";

function toolUseLine(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  }) + "\n";
}

/** A tracker on an injected clock the caller advances. */
function trackerAt(clock: { ms: number }): AgentProgressTracker {
  return new AgentProgressTracker({
    phase: "execute",
    intervalMs: 3_600_000, // never emits; this file tests the window only
    log: () => undefined,
    now: () => clock.ms,
  });
}

Deno.test("agent_progress - toolCallsSince counts only the calls inside the window", () => {
  const clock = { ms: 5_000_000 };
  const tracker = trackerAt(clock);

  // Ten calls a minute ago, then fifty in the last minute — the shape of the
  // echo/pgrep poll loop #2230 exists to stop.
  for (let i = 0; i < 10; i++) {
    tracker.feed(toolUseLine("Bash", { command: `echo w${i}` }));
  }
  clock.ms += 240_000;
  for (let i = 0; i < 50; i++) {
    tracker.feed(toolUseLine("Bash", { command: `echo w${i + 10}` }));
  }

  assertEquals(
    tracker.toolCallsSince(clock.ms - 300_000),
    60,
    "a five-minute window sees every call",
  );
  assertEquals(
    tracker.toolCallsSince(clock.ms - 60_000),
    50,
    "a one-minute window sees only the recent burst",
  );
  assertEquals(
    tracker.toolCallsSince(clock.ms + 1),
    0,
    "a window that has not opened yet sees nothing",
  );
});

Deno.test("agent_progress - toolCallsSince forgets calls older than the retention", () => {
  const clock = { ms: 5_000_000 };
  const tracker = trackerAt(clock);

  tracker.feed(toolUseLine("Read", { file_path: "README.md" }));
  clock.ms += TOOL_CALL_HISTORY_MS + 60_000;
  tracker.feed(toolUseLine("Bash", { command: "deno test" }));

  assertEquals(
    tracker.toolCallsSince(0),
    1,
    "the aged-out call is dropped, so only the fresh one is counted",
  );
  assertEquals(
    tracker.snapshot().toolCalls,
    2,
    "the lifetime counter still reports both",
  );
});

Deno.test("agent_progress - the window stays bounded on a storming run", () => {
  const clock = { ms: 5_000_000 };
  const tracker = trackerAt(clock);

  // Twenty thousand calls inside one retention window: nothing ages out by
  // time, so only the hard cap keeps the history from growing without bound.
  for (let i = 0; i < 20_000; i++) {
    tracker.feed(toolUseLine("Bash", { command: `echo w${i}` }));
    clock.ms += 10;
  }

  const counted = tracker.toolCallsSince(0);
  assert(
    counted <= 5_000,
    `the retained history must be capped, counted ${counted}`,
  );
  assert(
    counted >= 1_000,
    `the cap must still leave a usable window, counted ${counted}`,
  );
  assertEquals(tracker.snapshot().toolCalls, 20_000);
});

Deno.test("agent_progress - the snapshot names the last tool call for the stall reason", () => {
  const clock = { ms: 5_000_000 };
  const tracker = trackerAt(clock);

  assertEquals(
    tracker.snapshot().lastToolSummary,
    undefined,
    "no tool call yet, nothing to name",
  );
  tracker.feed(toolUseLine("Bash", { command: "echo w252" }));
  assertEquals(tracker.snapshot().lastToolSummary, "Bash echo w252");
});

Deno.test("agent_progress - Codex tool items land in the window too", () => {
  const clock = { ms: 5_000_000 };
  const tracker = trackerAt(clock);

  for (let i = 0; i < 3; i++) {
    tracker.feed(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: `item-${i}`,
          item_type: "command_execution",
          command: `echo w${i}`,
        },
      }) + "\n",
    );
  }

  assertEquals(tracker.toolCallsSince(clock.ms - 60_000), 3);
  assertEquals(tracker.snapshot().lastToolSummary, "Bash echo w2");
});
