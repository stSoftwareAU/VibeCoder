/**
 * Post-run callbacks — the public extension contract (Issue #806, parent #796).
 *
 * The `success / failure / always` semantics familiar from CI pipeline
 * post-build blocks, applied to one terminal issue run:
 *
 * ```mermaid
 * flowchart LR
 *     R["Issue run terminates"] --> D{result}
 *     D -- success --> S["callbacks.success"]
 *     D -- failure --> F["callbacks.failure"]
 *     S --> A["callbacks.always"]
 *     F --> A
 *     A --> O["Original VibeCoder outcome — unchanged"]
 * ```
 *
 * ## Boundaries this module holds
 *
 * - **Direct execution.** The configured path is spawned directly. No shell,
 *   no `sh -c`, no argument interpolation, so no issue or repository text can
 *   ever be parsed as a command.
 * - **A hook never rewrites the outcome.** Every invocation is captured and
 *   reported; nothing here throws, and the caller's `RunOutcome` is untouched.
 * - **`always` runs regardless.** A failed, timed-out or un-spawnable outcome
 *   hook does not skip it.
 * - **No credentials in the environment.** The child starts from an empty
 *   environment: only {@link INHERITED_ENV_VARS} and the documented
 *   `VIBECODER_*` context reach it. Prompt bodies and transcript contents are
 *   never exported — the transcript is passed as a *path*, and reading it is
 *   the callback author's decision.
 * - **Bounded everywhere.** Wall-clock per hook comes from
 *   `callbacks.timeout_seconds`; captured stdout/stderr are truncated to
 *   {@link MAX_CAPTURED_OUTPUT_CHARS} and routed through `redactSecrets()`
 *   before they are logged.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { FailureCategory } from "./failure_diagnosis.ts";
import type { RunOutcome } from "./run_outcome.ts";
import {
  type CallbackEvent,
  type CallbacksConfig,
  hasAnyRunCallback,
  hasCycleCallback,
} from "./run_callbacks_config.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";
import { redactSecrets } from "./secret_redaction.ts";

/**
 * Version of the callback context document and environment contract.
 *
 * **The contract is additive; this number is not a changelog.** Adding a
 * field, a value or an event never bumps it — a hook written against an
 * older version keeps reading every field it knows. Bump it only when a
 * field is removed or its meaning changes, and treat that as the fleet-wide
 * breaking change it is: every deployed extension refuses the new version
 * until a human reinstalls it on every host. On 2026-09-11 the 1 → 2 bump was
 * made for an additive change and every callback on every host failed on
 * every issue until each host was reinstalled by hand (Issues #2039, #2041).
 * `callback_schema_compat_test.ts` pins the fields schema 1 promised, and
 * `docs/CALLBACKS.md` ("Versioning") is the operator-facing rule.
 */
export const CALLBACK_SCHEMA_VERSION = 2;

/** Longest stdout/stderr excerpt captured and logged per stream. */
export const MAX_CAPTURED_OUTPUT_CHARS = 4000;

/**
 * Environment variables inherited from the worker. Deliberately tiny: enough
 * for a portable shell hook to find its interpreter and home directory, and
 * nothing that could carry a credential.
 */
export const INHERITED_ENV_VARS: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "TMPDIR",
];

/** Token and cost telemetry for the run, when the providers reported it. */
export interface CallbackRunTelemetry {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** Estimated spend in USD; absent when no model had a pricing row. */
  estimatedCostUsd?: number;
}

/**
 * Facts about one terminal issue run, handed to every hook it triggers.
 *
 * Optional fields are omitted from the context document and the environment
 * when the run could not supply them — an extension tests for presence rather
 * than reading an empty string that might mean "none" or "unknown".
 */
