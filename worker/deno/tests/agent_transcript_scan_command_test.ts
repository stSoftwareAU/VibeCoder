/**
 * CLI tests for the agent-transcript-scan command (Issue #3700).
 *
 * Unit tests for the scanner live in agent_transcript_scan_test.ts.
 *
 * Uses Australian English throughout (behaviour, recognise).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { agentTranscriptScanCommand } from "../commands/agent_transcript_scan.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { TranscriptScanResult } from "../lib/agent_transcript_scan.ts";

const FLAGGED = new URL(
  "./fixtures/agent_transcripts/flagged.jsonl",
  import.meta.url,
);
const CLEAN = new URL(
  "./fixtures/agent_transcripts/clean.jsonl",
  import.meta.url,
);
const TRANSCRIPT = "agent-vibe-test02-abc123-3700.jsonl";

Deno.test("agentTranscriptScanCommand - has correct name", () => {
  assertEquals(agentTranscriptScanCommand.name, "agent-transcript-scan");
});

Deno.test("agentTranscriptScanCommand - fails loud naming each flagged signal", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.copyFile(FLAGGED, `${dir}/${TRANSCRIPT}`);
    const result = await agentTranscriptScanCommand.execute(
      { "log-dir": dir },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    assertStringIncludes(
      result.message,
      "[SECURITY] [AGENT_TRANSCRIPT_FLAGGED]",
    );
    assertStringIncludes(result.message, "egress");
    assertStringIncludes(result.message, "credential-read");
    assertStringIncludes(result.message, "disallowed-tool");
    assertStringIncludes(result.message, TRANSCRIPT);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agentTranscriptScanCommand - succeeds on a clean transcript", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.copyFile(CLEAN, `${dir}/${TRANSCRIPT}`);
    const result = await agentTranscriptScanCommand.execute(
      { "log-dir": dir },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "new findings 0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agentTranscriptScanCommand - fails loud when the log directory cannot be read", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const notADirectory = `${dir}/not-a-directory`;
    await Deno.writeTextFile(notADirectory, "x");
    const result = await agentTranscriptScanCommand.execute(
      { "log-dir": notADirectory },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    assert(
      result.message.startsWith("[SECURITY] [AGENT_TRANSCRIPT_SCAN_FAILED]"),
    );
    assertStringIncludes(result.message, notADirectory);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agentTranscriptScanCommand - fails loud when the scan state cannot be written", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.copyFile(CLEAN, `${dir}/${TRANSCRIPT}`);
    // A directory where the memo's temporary file must go makes the write fail.
    await Deno.mkdir(`${dir}/transcript-scan-state.json.tmp`);
    const result = await agentTranscriptScanCommand.execute(
      { "log-dir": dir },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    assertStringIncludes(
      result.message,
      "[SECURITY] [AGENT_TRANSCRIPT_SCAN_INCOMPLETE]",
    );
    assertStringIncludes(result.message, "state file:");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agentTranscriptScanCommand - names gzipped and unparsed input in a clean pass", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.copyFile(CLEAN, `${dir}/agent-vibe-test03-abc123-3700.jsonl`);
    const malformed = `${dir}/agent-vibe-test03-def456-3701.jsonl`;
    await Deno.writeTextFile(
      malformed,
      `${await Deno.readTextFile(CLEAN)}{not json\n`,
    );
    await Deno.writeFile(
      `${malformed}.gz`,
      new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
    );
    const result = await agentTranscriptScanCommand.execute(
      { "log-dir": dir },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "not checked (gzipped) 1");
    assertStringIncludes(result.message, "unparsed lines 1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agentTranscriptScanCommand - names more than ten findings by count", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const lines = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: `toolu_${i}`,
            name: "Bash",
            input: { command: `curl -s https://example.invalid/item-${i}` },
          }],
        },
        session_id: "s",
      }));
    await Deno.writeTextFile(`${dir}/${TRANSCRIPT}`, `${lines.join("\n")}\n`);
    const result = await agentTranscriptScanCommand.execute(
      { "log-dir": dir },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "12 new finding(s)");
    assertStringIncludes(result.message, "(and 2 more)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agentTranscriptScanCommand - returns the scan result as data on a flagged transcript", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.copyFile(FLAGGED, `${dir}/${TRANSCRIPT}`);
    const result = await agentTranscriptScanCommand.execute(
      { "log-dir": dir },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    const data = result.data as TranscriptScanResult | undefined;
    assert(data !== undefined);
    assertEquals(data.scannedFiles, [TRANSCRIPT]);
    assertEquals(data.newFindings.length, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agentTranscriptScanCommand - returns the scan result as data when the scan is incomplete", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.copyFile(CLEAN, `${dir}/${TRANSCRIPT}`);
    await Deno.mkdir(`${dir}/transcript-scan-state.json.tmp`);
    const result = await agentTranscriptScanCommand.execute(
      { "log-dir": dir },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    const data = result.data as TranscriptScanResult | undefined;
    assert(data !== undefined);
    assertEquals(typeof data.stateError, "string");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
