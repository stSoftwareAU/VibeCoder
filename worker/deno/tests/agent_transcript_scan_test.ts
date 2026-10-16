/**
 * Tests for the scheduled agent transcript scan (Issue #3700).
 *
 * Covers the per-line signal rules, the directory pass (ledger dedupe, the
 * size-and-mtime memo, gzipped transcripts, a missing directory) and the
 * hostile-input growth bounds.
 *
 * Uses Australian English throughout (behaviour, recognise, memoised).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { assertLinearGrowth } from "./support/growth.ts";
import {
  type RecordedTranscriptFinding,
  scanAgentTranscripts,
  scanTranscriptLine,
  TRANSCRIPT_SCAN_FINDINGS_FILE,
  TRANSCRIPT_SCAN_STATE_FILE,
} from "../lib/agent_transcript_scan.ts";

const FLAGGED = new URL(
  "./fixtures/agent_transcripts/flagged.jsonl",
  import.meta.url,
);
const CLEAN = new URL(
  "./fixtures/agent_transcripts/clean.jsonl",
  import.meta.url,
);
const TRANSCRIPT = "agent-vibe-test01-abc123-3700.jsonl";

/** Run `run` against a fresh temp log directory, removed afterwards. */
async function withLogDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Copy a fixture into `dir` under a transcript name. */
async function seed(
  dir: string,
  source: URL,
  name: string = TRANSCRIPT,
): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.copyFile(source, path);
  return path;
}

/** Every record in the findings ledger, in file order. */
async function readLedger(dir: string): Promise<RecordedTranscriptFinding[]> {
  const text = await Deno.readTextFile(
    `${dir}/${TRANSCRIPT_SCAN_FINDINGS_FILE}`,
  );
  return text.split("\n").filter((line) => line.length > 0).map((line) =>
    JSON.parse(line) as RecordedTranscriptFinding
  );
}

/** A stream-json assistant event carrying one Bash tool_use. */
function assistantBash(command: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_t",
        name: "Bash",
        input: { command },
      }],
    },
    session_id: "s",
  });
}

/** A stream-json assistant event carrying one tool_use of any tool. */
function assistantTool(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_t", name, input }],
    },
    session_id: "s",
  });
}

/** A stream-json user event carrying one tool_result. */
function userResult(content: unknown, isError: boolean): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        content,
        is_error: isError,
        tool_use_id: "toolu_t",
      }],
    },
    session_id: "s",
  });
}

/** A stream-json result event carrying the given permission denials. */
function resultWith(denials: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    permission_denials: denials,
    session_id: "s",
  });
}

/** The signals `scanTranscriptLine` reports for one line. */
function signalsOf(line: string): string[] {
  return scanTranscriptLine(line).findings.map((f) => f.signal);
}

Deno.test("scanAgentTranscripts - flags a seeded transcript carrying flagged signals (Issue #3700)", async () => {
  await withLogDir(async (dir) => {
    await seed(dir, FLAGGED);
    const result = await scanAgentTranscripts(dir, {
      now: new Date("2026-10-16T00:00:00Z"),
    });

    const located = result.newFindings.map((f) => [f.signal, f.file, f.line]);
    assertEquals(located, [
      ["egress", TRANSCRIPT, 5],
      ["credential-read", TRANSCRIPT, 7],
      ["disallowed-tool", TRANSCRIPT, 10],
      ["disallowed-tool", TRANSCRIPT, 12],
    ]);
    assertStringIncludes(
      result.newFindings[0]!.detail,
      'network client "curl"',
    );
    assertStringIncludes(
      result.newFindings[1]!.detail,
      "/home/vibe/.ssh/id_ed25519",
    );
    assertEquals(
      result.newFindings[2]!.detail,
      "guard refusal [WRITE_REPO_BLOCKED]",
    );
    assertStringIncludes(
      result.newFindings[3]!.detail,
      "permission denied: WebFetch",
    );
    assertEquals(result.newFindings[0]!.detectedAt, "2026-10-16T00:00:00.000Z");

    const ledger = await readLedger(dir);
    assertEquals(ledger, result.newFindings);
  });
});

Deno.test("scanAgentTranscripts - passes a clean transcript (Issue #3700)", async () => {
  await withLogDir(async (dir) => {
    await seed(dir, CLEAN);
    const result = await scanAgentTranscripts(dir);
    assertEquals(result.newFindings, []);
    assertEquals(result.unreadable, []);
    assertEquals(result.scannedFiles, [TRANSCRIPT]);
  });
});

