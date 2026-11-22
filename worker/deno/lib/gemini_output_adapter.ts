/**
 * The Gemini CLI output adapter (Issue #5340, parent #1695).
 *
 * `gemini --output-format stream-json` writes NDJSON, one event per line, each
 * with a `type` and a `timestamp`. Until now the worker read it with Claude's
 * extractor, so the echoed prompt, the agent's deltas and the CLI's own error
 * lines were all handed on as one stream "as if it were the agent's answer".
 * This module decodes the events instead.
 *
 * The event shape, verified against the pinned CLI (Gemini CLI 0.68.0,
 * `container/tools.json`; read from the published bundle, sha256 325099dd…):
 *
 * - `init` — `session_id` and `model`;
 * - `message` — `role` `user` (the echoed prompt: never answer text) or
 *   `assistant` (`content`, sent as `delta` chunks to be concatenated);
 * - `tool_use` / `tool_result` — a tool call and its outcome;
 * - `error` — non-terminal (`severity` `warning` for retry notices);
 * - `result` — the terminal event, `status` `success` or `error`. On a fatal
 *   error it carries `error: {type, message}`, where `type` is the CLI's own
 *   error class (`TerminalQuotaError`, `UnauthorizedError`, …) and `message`
 *   is the server's text. The process then exits with that error's code: a
 *   429 surfaces as exit 173 on Linux, a fatal authentication error as 41,
 *   the turn cap as 53. `stats` on every `result` is read by
 *   `gemini_token_usage.ts`.
 *
 * Classification order, after the process facts (a cancellation or a watchdog
 * kill outranks everything) and a success (never a failure, however much of
 * its text quotes a limit): out-of-memory; authentication from structured
 * evidence; quota from structured evidence; authentication from prose; quota
 * from prose; model unavailable; turn limit; network; rate limit; then
 * task failure. The assistant's own text is never classified, except for the
 * out-of-memory check, exactly as Codex does it.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  type AgentDecodedOutput,
  type AgentEvidenceKind,
  type AgentFailure,
  agentFailure,
  type AgentOutputAdapter,
  type AgentQuota,
  type AgentRunStreams,
  type AgentStructuredError,
  type AgentTerminalStatus,
  type AgentTextSource,
  BALANCE_EXHAUSTED_RE,
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
// Heap exhaustion is a runtime fact, not a vendor's vocabulary, so the one
// predicate is reused rather than copied (as Codex's adapter does).
import { detectOutOfMemory } from "./claude_executor.ts";
import { isGeminiAuthError } from "./gemini_auth.ts";
import { decodeGeminiTokenUsage } from "./gemini_token_usage.ts";

/** The provider id this adapter decodes for. */
const PROVIDER_ID = "gemini";

/** The CLI's exit code for a fatal authentication error. */
const AUTH_EXIT_CODE = 41;

/** The CLI's exit code for the turn cap (`FatalTurnLimitedError`). */
const TURN_LIMIT_EXIT_CODE = 53;

/** Transport failures the CLI reports in prose (as Codex's adapter reads them). */
const NETWORK_RE =
  /overloaded|high demand|econnreset|econnrefused|etimedout|enotfound|socket hang up|stream disconnected|connection (?:reset|refused|closed)/i;

/**
 * A refusal about the model rather than the credential or the window. The
 * `model` prefix is bounded, so the match cannot run away on a long line.
 */
const MODEL_UNAVAILABLE_RE =
  /model[^\n]{0,40}(?:not found|does not exist|is not supported|unavailable)|ModelNotFoundError/i;

/**
 * A rejected credential: the CLI's own class names for a fatal auth, a 401,
 * a 403 or a suspended account, or the Google API's wording for the same.
 */
const AUTH_RE =
  /\b(?:FatalAuthenticationError|UnauthorizedError|ForbiddenError|AccountSuspendedError)\b|UNAUTHENTICATED|invalid authentication credentials|invalid_grant/i;

/** The CLI's own terminal verdict that a quota is spent. */
const TERMINAL_QUOTA_RE = /\bTerminalQuotaError\b/;

/** A quota refusal in the Gemini API's own wording. */
const QUOTA_RE =
  /exhausted your (?:capacity|daily quota)|quota will reset|exceeded your current quota|QUOTA_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|INSUFFICIENT_G1_CREDITS_BALANCE/i;

