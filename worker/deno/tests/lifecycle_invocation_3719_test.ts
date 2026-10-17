import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { breakdownInvocationTelemetry } from "../lib/run_callback_telemetry.ts";
import {
  buildLifecycleEvent,
  LifecycleEventSchemaError,
  readLifecycleLedger,
} from "../lib/lifecycle_ledger.ts";
import {
  activateLifecycleAssignment,
  currentLifecycleRunId,
  lifecycleRecordingContext,
  withLifecycleInvocation,
  withLifecycleRecording,
} from "../lib/lifecycle_recording.ts";

const assignmentId = "3f2c9a1e-4b5d-4c6e-8f70-1a2b3c4d5e6f";
const usage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationTokens: 30,
  cacheReadTokens: 40,
};
const stats = {
  requestedModel: "sonnet",
  servedModels: ["claude-sonnet-4-6"],
  tokenUsage: usage,
  wallClockMs: 2000,
  effort: "high",
};

Deno.test("Issue #3719: nested telemetry rejects private fields and false zero estimates", () => {
  const telemetry = breakdownInvocationTelemetry(
    { runStats: stats },
    "manager",
    "claude",
  );
  const base = {
    kind: "invocation" as const,
    assignmentId,
    runId: "run-1",
    host: "host-a",
    repo: "org/repo",
    issueNumber: 7,
    recordedAt: "2026-10-17T00:00:00Z",
    role: "manager" as const,
    provider: "claude",
    attempt: 1,
    result: "success" as const,
    ...telemetry,
  };
  buildLifecycleEvent(base);
  assertThrows(
    () =>
      buildLifecycleEvent({
        ...base,
        pricing: "unknown",
        estimatedApiEquivalentUsd: 0,
      }),
    LifecycleEventSchemaError,
  );
  assertThrows(
    () =>
      buildLifecycleEvent({
        ...base,
        usage: "unknown",
        estimatedApiEquivalentUsd: 0,
      }),
    LifecycleEventSchemaError,
  );
  assert(telemetry.models?.[0]);
  const model = telemetry.models[0];
  for (
    const probe of [
      { ...model, prompt: "private" },
      { ...model, tokens: { ...model.tokens, password: "private" } },
      { ...model, model: "someone@example.com" },
      { ...model, pricing: "unknown" as const, estimatedApiEquivalentUsd: 0 },
    ]
  ) {
    assertThrows(
      () => buildLifecycleEvent({ ...base, models: [probe] }),
      LifecycleEventSchemaError,
    );
  }
});

Deno.test("Issue #3719: concurrent claims isolate identities and fresh claims retain new spend", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ledgerPath = `${dir}/ledger.jsonl`;
    const contexts = [1, 2].map(() => ({
      ...lifecycleRecordingContext(dir, "org/repo", 7),
      ledgerPath,
    }));
    assert(contexts[0] && contexts[1]);
    assert(contexts[0].runId !== contexts[1].runId);
    let arrived = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => release = resolve);
    await Promise.all(
      contexts.map((context, i) =>
        withLifecycleRecording(context, async () => {
          activateLifecycleAssignment(i === 0 ? assignmentId : "unknown");
          if (++arrived === 2) release();
          await bothStarted;
          assertEquals(currentLifecycleRunId(), context.runId);
          await withLifecycleInvocation({ phase: "issue" }, async () => ({
            ok: true as const,
            value: { exitCode: 0, timedOut: false, runStats: stats },
          }));
        })
      ),
    );
    assertEquals(currentLifecycleRunId(), undefined);
    const events = await readLifecycleLedger(ledgerPath);
    assertEquals(events.length, 2);
    for (const [i, context] of contexts.entries()) {
      const event = events.find((e) => e.runId === context.runId);
      assert(event?.kind === "invocation");
      assertEquals(event.assignmentId, i === 0 ? assignmentId : "unknown");
      assertEquals(event.invocationIndex, 1);
      assertEquals(event.pricing, "known");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Issue #3719: split models retain separate prices and unattributed sub-agent roles", () => {
  const result = breakdownInvocationTelemetry(
    {
      runStats: {
        ...stats,
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 100,
            outputTokens: 20,
            cacheCreationInputTokens: 30,
            cacheReadInputTokens: 40,
          },
          "unpriced-model": { inputTokens: 50, outputTokens: 10 },
        },
      },
    },
    "manager",
    "claude",
  );
  assertEquals(result.usage, "known");
  assertEquals(result.pricing, "unknown");
  assertEquals(result.estimatedApiEquivalentUsd, undefined);
  assertEquals(result.models?.map((m) => [m.model, m.role, m.pricing]), [
    ["claude-sonnet-4-6", "manager", "known"],
    ["unpriced-model", "sub-agent (unattributed)", "unknown"],
  ]);
  assert((result.models?.[0]?.estimatedApiEquivalentUsd ?? 0) > 0);
  assertEquals(result.models?.[1]?.estimatedApiEquivalentUsd, undefined);
  assertEquals(result.models?.[0]?.tokens, usage);
});

