/**
 * The Codex CLI output adapter (Issue #1695, parent #1694).
 *
 * `codex exec --json` writes JSONL, and until now the worker read it with
 * Claude's extractor: no `result` line and no `assistant` blocks, so the whole
 * envelope stream was handed on **as if it were the agent's answer**, and any
 * refusal was classified by whichever Claude prose pattern happened to match.
 * This module decodes the events instead.
 *
 * Two envelope generations are accepted, because a pinned CLI is a moving
 * target and guessing one would break the other:
 *
 * - the experimental top-level schema — `thread.started`, `item.started` /
 *   `item.completed`, `turn.completed`, `turn.failed`, `error`;
 * - the protocol envelope — `{"id":"0","msg":{"type":"agent_message",…}}`,
 *   with `session_configured`, `token_count` and `task_complete`.
 *
 * A field this worker has never seen is not an error: an error event's own
 * object is kept verbatim on {@link AgentStructuredError.raw}, so a consumer
 * can read a new field without the adapter being taught about it first. An
 * event whose *kind* is unrecognised is counted — as progress when it is a
 * recognisable envelope, as a malformed line when it is not — and a line that
 * is not JSON at all (a CLI log line, a truncated final write) is counted the
 * same way. Nothing is dropped in silence.
 *
 * The classification rules that matter most here are the two the issue names:
 * a **401/403 is authentication**, never an unavailable model, and a **429 is
 * a transient rate limit**, never an exhausted subscription. Only a refusal
 * that says the window is spent is `quota-exhausted`, and only then is a
 * scope or a reset reported — an unstated window stays `"unknown"`.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  type AgentDecodedOutput,
  type AgentFailure,
  agentFailure,
  type AgentOutputAdapter,
  type AgentQuota,
  type AgentRunStreams,
  type AgentStructuredError,
  type AgentTerminalStatus,
  type AgentTextSource,
  classifyProcessOutcome,
  detectQuotaScope,
  extractHttpStatus,
  extractRetryAfterSeconds,
  failureMessage,
  isNetworkStatus,
  parseJsonlEvents,
  readNumber,
  readObject,
  readString,
  redactedEvidence,
} from "./agent_output.ts";
import { isCodexAuthError } from "./codex_auth.ts";
// Heap exhaustion is a runtime fact, not a vendor's vocabulary: the one
// predicate is reused rather than a second copy of the same patterns
// (Issue #1695). It lives beside Claude's other detectors for historical
// reasons only.
import { detectOutOfMemory } from "./claude_executor.ts";
import type { TokenUsage } from "./token_usage.ts";

/** The provider id this adapter decodes for. */
const PROVIDER_ID = "codex";

/** Transport failures the CLI reports in prose. */
const NETWORK_RE =
  /overloaded|high demand|econnreset|econnrefused|etimedout|enotfound|socket hang up|stream disconnected|connection (?:reset|refused|closed)/i;

/** A refusal about the model rather than the credential or the window. */
const MODEL_UNAVAILABLE_RE =
  /model_not_found|unknown model|unsupported model|model[^\n]{0,40}(?:does not exist|not found|unavailable|not available|is not supported)|do(?:es)? not have access to it/i;

/** A refusal that says the subscription window itself is spent. */
const QUOTA_RE =
  /usage_limit|usage limit|quota[^\n]{0,20}(?:exhausted|exceeded)|out of credits|plan limit|hit your (?:weekly|monthly|daily)? ?limit/i;

/** A transient limit on the rate of requests. */
const RATE_LIMIT_RE = /rate[_ ]limit|too many requests|\b429\b/i;

/**
 * The CLI refusing the session it was asked to resume.
 *
 * `codex exec resume` names a session Codex must still hold; a rolled or
 * pruned one is refused before any model call, exactly as Claude's session
 * flags are. Anchored to session vocabulary so an unrelated "not found"
 * cannot match.
 */
const INVALID_SESSION_RE =
  /session[_ ](?:not[_ ]found|expired|invalid)|(?:no|unknown|invalid|expired)[^\n]{0,20}session|thread[_ ]not[_ ]found|no (?:previous|recorded) session/i;