export interface IssueRunCallbackContext {
  /** Canonical worker run id (`VIBE_RUN_ID`). */
  runId: string;
  /** The original VibeCoder result. Never altered by a hook. */
  result: "success" | "failure";
  /** `owner/repo` the run worked. */
  repository: string;
  /** Issue number the run worked. */
  issueNumber: number;
  /** Host the worker runs on. */
  host: string;
  /** Operator-configured worker name, when set. */
  workerName?: string;
  /** Agent provider that served the run, when known. */
  provider?: string;
  /** Agent session id, when the run had one. */
  sessionId?: string;
  /** Absolute path to this run's session transcript/log, when one exists. */
  sessionLogPath?: string;
  /** ISO-8601 timestamp the run was claimed. */
  startedAt: string;
  /** ISO-8601 timestamp the run terminated. */
  finishedAt: string;
  /** Wall-clock seconds from claim to termination. */
  durationSeconds: number;
  /** Original exit code of the run: 0 on success, non-zero on failure. */
  exitCode: number;
  /** Token and cost telemetry, when available. */
  telemetry?: CallbackRunTelemetry;
  /**
   * Structured run outcome (Issue #1947). Present when the worker computed
   * one; omitted members stay omitted, same as the rest of the context.
   */
  outcome?: CallbackRunOutcome;
  /**
   * Why `telemetry` is absent (Issue #1948). Present exactly when
   * `telemetry` is not.
   */
  telemetryAbsentReason?: TelemetryAbsentReason;
  /**
   * Why `sessionLogPath` is absent (Issue #1948). Present exactly when
   * `sessionLogPath` is not.
   */
  sessionLogAbsentReason?: SessionLogAbsentReason;
}

/**
 * The structured outcome a fleet archive can count without reading a
 * transcript (Issue #1947).
 */
export interface CallbackRunOutcome {
  kind: RunOutcome["kind"];
  /** {@link FailureCategory} when `kind` is `no_pr`. */
  category?: FailureCategory;
  /** Phase that terminated the run. */
  phase?: string;
  /** Classifier slug when one was computed for a no-PR run. */
  failureClass?: string;
  /** PR number when a PR exists, including a later-step failure. */
  prNumber?: number;
}

/** Why the callback context carries no token/cost telemetry (Issue #1948). */
export type TelemetryAbsentReason =
  | "agent_not_invoked"
  | "usage_not_reported"
  | "provider_unsupported";

/** Why the callback context carries no session transcript path (Issue #1948). */
export type SessionLogAbsentReason =
  | "tee_disabled"
  | "log_dir_unavailable"
  | "size_cap_exceeded"
  | "write_failed"
  | "file_missing";

/** Why a scan cycle ended, for the per-cycle heartbeat (Issue #1955). */
export type CycleEndReason =
  | "no_eligible_work"
  | "quota_paused"
  | "rate_limited"
  | "shutdown"
  | "error";

/**
 * Fleet-summary counters for one scan cycle (Issue #1955).
 *
 * Deltas against the process-wide accumulators, so a quiet cycle reads as
 * zeros rather than as the run's lifetime totals.
 */
export interface CycleFleetSummary {
  claims: number;
  successes: number;
  failures: number;
  skips: number;
  idleSeconds: number;
  occupiedSeconds: number;
  rateLimitedSeconds: number;
  tokenBlockedSeconds: number;
}

/**
 * Facts about one finished scan cycle, handed to `callbacks.cycle`.
 *
 * A launcher that never reaches the scan loop emits nothing — silence from
 * this hook means the host never entered the loop, not that it was idle.
 */
export interface CycleCallbackContext {
  runId: string;
  host: string;
  workerName?: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  issuesScanned: number;
  claimsAttempted: number;
  claimsTaken: number;
  endReason: CycleEndReason;
  fleetSummary: CycleFleetSummary;
}

/**
 * Cycle-local facts the scan loop reports to the callback layer
 * (Issue #1955). Production wiring adds host / run-id identity.
 */
export interface TerminalScanCycle {
  startedAtEpochMs: number;
  finishedAtEpochMs: number;
  issuesScanned: number;
  claimsAttempted: number;
  claimsTaken: number;
  endReason: CycleEndReason;
  fleetSummary: CycleFleetSummary;
}

