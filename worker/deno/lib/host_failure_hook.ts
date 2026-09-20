/**
 * The host-side `callbacks.host_failure` hook (Issue #2107, parent #2088).
 *
 * A host-level failure — the launcher crash-looping, the checkout update
 * failing run after run — happens *before* any issue is claimed and before a
 * container exists, so none of the post-run hooks can report it. This module
 * is that report: the same contract the post-run callbacks use (a versioned
 * JSON document at `VIBECODER_CALLBACK_CONTEXT`, scalar `VIBECODER_*` facts,
 * a cleared environment, a bounded spawn), fired from the host.
 *
 * ```mermaid
 * flowchart LR
 *     F["Host failure persists"] --> R["readHostFailureHook(.config.json)"]
 *     R -- none --> N["Nothing to run"]
 *     R -- invalid --> E["config_invalid — reported, never repaired"]
 *     R -- hook --> I["invokeHostFailureHook"]
 *     I --> O["CallbackInvocation — ok / failed / timed_out / spawn_failed"]
 * ```
 *
 * ## Boundaries this module holds
 *
 * - **A targeted read.** The host validates `callbacks.host_failure` and
 *   `callbacks.timeout_seconds` only. A `success` hook naming a path that
 *   exists only inside the container is correct configuration, and must not
 *   stop the host hook from firing.
 * - **Never throws.** A missing, unreadable or malformed config file is
 *   reported as `none` or `invalid`; an un-spawnable hook is recorded as
 *   `spawn_failed`. The failure being escalated is not made worse by the
 *   escalation.
 * - **A host path.** Unlike every other callback key, this one is resolved on
 *   the host's own filesystem — see `run_callbacks_config.ts`.
 * - **Scalars in the environment, multi-line facts in the document.** The log
 *   tail and the free-text detail live only in the JSON document; the
 *   environment carries one-line facts, as the rest of the contract does.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  CALLBACK_SCHEMA_VERSION,
  type CallbackInvocation,
  INHERITED_ENV_VARS,
  invokeCallback,
  type InvokeCallbackSeams,
} from "./run_callbacks.ts";
import { parseHostFailureCallback } from "./run_callbacks_config.ts";
import {
  type WorkerBuildFacts,
  workerBuildFacts,
} from "./worker_build_info.ts";

/** Which host-level path is failing. */
export type HostFailureCondition = "launcher" | "checkout_update";

/**
 * Whether this is the first report of the streak or a repeat while it
 * persists, and how many reports have been delivered including this one.
 */
export interface HostFailureDelivery {
  kind: "first" | "repeat";
  count: number;
}

/** Checkout facts, when the failing condition is the checkout update. */
export interface HostFailureCheckout {
  branch: string;
  dirtyFiles: number;
}

/**
 * Facts about a persisting host-level failure, handed to the hook.
 *
 * Optional facts the host could not supply are omitted from both the document
 * and the environment rather than emitted empty, so a hook's presence test is
 * truthful.
 */
export interface HostFailurePayload {
  /** Host the failure is on. */
  host: string;
  /** Which host-level path is failing. */
  condition: HostFailureCondition;
  /** Phase within that condition that failed. */
  phase: string;
  /** Consecutive failures of this condition, including this one. */
  consecutiveFailures: number;
  /** Exit status of the most recent attempt, when one was observed. */
  lastExitStatus?: number;
  /** Seconds the host will wait before retrying, when it backs off. */
  backoffSeconds?: number;
  /** ISO-8601 timestamp of the first failure in the streak. */
  streakStartedAt: string;
  /** First report of this streak, or a repeat while it persists. */
  delivery: HostFailureDelivery;
  /** Attempt number that produced this report. */
  attempt: number;
  /** Tail of the failing attempt's output, when captured. */
  logTail?: string;
  /** Free-text diagnosis, when the host has one. */
  detail?: string;
  /** Checkout facts, when the condition is the checkout update. */
  checkout?: HostFailureCheckout;
}

/** What a targeted read of `callbacks.host_failure` found. */
export type HostFailureHookConfig =
  /** No hook is configured — nothing to run, and not a fault. */
  | { kind: "none" }
  /** A validated hook. */
  | { kind: "hook"; path: string; timeoutSeconds: number }
  /** The configuration could not be read or is malformed. */
  | { kind: "invalid"; error: string };

/** Seams for invoking the hook; the timeout comes from the hook itself. */
export type HostFailureHookSeams = Omit<InvokeCallbackSeams, "callbacks">;

/** The event name this module fires under. */
const HOST_FAILURE_EVENT = "host_failure";

