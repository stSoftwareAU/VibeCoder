import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  runClaudeWithRetry,
  runClaudeWithTimeout,
} from "../lib/claude_runner.ts";
import type { ClaudeRunResult } from "../lib/claude_runner.ts";
import { AgentTurnLimitError } from "../lib/claude_turn_limit.ts";
import {
  UNFINISHED_ISSUE_EXECUTOR_MESSAGE,
  UnfinishedIssueExecutorError,
} from "../lib/issue_executor_enforcement.ts";
import { billedResultOfError } from "../lib/failed_invocation_result.ts";
import { readLifecycleLedger } from "../lib/lifecycle_ledger.ts";
import {
  activateLifecycleAssignment,
  withLifecycleInvocation,
  withLifecycleRecording,
} from "../lib/lifecycle_recording.ts";
import { createAgentStub, withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

const assignmentId = "3f2c9a1e-4b5d-4c6e-8f70-1a2b3c4d5e6f";
const usageLine = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 30,
  cache_read_input_tokens: 40,
};

/** Run `body` inside an activated recording context and return the ledger. */
async function recorded(body: () => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const ledgerPath = `${dir}/ledger.jsonl`;
  try {
    await withLifecycleRecording({
      ledgerPath,
      runId: "run-1",
      host: "host-a",
      repo: "org/repo",
    }, async () => {
      activateLifecycleAssignment(assignmentId);
      await body();
    });
    return await readLifecycleLedger(ledgerPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test({
  name:
    "Issue #5029: an unfinished split refusal through the real runner records provider and usage",
  ignore: Deno.build.os === "windows",
  async fn() {
    const lines = [
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          model: "claude-sonnet-4-6",
          content: [{
            type: "tool_use",
            id: "executor-call",
            name: "Agent",
            input: { subagent_type: "executor", run_in_background: false },
          }],
        },
      },
      { type: "result", subtype: "success", result: "done", usage: usageLine },
    ];
    const stream = lines.map((line) => JSON.stringify(line)).join("\n");
    const stub = await createAgentStub(
      `cat <<'STREAM'\n${stream}\nSTREAM\nexit 0\n`,
    );
    try {
      let outcome: Awaited<ReturnType<typeof runClaudeWithTimeout>> | undefined;
      const events = await recorded(async () => {
        outcome = await runClaudeWithTimeout({
          clock: fakeClock(),
          prompt: "P",
          model: "sonnet",
          agentProvider: "claude",
          agentBinaryPath: stub.path,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          issueExecutorSplit: true,
        });
      });
      assert(outcome && !outcome.ok);
      assert(outcome.error instanceof UnfinishedIssueExecutorError);
      assertEquals(events.length, 1);
      const event = events[0];
      assert(event?.kind === "invocation");
      assertEquals(event.provider, "claude");
      assertEquals(event.usage, "known");
      assertEquals(event.servedModel, "claude-sonnet-4-6");
      assertEquals(event.models?.[0]?.tokens, {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 30,
        cacheReadTokens: 40,
      });
      assertEquals(event.result, "failure");
    } finally {
      await stub.dispose();
    }
  },
});

Deno.test({
  name: "Issue #5029: a turn cap keeps exactly one ledger entry",
  ignore: Deno.build.os === "windows",
  async fn() {
    const event = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "Reached max turns (7)",
      usage: usageLine,
    });
    await withAgentStub(
      `printf '%s\\n' '${event}'\nexit 1`,
      async (stub) => {
        let outcome: Awaited<ReturnType<typeof runClaudeWithRetry>> | undefined;
        const events = await recorded(async () => {
          outcome = await runClaudeWithRetry({
            prompt: "test",
            agentBinaryPath: stub.path,
            agentProvider: "claude",
            timeoutSeconds: 30,
            clock: fakeClock(),
            env: (key) => key === "VIBE_CLAUDE_MAX_TURNS" ? "7" : undefined,
          }, { maxRetries: 2, maxWaitSeconds: 0, initialWaitInterval: 0 });
        });
        assert(outcome && !outcome.ok);
        assert(outcome.error instanceof AgentTurnLimitError);
        assertEquals(events.length, 1);
        const entry = events[0];
        assert(entry?.kind === "invocation");
        assertEquals(entry.provider, "claude");
      },
    );
  },
});

const bareResult = {
  exitCode: 0,
  timedOut: false,
  output: "",
  provider: "claude",
  runStats: { servedModels: [], requestedModel: "sonnet", wallClockMs: 1000 },
} as never;

Deno.test("Issue #5029: a refusal with no usage records its provider and unknown usage", async () => {
  const events = await recorded(async () => {
    await withLifecycleInvocation(
      { phase: "issue" },
      () =>
        Promise.resolve({
          ok: false as const,
          error: new UnfinishedIssueExecutorError(
            UNFINISHED_ISSUE_EXECUTOR_MESSAGE,
            bareResult,
          ),
        }),
    );
  });
  assertEquals(events.length, 1);
  const event = events[0];
  assert(event?.kind === "invocation");
  assertEquals(event.provider, "claude");
  assertEquals(event.usage, "unknown");
  assertEquals(event.estimatedApiEquivalentUsd, undefined);
  assertEquals(event.models, undefined);
  assertEquals(event.result, "failure");
});

Deno.test("Issue #5029: a plain error records nothing invented", async () => {
  const events = await recorded(async () => {
    await withLifecycleInvocation(
      { phase: "issue" },
      () =>
        Promise.resolve({
          ok: false as const,
          error: new Error(UNFINISHED_ISSUE_EXECUTOR_MESSAGE),
        }),
    );
  });
  assertEquals(events.length, 1);
  const event = events[0];
  assert(event?.kind === "invocation");
  assertEquals(event.provider, "unknown");
  assertEquals(event.usage, "unknown");
  assertEquals(event.result, "failure");
});

Deno.test("Issue #5029: billedResultOfError returns only a carried result", () => {
  const capResult = { marker: "cap" } as unknown as ClaudeRunResult;
  const splitResult = { marker: "split" } as unknown as ClaudeRunResult;
  assertStrictEquals(
    billedResultOfError(new AgentTurnLimitError("cap", capResult)),
    capResult,
  );
  assertStrictEquals(
    billedResultOfError(new UnfinishedIssueExecutorError("x", splitResult)),
    splitResult,
  );
  assertEquals(billedResultOfError(new Error("plain")), undefined);
  assertEquals(billedResultOfError(new AgentTurnLimitError("cap")), undefined);
  assertEquals(
    billedResultOfError(new UnfinishedIssueExecutorError("x")),
    undefined,
  );
  assertEquals(billedResultOfError("string"), undefined);
});
