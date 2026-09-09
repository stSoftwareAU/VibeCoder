/**
 * The provider-neutral agent output contract (Issue #1695, parent #1694).
 *
 * Everything the worker learns from one agent invocation used to be read in
 * Claude's shape: `extractStreamJsonText` for the answer, a ladder of
 * `detect*` regexes over the tail of stdout+stderr for the failure. A second
 * vendor's CLI writes neither, so its JSONL was handed on as if it were prose
 * and its refusals were classified by whichever Claude pattern happened to
 * match — which is how a quoted "429" in an agent's own answer could read as a
 * refusal, and a 403 could read as an unavailable model.
 *
 * This module is the contract both vendors are decoded *into*: one typed
 * result (final text, session identity, usage, progress, terminal status,
 * structured errors) and one typed failure (a named category, its evidence,
 * quota scope and reset, retry-after). The per-provider adapters
 * (`claude_output_adapter.ts`, `codex_output_adapter.ts`) own their CLI's
 * event shapes and nothing else; the provider descriptor names the adapter, so
 * the runner never tests a vendor id.
 *
 * Three rules the whole contract exists to keep:
 *
 * - **A JSON event envelope is not prose.** An adapter that cannot find the
 *   agent's answer reports `textSource: "none"`, never the raw JSONL.
 * - **Evidence beats vocabulary.** A structured event is preferred over prose,
 *   and a *successful* run's quoted "rate limit" text is a quotation, not a
 *   refusal — classification only runs on a failed process.
 * - **Nothing is invented.** An unstated quota scope stays `"unknown"`, an
 *   unparsed field is preserved on `raw` rather than defaulted, and every
 *   malformed line is counted rather than silently dropped.
 *
 * ```mermaid
 * flowchart LR
 *     S["stdout / stderr / exit"] --> A["provider.output<br/>(adapter)"]
 *     A --> D["AgentDecodedOutput<br/>text · session · usage · status"]
 *     A --> F["AgentFailure<br/>category · evidence · quota"]
 *     D --> R["ClaudeRunResult.agentOutput"]
 *     F --> R2["ClaudeRunResult.agentFailure"]
 * ```
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { redactSecrets } from "./secret_redaction.ts";
import type { TokenUsage } from "./token_usage.ts";

/** How the run ended, as the provider's own events reported it. */
export type AgentTerminalStatus =
  /** The provider said the turn finished. */
  | "completed"
  /** The provider said the turn failed. */
  | "failed"
  /** Events were read, but none reported a terminal outcome. */
  | "incomplete"
  /** Nothing decodable was emitted — the CLI died before it said anything. */
  | "unknown";

/** Where {@link AgentDecodedOutput.text} came from. */
export type AgentTextSource =
  /** The provider's own final-answer event. */
  | "final"
  /** Concatenated intermediate assistant text — a run cut off mid-turn. */
  | "partial"
  /** Output that is not the provider's event format at all, passed through. */
  | "raw"
  /** No answer was found; the text is empty (never a JSON envelope). */
  | "none";

/** The normalised failure categories every provider is classified into. */
export const AGENT_FAILURE_CATEGORIES = [
  "authentication",
  "model-unavailable",
  "quota-exhausted",
  "rate-limit",
  "network",
  "invalid-session",
  "timeout",
  "out-of-memory",
  "cancelled",
  "task-failure",
] as const;

/** One normalised failure category. */
export type AgentFailureCategory = typeof AGENT_FAILURE_CATEGORIES[number];

/** What the classification was actually read from. */
export type AgentEvidenceKind =
  /** A machine-readable event the provider emitted. */
  | "structured"
  /** The provider's own error prose, matched narrowly. */
  | "prose"
  /** A fact of the process itself: the watchdog, a cancellation, an exit. */
  | "process";

/**
 * The billing window a quota failure names.
 *
 * `"unknown"` is a first-class answer: a refusal that states no window is
 * reported without one rather than being assigned the vendor's most common
 * window, which would make the scheduler wait on a window nobody mentioned.
 */
export type AgentQuotaScope =
  | "five-hour"
  | "weekly"
  | "monthly"
  | "account"
  | "unknown";

/** A quota window, as far as the provider described it. */
export interface AgentQuota {
  /** Which window; `"unknown"` when the provider did not say. */
  scope: AgentQuotaScope;
  /** When the window reopens, when the provider said. */
  resetEpochMs?: number;
  /**
   * Seconds until the window reopens, when the provider reported a duration
   * rather than an instant. Kept as reported: turning it into an instant
   * needs a clock the decoder does not own, and the classifier that does own
   * one records the instant on {@link resetEpochMs}.
   */
  resetsInSeconds?: number;
  /** Fraction of the window consumed (0–1), when the provider reported it. */
  usedFraction?: number;
}

