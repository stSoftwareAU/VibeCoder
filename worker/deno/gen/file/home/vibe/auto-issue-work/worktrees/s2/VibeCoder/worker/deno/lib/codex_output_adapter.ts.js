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
 */ import { agentFailure, BALANCE_EXHAUSTED_RE, classifyProcessOutcome, detectQuotaScope, extractHttpStatus, extractRetryAfterSeconds, failureMessage, isNetworkStatus, parseJsonlEvents, readNumber, readObject, readString, redactedEvidence } from "./agent_output.ts";
import { isCodexAuthError } from "./codex_auth.ts";
// Heap exhaustion is a runtime fact, not a vendor's vocabulary: the one
// predicate is reused rather than a second copy of the same patterns
// (Issue #1695). It lives beside Claude's other detectors for historical
// reasons only.
import { detectOutOfMemory } from "./claude_executor.ts";
/** The provider id this adapter decodes for. */ const PROVIDER_ID = "codex";
/** Transport failures the CLI reports in prose. */ const NETWORK_RE = /overloaded|high demand|econnreset|econnrefused|etimedout|enotfound|socket hang up|stream disconnected|connection (?:reset|refused|closed)/i;
/** A refusal about the model rather than the credential or the window. */ const MODEL_UNAVAILABLE_RE = /model_not_found|unknown model|unsupported model|model[^\n]{0,40}(?:does not exist|not found|unavailable|not available|is not supported)|do(?:es)? not have access to it/i;
/** A refusal that says the subscription window itself is spent. */ const QUOTA_RE = /usage_limit|usage limit|quota[^\n]{0,20}(?:exhausted|exceeded)|out of credits|plan limit|hit your (?:weekly|monthly|daily)? ?limit/i;
/** A transient limit on the rate of requests. */ const RATE_LIMIT_RE = /rate[_ ]limit|too many requests|\b429\b/i;
/**
 * The CLI refusing the session it was asked to resume.
 *
 * `codex exec resume` names a session Codex must still hold; a rolled or
 * pruned one is refused before any model call, exactly as Claude's session
 * flags are. Anchored to session vocabulary so an unrelated "not found"
 * cannot match.
 */ const INVALID_SESSION_RE = /session[_ ](?:not[_ ]found|expired|invalid)|(?:no|unknown|invalid|expired)[^\n]{0,20}session|thread[_ ]not[_ ]found|no (?:previous|recorded) session/i;