/** The CLI's transient quota class: retry after a delay, not exhausted. */
const RETRYABLE_QUOTA_RE = /\bRetryableQuotaError\b/;

/** A transient limit on the rate of requests. */
const RATE_LIMIT_RE =
  /rate[_ ]limit|too many requests|RESOURCE_EXHAUSTED|\b429\b/i;

/** The turn cap, by its class name. */
const TURN_LIMIT_RE = /\bFatalTurnLimitedError\b/;

/**
 * `reset after 2h30m15s` (any subset of the three units). Every group is
 * optional, so the match is checked for at least one group before it is used.
 */
const RESET_AFTER_RE = /\breset after (\d+h)?(\d+m)?(\d+(?:\.\d+)?s)?/i;

/** `retry in 3600s`, `retry in 500ms`. Linear: one bounded number, one unit. */
const RETRY_IN_RE = /\bretry in (\d+(?:\.\d+)?)(ms|s)\b/i;

/**
 * The delay a message states, in milliseconds.
 *
 * @param text - The message to read.
 * @returns The delay, or undefined when none was stated. Never a default: an
 *   invented delay is indistinguishable from a measured one.
 */
function retryInMs(text: string): number | undefined {
  const match = RETRY_IN_RE.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  return match[2]?.toLowerCase() === "ms" ? value : value * 1000;
}

/**
 * The reset delay a quota message states, in milliseconds.
 *
 * The "reset after" phrase wins when it carries at least one unit; otherwise
 * a "retry in" delay is the reset.
 *
 * @param text - The refusal text.
 * @returns The delay, or undefined when none was stated.
 */
function resetDelayMs(text: string): number | undefined {
  const after = RESET_AFTER_RE.exec(text);
  if (after && (after[1] || after[2] || after[3])) {
    const seconds = (after[1] ? parseFloat(after[1]) * 3600 : 0) +
      (after[2] ? parseFloat(after[2]) * 60 : 0) +
      (after[3] ? parseFloat(after[3]) : 0);
    return seconds * 1000;
  }
  return retryInMs(text);
}

/**
 * The quota window a Gemini refusal describes.
 *
 * @param text - The refusal text.
 * @param nowMs - The clock the reset is measured from.
 * @returns The scope (`"unknown"` when unnamed) and the reset instant, only
 *   when the refusal stated one.
 */
function geminiQuota(text: string, nowMs: number): AgentQuota {
  const delay = resetDelayMs(text);
  const resetEpochMs = delay === undefined ? undefined : nowMs + delay;
  return {
    scope: detectQuotaScope(text),
    ...(resetEpochMs !== undefined && Number.isFinite(resetEpochMs)
      ? { resetEpochMs }
      : {}),
  };
}

/**
 * The structured error one `result` event's `error` object describes.
 *
 * @param error - The error object, kept verbatim on `raw`.
 * @returns The structured error, with the class as its code.
 */
