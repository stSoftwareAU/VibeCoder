/**
 * The opt-in gate that runs one issue through the external orchestrator
 * (Issue #3642). It is the only place the orchestrator meets the Claude
 * runner: each role call becomes one `runClaudeWithRetry` call pinned to the
 * selected provider, with model fallback off and the native `--agents`
 * sub-agent path never set. Every refusal fails closed. Nothing here falls
 * back to `--agents` or to a metered API.
 *
 * Australian English spelling throughout (behaviour, honoured, recognised).
 */

import {
  type ClaudeRunResult,
  DEFAULT_CLAUDE_KILL_AFTER_SECONDS,
  DEFAULT_CLAUDE_TIMEOUT_SECONDS,
  DEFAULT_RETRY_MAX_RETRIES,
  DEFAULT_RETRY_MAX_WAIT_SECONDS,
  type RetryOptions,
  type RunClaudeOptions,
} from "../claude_runner.ts";
import type { ExternalIssueRunInput } from "../execute_claude_phase.ts";
import { idempotencyKey } from "./checkpoint.ts";
import { preflightRole } from "./preflight.ts";
import { resolveAgentStateDir } from "../agent_state_dir.ts";
import { estimateCostWithUpperBound } from "../token_usage.ts";
import { effectiveRoleSelections } from "./role_config.ts";
import type { Result } from "../../types.ts";
import {
  type OrchestrationOutcome,
  runExternalOrchestration,
} from "./orchestrator.ts";
import {
  type AgentCall,
  type AgentCallResult,
  DEFAULT_ORCHESTRATION_BOUNDS,
  type InvokeAgent,
  type OrchestrationBounds,
} from "./types.ts";

/**
 * Slack added to the runner's own budget, covering process start-up and the
 * ladder's bookkeeping, so a call the runner finishes in time is never
 * reported as abandoned.
 */
const RUNNER_CALL_GRACE_MS = 60_000;

/**
 * How long one `runClaudeWithRetry` call may take before the orchestrator
 * abandons it. Each attempt may run to its hard timeout and then through its
 * kill grace, and each retry may first wait its full budget. Unset options
 * take the runner's own defaults. Progress extensions are not counted: each
 * one the runner grants moves that attempt's hard deadline past
 * `timeoutSeconds`, so an extended call can outlast this budget.
 *
 * @param claudeOptions - The Claude options the call runs with.
 * @param retryOptions - The retry options the call runs with.
 * @returns The budget in milliseconds.
 */
export function runnerCallBudgetMs(
  claudeOptions: RunClaudeOptions,
  retryOptions: RetryOptions | undefined,
): number {
  const maxRetries = retryOptions?.maxRetries ?? DEFAULT_RETRY_MAX_RETRIES;
  const maxWaitSeconds = retryOptions?.maxWaitSeconds ??
    DEFAULT_RETRY_MAX_WAIT_SECONDS;
  const timeoutSeconds = claudeOptions.timeoutSeconds ??
    DEFAULT_CLAUDE_TIMEOUT_SECONDS;
  const killAfterSeconds = claudeOptions.killAfterSeconds ??
    DEFAULT_CLAUDE_KILL_AFTER_SECONDS;
  const attempts = maxRetries + 1;
  const perAttemptSeconds = timeoutSeconds + 2 * killAfterSeconds;
  const waitSeconds = maxRetries * maxWaitSeconds;
  return (attempts * perAttemptSeconds + waitSeconds) * 1000 +
    RUNNER_CALL_GRACE_MS;
}

/** Injected collaborators. Tests supply fakes so no provider CLI runs. */
export interface IssueRunGateDeps {
  /** The Claude runner, passed in so tests can fake it; only its default constants are imported. */
  preflight?: typeof preflightRole;
  runClaudeWithRetry: (
    options: RunClaudeOptions,
    retryOptions?: RetryOptions,
  ) => Promise<Result<ClaudeRunResult>>;
  /** Parent of the checkpoint directory; defaults to the work directory's agent state dir. */
  stateDir?: string;
  /** Child env used for credential and billing checks. */
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  /** Clock in epoch milliseconds. */
  now?: () => number;
}

/** Builds the Claude options for one role call, with the gate's pins applied. */
function claudeOptionsFor(
  input: ExternalIssueRunInput,
  call: AgentCall,
): RunClaudeOptions {
  return {
    ...input.claudeOptions,
    prompt: call.prompt,
    agentProvider: call.envelope.provider,
    model: call.envelope.model,
    effort: call.envelope.effort,
    disallowedTools: [
      ...(input.claudeOptions.disallowedTools ?? []),
      ...call.envelope.deniedTools,
    ],
    // Fallback to another model would hide a failure the operator should see.
    enableModelFallback: false,
    // The gate never uses Claude's native `--agents` sub-agent path.
    agents: undefined,
    // Per-attempt usage is what the cost bound is priced from.
    captureInvocationStats: true,
    orchestrationRole: call.envelope.role === "executor"
      ? "executor"
      : call.envelope.role === "manager"
      ? "manager"
      : "reviewer",
    lifecycleRole: call.envelope.role === "executor"
      ? "executor"
      : call.envelope.role === "manager"
      ? "manager"
      : "reviewer",
    // Each role starts with its own context; a manager transcript must not reach an executor.
    sessionResumeState: undefined,
    mcpConfig: undefined,
    settingsJson: undefined,
    issueExecutorSplit: false,
  };
}

