/**
 * End-to-end tests for the provider fallback on a refused model inside
 * `runClaudeWithRetry()` (Issue #4034).
 *
 * GRQ-23, 2026-10-20: the ChatGPT login behind Codex refused the grill-me
 * model with HTTP 400 ("The 'gpt-5' model is not supported when using Codex
 * with a ChatGPT account", Issue #4019). Codex publishes no cheaper-model
 * ladder, so the run logged `no-ladder-for-provider` and gave up — every
 * cycle — although `agent_provider_fallback` named a healthy alternative.
 * Only the health gate consulted that list (Issue #4014).
 *
 * The stub agent — named by path (Issue #959), so it stands in for whichever
 * provider the runner selects — records the first argument of each
 * invocation (`exec` for Codex) and refuses every Codex invocation with the
 * live JSONL refusal. Any other provider succeeds. So the recorded sequence
 * proves the switch, and that the run then succeeds on the fallback.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import {
  resolveProviderFallbackPolicy,
  setConfiguredProviderFallbackPolicy,
} from "../lib/provider_fallback_policy.ts";
import type { Logger } from "../types.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv } from "./support/env_lookup.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** Basename of the file the stub records each invocation's first arg in. */
const CALL_LOG = "calls.log";

/** The live refusal, as Codex writes it into its JSONL stream. */
const REFUSAL =
  "The 'gpt-5' model is not supported when using Codex with a ChatGPT account.";

function buildRefusingCodexStubBody(): string {
  const failed = JSON.stringify({
    type: "turn.failed",
    error: { type: "invalid_request_error", message: REFUSAL },
  });
  return [
    `printf '%s\\n' "$1" >> "$(dirname "$0")/${CALL_LOG}"`,
    `if [ "$1" = "exec" ]; then`,
    `  printf '%s\\n' '${failed}'`,
    `  exit 1`,
    `fi`,
    `printf '%s\\n' '{"type":"result","result":"Done."}'`,
    `exit 0`,
  ].join("\n");
}

async function readCalls(log: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(log)).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function recordingLogger(lines: string[]): Logger {
  const push = (message: string) => lines.push(message);
  return {
    info: push,
    warn: push,
    error: push,
    debug: () => {},
  } as unknown as Logger;
}

const FAST_RETRY = {
  maxRetries: 0,
  maxWaitSeconds: 1,
  initialWaitInterval: 0,
} as const;

async function runRefusedGrillMe(
  fallback: string[] | undefined,
): Promise<{ exitCode: number; calls: string[]; log: string[] }> {
  setConfiguredProviderFallbackPolicy(
    resolveProviderFallbackPolicy({
      preferred: "codex",
      enabled: ["codex", "claude"],
      fallback,
    }),
  );
  const log: string[] = [];
  try {
    return await withAgentStub(
      buildRefusingCodexStubBody(),
      async (stub) => {
        const result = await runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "test",
            phase: "grill_me",
            agentProvider: "codex",
            agentBinaryPath: stub.path,
            env: emptyEnv,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            logger: recordingLogger(log),
          },
          FAST_RETRY,
        );
        assert(result.ok, `run errored: ${!result.ok && result.error}`);
        return {
          exitCode: result.value.exitCode,
          calls: await readCalls(`${stub.dir}/${CALL_LOG}`),
          log,
        };
      },
      { prefix: "codex_refusal_4034_" },
    );
  } finally {
    setConfiguredProviderFallbackPolicy(undefined);
  }
}

Deno.test({
  name:
    "runClaudeWithRetry - a refused model on a ladderless provider moves to agent_provider_fallback (Issue #4034)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { exitCode, calls, log } = await runRefusedGrillMe(["claude"]);

    assertEquals(exitCode, 0, `the fallback run must succeed: ${log}`);
    assertEquals(calls[0], "exec", "the first attempt is Codex");
    assertEquals(calls.length, 2, `exactly one switch: ${calls}`);
    assert(calls[1] !== "exec", "the retry ran on the fallback, not Codex");
    assert(
      !log.some((line) => line.includes("no cheaper fallback available")),
      "the run must not give up while a fallback is configured",
    );
    assert(
      log.some((line) =>
        line.includes("codex") && line.includes("claude") &&
        line.includes("#4034")
      ),
      `the switch is logged naming both providers: ${log}`,
    );
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a refused model with no fallback configured still gives up (Issue #4034)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const { exitCode, calls, log } = await runRefusedGrillMe(undefined);

    assert(exitCode !== 0, "a pinned provider must not be substituted");
    assertEquals(calls, ["exec"], "no other provider was invoked");
    assertStringIncludes(log.join("\n"), "no cheaper fallback available");
  },
});