/**
 * One terminal issue run, as the scan loop reports it to the callback layer
 * (Issue #806).
 *
 * The loop knows the claim, the result and the wall-clock bounds; the
 * production wiring turns those into an {@link IssueRunCallbackContext} by
 * adding the host, provider, session and telemetry facts it can resolve.
 */
export interface TerminalIssueRun {
  /** `owner/repo` the run worked. */
  repo: string;
  /** Issue number the run worked. */
  issueNumber: number;
  /** The original VibeCoder result. A hook never changes it. */
  result: "success" | "failure";
  /** Epoch ms the claim was taken. */
  startedAtEpochMs: number;
  /** Epoch ms the run terminated. */
  finishedAtEpochMs: number;
  /** Token and cost telemetry, when the run's invocations reported it. */
  telemetry?: CallbackRunTelemetry;
  /** What the run achieved, when the worker computed a {@link RunOutcome}. */
  outcome?: RunOutcome;
  /** Terminating phase name, when known (setup, execute, completion, …). */
  phase?: string;
  /**
   * Why telemetry is absent, when the run invoked no agent or the
   * provider reported no usage (Issue #1948).
   */
  telemetryAbsentReason?: TelemetryAbsentReason;
}

/** What became of one hook invocation. */
export type CallbackStatus =
  /** Exited 0. */
  | "ok"
  /** Exited non-zero. */
  | "failed"
  /** Exceeded `callbacks.timeout_seconds` and was terminated. */
  | "timed_out"
  /** Could not be spawned at all (missing file, not executable). */
  | "spawn_failed";

/** Record of one hook invocation, in the order it ran. */
export interface CallbackInvocation {
  event: CallbackEvent;
  path: string;
  status: CallbackStatus;
  /** Process exit code; 124 on timeout, -1 when the spawn itself failed. */
  exitCode: number;
  /** Redacted, truncated stdout. */
  stdout: string;
  /** Redacted, truncated stderr. */
  stderr: string;
  durationMs: number;
}

/** Shared seams for spawning a hook. */
export interface InvokeCallbackSeams {
  callbacks: CallbacksConfig;
  log: (message: string) => void;
  logError: (message: string) => void;
  run?: typeof runWithTimeout;
  readEnv?: (name: string) => string | undefined;
  now?: () => number;
  writeContextFile?: (
    document: Record<string, unknown>,
  ) => Promise<{ path: string; cleanup: (warn: Warn) => Promise<void> }>;
}

/** Injectable seams so the runner is testable without real processes. */
export interface InvokeRunCallbacksOptions extends InvokeCallbackSeams {
  context: IssueRunCallbackContext;
}

/** Injectable seams for the per-cycle heartbeat (Issue #1955). */
export interface InvokeCycleCallbackOptions extends InvokeCallbackSeams {
  context: CycleCallbackContext;
}

/** Sink for a fault that is worth saying out loud but must not stop a hook. */
type Warn = (message: string) => void;

/** Read an environment variable, tolerating a denied `--allow-env`. */
function readEnvSafe(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/**
 * The versioned JSON document handed to a hook.
 *
 * Optional facts are omitted rather than emitted empty, so `sessionId in ctx`
 * is a truthful test of "this run had a session".
 */
export function buildCallbackContextDocument(
  context: IssueRunCallbackContext,
  event: CallbackEvent,
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    schemaVersion: CALLBACK_SCHEMA_VERSION,
    event,
    runId: context.runId,
    result: context.result,
    repository: context.repository,
    issueNumber: context.issueNumber,
    host: context.host,
    startedAt: context.startedAt,
    finishedAt: context.finishedAt,
    durationSeconds: context.durationSeconds,
    exitCode: context.exitCode,
  };
  if (context.workerName !== undefined) {
    document.workerName = context.workerName;
  }
  if (context.provider !== undefined) document.provider = context.provider;
  if (context.sessionId !== undefined) document.sessionId = context.sessionId;
  if (context.sessionLogPath !== undefined) {
    document.sessionLogPath = context.sessionLogPath;
  }
  if (context.sessionLogAbsentReason !== undefined) {
    document.sessionLogAbsentReason = context.sessionLogAbsentReason;
  }
  if (context.telemetry !== undefined) document.telemetry = context.telemetry;
  if (context.telemetryAbsentReason !== undefined) {
    document.telemetryAbsentReason = context.telemetryAbsentReason;
  }
  if (context.outcome !== undefined) document.outcome = context.outcome;
  return document;
}

