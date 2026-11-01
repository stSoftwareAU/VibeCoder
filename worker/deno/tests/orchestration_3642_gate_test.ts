/**
 * Tests for the external orchestration gate (Issue #3642): the role defaults,
 * per-role overrides, the refusals (auth, quota, cross-provider, sequential
 * dispatch) and checkpoint resume. A fake Claude runner stands in for the
 * CLI, so no provider process runs.
 *
 * Australian English spelling throughout (behaviour, recognised, honour).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { AgentFailure } from "../lib/agent_output.ts";
import type {
  ClaudeRunResult,
  RetryOptions,
  RunClaudeOptions,
  RunStats,
} from "../lib/claude_runner.ts";
import { createDefaultDeps } from "../lib/execute_claude_phase.ts";
import type { ExternalIssueRunInput } from "../lib/execute_claude_phase.ts";
import {
  type IssueRunGateDeps,
  runnerCallBudgetMs,
  runOrchestratedIssueRun,
} from "../lib/orchestration/issue_run_gate.ts";
import type { ExternalOrchestrationSettings, Result } from "../types.ts";

/** A claude environment that proves a fixed-price subscription. */
const SUBSCRIPTION_ENV = { CLAUDE_CODE_OAUTH_TOKEN: "test-token" };

/** A fixed clock, so the lease never lapses during a test. */
const now = () => 1_000;

/** The manager review prompt starts with this text (see the orchestrator). */
const REVIEW_PREFIX = "Manager review";

type Responder = (options: RunClaudeOptions) => ClaudeRunResult;

/** A successful runner result carrying `output`. */
function runResult(overrides: Partial<ClaudeRunResult> = {}): ClaudeRunResult {
  return { exitCode: 0, output: "step output", timedOut: false, ...overrides };
}

/** A fake runner that records every option set and answers from `respond`. */
function fakeRunner(respond: Responder = answerByPhase): {
  calls: RunClaudeOptions[];
  retries: (RetryOptions | undefined)[];
  runClaudeWithRetry: IssueRunGateDeps["runClaudeWithRetry"];
} {
  const calls: RunClaudeOptions[] = [];
  const retries: (RetryOptions | undefined)[] = [];
  const runClaudeWithRetry: IssueRunGateDeps["runClaudeWithRetry"] = (
    options,
    retryOptions,
  ) => {
    calls.push(options);
    retries.push(retryOptions);
    const value: Result<ClaudeRunResult> = {
      ok: true,
      value: respond(options),
    };
    return Promise.resolve(value);
  };
  return { calls, retries, runClaudeWithRetry };
}

/** Answers every call successfully, the review with its own output. */
function answerByPhase(options: RunClaudeOptions): ClaudeRunResult {
  return runResult({
    output: options.prompt.startsWith(REVIEW_PREFIX)
      ? "manager review"
      : "step output",
  });
}

/** The plan calls: manager calls that are not the review. */
function isPlanCall(options: RunClaudeOptions): boolean {
  return !options.prompt.startsWith(REVIEW_PREFIX) &&
    options.model === "sonnet";
}

async function withWorkDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/codex`);
    await Deno.writeTextFile(
      `${dir}/codex/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt" }),
    );
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The repository every gate test runs against. */
const REPO = "stSoftwareAU/VibeCoder";

/** Where {@link depsFor} puts the checkpoint for issue 3642 under `dir`. */
function checkpointFile(dir: string): string {
  return `${dir}/state/orchestration/${encodeURIComponent(REPO)}/3642.json`;
}

function inputFor(
  workspaceDir: string,
  settings: ExternalOrchestrationSettings = {},
): ExternalIssueRunInput {
  return {
    claudeOptions: { prompt: "unused", cwd: workspaceDir },
    retryOptions: {},
    workDir: workspaceDir,
    repo: REPO,
    issueNumber: 3642,
    branch: "issue-3642-gate",
    workspaceDir,
    brief: "Add provider-neutral orchestration",
    settings,
  };
}

function depsFor(
  dir: string,
  runClaudeWithRetry: IssueRunGateDeps["runClaudeWithRetry"],
): IssueRunGateDeps {
  return {
    runClaudeWithRetry,
    preflight: async () => {},
    stateDir: `${dir}/state`,
    env: { ...SUBSCRIPTION_ENV, CODEX_HOME: `${dir}/codex` },
    now,
  };
}

