/**
 * External, provider-neutral orchestration of one issue (Issue #3642), behind
 * an opt-in flag. The manager plans, the executor carries the plan out, and
 * the manager reviews the result. Each role call goes through the injected
 * {@link InvokeAgent}, so the handoff never depends on Claude's `--agents`
 * mechanism, and no role may delegate further (contract section 6, Issue
 * #3641).
 *
 * The run fails closed. Any refusal (an unsupported selection, a missing
 * enforcement of a denied tool, metered billing, a lapsed lease, an exhausted
 * budget, or an auth or quota failure) returns a refused outcome. Nothing is
 * retried on a second provider, and nothing falls back silently.
 *
 * Australian English spelling throughout (behaviour, honoured, recognised).
 */

import { classifyProviderBilling } from "../provider_billing.ts";
import { redactSecrets } from "../secret_redaction.ts";
import { assertRoleSupported } from "./capabilities.ts";
import {
  idempotencyKey,
  loadCheckpoint,
  ORCHESTRATION_CHECKPOINT_SCHEMA,
  type OrchestrationCheckpoint,
  saveCheckpoint,
} from "./checkpoint.ts";
import {
  type AgentCall,
  type AgentCallResult,
  assertTransition,
  DEFAULT_ORCHESTRATION_BOUNDS,
  type InvokeAgent,
  type OrchestrationBounds,
  type OrchestrationRefusal,
  type OrchestrationState,
  type RoleSelection,
  type StructuredResult,
  type TargetRole,
  type TaskEnvelope,
} from "./types.ts";

/** How long a lease may go unrenewed before a resume refuses it. */
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

/** The longest one provider call may run before it counts as a timeout. */
const CALL_TIMEOUT_MS = 10 * 60_000;

const MANAGER_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];
const MANAGER_DENIED_TOOLS = ["Edit", "Write", "Bash", "Task"];
const EXECUTOR_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Grep",
  "Glob",
];
const EXECUTOR_DENIED_TOOLS = ["Task"];

const DELEGATION_CONSTRAINT =
  "Do not delegate to other agents; the run is one level deep (contract section 6).";
const STOP_CONDITION =
  "Stop and report once the acceptance criteria are met or the brief cannot be carried out.";

/** What one orchestrated run is asked to do, and how it may proceed. */
export interface ExternalOrchestrationOptions {
  issueId: string;
  branch: string;
  workspaceDir: string;
  brief: string;
  acceptanceCriteria: string[];
  manager: RoleSelection;
  executor: RoleSelection;
  bounds?: Partial<OrchestrationBounds>;
  checkpointDir: string;
  invoke: InvokeAgent;
  /** child env used for credential/billing checks; defaults to Deno.env.toObject() */
  env?: Record<string, string | undefined>;
  /** Clock in epoch milliseconds; defaults to Date.now. */
  now?: () => number;
  /** The lease this run holds; a fresh one is generated when absent. */
  leaseId?: string;
  /** How long a lease may go unrenewed; defaults to 15 minutes. */
  leaseTtlMs?: number;
  /** Polled before each provider call; true cancels the run. */
  isCancelled?: () => boolean;
  log?: (msg: string) => void;
}

/** How an orchestrated run ended, and what it produced. */
export interface OrchestrationOutcome {
  state:
    | "done"
    | "blocked"
    | "refused"
    | "timed_out"
    | "cancelled"
    | "released";
  reason?: string;
  refusal?: OrchestrationRefusal;
  results: StructuredResult[];
  /** True when the run continued from a checkpoint written under the same lease. */
  resumed: boolean;
  /** Provider invocations made across resumes of the same unreleased lease; reset after a released checkpoint. */
  invocations: number;
  /** Spend across resumes of the same unreleased lease; reset after a released checkpoint. */
  costUsd: number;
  /** The manager's final review output when state is "done". */
  managerOutput?: string;
}

type Phase = "plan" | "execute" | "review";

type CallResult =
  | { ok: true; output: string }
  | { ok: false; outcome: OrchestrationOutcome };

type TerminalState = "refused" | "blocked" | "timed_out" | "cancelled";

function isCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function boundsProblem(bounds: OrchestrationBounds): string | undefined {
  if (!isCount(bounds.maxRetries)) {
    return "maxRetries must be a whole number, zero or more";
  }
  if (!isCount(bounds.maxDelegationDepth)) {
    return "maxDelegationDepth must be a whole number, zero or more";
  }
  if (!Number.isInteger(bounds.maxConcurrency) || bounds.maxConcurrency < 1) {
    return "maxConcurrency must be a whole number, one or more";
  }
  if (!Number.isInteger(bounds.maxInvocations) || bounds.maxInvocations < 1) {
    return "maxInvocations must be a whole number, one or more";
  }
  if (
    bounds.maxCostUsd !== undefined &&
    !(Number.isFinite(bounds.maxCostUsd) && bounds.maxCostUsd >= 0)
  ) {
    return "maxCostUsd must be a finite number, zero or more";
  }
  return undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function criteriaList(criteria: readonly string[]): string {
  return criteria.length === 0
    ? "- (none given)"
    : criteria.map((item) => `- ${item}`).join("\n");
}

function planPrompt(
  issueId: string,
  branch: string,
  brief: string,
  criteria: readonly string[],
): string {
  return [
    `Manager role for issue ${issueId} on branch ${branch}.`,
    "Plan the work for the brief below. Do not edit files and do not delegate.",
    "Reply with the plan as plain text.",
    "",
    "Brief:",
    brief,
    "",
    "Acceptance criteria:",
    criteriaList(criteria),
  ].join("\n");
}

function executePrompt(
  issueId: string,
  branch: string,
  brief: string,
  plan: string,
): string {
  return [
    `Executor role for issue ${issueId} on branch ${branch}.`,
    "Carry out the plan below in the workspace. Do not delegate.",
    "",
    "Plan:",
    plan,
    "",
    "Brief:",
    brief,
  ].join("\n");
}

function reviewPrompt(
  issueId: string,
  brief: string,
  criteria: readonly string[],
  execution: string,
): string {
  return [
    `Manager review for issue ${issueId}.`,
    "Review the executor's work against the acceptance criteria below.",
    "Reply with the review as plain text; an empty review blocks the run.",
    "",
    "Acceptance criteria:",
    criteriaList(criteria),
    "",
    "Brief:",
    brief,
    "",
    "Executor summary:",
    execution,
  ].join("\n");
}

/**
 * Runs one issue through the manager and executor roles, checkpointing every
 * step, so an interrupted run can resume without repeating a finished call.
 *
 * @param options - The issue, the two role selections, the invoker and bounds.
 * @returns The outcome. Refusals and failures are returned, not thrown.
 */
export async function runExternalOrchestration(
  options: ExternalOrchestrationOptions,
): Promise<OrchestrationOutcome> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const environment = options.env ?? Deno.env.toObject();
  const lookup = (name: string): string | undefined => environment[name];

  const refusedAtStart = (
    refusal: OrchestrationRefusal,
  ): OrchestrationOutcome => ({
    state: "refused",
    reason: refusal.message,
    refusal,
    results: [],
    resumed: false,
    invocations: 0,
    costUsd: 0,
  });

  const texts = {
    issueId: options.issueId,
    branch: options.branch,
    workspaceDir: options.workspaceDir,
    brief: options.brief,
    checkpointDir: options.checkpointDir,
  };
  for (const [name, value] of Object.entries(texts)) {
    if (value.trim() === "") {
      return refusedAtStart({
        kind: "invalid_selection",
        message: `${name} must not be blank`,
      });
    }
  }
  if (options.leaseId !== undefined && options.leaseId.trim() === "") {
    return refusedAtStart({
      kind: "invalid_selection",
      message: "leaseId must not be blank",
    });
  }
  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!(Number.isFinite(leaseTtlMs) && leaseTtlMs > 0)) {
    return refusedAtStart({
      kind: "invalid_selection",
      message: "leaseTtlMs must be a positive number of milliseconds",
    });
  }

  const bounds: OrchestrationBounds = {
    maxRetries: options.bounds?.maxRetries ??
      DEFAULT_ORCHESTRATION_BOUNDS.maxRetries,
    maxDelegationDepth: options.bounds?.maxDelegationDepth ??
      DEFAULT_ORCHESTRATION_BOUNDS.maxDelegationDepth,
    maxConcurrency: options.bounds?.maxConcurrency ??
      DEFAULT_ORCHESTRATION_BOUNDS.maxConcurrency,
    maxInvocations: options.bounds?.maxInvocations ??
      DEFAULT_ORCHESTRATION_BOUNDS.maxInvocations,
    maxCostUsd: options.bounds?.maxCostUsd,
  };
  const problem = boundsProblem(bounds);
  if (problem !== undefined) {
    return refusedAtStart({ kind: "invalid_selection", message: problem });
  }
  if (bounds.maxDelegationDepth < 1) {
    return refusedAtStart({
      kind: "depth_exceeded",
      message:
        `maxDelegationDepth is ${bounds.maxDelegationDepth}; the executor sits one level below the manager, so no delegation is allowed`,
    });
  }

  const roles: Array<[TargetRole, RoleSelection, readonly string[]]> = [
    ["manager", options.manager, MANAGER_DENIED_TOOLS],
    ["executor", options.executor, EXECUTOR_DENIED_TOOLS],
  ];
  for (const [role, selection, denied] of roles) {
    const refusal = assertRoleSupported(selection, role, denied);
    if (refusal) return refusedAtStart(refusal);
  }

  for (const selection of [options.manager, options.executor]) {
    const evidence = classifyProviderBilling(selection.provider, {
      workDir: options.workspaceDir,
      env: lookup,
    });
    if (evidence.billingMode === "metered") {
      return refusedAtStart({
        kind: "metered_billing",
        message:
          `${selection.provider} is billed per token (${evidence.reason}); an orchestrated run will not spend metered credit`,
      });
    }
  }

  const loaded = await loadCheckpoint(options.checkpointDir, options.issueId);
  if (loaded.warning !== undefined) log(loaded.warning);

  const leaseId = options.leaseId ?? crypto.randomUUID();
  const freshCheckpoint = (): OrchestrationCheckpoint => ({
    schema: ORCHESTRATION_CHECKPOINT_SCHEMA,
    issueId: options.issueId,
    leaseId,
    leaseHeartbeatMs: now(),
    state: "claimed",
    invocations: 0,
    costUsd: 0,
    steps: {},
    results: [],
  });

  const existing = loaded.checkpoint;
  let resumed = false;
  let cp: OrchestrationCheckpoint;
  if (
    existing !== undefined && existing.leaseId === leaseId &&
    existing.state !== "released"
  ) {
    cp = existing;
    resumed = true;
  } else {
    if (existing !== undefined && existing.leaseId === leaseId) {
      // A released checkpoint is a completed prior run, not an interrupted one.
      log(
        `orchestration checkpoint for ${options.issueId} is released (the prior run completed); starting afresh under lease ${leaseId}`,
      );
    } else if (existing !== undefined) {
      log(
        `orchestration checkpoint for ${options.issueId} belongs to lease ${existing.leaseId}; starting afresh under lease ${leaseId}`,
      );
    }
    cp = freshCheckpoint();
  }

  const persist = async (renew: boolean): Promise<void> => {
    if (renew) cp.leaseHeartbeatMs = now();
    await saveCheckpoint(options.checkpointDir, cp);
  };
  const move = (to: OrchestrationState): void => {
    assertTransition(cp.state, to);
    cp.state = to;
  };
  const marker = (phase: Phase): string => `${options.issueId}:phase:${phase}`;
  const lapsed = (): boolean => now() - cp.leaseHeartbeatMs > leaseTtlMs;
  const staleMessage = (): string =>
    `lease ${leaseId} lapsed: last renewed at ${cp.leaseHeartbeatMs}, ttl ${leaseTtlMs} ms`;

  const outcome = (
    state: OrchestrationOutcome["state"],
    extra: {
      reason?: string;
      refusal?: OrchestrationRefusal;
      managerOutput?: string;
    },
  ): OrchestrationOutcome => ({
    state,
    ...extra,
    results: [...cp.results],
    resumed,
    invocations: cp.invocations,
    costUsd: cp.costUsd,
  });

  const finish = async (
    state: TerminalState,
    reason: string,
    refusal?: OrchestrationRefusal,
  ): Promise<OrchestrationOutcome> => {
    move(state);
    cp.final = refusal ? { state, reason, refusal } : { state, reason };
    // A lapsed lease stays lapsed: a stale refusal must not renew its heartbeat.
    await persist(refusal?.kind !== "stale_lease");
    return outcome(state, { reason, refusal });
  };

  if (resumed && cp.state !== "claimed") {
    if (cp.state !== "recovering") move("recovering");
    if (lapsed()) {
      return await finish("refused", staleMessage(), {
        kind: "stale_lease",
        message: staleMessage(),
      });
    }
    delete cp.final;
    move(cp.steps[marker("plan")] !== undefined ? "dispatched" : "planning");
  } else {
    move("planning");
  }
  await persist(true);

  const stopBeforeCall = async (): Promise<
    OrchestrationOutcome | undefined
  > => {
    if (options.isCancelled?.()) {
      return await finish(
        "cancelled",
        "run cancelled before the next provider call",
      );
    }
    if (lapsed()) {
      return await finish("refused", staleMessage(), {
        kind: "stale_lease",
        message: staleMessage(),
      });
    }
    if (cp.invocations >= bounds.maxInvocations) {
      const message =
        `the run has made ${cp.invocations} of ${bounds.maxInvocations} allowed provider invocations`;
      return await finish("refused", message, {
        kind: "budget_exceeded",
        message,
      });
    }
    if (bounds.maxCostUsd !== undefined && cp.costUsd >= bounds.maxCostUsd) {
      const message =
        `the run has spent ${cp.costUsd} USD of the ${bounds.maxCostUsd} USD allowed`;
      return await finish("refused", message, {
        kind: "budget_exceeded",
        message,
      });
    }
    return undefined;
  };

  const callProvider = async (call: AgentCall): Promise<AgentCallResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<AgentCallResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ok: false,
            kind: "timeout",
            message: `no answer within ${CALL_TIMEOUT_MS} ms`,
          }),
        CALL_TIMEOUT_MS,
      );
    });
    const answer = Promise.resolve()
      .then(() => options.invoke(call))
      .catch((err: unknown): AgentCallResult => ({
        ok: false,
        kind: "error",
        message: errorText(err),
      }));
    try {
      return await Promise.race([answer, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };

  const envelopeFor = (
    role: TargetRole,
    selection: RoleSelection,
    tools: { allowed: readonly string[]; denied: readonly string[] },
  ): TaskEnvelope => ({
    role,
    provider: selection.provider,
    model: selection.model,
    effort: selection.effort,
    allowedTools: [...tools.allowed],
    deniedTools: [...tools.denied],
    workspaceDir: options.workspaceDir,
    brief: options.brief,
    issueId: options.issueId,
    branch: options.branch,
    constraints: [DELEGATION_CONSTRAINT],
    acceptanceCriteria: [...options.acceptanceCriteria],
    stopConditions: [STOP_CONDITION],
    maxRetries: bounds.maxRetries,
    timeoutMs: CALL_TIMEOUT_MS,
    leaseId,
    leaseExpiresAt: now() + leaseTtlMs,
    heartbeatIntervalMs: Math.floor(leaseTtlMs / 3),
  });

  const invokeRole = async (
    role: TargetRole,
    selection: RoleSelection,
    prompt: string,
    tools: { allowed: readonly string[]; denied: readonly string[] },
    phase: Phase,
  ): Promise<CallResult> => {
    const attempts = bounds.maxRetries + 1;
    for (let attempt = 0; ; attempt++) {
      const key = await idempotencyKey(options.issueId, role, attempt, prompt);
      const recorded = cp.steps[key];
      if (recorded !== undefined) return { ok: true, output: recorded };

      const stop = await stopBeforeCall();
      if (stop !== undefined) return { ok: false, outcome: stop };
      if (phase === "execute" && cp.state === "dispatched") move("executing");

      cp.invocations += 1;
      await persist(true);
      const result = await callProvider({
        envelope: envelopeFor(role, selection, tools),
        prompt,
        idempotencyKey: key,
      });
      if (result.ok) {
        cp.costUsd += result.costUsd ?? 0;
        cp.steps[key] = result.output;
        await persist(true);
        return { ok: true, output: result.output };
      }
      await persist(true);
      // Provider text may carry a credential, so it is masked before it reaches the checkpoint.
      const safe = redactSecrets(result.message);

      if (result.kind === "auth") {
        return {
          ok: false,
          outcome: await finish(
            "refused",
            `${selection.provider} rejected its credentials: ${safe}`,
            { kind: "auth_failure", message: safe },
          ),
        };
      }
      if (result.kind === "quota") {
        return {
          ok: false,
          outcome: await finish(
            "refused",
            `${selection.provider} has no quota left: ${safe}`,
            { kind: "quota_exhausted", message: safe },
          ),
        };
      }
      if (attempt + 1 < attempts) {
        if (phase === "execute") move("dispatched");
        continue;
      }
      if (result.kind === "timeout") {
        return {
          ok: false,
          outcome: await finish(
            "timed_out",
            `${role} call timed out after ${attempts} attempt(s): ${safe}`,
          ),
        };
      }
      const message =
        `${role} call failed after ${attempts} attempt(s): ${safe}`;
      return {
        ok: false,
        outcome: await finish("refused", message, {
          kind: "retries_exhausted",
          message,
        }),
      };
    }
  };

  if (cp.state === "planning") {
    const planned = await invokeRole(
      "manager",
      options.manager,
      planPrompt(
        options.issueId,
        options.branch,
        options.brief,
        options.acceptanceCriteria,
      ),
      { allowed: MANAGER_ALLOWED_TOOLS, denied: MANAGER_DENIED_TOOLS },
      "plan",
    );
    if (!planned.ok) return planned.outcome;
    if (planned.output.trim() === "") {
      return await finish("blocked", "the manager returned an empty plan");
    }
    cp.steps[marker("plan")] = planned.output;
    cp.results.push({
      role: "manager",
      status: "done",
      filesChanged: [],
      summary: planned.output,
      evidence: [],
    });
    move("dispatched");
    await persist(true);
  }

  if (cp.state === "dispatched") {
    if (cp.steps[marker("execute")] === undefined) {
      const executed = await invokeRole(
        "executor",
        options.executor,
        executePrompt(
          options.issueId,
          options.branch,
          options.brief,
          cp.steps[marker("plan")] ?? "",
        ),
        { allowed: EXECUTOR_ALLOWED_TOOLS, denied: EXECUTOR_DENIED_TOOLS },
        "execute",
      );
      if (!executed.ok) return executed.outcome;
      cp.steps[marker("execute")] = executed.output;
      cp.results.push({
        role: "executor",
        status: "done",
        filesChanged: [],
        summary: executed.output,
        evidence: [],
      });
    }
    if (cp.state === "dispatched") move("executing");
    move("reviewing");
    await persist(true);
  }

  if (cp.state === "reviewing") {
    if (cp.steps[marker("review")] === undefined) {
      const reviewed = await invokeRole(
        "manager",
        options.manager,
        reviewPrompt(
          options.issueId,
          options.brief,
          options.acceptanceCriteria,
          cp.steps[marker("execute")] ?? "",
        ),
        { allowed: MANAGER_ALLOWED_TOOLS, denied: MANAGER_DENIED_TOOLS },
        "review",
      );
      if (!reviewed.ok) return reviewed.outcome;
      if (reviewed.output.trim() === "") {
        return await finish("blocked", "the manager returned an empty review");
      }
      cp.steps[marker("review")] = reviewed.output;
      cp.results.push({
        role: "manager",
        status: "done",
        filesChanged: [],
        summary: reviewed.output,
        evidence: [],
      });
    }
    const managerOutput = cp.steps[marker("review")];
    move("done");
    cp.final = {
      state: "done",
      reason: "manager review accepted",
      managerOutput,
    };
    await persist(true);
    move("released");
    await persist(true);
    return outcome("done", {
      reason: "manager review accepted",
      managerOutput,
    });
  }

  throw new Error(
    `orchestration: run for ${options.issueId} reached unexpected state ${cp.state}`,
  );
}
