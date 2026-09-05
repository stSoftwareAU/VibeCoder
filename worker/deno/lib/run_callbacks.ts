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

import {
  type CallbackEvent,
  type CallbacksConfig,
  hasAnyCallback,
} from "./run_callbacks_config.ts";
import { runWithTimeout } from "./subprocess_timeout.ts";
import { redactSecrets } from "./secret_redaction.ts";

/**
 * Version of the callback context document and environment contract.
 *
 * Bump when a field's meaning changes or a field is removed, so an extension
 * can refuse a contract it does not understand rather than misreading it.
 */
export const CALLBACK_SCHEMA_VERSION = 1;

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

/** Injectable seams so the runner is testable without real processes. */
export interface InvokeRunCallbacksOptions {
  callbacks: CallbacksConfig;
  context: IssueRunCallbackContext;
  /** Informational sink (invocation start and successful completion). */
  log: (message: string) => void;
  /** Fault sink — a hook that failed, timed out or could not be spawned. */
  logError: (message: string) => void;
  /** Subprocess runner. Defaults to {@link runWithTimeout}. */
  run?: typeof runWithTimeout;
  /** Environment reader. Defaults to a permission-tolerant `Deno.env.get`. */
  readEnv?: (name: string) => string | undefined;
  /** Monotonic clock for durations. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Context-file writer. Returns the absolute path written and a disposer.
   * Defaults to a 0600 temp file removed after the hook exits.
   */
  writeContextFile?: (
    document: Record<string, unknown>,
  ) => Promise<{ path: string; cleanup: (warn: Warn) => Promise<void> }>;
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
  if (context.telemetry !== undefined) document.telemetry = context.telemetry;
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
  options: InvokeRunCallbacksOptions,
): Promise<CallbackInvocation> {
  const run = options.run ?? runWithTimeout;
  const now = options.now ?? Date.now;
  const writeContextFile = options.writeContextFile ?? writeTempContextFile;
  const startedMs = now();

  let cleanup: ((warn: Warn) => Promise<void>) | undefined;
  try {
    const file = await writeContextFile(
      buildCallbackContextDocument(options.context, event),
    );
    cleanup = file.cleanup;
    // No shell, no arguments: the executable is spawned directly, so no
    // untrusted issue or repository text can be parsed as a command.
    const result = await run(path, [], {
      timeoutMs: options.callbacks.timeoutSeconds * 1000,
      // A hook that hung is exactly the one whose output matters, so what it
      // printed before the kill is captured rather than discarded.
      captureOutputOnTimeout: true,
      env: buildCallbackEnv(
        options.context,
        event,
        file.path,
        options.readEnv ?? readEnvSafe,
      ),
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
    // Writing the context file, or the runner itself, faulted. Reported as a
    // hook fault — never propagated, so the run's own outcome is unaffected.
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

/** Log an invocation at the level its status deserves. */
function reportInvocation(
  invocation: CallbackInvocation,
  options: InvokeRunCallbacksOptions,
): void {
  const detail = describeInvocation(invocation);
  const streams = [
    invocation.stdout ? `stdout: ${invocation.stdout}` : "",
    invocation.stderr ? `stderr: ${invocation.stderr}` : "",
  ].filter((part) => part !== "").join("\n");
  const full = streams ? `${detail}\n${streams}` : detail;
  if (invocation.status === "ok") {
    options.log(full);
  } else {
    // Loud, and explicitly non-masking: the run's own result is untouched.
    options.logError(
      `${full}\nThe original VibeCoder result (${options.context.result}) is unchanged.`,
    );
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
  if (!hasAnyCallback(callbacks)) return [];

  const invocations: CallbackInvocation[] = [];
  for (const event of [context.result, "always"] as const) {
    const path = callbacks[event];
    if (path === undefined) continue;
    options.log(
      `Running ${event} callback for ${context.repository}#${context.issueNumber}: ${path}`,
    );
    const invocation = await invokeOne(event, path, options);
    invocations.push(invocation);
    reportInvocation(invocation, options);
  }
  return invocations;
}
