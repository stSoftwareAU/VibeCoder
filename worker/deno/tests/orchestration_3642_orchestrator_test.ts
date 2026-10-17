/**
 * Behavioural tests for the external orchestrator (Issue #3642): handoffs,
 * interruption and recovery, lease staleness, refusals (auth, quota, metered
 * billing, missing tool enforcement, depth and budget bounds) and retries.
 * A scripted invoker stands in for the provider, so no provider CLI runs.
 *
 * Australian English spelling throughout (behaviour, recognised, honour).
 */

import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { loadCheckpoint } from "../lib/orchestration/checkpoint.ts";
import {
  type ExternalOrchestrationOptions,
  type OrchestrationOutcome,
  runExternalOrchestration,
} from "../lib/orchestration/orchestrator.ts";
import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";
import type {
  AgentCall,
  AgentCallResult,
  InvokeAgent,
  TargetProvider,
} from "../lib/orchestration/types.ts";

/** A claude environment that proves a fixed-price subscription. */
const SUBSCRIPTION_ENV = { CLAUDE_CODE_OAUTH_TOKEN: "test-token" };

type Script = (call: AgentCall) => AgentCallResult;

function phaseOf(call: AgentCall): "plan" | "execute" | "review" {
  if (call.prompt.startsWith("Manager review")) return "review";
  return call.envelope.role === "executor" ? "execute" : "plan";
}

function okScript(call: AgentCall): AgentCallResult {
  return { ok: true, output: `${phaseOf(call)} output` };
}

/** A fake invoker that records every call and answers from `script`. */
function fakeInvoker(script: Script = okScript): {
  calls: AgentCall[];
  invoke: InvokeAgent;
} {
  const calls: AgentCall[] = [];
  const invoke: InvokeAgent = (call) => {
    calls.push(call);
    return Promise.resolve(script(call));
  };
  return { calls, invoke };
}

async function withWorkDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function optionsFor(
  dir: string,
  invoke: InvokeAgent,
  overrides: Partial<ExternalOrchestrationOptions> = {},
): ExternalOrchestrationOptions {
  return {
    issueId: "3642",
    branch: "issue-3642-test",
    workspaceDir: dir,
    brief: "Add provider-neutral orchestration",
    acceptanceCriteria: ["tests pass"],
    manager: { provider: "claude" },
    executor: { provider: "claude" },
    checkpointDir: `${dir}/checkpoints`,
    invoke,
    env: SUBSCRIPTION_ENV,
    now: () => 1_000,
    leaseId: "lease-1",
    leaseTtlMs: 1_000,
    ...overrides,
  };
}

Deno.test("handoff: manager plans, executor carries out, manager reviews", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke),
    );

    assertEquals(outcome.state, "done");
    assertEquals(outcome.resumed, false);
    assertEquals(fake.calls.map(phaseOf), ["plan", "execute", "review"]);
    assertEquals(outcome.managerOutput, "review output");
    assertEquals(outcome.invocations, 3);
    assertEquals(outcome.results.length, 3);
    // The manager is denied editing tools; the executor is denied delegation.
    assertEquals(fake.calls[0]?.envelope.deniedTools.includes("Edit"), true);
    assertEquals(fake.calls[1]?.envelope.deniedTools, ["Task"]);
  });
});

Deno.test("a released run starts afresh on the same lease and calls the provider again", async () => {
  await withWorkDir(async (dir) => {
    const costed: Script = (call) => ({
      ok: true,
      output: `${phaseOf(call)} output`,
      costUsd: 1,
    });
    const first = fakeInvoker(costed);
    const firstOutcome = await runExternalOrchestration(
      optionsFor(dir, first.invoke),
    );
    assertEquals(firstOutcome.state, "done");
    assertEquals(firstOutcome.invocations, 3);
    assertEquals(firstOutcome.costUsd, 3);

    const second = fakeInvoker(costed);
    const outcome = await runExternalOrchestration(
      optionsFor(dir, second.invoke),
    );
    assertEquals(outcome.state, "done");
    assertEquals(outcome.resumed, false);
    assertEquals(second.calls.map(phaseOf), ["plan", "execute", "review"]);
    assertEquals(outcome.managerOutput, "review output");
    assertEquals(outcome.results.length, 3);
    // Counts and cost restart from zero rather than carrying the prior run over.
    assertEquals(outcome.invocations, 3);
    assertEquals(outcome.costUsd, 3);

    const loaded = await loadCheckpoint(`${dir}/checkpoints`, "3642");
    assertEquals(loaded.checkpoint?.state, "released");
    assertEquals(loaded.checkpoint?.invocations, 3);
  });
});

