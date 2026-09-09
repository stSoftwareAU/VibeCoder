/**
 * The provider-neutral agent-output contract (Issue #1695, parent #1694).
 *
 * These cover the shared layer only — JSONL tolerance, evidence redaction and
 * the terminal/retryable split every provider's classification is read
 * through. The per-provider adapters have their own suites.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  AGENT_FAILURE_CATEGORIES,
  agentFailure,
  classifyProcessOutcome,
  detectQuotaScope,
  extractHttpStatus,
  extractRetryAfterSeconds,
  isNetworkStatus,
  isTerminalFailureCategory,
  parseJsonlEvents,
  readNumber,
  readObject,
  readString,
  redactedEvidence,
} from "../lib/agent_output.ts";

Deno.test("parseJsonlEvents - keeps every field of every event verbatim", () => {
  const raw = [
    '{"type":"thread.started","thread_id":"t-1","unknown_future_field":{"a":1}}',
    '{"type":"turn.completed","usage":{"input_tokens":10}}',
  ].join("\n");

  const parsed = parseJsonlEvents(raw);

  assertEquals(parsed.events.length, 2);
  assertEquals(parsed.malformedLines, 0);
  // Unknown fields are preserved, never dropped or defaulted (Issue #1695).
  assertEquals(parsed.events[0]?.value.unknown_future_field, { a: 1 });
  assertEquals(parsed.events[0]?.line, 1);
});

Deno.test("parseJsonlEvents - skips malformed and non-JSON lines, counting them", () => {
  const raw = [
    '{"type":"thread.started","thread_id":"t-1"}',
    "2026-09-09T04:10:11Z INFO codex_core: starting session",
    '{"type":"item.completed","item":{"item_type":"agent_message","text":"done"}}',
    '{"type":"turn.completed","usage":{"input_tokens":120,', // truncated
  ].join("\n");

  const parsed = parseJsonlEvents(raw);

  assertEquals(parsed.events.length, 2);
  assertEquals(parsed.malformedLines, 2);
});

Deno.test("parseJsonlEvents - a JSON scalar or array line is not an event", () => {
  const parsed = parseJsonlEvents('"just a string"\n[1,2,3]\n{"type":"ok"}');

  assertEquals(parsed.events.length, 1);
  assertEquals(parsed.malformedLines, 2);
});

Deno.test("parseJsonlEvents - empty input yields no events and no malformed lines", () => {
  const parsed = parseJsonlEvents("   \n\n");

  assertEquals(parsed.events.length, 0);
  assertEquals(parsed.malformedLines, 0);
});

Deno.test("redactedEvidence - redacts secrets and bounds the excerpt", () => {
  const text = [
    "line one",
    "ghp_0123456789012345678901234567890123456789",
    "line three",
    "line four",
  ].join("\n");

  const evidence = redactedEvidence(text, 2);

  assert(!evidence.includes("ghp_0123456789012345678901234567890123456789"));
  assertEquals(evidence.split("\n").length, 2);
  // The tail is what a failure ends with, so that is what is kept.
  assert(evidence.includes("line four"));
});

Deno.test("isTerminalFailureCategory - every category has an explicit verdict", () => {
  for (const category of AGENT_FAILURE_CATEGORIES) {
    assertEquals(
      typeof isTerminalFailureCategory(category),
      "boolean",
      `${category} has no terminal verdict`,
    );
  }
  // The retryable ones: a wait or a flag change can recover them.
  assertEquals(isTerminalFailureCategory("rate-limit"), false);
  assertEquals(isTerminalFailureCategory("network"), false);
  assertEquals(isTerminalFailureCategory("invalid-session"), false);
  // The terminal ones: retrying spends the same exhausted resource.
  assertEquals(isTerminalFailureCategory("quota-exhausted"), true);
  assertEquals(isTerminalFailureCategory("authentication"), true);
  assertEquals(isTerminalFailureCategory("out-of-memory"), true);
  assertEquals(isTerminalFailureCategory("cancelled"), true);
});

Deno.test("extractHttpStatus - reads a named status and ignores any other number", () => {
  assertEquals(extractHttpStatus("API error: 429 Too Many Requests"), 429);
  assertEquals(extractHttpStatus("401 Unauthorized"), 401);
  // An allowlist, not "any three digits": a token count is not a status.
  assertEquals(
    extractHttpStatus("used 512 input tokens over 300 seconds"),
    undefined,
  );
  assertEquals(extractHttpStatus("line 404040 of the log"), undefined);
  assertEquals(extractHttpStatus(""), undefined);
});

Deno.test("extractRetryAfterSeconds - reads every phrasing, and invents nothing", () => {
  assertEquals(extractRetryAfterSeconds("retry-after: 30"), 30);
  assertEquals(extractRetryAfterSeconds('"retry_after": 12'), 12);
  assertEquals(extractRetryAfterSeconds("please retry in 45 seconds"), 45);
  assertEquals(extractRetryAfterSeconds("try again in 5s"), 5);
  // No stated delay means no delay — never a default that reads as measured.
  assertEquals(extractRetryAfterSeconds("please try again later"), undefined);
});

Deno.test("detectQuotaScope - names only the window the message names", () => {
  assertEquals(detectQuotaScope("your 5-hour limit is spent"), "five-hour");
  assertEquals(detectQuotaScope("weekly usage limit reached"), "weekly");
  assertEquals(detectQuotaScope("monthly quota exhausted"), "monthly");
  assertEquals(detectQuotaScope("account-wide limit"), "account");
  assertEquals(detectQuotaScope("you have hit your limit"), "unknown");
});

Deno.test("isNetworkStatus - server and overload statuses only", () => {
  assertEquals(isNetworkStatus(503), true);
  assertEquals(isNetworkStatus(529), true);
  assertEquals(isNetworkStatus(429), false);
  assertEquals(isNetworkStatus(403), false);
  assertEquals(isNetworkStatus(undefined), false);
});

Deno.test("readString / readNumber / readObject - a wrong type is absent, never coerced", () => {
  assertEquals(readString("id-1"), "id-1");
  assertEquals(readString(""), undefined);
  assertEquals(readString(7), undefined);
  assertEquals(readNumber(0), 0);
  assertEquals(readNumber(Number.NaN), undefined);
  assertEquals(readNumber("12"), undefined);
  assertEquals(readObject({ a: 1 }), { a: 1 });
  assertEquals(readObject([1, 2]), undefined);
  assertEquals(readObject(null), undefined);
});

Deno.test("agentFailure - the terminal verdict comes from the category, not the caller", () => {
  const rateLimit = agentFailure({
    category: "rate-limit",
    message: "limited",
    evidence: "prose",
    retryAfterSeconds: 30,
  });
  assertEquals(rateLimit.terminal, false);
  assertEquals(rateLimit.retryAfterSeconds, 30);
  assertEquals(rateLimit.errors, []);

  assertEquals(
    agentFailure({
      category: "quota-exhausted",
      message: "spent",
      evidence: "structured",
    }).terminal,
    true,
  );
});

Deno.test("classifyProcessOutcome - the worker's own facts, and nothing else", () => {
  assertEquals(
    classifyProcessOutcome({
      stdout: "",
      stderr: "",
      exitCode: 143,
      cancelled: true,
    })
      ?.category,
    "cancelled",
  );
  assertEquals(
    classifyProcessOutcome({
      stdout: "",
      stderr: "",
      exitCode: 124,
      timedOut: true,
    })
      ?.category,
    "timeout",
  );
  // A plain non-zero exit is not the process explaining itself.
  assertEquals(
    classifyProcessOutcome({ stdout: "", stderr: "boom", exitCode: 1 }),
    undefined,
  );
});
