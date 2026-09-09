/**
 * The Claude Code output adapter (Issue #1695, parent #1694).
 *
 * Claude's half of the contract in `agent_output.ts`. It owns no new
 * vocabulary: the text extraction is `extractStreamJsonText` and every prose
 * test is the `detect*` predicate `claude_executor.ts` already owns, so an
 * existing Claude result decodes to exactly the text it decoded to before and
 * classifies the way the runner's ladder classifies it. What is new is the
 * *shape*: a named category, the evidence it was read from, and the quota
 * scope and reset carried as data rather than reconstructed by each caller.
 *
 * Two things it deliberately does **not** do:
 *
 * - It does not parse the CLI's `rate_limit_event`. That parser is Issue
 *   #1666's, and a second copy here is how the two would drift; when it
 *   lands, its windows and `resetsAt` become the structured evidence this
 *   module's quota branch prefers over prose.
 * - It does not re-run the model-unavailable regex on a 401/403 alone. A
 *   refused credential is an authentication failure; only a refusal that
 *   names the model is a model failure, which is what stops a bad credential
 *   walking the cheaper-model ladder.
 *
 * The Claude CLI is also DeepSeek's binary, so both descriptors share this
 * adapter — one CLI, one event shape.
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
  type AgentTextSource,
  classifyProcessOutcome,
  detectQuotaScope,
  extractHttpStatus,
  extractRetryAfterSeconds,
  parseJsonlEvents,
  redactedEvidence,
} from "./agent_output.ts";
import { isClaudeAuthError } from "./claude_auth.ts";
import {
  detectInvalidSessionId,
  detectModelUnavailable,
  detectOutOfMemory,
  detectRateLimit,
  detectUsageLimit,
  extractStreamJsonText,
  parseUsageLimitReset,
} from "./claude_executor.ts";
import { extractTokenUsage } from "./token_usage.ts";

/** The provider id this adapter decodes for. */
const PROVIDER_ID = "claude";

/** Statuses that mean the transport failed, not the credential or the model. */
const NETWORK_STATUSES: ReadonlySet<number> = new Set([
  500,
  502,
  503,
  504,
  529,
]);

/** Transport failures the CLI reports in prose. */
const NETWORK_RE =
  /overloaded|econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|connection (?:reset|refused|closed)/i;

/** A refusal that names the model, as opposed to the credential. */
const MODEL_EVIDENCE_RE = /\bmodel\b|unrecogni[sz]ed_model|model_not_found/i;

/** Read a string field, or undefined when it is absent or another type. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The assistant text blocks of one `assistant` event, concatenated. */
function assistantText(event: Record<string, unknown>): string {
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block && typeof block === "object" &&
      (block as Record<string, unknown>).type === "text"
    ) {
      const text = str((block as Record<string, unknown>).text);
      if (text) parts.push(text);
    }
  }
  return parts.join("");
}

/**
 * Collect the structured error evidence a Claude stream carries.
 *
 * Three shapes, all real (the recorded 2.1.261 fixtures carry two of them):
 * a `result` line flagged `is_error`, an `assistant` line carrying an `error`
 * code, and a bare `error` event. Each keeps its whole event on `raw`.
 */
function collectErrors(
  events: readonly { value: Record<string, unknown> }[],
): AgentStructuredError[] {
  const errors: AgentStructuredError[] = [];
  for (const { value } of events) {
    const type = str(value.type);
    if (type === "result" && value.is_error === true) {
      errors.push({
        source: "result",
        message: str(value.result) ?? str(value.subtype) ?? "result is_error",
        ...(str(value.subtype) ? { code: str(value.subtype) } : {}),
        raw: value,
      });
      continue;
    }
    if (type === "assistant" && str(value.error)) {
      errors.push({
        source: "assistant",
        message: assistantText(value) || (str(value.error) ?? ""),
        code: str(value.error),
        raw: value,
      });
      continue;
    }
    if (type === "error") {
      const message = str(value.message) ?? str(value.error) ?? "error event";
      errors.push({
        source: "error",
        message,
        ...(str(value.subtype) ? { code: str(value.subtype) } : {}),
        ...(extractHttpStatus(message) !== undefined
          ? { httpStatus: extractHttpStatus(message) }
          : {}),
        raw: value,
      });
    }
  }
  return errors;
}