Deno.test("an interrupted run resumes under the same lease without repeating the plan", async () => {
  await withWorkDir(async (dir) => {
    const interrupted = fakeInvoker((call) =>
      phaseOf(call) === "execute"
        ? { ok: false, kind: "timeout", message: "interrupted" }
        : okScript(call)
    );
    const first = await runExternalOrchestration(
      optionsFor(dir, interrupted.invoke, { bounds: { maxRetries: 0 } }),
    );
    assertEquals(first.state, "timed_out");
    assertEquals(first.invocations, 2);

    const resumed = fakeInvoker();
    const second = await runExternalOrchestration(
      optionsFor(dir, resumed.invoke, { bounds: { maxRetries: 0 } }),
    );
    assertEquals(second.state, "done");
    assertEquals(second.resumed, true);
    assertEquals(resumed.calls.map(phaseOf), ["execute", "review"]);
    assertEquals(second.invocations, 4);
  });
});

Deno.test("a stale lease refuses resume and leaves the heartbeat unrenewed", async () => {
  await withWorkDir(async (dir) => {
    let clock = 1_000;
    const timedOut = fakeInvoker((call) =>
      phaseOf(call) === "execute"
        ? { ok: false, kind: "timeout", message: "stalled" }
        : okScript(call)
    );
    await runExternalOrchestration(
      optionsFor(dir, timedOut.invoke, {
        now: () => clock,
        bounds: { maxRetries: 0 },
      }),
    );

    clock = 2_500;
    const late = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, late.invoke, { now: () => clock }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "stale_lease");
    assertEquals(late.calls.length, 0);

    const loaded = await loadCheckpoint(`${dir}/checkpoints`, "3642");
    assertEquals(loaded.checkpoint?.leaseHeartbeatMs, 1_000);
  });
});

Deno.test("cancellation before the first call makes no provider call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { isCancelled: () => true }),
    );
    assertEquals(outcome.state, "cancelled");
    assertEquals(fake.calls.length, 0);
  });
});

Deno.test("an auth failure refuses the run after one call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker(() => ({
      ok: false,
      kind: "auth",
      message: "bad token",
    }));
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxRetries: 1 } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "auth_failure");
    assertEquals(fake.calls.length, 1);
  });
});

Deno.test("quota exhaustion refuses the run without retrying or switching provider", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker((call) =>
      phaseOf(call) === "execute"
        ? { ok: false, kind: "quota", message: "limit reached" }
        : okScript(call)
    );
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxRetries: 1 } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "quota_exhausted");
    assertEquals(fake.calls.map(phaseOf), ["plan", "execute"]);
    assertEquals(
      fake.calls.every((call) => call.envelope.provider === "claude"),
      true,
    );
  });
});

Deno.test("metered billing refuses an orchestrated run before any call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { env: { ANTHROPIC_API_KEY: "key" } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "metered_billing");
    assertEquals(fake.calls.length, 0);
  });
});

Deno.test("positive control: a fixed subscription runs even when a metered key is also set", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, {
        env: { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "key" },
      }),
    );
    assertEquals(outcome.state, "done");
    assertEquals(fake.calls.length, 3);
  });
});

Deno.test("an executor on a provider that cannot enforce denied tools is refused", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, {
        executor: { provider: "codex" },
        env: {},
      }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "missing_tool_support");
    assertEquals(fake.calls.length, 0);
  });
});

Deno.test("an unknown executor provider is refused as unsupported", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, {
        executor: { provider: "openai" as unknown as TargetProvider },
      }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "unsupported_provider");
    assertEquals(fake.calls.length, 0);
  });
});

Deno.test("a delegation depth of zero refuses before any call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxDelegationDepth: 0 } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "depth_exceeded");
    assertEquals(fake.calls.length, 0);
  });
});

Deno.test("an invocation budget stops the run before the next call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxInvocations: 1 } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "budget_exceeded");
    assertEquals(fake.calls.length, 1);
    assertEquals(outcome.invocations, 1);
  });
});

Deno.test("a cost cap stops the run once spend reaches it", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker((call) =>
      phaseOf(call) === "plan"
        ? { ok: true, output: "plan output", costUsd: 2 }
        : okScript(call)
    );
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxCostUsd: 1 } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "budget_exceeded");
    assertEquals(fake.calls.length, 1);
    assertEquals(outcome.costUsd, 2);
  });
});

Deno.test("invalid bounds are refused as invalid_selection before any call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxInvocations: 0 } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "invalid_selection");
    assertEquals(fake.calls.length, 0);
  });
});

