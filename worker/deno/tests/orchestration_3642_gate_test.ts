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
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function inputFor(
  workspaceDir: string,
  settings: ExternalOrchestrationSettings = {},
): ExternalIssueRunInput {
  return {
    claudeOptions: { prompt: "unused", cwd: workspaceDir },
    retryOptions: {},
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
    stateDir: `${dir}/state`,
    env: SUBSCRIPTION_ENV,
    now,
  };
}

Deno.test("orchestration gate - default selection uses the Sonnet manager and Haiku executor, never --agents or fallback (Issue #3642)", async () => {
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
    assertEquals(selections, ["haiku/high", "sonnet/high"]);
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
    assertEquals(selections, ["opus/max", "sonnet/low"]);
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
      inputFor(dir, { executor: { provider: "codex" } }),
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
    // First run: the plan succeeds, then the executor fails every attempt.
    const broken = fakeRunner((options) =>
      options.model === "haiku"
        ? runResult({ exitCode: 1, output: "executor broke" })
        : answerByPhase(options)
    );
    const first = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, broken.runClaudeWithRetry),
    );
    assertEquals(first.ok, false);
    assertEquals(broken.calls.filter(isPlanCall).length, 1);

    // Second run, same issue and state dir: the executor now succeeds.
    const healthy = fakeRunner();
    const second = await runOrchestratedIssueRun(
      inputFor(dir),
      depsFor(dir, healthy.runClaudeWithRetry),
    );
    assertEquals(second.ok, true);
    // The plan was checkpointed under the same lease, so it is not repeated.
    assertEquals(healthy.calls.filter(isPlanCall).length, 0);
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
    const secret = "ghp_Qx7Lm2Vb9Nc4Zd8Rf1Tg6Hy3Jk5Wp0Sa2Eu4Io";
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