/** Read an environment variable, tolerating a denied `--allow-env`. */
function readEnvSafe(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

/** Describe a read fault without leaking a stack trace. */
function faultMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read `callbacks.host_failure` and `callbacks.timeout_seconds` from the
 * host's `.config.json`. Never throws.
 *
 * A missing file, a configuration with no `callbacks` block, and a block
 * without `host_failure` all mean the same thing — no hook — and are reported
 * as `none`. Everything else is a fault the operator must see, and is
 * reported as `invalid` with the message rather than silently answered as
 * "no hook configured".
 */
export async function readHostFailureHook(
  configPath: string,
): Promise<HostFailureHookConfig> {
  let text: string;
  try {
    text = await Deno.readTextFile(configPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "none" };
    return {
      kind: "invalid",
      error: `${configPath} could not be read: ${faultMessage(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      kind: "invalid",
      error: `${configPath} is not valid JSON: ${faultMessage(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      kind: "invalid",
      error: `${configPath} must contain a JSON object`,
    };
  }

  const raw = (parsed as Record<string, unknown>).callbacks;
  if (raw === undefined || raw === null) return { kind: "none" };

  const hook = parseHostFailureCallback(raw);
  if (!hook.ok) return { kind: "invalid", error: hook.error };
  if (hook.value.path === undefined) return { kind: "none" };
  return {
    kind: "hook",
    path: hook.value.path,
    timeoutSeconds: hook.value.timeoutSeconds,
  };
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
 * The versioned JSON document handed to the hook.
 *
 * Additive against the post-run contract: `schemaVersion` stays at
 * {@link CALLBACK_SCHEMA_VERSION}, because a new event is not a breaking
 * change to the fields an existing hook already reads.
 */
export function buildHostFailureDocument(
  payload: HostFailurePayload,
  facts: WorkerBuildFacts = workerBuildFacts(),
): Record<string, unknown> {
  const document: Record<string, unknown> = {
    schemaVersion: CALLBACK_SCHEMA_VERSION,
    event: HOST_FAILURE_EVENT,
    host: payload.host,
    condition: payload.condition,
    phase: payload.phase,
    consecutiveFailures: payload.consecutiveFailures,
    streakStartedAt: payload.streakStartedAt,
    delivery: payload.delivery,
    attempt: payload.attempt,
  };
  if (payload.lastExitStatus !== undefined) {
    document.lastExitStatus = payload.lastExitStatus;
  }
  if (payload.backoffSeconds !== undefined) {
    document.backoffSeconds = payload.backoffSeconds;
  }
  if (payload.logTail !== undefined) document.logTail = payload.logTail;
  if (payload.detail !== undefined) document.detail = payload.detail;
  if (payload.checkout !== undefined) document.checkout = payload.checkout;
  // Issue #2444: additive, omitted rather than guessed when unreadable.
  if (facts.version !== undefined) document.workerVersion = facts.version;
  if (facts.commit !== undefined) document.workerCommit = facts.commit;
  return document;
}

/**
 * The `VIBECODER_*` environment the hook receives, plus the inherited
 * minimum.
 *
 * Scalars only. The multi-line facts — `logTail`, `detail` — live in the
 * document alone, where a hook reads them without an environment-size limit
 * turning them into a spawn failure.
 */
export function buildHostFailureEnv(
  payload: HostFailurePayload,
  contextFilePath: string,
  readEnv: (name: string) => string | undefined = readEnvSafe,
  facts: WorkerBuildFacts = workerBuildFacts(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV_VARS) {
    const value = readEnv(name);
    if (value !== undefined) env[name] = value;
  }
  put(env, "VIBECODER_CALLBACK_SCHEMA_VERSION", CALLBACK_SCHEMA_VERSION);
  put(env, "VIBECODER_CALLBACK_EVENT", HOST_FAILURE_EVENT);
  put(env, "VIBECODER_CALLBACK_CONTEXT", contextFilePath);
  put(env, "VIBECODER_HOST", payload.host);
  put(env, "VIBECODER_HOST_FAILURE_CONDITION", payload.condition);
  put(env, "VIBECODER_HOST_FAILURE_PHASE", payload.phase);
  put(env, "VIBECODER_CONSECUTIVE_FAILURES", payload.consecutiveFailures);
  put(env, "VIBECODER_LAST_EXIT_STATUS", payload.lastExitStatus);
  put(env, "VIBECODER_BACKOFF_SECONDS", payload.backoffSeconds);
  put(env, "VIBECODER_STREAK_STARTED_AT", payload.streakStartedAt);
  put(env, "VIBECODER_DELIVERY_KIND", payload.delivery.kind);
  put(env, "VIBECODER_DELIVERY_COUNT", payload.delivery.count);
  put(env, "VIBECODER_ATTEMPT", payload.attempt);
  // Issue #2444: omitted rather than guessed when the build could not be read.
  put(env, "VIBECODER_WORKER_VERSION", facts.version);
  put(env, "VIBECODER_WORKER_COMMIT", facts.commit);
  return env;
}

/**
 * Run the host-failure hook once, capturing everything it produced.
 *
 * Never throws: the hook's own fault is recorded as `failed`, `timed_out` or
 * `spawn_failed` and returned, so the host reports it rather than losing the
 * failure it was escalating.
 */
export function invokeHostFailureHook(
  payload: HostFailurePayload,
  hook: { path: string; timeoutSeconds: number },
  seams: HostFailureHookSeams,
): Promise<CallbackInvocation> {
  return invokeCallback(
    HOST_FAILURE_EVENT,
    hook.path,
    buildHostFailureDocument(payload),
    buildHostFailureEnv(payload, "", seams.readEnv),
    { ...seams, callbacks: { timeoutSeconds: hook.timeoutSeconds } },
  );
}