Deno.test("orchestration gate - default selection uses the Sonnet manager, Haiku executor and Opus reviewer, never --agents or fallback (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    assertEquals(fake.calls.length > 0, true);
    for (const options of fake.calls) {
      assertEquals(options.enableModelFallback, false);
      assertEquals(options.agents, undefined);
      assertEquals(options.agentProvider, "claude");
    }
    const selections = [
      ...new Set(fake.calls.map((o) => `${o.model}/${o.effort}`)),
    ].sort();
    // Opus does the code reviews (owner decision 2026-10-22): a separate
    // reviewer call even with no reviewer role configured.
    assertEquals(selections, ["haiku/high", "opus/high", "sonnet/high"]);
  });
});

Deno.test("orchestration gate - every role call denies sub-agent dispatch, and the manager every editing tool (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      {
        ...inputFor(dir),
        claudeOptions: {
          prompt: "unused",
          cwd: dir,
          disallowedTools: ["WebFetch"],
        },
      },
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    const manager = fake.calls.filter((o) => o.model === "sonnet");
    const executor = fake.calls.filter((o) => o.model === "haiku");
    // The review is the Opus reviewer's call, not a second manager call
    // (owner decision 2026-10-22); it is read-only like the manager.
    const reviewer = fake.calls.filter((o) => o.model === "opus");
    assertEquals(manager.length, 1);
    assertEquals(executor.length, 1);
    assertEquals(reviewer.length, 1);
    for (const options of [...manager, ...reviewer]) {
      assertEquals(options.disallowedTools, [
        "WebFetch",
        "Edit",
        "MultiEdit",
        "Write",
        "NotebookEdit",
        "Bash",
        "Task",
        "Agent",
      ]);
    }
    assertEquals(executor[0]?.disallowedTools, ["WebFetch", "Task", "Agent"]);
  });
});

Deno.test("orchestration gate - a provider-only override takes that provider's own default for the role (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { executor: { provider: "codex" } }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    const executor = fake.calls.filter((o) => o.agentProvider === "codex");
    assertEquals(executor.length, 1);
    // Never the Claude default ("haiku") on another provider: Codex's own
    // executor model, Luna — Codex's Haiku (owner decision 2026-10-22).
    assertEquals(executor[0]?.model, "gpt-6-luna");
    assertEquals(executor[0]?.effort, "high");
    // The manager and reviewer keep their default provider, so they keep
    // their defaults too.
    const claude = fake.calls.filter((o) => o.agentProvider === "claude");
    assertEquals(
      [...new Set(claude.map((o) => `${o.model}/${o.effort}`))].sort(),
      ["opus/high", "sonnet/high"],
    );

    // Positive control: a model and effort named beside the provider are kept.
    const named = fakeRunner();
    await withWorkDir(async (controlDir) => {
      const control = await runOrchestratedIssueRun(
        inputFor(controlDir, {
          executor: {
            provider: "codex",
            model: "gpt-6.1-sol",
            effort: "low",
          },
        }),
        depsFor(controlDir, named.runClaudeWithRetry),
      );
      assertEquals(control.ok, true);
    });
    const chosen = named.calls.find((o) => o.agentProvider === "codex");
    assertEquals(chosen?.model, "gpt-6.1-sol");
    assertEquals(chosen?.effort, "low");
  });
});

Deno.test("orchestration gate - checkpoints sit beside the work volume, scoped by repository, outside the work volume (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const workDir = `${dir}/work`;
    const workspaceDir = `${workDir}/VibeCoder`;
    await Deno.mkdir(workspaceDir, { recursive: true });
    const fake = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      { ...inputFor(workspaceDir), workDir },
      {
        runClaudeWithRetry: fake.runClaudeWithRetry,
        preflight: async () => {},
        env: { ...SUBSCRIPTION_ENV, CODEX_HOME: `${dir}/codex` },
        now,
      },
    );
    assertEquals(outcome.ok, true);
    const file = `${dir}/work-agent-state/orchestration/${
      encodeURIComponent(REPO)
    }/3642.json`;
    assertEquals((await Deno.stat(file)).isFile, true);
    // Nothing is written into the work volume, which nukeWorkDir may wipe.
    const inWork = [];
    for await (const entry of Deno.readDir(workDir)) inWork.push(entry.name);
    assertEquals(inWork, ["VibeCoder"]);
  });
});