/** The versioned JSON document handed to a cycle hook (Issue #1955). */
export function buildCycleCallbackDocument(
  context: CycleCallbackContext,
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    schemaVersion: CALLBACK_SCHEMA_VERSION,
    event: "cycle",
    runId: context.runId,
    host: context.host,
    startedAt: context.startedAt,
    finishedAt: context.finishedAt,
    durationSeconds: context.durationSeconds,
    issuesScanned: context.issuesScanned,
    claimsAttempted: context.claimsAttempted,
    claimsTaken: context.claimsTaken,
    endReason: context.endReason,
    fleetSummary: context.fleetSummary,
  };
  if (context.workerName !== undefined) {
    document.workerName = context.workerName;
  }
  return document;
}

/** Add an entry only when the value is present. */
function put(
  env: Record<string, string>,
  name: string,
  value: string | number | undefined,
): void {
  if (value === undefined) return;
  env[name] = String(value);
}

/**
 * The `VIBECODER_*` environment a hook receives, plus the inherited minimum.
 *
 * Scalars only: no credential, prompt body or transcript content is ever
 * exported. `VIBECODER_CALLBACK_CONTEXT` names the JSON document instead.
 */
export function buildCallbackEnv(
  context: IssueRunCallbackContext,
  event: CallbackEvent,
  contextFilePath: string,
  readEnv: (name: string) => string | undefined = readEnvSafe,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV_VARS) {
    const value = readEnv(name);
    if (value !== undefined) env[name] = value;
  }
  put(env, "VIBECODER_CALLBACK_SCHEMA_VERSION", CALLBACK_SCHEMA_VERSION);
  put(env, "VIBECODER_CALLBACK_EVENT", event);
  put(env, "VIBECODER_CALLBACK_CONTEXT", contextFilePath);
  put(env, "VIBECODER_RUN_ID", context.runId);
  put(env, "VIBECODER_RESULT", context.result);
  put(env, "VIBECODER_REPOSITORY", context.repository);
  put(env, "VIBECODER_ISSUE_NUMBER", context.issueNumber);
  put(env, "VIBECODER_HOST", context.host);
  put(env, "VIBECODER_WORKER_NAME", context.workerName);
  put(env, "VIBECODER_PROVIDER", context.provider);
  put(env, "VIBECODER_SESSION_ID", context.sessionId);
  put(env, "VIBECODER_SESSION_LOG_PATH", context.sessionLogPath);
  put(
    env,
    "VIBECODER_SESSION_LOG_ABSENT_REASON",
    context.sessionLogAbsentReason,
  );
  put(env, "VIBECODER_STARTED_AT", context.startedAt);
  put(env, "VIBECODER_FINISHED_AT", context.finishedAt);
  put(env, "VIBECODER_DURATION_SECONDS", context.durationSeconds);
  put(env, "VIBECODER_EXIT_CODE", context.exitCode);
  put(env, "VIBECODER_INPUT_TOKENS", context.telemetry?.inputTokens);
  put(env, "VIBECODER_OUTPUT_TOKENS", context.telemetry?.outputTokens);
  put(
    env,
    "VIBECODER_CACHE_CREATION_TOKENS",
    context.telemetry?.cacheCreationTokens,
  );
  put(env, "VIBECODER_CACHE_READ_TOKENS", context.telemetry?.cacheReadTokens);
  put(env, "VIBECODER_ESTIMATED_COST_USD", context.telemetry?.estimatedCostUsd);
  put(
    env,
    "VIBECODER_TELEMETRY_ABSENT_REASON",
    context.telemetryAbsentReason,
  );
  put(env, "VIBECODER_OUTCOME_KIND", context.outcome?.kind);
  put(env, "VIBECODER_OUTCOME_CATEGORY", context.outcome?.category);
  put(env, "VIBECODER_OUTCOME_PHASE", context.outcome?.phase);
  put(env, "VIBECODER_OUTCOME_FAILURE_CLASS", context.outcome?.failureClass);
  put(env, "VIBECODER_PR_NUMBER", context.outcome?.prNumber);
  return env;
}

