/**
 * Tests for the agent stream-json transcript tee (Issue #4169, proposal 2).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  agentTranscriptEnabled,
  agentTranscriptPath,
  AgentTranscriptWriter,
  maybeCreateAgentTranscriptWriter,
} from "../lib/agent_transcript.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import { createAgentStub } from "./support/agent_stub.ts";
import type { Logger } from "../types.ts";
import { fakeClock } from "./support/fake_clock.ts";

// Issue #1141 changed this rule deliberately: `DEBUG=true` used to enable the
// tee on its own, and a debug flag that silently starts capturing repository
// content is a surprise. The switch is now `.config.json`'s
// `agent_transcript_enabled`, which the worker driver settles into this
// variable at start; `DEBUG` no longer participates.
Deno.test("agent_transcript - enabled only by the settled transcript switch", () => {
  const env = (values: Record<string, string>) => (key: string) => values[key];
  assertEquals(agentTranscriptEnabled(env({})), false);
  assertEquals(agentTranscriptEnabled(env({ DEBUG: "false" })), false);
  assertEquals(agentTranscriptEnabled(env({ DEBUG: "true" })), false);
  assertEquals(
    agentTranscriptEnabled(env({ VIBE_AGENT_TRANSCRIPT: "true" })),
    true,
  );
  assertEquals(
    agentTranscriptEnabled(env({ VIBE_AGENT_TRANSCRIPT: "1" })),
    false,
  );
});

Deno.test("agent_transcript - path names the run id and issue number", () => {
  assertEquals(
    agentTranscriptPath("/home/vibe/logs", "vibe-abc123-def456", 4169),
    "/home/vibe/logs/agent-vibe-abc123-def456-4169.jsonl",
  );
  assertEquals(
    agentTranscriptPath("/home/vibe/logs", "vibe-abc123-def456"),
    "/home/vibe/logs/agent-vibe-abc123-def456.jsonl",
  );
});

Deno.test("agent_transcript - writes completed lines, carries partials across chunks", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agent_transcript_" });
  const filePath = `${dir}/agent-test.jsonl`;
  try {
    const writer = new AgentTranscriptWriter({ filePath });
    writer.feed('{"type":"assistant"}\n{"type":"to');
    writer.feed('ol_use"}\n');
    writer.close();
    const written = await Deno.readTextFile(filePath);
    assertEquals(written, '{"type":"assistant"}\n{"type":"tool_use"}\n');
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("agent_transcript - redacts secrets even when split across chunks", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agent_transcript_" });
  const filePath = `${dir}/agent-test.jsonl`;
  try {
    const writer = new AgentTranscriptWriter({ filePath });
    // A GitHub token split mid-secret across two stdout chunks: line-based
    // carry means the redactor always sees the whole line.
    writer.feed('{"text":"token ghp_ABCDEFGHIJKLMNOP');
    writer.feed('QRSTUVWXYZ0123456789 used"}\n');
    writer.close();
    const written = await Deno.readTextFile(filePath);
    assertStringIncludes(written, REDACTION_PLACEHOLDER);
    assert(!written.includes("ghp_"), `secret leaked: ${written}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("agent_transcript - close flushes a trailing partial line, redacted", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agent_transcript_" });
  const filePath = `${dir}/agent-test.jsonl`;
  try {
    const writer = new AgentTranscriptWriter({ filePath });
    writer.feed('{"final":"no trailing newline"}');
    writer.close();
    const written = await Deno.readTextFile(filePath);
    assertEquals(written, '{"final":"no trailing newline"}\n');
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("agent_transcript - a write failure disables the writer with one warning, never throws", () => {
  const warnings: string[] = [];
  const writer = new AgentTranscriptWriter({
    filePath: "/nonexistent-dir-for-test/agent-test.jsonl",
    warn: (m) => warnings.push(m),
  });
  writer.feed("line one\n");
  writer.feed("line two\n");
  writer.close();
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0]!, "transcript");
});

Deno.test("agent_transcript - size cap stops the tee with a warning", async () => {
  const dir = await Deno.makeTempDir({ prefix: "agent_transcript_" });
  const filePath = `${dir}/agent-test.jsonl`;
  const warnings: string[] = [];
  try {
    const writer = new AgentTranscriptWriter({
      filePath,
      maxBytes: 20,
      warn: (m) => warnings.push(m),
    });
    writer.feed("under the cap\n");
    writer.feed("this line must not land\n");
    writer.close();
    const written = await Deno.readTextFile(filePath);
    assertEquals(written, "under the cap\n");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "cap");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("agent_transcript - factory returns undefined when the switch is off", () => {
  const writer = maybeCreateAgentTranscriptWriter({
    env: () => undefined,
    issueNumber: 4169,
  });
  assertEquals(writer, undefined);
});

Deno.test("agent_transcript - factory derives the log-directory path and creates it", async () => {
  const home = await Deno.makeTempDir({ prefix: "agent_transcript_home_" });
  try {
    const env = (key: string) =>
      ({
        VIBE_AGENT_TRANSCRIPT: "true",
        HOME: home,
        VIBE_RUN_ID: "vibe-testrun-abc123",
      })[key];
    const writer = maybeCreateAgentTranscriptWriter({ env, issueNumber: 7 });
    assert(writer);
    assertEquals(
      writer.filePath,
      `${home}/logs/agent-vibe-testrun-abc123-7.jsonl`,
    );
    writer.feed('{"ok":true}\n');
    writer.close();
    const written = await Deno.readTextFile(writer.filePath);
    assertEquals(written, '{"ok":true}\n');
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => undefined);
  }
});

Deno.test({
  name:
    "agent_transcript - runClaudeWithTimeout tees the raw stream to the transcript file (Issue #4169)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
    // Named by path, never installed on the process-wide `PATH` (Issue #960).
    const stub = await createAgentStub(
      `printf '%s\\n' '${toolLine}'\n` +
        `printf '%s\\n' '{"type":"result","result":"done"}'\n`,
      { prefix: "agent_transcript_stub_" },
    );

    const transcriptPath = `${stub.dir}/agent-e2e.jsonl`;
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
        clock: fakeClock(),
        prompt: "test",
        agentBinaryPath: stub.path,
        phase: "execute",
        timeoutSeconds: 30,
        killAfterSeconds: 1,
        transcriptPath,
        logger,
      });
      assert(result.ok);
      const written = await Deno.readTextFile(transcriptPath);
      assertStringIncludes(written, '"tool_use"');
      assertStringIncludes(written, '"type":"result"');
    } finally {
      await stub.dispose();
    }
  },
});
