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
 */ import { agentFailure, BALANCE_EXHAUSTED_RE, classifyProcessOutcome, detectQuotaScope, extractHttpStatus, extractRetryAfterSeconds, failureMessage, isNetworkStatus, parseJsonlEvents, readString, redactedEvidence } from "./agent_output.ts";
import { isClaudeAuthError } from "./claude_auth.ts";
import { detectInvalidSessionId, detectModelUnavailable, detectOutOfMemory, detectRateLimit, detectUsageLimit, extractStreamJsonText, parseUsageLimitReset } from "./claude_executor.ts";
import { extractTokenUsage } from "./token_usage.ts";
/** The provider id this adapter decodes for. */ const PROVIDER_ID = "claude";
/** Transport failures the CLI reports in prose. */ const NETWORK_RE = /overloaded|econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|connection (?:reset|refused|closed)/i;
/** A refusal that names the model, as opposed to the credential. */ const MODEL_EVIDENCE_RE = /\bmodel\b|unrecogni[sz]ed_model|model_not_found/i;
/** The assistant text blocks of one `assistant` event, concatenated. */ function assistantText(event) {
  const message = event.message;
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content){
    if (block && typeof block === "object" && block.type === "text") {
      const text = readString(block.text);
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
 */ function collectErrors(events) {
  const errors = [];
  for (const { value } of events){
    const type = readString(value.type);
    if (type === "result" && value.is_error === true) {
      errors.push({
        source: "result",
        message: readString(value.result) ?? readString(value.subtype) ?? "result is_error",
        ...readString(value.subtype) ? {
          code: readString(value.subtype)
        } : {},
        raw: value
      });
      continue;
    }
    if (type === "assistant" && readString(value.error)) {
      errors.push({
        source: "assistant",
        message: assistantText(value) || (readString(value.error) ?? ""),
        code: readString(value.error),
        raw: value
      });
      continue;
    }
    if (type === "error") {
      const message = readString(value.message) ?? readString(value.error) ?? "error event";
      errors.push({
        source: "error",
        message,
        ...readString(value.subtype) ? {
          code: readString(value.subtype)
        } : {},
        ...extractHttpStatus(message) !== undefined ? {
          httpStatus: extractHttpStatus(message)
        } : {},
        raw: value
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
 */ function decodeClaudeOutput(stdout) {
  const { events, malformedLines } = parseJsonlEvents(stdout);
  const text = extractStreamJsonText(stdout);
  let textSource = "none";
  let status = events.length === 0 ? "unknown" : "incomplete";
  let sessionId;
  let progressEvents = 0;
  let last;
  for (const { value } of events){
    sessionId = readString(value.session_id) ?? sessionId;
    const type = readString(value.type);
    if (type === "result") {
      status = value.is_error === true ? "failed" : "completed";
      if (readString(value.result)) textSource = "final";
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
    errors: collectErrors(events),
    malformedLines
  };
}
/** The quota window a Claude refusal describes, scope and reset alike. */ function claudeQuota(surface, nowMs) {
  const resetEpochMs = parseUsageLimitReset(surface, nowMs);
  return {
    scope: detectQuotaScope(surface),
    ...resetEpochMs !== null ? {
      resetEpochMs
    } : {}
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
 */ function classifyClaudeFailure(name, streams, decoded) {
  const process = classifyProcessOutcome(streams);
  if (process) return process;
  // A run that exited 0 succeeded. Its prose is the agent's, not the CLI's.
  if (streams.exitCode === 0) return undefined;
  const stderr = streams.stderr ?? "";
  const nowMs = streams.nowMs ?? Date.now();
  const structuredText = decoded.errors.map((e)=>`${e.code ?? ""} ${e.message}`).join("\n");
  const cliSurface = `${structuredText}\n${stderr}`.trim();
  // The CLI's *error* surface, never the agent's answer: a failed run whose
  // prose merely quotes "429" or "usage limit reached" is quoting, not
  // refusing (Issue #1695). Stdout is consulted only when the CLI produced
  // neither a structured error nor stderr **and** it was not the CLI's event
  // stream at all — the compatibility path, where a refusal is all stdout
  // ever carried. A stream of events with no error in it is the agent
  // talking: an exit-1 run cut off mid-turn while discussing retries or a
  // quota is not a refusal (Issue #4114).
  const surface = cliSurface ? cliSurface : decoded.status === "unknown" ? decoded.text : "";
  const evidenceText = redactedEvidence(surface);
  const httpStatus = extractHttpStatus(surface);
  const say = (headline)=>failureMessage(headline, evidenceText);
  if (decoded.errors.some((error)=>error.source === "result" && error.code === "error_max_turns")) {
    return agentFailure({
      category: "turn-limit",
      message: say("The Claude CLI reached its per-run turn limit (error_max_turns)"),
      evidence: "structured",
      errors: decoded.errors
    });
  }
  // Memory first: a V8 heap abort's "heap limit" wording matches the
  // secondary rate-limit pattern, and waiting cannot reclaim memory.
  if (detectOutOfMemory(surface)) {
    return agentFailure({
      category: "out-of-memory",
      message: say("The Claude CLI ran out of memory"),
      evidence: "prose",
      errors: decoded.errors
    });
  }
  // Structured evidence: the CLI's own verdict on the run, when it gave one.
  for (const error of decoded.errors){
    const code = error.code ?? "";
    if (/auth/i.test(code) || isClaudeAuthError(error.message)) {
      return agentFailure({
        category: "authentication",
        message: say(`${name} refused the credential`),
        evidence: "structured",
        ...httpStatus !== undefined ? {
          httpStatus
        } : {},
        errors: decoded.errors
      });
    }
    if (detectUsageLimit(error.message)) {
      return agentFailure({
        category: "quota-exhausted",
        message: say(quotaHeadline(name, error.message)),
        evidence: "structured",
        quota: claudeQuota(error.message, nowMs),
        errors: decoded.errors
      });
    }
  }
  // The CLI refused the session flags before it ever reached a model call.
  if (detectInvalidSessionId(surface)) {
    return agentFailure({
      category: "invalid-session",
      message: say("The Claude CLI refused the session flags"),
      evidence: "prose",
      errors: decoded.errors
    });
  }
  // A refused credential, including a bare 401/403 that names no model.
  if (isClaudeAuthError(surface) || (httpStatus === 401 || httpStatus === 403) && !MODEL_EVIDENCE_RE.test(surface)) {
    return agentFailure({
      category: "authentication",
      message: say(`${name} refused the credential`),
      evidence: "prose",
      ...httpStatus !== undefined ? {
        httpStatus
      } : {},
      errors: decoded.errors
    });
  }
  if (detectModelUnavailable(surface)) {
    return agentFailure({
      category: "model-unavailable",
      message: say(`${name} refused the requested model`),
      evidence: "prose",
      ...httpStatus !== undefined ? {
        httpStatus
      } : {},
      errors: decoded.errors
    });
  }
  if (detectUsageLimit(surface)) {
    return agentFailure({
      category: "quota-exhausted",
      message: say(quotaHeadline(name, surface)),
      evidence: "prose",
      quota: claudeQuota(surface, nowMs),
      // Issue #2613: a spent balance names its 402 — keep it for the alert.
      ...httpStatus !== undefined ? {
        httpStatus
      } : {},
      errors: decoded.errors
    });
  }
  // Transport before rate limit: an overloaded upstream matches the
  // rate-limit vocabulary but is not a limit on this account.
  if (isNetworkStatus(httpStatus) || NETWORK_RE.test(surface)) {
    return agentFailure({
      category: "network",
      message: say("The Claude CLI could not reach the API"),
      evidence: "prose",
      ...httpStatus !== undefined ? {
        httpStatus
      } : {},
      errors: decoded.errors
    });
  }
  // A transient limit: only a primary match or an explicit 429, never the
  // weak "try again / retry / limit" vocabulary on its own.
  if (httpStatus === 429 || detectRateLimit(surface).isPrimary) {
    const retryAfterSeconds = extractRetryAfterSeconds(surface);
    return agentFailure({
      category: "rate-limit",
      message: say(`${name} rate-limited this request`),
      evidence: "prose",
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
    message: say(`The Claude CLI exited ${streams.exitCode}`),
    evidence: "process",
    errors: decoded.errors
  });
}
/**
 * The headline for a quota refusal: a spent balance is a balance, a spent
 * window is a window (Issue #2633). DeepSeek's `402 Insufficient Balance` was
 * published as "Claude's subscription window is exhausted" — the wrong
 * provider and the wrong condition.
 */ function quotaHeadline(name, text) {
  return BALANCE_EXHAUSTED_RE.test(text) ? `${name}'s account balance is spent` : `${name}'s subscription window is exhausted`;
}
/**
 * An output adapter for a provider that runs the Claude Code binary: the
 * events are Claude Code's, the refusals name the provider (Issue #2633).
 */ function claudeCodeOutputAdapter(providerId, name) {
  return {
    providerId,
    decode: decodeClaudeOutput,
    classify: (streams, decoded)=>classifyClaudeFailure(name, streams, decoded)
  };
}
/** Claude Code's output adapter for the Claude provider. */ export const CLAUDE_OUTPUT_ADAPTER = claudeCodeOutputAdapter(PROVIDER_ID, "Claude");
/**
 * The same adapter for DeepSeek, which runs the Claude Code binary against
 * DeepSeek's endpoint: identical events, refusals that name DeepSeek.
 */ export const DEEPSEEK_OUTPUT_ADAPTER = claudeCodeOutputAdapter("deepseek", "DeepSeek");
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jbGF1ZGVfb3V0cHV0X2FkYXB0ZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUaGUgQ2xhdWRlIENvZGUgb3V0cHV0IGFkYXB0ZXIgKElzc3VlICMxNjk1LCBwYXJlbnQgIzE2OTQpLlxuICpcbiAqIENsYXVkZSdzIGhhbGYgb2YgdGhlIGNvbnRyYWN0IGluIGBhZ2VudF9vdXRwdXQudHNgLiBJdCBvd25zIG5vIG5ld1xuICogdm9jYWJ1bGFyeTogdGhlIHRleHQgZXh0cmFjdGlvbiBpcyBgZXh0cmFjdFN0cmVhbUpzb25UZXh0YCBhbmQgZXZlcnkgcHJvc2VcbiAqIHRlc3QgaXMgdGhlIGBkZXRlY3QqYCBwcmVkaWNhdGUgYGNsYXVkZV9leGVjdXRvci50c2AgYWxyZWFkeSBvd25zLCBzbyBhblxuICogZXhpc3RpbmcgQ2xhdWRlIHJlc3VsdCBkZWNvZGVzIHRvIGV4YWN0bHkgdGhlIHRleHQgaXQgZGVjb2RlZCB0byBiZWZvcmUgYW5kXG4gKiBjbGFzc2lmaWVzIHRoZSB3YXkgdGhlIHJ1bm5lcidzIGxhZGRlciBjbGFzc2lmaWVzIGl0LiBXaGF0IGlzIG5ldyBpcyB0aGVcbiAqICpzaGFwZSo6IGEgbmFtZWQgY2F0ZWdvcnksIHRoZSBldmlkZW5jZSBpdCB3YXMgcmVhZCBmcm9tLCBhbmQgdGhlIHF1b3RhXG4gKiBzY29wZSBhbmQgcmVzZXQgY2FycmllZCBhcyBkYXRhIHJhdGhlciB0aGFuIHJlY29uc3RydWN0ZWQgYnkgZWFjaCBjYWxsZXIuXG4gKlxuICogVHdvIHRoaW5ncyBpdCBkZWxpYmVyYXRlbHkgZG9lcyAqKm5vdCoqIGRvOlxuICpcbiAqIC0gSXQgZG9lcyBub3QgcGFyc2UgdGhlIENMSSdzIGByYXRlX2xpbWl0X2V2ZW50YC4gVGhhdCBwYXJzZXIgaXMgSXNzdWVcbiAqICAgIzE2NjYncywgYW5kIGEgc2Vjb25kIGNvcHkgaGVyZSBpcyBob3cgdGhlIHR3byB3b3VsZCBkcmlmdDsgd2hlbiBpdFxuICogICBsYW5kcywgaXRzIHdpbmRvd3MgYW5kIGByZXNldHNBdGAgYmVjb21lIHRoZSBzdHJ1Y3R1cmVkIGV2aWRlbmNlIHRoaXNcbiAqICAgbW9kdWxlJ3MgcXVvdGEgYnJhbmNoIHByZWZlcnMgb3ZlciBwcm9zZS5cbiAqIC0gSXQgZG9lcyBub3QgcmUtcnVuIHRoZSBtb2RlbC11bmF2YWlsYWJsZSByZWdleCBvbiBhIDQwMS80MDMgYWxvbmUuIEFcbiAqICAgcmVmdXNlZCBjcmVkZW50aWFsIGlzIGFuIGF1dGhlbnRpY2F0aW9uIGZhaWx1cmU7IG9ubHkgYSByZWZ1c2FsIHRoYXRcbiAqICAgbmFtZXMgdGhlIG1vZGVsIGlzIGEgbW9kZWwgZmFpbHVyZSwgd2hpY2ggaXMgd2hhdCBzdG9wcyBhIGJhZCBjcmVkZW50aWFsXG4gKiAgIHdhbGtpbmcgdGhlIGNoZWFwZXItbW9kZWwgbGFkZGVyLlxuICpcbiAqIFRoZSBDbGF1ZGUgQ0xJIGlzIGFsc28gRGVlcFNlZWsncyBiaW5hcnksIHNvIGJvdGggZGVzY3JpcHRvcnMgc2hhcmUgdGhpc1xuICogYWRhcHRlciDigJQgb25lIENMSSwgb25lIGV2ZW50IHNoYXBlLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHtcbiAgdHlwZSBBZ2VudERlY29kZWRPdXRwdXQsXG4gIHR5cGUgQWdlbnRGYWlsdXJlLFxuICBhZ2VudEZhaWx1cmUsXG4gIHR5cGUgQWdlbnRPdXRwdXRBZGFwdGVyLFxuICB0eXBlIEFnZW50UXVvdGEsXG4gIHR5cGUgQWdlbnRSdW5TdHJlYW1zLFxuICB0eXBlIEFnZW50U3RydWN0dXJlZEVycm9yLFxuICB0eXBlIEFnZW50VGV4dFNvdXJjZSxcbiAgQkFMQU5DRV9FWEhBVVNURURfUkUsXG4gIGNsYXNzaWZ5UHJvY2Vzc091dGNvbWUsXG4gIGRldGVjdFF1b3RhU2NvcGUsXG4gIGV4dHJhY3RIdHRwU3RhdHVzLFxuICBleHRyYWN0UmV0cnlBZnRlclNlY29uZHMsXG4gIGZhaWx1cmVNZXNzYWdlLFxuICBpc05ldHdvcmtTdGF0dXMsXG4gIHBhcnNlSnNvbmxFdmVudHMsXG4gIHJlYWRTdHJpbmcsXG4gIHJlZGFjdGVkRXZpZGVuY2UsXG59IGZyb20gXCIuL2FnZW50X291dHB1dC50c1wiO1xuaW1wb3J0IHsgaXNDbGF1ZGVBdXRoRXJyb3IgfSBmcm9tIFwiLi9jbGF1ZGVfYXV0aC50c1wiO1xuaW1wb3J0IHtcbiAgZGV0ZWN0SW52YWxpZFNlc3Npb25JZCxcbiAgZGV0ZWN0TW9kZWxVbmF2YWlsYWJsZSxcbiAgZGV0ZWN0T3V0T2ZNZW1vcnksXG4gIGRldGVjdFJhdGVMaW1pdCxcbiAgZGV0ZWN0VXNhZ2VMaW1pdCxcbiAgZXh0cmFjdFN0cmVhbUpzb25UZXh0LFxuICBwYXJzZVVzYWdlTGltaXRSZXNldCxcbn0gZnJvbSBcIi4vY2xhdWRlX2V4ZWN1dG9yLnRzXCI7XG5pbXBvcnQgeyBleHRyYWN0VG9rZW5Vc2FnZSB9IGZyb20gXCIuL3Rva2VuX3VzYWdlLnRzXCI7XG5cbi8qKiBUaGUgcHJvdmlkZXIgaWQgdGhpcyBhZGFwdGVyIGRlY29kZXMgZm9yLiAqL1xuY29uc3QgUFJPVklERVJfSUQgPSBcImNsYXVkZVwiO1xuXG4vKiogVHJhbnNwb3J0IGZhaWx1cmVzIHRoZSBDTEkgcmVwb3J0cyBpbiBwcm9zZS4gKi9cbmNvbnN0IE5FVFdPUktfUkUgPVxuICAvb3ZlcmxvYWRlZHxlY29ubnJlc2V0fGVjb25ucmVmdXNlZHxldGltZWRvdXR8ZW5vdGZvdW5kfHNvY2tldCBoYW5nIHVwfGZldGNoIGZhaWxlZHxuZXR3b3JrIGVycm9yfGNvbm5lY3Rpb24gKD86cmVzZXR8cmVmdXNlZHxjbG9zZWQpL2k7XG5cbi8qKiBBIHJlZnVzYWwgdGhhdCBuYW1lcyB0aGUgbW9kZWwsIGFzIG9wcG9zZWQgdG8gdGhlIGNyZWRlbnRpYWwuICovXG5jb25zdCBNT0RFTF9FVklERU5DRV9SRSA9IC9cXGJtb2RlbFxcYnx1bnJlY29nbmlbc3pdZWRfbW9kZWx8bW9kZWxfbm90X2ZvdW5kL2k7XG5cbi8qKiBUaGUgYXNzaXN0YW50IHRleHQgYmxvY2tzIG9mIG9uZSBgYXNzaXN0YW50YCBldmVudCwgY29uY2F0ZW5hdGVkLiAqL1xuZnVuY3Rpb24gYXNzaXN0YW50VGV4dChldmVudDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcge1xuICBjb25zdCBtZXNzYWdlID0gZXZlbnQubWVzc2FnZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgY29uc3QgY29udGVudCA9IG1lc3NhZ2U/LmNvbnRlbnQ7XG4gIGlmICghQXJyYXkuaXNBcnJheShjb250ZW50KSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNvbnRlbnQpIHtcbiAgICBpZiAoXG4gICAgICBibG9jayAmJiB0eXBlb2YgYmxvY2sgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgIChibG9jayBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikudHlwZSA9PT0gXCJ0ZXh0XCJcbiAgICApIHtcbiAgICAgIGNvbnN0IHRleHQgPSByZWFkU3RyaW5nKChibG9jayBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikudGV4dCk7XG4gICAgICBpZiAodGV4dCkgcGFydHMucHVzaCh0ZXh0KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHBhcnRzLmpvaW4oXCJcIik7XG59XG5cbi8qKlxuICogQ29sbGVjdCB0aGUgc3RydWN0dXJlZCBlcnJvciBldmlkZW5jZSBhIENsYXVkZSBzdHJlYW0gY2Fycmllcy5cbiAqXG4gKiBUaHJlZSBzaGFwZXMsIGFsbCByZWFsICh0aGUgcmVjb3JkZWQgMi4xLjI2MSBmaXh0dXJlcyBjYXJyeSB0d28gb2YgdGhlbSk6XG4gKiBhIGByZXN1bHRgIGxpbmUgZmxhZ2dlZCBgaXNfZXJyb3JgLCBhbiBgYXNzaXN0YW50YCBsaW5lIGNhcnJ5aW5nIGFuIGBlcnJvcmBcbiAqIGNvZGUsIGFuZCBhIGJhcmUgYGVycm9yYCBldmVudC4gRWFjaCBrZWVwcyBpdHMgd2hvbGUgZXZlbnQgb24gYHJhd2AuXG4gKi9cbmZ1bmN0aW9uIGNvbGxlY3RFcnJvcnMoXG4gIGV2ZW50czogcmVhZG9ubHkgeyB2YWx1ZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfVtdLFxuKTogQWdlbnRTdHJ1Y3R1cmVkRXJyb3JbXSB7XG4gIGNvbnN0IGVycm9yczogQWdlbnRTdHJ1Y3R1cmVkRXJyb3JbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHsgdmFsdWUgfSBvZiBldmVudHMpIHtcbiAgICBjb25zdCB0eXBlID0gcmVhZFN0cmluZyh2YWx1ZS50eXBlKTtcbiAgICBpZiAodHlwZSA9PT0gXCJyZXN1bHRcIiAmJiB2YWx1ZS5pc19lcnJvciA9PT0gdHJ1ZSkge1xuICAgICAgZXJyb3JzLnB1c2goe1xuICAgICAgICBzb3VyY2U6IFwicmVzdWx0XCIsXG4gICAgICAgIG1lc3NhZ2U6IHJlYWRTdHJpbmcodmFsdWUucmVzdWx0KSA/PyByZWFkU3RyaW5nKHZhbHVlLnN1YnR5cGUpID8/XG4gICAgICAgICAgXCJyZXN1bHQgaXNfZXJyb3JcIixcbiAgICAgICAgLi4uKHJlYWRTdHJpbmcodmFsdWUuc3VidHlwZSlcbiAgICAgICAgICA/IHsgY29kZTogcmVhZFN0cmluZyh2YWx1ZS5zdWJ0eXBlKSB9XG4gICAgICAgICAgOiB7fSksXG4gICAgICAgIHJhdzogdmFsdWUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodHlwZSA9PT0gXCJhc3Npc3RhbnRcIiAmJiByZWFkU3RyaW5nKHZhbHVlLmVycm9yKSkge1xuICAgICAgZXJyb3JzLnB1c2goe1xuICAgICAgICBzb3VyY2U6IFwiYXNzaXN0YW50XCIsXG4gICAgICAgIG1lc3NhZ2U6IGFzc2lzdGFudFRleHQodmFsdWUpIHx8IChyZWFkU3RyaW5nKHZhbHVlLmVycm9yKSA/PyBcIlwiKSxcbiAgICAgICAgY29kZTogcmVhZFN0cmluZyh2YWx1ZS5lcnJvciksXG4gICAgICAgIHJhdzogdmFsdWUsXG4gICAgICB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodHlwZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gcmVhZFN0cmluZyh2YWx1ZS5tZXNzYWdlKSA/PyByZWFkU3RyaW5nKHZhbHVlLmVycm9yKSA/P1xuICAgICAgICBcImVycm9yIGV2ZW50XCI7XG4gICAgICBlcnJvcnMucHVzaCh7XG4gICAgICAgIHNvdXJjZTogXCJlcnJvclwiLFxuICAgICAgICBtZXNzYWdlLFxuICAgICAgICAuLi4ocmVhZFN0cmluZyh2YWx1ZS5zdWJ0eXBlKVxuICAgICAgICAgID8geyBjb2RlOiByZWFkU3RyaW5nKHZhbHVlLnN1YnR5cGUpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgICAgLi4uKGV4dHJhY3RIdHRwU3RhdHVzKG1lc3NhZ2UpICE9PSB1bmRlZmluZWRcbiAgICAgICAgICA/IHsgaHR0cFN0YXR1czogZXh0cmFjdEh0dHBTdGF0dXMobWVzc2FnZSkgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgICByYXc6IHZhbHVlLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBlcnJvcnM7XG59XG5cbi8qKlxuICogRGVjb2RlIG9uZSBDbGF1ZGUgYHN0cmVhbS1qc29uYCBzdGRvdXQgaW50byB0aGUgc2hhcmVkIGNvbnRyYWN0LlxuICpcbiAqIFRoZSB0ZXh0IGlzIGBleHRyYWN0U3RyZWFtSnNvblRleHRgJ3MsIHVuY2hhbmdlZCwgc28gbm8gZXhpc3RpbmcgcmVzdWx0XG4gKiBtb3Zlcy4gV2hhdCBjaGFuZ2VzIGlzIHRoYXQgdGhlIGNhbGxlciBpcyBub3cgdG9sZCAqd2hlcmUqIGl0IGNhbWUgZnJvbTpcbiAqIGBcIm5vbmVcImAgc2F5cyB0aGUgc3RyZWFtIHdhcyBldmVudCBlbnZlbG9wZXMgd2l0aCBubyBhbnN3ZXIgaW4gdGhlbSwgd2hpY2hcbiAqIGlzIHRoZSBjYXNlIHRoYXQgbXVzdCBuZXZlciBiZSByZWFkIGFzIHRoZSBhZ2VudCdzIHByb3NlLlxuICpcbiAqIEBwYXJhbSBzdGRvdXQgLSBSYXcgc3Rkb3V0IGZyb20gdGhlIENMSS5cbiAqIEByZXR1cm5zIFRoZSBkZWNvZGVkIHJ1bi5cbiAqL1xuZnVuY3Rpb24gZGVjb2RlQ2xhdWRlT3V0cHV0KHN0ZG91dDogc3RyaW5nKTogQWdlbnREZWNvZGVkT3V0cHV0IHtcbiAgY29uc3QgeyBldmVudHMsIG1hbGZvcm1lZExpbmVzIH0gPSBwYXJzZUpzb25sRXZlbnRzKHN0ZG91dCk7XG4gIGNvbnN0IHRleHQgPSBleHRyYWN0U3RyZWFtSnNvblRleHQoc3Rkb3V0KTtcblxuICBsZXQgdGV4dFNvdXJjZTogQWdlbnRUZXh0U291cmNlID0gXCJub25lXCI7XG4gIGxldCBzdGF0dXM6IEFnZW50RGVjb2RlZE91dHB1dFtcInN0YXR1c1wiXSA9IGV2ZW50cy5sZW5ndGggPT09IDBcbiAgICA/IFwidW5rbm93blwiXG4gICAgOiBcImluY29tcGxldGVcIjtcbiAgbGV0IHNlc3Npb25JZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgcHJvZ3Jlc3NFdmVudHMgPSAwO1xuICBsZXQgbGFzdDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG4gIGZvciAoY29uc3QgeyB2YWx1ZSB9IG9mIGV2ZW50cykge1xuICAgIHNlc3Npb25JZCA9IHJlYWRTdHJpbmcodmFsdWUuc2Vzc2lvbl9pZCkgPz8gc2Vzc2lvbklkO1xuICAgIGNvbnN0IHR5cGUgPSByZWFkU3RyaW5nKHZhbHVlLnR5cGUpO1xuICAgIGlmICh0eXBlID09PSBcInJlc3VsdFwiKSB7XG4gICAgICBzdGF0dXMgPSB2YWx1ZS5pc19lcnJvciA9PT0gdHJ1ZSA/IFwiZmFpbGVkXCIgOiBcImNvbXBsZXRlZFwiO1xuICAgICAgaWYgKHJlYWRTdHJpbmcodmFsdWUucmVzdWx0KSkgdGV4dFNvdXJjZSA9IFwiZmluYWxcIjtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodHlwZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuICAgICAgcHJvZ3Jlc3NFdmVudHMrKztcbiAgICAgIGNvbnN0IGFzc2lzdGFudCA9IGFzc2lzdGFudFRleHQodmFsdWUpO1xuICAgICAgaWYgKGFzc2lzdGFudCkge1xuICAgICAgICBsYXN0ID0gYXNzaXN0YW50LnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKS5hdCgtMSkgPz8gbGFzdDtcbiAgICAgICAgaWYgKHRleHRTb3VyY2UgPT09IFwibm9uZVwiKSB0ZXh0U291cmNlID0gXCJwYXJ0aWFsXCI7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcHJvZ3Jlc3NFdmVudHMrKztcbiAgfVxuXG4gIC8vIE91dHB1dCB0aGF0IGlzIG5vdCB0aGUgQ0xJJ3MgZXZlbnQgZm9ybWF0IGF0IGFsbCDigJQgYSBoZWFsdGgtY2hlY2sgbGluZSwgYVxuICAvLyBwbGFpbiBlcnJvciDigJQgaXMgbGVnaXRpbWF0ZWx5IHRoZSBDTEkncyBvd24gdGV4dCwgbm90IGFuIGVudmVsb3BlLlxuICBpZiAoZXZlbnRzLmxlbmd0aCA9PT0gMCAmJiB0ZXh0KSB0ZXh0U291cmNlID0gXCJyYXdcIjtcbiAgLy8gQSBzdHJlYW0gb2YgZW52ZWxvcGVzIHdpdGggbm8gYW5zd2VyIGluIGl0IGxlYXZlcyBgdGV4dFNvdXJjZWAgYXRcbiAgLy8gYFwibm9uZVwiYDogdGhlIHByZS1leGlzdGluZyBmYWxsYmFjayBzdGlsbCBwYXNzZXMgdGhlIHJhdyBzdHJlYW0gdGhyb3VnaCBhc1xuICAvLyBldmlkZW5jZSwgYW5kIGBcIm5vbmVcImAgaXMgaG93IGEgY2FsbGVyIGtub3dzIGl0IGlzIG5vdCB0aGUgYWdlbnQncyBwcm9zZS5cblxuICBjb25zdCB1c2FnZSA9IGV4dHJhY3RUb2tlblVzYWdlKHN0ZG91dCkgPz8gdW5kZWZpbmVkO1xuICByZXR1cm4ge1xuICAgIHRleHQsXG4gICAgdGV4dFNvdXJjZSxcbiAgICBzdGF0dXMsXG4gICAgLi4uKHNlc3Npb25JZCA/IHsgc2Vzc2lvbklkIH0gOiB7fSksXG4gICAgLi4uKHVzYWdlID8geyB1c2FnZSB9IDoge30pLFxuICAgIHByb2dyZXNzOiB7IGV2ZW50czogcHJvZ3Jlc3NFdmVudHMsIC4uLihsYXN0ID8geyBsYXN0IH0gOiB7fSkgfSxcbiAgICBlcnJvcnM6IGNvbGxlY3RFcnJvcnMoZXZlbnRzKSxcbiAgICBtYWxmb3JtZWRMaW5lcyxcbiAgfTtcbn1cblxuLyoqIFRoZSBxdW90YSB3aW5kb3cgYSBDbGF1ZGUgcmVmdXNhbCBkZXNjcmliZXMsIHNjb3BlIGFuZCByZXNldCBhbGlrZS4gKi9cbmZ1bmN0aW9uIGNsYXVkZVF1b3RhKHN1cmZhY2U6IHN0cmluZywgbm93TXM6IG51bWJlcik6IEFnZW50UXVvdGEge1xuICBjb25zdCByZXNldEVwb2NoTXMgPSBwYXJzZVVzYWdlTGltaXRSZXNldChzdXJmYWNlLCBub3dNcyk7XG4gIHJldHVybiB7XG4gICAgc2NvcGU6IGRldGVjdFF1b3RhU2NvcGUoc3VyZmFjZSksXG4gICAgLi4uKHJlc2V0RXBvY2hNcyAhPT0gbnVsbCA/IHsgcmVzZXRFcG9jaE1zIH0gOiB7fSksXG4gIH07XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgb25lIGZhaWxlZCBDbGF1ZGUgcnVuLlxuICpcbiAqIE9yZGVyIGlzIHRoZSBwb2ludC4gVGhlIHdvcmtlcidzIG93biBmYWN0cyBmaXJzdCAoYSBjYW5jZWxsZWQgcnVuIGlzIG5ldmVyXG4gKiByZS1leHBsYWluZWQgYnkgaXRzIG91dHB1dCksIHRoZW4gYSBzdWNjZXNzZnVsIGV4aXQgc2hvcnQtY2lyY3VpdHMgdG8gKm5vXG4gKiBmYWlsdXJlIGF0IGFsbCog4oCUIHdoaWNoIGlzIHdoYXQgc3RvcHMgYW4gYWdlbnQgcXVvdGluZyBcIjQyOVwiIGluIGl0cyBhbnN3ZXJcbiAqIGJlaW5nIHJlYWQgYXMgYSByZWZ1c2FsIOKAlCB0aGVuIHN0cnVjdHVyZWQgZXZpZGVuY2UsIHRoZW4gdGhlIG5hcnJvdyBwcm9zZVxuICogcHJlZGljYXRlcy5cbiAqXG4gKiBAcGFyYW0gc3RyZWFtcyAtIFRoZSBydW4ncyBzdHJlYW1zIGFuZCBwcm9jZXNzIGZhY3RzLlxuICogQHBhcmFtIGRlY29kZWQgLSBUaGUgZGVjb2RlZCBvdXRwdXQgZnJvbSB7QGxpbmsgZGVjb2RlQ2xhdWRlT3V0cHV0fS5cbiAqIEByZXR1cm5zIFRoZSBub3JtYWxpc2VkIGZhaWx1cmUsIG9yIHVuZGVmaW5lZCB3aGVuIHRoZSBydW4gZGlkIG5vdCBmYWlsLlxuICovXG5mdW5jdGlvbiBjbGFzc2lmeUNsYXVkZUZhaWx1cmUoXG4gIG5hbWU6IHN0cmluZyxcbiAgc3RyZWFtczogQWdlbnRSdW5TdHJlYW1zLFxuICBkZWNvZGVkOiBBZ2VudERlY29kZWRPdXRwdXQsXG4pOiBBZ2VudEZhaWx1cmUgfCB1bmRlZmluZWQge1xuICBjb25zdCBwcm9jZXNzID0gY2xhc3NpZnlQcm9jZXNzT3V0Y29tZShzdHJlYW1zKTtcbiAgaWYgKHByb2Nlc3MpIHJldHVybiBwcm9jZXNzO1xuXG4gIC8vIEEgcnVuIHRoYXQgZXhpdGVkIDAgc3VjY2VlZGVkLiBJdHMgcHJvc2UgaXMgdGhlIGFnZW50J3MsIG5vdCB0aGUgQ0xJJ3MuXG4gIGlmIChzdHJlYW1zLmV4aXRDb2RlID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHN0ZGVyciA9IHN0cmVhbXMuc3RkZXJyID8/IFwiXCI7XG4gIGNvbnN0IG5vd01zID0gc3RyZWFtcy5ub3dNcyA/PyBEYXRlLm5vdygpO1xuICBjb25zdCBzdHJ1Y3R1cmVkVGV4dCA9IGRlY29kZWQuZXJyb3JzXG4gICAgLm1hcCgoZSkgPT4gYCR7ZS5jb2RlID8/IFwiXCJ9ICR7ZS5tZXNzYWdlfWApXG4gICAgLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IGNsaVN1cmZhY2UgPSBgJHtzdHJ1Y3R1cmVkVGV4dH1cXG4ke3N0ZGVycn1gLnRyaW0oKTtcbiAgLy8gVGhlIENMSSdzICplcnJvciogc3VyZmFjZSwgbmV2ZXIgdGhlIGFnZW50J3MgYW5zd2VyOiBhIGZhaWxlZCBydW4gd2hvc2VcbiAgLy8gcHJvc2UgbWVyZWx5IHF1b3RlcyBcIjQyOVwiIG9yIFwidXNhZ2UgbGltaXQgcmVhY2hlZFwiIGlzIHF1b3RpbmcsIG5vdFxuICAvLyByZWZ1c2luZyAoSXNzdWUgIzE2OTUpLiBTdGRvdXQgaXMgY29uc3VsdGVkIG9ubHkgd2hlbiB0aGUgQ0xJIHByb2R1Y2VkXG4gIC8vIG5laXRoZXIgYSBzdHJ1Y3R1cmVkIGVycm9yIG5vciBzdGRlcnIgKiphbmQqKiBpdCB3YXMgbm90IHRoZSBDTEkncyBldmVudFxuICAvLyBzdHJlYW0gYXQgYWxsIOKAlCB0aGUgY29tcGF0aWJpbGl0eSBwYXRoLCB3aGVyZSBhIHJlZnVzYWwgaXMgYWxsIHN0ZG91dFxuICAvLyBldmVyIGNhcnJpZWQuIEEgc3RyZWFtIG9mIGV2ZW50cyB3aXRoIG5vIGVycm9yIGluIGl0IGlzIHRoZSBhZ2VudFxuICAvLyB0YWxraW5nOiBhbiBleGl0LTEgcnVuIGN1dCBvZmYgbWlkLXR1cm4gd2hpbGUgZGlzY3Vzc2luZyByZXRyaWVzIG9yIGFcbiAgLy8gcXVvdGEgaXMgbm90IGEgcmVmdXNhbCAoSXNzdWUgIzQxMTQpLlxuICBjb25zdCBzdXJmYWNlID0gY2xpU3VyZmFjZVxuICAgID8gY2xpU3VyZmFjZVxuICAgIDogZGVjb2RlZC5zdGF0dXMgPT09IFwidW5rbm93blwiXG4gICAgPyBkZWNvZGVkLnRleHRcbiAgICA6IFwiXCI7XG4gIGNvbnN0IGV2aWRlbmNlVGV4dCA9IHJlZGFjdGVkRXZpZGVuY2Uoc3VyZmFjZSk7XG4gIGNvbnN0IGh0dHBTdGF0dXMgPSBleHRyYWN0SHR0cFN0YXR1cyhzdXJmYWNlKTtcbiAgY29uc3Qgc2F5ID0gKGhlYWRsaW5lOiBzdHJpbmcpID0+IGZhaWx1cmVNZXNzYWdlKGhlYWRsaW5lLCBldmlkZW5jZVRleHQpO1xuXG4gIGlmIChcbiAgICBkZWNvZGVkLmVycm9ycy5zb21lKChlcnJvcikgPT5cbiAgICAgIGVycm9yLnNvdXJjZSA9PT0gXCJyZXN1bHRcIiAmJiBlcnJvci5jb2RlID09PSBcImVycm9yX21heF90dXJuc1wiXG4gICAgKVxuICApIHtcbiAgICByZXR1cm4gYWdlbnRGYWlsdXJlKHtcbiAgICAgIGNhdGVnb3J5OiBcInR1cm4tbGltaXRcIixcbiAgICAgIG1lc3NhZ2U6IHNheShcbiAgICAgICAgXCJUaGUgQ2xhdWRlIENMSSByZWFjaGVkIGl0cyBwZXItcnVuIHR1cm4gbGltaXQgKGVycm9yX21heF90dXJucylcIixcbiAgICAgICksXG4gICAgICBldmlkZW5jZTogXCJzdHJ1Y3R1cmVkXCIsXG4gICAgICBlcnJvcnM6IGRlY29kZWQuZXJyb3JzLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gTWVtb3J5IGZpcnN0OiBhIFY4IGhlYXAgYWJvcnQncyBcImhlYXAgbGltaXRcIiB3b3JkaW5nIG1hdGNoZXMgdGhlXG4gIC8vIHNlY29uZGFyeSByYXRlLWxpbWl0IHBhdHRlcm4sIGFuZCB3YWl0aW5nIGNhbm5vdCByZWNsYWltIG1lbW9yeS5cbiAgaWYgKGRldGVjdE91dE9mTWVtb3J5KHN1cmZhY2UpKSB7XG4gICAgcmV0dXJuIGFnZW50RmFpbHVyZSh7XG4gICAgICBjYXRlZ29yeTogXCJvdXQtb2YtbWVtb3J5XCIsXG4gICAgICBtZXNzYWdlOiBzYXkoXCJUaGUgQ2xhdWRlIENMSSByYW4gb3V0IG9mIG1lbW9yeVwiKSxcbiAgICAgIGV2aWRlbmNlOiBcInByb3NlXCIsXG4gICAgICBlcnJvcnM6IGRlY29kZWQuZXJyb3JzLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gU3RydWN0dXJlZCBldmlkZW5jZTogdGhlIENMSSdzIG93biB2ZXJkaWN0IG9uIHRoZSBydW4sIHdoZW4gaXQgZ2F2ZSBvbmUuXG4gIGZvciAoY29uc3QgZXJyb3Igb2YgZGVjb2RlZC5lcnJvcnMpIHtcbiAgICBjb25zdCBjb2RlID0gZXJyb3IuY29kZSA/PyBcIlwiO1xuICAgIGlmICgvYXV0aC9pLnRlc3QoY29kZSkgfHwgaXNDbGF1ZGVBdXRoRXJyb3IoZXJyb3IubWVzc2FnZSkpIHtcbiAgICAgIHJldHVybiBhZ2VudEZhaWx1cmUoe1xuICAgICAgICBjYXRlZ29yeTogXCJhdXRoZW50aWNhdGlvblwiLFxuICAgICAgICBtZXNzYWdlOiBzYXkoYCR7bmFtZX0gcmVmdXNlZCB0aGUgY3JlZGVudGlhbGApLFxuICAgICAgICBldmlkZW5jZTogXCJzdHJ1Y3R1cmVkXCIsXG4gICAgICAgIC4uLihodHRwU3RhdHVzICE9PSB1bmRlZmluZWQgPyB7IGh0dHBTdGF0dXMgfSA6IHt9KSxcbiAgICAgICAgZXJyb3JzOiBkZWNvZGVkLmVycm9ycyxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAoZGV0ZWN0VXNhZ2VMaW1pdChlcnJvci5tZXNzYWdlKSkge1xuICAgICAgcmV0dXJuIGFnZW50RmFpbHVyZSh7XG4gICAgICAgIGNhdGVnb3J5OiBcInF1b3RhLWV4aGF1c3RlZFwiLFxuICAgICAgICBtZXNzYWdlOiBzYXkocXVvdGFIZWFkbGluZShuYW1lLCBlcnJvci5tZXNzYWdlKSksXG4gICAgICAgIGV2aWRlbmNlOiBcInN0cnVjdHVyZWRcIixcbiAgICAgICAgcXVvdGE6IGNsYXVkZVF1b3RhKGVycm9yLm1lc3NhZ2UsIG5vd01zKSxcbiAgICAgICAgZXJyb3JzOiBkZWNvZGVkLmVycm9ycyxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFRoZSBDTEkgcmVmdXNlZCB0aGUgc2Vzc2lvbiBmbGFncyBiZWZvcmUgaXQgZXZlciByZWFjaGVkIGEgbW9kZWwgY2FsbC5cbiAgaWYgKGRldGVjdEludmFsaWRTZXNzaW9uSWQoc3VyZmFjZSkpIHtcbiAgICByZXR1cm4gYWdlbnRGYWlsdXJlKHtcbiAgICAgIGNhdGVnb3J5OiBcImludmFsaWQtc2Vzc2lvblwiLFxuICAgICAgbWVzc2FnZTogc2F5KFwiVGhlIENsYXVkZSBDTEkgcmVmdXNlZCB0aGUgc2Vzc2lvbiBmbGFnc1wiKSxcbiAgICAgIGV2aWRlbmNlOiBcInByb3NlXCIsXG4gICAgICBlcnJvcnM6IGRlY29kZWQuZXJyb3JzLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gQSByZWZ1c2VkIGNyZWRlbnRpYWwsIGluY2x1ZGluZyBhIGJhcmUgNDAxLzQwMyB0aGF0IG5hbWVzIG5vIG1vZGVsLlxuICBpZiAoXG4gICAgaXNDbGF1ZGVBdXRoRXJyb3Ioc3VyZmFjZSkgfHxcbiAgICAoKGh0dHBTdGF0dXMgPT09IDQwMSB8fCBodHRwU3RhdHVzID09PSA0MDMpICYmXG4gICAgICAhTU9ERUxfRVZJREVOQ0VfUkUudGVzdChzdXJmYWNlKSlcbiAgKSB7XG4gICAgcmV0dXJuIGFnZW50RmFpbHVyZSh7XG4gICAgICBjYXRlZ29yeTogXCJhdXRoZW50aWNhdGlvblwiLFxuICAgICAgbWVzc2FnZTogc2F5KGAke25hbWV9IHJlZnVzZWQgdGhlIGNyZWRlbnRpYWxgKSxcbiAgICAgIGV2aWRlbmNlOiBcInByb3NlXCIsXG4gICAgICAuLi4oaHR0cFN0YXR1cyAhPT0gdW5kZWZpbmVkID8geyBodHRwU3RhdHVzIH0gOiB7fSksXG4gICAgICBlcnJvcnM6IGRlY29kZWQuZXJyb3JzLFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKGRldGVjdE1vZGVsVW5hdmFpbGFibGUoc3VyZmFjZSkpIHtcbiAgICByZXR1cm4gYWdlbnRGYWlsdXJlKHtcbiAgICAgIGNhdGVnb3J5OiBcIm1vZGVsLXVuYXZhaWxhYmxlXCIsXG4gICAgICBtZXNzYWdlOiBzYXkoYCR7bmFtZX0gcmVmdXNlZCB0aGUgcmVxdWVzdGVkIG1vZGVsYCksXG4gICAgICBldmlkZW5jZTogXCJwcm9zZVwiLFxuICAgICAgLi4uKGh0dHBTdGF0dXMgIT09IHVuZGVmaW5lZCA/IHsgaHR0cFN0YXR1cyB9IDoge30pLFxuICAgICAgZXJyb3JzOiBkZWNvZGVkLmVycm9ycyxcbiAgICB9KTtcbiAgfVxuXG4gIGlmIChkZXRlY3RVc2FnZUxpbWl0KHN1cmZhY2UpKSB7XG4gICAgcmV0dXJuIGFnZW50RmFpbHVyZSh7XG4gICAgICBjYXRlZ29yeTogXCJxdW90YS1leGhhdXN0ZWRcIixcbiAgICAgIG1lc3NhZ2U6IHNheShxdW90YUhlYWRsaW5lKG5hbWUsIHN1cmZhY2UpKSxcbiAgICAgIGV2aWRlbmNlOiBcInByb3NlXCIsXG4gICAgICBxdW90YTogY2xhdWRlUXVvdGEoc3VyZmFjZSwgbm93TXMpLFxuICAgICAgLy8gSXNzdWUgIzI2MTM6IGEgc3BlbnQgYmFsYW5jZSBuYW1lcyBpdHMgNDAyIOKAlCBrZWVwIGl0IGZvciB0aGUgYWxlcnQuXG4gICAgICAuLi4oaHR0cFN0YXR1cyAhPT0gdW5kZWZpbmVkID8geyBodHRwU3RhdHVzIH0gOiB7fSksXG4gICAgICBlcnJvcnM6IGRlY29kZWQuZXJyb3JzLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gVHJhbnNwb3J0IGJlZm9yZSByYXRlIGxpbWl0OiBhbiBvdmVybG9hZGVkIHVwc3RyZWFtIG1hdGNoZXMgdGhlXG4gIC8vIHJhdGUtbGltaXQgdm9jYWJ1bGFyeSBidXQgaXMgbm90IGEgbGltaXQgb24gdGhpcyBhY2NvdW50LlxuICBpZiAoXG4gICAgaXNOZXR3b3JrU3RhdHVzKGh0dHBTdGF0dXMpIHx8XG4gICAgTkVUV09SS19SRS50ZXN0KHN1cmZhY2UpXG4gICkge1xuICAgIHJldHVybiBhZ2VudEZhaWx1cmUoe1xuICAgICAgY2F0ZWdvcnk6IFwibmV0d29ya1wiLFxuICAgICAgbWVzc2FnZTogc2F5KFwiVGhlIENsYXVkZSBDTEkgY291bGQgbm90IHJlYWNoIHRoZSBBUElcIiksXG4gICAgICBldmlkZW5jZTogXCJwcm9zZVwiLFxuICAgICAgLi4uKGh0dHBTdGF0dXMgIT09IHVuZGVmaW5lZCA/IHsgaHR0cFN0YXR1cyB9IDoge30pLFxuICAgICAgZXJyb3JzOiBkZWNvZGVkLmVycm9ycyxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIEEgdHJhbnNpZW50IGxpbWl0OiBvbmx5IGEgcHJpbWFyeSBtYXRjaCBvciBhbiBleHBsaWNpdCA0MjksIG5ldmVyIHRoZVxuICAvLyB3ZWFrIFwidHJ5IGFnYWluIC8gcmV0cnkgLyBsaW1pdFwiIHZvY2FidWxhcnkgb24gaXRzIG93bi5cbiAgaWYgKGh0dHBTdGF0dXMgPT09IDQyOSB8fCBkZXRlY3RSYXRlTGltaXQoc3VyZmFjZSkuaXNQcmltYXJ5KSB7XG4gICAgY29uc3QgcmV0cnlBZnRlclNlY29uZHMgPSBleHRyYWN0UmV0cnlBZnRlclNlY29uZHMoc3VyZmFjZSk7XG4gICAgcmV0dXJuIGFnZW50RmFpbHVyZSh7XG4gICAgICBjYXRlZ29yeTogXCJyYXRlLWxpbWl0XCIsXG4gICAgICBtZXNzYWdlOiBzYXkoYCR7bmFtZX0gcmF0ZS1saW1pdGVkIHRoaXMgcmVxdWVzdGApLFxuICAgICAgZXZpZGVuY2U6IFwicHJvc2VcIixcbiAgICAgIC4uLihyZXRyeUFmdGVyU2Vjb25kcyAhPT0gdW5kZWZpbmVkID8geyByZXRyeUFmdGVyU2Vjb25kcyB9IDoge30pLFxuICAgICAgLi4uKGh0dHBTdGF0dXMgIT09IHVuZGVmaW5lZCA/IHsgaHR0cFN0YXR1cyB9IDoge30pLFxuICAgICAgZXJyb3JzOiBkZWNvZGVkLmVycm9ycyxcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiBhZ2VudEZhaWx1cmUoe1xuICAgIGNhdGVnb3J5OiBcInRhc2stZmFpbHVyZVwiLFxuICAgIG1lc3NhZ2U6IHNheShgVGhlIENsYXVkZSBDTEkgZXhpdGVkICR7c3RyZWFtcy5leGl0Q29kZX1gKSxcbiAgICBldmlkZW5jZTogXCJwcm9jZXNzXCIsXG4gICAgZXJyb3JzOiBkZWNvZGVkLmVycm9ycyxcbiAgfSk7XG59XG5cbi8qKlxuICogVGhlIGhlYWRsaW5lIGZvciBhIHF1b3RhIHJlZnVzYWw6IGEgc3BlbnQgYmFsYW5jZSBpcyBhIGJhbGFuY2UsIGEgc3BlbnRcbiAqIHdpbmRvdyBpcyBhIHdpbmRvdyAoSXNzdWUgIzI2MzMpLiBEZWVwU2VlaydzIGA0MDIgSW5zdWZmaWNpZW50IEJhbGFuY2VgIHdhc1xuICogcHVibGlzaGVkIGFzIFwiQ2xhdWRlJ3Mgc3Vic2NyaXB0aW9uIHdpbmRvdyBpcyBleGhhdXN0ZWRcIiDigJQgdGhlIHdyb25nXG4gKiBwcm92aWRlciBhbmQgdGhlIHdyb25nIGNvbmRpdGlvbi5cbiAqL1xuZnVuY3Rpb24gcXVvdGFIZWFkbGluZShuYW1lOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBCQUxBTkNFX0VYSEFVU1RFRF9SRS50ZXN0KHRleHQpXG4gICAgPyBgJHtuYW1lfSdzIGFjY291bnQgYmFsYW5jZSBpcyBzcGVudGBcbiAgICA6IGAke25hbWV9J3Mgc3Vic2NyaXB0aW9uIHdpbmRvdyBpcyBleGhhdXN0ZWRgO1xufVxuXG4vKipcbiAqIEFuIG91dHB1dCBhZGFwdGVyIGZvciBhIHByb3ZpZGVyIHRoYXQgcnVucyB0aGUgQ2xhdWRlIENvZGUgYmluYXJ5OiB0aGVcbiAqIGV2ZW50cyBhcmUgQ2xhdWRlIENvZGUncywgdGhlIHJlZnVzYWxzIG5hbWUgdGhlIHByb3ZpZGVyIChJc3N1ZSAjMjYzMykuXG4gKi9cbmZ1bmN0aW9uIGNsYXVkZUNvZGVPdXRwdXRBZGFwdGVyKFxuICBwcm92aWRlcklkOiBzdHJpbmcsXG4gIG5hbWU6IHN0cmluZyxcbik6IEFnZW50T3V0cHV0QWRhcHRlciB7XG4gIHJldHVybiB7XG4gICAgcHJvdmlkZXJJZCxcbiAgICBkZWNvZGU6IGRlY29kZUNsYXVkZU91dHB1dCxcbiAgICBjbGFzc2lmeTogKHN0cmVhbXMsIGRlY29kZWQpID0+XG4gICAgICBjbGFzc2lmeUNsYXVkZUZhaWx1cmUobmFtZSwgc3RyZWFtcywgZGVjb2RlZCksXG4gIH07XG59XG5cbi8qKiBDbGF1ZGUgQ29kZSdzIG91dHB1dCBhZGFwdGVyIGZvciB0aGUgQ2xhdWRlIHByb3ZpZGVyLiAqL1xuZXhwb3J0IGNvbnN0IENMQVVERV9PVVRQVVRfQURBUFRFUjogQWdlbnRPdXRwdXRBZGFwdGVyID1cbiAgY2xhdWRlQ29kZU91dHB1dEFkYXB0ZXIoUFJPVklERVJfSUQsIFwiQ2xhdWRlXCIpO1xuXG4vKipcbiAqIFRoZSBzYW1lIGFkYXB0ZXIgZm9yIERlZXBTZWVrLCB3aGljaCBydW5zIHRoZSBDbGF1ZGUgQ29kZSBiaW5hcnkgYWdhaW5zdFxuICogRGVlcFNlZWsncyBlbmRwb2ludDogaWRlbnRpY2FsIGV2ZW50cywgcmVmdXNhbHMgdGhhdCBuYW1lIERlZXBTZWVrLlxuICovXG5leHBvcnQgY29uc3QgREVFUFNFRUtfT1VUUFVUX0FEQVBURVI6IEFnZW50T3V0cHV0QWRhcHRlciA9XG4gIGNsYXVkZUNvZGVPdXRwdXRBZGFwdGVyKFwiZGVlcHNlZWtcIiwgXCJEZWVwU2Vla1wiKTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0EwQkMsR0FFRCxTQUdFLFlBQVksRUFNWixvQkFBb0IsRUFDcEIsc0JBQXNCLEVBQ3RCLGdCQUFnQixFQUNoQixpQkFBaUIsRUFDakIsd0JBQXdCLEVBQ3hCLGNBQWMsRUFDZCxlQUFlLEVBQ2YsZ0JBQWdCLEVBQ2hCLFVBQVUsRUFDVixnQkFBZ0IsUUFDWCxvQkFBb0I7QUFDM0IsU0FBUyxpQkFBaUIsUUFBUSxtQkFBbUI7QUFDckQsU0FDRSxzQkFBc0IsRUFDdEIsc0JBQXNCLEVBQ3RCLGlCQUFpQixFQUNqQixlQUFlLEVBQ2YsZ0JBQWdCLEVBQ2hCLHFCQUFxQixFQUNyQixvQkFBb0IsUUFDZix1QkFBdUI7QUFDOUIsU0FBUyxpQkFBaUIsUUFBUSxtQkFBbUI7QUFFckQsOENBQThDLEdBQzlDLE1BQU0sY0FBYztBQUVwQixpREFBaUQsR0FDakQsTUFBTSxhQUNKO0FBRUYsa0VBQWtFLEdBQ2xFLE1BQU0sb0JBQW9CO0FBRTFCLHNFQUFzRSxHQUN0RSxTQUFTLGNBQWMsS0FBOEI7RUFDbkQsTUFBTSxVQUFVLE1BQU0sT0FBTztFQUM3QixNQUFNLFVBQVUsU0FBUztFQUN6QixJQUFJLENBQUMsTUFBTSxPQUFPLENBQUMsVUFBVSxPQUFPO0VB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
// denoCacheMetadata=7659836513911899176,9645504937109571633