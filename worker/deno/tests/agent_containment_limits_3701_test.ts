import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { resolveAgentProvider } from "../lib/agent_provider.ts";
import { CLAUDE_OUTPUT_ADAPTER } from "../lib/claude_output_adapter.ts";
import { fakeClock } from "./support/fake_clock.ts";
import {
  runClaudeWithRetry,
  runClaudeWithTimeout,
} from "../lib/claude_runner.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { createLogger } from "../lib/logger.ts";
import { AgentTurnLimitError } from "../lib/claude_turn_limit.ts";
import { loadConfig } from "../lib/config.ts";

Deno.test("Claude invocation always carries a positive turn cap, including DeepSeek", () => {
  for (const provider of ["claude", "deepseek"]) {
    const args = resolveAgentProvider(provider).buildInvocation({
      prompt: "hello",
      env: () => undefined,
    });
    const at = args.indexOf("--max-turns");
    assertEquals(at >= 0, true);
    assertEquals(args[at + 1], "100");
    const configured = resolveAgentProvider(provider).buildInvocation({
      prompt: "hello",
      env: (key) => key === "VIBE_CLAUDE_MAX_TURNS" ? "7" : undefined,
    });
    assertEquals(configured[configured.indexOf("--max-turns") + 1], "7");
    assertThrows(
      () =>
        resolveAgentProvider(provider).buildInvocation({
          prompt: "hello",
          env: (key) => key === "VIBE_CLAUDE_MAX_TURNS" ? "0" : undefined,
        }),
      Error,
      "claude_max_turns",
    );
  }
});

Deno.test("Claude turn limit is terminal and distinct from the watchdog and quoted prose", () => {
  // Documented SDK result contract, not a captured live-model run:
  // https://code.claude.com/docs/en/agent-sdk/agent-loop
  const stdout = JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    num_turns: 7,
    errors: ["Reached max turns (7)"],
  });
  const decoded = CLAUDE_OUTPUT_ADAPTER.decode(stdout);
  const failure = CLAUDE_OUTPUT_ADAPTER.classify({
    stdout,
    stderr: "",
    exitCode: 1,
  }, decoded);
  assertEquals(failure?.category, "turn-limit");
  assertEquals(failure?.terminal, true);
  assertStringIncludes(failure?.message ?? "", "error_max_turns");
  assertEquals(
    CLAUDE_OUTPUT_ADAPTER.classify({
      stdout,
      stderr: "",
      exitCode: 124,
      timedOut: true,
    }, decoded)?.category,
    "timeout",
  );
  const quoted = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "error_max_turns",
  });
  assertEquals(
    CLAUDE_OUTPUT_ADAPTER.classify(
      { stdout: quoted, stderr: "", exitCode: 0 },
      CLAUDE_OUTPUT_ADAPTER.decode(quoted),
    ),
    undefined,
  );
});

Deno.test("config defaults and validates claude_max_turns", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/config.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({ repos: ["org/repo"], claude_max_turns: 9 }),
    );
    const configured = await loadConfig(path);
    assertEquals(configured.claudeMaxTurns, 9);
    await Deno.writeTextFile(path, JSON.stringify({ repos: ["org/repo"] }));
    assertEquals((await loadConfig(path)).claudeMaxTurns, 100);
    for (const bad of [0, -1, 1.5, "10"]) {
      await Deno.writeTextFile(
        path,
        JSON.stringify({ repos: ["org/repo"], claude_max_turns: bad }),
      );
      await assertRejects(() => loadConfig(path), Error, "claude_max_turns");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "turn-limit runner logs cause and cap and never retries or waits",
  ignore: Deno.build.os === "windows",
  async fn() {
    const logs: string[] = [];
    const event = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "Reached max turns (7); Invalid session ID; retry rate limit",
    });
    await withAgentStub(
      `printf 'run\\n' >> "$(dirname "$0")/runs"\nprintf '%s\\n' '${event}'\nexit 1`,
      async (stub) => {
        const result = await runClaudeWithRetry({
          prompt: "test",
          agentBinaryPath: stub.path,
          agentProvider: "claude",
          sessionResumeState: {
            sessionId: "00000000-0000-4000-8000-000000000001",
            phaseCount: 1,
            providerId: "claude",
          },
          timeoutSeconds: 30,
          clock: fakeClock(),
          env: (key) => key === "VIBE_CLAUDE_MAX_TURNS" ? "7" : undefined,
          logger: createLogger({ write: (line) => logs.push(line) }),
        }, { maxRetries: 2, maxWaitSeconds: 0, initialWaitInterval: 0 });
        assertEquals(result.ok, false);
        if (result.ok) {
          throw new Error("capped invocation must be a typed failure");
        }
        assertEquals(result.error instanceof AgentTurnLimitError, true);
        if (!(result.error instanceof AgentTurnLimitError)) throw result.error;
        assertEquals(result.error.executionResult?.timedOut, false);
        assertEquals(
          result.error.executionResult?.agentFailure?.category,
          "turn-limit",
        );
        assertEquals(
          (await Deno.readTextFile(`${stub.dir}/runs`)).trim(),
          "run",
        );
        assertStringIncludes(logs.join("\n"), "Reached max turns (7)");
        assertStringIncludes(
          logs.join("\n"),
          "claude_timeout=30 claude_max_turns=7",
        );
        assertStringIncludes(logs.join("\n"), "AGENT_TURN_LIMIT");
      },
    );
  },
});

Deno.test({
  name:
    "direct runner emits distinct turn-limit cause without the retry wrapper",
  ignore: Deno.build.os === "windows",
  async fn() {
    const logs: string[] = [];
    await withAgentStub(
      `printf '%s\\n' '{"type":"result","subtype":"error_max_turns","is_error":true}'\nexit 1`,
      async (stub) => {
        const result = await runClaudeWithTimeout({
          prompt: "test",
          agentBinaryPath: stub.path,
          agentProvider: "claude",
          clock: fakeClock(),
          timeoutSeconds: 30,
          logger: createLogger({ write: (line) => logs.push(line) }),
        });
        assertEquals(result.ok, true);
        assertStringIncludes(logs.join("\n"), "AGENT_TURN_LIMIT");
        assertStringIncludes(logs.join("\n"), "error_max_turns");
      },
    );
  },
});

Deno.test("turn-limit classifier requires its result subtype, not another error code or source", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
  });
  const decoded = CLAUDE_OUTPUT_ADAPTER.decode(stdout);
  for (
    const errors of [
      decoded.errors.map((error) => ({ ...error, code: "other_error" })),
      decoded.errors.map((error) => ({ ...error, source: "stderr" as const })),
    ]
  ) {
    assertEquals(
      CLAUDE_OUTPUT_ADAPTER.classify({ stdout, stderr: "", exitCode: 1 }, {
        ...decoded,
        errors,
      })?.category === "turn-limit",
      false,
    );
  }
});
