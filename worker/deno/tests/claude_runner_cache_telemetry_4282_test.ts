/**
 * Tests that the runner surfaces the Anthropic prompt-cache hit rate for every
 * invocation (Issue #4282).
 *
 * The harness mirrors `claude_runner_invocation_budget_3648_test.ts`: a stub
 * agent, named by path rather than installed on `PATH` (Issue #959), that
 * prints one stream-json result line carrying the usage fields the API
 * reports, so the assertions run against the real `runClaudeWithTimeout`
 * parsing and logging path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { type AgentStub, withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** Usage figures the stub reports on its result line. */
interface StubUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Run `fn` with a stub agent that reports `usage`. */
function withUsageStub<T>(
  usage: StubUsage,
  fn: (stub: AgentStub) => Promise<T>,
): Promise<T> {
  const body = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' '${
      JSON.stringify({
        type: "result",
        result: "done",
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_creation_input_tokens: usage.cacheWrite,
          cache_read_input_tokens: usage.cacheRead,
        },
      })
    }'`,
    "exit 0",
    "",
  ].join("\n");
  return withAgentStub(body, fn, { prefix: "claude_cache_stub_" });
}

/** Logger that records info and warn lines separately. */
function recordingLogger(info: string[], warn: string[]) {
  return {
    info: (msg: string) => info.push(msg),
    warn: (msg: string) => warn.push(msg),
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

Deno.test({
  name: "runner - logs the Anthropic prompt-cache hit rate for the invocation",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const info: string[] = [];
    const warn: string[] = [];
    const result = await withUsageStub(
      { input: 5_000, output: 1_000, cacheWrite: 15_000, cacheRead: 180_000 },
      (stub) =>
        runClaudeWithTimeout({
          clock: fakeClock(),
          prompt: "test",
          agentBinaryPath: stub.path,
          model: "claude-opus-4-8",
          repo: "owner/repo",
          phase: "issue",
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          logger: recordingLogger(info, warn),
        }),
    );

    assert(result.ok, "the stub run must succeed");
    const line = info.find((msg) => msg.startsWith("Anthropic prompt cache:"));
    assert(line, `expected a cache line, got: ${info.join(" | ")}`);
    assert(line.includes("90.0%"), `expected 90.0% in: ${line}`);
    assert(line.includes("owner/repo"), `expected the repo in: ${line}`);
    // A healthy rate raises no warning.
    assertEquals(warn.filter((m) => m.includes("Prompt-cache hit rate")), []);
  },
});

Deno.test({
  name: "runner - warns when the invocation's hit rate has regressed",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const info: string[] = [];
    const warn: string[] = [];
    const result = await withUsageStub(
      { input: 180_000, output: 1_000, cacheWrite: 0, cacheRead: 20_000 },
      (stub) =>
        runClaudeWithTimeout({
          clock: fakeClock(),
          prompt: "test",
          agentBinaryPath: stub.path,
          model: "claude-opus-4-8",
          repo: "owner/repo",
          phase: "issue",
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          logger: recordingLogger(info, warn),
        }),
    );

    assert(result.ok, "the stub run must succeed");
    const warning = warn.find((msg) => msg.includes("Prompt-cache hit rate"));
    assert(warning, `expected a regression warning, got: ${warn.join(" | ")}`);
    assert(warning.includes("volatile token"), warning);
  },
});

Deno.test({
  name: "runner - stays quiet when the run reports no usage",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const info: string[] = [];
    const warn: string[] = [];
    const result = await withUsageStub(
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      (stub) =>
        runClaudeWithTimeout({
          clock: fakeClock(),
          prompt: "test",
          agentBinaryPath: stub.path,
          model: "claude-opus-4-8",
          repo: "owner/repo",
          phase: "issue",
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          logger: recordingLogger(info, warn),
        }),
    );

    assert(result.ok, "the stub run must succeed");
    if (!result.ok) return;
    // The absence of a cache line is only evidence if the stub actually ran
    // (Issue #959): without this a run that never spawned would pass too.
    assertEquals(result.value.exitCode, 0);
    assertStringIncludes(result.value.output, "done");
    assertEquals(
      info.filter((msg) => msg.startsWith("Anthropic prompt cache:")),
      [],
    );
  },
});
