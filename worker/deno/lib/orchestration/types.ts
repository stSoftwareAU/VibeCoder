/**
 * Types for the external, provider-neutral orchestration (Issue #3642).
 *
 * The shapes follow the contract in docs/MANAGER-WORKER-CONTRACT.md
 * (Issue #3641) sections 4 to 6. Nothing here reaches a provider by itself:
 * the orchestrator builds these values and hands each role call to an
 * injected {@link InvokeAgent}, so the handoff never depends on Claude's
 * `--agents` sub-agent mechanism.
 *
 * Australian English spelling throughout (behaviour, honoured, recognised).
 */

/** The role one call plays inside an orchestrated run. */
export type TargetRole =
  | "manager"
  | "executor"
  | "spec_reviewer"
  | "standards_reviewer"
  | "explorer";

/** A provider the orchestrator can name as a handoff target. */
export type TargetProvider = "claude" | "codex" | "gemini" | "deepseek";

/** The provider, model and reasoning effort one role runs with. */
export interface RoleSelection {
  provider: TargetProvider;
  model?: string;
  effort?: string;
}

/** What one role call is handed: the contract's task envelope (section 4). */
export interface TaskEnvelope {
  role: TargetRole;
  provider: TargetProvider;
  model?: string;
  effort?: string;
  allowedTools: string[];
  deniedTools: string[];
  workspaceDir: string;
  brief: string;
  issueId: string;
  branch: string;
  constraints: string[];
  acceptanceCriteria: string[];
  stopConditions: string[];
  maxRetries: number;
  timeoutMs: number;
  leaseId: string;
  /** Epoch milliseconds at which the lease lapses unless it is renewed. */
  leaseExpiresAt: number;
  heartbeatIntervalMs: number;
}

/** How a role call ended, as the orchestrator records it. */
export type StructuredStatus =
  | "done"
  | "blocked"
  | "failed"
  | "cancelled"
  | "timed_out";

/** What one role call reports back: the contract's structured result. */
export interface StructuredResult {
  role: TargetRole;
  status: StructuredStatus;
  filesChanged: string[];
  summary: string;
  evidence: string[];
}

/**
 * What a provider can carry of the contract. Every field is derived from the
 * provider's registered descriptor; see `providerCapabilities`.
 */
export interface ProviderCapabilities {
  /** The CLI accepts `--agents` sub-agent definitions. */
  agents: boolean;
  /** The CLI accepts a `--settings` payload carrying hooks. */
  settingsHook: boolean;
  /** The provider's stream can be compacted mid-run. */
  compaction: boolean;
  /** How the prompt reaches the CLI. */
  promptTransport: "stdin" | "argv";
}

/**
 * The states of one orchestrated run (contract section 5). `recovering` is
 * the state a resumed run enters before it re-checks its lease.
 */
export type OrchestrationState =
  | "claimed"
  | "planning"
  | "refused"
  | "dispatched"
  | "executing"
  | "reviewing"
  | "blocked"
  | "timed_out"
  | "cancelled"
  | "recovering"
  | "done"
  | "released";

/** The limits one run may not exceed. Retries and depth are per the contract. */
export interface OrchestrationBounds {
  /** Extra attempts after a failed `error` or `timeout` call. An abandoned call (no answer within the call timeout) is never retried. */
  maxRetries: number;
  /** How many delegation levels below the manager may run (contract section 6). */
  maxDelegationDepth: number;
  /** How many role calls may be in flight at once. */
  maxConcurrency: number;
  /** The most provider invocations one run may make, across resumes. */
  maxInvocations: number;
  /** The most spend one run may make. Absent means no cost cap. */
  maxCostUsd?: number;
}

/** Bounds used for any field the caller leaves out. */
export const DEFAULT_ORCHESTRATION_BOUNDS: OrchestrationBounds = {
  maxRetries: 1,
  maxDelegationDepth: 1,
  maxConcurrency: 1,
  maxInvocations: 6,
};

/** Why one provider call failed, as the injected invoker reports it. */
export type AgentCallFailureKind = "auth" | "quota" | "timeout" | "error";

/** One role call handed to the injected invoker. */
export interface AgentCall {
  envelope: TaskEnvelope;
  prompt: string;
  idempotencyKey: string;
}

/** What the injected invoker reports back for one call. */
export type AgentCallResult =
  | { ok: true; output: string; costUsd?: number }
  | { ok: false; kind: AgentCallFailureKind; message: string };

/** Runs one role call against a real or fake provider. */
export type InvokeAgent = (call: AgentCall) => Promise<AgentCallResult>;

/** Why an orchestrated run refused to continue. */
export type OrchestrationRefusalKind =
  | "unsupported_provider"
  | "unsupported_capability"
  | "missing_tool_support"
  | "auth_failure"
  | "quota_exhausted"
  | "stale_lease"
  | "metered_billing"
  | "depth_exceeded"
  | "budget_exceeded"
  | "retries_exhausted"
  | "invalid_selection";

/** A refusal: the kind, and an operator-facing message. */
export interface OrchestrationRefusal {
  kind: OrchestrationRefusalKind;
  message: string;
}

/**
 * The legal transitions between states (contract section 5), plus the
 * extensions this orchestrator needs and the contract does not draw:
 * resumption enters `recovering` from every unreleased state, and a
 * refusal, cancellation or budget stop may arise in any active state.
 */
export const ORCHESTRATION_TRANSITIONS: Readonly<
  Record<OrchestrationState, readonly OrchestrationState[]>
> = {
  claimed: ["planning"],
  planning: [
    "dispatched",
    "refused",
    "blocked",
    "timed_out",
    "cancelled",
    "recovering",
  ],
  dispatched: ["executing", "refused", "recovering", "cancelled"],
  executing: [
    "reviewing",
    "dispatched",
    "blocked",
    "refused",
    "timed_out",
    "cancelled",
    "recovering",
  ],
  reviewing: [
    "done",
    "blocked",
    "refused",
    "timed_out",
    "cancelled",
    "recovering",
  ],
  recovering: ["planning", "dispatched", "refused", "released"],
  blocked: ["released", "recovering"],
  timed_out: ["released", "recovering"],
  cancelled: ["released", "recovering"],
  refused: ["released", "recovering"],
  done: ["released", "recovering"],
  released: [],
};

/**
 * Throws when `from` -> `to` is not a legal transition. The orchestrator
 * calls this for every state change, so an illegal move cannot be recorded.
 */
export function assertTransition(
  from: OrchestrationState,
  to: OrchestrationState,
): void {
  if (!ORCHESTRATION_TRANSITIONS[from].includes(to)) {
    throw new Error(`illegal orchestration transition: ${from} -> ${to}`);
  }
}