/**
 * Decode one Claude `stream-json` stdout into the shared contract.
 *
 * The text is `extractStreamJsonText`'s, unchanged, so no existing result
 * moves. What changes is that the caller is now told *where* it came from:
 * `"none"` says the stream was event envelopes with no answer in them, which
 * is the case that must never be read as the agent's prose.
 *
 * @param stdout - Raw stdout from the CLI.
 * @returns The decoded run.
 */
function decodeClaudeOutput(stdout: string): AgentDecodedOutput {
  const { events, malformedLines } = parseJsonlEvents(stdout);
  const text = extractStreamJsonText(stdout);

  let textSource: AgentTextSource = "none";
  let status: AgentDecodedOutput["status"] = events.length === 0
    ? "unknown"
    : "incomplete";
  let sessionId: string | undefined;
  let progressEvents = 0;
  let last: string | undefined;

  for (const { value } of events) {
    sessionId = str(value.session_id) ?? sessionId;
    const type = str(value.type);
    if (type === "result") {
      status = value.is_error === true ? "failed" : "completed";
      if (str(value.result)) textSource = "final";
      continue;
    }
    if (type === "assistant") {
      progressEvents++;
      const assistant = assistantText(value);
      if (assistant) {
        last = assistant.split("\n").filter(Boolean).at(-1) ?? last;
        if (textSource === "none") textSource = "partial";
      }
      continue;
    }
    progressEvents++;
  }

  // Output that is not the CLI's event format at all — a health-check line, a
  // plain error — is legitimately the CLI's own text, not an envelope.
  if (events.length === 0 && text) textSource = "raw";
  // A stream of envelopes with no answer in it leaves `textSource` at
  // `"none"`: the pre-existing fallback still passes the raw stream through as
  // evidence, and `"none"` is how a caller knows it is not the agent's prose.

  const usage = extractTokenUsage(stdout) ?? undefined;
  return {
    text,
    textSource,
    status,
    ...(sessionId ? { sessionId } : {}),
    ...(usage ? { usage } : {}),
    progress: { events: progressEvents, ...(last ? { last } : {}) },
    errors: collectErrors(events),
    malformedLines,
  };
}

/** The quota window a Claude refusal describes, scope and reset alike. */
function claudeQuota(surface: string, nowMs: number): AgentQuota {
  const resetEpochMs = parseUsageLimitReset(surface, nowMs);
  return {
    scope: detectQuotaScope(surface),
    ...(resetEpochMs !== null ? { resetEpochMs } : {}),
  };
}

/**
 * Classify one failed Claude run.
 *
 * Order is the point. The worker's own facts first (a cancelled run is never
 * re-explained by its output), then a successful exit short-circuits to *no
 * failure at all* — which is what stops an agent quoting "429" in its answer
 * being read as a refusal — then structured evidence, then the narrow prose
 * predicates.
 *
 * @param streams - The run's streams and process facts.
 * @param decoded - The decoded output from {@link decodeClaudeOutput}.
 * @returns The normalised failure, or undefined when the run did not fail.
 */