Deno.test("a failed call is retried and the run then succeeds", async () => {
  await withWorkDir(async (dir) => {
    let executorCalls = 0;
    const fake = fakeInvoker((call) => {
      if (phaseOf(call) !== "execute") return okScript(call);
      executorCalls += 1;
      return executorCalls === 1
        ? { ok: false, kind: "error", message: "transient" }
        : okScript(call);
    });
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxRetries: 1 } }),
    );
    assertEquals(outcome.state, "done");
    assertEquals(executorCalls, 2);
    assertEquals(outcome.invocations, 4);
  });
});

Deno.test("retries exhausted refuses the run", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker((call) =>
      phaseOf(call) === "execute"
        ? { ok: false, kind: "error", message: "broken" }
        : okScript(call)
    );
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxRetries: 1 } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "retries_exhausted");
    assertEquals(
      fake.calls.filter((call) => phaseOf(call) === "execute").length,
      2,
    );
  });
});

Deno.test("a timeout that exhausts its attempts ends the run timed_out", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker((call) =>
      phaseOf(call) === "plan"
        ? { ok: false, kind: "timeout", message: "slow" }
        : okScript(call)
    );
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxRetries: 0 } }),
    );
    assertEquals(outcome.state, "timed_out");
    assertEquals(fake.calls.length, 1);
  });
});

Deno.test("an abandoned call is not retried and ends the run timed_out", async () => {
  await withWorkDir(async (dir) => {
    let executorCalls = 0;
    const invoke: InvokeAgent = (call) => {
      if (phaseOf(call) !== "execute") return Promise.resolve(okScript(call));
      executorCalls += 1;
      return new Promise(() => {});
    };
    const outcome = await runExternalOrchestration(
      optionsFor(dir, invoke, { bounds: { maxRetries: 2 }, callTimeoutMs: 20 }),
    );
    assertEquals(outcome.state, "timed_out");
    assertEquals(executorCalls, 1);
    assertStringIncludes(outcome.reason ?? "", "not retried");
  });
});

Deno.test("a non-positive callTimeoutMs is refused as invalid_selection", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { callTimeoutMs: 0 }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "invalid_selection");
    assertStringIncludes(outcome.refusal?.message ?? "", "callTimeoutMs");
    assertEquals(fake.calls.length, 0);
  });
});

Deno.test("positive control: a valid callTimeoutMs is not refused", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { callTimeoutMs: 60_000 }),
    );
    assertNotEquals(outcome.state, "refused");
    assertEquals(outcome.state, "done");
  });
});

Deno.test("an old-version checkpoint is ignored with a warning, not replayed", async () => {
  await withWorkDir(async (dir) => {
    const checkpointDir = `${dir}/checkpoints`;
    await Deno.mkdir(checkpointDir, { recursive: true });
    await Deno.writeTextFile(
      `${checkpointDir}/3642.json`,
      JSON.stringify({
        schema: "orchestration-checkpoint-v0",
        issueId: "3642",
        leaseId: "lease-1",
        leaseHeartbeatMs: 1_000,
        state: "reviewing",
        invocations: 0,
        costUsd: 0,
        steps: {},
        results: [],
      }),
    );
    const logged: string[] = [];
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { log: (msg) => logged.push(msg) }),
    );
    assertEquals(outcome.state, "done");
    assertEquals(outcome.resumed, false);
    assertEquals(fake.calls.map(phaseOf), ["plan", "execute", "review"]);
    assertStringIncludes(logged.join("\n"), "schema");
  });
});

/** A GitHub classic token shape (ghp_ plus 36 base62) that redactSecrets masks. */
const LEAKED_TOKEN = `ghp_${"x7Q".repeat(12)}`;

/**
 * Asserts the secret is gone from the outcome and the persisted checkpoint file,
 * and that the non-secret wording of the provider message survives.
 */
async function assertRedacted(
  outcome: OrchestrationOutcome,
  dir: string,
  survivor: string,
): Promise<void> {
  const checkpointText = await Deno.readTextFile(
    `${dir}/checkpoints/3642.json`,
  );
  const reason = outcome.reason ?? "";
  const refusalMessage = outcome.refusal?.message ?? "";
  assertEquals(reason.includes(LEAKED_TOKEN), false);
  assertEquals(refusalMessage.includes(LEAKED_TOKEN), false);
  assertEquals(checkpointText.includes(LEAKED_TOKEN), false);
  assertStringIncludes(reason, survivor);
  assertStringIncludes(refusalMessage, survivor);
  assertStringIncludes(reason, REDACTION_PLACEHOLDER);
  assertStringIncludes(checkpointText, survivor);
}