Deno.test("scanAgentTranscripts - does not re-report a finding on the next pass (Issue #3700)", async () => {
  await withLogDir(async (dir) => {
    await seed(dir, FLAGGED);
    const first = await scanAgentTranscripts(dir);
    assert(first.newFindings.length > 0);

    const second = await scanAgentTranscripts(dir);
    assertEquals(second.newFindings.length, 0);
    assertEquals(second.unchangedFiles, 1);

    // Forget the memo: the file is read again, and the ledger still stops
    // every finding from being recorded a second time.
    await Deno.remove(`${dir}/${TRANSCRIPT_SCAN_STATE_FILE}`);
    const third = await scanAgentTranscripts(dir);
    assertEquals(third.newFindings.length, 0);
    assert(third.knownFindings > 0);
    assertEquals(third.scannedFiles, [TRANSCRIPT]);

    const ledger = await readLedger(dir);
    assertEquals(ledger.length, first.newFindings.length);
  });
});

Deno.test("scanAgentTranscripts - a rotated rename is not rescanned (Issue #3700)", async () => {
  await withLogDir(async (dir) => {
    const path = await seed(dir, FLAGGED);
    await scanAgentTranscripts(dir);

    await Deno.rename(path, `${path}.1`);
    const result = await scanAgentTranscripts(dir);
    assertEquals(result.newFindings, []);
    assertEquals(result.unchangedFiles, 1);
    assertEquals(result.scannedFiles, []);
  });
});

Deno.test("scanAgentTranscripts - reports a gzipped transcript as not checked (Issue #3700)", async () => {
  await withLogDir(async (dir) => {
    const gz = `${TRANSCRIPT}.gz`;
    await Deno.writeFile(
      `${dir}/${gz}`,
      new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
    );
    const result = await scanAgentTranscripts(dir);
    assertEquals(result.notChecked, [gz]);
    assertEquals(result.scannedFiles.includes(gz), false);
  });
});

Deno.test("scanAgentTranscripts - a missing log directory is an empty clean result (Issue #3700)", async () => {
  await withLogDir(async (dir) => {
    const result = await scanAgentTranscripts(`${dir}/does-not-exist`);
    assertEquals(result.newFindings, []);
    assertEquals(result.unreadable, []);
    assertEquals(result.scannedFiles, []);
    assertEquals(result.stateError, undefined);
  });
});

Deno.test("scanAgentTranscripts - ignores files that are not transcripts (Issue #3700)", async () => {
  await withLogDir(async (dir) => {
    const curl = assistantBash("curl -s https://example.invalid/upload");
    await Deno.writeTextFile(`${dir}/worker-1.log`, `${curl}\n`);
    await Deno.writeTextFile(`${dir}/self-heal.jsonl`, `${curl}\n`);
    const result = await scanAgentTranscripts(dir);
    assertEquals(result.newFindings, []);
    assertEquals(result.scannedFiles, []);
  });
});

Deno.test("scanTranscriptLine - flags egress via curl, a wrapped wget and a /dev/tcp socket (Issue #3700)", () => {
  assertEquals(
    signalsOf(assistantBash("curl -s https://example.invalid")),
    ["egress"],
  );
  const wrapped = scanTranscriptLine(assistantBash("timeout 30 wget x"));
  assertEquals(wrapped.findings.map((f) => f.signal), ["egress"]);
  assertStringIncludes(wrapped.findings[0]!.detail, 'network client "wget"');
  assertEquals(
    signalsOf(assistantBash("cat < /dev/tcp/example.invalid/443")),
    ["egress"],
  );
});

Deno.test("scanTranscriptLine - flags each network client named in command position (Issue #3700)", () => {
  const clients = [
    "nc",
    "ncat",
    "netcat",
    "socat",
    "telnet",
    "ssh",
    "scp",
    "sftp",
    "ftp",
  ];
  for (const client of clients) {
    const scan = scanTranscriptLine(
      assistantBash(`${client} example.invalid 443`),
    );
    assertEquals(scan.findings.map((f) => f.signal), ["egress"], client);
    assertStringIncludes(
      scan.findings[0]!.detail,
      `network client "${client}"`,
    );
  }
});

Deno.test("scanTranscriptLine - looks through each wrapper word to the network client it runs (Issue #3700)", () => {
  const wrappers = ["sudo", "env", "nohup", "exec", "command", "time", "xargs"];
  for (const wrapper of wrappers) {
    const scan = scanTranscriptLine(
      assistantBash(`${wrapper} curl example.invalid`),
    );
    assertEquals(scan.findings.map((f) => f.signal), ["egress"], wrapper);
    assertStringIncludes(scan.findings[0]!.detail, 'network client "curl"');
  }
});