Deno.test("Issue #3719: absent usage and unobserved served models stay unknown", () => {
  const result = breakdownInvocationTelemetry(
    { runStats: { ...stats, servedModels: [], tokenUsage: undefined } },
    "executor",
    "claude",
  );
  assertEquals(result, {
    usage: "unknown",
    telemetryAbsentReason: "usage_not_reported",
    pricing: "unknown",
  });
  assertEquals(
    breakdownInvocationTelemetry({}, "manager", "other").telemetryAbsentReason,
    "provider_unsupported",
  );
  const known = breakdownInvocationTelemetry(
    { runStats: stats },
    "reviewer",
    "claude",
  );
  assertEquals(known.pricing, "known");
  assert((known.estimatedApiEquivalentUsd ?? 0) > 0);
});

Deno.test("Issue #3719: failure, timeout and restart replay record once per invocation", async () => {
  const dir = await Deno.makeTempDir();
  const ledgerPath = `${dir}/ledger.jsonl`;
  const context = {
    ledgerPath,
    runId: "run-1",
    host: "worker-1",
    repo: "org/repo",
    issueNumber: 7,
    now: () => Date.parse("2026-10-17T00:00:00Z"),
  };
  try {
    for (let replay = 0; replay < 2; replay++) {
      await withLifecycleRecording(context, async () => {
        await withLifecycleInvocation(
          { phase: "issue" },
          async () => ({
            ok: true as const,
            value: { exitCode: 0, timedOut: false },
          }),
        );
        activateLifecycleAssignment(assignmentId);
        for (
          const [exitCode, timedOut] of [[1, false], [124, true], [
            0,
            false,
          ]] as const
        ) {
          await withLifecycleInvocation(
            { phase: "issue" },
            async () => ({
              ok: true as const,
              value: {
                exitCode,
                timedOut,
                provider: "claude",
                runStats: stats,
              },
            }),
          );
        }
      });
    }
    const events = await readLifecycleLedger(ledgerPath);
    assertEquals(events.length, 3);
    assertEquals(
      events.map((e) => e.kind === "invocation" ? e.result : "wrong-kind"),
      ["failure", "timeout", "success"],
    );
    for (const event of events) {
      assertEquals(event.assignmentId, assignmentId);
      assert(event?.kind === "invocation");
      assertEquals(event.durationSeconds, 2);
      assertEquals(event.requestedModel, "sonnet");
      assertEquals(event.servedModel, "claude-sonnet-4-6");
      assertEquals(event.effort, "high");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Issue #3719: a thrown invocation is recorded and rethrows its cause", async () => {
  const dir = await Deno.makeTempDir();
  const ledgerPath = `${dir}/ledger.jsonl`;
  try {
    await withLifecycleRecording({
      ledgerPath,
      runId: "throw-run",
      host: "worker-1",
      repo: "org/repo",
      issueNumber: 7,
    }, async () => {
      activateLifecycleAssignment(assignmentId);
      await assertRejects(
        () =>
          withLifecycleInvocation(
            { phase: "issue" },
            () => Promise.reject(new Error("spawn failed")),
          ),
        Error,
        "spawn failed",
      );
    });
    const [event] = await readLifecycleLedger(ledgerPath);
    assert(event?.kind === "invocation");
    assertEquals(event.result, "failure");
    assertEquals(event.usage, "unknown");
    assertEquals(event.estimatedApiEquivalentUsd, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name:
    "Issue #3719: the real retry runner records every failed attempt and retains follow-on usage",
  ignore: Deno.build.os === "windows",
  async fn() {
    const { withAgentStub } = await import("./support/agent_stub.ts");
    const { fakeClock } = await import("./support/fake_clock.ts");
    const { runClaudeWithRetry } = await import("../lib/claude_runner.ts");
    await withAgentStub(
      `printf '%s\\n' '{"type":"result","result":"API rate limit exceeded - too many requests","usage":{"input_tokens":100,"output_tokens":20}}'\nexit 1`,
      async (stub) => {
        const ledgerPath = `${stub.dir}/ledger.jsonl`;
        await withLifecycleRecording({
          ledgerPath,
          runId: "real-retry",
          host: "worker-1",
          repo: "org/repo",
          issueNumber: 7,
        }, async () => {
          activateLifecycleAssignment(assignmentId);
          const result = await runClaudeWithRetry({
            clock: fakeClock(),
            prompt: "test",
            model: "sonnet",
            agentBinaryPath: stub.path,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            captureInvocationStats: true,
          }, {
            maxRetries: 0,
            maxWaitSeconds: 1,
            initialWaitInterval: 0,
            maxTotalInvocations: 2,
          });
          assert(result.ok);
          assertEquals(result.value.invocationStats?.length, 2);
        });
        const events = await readLifecycleLedger(ledgerPath);
        assertEquals(events.length, 2);
        assertEquals(
          events.map((e) => e.kind === "invocation" ? e.result : "wrong-kind"),
          ["failure", "failure"],
        );
      },
    );
  },
});
