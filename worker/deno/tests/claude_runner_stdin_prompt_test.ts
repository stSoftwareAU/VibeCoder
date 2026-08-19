/**
 * The agent prompt travels on stdin, not argv (Issue #4385).
 *
 * Observed live on vibe-coder-39849 (container mode, Linux VM): grill-me
 * round 2 on VibeCoder#4377 died at spawn with "Failed to spawn
 * '/usr/local/bin/claude': Argument list too long (os error 7)". The
 * prompt — issue body, every comment and the round-1 transcript — was
 * passed as ONE argv element, and Linux caps a single argument at 128 KiB
 * (MAX_ARG_STRLEN). macOS has no such cap, which is why native runs never
 * showed it. Claude Code reads the prompt from stdin when `-p` has no
 * positional value, so the runner pipes it instead.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";

/**
 * A stub `claude` that records its argv and the byte count it read from
 * stdin, then emits one stream-json result naming both.
 */
async function withStdinStub<T>(
  fn: (stub: { dir: string; argvLog: string }) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "claude_stdin_stub_" });
  const argvLog = `${dir}/argv.log`;
  const script = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$@" > '${argvLog}'`,
    `bytes=$(cat | wc -c | tr -d ' ')`,
    `printf '%s\\n' "{\\"type\\":\\"result\\",\\"result\\":\\"stdin_bytes=$bytes\\"}"`,
    "exit 0",
  ].join("\n");
  await Deno.writeTextFile(`${dir}/claude`, `${script}\n`);
  await Deno.chmod(`${dir}/claude`, 0o755);
  const originalPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${originalPath}`);
  try {
    return await fn({ dir, argvLog });
  } finally {
    Deno.env.set("PATH", originalPath);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "runClaudeWithRetry - a prompt over 128 KiB reaches the agent on stdin and never appears in argv (Issue #4385)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Well past MAX_ARG_STRLEN; multi-byte characters included so the byte
    // count, not the character count, is what travels.
    const prompt = "grill-me round 2 — ".repeat(12_000);
    const expectedBytes = new TextEncoder().encode(prompt).length;
    assert(expectedBytes > 131_072, "the fixture must exceed 128 KiB");

    await withStdinStub(async (stub) => {
      const result = await runClaudeWithRetry(
        {
          prompt,
          model: "sonnet",
          enableModelFallback: false,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 1 },
      );
      assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
      if (!result.ok) return;
      assertEquals(result.value.exitCode, 0);
      assert(
        result.value.output.includes(`stdin_bytes=${expectedBytes}`),
        `the whole prompt must arrive on stdin: ${result.value.output}`,
      );
      const argv = await Deno.readTextFile(stub.argvLog);
      const argvLines = argv.split("\n");
      assert(
        !argv.includes("grill-me round 2"),
        "no prompt text may be in argv",
      );
      assertEquals(argvLines.at(-2), "-p", `argv ends with a bare -p: ${argv}`);
      assert(
        argvLines.every((a) => a.length < 131_072),
        "no argv element reaches MAX_ARG_STRLEN",
      );
    });
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - an agent that exits before reading stdin does not hang or fail the runner (Issue #4385)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    // Auth-error shape: the CLI prints and exits without ever touching stdin.
    const dir = await Deno.makeTempDir({ prefix: "claude_stdin_early_" });
    await Deno.writeTextFile(
      `${dir}/claude`,
      `#!/usr/bin/env bash\nprintf '%s\\n' '{"type":"result","result":"left early"}'\nexit 3\n`,
    );
    await Deno.chmod(`${dir}/claude`, 0o755);
    const originalPath = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", `${dir}:${originalPath}`);
    try {
      const result = await runClaudeWithRetry(
        {
          prompt: "y".repeat(600_000), // far more than a pipe buffer holds
          model: "sonnet",
          enableModelFallback: false,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 1 },
      );
      assert(result.ok, `expected ok, got ${!result.ok && result.error}`);
      if (!result.ok) return;
      assertEquals(result.value.exitCode, 3);
      assert(result.value.output.includes("left early"));
    } finally {
      Deno.env.set("PATH", originalPath);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