function classifyClaudeFailure(
  streams: AgentRunStreams,
  decoded: AgentDecodedOutput,
): AgentFailure | undefined {
  const process = classifyProcessOutcome(streams);
  if (process) return process;

  // A run that exited 0 succeeded. Its prose is the agent's, not the CLI's.
  if (streams.exitCode === 0) return undefined;

  const stderr = streams.stderr ?? "";
  const surface = `${decoded.text}\n${stderr}`;
  const nowMs = streams.nowMs ?? Date.now();
  const structuredText = decoded.errors.map((e) =>
    `${e.code ?? ""} ${e.message}`
  )
    .join("\n");
  const evidenceText = redactedEvidence(
    [structuredText, stderr].filter(Boolean).join("\n"),
  );
  const httpStatus = extractHttpStatus(`${structuredText}\n${stderr}`);
  const say = (headline: string) =>
    evidenceText ? `${headline} — evidence: ${evidenceText}` : headline;

  // Memory first: a V8 heap abort's "heap limit" wording matches the
  // secondary rate-limit pattern, and waiting cannot reclaim memory.
  if (detectOutOfMemory(`${decoded.text}\n${stderr}`)) {
    return agentFailure({
      category: "out-of-memory",
      message: say("The Claude CLI ran out of memory"),
      evidence: "prose",
      errors: decoded.errors,
    });
  }

  // Structured evidence: the CLI's own verdict on the run, when it gave one.
  for (const error of decoded.errors) {
    const code = error.code ?? "";
    if (/auth/i.test(code) || isClaudeAuthError(error.message)) {
      return agentFailure({
        category: "authentication",
        message: say("Claude refused the credential"),
        evidence: "structured",
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        errors: decoded.errors,
      });
    }
    if (detectUsageLimit(error.message)) {
      return agentFailure({
        category: "quota-exhausted",
        message: say("Claude's subscription window is exhausted"),
        evidence: "structured",
        quota: claudeQuota(error.message, nowMs),
        errors: decoded.errors,
      });
    }
  }

  // The CLI refused the session flags before it ever reached a model call.
  if (detectInvalidSessionId(surface)) {
    return agentFailure({
      category: "invalid-session",
      message: say("The Claude CLI refused the session flags"),
      evidence: "prose",
      errors: decoded.errors,
    });
  }

  // A refused credential, including a bare 401/403 that names no model.
  if (
    isClaudeAuthError(surface) ||
    ((httpStatus === 401 || httpStatus === 403) &&
      !MODEL_EVIDENCE_RE.test(surface))
  ) {
    return agentFailure({
      category: "authentication",
      message: say("Claude refused the credential"),
      evidence: "prose",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errors: decoded.errors,
    });
  }

  if (detectModelUnavailable(surface)) {
    return agentFailure({
      category: "model-unavailable",
      message: say("Claude refused the requested model"),
      evidence: "prose",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errors: decoded.errors,
    });
  }

  if (detectUsageLimit(surface)) {
    return agentFailure({
      category: "quota-exhausted",
      message: say("Claude's subscription window is exhausted"),
      evidence: "prose",
      quota: claudeQuota(surface, nowMs),
      errors: decoded.errors,
    });
  }

  // Transport before rate limit: an overloaded upstream matches the
  // rate-limit vocabulary but is not a limit on this account.
  if (
    (httpStatus !== undefined && NETWORK_STATUSES.has(httpStatus)) ||
    NETWORK_RE.test(surface)
  ) {
    return agentFailure({
      category: "network",
      message: say("The Claude CLI could not reach the API"),
      evidence: "prose",
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errors: decoded.errors,
    });
  }

  // A transient limit: only a primary match or an explicit 429, never the
  // weak "try again / retry / limit" vocabulary on its own.
  if (httpStatus === 429 || detectRateLimit(surface).isPrimary) {
    const retryAfterSeconds = extractRetryAfterSeconds(surface);
    return agentFailure({
      category: "rate-limit",
      message: say("Claude rate-limited this request"),
      evidence: "prose",
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errors: decoded.errors,
    });
  }

  return agentFailure({
    category: "task-failure",
    message: say(`The Claude CLI exited ${streams.exitCode}`),
    evidence: "process",
    errors: decoded.errors,
  });
}

/** Claude Code's output adapter, named by the Claude and DeepSeek descriptors. */
export const CLAUDE_OUTPUT_ADAPTER: AgentOutputAdapter = {
  providerId: PROVIDER_ID,
  decode: decodeClaudeOutput,
  classify: classifyClaudeFailure,
};