Deno.test("orchestration gate - a work directory that names no directory refuses the run before any call (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      { ...inputFor(dir), workDir: "/" },
      {
        runClaudeWithRetry: fake.runClaudeWithRetry,
        preflight: async () => {},
        env: { ...SUBSCRIPTION_ENV, CODEX_HOME: `${dir}/codex` },
        now,
      },
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(
      outcome.error.message,
      "no agent state directory to checkpoint into",
    );
    assertEquals(fake.calls.length, 0);
  });
});

Deno.test("orchestration gate - a run that completes returns the last manager result (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    if (!outcome.ok) return;
    assertEquals(outcome.value.output, "manager review");
    // Plan, execute and review: three role calls for a clean run.
    assertEquals(fake.calls.length, 3);
  });
});

Deno.test("orchestration gate - per-role overrides replace the defaults (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, {
        manager: { provider: "claude", model: "opus", effort: "max" },
        executor: { provider: "claude", model: "sonnet", effort: "low" },
      }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    const selections = [
      ...new Set(fake.calls.map((o) => `${o.model}/${o.effort}`)),
    ].sort();
    // The unconfigured reviewer keeps its own Opus/high default.
    assertEquals(selections, ["opus/high", "opus/max", "sonnet/low"]);
  });
});

Deno.test("orchestration gate - an auth failure refuses with no fallback call (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const authFailure: AgentFailure = {
      category: "authentication",
      message: "not logged in",
      evidence: "prose",
      terminal: true,
      errors: [],
    };
    const fake = fakeRunner(() =>
      runResult({ exitCode: 1, agentFailure: authFailure })
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    // One refused call and nothing after it: no retry, no fallback.
    assertEquals(fake.calls.length, 1);
    assertEquals(fake.calls[0]?.enableModelFallback, false);
    assertEquals(fake.calls[0]?.agents, undefined);
  });
});

Deno.test("orchestration gate - a quota refusal stops the run (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner(() =>
      runResult({ exitCode: 2, usageLimit: { waitSeconds: 3600 } })
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    assertEquals(fake.calls.length, 1);
  });
});

Deno.test("orchestration gate - a provider that cannot enforce the denied tools is refused before it runs (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { executor: { provider: "gemini" } }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    // The codex executor is never handed to the Claude runner.
    assertEquals(
      fake.calls.filter((o) => o.agentProvider === "codex").length,
      0,
    );
  });
});

Deno.test("orchestration gate - maxConcurrency above 1 is refused (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxConcurrency: 2 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(
      outcome.error.message,
      "sequential dispatch only (maxConcurrency must be 1)",
    );
    assertEquals(fake.calls.length, 0);
  });
});

Deno.test("orchestration gate - a resumed run reuses the completed manager plan (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    // First run: the plan succeeds, then the worker dies during the executor
    // call. The checkpoint copied mid-call is what that worker left behind.
    let snapshot: string | undefined;
    const dying: IssueRunGateDeps["runClaudeWithRetry"] = async (options) => {
      if (options.model === "haiku") {
        snapshot = await Deno.readTextFile(checkpointFile(dir));
        return { ok: false, error: new Error("worker died") };
      }
      return { ok: true, value: answerByPhase(options) };
    };
    const first = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 0 }),
      depsFor(dir, dying),
    );
    assertEquals(first.ok, false);
    await Deno.writeTextFile(checkpointFile(dir), snapshot ?? "");

    // Second run, same issue and state dir: the executor now succeeds.
    const healthy = fakeRunner();
    const second = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 0 }),
      depsFor(dir, healthy.runClaudeWithRetry),
    );
    assertEquals(second.ok, true);
    // The plan was checkpointed under the same lease, so it is not repeated.
    assertEquals(healthy.calls.filter(isPlanCall).length, 0);
    assertEquals(healthy.calls.length, 2);
  });
});