/**
 * The `VIBECODER_*` environment a cycle hook receives (Issue #1955).
 *
 * Run-only scalars (`RESULT`, `REPOSITORY`, `ISSUE_NUMBER`, …) are omitted
 * so a cycle hook cannot be mistaken for a run hook.
 */
export function buildCycleCallbackEnv(
  context: CycleCallbackContext,
  contextFilePath: string,
  readEnv: (name: string) => string | undefined = readEnvSafe,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV_VARS) {
    const value = readEnv(name);
    if (value !== undefined) env[name] = value;
  }
  put(env, "VIBECODER_CALLBACK_SCHEMA_VERSION", CALLBACK_SCHEMA_VERSION);
  put(env, "VIBECODER_CALLBACK_EVENT", "cycle");
  put(env, "VIBECODER_CALLBACK_CONTEXT", contextFilePath);
  put(env, "VIBECODER_RUN_ID", context.runId);
  put(env, "VIBECODER_HOST", context.host);
  put(env, "VIBECODER_WORKER_NAME", context.workerName);
  put(env, "VIBECODER_STARTED_AT", context.startedAt);
  put(env, "VIBECODER_FINISHED_AT", context.finishedAt);
  put(env, "VIBECODER_DURATION_SECONDS", context.durationSeconds);
  put(env, "VIBECODER_ISSUES_SCANNED", context.issuesScanned);
  put(env, "VIBECODER_CLAIMS_ATTEMPTED", context.claimsAttempted);
  put(env, "VIBECODER_CLAIMS_TAKEN", context.claimsTaken);
  put(env, "VIBECODER_CYCLE_END_REASON", context.endReason);
  return env;
}

/** Redact then bound one captured stream. */
function captureStream(raw: string): string {
  const redacted = redactSecrets(raw);
  return redacted.length > MAX_CAPTURED_OUTPUT_CHARS
    ? `${redacted.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}… [truncated]`
    : redacted;
}

