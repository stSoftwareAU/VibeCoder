/** Per-run invocation attribution, isolated between concurrent slots (Issue #3719). */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Result } from "../types.ts";
import type { RunClaudeOptions } from "./claude_runner.ts";
import type { RunStats } from "./run_stats.ts";
import { breakdownInvocationTelemetry } from "./run_callback_telemetry.ts";
import {
  appendLifecycleEvent,
  buildLifecycleEvent,
  lifecycleLedgerPath,
  type LifecycleRole,
} from "./lifecycle_ledger.ts";
import { getHostname } from "./worker_identity.ts";
import { generateRunId } from "./run_id.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Worker-owned identity and IO for one run, never process-global mutable attribution. */
export interface LifecycleRecordingContext {
  ledgerPath: string;
  runId: string;
  host: string;
  repo: string;
  issueNumber?: number;
  now?: () => number;
}
interface RecordingState {
  context: LifecycleRecordingContext;
  assignmentId?: string;
  index: number;
}
const recording = new AsyncLocalStorage<RecordingState>();

/** Production identity; tests supply an explicit context and temporary ledger. */
export function lifecycleRecordingContext(
  workDir: string,
  repo: string,
  issueNumber?: number,
  runId = generateRunId(),
): LifecycleRecordingContext {
  const host = getHostname();
  return {
    ledgerPath: lifecycleLedgerPath(workDir, host),
    host,
    repo,
    issueNumber,
    runId,
  };
}

/** Give the async run its own invocation counter and assignment. */
export function withLifecycleRecording<T>(
  context: LifecycleRecordingContext,
  fn: () => Promise<T>,
): Promise<T> {
  return recording.run({ context, index: 0 }, fn);
}

/** The current claim's ID also stamps its assignment event. */
export function currentLifecycleRunId(): string | undefined {
  return recording.getStore()?.context.runId;
}

/** Activate after assignment resolution; "unknown" preserves usage after a recording failure. */
export function activateLifecycleAssignment(assignmentId: string): void {
  const state = recording.getStore();
  if (state) state.assignmentId = assignmentId;
}

interface InvocationResult {
  exitCode: number;
  timedOut: boolean;
  provider?: string;
  usageLimit?: unknown;
  agentFailure?: { category: string };
  runStats?: RunStats;
}

/**
 * Wrap the single-spawn runner, below its retry ladder. No output, prompt or
 * exception text is copied into the ledger. Recording failures are logged;
 * an agent failure is never replaced with a telemetry failure.
 */
export async function withLifecycleInvocation<T extends InvocationResult>(
  options: Pick<
    RunClaudeOptions,
    "phase" | "logger" | "model" | "lifecycleRole"
  >,
  invoke: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const state = recording.getStore();
  if (!state?.assignmentId) return await invoke();
  const { context, assignmentId } = state;
  const index = ++state.index;
  const now = context.now ?? Date.now;
  const started = now();
  let result: Result<T> | undefined;
  try {
    result = await invoke();
    return result;
  } finally {
    const value = result?.ok ? result.value : undefined;
    const stats = value?.runStats;
    const role: LifecycleRole = options.lifecycleRole ?? "manager";
    const provider = value?.provider ?? stats?.provider ?? "unknown";
    try {
      const telemetry = breakdownInvocationTelemetry(
        { runStats: stats },
        role,
        provider,
      );
      const requestedModel = stats?.requestedModel ?? options.model;
      const servedModel = stats?.servedModels[0];
      await appendLifecycleEvent(
        context.ledgerPath,
        buildLifecycleEvent({
          kind: "invocation",
          assignmentId,
          runId: context.runId,
          host: context.host,
          repo: context.repo,
          issueNumber: context.issueNumber,
          recordedAt: new Date(now()).toISOString(),
          invocationIndex: index,
          attempt: index,
          role,
          provider,
          ...(requestedModel ? { requestedModel } : {}),
          ...(servedModel ? { servedModel } : {}),
          ...(stats?.effort ? { effort: stats.effort } : {}),
          durationSeconds:
            (stats?.wallClockMs ?? Math.max(0, now() - started)) / 1000,
          quotaStatus: value?.usageLimit ||
              value?.agentFailure?.category === "quota-exhausted" ||
              value?.agentFailure?.category === "rate-limit"
            ? "limited"
            : "unknown",
          result: value?.timedOut
            ? "timeout"
            : value?.exitCode === 0
            ? "success"
            : "failure",
          ...telemetry,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail =
        `Lifecycle invocation recording failed for ${context.repo}#${
          context.issueNumber ?? "unknown"
        }: ${redactSecrets(message)}`;
      if (options.logger) options.logger.error(detail);
      else console.error(detail);
    }
  }
}