Deno.test("orchestration gate - a quota refusal does not wedge the issue: a run past the lease ttl completes (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    let clock = 1_000;
    const exhausted = fakeRunner(() =>
      runResult({ exitCode: 2, usageLimit: { waitSeconds: 3600 } })
    );
    const first = await runOrchestratedIssueRun(inputFor(dir), {
      ...depsFor(dir, exhausted.runClaudeWithRetry),
      now: () => clock,
    });
    assertEquals(first.ok, false);

    // Past the 15-minute lease ttl, twice over: neither run is refused.
    for (const later of [clock + 16 * 60_000, clock + 32 * 60_000]) {
      clock = later;
      const healthy = fakeRunner();
      const outcome = await runOrchestratedIssueRun(inputFor(dir), {
        ...depsFor(dir, healthy.runClaudeWithRetry),
        now: () => clock,
      });
      assertEquals(outcome.ok, true);
      assertEquals(healthy.calls.length, 3);
    }
  });
});

Deno.test("orchestration gate - a later run for the same issue starts afresh after a completed run (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    // First run completes and leaves a released checkpoint under issue-3642.
    const firstFake = fakeRunner();
    const first = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, firstFake.runClaudeWithRetry),
    );
    assertEquals(first.ok, true);
    assertEquals(firstFake.calls.length, 3);

    // Second run, same issue and state dir (e.g. after PR feedback): it must
    // call the provider again rather than returning the released checkpoint.
    const secondFake = fakeRunner();
    const second = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, secondFake.runClaudeWithRetry),
    );
    assertEquals(second.ok, true);
    assertEquals(secondFake.calls.length, 3);
    if (!second.ok) return;
    assertEquals(second.value.output, "manager review");
  });
});

Deno.test("orchestration gate - a runner failure carrying a credential is masked in the returned error (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    // A GitHub token inside the runner's failure text; the gate must not return it.
    const secret = `ghp_${"x7Q".repeat(12)}`;
    const failing: IssueRunGateDeps["runClaudeWithRetry"] = () =>
      Promise.resolve({
        ok: false,
        error: new Error(`gh auth failed for token ${secret}`),
      });
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, failing),
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertEquals(outcome.error.message.includes(secret), false);
    // The non-secret part of the provider text survives the mask.
    assertStringIncludes(outcome.error.message, "gh auth failed");
    assertStringIncludes(outcome.error.message, "***REDACTED***");
  });
});

Deno.test("orchestration gate - runnerCallBudgetMs sums attempts, kill grace and retry waits (Issue #3642)", () => {
  const budget = runnerCallBudgetMs(
    { prompt: "unused", cwd: ".", timeoutSeconds: 100, killAfterSeconds: 5 },
    { maxRetries: 2, maxWaitSeconds: 10 },
  );
  assertEquals(budget, (3 * (100 + 10) + 2 * 10) * 1000 + 60_000);
});

Deno.test("orchestration gate - runnerCallBudgetMs with every option absent uses the runner defaults (Issue #3642)", () => {
  const budget = runnerCallBudgetMs({ prompt: "unused", cwd: "." }, undefined);
  assertEquals(budget, (3 * (14400 + 60) + 2 * 600) * 1000 + 60_000);
  assertEquals(budget > 4 * 3600 * 1000, true);
});

Deno.test("orchestration gate - createDefaultDeps wires runExternalOrchestratedIssueRun (Issue #3642)", () => {
  const deps = createDefaultDeps();
  assertEquals(typeof deps.runExternalOrchestratedIssueRun, "function");
});

Deno.test("orchestration gate - an unknown manager provider is refused before any runner call (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const refused = fakeRunner();
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { manager: { provider: "nope" } }),
      depsFor(dir, refused.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(outcome.error.message, 'unknown provider "nope"');
    assertEquals(refused.calls.length, 0);

    // Positive control: the same settings with a known provider reach the runner.
    const accepted = fakeRunner();
    const control = await runOrchestratedIssueRun(
      inputFor(dir, { manager: { provider: "claude" } }),
      depsFor(dir, accepted.runClaudeWithRetry),
    );
    assertEquals(control.ok, true);
    assertEquals(accepted.calls.length > 0, true);
  });
});

Deno.test("orchestration gate - a runner exit 124 is a timeout that ends the run timed_out after its retries (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner(() => runResult({ exitCode: 124 }));
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(outcome.error.message, "timed out after 2 attempt(s)");
    assertStringIncludes(outcome.error.message, "exited with code 124");
    assertEquals(fake.calls.length, 2);
  });
});