/** One structured error event, preserved as the provider emitted it. */
export interface AgentStructuredError {
  /** The event type it came from, e.g. `turn.failed` or `result`. */
  source: string;
  /** The provider's own message text. */
  message: string;
  /** The provider's error code, when the event carried one. */
  code?: string;
  /** The HTTP status, when the event carried one. */
  httpStatus?: number;
  /**
   * The event's own object, verbatim (Issue #1695).
   *
   * Fields this worker does not understand — a new `plan_type`, a vendor's
   * next schema addition — survive here rather than being dropped, so a
   * consumer can read them without the adapter being taught about them first.
   */
  raw: Readonly<Record<string, unknown>>;
}

/** How much of the run the provider reported doing. */
export interface AgentProgress {
  /** Number of decodable progress events (tool calls, turns, messages). */
  events: number;
  /** The last human-readable progress line, when there was one. */
  last?: string;
}

/** One agent invocation, decoded into the shared contract. */
export interface AgentDecodedOutput {
  /** The agent's answer; empty when none was found. */
  text: string;
  /** Where {@link text} came from — never "final" for a JSON envelope. */
  textSource: AgentTextSource;
  /** What the provider's events said about how the run ended. */
  status: AgentTerminalStatus;
  /** The provider's session/thread identity, when it emitted one. */
  sessionId?: string;
  /** Token counts, when the provider reported them. */
  usage?: TokenUsage;
  /** Progress evidence. */
  progress: AgentProgress;
  /** Every structured error event, in the order they were emitted. */
  errors: readonly AgentStructuredError[];
  /** A quota window the stream reported, exhausted or not. */
  quota?: AgentQuota;
  /** Lines that were not decodable events — counted, never thrown on. */
  malformedLines: number;
}

/** The streams and process facts one classification is made from. */
export interface AgentRunStreams {
  /** Raw stdout from the CLI. */
  stdout: string;
  /** Raw stderr from the CLI. */
  stderr: string;
  /** The child's exit code. */
  exitCode: number;
  /** A worker watchdog fired. */
  timedOut?: boolean;
  /** The worker asked for this process to stop (shutdown, scheduled release). */
  cancelled?: boolean;
  /** Clock for reset arithmetic; defaults to now. Injected by tests. */
  nowMs?: number;
}

/** One normalised failure. */
export interface AgentFailure {
  /** The normalised category. */
  category: AgentFailureCategory;
  /** Operator-facing summary, carrying the redacted evidence excerpt. */
  message: string;
  /** What the category was read from. */
  evidence: AgentEvidenceKind;
  /** Whether retrying the same call is futile. */
  terminal: boolean;
  /** Seconds the provider asked the caller to wait, when it said. */
  retryAfterSeconds?: number;
  /** The HTTP status behind the failure, when one was reported. */
  httpStatus?: number;
  /** The quota window, for a quota failure that named one. */
  quota?: AgentQuota;
  /** The structured evidence, preserved verbatim. */
  errors: readonly AgentStructuredError[];
}

/** One provider's decoder and classifier. */
export interface AgentOutputAdapter {
  /** The provider id this adapter decodes for. */
  providerId: string;
  /** Decode one run's stdout into the shared contract. */
  decode(stdout: string): AgentDecodedOutput;
  /**
   * Classify one failed run. Returns `undefined` when the run did not fail —
   * which is what stops a success that *quotes* a rate limit being read as
   * one.
   */
  classify(
    streams: AgentRunStreams,
    decoded: AgentDecodedOutput,
  ): AgentFailure | undefined;
}

/**
 * Categories retrying cannot recover: the credential, the window, the memory
 * or the decision is the same on the next attempt.
 */
const TERMINAL_CATEGORIES: ReadonlySet<AgentFailureCategory> = new Set([
  "authentication",
  "model-unavailable",
  "quota-exhausted",
  "timeout",
  "out-of-memory",
  "cancelled",
  "task-failure",
]);

/**
 * Whether retrying the identical call is futile for this category.
 *
 * `model-unavailable` is terminal *for the model*: the recovery is the
 * provider's cheaper-model ladder, not a repeat of the same request.
 *
 * @param category - The normalised category.
 * @returns True when the caller must not simply retry.
 */
export function isTerminalFailureCategory(
  category: AgentFailureCategory,
): boolean {
  return TERMINAL_CATEGORIES.has(category);
}

/** One decoded JSONL line. */
export interface AgentJsonEvent {
  /** One-based line number in the raw stream, for evidence. */
  line: number;
  /** The decoded object. */
  value: Record<string, unknown>;
}

/** The outcome of decoding a whole JSONL stream. */
export interface ParsedJsonl {
  /** Every line that decoded to a JSON object. */
  events: AgentJsonEvent[];
  /** Lines that did not — a log line, a truncated final write. */
  malformedLines: number;
}

/**
 * Decode a JSONL stream, tolerating everything a real CLI mixes into it.
 *
 * A CLI interleaves its own log lines, and a killed process leaves its last
 * line truncated. Neither throws here: both are counted, so a consumer can
 * say how much of the stream it could not read instead of pretending the run
 * emitted nothing.
 *
 * @param raw - Raw stdout.
 * @returns The decoded object lines and the count of the rest.
 */