function resultError(error: Record<string, unknown>): AgentStructuredError {
  const message = readString(error.message) ?? "result";
  const code = readString(error.type);
  const httpStatus = readNumber(error.code) ?? readNumber(error.status) ??
    extractHttpStatus(message);
  return {
    source: "result",
    message,
    ...(code !== undefined ? { code } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    raw: error,
  };
}

/**
 * Decode one `gemini --output-format stream-json` stdout into the shared
 * contract.
 *
 * @param stdout - Raw stdout from the CLI.
 * @returns The decoded run. The text is the agent's own answer or empty; the
 *   echoed prompt is never in it.
 */
function decodeGeminiOutput(stdout: string): AgentDecodedOutput {
  const { events, malformedLines } = parseJsonlEvents(stdout);
  let untypedEvents = 0;

  let status: AgentTerminalStatus = events.length === 0
    ? "unknown"
    : "incomplete";
  let sessionId: string | undefined;
  let progressEvents = 0;
  let last: string | undefined;
  const errors: AgentStructuredError[] = [];
  // Assistant text, closed into a segment at each tool call: the text after a
  // turn's last tool call is its answer, and anything before is narration.
  const segments: string[] = [];
  let current = "";

  for (const { value } of events) {
    const kind = readString(value.type);
    if (!kind) {
      // An object with no event kind is not a decodable event: counted with
      // the malformed lines, never silently dropped.
      untypedEvents++;
      continue;
    }

    if (kind === "init") {
      sessionId = readString(value.session_id) ?? sessionId;
      continue;
    }

    if (kind === "message") {
      // The echoed prompt is role `user`; it is never the agent's answer.
      if (readString(value.role) === "assistant") {
        progressEvents++;
        current += readString(value.content) ?? "";
      }
      continue;
    }

    if (kind === "tool_use") {
      progressEvents++;
      last = readString(value.tool_name) ?? last;
      segments.push(current);
      current = "";
      continue;
    }

    if (kind === "tool_result") {
      progressEvents++;
      continue;
    }

    if (kind === "error") {
      // Non-terminal (retry warnings and the like): kept as evidence, with no
      // change to the run's status.
      const message = readString(value.message) ?? "";
      const httpStatus = extractHttpStatus(message);
      errors.push({
        source: "error",
        message,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        raw: value,
      });
      continue;
    }

    if (kind === "result") {
      const outcome = readString(value.status);
      if (outcome === "success") {
        status = "completed";
      } else if (outcome === "error") {
        status = "failed";
        const error = readObject(value.error);
        if (error) errors.push(resultError(error));
      }
      continue;
    }

    // An event kind this adapter does not know is counted as progress, not
    // dropped: the run did something, even if the worker cannot name it.
    progressEvents++;
  }
  segments.push(current);

  const nonEmpty = segments.filter((segment) => segment.length > 0);
  let text = "";
  let textSource: AgentTextSource = "none";
  if (nonEmpty.length > 0) {
    if (status === "completed") {
      text = nonEmpty.at(-1) ?? "";
      textSource = "final";
    } else {
      text = nonEmpty.join("\n");
      textSource = "partial";
    }
  } else if (events.length === 0 && stdout.trim()) {
    // Not an event stream at all: passed through, so nothing is lost. The
    // caller is told it is raw, never that it is the answer.
    text = stdout;
    textSource = "raw";
  }

  const usage = decodeGeminiTokenUsage(stdout);

  return {
    text,
    textSource,
    status,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(usage !== undefined ? { usage } : {}),
    progress: {
      events: progressEvents,
      ...(last !== undefined ? { last } : {}),
    },
    errors,
    malformedLines: malformedLines + untypedEvents,
  };
}

/**
 * The evidence a structured-or-process authentication failure rests on.
 *
 * @param structured - Whether a structured error matched.
 * @param exitCode - The child's exit code.
 * @returns Structured first, then the process's own fatal code, then prose.
 */
function authEvidence(
  structured: boolean,
  exitCode: number,
): AgentEvidenceKind {
  if (structured) return "structured";
  if (exitCode === AUTH_EXIT_CODE) return "process";
  return "prose";
}

/**
 * Classify one failed Gemini run.
 *
 * @param streams - The run's process facts and streams.
 * @param decoded - The decode of its stdout.
 * @returns The failure, or undefined when the run did not fail.
 */
function classifyGeminiFailure(
  streams: AgentRunStreams,
  decoded: AgentDecodedOutput,
): AgentFailure | undefined {
  const processFailure = classifyProcessOutcome(streams);
  if (processFailure) return processFailure;
  // A success that quotes a quota or a login line is a quotation, not a
  // refusal.
  if (streams.exitCode === 0) return undefined;

  const { stderr, exitCode } = streams;
  const { errors } = decoded;
  const surface = `${
    errors.map((e) => `${e.code ?? ""} ${e.message}`).join("\n")
  }\n${stderr}`;
  const evidence = redactedEvidence(surface);
  const say = (headline: string) => failureMessage(headline, evidence);
  const nowMs = streams.nowMs ?? Date.now();

  // Result errors are searched first (they are the CLI's verdict), then the
  // rest, in the order they were emitted.
  const ordered = [
    ...errors.filter((e) => e.source === "result"),
    ...errors.filter((e) => e.source !== "result"),
  ];
  const match = (test: RegExp) =>
    ordered.find((e) => test.test(`${e.code ?? ""} ${e.message}`));
  const httpStatus = ordered.find((e) => e.httpStatus !== undefined)
    ?.httpStatus ?? extractHttpStatus(surface);

  if (detectOutOfMemory(`${decoded.text}\n${stderr}`)) {
    return agentFailure({
      category: "out-of-memory",
      message: say("The Gemini CLI ran out of memory"),
      evidence: "prose",
      errors,
    });
  }

  // Authentication before any status code is read as a quota or a model
  // problem: a rejected credential answers 401/403 and must never walk the
  // model ladder.
  const authError = match(AUTH_RE);
  if (
    authError || exitCode === AUTH_EXIT_CODE || httpStatus === 401 ||
    httpStatus === 403
  ) {
    return agentFailure({
      category: "authentication",
      message: say("Gemini refused the credential"),
      evidence: authEvidence(authError !== undefined, exitCode),
      httpStatus,
      errors,
    });
  }

  // A spent window, read from the CLI's own verdict or the API's wording.
  // Issue #2613: a spent balance (HTTP 402) is the same account-wide refusal.
  const quotaError = match(TERMINAL_QUOTA_RE) ?? match(QUOTA_RE) ??
    match(BALANCE_EXHAUSTED_RE);
  if (quotaError) {
    return agentFailure({
      category: "quota-exhausted",
      message: say("Gemini's quota is exhausted"),
      evidence: "structured",
      quota: geminiQuota(quotaError.message, nowMs),
      httpStatus,
      errors,
    });
  }

  // Prose authentication comes after the structured quota verdict on purpose:
  // Gemini's stderr routinely names GEMINI_API_KEY in an advisory warning,
  // which isGeminiAuthError reads as an auth failure. A structured quota must
  // win over that.
  if (isGeminiAuthError(stderr)) {
    return agentFailure({
      category: "authentication",
      message: say("Gemini refused the credential"),
      evidence: "prose",
      httpStatus,
      errors,
    });
  }

  if (QUOTA_RE.test(stderr) || BALANCE_EXHAUSTED_RE.test(stderr)) {
    return agentFailure({
      category: "quota-exhausted",
      message: say("Gemini's quota is exhausted"),
      evidence: "prose",
      quota: geminiQuota(stderr, nowMs),
      httpStatus,
      errors,
    });
  }

  const modelError = match(MODEL_UNAVAILABLE_RE);
  if (modelError || MODEL_UNAVAILABLE_RE.test(stderr)) {
    return agentFailure({
      category: "model-unavailable",
      message: say("Gemini refused the requested model"),
      evidence: modelError ? "structured" : "prose",
      httpStatus,
      errors,
    });
  }

  const turnError = match(TURN_LIMIT_RE);
  if (exitCode === TURN_LIMIT_EXIT_CODE || turnError) {
    return agentFailure({
      category: "turn-limit",
      message: say("The Gemini CLI stopped at its turn limit"),
      evidence: turnError ? "structured" : "process",
      errors,
    });
  }

  if (
    isNetworkStatus(httpStatus) ||
    (NETWORK_RE.test(surface) && !RATE_LIMIT_RE.test(surface))
  ) {
    return agentFailure({
      category: "network",
      message: say("The Gemini CLI could not reach the API"),
      evidence: "prose",
      httpStatus,
      errors,
    });
  }

  // A transient limit: the CLI's retryable class, a 429, or its wording. The
  // retry delay is read from the same text it was classified on.
  const rateError = match(RETRYABLE_QUOTA_RE) ?? match(RATE_LIMIT_RE);
  if (rateError || httpStatus === 429 || RATE_LIMIT_RE.test(stderr)) {
    const delayMs = retryInMs(surface);
    const retryAfterSeconds = delayMs !== undefined
      ? delayMs / 1000
      : extractRetryAfterSeconds(surface);
    return agentFailure({
      category: "rate-limit",
      message: say("Gemini rate-limited this request"),
      evidence: rateError ? "structured" : "prose",
      retryAfterSeconds,
      httpStatus,
      errors,
    });
  }

  return agentFailure({
    category: "task-failure",
    message: say(`The Gemini CLI exited ${exitCode}`),
    evidence: errors.length > 0 ? "structured" : "process",
    errors,
  });
}

/** The Gemini CLI's output adapter, named by the Gemini descriptor. */
export const GEMINI_OUTPUT_ADAPTER: AgentOutputAdapter = {
  providerId: PROVIDER_ID,
  decode: decodeGeminiOutput,
  classify: classifyGeminiFailure,
};