/**
 * The event body and its kind, whichever envelope generation carried it.
 *
 * A protocol line nests everything under `msg`; the experimental schema puts
 * it at the top level. Both reduce to "a kind and a body" here, so nothing
 * downstream knows which generation it is reading.
 */
function eventBody(
  value: Record<string, unknown>,
): { kind: string; body: Record<string, unknown> } | undefined {
  const msg = readObject(value.msg);
  if (msg && readString(msg.type)) {
    return { kind: readString(msg.type)!, body: msg };
  }
  const kind = readString(value.type);
  return kind ? { kind, body: value } : undefined;
}

/** An item event's own type, under either of the two field names in use. */
function itemType(item: Record<string, unknown>): string | undefined {
  return readString(item.item_type) ?? readString(item.type);
}

/** Codex's token counts, mapped onto the shared {@link TokenUsage} shape. */
function usageFrom(source: Record<string, unknown>): TokenUsage | undefined {
  const input = readNumber(source.input_tokens);
  const output = readNumber(source.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    // Codex reports cached *input* tokens and has no cache-write counter, so
    // the write count stays 0 rather than being invented from the read.
    cacheCreationTokens: 0,
    cacheReadTokens: readNumber(source.cached_input_tokens) ?? 0,
  };
}

/** A `rate_limits` window from a `token_count` event, when one is present. */
function quotaFrom(
  rateLimits: Record<string, unknown>,
): AgentQuota | undefined {
  const primary = readObject(rateLimits.primary) ??
    readObject(rateLimits.secondary);
  if (!primary) return undefined;
  const usedPercent = readNumber(primary.used_percent);
  const windowMinutes = readNumber(primary.window_minutes);
  const resetsIn = readNumber(primary.resets_in_seconds);
  return {
    // A window length is a fact; a name for it is not, unless it matches one
    // of the named windows exactly.
    scope: windowMinutes === 300
      ? "five-hour"
      : windowMinutes === 10_080
      ? "weekly"
      : "unknown",
    ...(usedPercent !== undefined ? { usedFraction: usedPercent / 100 } : {}),
    ...(resetsIn !== undefined ? { resetsInSeconds: resetsIn } : {}),
  };
}

/** The error object of a `turn.failed` / `error` event, in either generation. */
function errorObject(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return readObject(body.error) ??
    (readString(body.message) ? body : undefined);
}

/**
 * Decode one `codex exec --json` stdout into the shared contract.
 *
 * @param stdout - Raw stdout from the CLI.
 * @returns The decoded run; `text` is empty unless the agent actually said
 *   something, so a stream of envelopes is never mistaken for prose.
 */