/** Default context-file writer: a 0600 temp file, removed after the hook. */
async function writeTempContextFile(
  document: Record<string, unknown>,
): Promise<{ path: string; cleanup: (warn: Warn) => Promise<void> }> {
  const path = await Deno.makeTempFile({
    prefix: "vibecoder-callback-",
    suffix: ".json",
  });
  await Deno.writeTextFile(path, `${JSON.stringify(document, null, 2)}\n`);
  return {
    path,
    cleanup: async (warn: Warn) => {
      try {
        await Deno.remove(path);
      } catch (error) {
        // A hook that moved the file leaves nothing to remove; anything else
        // leaks a context file per invocation, so say so rather than let it
        // accumulate unremarked.
        if (error instanceof Deno.errors.NotFound) return;
        warn(
          `Callback context file ${path} could not be removed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}

/** One-line summary of an invocation for the worker log. */
export function describeInvocation(invocation: CallbackInvocation): string {
  const seconds = (invocation.durationMs / 1000).toFixed(1);
  return `callback ${invocation.event} (${invocation.path}) ${invocation.status}` +
    ` — exit ${invocation.exitCode}, ${seconds}s`;
}

/** Run one hook, capturing everything it produced. Never throws. */
async function invokeOne(
  event: CallbackEvent,
  path: string,
  document: Record<string, unknown>,
  env: Record<string, string>,
  options: InvokeCallbackSeams,
): Promise<CallbackInvocation> {
  const run = options.run ?? runWithTimeout;
  const now = options.now ?? Date.now;
  const writeContextFile = options.writeContextFile ?? writeTempContextFile;
  const startedMs = now();

  let cleanup: ((warn: Warn) => Promise<void>) | undefined;
  try {
    const file = await writeContextFile(document);
    cleanup = file.cleanup;
    env.VIBECODER_CALLBACK_CONTEXT = file.path;
    const result = await run(path, [], {
      timeoutMs: options.callbacks.timeoutSeconds * 1000,
      captureOutputOnTimeout: true,
      env,
      clearEnv: true,
    });
    const durationMs = now() - startedMs;

    if (!result.ok) {
      return {
        event,
        path,
        status: "spawn_failed",
        exitCode: -1,
        stdout: "",
        stderr: captureStream(result.error.message),
        durationMs,
      };
    }
    const { success, code, stdout, stderr, timedOut } = result.value;
    return {
      event,
      path,
      status: timedOut ? "timed_out" : success ? "ok" : "failed",
      exitCode: code,
      stdout: captureStream(stdout),
      stderr: captureStream(stderr),
      durationMs,
    };
  } catch (error) {
    return {
      event,
      path,
      status: "spawn_failed",
      exitCode: -1,
      stdout: "",
      stderr: captureStream(
        error instanceof Error ? error.message : String(error),
      ),
      durationMs: now() - startedMs,
    };
  } finally {
    if (cleanup) await cleanup(options.logError);
  }
}

function reportInvocation(
  invocation: CallbackInvocation,
  log: (message: string) => void,
  logError: (message: string) => void,
  unchangedNote: string,
): void {
  const detail = describeInvocation(invocation);
  const streams = [
    invocation.stdout ? `stdout: ${invocation.stdout}` : "",
    invocation.stderr ? `stderr: ${invocation.stderr}` : "",
  ].filter((part) => part !== "").join("\n");
  const full = streams ? `${detail}\n${streams}` : detail;
  if (invocation.status === "ok") {
    log(full);
  } else {
    logError(`${full}\n${unchangedNote}`);
  }
}

/**
 * Run the callbacks for one terminal issue run: the outcome hook matching
 * `context.result`, then `always`.
 *
 * A hook that is not configured is a no-op and produces no record, so the
 * returned array is exactly the hooks that ran, in the order they ran. The
 * `always` hook runs even when the outcome hook failed, timed out or could
 * not be spawned.
 *
 * Never throws: a callback fault is reported, never propagated.
 */
export async function invokeRunCallbacks(
  options: InvokeRunCallbacksOptions,
): Promise<CallbackInvocation[]> {
  const { callbacks, context } = options;
  if (!hasAnyRunCallback(callbacks)) return [];

  const invocations: CallbackInvocation[] = [];
  for (const event of [context.result, "always"] as const) {
    const path = callbacks[event];
    if (path === undefined) continue;
    options.log(
      `Running ${event} callback for ${context.repository}#${context.issueNumber}: ${path}`,
    );
    const invocation = await invokeOne(
      event,
      path,
      buildCallbackContextDocument(context, event),
      buildCallbackEnv(context, event, "", options.readEnv ?? readEnvSafe),
      options,
    );
    invocations.push(invocation);
    reportInvocation(
      invocation,
      options.log,
      options.logError,
      `The original VibeCoder result (${context.result}) is unchanged.`,
    );
  }
  return invocations;
}

/**
 * Run the per-cycle heartbeat hook once (Issue #1955).
 *
 * Never throws: a hook fault is reported, never propagated. A configuration
 * without `callbacks.cycle` is a no-op. Run hooks are not invoked.
 */
export async function invokeCycleCallback(
  options: InvokeCycleCallbackOptions,
): Promise<CallbackInvocation[]> {
  const { callbacks, context } = options;
  if (!hasCycleCallback(callbacks) || callbacks.cycle === undefined) {
    return [];
  }
  const path = callbacks.cycle;
  options.log(
    `Running cycle callback (${context.endReason}) on ${context.host}: ${path}`,
  );
  const invocation = await invokeOne(
    "cycle",
    path,
    buildCycleCallbackDocument(context),
    buildCycleCallbackEnv(context, "", options.readEnv ?? readEnvSafe),
    options,
  );
  reportInvocation(
    invocation,
    options.log,
    options.logError,
    "The scan cycle's own outcome is unchanged.",
  );
  return [invocation];
}