Deno.test("orchestration gate - a runner finish-deadline release returns the runner's timed-out result and the executor is not retried (Issue #4584)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner((options) =>
      options.orchestrationRole === "executor"
        ? runResult({
          exitCode: 124,
          timedOut: true,
          finishDeadline: true,
          output: "wip",
        })
        : answerByPhase(options)
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    if (!outcome.ok) return;
    assertEquals(outcome.value.timedOut, true);
    assertEquals(outcome.value.finishDeadline, true);
    assertEquals(outcome.value.output, "wip");
    // One plan call and one executor call: the release is not retried.
    assertEquals(
      fake.calls.filter((o) => o.orchestrationRole === "executor").length,
      1,
    );
    assertEquals(fake.calls.length, 2);
  });
});

Deno.test("orchestration gate - a runner scheduled hard-cap release returns the runner's timed-out result and the executor is not retried (Issue #4584)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner((options) =>
      options.orchestrationRole === "executor"
        ? runResult({
          exitCode: 124,
          timedOut: true,
          scheduledRelease: "hard-cap",
          output: "wip",
        })
        : answerByPhase(options)
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    if (!outcome.ok) return;
    assertEquals(outcome.value.timedOut, true);
    assertEquals(outcome.value.scheduledRelease, "hard-cap");
    assertEquals(outcome.value.output, "wip");
    assertEquals(
      fake.calls.filter((o) => o.orchestrationRole === "executor").length,
      1,
    );
    assertEquals(fake.calls.length, 2);
  });
});

Deno.test("orchestration gate - a genuine runner hard timeout is retried, then returns the runner's timed-out result (Issue #4584)", async () => {
  await withWorkDir(async (dir) => {
    // Each attempt answers differently, so the test sees which one is returned.
    let executorAttempt = 0;
    const fake = fakeRunner((options) => {
      if (options.orchestrationRole !== "executor") {
        return answerByPhase(options);
      }
      executorAttempt += 1;
      return runResult({
        exitCode: 124,
        timedOut: true,
        output: `slow-${executorAttempt}`,
      });
    });
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    if (!outcome.ok) return;
    assertEquals(outcome.value.timedOut, true);
    assertEquals(outcome.value.output, "slow-2");
    // One plan call, then the executor's two attempts.
    assertEquals(
      fake.calls.filter((o) => o.orchestrationRole === "executor").length,
      2,
    );
    assertEquals(fake.calls.length, 3);
  });
});

Deno.test("orchestration gate - an earlier attempt's timed-out result is not returned when a later attempt ends the run without one (Issue #4584)", async () => {
  await withWorkDir(async (dir) => {
    let executorAttempt = 0;
    const fake = fakeRunner((options) => {
      if (options.orchestrationRole !== "executor") {
        return answerByPhase(options);
      }
      executorAttempt += 1;
      // Attempt 1 is a genuine runner timeout (retried); attempt 2 exits 124
      // without the runner marking it timed out, so the run ends timed_out.
      return executorAttempt === 1
        ? runResult({ exitCode: 124, timedOut: true, output: "first" })
        : runResult({ exitCode: 124, timedOut: false });
    });
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    // Both attempts ran, so the stale first result is the only candidate.
    assertEquals(executorAttempt, 2);
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(outcome.error.message, "timed out after 2 attempt(s)");
  });
});

Deno.test("orchestration gate - an exit 124 that the runner did not mark timedOut is retried even with finishDeadline set (Issue #4584)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner((options) =>
      options.orchestrationRole === "executor"
        ? runResult({ exitCode: 124, timedOut: false, finishDeadline: true })
        : answerByPhase(options)
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    // One plan call, then the executor's two attempts.
    assertEquals(
      fake.calls.filter((o) => o.orchestrationRole === "executor").length,
      2,
    );
  });
});

Deno.test("orchestration gate - a timed-out result the run refuses on is an error, not the runner's result (Issue #4584)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner((options) =>
      options.orchestrationRole === "executor"
        ? runResult({ exitCode: 2, timedOut: true, output: "partial" })
        : answerByPhase(options)
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
  });
});