Deno.test("an auth failure message is redacted in the reason, refusal and checkpoint", async () => {
  await withWorkDir(async (dir) => {
    const raw = `bad token ${LEAKED_TOKEN} for the account`;
    // The fixture must be one redactSecrets really changes, or the test proves nothing.
    assertNotEquals(redactSecrets(raw), raw);
    const fake = fakeInvoker(() => ({ ok: false, kind: "auth", message: raw }));
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxRetries: 0 } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "auth_failure");
    await assertRedacted(outcome, dir, "bad token");
  });
});

Deno.test("a generic provider error message is redacted in the reason, refusal and checkpoint", async () => {
  await withWorkDir(async (dir) => {
    const raw = `request failed with ${LEAKED_TOKEN} in the response`;
    assertNotEquals(redactSecrets(raw), raw);
    const fake = fakeInvoker((call) =>
      phaseOf(call) === "execute"
        ? { ok: false, kind: "error", message: raw }
        : okScript(call)
    );
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { bounds: { maxRetries: 0 } }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "retries_exhausted");
    await assertRedacted(outcome, dir, "request failed");
  });
});

Deno.test("a completed cross-provider handoff runs the executor on deepseek and the manager on claude", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { executor: { provider: "deepseek" } }),
    );
    assertEquals(outcome.state, "done");
    assertEquals(fake.calls.map(phaseOf), ["plan", "execute", "review"]);
    // Index 0 and 2 are manager calls; index 1 is the executor call.
    assertEquals(
      fake.calls.map((call) => call.envelope.provider),
      ["claude", "deepseek", "claude"],
    );
    assertEquals(fake.calls[1]?.envelope.role, "executor");
  });
});

Deno.test("an empty manager plan ends the run blocked before any executor call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker((call) =>
      phaseOf(call) === "plan" ? { ok: true, output: "   " } : okScript(call)
    );
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke),
    );
    assertEquals(outcome.state, "blocked");
    assertStringIncludes(outcome.reason ?? "", "empty plan");
    assertEquals(fake.calls.map(phaseOf), ["plan"]);
    assertEquals(
      fake.calls.filter((call) => phaseOf(call) === "execute").length,
      0,
    );
  });
});

Deno.test("an empty manager review ends the run blocked", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker((call) =>
      phaseOf(call) === "review" ? { ok: true, output: "" } : okScript(call)
    );
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke),
    );
    assertEquals(outcome.state, "blocked");
    assertStringIncludes(outcome.reason ?? "", "empty review");
    assertEquals(fake.calls.map(phaseOf), ["plan", "execute", "review"]);
  });
});

Deno.test("a blank issueId is refused as invalid_selection before any call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { issueId: "  " }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "invalid_selection");
    assertStringIncludes(
      outcome.refusal?.message ?? "",
      "issueId must not be blank",
    );
    assertEquals(fake.calls.length, 0);

    // Positive control: the same options with a real issue id run to completion.
    const control = fakeInvoker();
    const accepted = await runExternalOrchestration(
      optionsFor(dir, control.invoke),
    );
    assertEquals(accepted.state, "done");
  });
});

Deno.test("a blank leaseId is refused as invalid_selection before any call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { leaseId: "" }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "invalid_selection");
    assertStringIncludes(
      outcome.refusal?.message ?? "",
      "leaseId must not be blank",
    );
    assertEquals(fake.calls.length, 0);

    // Positive control: the same options with a real lease id run to completion.
    const control = fakeInvoker();
    const accepted = await runExternalOrchestration(
      optionsFor(dir, control.invoke),
    );
    assertEquals(accepted.state, "done");
  });
});

Deno.test("a non-positive leaseTtlMs is refused as invalid_selection before any call", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeInvoker();
    const outcome = await runExternalOrchestration(
      optionsFor(dir, fake.invoke, { leaseTtlMs: 0 }),
    );
    assertEquals(outcome.state, "refused");
    assertEquals(outcome.refusal?.kind, "invalid_selection");
    assertStringIncludes(outcome.refusal?.message ?? "", "leaseTtlMs");
    assertEquals(fake.calls.length, 0);

    // Positive control: the same options with a positive lease TTL run to completion.
    const control = fakeInvoker();
    const accepted = await runExternalOrchestration(
      optionsFor(dir, control.invoke, { leaseTtlMs: 60_000 }),
    );
    assertEquals(accepted.state, "done");
  });
});