/**
 * The event body and its kind, whichever envelope generation carried it.
 *
 * A protocol line nests everything under `msg`; the experimental schema puts
 * it at the top level. Both reduce to "a kind and a body" here, so nothing
 * downstream knows which generation it is reading.
 */ function eventBody(value) {
  const msg = readObject(value.msg);
  if (msg && readString(msg.type)) {
    return {
      kind: readString(msg.type),
      body: msg
    };
  }
  const kind = readString(value.type);
  return kind ? {
    kind,
    body: value
  } : undefined;
}
/** An item event's own type, under either of the two field names in use. */ function itemType(item) {
  return readString(item.item_type) ?? readString(item.type);
}
/** Codex's token counts, mapped onto the shared {@link TokenUsage} shape. */ function usageFrom(source) {
  const input = readNumber(source.input_tokens);
  const output = readNumber(source.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    // Codex reports cached *input* tokens and has no cache-write counter, so
    // the write count stays 0 rather than being invented from the read.
    cacheCreationTokens: 0,
    cacheReadTokens: readNumber(source.cached_input_tokens) ?? 0
  };
}
/** A `rate_limits` window from a `token_count` event, when one is present. */ function quotaFrom(rateLimits) {
  const primary = readObject(rateLimits.primary) ?? readObject(rateLimits.secondary);
  if (!primary) return undefined;
  const usedPercent = readNumber(primary.used_percent);
  const windowMinutes = readNumber(primary.window_minutes);
  const resetsIn = readNumber(primary.resets_in_seconds);
  return {
    // A window length is a fact; a name for it is not, unless it matches one
    // of the named windows exactly.
    scope: windowMinutes === 300 ? "five-hour" : windowMinutes === 10_080 ? "weekly" : "unknown",
    ...usedPercent !== undefined ? {
      usedFraction: usedPercent / 100
    } : {},
    ...resetsIn !== undefined ? {
      resetsInSeconds: resetsIn
    } : {}
  };
}
/** The error object of a `turn.failed` / `error` event, in either generation. */ function errorObject(body) {
  return readObject(body.error) ?? (readString(body.message) ? body : undefined);
}
/**
 * Decode one `codex exec --json` stdout into the shared contract.
 *
 * @param stdout - Raw stdout from the CLI.
 * @returns The decoded run; `text` is empty unless the agent actually said
 *   something, so a stream of envelopes is never mistaken for prose.
 */ function decodeCodexOutput(stdout) {
  const { events, malformedLines } = parseJsonlEvents(stdout);
  let malformedEvents = 0;
  let text = "";
  let textSource = "none";
  let status = events.length === 0 ? "unknown" : "incomplete";
  let sessionId;
  let usage;
  let quota;
  let progressEvents = 0;
  let last;
  const errors = [];
  for (const { value } of events){
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
    sessionId = readString(body.thread_id) ?? readString(body.session_id) ?? sessionId;
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
      const rateLimits = readObject(body.rate_limits) ?? (info ? readObject(info.rate_limits) : undefined);
      if (rateLimits) quota = quotaFrom(rateLimits) ?? quota;
      continue;
    }
    if (kind === "turn.failed" || kind === "error" || kind === "stream_error") {
      status = "failed";
      const detail = errorObject(body);
      if (detail) {
        const message = readString(detail.message) ?? kind;
        const httpStatus = readNumber(detail.http_status) ?? readNumber(detail.status) ?? extractHttpStatus(message);
        errors.push({
          source: kind,
          message,
          ...readString(detail.type) ? {
            code: readString(detail.type)
          } : {},
          ...httpStatus !== undefined ? {
            httpStatus
          } : {},
          raw: detail
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
    ...sessionId ? {
      sessionId
    } : {},
    ...usage ? {
      usage
    } : {},
    progress: {
      events: progressEvents,
      ...last ? {
        last
      } : {}
    },
    errors,
    ...quota ? {
      quota
    } : {},
    malformedLines: malformedLines + malformedEvents
  };
}
/** The window a Codex refusal describes, from its own fields where present. */ function codexQuota(error, surface, nowMs, reported) {
  const resetsIn = error ? readNumber(error.raw.resets_in_seconds) : undefined;
  const resetsAt = error ? readNumber(error.raw.resets_at) : undefined;
  const stated = error?.message ?? surface;
  const isoReset = /\b(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\b/.exec(stated)?.[1];
  const resetEpochMs = resetsIn !== undefined ? nowMs + resetsIn * 1000 : resetsAt !== undefined ? resetsAt * 1000 : isoReset ? Date.parse(isoReset) : undefined;
  const statedScope = detectQuotaScope(stated);
  // The window the stream already reported (`token_count.rate_limits`) is
  // structured evidence: it fills what the refusal's prose left unstated,
  // and never overrides what the refusal did state.
  return {
    scope: statedScope === "unknown" ? reported?.scope ?? "unknown" : statedScope,
    ...resetEpochMs !== undefined && Number.isFinite(resetEpochMs) ? {
      resetEpochMs
    } : reported?.resetsInSeconds !== undefined ? {
      resetEpochMs: nowMs + reported.resetsInSeconds * 1000
    } : {},
    ...reported?.usedFraction !== undefined ? {
      usedFraction: reported.usedFraction
    } : {}
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
 */ function classifyCodexFailure(streams, decoded) {
  const process = classifyProcessOutcome(streams);
  if (process) return process;
  if (streams.exitCode === 0) return undefined;
  const stderr = streams.stderr ?? "";
  const nowMs = streams.nowMs ?? Date.now();
  const structuredText = decoded.errors.map((e)=>`${e.code ?? ""} ${e.message}`).join("\n");
  const surface = `${structuredText}\n${stderr}`;
  const evidenceText = redactedEvidence(surface);
  const say = (headline)=>failureMessage(headline, evidenceText);
  /** Pick the structured error that explains the run, when one does. */ const match = (test)=>decoded.errors.find((e)=>test.test(`${e.code ?? ""} ${e.message}`));
  const httpStatus = decoded.errors.find((e)=>e.httpStatus !== undefined)?.httpStatus ?? extractHttpStatus(surface);
  if (detectOutOfMemory(`${decoded.text}\n${stderr}`)) {
    return agentFailure({
      category: "out-of-memory",
      message: say("The Codex CLI ran out of memory"),
      evidence: "prose",
      errors: decoded.errors
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
      ...httpStatus !== undefined ? {
        httpStatus
      } : {},
      errors: decoded.errors
    });
  }
  if (isCodexAuthError(stderr)) {
    return agentFailure({
      category: "authentication",
      message: say("Codex refused the credential"),
      evidence: "prose",
      errors: decoded.errors
    });
  }
  // An exhausted window: only when the refusal says the window is spent.
  // Issue #2613: a spent balance (HTTP 402) is the same account-wide refusal.
  const quotaError = match(QUOTA_RE) ?? match(BALANCE_EXHAUSTED_RE);
  if (quotaError || QUOTA_RE.test(stderr) || BALANCE_EXHAUSTED_RE.test(stderr)) {
    return agentFailure({
      category: "quota-exhausted",
      message: say("Codex's subscription window is exhausted"),
      evidence: quotaError ? "structured" : "prose",
      quota: codexQuota(quotaError, surface, nowMs, decoded.quota),
      ...httpStatus !== undefined ? {
        httpStatus
      } : {},
      errors: decoded.errors
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
      errors: decoded.errors
    });
  }
  const modelError = match(MODEL_UNAVAILABLE_RE);
  if (modelError || MODEL_UNAVAILABLE_RE.test(stderr)) {
    return agentFailure({
      category: "model-unavailable",
      message: say("Codex refused the requested model"),
      evidence: modelError ? "structured" : "prose",
      ...httpStatus !== undefined ? {
        httpStatus
      } : {},
      errors: decoded.errors
    });
  }
  if (isNetworkStatus(httpStatus) || NETWORK_RE.test(surface) && !RATE_LIMIT_RE.test(surface)) {
    return agentFailure({
      category: "network",
      message: say("The Codex CLI could not reach the API"),
      evidence: "prose",
      ...httpStatus !== undefined ? {
        httpStatus
      } : {},
      errors: decoded.errors
    });
  }
  const rateError = match(RATE_LIMIT_RE);
  if (rateError || httpStatus === 429 || RATE_LIMIT_RE.test(stderr)) {
    const retryAfterSeconds = (rateError ? readNumber(rateError.raw.retry_after_seconds) : undefined) ?? extractRetryAfterSeconds(surface);
    return agentFailure({
      category: "rate-limit",
      message: say("Codex rate-limited this request"),
      evidence: rateError ? "structured" : "prose",
      ...retryAfterSeconds !== undefined ? {
        retryAfterSeconds
      } : {},
      ...httpStatus !== undefined ? {
        httpStatus
      } : {},
      errors: decoded.errors
    });
  }
  return agentFailure({
    category: "task-failure",
    message: say(`The Codex CLI exited ${streams.exitCode}`),
    evidence: decoded.errors.length > 0 ? "structured" : "process",
    errors: decoded.errors
  });
}
/** The Codex CLI's output adapter, named by the Codex descriptor. */ export const CODEX_OUTPUT_ADAPTER = {
  providerId: PROVIDER_ID,
  decode: decodeCodexOutput,
  classify: classifyCodexFailure
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jb2RleF9vdXRwdXRfYWRhcHRlci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRoZSBDb2RleCBDTEkgb3V0cHV0IGFkYXB0ZXIgKElzc3VlICMxNjk1LCBwYXJlbnQgIzE2OTQpLlxuICpcbiAqIGBjb2RleCBleGVjIC0tanNvbmAgd3JpdGVzIEpTT05MLCBhbmQgdW50aWwgbm93IHRoZSB3b3JrZXIgcmVhZCBpdCB3aXRoXG4gKiBDbGF1ZGUncyBleHRyYWN0b3I6IG5vIGByZXN1bHRgIGxpbmUgYW5kIG5vIGBhc3Npc3RhbnRgIGJsb2Nrcywgc28gdGhlIHdob2xlXG4gKiBlbnZlbG9wZSBzdHJlYW0gd2FzIGhhbmRlZCBvbiAqKmFzIGlmIGl0IHdlcmUgdGhlIGFnZW50J3MgYW5zd2VyKiosIGFuZCBhbnlcbiAqIHJlZnVzYWwgd2FzIGNsYXNzaWZpZWQgYnkgd2hpY2hldmVyIENsYXVkZSBwcm9zZSBwYXR0ZXJuIGhhcHBlbmVkIHRvIG1hdGNoLlxuICogVGhpcyBtb2R1bGUgZGVjb2RlcyB0aGUgZXZlbnRzIGluc3RlYWQuXG4gKlxuICogVHdvIGVudmVsb3BlIGdlbmVyYXRpb25zIGFyZSBhY2NlcHRlZCwgYmVjYXVzZSBhIHBpbm5lZCBDTEkgaXMgYSBtb3ZpbmdcbiAqIHRhcmdldCBhbmQgZ3Vlc3Npbmcgb25lIHdvdWxkIGJyZWFrIHRoZSBvdGhlcjpcbiAqXG4gKiAtIHRoZSBleHBlcmltZW50YWwgdG9wLWxldmVsIHNjaGVtYSDigJQgYHRocmVhZC5zdGFydGVkYCwgYGl0ZW0uc3RhcnRlZGAgL1xuICogICBgaXRlbS5jb21wbGV0ZWRgLCBgdHVybi5jb21wbGV0ZWRgLCBgdHVybi5mYWlsZWRgLCBgZXJyb3JgO1xuICogLSB0aGUgcHJvdG9jb2wgZW52ZWxvcGUg4oCUIGB7XCJpZFwiOlwiMFwiLFwibXNnXCI6e1widHlwZVwiOlwiYWdlbnRfbWVzc2FnZVwiLOKApn19YCxcbiAqICAgd2l0aCBgc2Vzc2lvbl9jb25maWd1cmVkYCwgYHRva2VuX2NvdW50YCBhbmQgYHRhc2tfY29tcGxldGVgLlxuICpcbiAqIEEgZmllbGQgdGhpcyB3b3JrZXIgaGFzIG5ldmVyIHNlZW4gaXMgbm90IGFuIGVycm9yOiBhbiBlcnJvciBldmVudCdzIG93blxuICogb2JqZWN0IGlzIGtlcHQgdmVyYmF0aW0gb24ge0BsaW5rIEFnZW50U3RydWN0dXJlZEVycm9yLnJhd30sIHNvIGEgY29uc3VtZXJcbiAqIGNhbiByZWFkIGEgbmV3IGZpZWxkIHdpdGhvdXQgdGhlIGFkYXB0ZXIgYmVpbmcgdGF1Z2h0IGFib3V0IGl0IGZpcnN0LiBBblxuICogZXZlbnQgd2hvc2UgKmtpbmQqIGlzIHVucmVjb2duaXNlZCBpcyBjb3VudGVkIOKAlCBhcyBwcm9ncmVzcyB3aGVuIGl0IGlzIGFcbiAqIHJlY29nbmlzYWJsZSBlbnZlbG9wZSwgYXMgYSBtYWxmb3JtZWQgbGluZSB3aGVuIGl0IGlzIG5vdCDigJQgYW5kIGEgbGluZSB0aGF0XG4gKiBpcyBub3QgSlNPTiBhdCBhbGwgKGEgQ0xJIGxvZyBsaW5lLCBhIHRydW5jYXRlZCBmaW5hbCB3cml0ZSkgaXMgY291bnRlZCB0aGVcbiAqIHNhbWUgd2F5LiBOb3RoaW5nIGlzIGRyb3BwZWQgaW4gc2lsZW5jZS5cbiAqXG4gKiBUaGUgY2xhc3NpZmljYXRpb24gcnVsZXMgdGhhdCBtYXR0ZXIgbW9zdCBoZXJlIGFyZSB0aGUgdHdvIHRoZSBpc3N1ZSBuYW1lczpcbiAqIGEgKio0MDEvNDAzIGlzIGF1dGhlbnRpY2F0aW9uKiosIG5ldmVyIGFuIHVuYXZhaWxhYmxlIG1vZGVsLCBhbmQgYSAqKjQyOSBpc1xuICogYSB0cmFuc2llbnQgcmF0ZSBsaW1pdCoqLCBuZXZlciBhbiBleGhhdXN0ZWQgc3Vic2NyaXB0aW9uLiBPbmx5IGEgcmVmdXNhbFxuICogdGhhdCBzYXlzIHRoZSB3aW5kb3cgaXMgc3BlbnQgaXMgYHF1b3RhLWV4aGF1c3RlZGAsIGFuZCBvbmx5IHRoZW4gaXMgYVxuICogc2NvcGUgb3IgYSByZXNldCByZXBvcnRlZCDigJQgYW4gdW5zdGF0ZWQgd2luZG93IHN0YXlzIGBcInVua25vd25cImAuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQge1xuICB0eXBlIEFnZW50RGVjb2RlZE91dHB1dCxcbiAgdHlwZSBBZ2VudEZhaWx1cmUsXG4gIGFnZW50RmFpbHVyZSxcbiAgdHlwZSBBZ2VudE91dHB1dEFkYXB0ZXIsXG4gIHR5cGUgQWdlbnRRdW90YSxcbiAgdHlwZSBBZ2VudFJ1blN0cmVhbXMsXG4gIHR5cGUgQWdlbnRTdHJ1Y3R1cmVkRXJyb3IsXG4gIHR5cGUgQWdlbnRUZXJtaW5hbFN0YXR1cyxcbiAgdHlwZSBBZ2VudFRleHRTb3VyY2UsXG4gIEJBTEFOQ0VfRVhIQVVTVEVEX1JFLFxuICBjbGFzc2lmeVByb2Nlc3NPdXRjb21lLFxuICBkZXRlY3RRdW90YVNjb3BlLFxuICBleHRyYWN0SHR0cFN0YXR1cyxcbiAgZXh0cmFjdFJldHJ5QWZ0ZXJTZWNvbmRzLFxuICBmYWlsdXJlTWVzc2FnZSxcbiAgaXNOZXR3b3JrU3RhdHVzLFxuICBwYXJzZUpzb25sRXZlbnRzLFxuICByZWFkTnVtYmVyLFxuICByZWFkT2JqZWN0LFxuICByZWFkU3RyaW5nLFxuICByZWRhY3RlZEV2aWRlbmNlLFxufSBmcm9tIFwiLi9hZ2VudF9vdXRwdXQudHNcIjtcbmltcG9ydCB7IGlzQ29kZXhBdXRoRXJyb3IgfSBmcm9tIFwiLi9jb2RleF9hdXRoLnRzXCI7XG4vLyBIZWFwIGV4aGF1c3Rpb24gaXMgYSBydW50aW1lIGZhY3QsIG5vdCBhIHZlbmRvcidzIHZvY2FidWxhcnk6IHRoZSBvbmVcbi8vIHByZWRpY2F0ZSBpcyByZXVzZWQgcmF0aGVyIHRoYW4gYSBzZWNvbmQgY29weSBvZiB0aGUgc2FtZSBwYXR0ZXJuc1xuLy8gKElzc3VlICMxNjk1KS4gSXQgbGl2ZXMgYmVzaWRlIENsYXVkZSdzIG90aGVyIGRldGVjdG9ycyBmb3IgaGlzdG9yaWNhbFxuLy8gcmVhc29ucyBvbmx5LlxuaW1wb3J0IHsgZGV0ZWN0T3V0T2ZNZW1vcnkgfSBmcm9tIFwiLi9jbGF1ZGVfZXhlY3V0b3IudHNcIjtcbmltcG9ydCB0eXBlIHsgVG9rZW5Vc2FnZSB9IGZyb20gXCIuL3Rva2VuX3VzYWdlLnRzXCI7XG5cbi8qKiBUaGUgcHJvdmlkZXIgaWQgdGhpcyBhZGFwdGVyIGRlY29kZXMgZm9yLiAqL1xuY29uc3QgUFJPVklERVJfSUQgPSBcImNvZGV4XCI7XG5cbi8qKiBUcmFuc3BvcnQgZmFpbHVyZXMgdGhlIENMSSByZXBvcnRzIGluIHByb3NlLiAqL1xuY29uc3QgTkVUV09SS19SRSA9XG4gIC9vdmVybG9hZGVkfGhpZ2ggZGVtYW5kfGVjb25ucmVzZXR8ZWNvbm5yZWZ1c2VkfGV0aW1lZG91dHxlbm90Zm91bmR8c29ja2V0IGhhbmcgdXB8c3RyZWFtIGRpc2Nvbm5lY3RlZHxjb25uZWN0aW9uICg/OnJlc2V0fHJlZnVzZWR8Y2xvc2VkKS9pO1xuXG4vKiogQSByZWZ1c2FsIGFib3V0IHRoZSBtb2RlbCByYXRoZXIgdGhhbiB0aGUgY3JlZGVudGlhbCBvciB0aGUgd2luZG93LiAqL1xuY29uc3QgTU9ERUxfVU5BVkFJTEFCTEVfUkUgPVxuICAvbW9kZWxfbm90X2ZvdW5kfHVua25vd24gbW9kZWx8dW5zdXBwb3J0ZWQgbW9kZWx8bW9kZWxbXlxcbl17MCw0MH0oPzpkb2VzIG5vdCBleGlzdHxub3QgZm91bmR8dW5hdmFpbGFibGV8bm90IGF2YWlsYWJsZXxpcyBub3Qgc3VwcG9ydGVkKXxkbyg/OmVzKT8gbm90IGhhdmUgYWNjZXNzIHRvIGl0L2k7XG5cbi8qKiBBIHJlZnVzYWwgdGhhdCBzYXlzIHRoZSBzdWJzY3JpcHRpb24gd2luZG93IGl0c2VsZiBpcyBzcGVudC4gKi9cbmNvbnN0IFFVT1RBX1JFID1cbiAgL3VzYWdlX2xpbWl0fHVzYWdlIGxpbWl0fHF1b3RhW15cXG5dezAsMjB9KD86ZXhoYXVzdGVkfGV4Y2VlZGVkKXxvdXQgb2YgY3JlZGl0c3xwbGFuIGxpbWl0fGhpdCB5b3VyICg/OndlZWtseXxtb250aGx5fGRhaWx5KT8gP2xpbWl0L2k7XG5cbi8qKiBBIHRyYW5zaWVudCBsaW1pdCBvbiB0aGUgcmF0ZSBvZiByZXF1ZXN0cy4gKi9cbmNvbnN0IFJBVEVfTElNSVRfUkUgPSAvcmF0ZVtfIF1saW1pdHx0b28gbWFueSByZXF1ZXN0c3xcXGI0MjlcXGIvaTtcblxuLyoqXG4gKiBUaGUgQ0xJIHJlZnVzaW5nIHRoZSBzZXNzaW9uIGl0IHdhcyBhc2tlZCB0byByZXN1bWUuXG4gKlxuICogYGNvZGV4IGV4ZWMgcmVzdW1lYCBuYW1lcyBhIHNlc3Npb24gQ29kZXggbXVzdCBzdGlsbCBob2xkOyBhIHJvbGxlZCBvclxuICogcHJ1bmVkIG9uZSBpcyByZWZ1c2VkIGJlZm9yZSBhbnkgbW9kZWwgY2FsbCwgZXhhY3RseSBhcyBDbGF1ZGUncyBzZXNzaW9uXG4gKiBmbGFncyBhcmUuIEFuY2hvcmVkIHRvIHNlc3Npb24gdm9jYWJ1bGFyeSBzbyBhbiB1bnJlbGF0ZWQgXCJub3QgZm91bmRcIlxuICogY2Fubm90IG1hdGNoLlxuICovXG5jb25zdCBJTlZBTElEX1NFU1NJT05fUkUgPVxuICAvc2Vzc2lvbltfIF0oPzpub3RbXyBdZm91bmR8ZXhwaXJlZHxpbnZhbGlkKXwoPzpub3x1bmtub3dufGludmFsaWR8ZXhwaXJlZClbXlxcbl17MCwyMH1zZXNzaW9ufHRocmVhZFtfIF1ub3RbXyBdZm91bmR8bm8gKD86cHJldmlvdXN8cmVjb3JkZWQpIHNlc3Npb24vaTtcblxuLyoqXG4gKiBUaGUgZXZlbnQgYm9keSBhbmQgaXRzIGtpbmQsIHdoaWNoZXZlciBlbnZlbG9wZSBnZW5lcmF0aW9uIGNhcnJpZWQgaXQuXG4gKlxuICogQSBwcm90b2NvbCBsaW5lIG5lc3RzIGV2ZXJ5dGhpbmcgdW5kZXIgYG1zZ2A7IHRoZSBleHBlcmltZW50YWwgc2NoZW1hIHB1dHNcbiAqIGl0IGF0IHRoZSB0b3AgbGV2ZWwuIEJvdGggcmVkdWNlIHRvIFwiYSBraW5kIGFuZCBhIGJvZHlcIiBoZXJlLCBzbyBub3RoaW5nXG4gKiBkb3duc3RyZWFtIGtub3dzIHdoaWNoIGdlbmVyYXRpb24gaXQgaXMgcmVhZGluZy5cbiAqL1xuZnVuY3Rpb24gZXZlbnRCb2R5KFxuICB2YWx1ZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4pOiB7IGtpbmQ6IHN0cmluZzsgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IG1zZyA9IHJlYWRPYmplY3QodmFsdWUubXNnKTtcbiAgaWYgKG1zZyAmJiByZWFkU3RyaW5nKG1zZy50eXBlKSkge1xuICAgIHJldHVybiB7IGtpbmQ6IHJlYWRTdHJpbmcobXNnLnR5cGUpISwgYm9keTogbXNnIH07XG4gIH1cbiAgY29uc3Qga2luZCA9IHJlYWRTdHJpbmcodmFsdWUudHlwZSk7XG4gIHJldHVybiBraW5kID8geyBraW5kLCBib2R5OiB2YWx1ZSB9IDogdW5kZWZpbmVkO1xufVxuXG4vKiogQW4gaXRlbSBldmVudCdzIG93biB0eXBlLCB1bmRlciBlaXRoZXIgb2YgdGhlIHR3byBmaWVsZCBuYW1lcyBpbiB1c2UuICovXG5mdW5jdGlvbiBpdGVtVHlwZShpdGVtOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiByZWFkU3RyaW5nKGl0ZW0uaXRlbV90eXBlKSA/PyByZWFkU3RyaW5nKGl0ZW0udHlwZSk7XG59XG5cbi8qKiBDb2RleCdzIHRva2VuIGNvdW50cywgbWFwcGVkIG9udG8gdGhlIHNoYXJlZCB7QGxpbmsgVG9rZW5Vc2FnZX0gc2hhcGUuICovXG5mdW5jdGlvbiB1c2FnZUZyb20oc291cmNlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFRva2VuVXNhZ2UgfCB1bmRlZmluZWQge1xuICBjb25zdCBpbnB1dCA9IHJlYWROdW1iZXIoc291cmNlLmlucHV0X3Rva2Vucyk7XG4gIGNvbnN0IG91dHB1dCA9IHJlYWROdW1iZXIoc291cmNlLm91dHB1dF90b2tlbnMpO1xuICBpZiAoaW5wdXQgPT09IHVuZGVmaW5lZCAmJiBvdXRwdXQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIHtcbiAgICBpbnB1dFRva2VuczogaW5wdXQgPz8gMCxcbiAgICBvdXRwdXRUb2tlbnM6IG91dHB1dCA/PyAwLFxuICAgIC8vIENvZGV4IHJlcG9ydHMgY2FjaGVkICppbnB1dCogdG9rZW5zIGFuZCBoYXMgbm8gY2FjaGUtd3JpdGUgY291bnRlciwgc29cbiAgICAvLyB0aGUgd3JpdGUgY291bnQgc3RheXMgMCByYXRoZXIgdGhhbiBiZWluZyBpbnZlbnRlZCBmcm9tIHRoZSByZWFkLlxuICAgIGNhY2hlQ3JlYXRpb25Ub2tlbnM6IDAsXG4gICAgY2FjaGVSZWFkVG9rZW5zOiByZWFkTnVtYmVyKHNvdXJjZS5jYWNoZWRfaW5wdXRfdG9rZW5zKSA/PyAwLFxuICB9O1xufVxuXG4vKiogQSBgcmF0ZV9saW1pdHNgIHdpbmRvdyBmcm9tIGEgYHRva2VuX2NvdW50YCBldmVudCwgd2hlbiBvbmUgaXMgcHJlc2VudC4gKi9cbmZ1bmN0aW9uIHF1b3RhRnJvbShcbiAgcmF0ZUxpbWl0czogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4pOiBBZ2VudFF1b3RhIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcHJpbWFyeSA9IHJlYWRPYmplY3QocmF0ZUxpbWl0cy5wcmltYXJ5KSA/P1xuICAgIHJlYWRPYmplY3QocmF0ZUxpbWl0cy5zZWNvbmRhcnkpO1xuICBpZiAoIXByaW1hcnkpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHVzZWRQZXJjZW50ID0gcmVhZE51bWJlcihwcmltYXJ5LnVzZWRfcGVyY2VudCk7XG4gIGNvbnN0IHdpbmRvd01pbnV0ZXMgPSByZWFkTnVtYmVyKHByaW1hcnkud2luZG93X21pbnV0ZXMpO1xuICBjb25zdCByZXNldHNJbiA9IHJlYWROdW1iZXIocHJpbWFyeS5yZXNldHNfaW5fc2Vjb25kcyk7XG4gIHJldHVybiB7XG4gICAgLy8gQSB3aW5kb3cgbGVuZ3RoIGlzIGEgZmFjdDsgYSBuYW1lIGZvciBpdCBpcyBub3QsIHVubGVzcyBpdCBtYXRjaGVzIG9uZVxuICAgIC8vIG9mIHRoZSBuYW1lZCB3aW5kb3dzIGV4YWN0bHkuXG4gICAgc2NvcGU6IHdpbmRvd01pbnV0ZXMgPT09IDMwMFxuICAgICAgPyBcImZpdmUtaG91clwiXG4gICAgICA6IHdpbmRvd01pbnV0ZXMgPT09IDEwXzA4MFxuICAgICAgPyBcIndlZWtseVwiXG4gICAgICA6IFwidW5rbm93blwiLFxuICAgIC4uLih1c2VkUGVyY2VudCAhPT0gdW5kZWZpbmVkID8geyB1c2VkRnJhY3Rpb246IHVzZWRQZXJjZW50IC8gMTAwIH0gOiB7fSksXG4gICAgLi4uKHJlc2V0c0luICE9PSB1bmRlZmluZWQgPyB7IHJlc2V0c0luU2Vjb25kczogcmVzZXRzSW4gfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqIFRoZSBlcnJvciBvYmplY3Qgb2YgYSBgdHVybi5mYWlsZWRgIC8gYGVycm9yYCBldmVudCwgaW4gZWl0aGVyIGdlbmVyYXRpb24uICovXG5mdW5jdGlvbiBlcnJvck9iamVjdChcbiAgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiByZWFkT2JqZWN0KGJvZHkuZXJyb3IpID8/XG4gICAgKHJlYWRTdHJpbmcoYm9keS5tZXNzYWdlKSA/IGJvZHkgOiB1bmRlZmluZWQpO1xufVxuXG4vKipcbiAqIERlY29kZSBvbmUgYGNvZGV4IGV4ZWMgLS1qc29uYCBzdGRvdXQgaW50byB0aGUgc2hhcmVkIGNvbnRyYWN0LlxuICpcbiAqIEBwYXJhbSBzdGRvdXQgLSBSYXcgc3Rkb3V0IGZyb20gdGhlIENMSS5cbiAqIEByZXR1cm5zIFRoZSBkZWNvZGVkIHJ1bjsgYHRleHRgIGlzIGVtcHR5IHVubGVzcyB0aGUgYWdlbnQgYWN0dWFsbHkgc2FpZFxuICogICBzb21ldGhpbmcsIHNvIGEgc3RyZWFtIG9mIGVudmVsb3BlcyBpcyBuZXZlciBtaXN0YWtlbiBmb3IgcHJvc2UuXG4gKi9cbmZ1bmN0aW9uIGRlY29kZUNvZGV4T3V0cHV0KHN0ZG91dDogc3RyaW5nKTogQWdlbnREZWNvZGVkT3V0cHV0IHtcbiAgY29uc3QgeyBldmVudHMsIG1hbGZvcm1lZExpbmVzIH0gPSBwYXJzZUpzb25sRXZlbnRzKHN0ZG91dCk7XG4gIGxldCBtYWxmb3JtZWRFdmVudHMgPSAwO1xuXG4gIGxldCB0ZXh0ID0gXCJcIjtcbiAgbGV0IHRleHRTb3VyY2U6IEFnZW50VGV4dFNvdXJjZSA9IFwibm9uZVwiO1xuICBsZXQgc3RhdHVzOiBBZ2VudFRlcm1pbmFsU3RhdHVzID0gZXZlbnRzLmxlbmd0aCA9PT0gMFxuICAgID8gXCJ1bmtub3duXCJcbiAgICA6IFwiaW5jb21wbGV0ZVwiO1xuICBsZXQgc2Vzc2lvbklkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCB1c2FnZTogVG9rZW5Vc2FnZSB8IHVuZGVmaW5lZDtcbiAgbGV0IHF1b3RhOiBBZ2VudFF1b3RhIHwgdW5kZWZpbmVkO1xuICBsZXQgcHJvZ3Jlc3NFdmVudHMgPSAwO1xuICBsZXQgbGFzdDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBjb25zdCBlcnJvcnM6IEFnZW50U3RydWN0dXJlZEVycm9yW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IHsgdmFsdWUgfSBvZiBldmVudHMpIHtcbiAgICBjb25zdCBldmVudCA9IGV2ZW50Qm9keSh2YWx1ZSk7XG4gICAgaWYgKCFldmVudCkge1xuICAgICAgLy8gQSBKU09OIG9iamVjdCB3aXRoIG5vIGV2ZW50IGtpbmQgdW5kZXIgZWl0aGVyIGVudmVsb3BlIGlzIG5vdCBhXG4gICAgICAvLyBkZWNvZGFibGUgZXZlbnQ6IGNvdW50ZWQgbGlrZSBhIG1hbGZvcm1lZCBsaW5lIHJhdGhlciB0aGFuIGRyb3BwZWQsXG4gICAgICAvLyBzbyBhIHNjaGVtYSBjaGFuZ2UgcmVhZHMgYXMgXCJ1bnJlYWRhYmxlXCIsIG5ldmVyIGFzIFwibm90aGluZ1xuICAgICAgLy8gaGFwcGVuZWRcIi5cbiAgICAgIG1hbGZvcm1lZEV2ZW50cysrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHsga2luZCwgYm9keSB9ID0gZXZlbnQ7XG5cbiAgICAvLyBTZXNzaW9uIGlkZW50aXR5LCB1bmRlciBlaXRoZXIgZ2VuZXJhdGlvbidzIG5hbWUgZm9yIGl0LlxuICAgIHNlc3Npb25JZCA9IHJlYWRTdHJpbmcoYm9keS50aHJlYWRfaWQpID8/IHJlYWRTdHJpbmcoYm9keS5zZXNzaW9uX2lkKSA/P1xuICAgICAgc2Vzc2lvbklkO1xuXG4gICAgaWYgKGtpbmQgPT09IFwiaXRlbS5zdGFydGVkXCIgfHwga2luZCA9PT0gXCJpdGVtLnVwZGF0ZWRcIikge1xuICAgICAgcHJvZ3Jlc3NFdmVudHMrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChraW5kID09PSBcIml0ZW0uY29tcGxldGVkXCIpIHtcbiAgICAgIHByb2dyZXNzRXZlbnRzKys7XG4gICAgICBjb25zdCBpdGVtID0gcmVhZE9iamVjdChib2R5Lml0ZW0pO1xuICAgICAgaWYgKCFpdGVtKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHR5cGUgPSBpdGVtVHlwZShpdGVtKTtcbiAgICAgIGlmICh0eXBlID09PSBcImFnZW50X21lc3NhZ2VcIikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gcmVhZFN0cmluZyhpdGVtLnRleHQpID8/IHJlYWRTdHJpbmcoaXRlbS5tZXNzYWdlKTtcbiAgICAgICAgaWYgKG1lc3NhZ2UpIHtcbiAgICAgICAgICB0ZXh0ID0gbWVzc2FnZTtcbiAgICAgICAgICB0ZXh0U291cmNlID0gXCJmaW5hbFwiO1xuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgbGFzdCA9IHJlYWRTdHJpbmcoaXRlbS5jb21tYW5kKSA/PyByZWFkU3RyaW5nKGl0ZW0udGl0bGUpID8/IGxhc3Q7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBUaGUgcHJvdG9jb2wgZW52ZWxvcGUncyBvd24gbWVzc2FnZSBhbmQgY29tcGxldGlvbiBldmVudHMuXG4gICAgaWYgKGtpbmQgPT09IFwiYWdlbnRfbWVzc2FnZVwiKSB7XG4gICAgICBwcm9ncmVzc0V2ZW50cysrO1xuICAgICAgY29uc3QgbWVzc2FnZSA9IHJlYWRTdHJpbmcoYm9keS5tZXNzYWdlKSA/PyByZWFkU3RyaW5nKGJvZHkudGV4dCk7XG4gICAgICBpZiAobWVzc2FnZSkge1xuICAgICAgICB0ZXh0ID0gbWVzc2FnZTtcbiAgICAgICAgdGV4dFNvdXJjZSA9IFwiZmluYWxcIjtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoa2luZCA9PT0gXCJ0YXNrX2NvbXBsZXRlXCIpIHtcbiAgICAgIHN0YXR1cyA9IFwiY29tcGxldGVkXCI7XG4gICAgICBjb25zdCBtZXNzYWdlID0gcmVhZFN0cmluZyhib2R5Lmxhc3RfYWdlbnRfbWVzc2FnZSk7XG4gICAgICBpZiAobWVzc2FnZSkge1xuICAgICAgICB0ZXh0ID0gbWVzc2FnZTtcbiAgICAgICAgdGV4dFNvdXJjZSA9IFwiZmluYWxcIjtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChraW5kID09PSBcInR1cm4uY29tcGxldGVkXCIpIHtcbiAgICAgIHN0YXR1cyA9IFwiY29tcGxldGVkXCI7XG4gICAgICBjb25zdCByZXBvcnRlZCA9IHJlYWRPYmplY3QoYm9keS51c2FnZSk7XG4gICAgICBpZiAocmVwb3J0ZWQpIHVzYWdlID0gdXNhZ2VGcm9tKHJlcG9ydGVkKSA/PyB1c2FnZTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChraW5kID09PSBcInRva2VuX2NvdW50XCIpIHtcbiAgICAgIHByb2dyZXNzRXZlbnRzKys7XG4gICAgICBjb25zdCBpbmZvID0gcmVhZE9iamVjdChib2R5LmluZm8pO1xuICAgICAgY29uc3QgdG90YWxzID0gaW5mbyA/IHJlYWRPYmplY3QoaW5mby50b3RhbF90b2tlbl91c2FnZSkgOiB1bmRlZmluZWQ7XG4gICAgICBpZiAodG90YWxzKSB1c2FnZSA9IHVzYWdlRnJvbSh0b3RhbHMpID8/IHVzYWdlO1xuICAgICAgY29uc3QgcmF0ZUxpbWl0cyA9IHJlYWRPYmplY3QoYm9keS5yYXRlX2xpbWl0cykgPz9cbiAgICAgICAgKGluZm8gPyByZWFkT2JqZWN0KGluZm8ucmF0ZV9saW1pdHMpIDogdW5kZWZpbmVkKTtcbiAgICAgIGlmIChyYXRlTGltaXRzKSBxdW90YSA9IHF1b3RhRnJvbShyYXRlTGltaXRzKSA/PyBxdW90YTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGlmIChraW5kID09PSBcInR1cm4uZmFpbGVkXCIgfHwga2luZCA9PT0gXCJlcnJvclwiIHx8IGtpbmQgPT09IFwic3RyZWFtX2Vycm9yXCIpIHtcbiAgICAgIHN0YXR1cyA9IFwiZmFpbGVkXCI7XG4gICAgICBjb25zdCBkZXRhaWwgPSBlcnJvck9iamVjdChib2R5KTtcbiAgICAgIGlmIChkZXRhaWwpIHtcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IHJlYWRTdHJpbmcoZGV0YWlsLm1lc3NhZ2UpID8/IGtpbmQ7XG4gICAgICAgIGNvbnN0IGh0dHBTdGF0dXMgPSByZWFkTnVtYmVyKGRldGFpbC5odHRwX3N0YXR1cykgPz9cbiAgICAgICAgICByZWFkTnVtYmVyKGRldGFpbC5zdGF0dXMpID8/IGV4dHJhY3RIdHRwU3RhdHVzKG1lc3NhZ2UpO1xuICAgICAgICBlcnJvcnMucHVzaCh7XG4gICAgICAgICAgc291cmNlOiBraW5kLFxuICAgICAgICAgIG1lc3NhZ2UsXG4gICAgICAgICAgLi4uKHJlYWRTdHJpbmcoZGV0YWlsLnR5cGUpID8geyBjb2RlOiByZWFkU3RyaW5nKGRldGFpbC50eXBlKSB9IDoge30pLFxuICAgICAgICAgIC4uLihodHRwU3RhdHVzICE9PSB1bmRlZmluZWQgPyB7IGh0dHBTdGF0dXMgfSA6IHt9KSxcbiAgICAgICAgICByYXc6IGRldGFpbCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBpZiAoa2luZCA9PT0gXCJ0YXNrX3N0YXJ0ZWRcIiB8fCBraW5kID09PSBcInR1cm4uc3RhcnRlZFwiKSBjb250aW51ZTtcbiAgICBwcm9ncmVzc0V2ZW50cysrO1xuICB9XG5cbiAgLy8gT3V0cHV0IHRoYXQgaXMgbm90IHRoZSBDTEkncyBldmVudCBmb3JtYXQgYXQgYWxsIOKAlCBhIHBhbmljLCBhIHBsYWluXG4gIC8vIGVycm9yIOKAlCBpcyBsZWdpdGltYXRlbHkgdGhlIENMSSdzIG93biB0ZXh0IGFuZCBtdXN0IG5vdCBiZSB0aHJvd24gYXdheVxuICAvLyBqdXN0IGJlY2F1c2UgaXQgaXMgbm90IGFuIGV2ZW50IChJc3N1ZSAjMTY5NSkuXG4gIGlmIChldmVudHMubGVuZ3RoID09PSAwICYmIHN0ZG91dC50cmltKCkpIHtcbiAgICB0ZXh0ID0gc3Rkb3V0O1xuICAgIHRleHRTb3VyY2UgPSBcInJhd1wiO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICB0ZXh0LFxuICAgIHRleHRTb3VyY2UsXG4gICAgc3RhdHVzLFxuICAgIC4uLihzZXNzaW9uSWQgPyB7IHNlc3Npb25JZCB9IDoge30pLFxuICAgIC4uLih1c2FnZSA/IHsgdXNhZ2UgfSA6IHt9KSxcbiAgICBwcm9ncmVzczogeyBldmVudHM6IHByb2dyZXNzRXZlbnRzLCAuLi4obGFzdCA/IHsgbGFzdCB9IDoge30pIH0sXG4gICAgZXJyb3JzLFxuICAgIC4uLihxdW90YSA/IHsgcXVvdGEgfSA6IHt9KSxcbiAgICBtYWxmb3JtZWRMaW5lczogbWFsZm9ybWVkTGluZXMgKyBtYWxmb3JtZWRFdmVudHMsXG4gIH07XG59XG5cbi8qKiBUaGUgd2luZG93IGEgQ29kZXggcmVmdXNhbCBkZXNjcmliZXMsIGZyb20gaXRzIG93biBmaWVsZHMgd2hlcmUgcHJlc2VudC4gKi9cbmZ1bmN0aW9uIGNvZGV4UXVvdGEoXG4gIGVycm9yOiBBZ2VudFN0cnVjdHVyZWRFcnJvciB8IHVuZGVmaW5lZCxcbiAgc3VyZmFjZTogc3RyaW5nLFxuICBub3dNczogbnVtYmVyLFxuICByZXBvcnRlZD86IEFnZW50UXVvdGEsXG4pOiBBZ2VudFF1b3RhIHtcbiAgY29uc3QgcmVzZXRzSW4gPSBlcnJvciA/IHJlYWROdW1iZXIoZXJyb3IucmF3LnJlc2V0c19pbl9zZWNvbmRzKSA6IHVuZGVmaW5lZDtcbiAgY29uc3QgcmVzZXRzQXQgPSBlcnJvciA/IHJlYWROdW1iZXIoZXJyb3IucmF3LnJlc2V0c19hdCkgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHN0YXRlZCA9IGVycm9yPy5tZXNzYWdlID8/IHN1cmZhY2U7XG4gIGNvbnN0IGlzb1Jlc2V0ID0gL1xcYihcXGR7NH0tXFxkezJ9LVxcZHsyfVRbXFxkOi5dK1opXFxiLy5leGVjKHN0YXRlZCk/LlsxXTtcbiAgY29uc3QgcmVzZXRFcG9jaE1zID0gcmVzZXRzSW4gIT09IHVuZGVmaW5lZFxuICAgID8gbm93TXMgKyByZXNldHNJbiAqIDEwMDBcbiAgICA6IHJlc2V0c0F0ICE9PSB1bmRlZmluZWRcbiAgICA/IHJlc2V0c0F0ICogMTAwMFxuICAgIDogaXNvUmVzZXRcbiAgICA/IERhdGUucGFyc2UoaXNvUmVzZXQpXG4gICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHN0YXRlZFNjb3BlID0gZGV0ZWN0UXVvdGFTY29wZShzdGF0ZWQpO1xuICAvLyBUaGUgd2luZG93IHRoZSBzdHJlYW0gYWxyZWFkeSByZXBvcnRlZCAoYHRva2VuX2NvdW50LnJhdGVfbGltaXRzYCkgaXNcbiAgLy8gc3RydWN0dXJlZCBldmlkZW5jZTogaXQgZmlsbHMgd2hhdCB0aGUgcmVmdXNhbCdzIHByb3NlIGxlZnQgdW5zdGF0ZWQsXG4gIC8vIGFuZCBuZXZlciBvdmVycmlkZXMgd2hhdCB0aGUgcmVmdXNhbCBkaWQgc3RhdGUuXG4gIHJldHVybiB7XG4gICAgc2NvcGU6IHN0YXRlZFNjb3BlID09PSBcInVua25vd25cIlxuICAgICAgPyByZXBvcnRlZD8uc2NvcGUgPz8gXCJ1bmtub3duXCJcbiAgICAgIDogc3RhdGVkU2NvcGUsXG4gICAgLi4uKHJlc2V0RXBvY2hNcyAhPT0gdW5kZWZpbmVkICYmIE51bWJlci5pc0Zpbml0ZShyZXNldEVwb2NoTXMpXG4gICAgICA/IHsgcmVzZXRFcG9jaE1zIH1cbiAgICAgIDogcmVwb3J0ZWQ/LnJlc2V0c0luU2Vjb25kcyAhPT0gdW5kZWZpbmVkXG4gICAgICA/IHsgcmVzZXRFcG9jaE1zOiBub3dNcyArIHJlcG9ydGVkLnJlc2V0c0luU2Vjb25kcyAqIDEwMDAgfVxuICAgICAgOiB7fSksXG4gICAgLi4uKHJlcG9ydGVkPy51c2VkRnJhY3Rpb24gIT09IHVuZGVmaW5lZFxuICAgICAgPyB7IHVzZWRGcmFjdGlvbjogcmVwb3J0ZWQudXNlZEZyYWN0aW9uIH1cbiAgICAgIDoge30pLFxuICB9O1xufVxuXG4vKipcbiAqIENsYXNzaWZ5IG9uZSBmYWlsZWQgQ29kZXggcnVuLlxuICpcbiAqIFNhbWUgb3JkZXIgYXMgZXZlcnkgYWRhcHRlcjogdGhlIHdvcmtlcidzIG93biBmYWN0cywgdGhlbiBhIGNsZWFuIGV4aXQgaXNcbiAqIG5vIGZhaWx1cmUgYXQgYWxsLCB0aGVuIHRoZSBDTEkncyBzdHJ1Y3R1cmVkIGV2ZW50cywgdGhlbiBpdHMgcHJvc2UuXG4gKlxuICogQHBhcmFtIHN0cmVhbXMgLSBUaGUgcnVuJ3Mgc3RyZWFtcyBhbmQgcHJvY2VzcyBmYWN0cy5cbiAqIEBwYXJhbSBkZWNvZGVkIC0gVGhlIGRlY29kZWQgb3V0cHV0IGZyb20ge0BsaW5rIGRlY29kZUNvZGV4T3V0cHV0fS5cbiAqIEByZXR1cm5zIFRoZSBub3JtYWxpc2VkIGZhaWx1cmUsIG9yIHVuZGVmaW5lZCB3aGVuIHRoZSBydW4gZGlkIG5vdCBmYWlsLlxuICovXG5mdW5jdGlvbiBjbGFzc2lmeUNvZGV4RmFpbHVyZShcbiAgc3RyZWFtczogQWdlbnRSdW5TdHJlYW1zLFxuICBkZWNvZGVkOiBBZ2VudERlY29kZWRPdXRwdXQsXG4pOiBBZ2VudEZhaWx1cmUgfCB1bmRlZmluZWQge1xuICBjb25zdCBwcm9jZXNzID0gY2xhc3NpZnlQcm9jZXNzT3V0Y29tZShzdHJlYW1zKTtcbiAgaWYgKHByb2Nlc3MpIHJldHVybiBwcm9jZXNzO1xuXG4gIGlmIChzdHJlYW1zLmV4aXRDb2RlID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHN0ZGVyciA9IHN0cmVhbXMuc3RkZXJyID8/IFwiXCI7XG4gIGNvbnN0IG5vd01zID0gc3RyZWFtcy5ub3dNcyA/PyBEYXRlLm5vdygpO1xuICBjb25zdCBzdHJ1Y3R1cmVkVGV4dCA9IGRlY29kZWQuZXJyb3JzXG4gICAgLm1hcCgoZSkgPT4gYCR7ZS5jb2RlID8/IFwiXCJ9ICR7ZS5tZXNzYWdlfWApXG4gICAgLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IHN1cmZhY2UgPSBgJHtzdHJ1Y3R1cmVkVGV4dH1cXG4ke3N0ZGVycn1gO1xuICBjb25zdCBldmlkZW5jZVRleHQgPSByZWRhY3RlZEV2aWRlbmNlKHN1cmZhY2UpO1xuICBjb25zdCBzYXkgPSAoaGVhZGxpbmU6IHN0cmluZykgPT4gZmFpbHVyZU1lc3NhZ2UoaGVhZGxpbmUsIGV2aWRlbmNlVGV4dCk7XG5cbiAgLyoqIFBpY2sgdGhlIHN0cnVjdHVyZWQgZXJyb3IgdGhhdCBleHBsYWlucyB0aGUgcnVuLCB3aGVuIG9uZSBkb2VzLiAqL1xuICBjb25zdCBtYXRjaCA9ICh0ZXN0OiBSZWdFeHApID0+XG4gICAgZGVjb2RlZC5lcnJvcnMuZmluZCgoZSkgPT4gdGVzdC50ZXN0KGAke2UuY29kZSA/PyBcIlwifSAke2UubWVzc2FnZX1gKSk7XG5cbiAgY29uc3QgaHR0cFN0YXR1cyA9IGRlY29kZWQuZXJyb3JzLmZpbmQoKGUpID0+IGUuaHR0cFN0YXR1cyAhPT0gdW5kZWZpbmVkKVxuICAgID8uaHR0cFN0YXR1cyA/PyBleHRyYWN0SHR0cFN0YXR1cyhzdXJmYWNlKTtcblxuICBpZiAoZGV0ZWN0T3V0T2ZNZW1vcnkoYCR7ZGVjb2RlZC50ZXh0fVxcbiR7c3RkZXJyfWApKSB7XG4gICAgcmV0dXJuIGFnZW50RmFpbHVyZSh7XG4gICAgICBjYXRlZ29yeTogXCJvdXQtb2YtbWVtb3J5XCIsXG4gICAgICBtZXNzYWdlOiBzYXkoXCJUaGUgQ29kZXggQ0xJIHJhbiBvdXQgb2YgbWVtb3J5XCIpLFxuICAgICAgZXZpZGVuY2U6IFwicHJvc2VcIixcbiAgICAgIGVycm9yczogZGVjb2RlZC5lcnJvcnMsXG4gICAgfSk7XG4gIH1cblxuICAvLyBBdXRoZW50aWNhdGlvbiBiZWZvcmUgYW55dGhpbmcgYSBzdGF0dXMgY29kZSBjb3VsZCBiZSByZWFkIGFzOiBhIHJlamVjdGVkXG4gIC8vIGNyZWRlbnRpYWwgYW5zd2VycyA0MDEvNDAzIGFuZCBtdXN0IG5ldmVyIHdhbGsgdGhlIG1vZGVsIGxhZGRlci5cbiAgY29uc3QgYXV0aEVycm9yID0gbWF0Y2goL2F1dGh8dW5hdXRob3JpW3N6XWVkfGxvZ2lufGFwaVtfIF1rZXkvaSk7XG4gIGlmIChhdXRoRXJyb3IgfHwgaHR0cFN0YXR1cyA9PT0gNDAxIHx8IGh0dHBTdGF0dXMgPT09IDQwMykge1xuICAgIHJldHVybiBhZ2VudEZhaWx1cmUoe1xuICAgICAgY2F0ZWdvcnk6IFwiYXV0aGVudGljYXRpb25cIixcbiAgICAgIG1lc3NhZ2U6IHNheShcIkNvZGV4IHJlZnVzZWQgdGhlIGNyZWRlbnRpYWxcIiksXG4gICAgICBldmlkZW5jZTogYXV0aEVycm9yID8gXCJzdHJ1Y3R1cmVkXCIgOiBcInByb3NlXCIsXG4gICAgICAuLi4oaHR0cFN0YXR1cyAhPT0gdW5kZWZpbmVkID8geyBodHRwU3RhdHVzIH0gOiB7fSksXG4gICAgICBlcnJvcnM6IGRlY29kZWQuZXJyb3JzLFxuICAgIH0pO1xuICB9XG4gIGlmIChpc0NvZGV4QXV0aEVycm9yKHN0ZGVycikpIHtcbiAgICByZXR1cm4gYWdlbnRGYWlsdXJlKHtcbiAgICAgIGNhdGVnb3J5OiBcImF1dGhlbnRpY2F0aW9uXCIsXG4gICAgICBtZXNzYWdlOiBzYXkoXCJDb2RleCByZWZ1c2VkIHRoZSBjcmVkZW50aWFsXCIpLFxuICAgICAgZXZpZGVuY2U6IFwicHJvc2VcIixcbiAgICAgIGVycm9yczogZGVjb2RlZC5lcnJvcnMsXG4gICAgfSk7XG4gIH1cblxuICAvLyBBbiBleGhhdXN0ZWQgd2luZG93OiBvbmx5IHdoZW4gdGhlIHJlZnVzYWwgc2F5cyB0aGUgd2luZG93IGlzIHNwZW50LlxuICAvLyBJc3N1ZSAjMjYxMzogYSBzcGVudCBiYWxhbmNlIChIVFRQIDQwMikgaXMgdGhlIHNhbWUgYWNjb3VudC13aWRlIHJlZnVzYWwuXG4gIGNvbnN0IHF1b3RhRXJyb3IgPSBtYXRjaChRVU9UQV9SRSkgPz8gbWF0Y2goQkFMQU5DRV9FWEhBVVNURURfUkUpO1xuICBpZiAoXG4gICAgcXVvdGFFcnJvciB8fCBRVU9UQV9SRS50ZXN0KHN0ZGVycikgfHwgQkFMQU5DRV9FWEhBVVNURURfUkUudGVzdChzdGRlcnIpXG4gICkge1xuICAgIHJldHVybiBhZ2VudEZhaWx1cmUoe1xuICAgICAgY2F0ZWdvcnk6IFwicXVvdGEtZXhoYXVzdGVkXCIsXG4gICAgICBtZXNzYWdlOiBzYXkoXCJDb2RleCdzIHN1YnNjcmlwdGlvbiB3aW5kb3cgaXMgZXhoYXVzdGVkXCIpLFxuICAgICAgZXZpZGVuY2U6IHF1b3RhRXJyb3IgPyBcInN0cnVjdHVyZWRcIiA6IFwicHJvc2VcIixcbiAgICAgIHF1b3RhOiBjb2RleFF1b3RhKHF1b3RhRXJyb3IsIHN1cmZhY2UsIG5vd01zLCBkZWNvZGVkLnF1b3RhKSxcbiAgICAgIC4uLihodHRwU3RhdHVzICE9PSB1bmRlZmluZWQgPyB7IGh0dHBTdGF0dXMgfSA6IHt9KSxcbiAgICAgIGVycm9yczogZGVjb2RlZC5lcnJvcnMsXG4gICAgfSk7XG4gIH1cblxuICAvLyBBIHJlZnVzZWQgc2Vzc2lvbiBpcyBhIHN0YXJ0LXVwIGZhaWx1cmU6IG5vdGhpbmcgYWZ0ZXIgaXQgY2FuIGJlIHJlYWRcbiAgLy8gZnJvbSB0aGlzIHJ1biwgYW5kIHRoZSByZW1lZHkgaXMgdGhlIHNlc3Npb24sIG5vdCB0aGUgbW9kZWwgb3IgYSB3YWl0LlxuICBjb25zdCBzZXNzaW9uRXJyb3IgPSBtYXRjaChJTlZBTElEX1NFU1NJT05fUkUpO1xuICBpZiAoc2Vzc2lvbkVycm9yIHx8IElOVkFMSURfU0VTU0lPTl9SRS50ZXN0KHN0ZGVycikpIHtcbiAgICByZXR1cm4gYWdlbnRGYWlsdXJlKHtcbiAgICAgIGNhdGVnb3J5OiBcImludmFsaWQtc2Vzc2lvblwiLFxuICAgICAgbWVzc2FnZTogc2F5KFwiQ29kZXggcmVmdXNlZCB0aGUgc2Vzc2lvbiBpdCB3YXMgYXNrZWQgdG8gcmVzdW1lXCIpLFxuICAgICAgZXZpZGVuY2U6IHNlc3Npb25FcnJvciA/IFwic3RydWN0dXJlZFwiIDogXCJwcm9zZVwiLFxuICAgICAgZXJyb3JzOiBkZWNvZGVkLmVycm9ycyxcbiAgICB9KTtcbiAgfVxuXG4gIGNvbnN0IG1vZGVsRXJyb3IgPSBtYXRjaChNT0RFTF9VTkFWQUlMQUJMRV9SRSk7XG4gIGlmIChtb2RlbEVycm9yIHx8IE1PREVMX1VOQVZBSUxBQkxFX1JFLnRlc3Qoc3RkZXJyKSkge1xuICAgIHJldHVybiBhZ2VudEZhaWx1cmUoe1xuICAgICAgY2F0ZWdvcnk6IFwibW9kZWwtdW5hdmFpbGFibGVcIixcbiAgICAgIG1lc3NhZ2U6IHNheShcIkNvZGV4IHJlZnVzZWQgdGhlIHJlcXVlc3RlZCBtb2RlbFwiKSxcbiAgICAgIGV2aWRlbmNlOiBtb2RlbEVycm9yID8gXCJzdHJ1Y3R1cmVkXCIgOiBcInByb3NlXCIsXG4gICAgICAuLi4oaHR0cFN0YXR1cyAhPT0gdW5kZWZpbmVkID8geyBodHRwU3RhdHVzIH0gOiB7fSksXG4gICAgICBlcnJvcnM6IGRlY29kZWQuZXJyb3JzLFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKFxuICAgIGlzTmV0d29ya1N0YXR1cyhodHRwU3RhdHVzKSB8fFxuICAgIChORVRXT1JLX1JFLnRlc3Qoc3VyZmFjZSkgJiYgIVJBVEVfTElNSVRfUkUudGVzdChzdXJmYWNlKSlcbiAgKSB7XG4gICAgcmV0dXJuIGFnZW50RmFpbHVyZSh7XG4gICAgICBjYXRlZ29yeTogXCJuZXR3b3JrXCIsXG4gICAgICBtZXNzYWdlOiBzYXkoXCJUaGUgQ29kZXggQ0xJIGNvdWxkIG5vdCByZWFjaCB0aGUgQVBJXCIpLFxuICAgICAgZXZpZGVuY2U6IFwicHJvc2VcIixcbiAgICAgIC4uLihodHRwU3RhdHVzICE9PSB1bmRlZmluZWQgPyB7IGh0dHBTdGF0dXMgfSA6IHt9KSxcbiAgICAgIGVycm9yczogZGVjb2RlZC5lcnJvcnMsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCByYXRlRXJyb3IgPSBtYXRjaChSQVRFX0xJTUlUX1JFKTtcbiAgaWYgKHJhdGVFcnJvciB8fCBodHRwU3RhdHVzID09PSA0MjkgfHwgUkFURV9MSU1JVF9SRS50ZXN0KHN0ZGVycikpIHtcbiAgICBjb25zdCByZXRyeUFmdGVyU2Vjb25kcyA9XG4gICAgICAocmF0ZUVycm9yID8gcmVhZE51bWJlcihyYXRlRXJyb3IucmF3LnJldHJ5X2FmdGVyX3NlY29uZHMpIDogdW5kZWZpbmVkKSA/P1xuICAgICAgICBleHRyYWN0UmV0cnlBZnRlclNlY29uZHMoc3VyZmFjZSk7XG4gICAgcmV0dXJuIGFnZW50RmFpbHVyZSh7XG4gICAgICBjYXRlZ29yeTogXCJyYXRlLWxpbWl0XCIsXG4gICAgICBtZXNzYWdlOiBzYXkoXCJDb2RleCByYXRlLWxpbWl0ZWQgdGhpcyByZXF1ZXN0XCIpLFxuICAgICAgZXZpZGVuY2U6IHJhdGVFcnJvciA/IFwic3RydWN0dXJlZFwiIDogXCJwcm9zZVwiLFxuICAgICAgLi4uKHJldHJ5QWZ0ZXJTZWNvbmRzICE9PSB1bmRlZmluZWQgPyB7IHJldHJ5QWZ0ZXJTZWNvbmRzIH0gOiB7fSksXG4gICAgICAuLi4oaHR0cFN0YXR1cyAhPT0gdW5kZWZpbmVkID8geyBodHRwU3RhdHVzIH0gOiB7fSksXG4gICAgICBlcnJvcnM6IGRlY29kZWQuZXJyb3JzLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIGFnZW50RmFpbHVyZSh7XG4gICAgY2F0ZWdvcnk6IFwidGFzay1mYWlsdXJlXCIsXG4gICAgbWVzc2FnZTogc2F5KGBUaGUgQ29kZXggQ0xJIGV4aXRlZCAke3N0cmVhbXMuZXhpdENvZGV9YCksXG4gICAgZXZpZGVuY2U6IGRlY29kZWQuZXJyb3JzLmxlbmd0aCA+IDAgPyBcInN0cnVjdHVyZWRcIiA6IFwicHJvY2Vzc1wiLFxuICAgIGVycm9yczogZGVjb2RlZC5lcnJvcnMsXG4gIH0pO1xufVxuXG4vKiogVGhlIENvZGV4IENMSSdzIG91dHB1dCBhZGFwdGVyLCBuYW1lZCBieSB0aGUgQ29kZXggZGVzY3JpcHRvci4gKi9cbmV4cG9ydCBjb25zdCBDT0RFWF9PVVRQVVRfQURBUFRFUjogQWdlbnRPdXRwdXRBZGFwdGVyID0ge1xuICBwcm92aWRlcklkOiBQUk9WSURFUl9JRCxcbiAgZGVjb2RlOiBkZWNvZGVDb2RleE91dHB1dCxcbiAgY2xhc3NpZnk6IGNsYXNzaWZ5Q29kZXhGYWlsdXJlLFxufTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQ0MsR0FFRCxTQUdFLFlBQVksRUFPWixvQkFBb0IsRUFDcEIsc0JBQXNCLEVBQ3RCLGdCQUFnQixFQUNoQixpQkFBaUIsRUFDakIsd0JBQXdCLEVBQ3hCLGNBQWMsRUFDZCxlQUFlLEVBQ2YsZ0JBQWdCLEVBQ2hCLFVBQVUsRUFDVixVQUFVLEVBQ1YsVUFBVSxFQUNWLGdCQUFnQixRQUNYLG9CQUFvQjtBQUMzQixTQUFTLGdCQUFnQixRQUFRLGtCQUFrQjtBQUNuRCx3RUFBd0U7QUFDeEUs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
// denoCacheMetadata=18352461886844451085,1314540837745465568