Deno.test("orchestration gate - a non-zero runner exit is an error that exhausts its retries (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner(() => runResult({ exitCode: 1 }));
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(outcome.error.message, "failed after 2 attempt(s)");
    assertStringIncludes(outcome.error.message, "exited with code 1");
    assertEquals(fake.calls.length, 2);
  });
});

Deno.test("orchestration gate - a runner Result failure maps to an error call that is retried (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    let runnerCalls = 0;
    const failing: IssueRunGateDeps["runClaudeWithRetry"] = () => {
      runnerCalls += 1;
      return Promise.resolve({ ok: false, error: new Error("boom") });
    };
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, failing),
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(outcome.error.message, "failed after 2 attempt(s)");
    assertStringIncludes(outcome.error.message, "boom");
    assertEquals(runnerCalls, 2);
  });
});

Deno.test("orchestration gate - a rate-limit failure is a quota refusal with no retry (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    const rateLimit: AgentFailure = {
      category: "rate-limit",
      message: "rate limit reached",
      evidence: "prose",
      terminal: false,
      errors: [],
    };
    const fake = fakeRunner(() =>
      runResult({ exitCode: 1, agentFailure: rateLimit })
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxRetries: 1 }),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(outcome.error.message, "rate limit reached");
    assertEquals(fake.calls.length, 1);
  });
});