Deno.test("scanTranscriptLine - does not flag a git commit that mentions ssh (Issue #3700)", () => {
  assertEquals(
    signalsOf(assistantBash('git commit -m "fix ssh handling"')),
    [],
  );
});

Deno.test("scanTranscriptLine - flags reads of credential paths (Issue #3700)", () => {
  assertEquals(
    signalsOf(
      assistantTool("Read", { file_path: "/home/vibe/.ssh/id_ed25519" }),
    ),
    ["credential-read"],
  );
  assertEquals(
    signalsOf(assistantBash("cat ~/.aws/credentials")),
    ["credential-read"],
  );
  assertEquals(
    signalsOf(
      assistantTool("Grep", {
        path: "~/.config/gh/hosts.yml",
        pattern: "oauth",
      }),
    ),
    ["credential-read"],
  );
});

Deno.test("scanTranscriptLine - checks the tail of an over-long token for a credential path (Issue #3700)", () => {
  const longPath = "/" + "a".repeat(5000) + "/.ssh/id_rsa";
  assertEquals(
    signalsOf(assistantTool("Read", { file_path: longPath })),
    ["credential-read"],
  );
});

Deno.test("scanTranscriptLine - does not flag an Edit that mentions a credential path (Issue #3700)", () => {
  assertEquals(
    signalsOf(
      assistantTool("Edit", {
        file_path: "worker/deno/lib/foo.ts",
        old_string: "const a = 1;",
        new_string: "// Never copy .ssh/ keys or run curl from here",
      }),
    ),
    [],
  );
});

Deno.test("scanTranscriptLine - flags disallowed-tool attempts (Issue #3700)", () => {
  const denied = scanTranscriptLine(
    resultWith([{
      tool_name: "Bash",
      tool_use_id: "toolu_x",
      tool_input: { command: "ls" },
    }]),
  );
  assertEquals(denied.findings.map((f) => f.signal), ["disallowed-tool"]);
  assertEquals(denied.findings[0]!.tool, "Bash");
  assertStringIncludes(
    denied.findings[0]!.detail,
    'permission denied: Bash {"command":"ls"}',
  );

  assertEquals(
    signalsOf(
      userResult("[SECURITY] [WRITE_REPO_BLOCKED] Refused pr create", true),
    ),
    ["disallowed-tool"],
  );
  assertEquals(
    signalsOf(
      userResult(
        [{ type: "text", text: "[SECURITY] [ISSUE_LIFECYCLE_REFUSED] no" }],
        true,
      ),
    ),
    ["disallowed-tool"],
  );
  assertEquals(
    signalsOf(
      userResult(
        "<tool_use_error>Error: No such tool available: WebFetch</tool_use_error>",
        true,
      ),
    ),
    ["disallowed-tool"],
  );
});

Deno.test("scanTranscriptLine - does not flag benign tool results (Issue #3700)", () => {
  assertEquals(
    signalsOf(
      userResult(
        "Exit code 1\n[SECURITY] [GH_BODY_UNREDACTABLE] a body read from stdin cannot be scanned",
        true,
      ),
    ),
    [],
  );
  assertEquals(
    signalsOf(
      userResult("[SECURITY] [WRITE_REPO_BLOCKED] Refused pr create", false),
    ),
    [],
  );
  assertEquals(
    signalsOf(
      userResult(
        "<tool_use_error>Error: No such tool available: bash. Tool names are case-sensitive: call Bash instead.</tool_use_error>",
        true,
      ),
    ),
    [],
  );
});

Deno.test("scanTranscriptLine - reports a malformed line as unparsed (Issue #3700)", () => {
  assertEquals(scanTranscriptLine("{not json").parsed, false);
  assertEquals(scanTranscriptLine("plain text").parsed, false);
  assertEquals(scanTranscriptLine("[1,2]").parsed, false);
  assertEquals(scanTranscriptLine("").parsed, true);
});

Deno.test("scanTranscriptLine - keeps each detail redacted and within 200 characters (Issue #3700)", () => {
  const command =
    `curl -H "Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://example.invalid/${
      "a".repeat(500)
    }`;
  const [finding] = scanTranscriptLine(assistantBash(command)).findings;
  assert(finding !== undefined);
  assert(finding.detail.length <= 200);
  assertEquals(
    finding.detail.includes("abcdefghijklmnopqrstuvwxyz0123456789"),
    false,
  );
});