function decodeCodexOutput(stdout: string): AgentDecodedOutput {
  const { events, malformedLines } = parseJsonlEvents(stdout);
  let malformedEvents = 0;

  let text = "";
  let textSource: AgentTextSource = "none";
  let status: AgentTerminalStatus = events.length === 0
    ? "unknown"
    : "incomplete";
  let sessionId: string | undefined;
  let usage: TokenUsage | undefined;
  let quota: AgentQuota | undefined;
  let progressEvents = 0;
  let last: string | undefined;
  const errors: AgentStructuredError[] = [];

  for (const { value } of events) {
    const event = eventBody(value);
    if (!event) {
      // A JSON object with no event kind under either envelope is not a
      // decodable event: counted like a malformed line rather than dropped,
      // so a schema change reads as "unreadable", never as "nothing
      // happened".
      malformedEvents++;
      continue;
    }
    const { kind, body } = event;

    // Session identity, under either generation's name for it.
    sessionId = readString(body.thread_id) ?? readString(body.session_id) ??
      sessionId;

    if (kind === "item.started" || kind === "item.updated") {
      progressEvents++;
      continue;
    }

    if (kind === "item.completed") {
      progressEvents++;
      const item = readObject(body.item);
      if (!item) continue;
      const type = itemType(item);
      if (type === "agent_message") {
        const message = readString(item.text) ?? readString(item.message);
        if (message) {
          text = message;
          textSource = "final";
        }
        continue;
      }
      last = readString(item.command) ?? readString(item.title) ?? last;
      continue;
    }

    // The protocol envelope's own message and completion events.
    if (kind === "agent_message") {
      progressEvents++;
      const message = readString(body.message) ?? readString(body.text);
      if (message) {
        text = message;
        textSource = "final";
      }
      continue;
    }
    if (kind === "task_complete") {
      status = "completed";
      const message = readString(body.last_agent_message);
      if (message) {
        text = message;
        textSource = "final";
      }
      continue;
    }

    if (kind === "turn.completed") {
      status = "completed";
      const reported = readObject(body.usage);
      if (reported) usage = usageFrom(reported) ?? usage;
      continue;
    }

    if (kind === "token_count") {
      progressEvents++;
      const info = readObject(body.info);
      const totals = info ? readObject(info.total_token_usage) : undefined;
      if (totals) usage = usageFrom(totals) ?? usage;
      const rateLimits = readObject(body.rate_limits) ??
        (info ? readObject(info.rate_limits) : undefined);
      if (rateLimits) quota = quotaFrom(rateLimits) ?? quota;
      continue;
    }

    if (kind === "turn.failed" || kind === "error" || kind === "stream_error") {
      status = "failed";
      const detail = errorObject(body);
      if (detail) {
        const message = readString(detail.message) ?? kind;
        const httpStatus = readNumber(detail.http_status) ??
          readNumber(detail.status) ?? extractHttpStatus(message);
        errors.push({
          source: kind,
          message,
          ...(readString(detail.type) ? { code: readString(detail.type) } : {}),
          ...(httpStatus !== undefined ? { httpStatus } : {}),
          raw: detail,
        });
      }
      continue;
    }

    if (kind === "task_started" || kind === "turn.started") continue;
    progressEvents++;
  }

  // Output that is not the CLI's event format at all — a panic, a plain
  // error — is legitimately the CLI's own text and must not be thrown away
  // just because it is not an event (Issue #1695).
  if (events.length === 0 && stdout.trim()) {
    text = stdout;
    textSource = "raw";
  }

  return {
    text,
    textSource,
    status,
    ...(sessionId ? { sessionId } : {}),
    ...(usage ? { usage } : {}),
    progress: { events: progressEvents, ...(last ? { last } : {}) },
    errors,
    ...(quota ? { quota } : {}),
    malformedLines: malformedLines + malformedEvents,
  };
}