export function parseJsonlEvents(raw: string): ParsedJsonl {
  const events: AgentJsonEvent[] = [];
  let malformedLines = 0;
  if (!raw.trim()) return { events, malformedLines };

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        events.push({ line: i + 1, value: value as Record<string, unknown> });
      } else {
        malformedLines++;
      }
    } catch {
      malformedLines++;
    }
  }
  return { events, malformedLines };
}

/** Default number of evidence lines carried in a failure message. */
const DEFAULT_EVIDENCE_LINES = 5;

/**
 * The redacted tail of `text`, bounded to `maxLines`.
 *
 * The tail, because a failure ends with its cause; redacted, because the
 * message reaches logs and issue comments.
 *
 * @param text - The stream to excerpt.
 * @param maxLines - Lines to keep from the end.
 * @returns The redacted excerpt, empty when there is nothing to show.
 */
export function redactedEvidence(
  text: string,
  maxLines: number = DEFAULT_EVIDENCE_LINES,
): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return redactSecrets(lines.slice(-maxLines).join("\n"));
}

/** HTTP statuses worth naming; anything else is not inferred from digits. */
const HTTP_STATUS_RE = /\b(401|403|404|408|409|429|500|502|503|504|529)\b/;

/**
 * The HTTP status a message names, when it names one.
 *
 * Deliberately an allowlist: matching any three digits would read a token
 * count or a line number as a status and classify on it.
 *
 * @param text - The message to read.
 * @returns The status, or undefined.
 */
export function extractHttpStatus(text: string): number | undefined {
  const match = HTTP_STATUS_RE.exec(text);
  return match?.[1] ? Number(match[1]) : undefined;
}

/** `retry-after: 30`, `retry after 30 seconds`, `try again in 45s`. */
const RETRY_AFTER_RE =
  /retry[-_ ]after["':\s]+(\d+)|retry (?:in|after) (\d+)\s*(?:s\b|sec|second)|try again in (\d+)\s*(?:s\b|sec|second)/i;

/**
 * The retry delay a message states, in seconds.
 *
 * @param text - The message to read.
 * @returns The delay, or undefined when none was stated — never a default,
 *   because an invented delay is indistinguishable from a measured one.
 */
export function extractRetryAfterSeconds(text: string): number | undefined {
  const match = RETRY_AFTER_RE.exec(text);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? Number(value) : undefined;
}

/** Window vocabulary; anything else leaves the scope `"unknown"`. */
const SCOPE_PATTERNS: readonly (readonly [RegExp, AgentQuotaScope])[] = [
  [/\b(?:5|five)[-\s]?hour\b/i, "five-hour"],
  [/\bweekly\b|\b7[-\s]?day\b|\bseven[-\s]?day\b|\bper week\b/i, "weekly"],
  [/\bmonthly\b|\bper month\b|\b30[-\s]?day\b/i, "monthly"],
  [/\baccount[-\s]?wide\b|\borganisation\b|\borganization\b/i, "account"],
];

/**
 * The billing window a message names.
 *
 * @param text - The refusal text.
 * @returns The named scope, or `"unknown"` when none was named.
 */
export function detectQuotaScope(text: string): AgentQuotaScope {
  for (const [pattern, scope] of SCOPE_PATTERNS) {
    if (pattern.test(text)) return scope;
  }
  return "unknown";
}

/**
 * Build a failure, filling in the terminal verdict from the category.
 *
 * @param input - The category, message and evidence, plus any structured
 *   detail the adapter read.
 * @returns The normalised failure.
 */
export function agentFailure(input: {
  category: AgentFailureCategory;
  message: string;
  evidence: AgentEvidenceKind;
  retryAfterSeconds?: number;
  httpStatus?: number;
  quota?: AgentQuota;
  errors?: readonly AgentStructuredError[];
}): AgentFailure {
  return {
    category: input.category,
    message: input.message,
    evidence: input.evidence,
    terminal: isTerminalFailureCategory(input.category),
    ...(input.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: input.retryAfterSeconds }
      : {}),
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
    ...(input.quota ? { quota: input.quota } : {}),
    errors: input.errors ?? [],
  };
}

/**
 * Classify the facts the worker knows without reading a single CLI byte.
 *
 * These outrank everything in the streams (Issue #4369's precedent): a run the
 * worker cancelled, or a watchdog killed, must never be re-explained by
 * whatever its output happened to end with — the agent's own tool output
 * quoting "rate limit" is exactly what used to be read as one.
 *
 * @param streams - The run's process facts.
 * @returns The failure, or undefined when the process itself explains nothing.
 */
export function classifyProcessOutcome(
  streams: AgentRunStreams,
): AgentFailure | undefined {
  if (streams.cancelled) {
    return agentFailure({
      category: "cancelled",
      message: "The worker stopped this agent run before it finished.",
      evidence: "process",
    });
  }
  if (streams.timedOut) {
    return agentFailure({
      category: "timeout",
      message: "The agent run was stopped by the worker's watchdog.",
      evidence: "process",
    });
  }
  return undefined;
}