Deno.test("scanTranscriptLine - an unclosed guard marker grows linearly (Issue #3700)", () => {
  const build = (chars: number) =>
    userResult("[SECURITY] [" + "A_".repeat(Math.ceil(chars / 2)), true);
  const scanned = assertLinearGrowth(
    "unclosed guard marker",
    build,
    (line) => scanTranscriptLine(line),
    { baseChars: 20_000 },
  );
  assertEquals(scanned.findings, []);
});

Deno.test("scanTranscriptLine - a run of quote characters grows linearly (Issue #3700)", () => {
  const build = (chars: number) =>
    assistantBash("'\"".repeat(Math.ceil(chars / 2)) + "x");
  const scanned = assertLinearGrowth(
    "run of quote characters",
    build,
    (line) => scanTranscriptLine(line),
    { baseChars: 20_000 },
  );
  assertEquals(scanned.findings, []);
});

Deno.test("scanTranscriptLine - a run of separators grows linearly (Issue #3700)", () => {
  const build = (chars: number) =>
    assistantBash(" ;|&".repeat(Math.ceil(chars / 4)) + "ls");
  const scanned = assertLinearGrowth(
    "run of separators",
    build,
    (line) => scanTranscriptLine(line),
    { baseChars: 20_000 },
  );
  assertEquals(scanned.findings, []);
});

/** Whether a file of `mode` blocks `access` on this host (false on root and Windows). */
async function modeBlocks(
  mode: number,
  access: "read" | "write",
): Promise<boolean> {
  if (Deno.build.os === "windows") return false;
  const probeDir = await Deno.makeTempDir();
  const probe = `${probeDir}/probe`;
  try {
    await Deno.writeTextFile(probe, "");
    await Deno.chmod(probe, mode);
    try {
      const file = access === "read"
        ? await Deno.open(probe, { read: true })
        : await Deno.open(probe, { write: true });
      file.close();
      return false;
    } catch {
      return true;
    }
  } finally {
    await Deno.remove(probeDir, { recursive: true });
  }
}

/** Whether a read-only (0o444) file refuses writes here; skips the test otherwise. */
const READ_ONLY_ENFORCED = await modeBlocks(0o444, "write");
/** Whether a 0o000 file refuses reads here; skips the test otherwise. */
const UNREADABLE_ENFORCED = await modeBlocks(0o000, "read");

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("scanAgentTranscripts - an unreadable findings ledger throws rather than re-reporting", async () => {
  await withLogDir(async (dir) => {
    await seed(dir, FLAGGED);
    await Deno.mkdir(`${dir}/${TRANSCRIPT_SCAN_FINDINGS_FILE}`);
    await assertRejects(
      () => scanAgentTranscripts(dir),
      Error,
      "cannot read findings ledger",
    );
  });
});

Deno.test({
  name:
    "scanAgentTranscripts - a ledger append failure throws and leaves the files unmemoised",
  ignore: !READ_ONLY_ENFORCED,
  fn: async () => {
    await withLogDir(async (dir) => {
      await seed(dir, FLAGGED);
      const ledger = `${dir}/${TRANSCRIPT_SCAN_FINDINGS_FILE}`;
      await Deno.writeTextFile(ledger, "");
      await Deno.chmod(ledger, 0o444);
      await assertRejects(
        () => scanAgentTranscripts(dir),
        Error,
        "cannot record findings in",
      );
      assertEquals(
        await pathExists(`${dir}/${TRANSCRIPT_SCAN_STATE_FILE}`),
        false,
      );

      await Deno.chmod(ledger, 0o644);
      const retry = await scanAgentTranscripts(dir);
      assertEquals(retry.scannedFiles, [TRANSCRIPT]);
      assertEquals(retry.unchangedFiles, 0);
      assertEquals(retry.newFindings.length, 4);
    });
  },
});

Deno.test({
  name:
    "scanAgentTranscripts - an unreadable transcript is reported, not memoised",
  ignore: !UNREADABLE_ENFORCED,
  fn: async () => {
    await withLogDir(async (dir) => {
      const path = await seed(dir, FLAGGED);
      await Deno.chmod(path, 0o000);
      const first = await scanAgentTranscripts(dir);
      assertEquals(first.unreadable.map((u) => u.file), [TRANSCRIPT]);
      assertEquals(first.scannedFiles, []);
      assertEquals(first.newFindings, []);

      await Deno.chmod(path, 0o644);
      const second = await scanAgentTranscripts(dir);
      assertEquals(second.unreadable, []);
      assertEquals(second.scannedFiles, [TRANSCRIPT]);
      assertEquals(second.newFindings.length, 4);
    });
  },
});
