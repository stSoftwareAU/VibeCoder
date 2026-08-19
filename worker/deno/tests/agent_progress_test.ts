/**
 * Tests for the agent-phase progress tracker (Issue #4169).
 *
 * A 70+ minute execute phase used to show nothing in worker-*.log between
 * "Processing issue …" and the outcome — indistinguishable from a hang
 * without host access. The worker already parses the agent's stream-json
 * (the no-output watchdog proves it); the tracker turns those events into
 * one compact progress line per interval.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type AgentActivitySnapshot,
  AgentProgressTracker,
} from "../lib/agent_progress.ts";
import type { Logger } from "../types.ts";

function toolUseLine(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  }) + "\n";
}

Deno.test("agent_progress - stays silent before the interval elapses", () => {
  let clock = 1_000_000;
  const lines: string[] = [];
  const tracker = new AgentProgressTracker({
    phase: "execute",
    intervalMs: 60_000,
    log: (m) => lines.push(m),
    now: () => clock,
  });

  tracker.feed(toolUseLine("Edit", { file_path: "worker/deno/lib/a.ts" }));
  clock += 30_000;
  tracker.feed(toolUseLine("Bash", { command: "deno test" }));
  assertEquals(lines, [], "no line before the interval");
});

Deno.test("agent_progress - emits one compact line per interval with the last tool call", () => {
  let clock = 1_000_000;
  const lines: string[] = [];
  const tracker = new AgentProgressTracker({
    phase: "execute",
    intervalMs: 60_000,
    log: (m) => lines.push(m),
    now: () => clock,
  });

  tracker.feed(toolUseLine("Read", { file_path: "README.md" }));
  clock += 55_000;
  tracker.feed(toolUseLine("Edit", { file_path: "worker/deno/lib/b.ts" }));
  clock += 8_000; // 63s since start — interval elapsed
  tracker.feed(toolUseLine("Bash", { command: "git status" }));

  assertEquals(lines.length, 1, "exactly one line per interval");
  const line = lines[0]!;
  assertStringIncludes(line, "[agent-progress] execute");
  assertStringIncludes(line, "1m3s elapsed");
  assertStringIncludes(line, "3 tool calls");
  assertStringIncludes(line, "Bash git status");
  assertStringIncludes(line, "0s ago");

  // The next interval produces the next line, not a flood.
  clock += 30_000;
  tracker.feed(toolUseLine("Write", { file_path: "notes.md" }));
  assertEquals(lines.length, 1);
  clock += 31_000;
  tracker.feed(toolUseLine("Edit", { file_path: "worker/deno/lib/c.ts" }));
  assertEquals(lines.length, 2);
  assertStringIncludes(lines[1]!, "5 tool calls");
});

Deno.test("agent_progress - reassembles tool_use events split across chunks", () => {
  let clock = 1_000_000;
  const lines: string[] = [];
  const tracker = new AgentProgressTracker({
    phase: "planning",
    intervalMs: 1_000,
    log: (m) => lines.push(m),
    now: () => clock,
  });

  const whole = toolUseLine("Edit", { file_path: "split/across/chunks.ts" });
  tracker.feed(whole.slice(0, 25));
  clock += 2_000;
  tracker.feed(whole.slice(25));

  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "1 tool call");
  assertStringIncludes(lines[0]!, "split/across/chunks.ts");
});

Deno.test("agent_progress - non-JSON noise and text blocks never break tracking", () => {
  let clock = 1_000_000;
  const lines: string[] = [];
  const tracker = new AgentProgressTracker({
    phase: "grill-me",
    intervalMs: 1_000,
    log: (m) => lines.push(m),
    now: () => clock,
  });

  tracker.feed("not json at all\n{broken json\n");
  tracker.feed(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "thinking aloud" }] },
    }) + "\n",
  );
  clock += 2_000;
  tracker.feed("more noise\n");

  assertEquals(lines.length, 1, "activity without tool calls still reports");
  assertStringIncludes(lines[0]!, "0 tool calls");
  assertStringIncludes(lines[0]!, "grill-me");
});

Deno.test("agent_progress - long bash commands are truncated in the summary", () => {
  let clock = 1_000_000;
  const lines: string[] = [];
  const tracker = new AgentProgressTracker({
    phase: "execute",
    intervalMs: 1_000,
    log: (m) => lines.push(m),
    now: () => clock,
  });

  tracker.feed(toolUseLine("Bash", { command: "x".repeat(300) }));
  clock += 2_000;
  tracker.feed("\n"); // interval check fires with the long call still last

  assert(lines[0]!.length < 260, `line too long: ${lines[0]!.length}`);
  assertStringIncludes(lines[0]!, "…");
});

// ---------------------------------------------------------------------------
// snapshot() — the readable activity signal (Issue #4293, part of #4290)
// ---------------------------------------------------------------------------

Deno.test("agent_progress - snapshot before any chunk: zero calls, no tool time, no chunk time advanced (Issue #4293)", () => {
  const clock = 1_000_000;
  const tracker = new AgentProgressTracker({
    phase: "execute",
    log: () => undefined,
    now: () => clock,
  });
  const snap = tracker.snapshot();
  assertEquals(snap.toolCalls, 0);
  assertEquals(snap.lastToolCallAtMs, undefined);
  // Nothing fed yet: the chunk time is the construction time.
  assertEquals(snap.lastChunkAtMs, 1_000_000);
});

Deno.test("agent_progress - snapshot: prose-only chunks advance lastChunkAtMs but never lastToolCallAtMs (Issue #4293)", () => {
  let clock = 1_000_000;
  const tracker = new AgentProgressTracker({
    phase: "execute",
    log: () => undefined,
    now: () => clock,
  });
  clock += 5_000;
  tracker.feed(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking…"}]}}\n',
  );
  clock += 5_000;
  tracker.feed("plain prose that is not JSON at all\n");
  const snap = tracker.snapshot();
  assertEquals(snap.toolCalls, 0);
  assertEquals(snap.lastToolCallAtMs, undefined);
  assertEquals(snap.lastChunkAtMs, 1_010_000);
});

Deno.test("agent_progress - snapshot: one tool call, then many, with the last call's time (Issue #4293)", () => {
  let clock = 1_000_000;
  const tracker = new AgentProgressTracker({
    phase: "execute",
    log: () => undefined,
    now: () => clock,
  });
  clock += 1_000;
  tracker.feed(toolUseLine("Read", { file_path: "a.ts" }));
  let snap = tracker.snapshot();
  assertEquals(snap.toolCalls, 1);
  assertEquals(snap.lastToolCallAtMs, 1_001_000);
  assertEquals(snap.lastChunkAtMs, 1_001_000);

  for (let i = 0; i < 4; i++) {
    clock += 1_000;
    tracker.feed(toolUseLine("Bash", { command: `step ${i}` }));
  }
  snap = tracker.snapshot();
  assertEquals(snap.toolCalls, 5);
  assertEquals(snap.lastToolCallAtMs, 1_005_000);
});

Deno.test("agent_progress - snapshot: a tool_use line split across two feeds counts once, at the completing chunk's time (Issue #4293)", () => {
  let clock = 1_000_000;
  const tracker = new AgentProgressTracker({
    phase: "execute",
    log: () => undefined,
    now: () => clock,
  });
  const line = toolUseLine("Edit", { file_path: "worker/deno/lib/x.ts" });
  const cut = Math.floor(line.length / 2);
  clock += 1_000;
  tracker.feed(line.slice(0, cut));
  assertEquals(tracker.snapshot().toolCalls, 0, "half a line is not a call");
  assertEquals(tracker.snapshot().lastChunkAtMs, 1_001_000);
  clock += 1_000;
  tracker.feed(line.slice(cut));
  const snap = tracker.snapshot();
  assertEquals(snap.toolCalls, 1);
  assertEquals(snap.lastToolCallAtMs, 1_002_000);
});

Deno.test("agent_progress - snapshot: malformed and non-JSON lines never throw and never count as tool activity (Issue #4293)", () => {
  let clock = 1_000_000;
  const tracker = new AgentProgressTracker({
    phase: "execute",
    log: () => undefined,
    now: () => clock,
  });
  clock += 1_000;
  tracker.feed(
    '{"type":"assistant","message":{"content":[{"type":"tool_use"\n',
  ); // truncated JSON mentioning tool_use
  tracker.feed('not json but says "tool_use" in prose\n');
  tracker.feed("{}\n");
  tracker.feed('{"message":{"content":"tool_use"}}\n'); // content not an array
  const snap = tracker.snapshot();
  assertEquals(snap.toolCalls, 0);
  assertEquals(snap.lastToolCallAtMs, undefined);
  assertEquals(snap.lastChunkAtMs, 1_001_000);
});

Deno.test({
  name:
    "agent_progress - runClaudeWithTimeout logs progress lines from a live stream (Issue #4169)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "agent_progress_stub_" });
    const stubPath = `${dir}/claude`;
    const toolLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Edit",
          input: { file_path: "worker/deno/lib/live.ts" },
        }],
      },
    });
    await Deno.writeTextFile(
      stubPath,
      "#!/usr/bin/env bash\n" +
        `printf '%s\\n' '${toolLine}'\n` +
        "sleep 2\n" +
        `printf '%s\\n' '${toolLine}'\n` +
        `printf '%s\\n' '{"type":"result","result":"done"}'\n`,
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
      const { runClaudeWithTimeout } = await import(
        "../lib/claude_runner.ts"
      );
      const result = await runClaudeWithTimeout({
        prompt: "test",
        phase: "execute",
        timeoutSeconds: 30,
        killAfterSeconds: 1,
        progressIntervalMs: 1_000,
        logger,
      });
      assert(result.ok);
      const progressLines = logs.filter((m) =>
        m.includes("[agent-progress] execute")
      );
      assert(
        progressLines.length >= 1,
        `expected a progress line; logs: ${logs.join(" | ")}`,
      );
      assertStringIncludes(progressLines[0]!, "tool call");
      assertStringIncludes(progressLines[0]!, "worker/deno/lib/live.ts");
    } finally {
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
  },
});

Deno.test({
  name:
    "agent_progress - runClaudeWithTimeout builds and feeds the tracker with NO logger: the activity signal exists, no progress lines are emitted (Issue #4293)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "agent_progress_stub_" });
    const stubPath = `${dir}/claude`;
    const toolLine = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Edit",
          input: { file_path: "worker/deno/lib/live.ts" },
        }],
      },
    });
    await Deno.writeTextFile(
      stubPath,
      "#!/usr/bin/env bash\n" +
        `printf '%s\\n' '${toolLine}'\n` +
        `printf '%s\\n' '${toolLine}'\n` +
        `printf '%s\\n' '{"type":"result","result":"done"}'\n`,
    );
    await Deno.chmod(stubPath, 0o755);
    const originalPath = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", `${dir}:${originalPath}`);

    const snapshots: AgentActivitySnapshot[] = [];
    // A console spy: with no logger, NOTHING may be printed for progress.
    const printed: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => printed.push(args.join(" "));
    console.log = (...args: unknown[]) => printed.push(args.join(" "));
    try {
      const { runClaudeWithTimeout } = await import(
        "../lib/claude_runner.ts"
      );
      const result = await runClaudeWithTimeout({
        prompt: "test",
        phase: "execute",
        timeoutSeconds: 30,
        killAfterSeconds: 1,
        progressIntervalMs: 1, // would emit on every chunk IF a sink existed
        onActivity: (snap) => snapshots.push(snap),
        // no logger
      });
      assert(result.ok);
      assert(snapshots.length >= 1, "the tracker must be fed without a logger");
      const last = snapshots[snapshots.length - 1]!;
      assertEquals(last.toolCalls, 2);
      assert(last.lastToolCallAtMs !== undefined);
      assert(last.lastChunkAtMs >= last.lastToolCallAtMs!);
      assertEquals(
        printed.filter((m) => m.includes("[agent-progress]")),
        [],
        "no progress lines without a logger",
      );
    } finally {
      console.error = originalError;
      console.log = originalLog;
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => undefined);
    }
  },
});