Deno.test("orchestration gate - a priced runner result counts toward max_cost_usd (Issue #3642)", async () => {
  await withWorkDir(async (dir) => {
    // A realistic Sonnet invocation: about 1.2k tokens in and 400 out.
    const pricedStats: RunStats[] = [{
      servedModels: ["claude-sonnet-4-5"],
      requestedModel: "sonnet",
      wallClockMs: 1_000,
      tokenUsage: {
        inputTokens: 1_200,
        outputTokens: 400,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    }];
    const priced = fakeRunner((options) => ({
      ...answerByPhase(options),
      invocationStats: pricedStats,
    }));
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir, { maxCostUsd: 0.000001 }),
      depsFor(dir, priced.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(outcome.error.message, "of the 0.000001 USD allowed");
    // The plan is priced over the cap, so no second call is made.
    assertEquals(priced.calls.length, 1);

    // Positive control: the same settings with no invocation stats (unpriced)
    // run to completion. A fresh state dir keeps the refused checkpoint out.
    await withWorkDir(async (controlDir) => {
      const unpriced = fakeRunner();
      const control = await runOrchestratedIssueRun(
        inputFor(controlDir, { maxCostUsd: 0.000001 }),
        depsFor(controlDir, unpriced.runClaudeWithRetry),
      );
      assertEquals(control.ok, true);
    });
  });
});

/** A git checkout under `dir` with one committed file. */
async function gitCheckout(dir: string): Promise<string> {
  const repo = `${dir}/repo`;
  await Deno.mkdir(repo);
  const git = async (...args: string[]) => {
    const out = await new Deno.Command("git", { args, cwd: repo }).output();
    assertEquals(out.success, true, `git ${args.join(" ")}`);
  };
  await git("init", "-q");
  // CI runners have no global git identity; set one for this fixture.
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await Deno.writeTextFile(`${repo}/code.ts`, "base\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  return repo;
}

Deno.test("orchestration gate - a Codex manager or reviewer cannot change the checkout; the executor can (Issue #4356)", async () => {
  await withWorkDir(async (dir) => {
    const repo = await gitCheckout(dir);
    const codex = { provider: "codex" } as const;
    const warnings: string[] = [];
    const fake = fakeRunner((options) => {
      if (options.orchestrationRole === "executor") {
        Deno.writeTextFileSync(`${repo}/code.ts`, "executor\n");
      } else {
        Deno.writeTextFileSync(`${repo}/code.ts`, "read-only role\n");
        Deno.writeTextFileSync(`${repo}/stray.ts`, "stray\n");
      }
      return answerByPhase(options);
    });
    const outcome = await runOrchestratedIssueRun(
      inputFor(repo, { manager: codex, executor: codex, reviewer: codex }),
      {
        ...depsFor(dir, fake.runClaudeWithRetry),
        log: () => {},
        warn: (msg) => warnings.push(msg),
      },
    );
    assertEquals(outcome.ok, true);
    assertEquals(
      [...new Set(fake.calls.map((o) => String(o.orchestrationRole)))].sort(),
      ["executor", "manager", "reviewer"],
    );
    // The last call is a read-only one, and the executor's work survived it.
    assertEquals(await Deno.readTextFile(`${repo}/code.ts`), "executor\n");
    assertEquals(
      await Deno.stat(`${repo}/stray.ts`).then(() => true, () => false),
      false,
    );
    assertEquals(warnings.length > 0, true);
    assertStringIncludes(warnings.join("\n"), "reverted");
  });
});

/** Run stats for one call, named by the model it was served and the tokens it spent. */
function statsFor(model: string, outputTokens: number): RunStats {
  return {
    servedModels: [model],
    requestedModel: model,
    wallClockMs: outputTokens,
    durationMs: outputTokens,
    tokenUsage: {
      inputTokens: 1,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  };
}

Deno.test("orchestration gate - the result carries the plan and executor calls' stats beside the review's (Issue #4595)", async () => {
  await withWorkDir(async (dir) => {
    const fake = fakeRunner((options) =>
      runResult({
        output: options.prompt.startsWith(REVIEW_PREFIX)
          ? "manager review"
          : "step output",
        // Distinct figures per call: plan 100 (sonnet), executor 7000 (haiku), review 300 (opus).
        runStats: options.model === "haiku"
          ? statsFor("claude-haiku-4-5", 7000)
          : options.model === "opus"
          ? statsFor("claude-opus-4-8", 300)
          : statsFor("claude-sonnet-4-6", 100),
      })
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    if (!outcome.ok) return;
    // The returned result is still the review, so the phase's own handling is unchanged.
    assertEquals(outcome.value.runStats?.servedModels, ["claude-opus-4-8"]);
    // The calls the review does not cover ride beside it, in call order.
    assertEquals(
      outcome.value.orchestrationCalls?.map((call) =>
        call.runStats?.tokenUsage?.outputTokens
      ),
      [100, 7000],
    );
    assertEquals(
      outcome.value.orchestrationCalls?.map((call) =>
        call.runStats?.servedModels[0]
      ),
      ["claude-sonnet-4-6", "claude-haiku-4-5"],
    );
  });
});

Deno.test("orchestration gate - a retried executor call contributes every attempt it billed (Issue #4595)", async () => {
  await withWorkDir(async (dir) => {
    const failedAttempt = statsFor("claude-haiku-4-5", 4000);
    const finalAttempt = statsFor("claude-haiku-4-5", 5000);
    const fake = fakeRunner((options) =>
      runResult({
        output: options.prompt.startsWith(REVIEW_PREFIX)
          ? "manager review"
          : "step output",
        runStats: options.model === "haiku"
          ? finalAttempt
          : statsFor("claude-opus-4-8", 300),
        ...(options.model === "haiku"
          ? { invocationStats: [failedAttempt, undefined, finalAttempt] }
          : {}),
      })
    );
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    if (!outcome.ok) return;
    const haikuTokens = outcome.value.orchestrationCalls
      ?.filter((call) => call.runStats?.servedModels[0] === "claude-haiku-4-5")
      .map((call) => call.runStats?.tokenUsage?.outputTokens);
    assertEquals(haikuTokens, [4000, 5000]);
  });
});

Deno.test("orchestration gate - a timed-out run still carries the earlier calls' stats (Issue #4595)", async () => {
  await withWorkDir(async (dir) => {
    let call = 0;
    const fake = fakeRunner(() => {
      call++;
      // The plan finishes; the executor then times out.
      return call === 1
        ? runResult({ runStats: statsFor("claude-sonnet-4-6", 100) })
        : runResult({
          exitCode: 124,
          timedOut: true,
          runStats: statsFor("claude-haiku-4-5", 7000),
        });
    });
    const outcome = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, fake.runClaudeWithRetry),
    );
    assertEquals(outcome.ok, true);
    if (!outcome.ok) return;
    assertEquals(outcome.value.timedOut, true);
    // Every call but the one returned: the plan, then any earlier executor attempt.
    assertEquals(
      outcome.value.orchestrationCalls?.length,
      fake.calls.length - 1,
    );
    assertEquals(
      outcome.value.orchestrationCalls?.[0]?.runStats?.servedModels[0],
      "claude-sonnet-4-6",
    );
  });
});