/** The window a Codex refusal describes, from its own fields where present. */
function codexQuota(
  error: AgentStructuredError | undefined,
  surface: string,
  nowMs: number,
  reported?: AgentQuota,
): AgentQuota {
  const resetsIn = error ? readNumber(error.raw.resets_in_seconds) : undefined;
  const resetsAt = error ? readNumber(error.raw.resets_at) : undefined;
  const stated = error?.message ?? surface;
  const isoReset = /\b(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\b/.exec(stated)?.[1];
  const resetEpochMs = resetsIn !== undefined
    ? nowMs + resetsIn * 1000
    : resetsAt !== undefined
    ? resetsAt * 1000
    : isoReset
    ? Date.parse(isoReset)
    : undefined;
  const statedScope = detectQuotaScope(stated);
  // The window the stream already reported (`token_count.rate_limits`) is
  // structured evidence: it fills what the refusal's prose left unstated,
  // and never overrides what the refusal did state.
  return {
    scope: statedScope === "unknown"
      ? reported?.scope ?? "unknown"
      : statedScope,
    ...(resetEpochMs !== undefined && Number.isFinite(resetEpochMs)
      ? { resetEpochMs }
      : reported?.resetsInSeconds !== undefined
      ? { resetEpochMs: nowMs + reported.resetsInSeconds * 1000 }
      : {}),
    ...(reported?.usedFraction !== undefined
      ? { usedFraction: reported.usedFraction }
      : {}),
  };
}

/**
 * Classify one failed Codex run.
 *
 * Same order as every adapter: the worker's own facts, then a clean exit is
 * no failure at all, then the CLI's structured events, then its prose.
 *
 * @param streams - The run's streams and process facts.
 * @param decoded - The decoded output from {@link decodeCodexOutput}.
 * @returns The normalised failure, or undefined when the run did not fail.
 */
function classifyCodexFailure(
  streams: AgentRunStreams,
  decoded: AgentDecodedOutput,
): AgentFailure | undefined {
  const process = classifyProcessOutcome(streams);
  if (process) return process;

  if (streams.exitCode === 0) return undefined;

  const stderr = streams.stderr ?? "";
  const nowMs = streams.nowMs ?? Date.now();
  const structuredText = decoded.errors
    .map((e) => `${e.code ?? ""} ${e.message}`)
    .join("\n");
  const surface = `${structuredText}\n${stderr}`;
  const evidenceText = redactedEvidence(surface);
  const say = (headline: string) => failureMessage(headline, evidenceText);

  /** Pick the structured error that explains the run, when one does. */
  const match = (test: RegExp) =>
    decoded.errors.find((e) => test.test(`${e.code ?? ""} ${e.message}`));

  const httpStatus = decoded.errors.find((e) => e.httpStatus !== undefined)
    ?.httpStatus ?? extractHttpStatus(surface);

  if (detectOutOfMemory(`${decoded.text}\n${stderr}`)) {
    return agentFailure({
      category: "out-of-memory",
      message: say("The Codex CLI ran out of memory"),
      evidence: "prose",
      errors: decoded.errors,
    });
  }

  // Authentication before anything a status code could be read as: a rejected
  // credential answers 401/403 and must never walk the model ladder.
  const authError = match(/auth|unauthori[sz]ed|login|api[_ ]key/i);
  if (authError || httpStatus === 401 || httpStatus === 403) {
    return agentFailure({
      category: "authentication",
      message: say("Codex refused the credential"),
      evidence: authError ? "structured" : "prose",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errors: decoded.errors,
    });
  }
  if (isCodexAuthError(stderr)) {
    return agentFailure({
      category: "authentication",
      message: say("Codex refused the credential"),
      evidence: "prose",
      errors: decoded.errors,
    });
  }

  // An exhausted window: only when the refusal says the window is spent.
  const quotaError = match(QUOTA_RE);
  if (quotaError || QUOTA_RE.test(stderr)) {
    return agentFailure({
      category: "quota-exhausted",
      message: say("Codex's subscription window is exhausted"),
      evidence: quotaError ? "structured" : "prose",
      quota: codexQuota(quotaError, surface, nowMs, decoded.quota),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errors: decoded.errors,
    });
  }

  // A refused session is a start-up failure: nothing after it can be read
  // from this run, and the remedy is the session, not the model or a wait.
  const sessionError = match(INVALID_SESSION_RE);
  if (sessionError || INVALID_SESSION_RE.test(stderr)) {
    return agentFailure({
      category: "invalid-session",
      message: say("Codex refused the session it was asked to resume"),
      evidence: sessionError ? "structured" : "prose",
      errors: decoded.errors,
    });
  }

  const modelError = match(MODEL_UNAVAILABLE_RE);
  if (modelError || MODEL_UNAVAILABLE_RE.test(stderr)) {
    return agentFailure({
      category: "model-unavailable",
      message: say("Codex refused the requested model"),
      evidence: modelError ? "structured" : "prose",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errors: decoded.errors,
    });
  }

  if (
    isNetworkStatus(httpStatus) ||
    (NETWORK_RE.test(surface) && !RATE_LIMIT_RE.test(surface))
  ) {
    return agentFailure({
      category: "network",
      message: say("The Codex CLI could not reach the API"),
      evidence: "prose",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errors: decoded.errors,
    });
  }

  const rateError = match(RATE_LIMIT_RE);
  if (rateError || httpStatus === 429 || RATE_LIMIT_RE.test(stderr)) {
    const retryAfterSeconds =
      (rateError ? readNumber(rateError.raw.retry_after_seconds) : undefined) ??
        extractRetryAfterSeconds(surface);
    return agentFailure({
      category: "rate-limit",
      message: say("Codex rate-limited this request"),
      evidence: rateError ? "structured" : "prose",
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errors: decoded.errors,
    });
  }

  return agentFailure({
    category: "task-failure",
    message: say(`The Codex CLI exited ${streams.exitCode}`),
    evidence: decoded.errors.length > 0 ? "structured" : "process",
    errors: decoded.errors,
  });
}

/** The Codex CLI's output adapter, named by the Codex descriptor. */
export const CODEX_OUTPUT_ADAPTER: AgentOutputAdapter = {
  providerId: PROVIDER_ID,
  decode: decodeCodexOutput,
  classify: classifyCodexFailure,
};
