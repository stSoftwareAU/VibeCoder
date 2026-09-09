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
  isTerminalFailureCategory,
  parseJsonlEvents,
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