/** The spend of one runner result, priced from its captured invocation stats. */
function costOf(result: ClaudeRunResult): number | undefined {
  let total = 0;
  let priced = false;
  for (const stats of result.invocationStats ?? []) {
    if (!stats?.tokenUsage) continue;
    total += estimateCostWithUpperBound(stats.tokenUsage, stats.requestedModel)
      .cost.totalCost;
    priced = true;
  }
  return priced ? total : undefined;
}

/** Maps one runner result onto the orchestrator's call outcome. */
function toAgentCallResult(result: ClaudeRunResult): AgentCallResult {
  const category = result.agentFailure?.category;
  const message = result.agentFailure?.message ??
    `claude exited with code ${result.exitCode}`;
  if (category === "authentication") {
    return { ok: false, kind: "auth", message };
  }
  if (
    category === "quota-exhausted" || category === "rate-limit" ||
    result.usageLimit !== undefined || result.noEligibleCredential === true ||
    result.exitCode === 2
  ) {
    return { ok: false, kind: "quota", message };
  }
  if (category === "timeout" || result.exitCode === 124) {
    return { ok: false, kind: "timeout", message };
  }
  if (result.exitCode !== 0) {
    return { ok: false, kind: "error", message };
  }
  return { ok: true, output: result.output, costUsd: costOf(result) };
}

/**
 * Runs one issue through the external orchestrator and returns the manager's
 * final result when the run is done. Any other outcome is an error.
 *
 * @param input - The issue, its brief, the Claude options and the settings.
 * @param deps - The runner and the optional state dir, env and clock.
 * @returns The last manager result on `done`, otherwise an error.
 */
export async function runOrchestratedIssueRun(
  input: ExternalIssueRunInput,
  deps: IssueRunGateDeps,
): Promise<Result<ClaudeRunResult>> {
  const settings = input.settings;
  const maxConcurrency = settings.maxConcurrency ??
    DEFAULT_ORCHESTRATION_BOUNDS.maxConcurrency;
  if (maxConcurrency > 1) {
    return {
      ok: false,
      error: new Error(
        "external orchestration: sequential dispatch only (maxConcurrency must be 1)",
      ),
    };
  }

  const selected = effectiveRoleSelections(settings);
  const manager = { value: selected.manager };
  const executor = { value: selected.executor };
  const reviewer = { value: selected.reviewer };
  const environment = deps.env ?? Deno.env.toObject();
  try {
    for (const selection of [manager.value, executor.value, reviewer.value]) {
      await (deps.preflight ?? preflightRole)(
        selection,
        input.workDir,
        environment,
      );
    }
  } catch (error) {
    return {
      ok: false,
      error: new Error(error instanceof Error ? error.message : String(error)),
    };
  }
  (deps.log ?? console.info)(
    `Effective orchestration roles: ${
      JSON.stringify({
        manager: manager.value,
        executor: executor.value,
        reviewer: reviewer.value,
      })
    }`,
  );

  // Beside the work volume, never inside it, so `nukeWorkDir` cannot wipe it.
  const stateRoot = deps.stateDir ?? resolveAgentStateDir(input.workDir);
  if (!stateRoot) {
    return {
      ok: false,
      error: new Error(
        "external orchestration: no agent state directory to checkpoint into",
      ),
    };
  }

  const bounds: Partial<OrchestrationBounds> = {
    maxConcurrency,
    maxRetries: settings.maxRetries ?? DEFAULT_ORCHESTRATION_BOUNDS.maxRetries,
    maxInvocations: settings.maxInvocations ??
      DEFAULT_ORCHESTRATION_BOUNDS.maxInvocations,
    ...(settings.maxCostUsd !== undefined
      ? { maxCostUsd: settings.maxCostUsd }
      : {}),
  };

  let lastManagerResult: ClaudeRunResult | undefined;
  const invoke: InvokeAgent = async (call) => {
    const run = await deps.runClaudeWithRetry(
      claudeOptionsFor(input, call),
      input.retryOptions,
    );
    if (!run.ok) {
      return { ok: false, kind: "error", message: run.error.message };
    }
    const result = run.value;
    if (call.envelope.role !== "executor") lastManagerResult = result;
    return toAgentCallResult(result);
  };

  const outcome: OrchestrationOutcome = await runExternalOrchestration({
    // The lease is stable per issue so a resumed run matches its checkpoint.
    leaseId: await idempotencyKey(
      String(input.issueNumber),
      "manager",
      0,
      JSON.stringify({ repo: input.repo, branch: input.branch, settings }),
    ),
    issueId: String(input.issueNumber),
    branch: input.branch,
    workspaceDir: input.workspaceDir,
    brief: input.brief,
    acceptanceCriteria: [],
    manager: manager.value,
    executor: executor.value,
    ...(settings.reviewer ? { reviewer: reviewer.value } : {}),
    bounds,
    checkpointDir: `${stateRoot}/orchestration/${
      encodeURIComponent(input.repo)
    }`,
    invoke,
    callTimeoutMs: runnerCallBudgetMs(input.claudeOptions, input.retryOptions),
    env: environment,
    now: deps.now,
    log: deps.log,
  });

  if (outcome.state === "done" && lastManagerResult) {
    return { ok: true, value: lastManagerResult };
  }
  return {
    ok: false,
    error: new Error(
      outcome.refusal?.message ?? outcome.reason ??
        `external orchestration ended ${outcome.state}`,
    ),
  };
}
