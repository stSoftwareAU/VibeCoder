/**
 * The Codex output adapter (Issue #1695, parent #1694).
 *
 * Fixtures are written to the pinned Codex CLI 0.147.0 `codex exec --json`
 * event shapes — that CLI is not installed here, and
 * `tests/fixtures/agent_output/README.md` says so rather than presenting them
 * as recordings. Both envelope generations are covered, because the adapter
 * accepts both.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CODEX_OUTPUT_ADAPTER } from "../lib/codex_output_adapter.ts";

const FIXTURE_DIR = new URL("./fixtures/agent_output/", import.meta.url);

/** Read a fixture; a missing one fails loudly rather than testing nothing. */
function fixture(name: string): string {
  return Deno.readTextFileSync(new URL(name, FIXTURE_DIR));
}

const SUCCESS = fixture("codex-0.147.0-success.jsonl");
const USAGE_LIMIT = fixture("codex-0.147.0-usage-limit.jsonl");
const RATE_LIMIT = fixture("codex-0.147.0-rate-limit-429.jsonl");
const AUTH_401 = fixture("codex-0.147.0-auth-401.jsonl");
const NOT_LOGGED_IN_ERR = fixture("codex-0.147.0-not-logged-in.stderr");
const MODEL_UNAVAILABLE = fixture("codex-0.147.0-model-unavailable.jsonl");
const MALFORMED = fixture("codex-0.147.0-malformed.jsonl");
const LEGACY = fixture("codex-0.147.0-legacy-envelope.jsonl");

/** Fixed clock so a `resets_in_seconds` window is asserted exactly. */
const NOW_MS = Date.UTC(2026, 8, 9, 4, 0, 0);

Deno.test("codex adapter - a completed turn yields the final agent message, session, usage and progress", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(SUCCESS);

  assertEquals(decoded.status, "completed");
  assertEquals(decoded.textSource, "final");
  assertStringIncludes(decoded.text, "Fixed the parser and the suite passes.");
  assertEquals(decoded.sessionId, "0199a5b2-7f31-7c4a-9e08-2b6a4c1d5e77");
  assertEquals(decoded.usage?.inputTokens, 18342);
  assertEquals(decoded.usage?.cacheReadTokens, 16000);
  assertEquals(decoded.usage?.outputTokens, 1201);
  assert(decoded.progress.events >= 3, "item events were not counted");
});

Deno.test("codex adapter - a success quoting a rate limit is a success, not a refusal", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(SUCCESS);
  const failure = CODEX_OUTPUT_ADAPTER.classify(
    { stdout: SUCCESS, stderr: "", exitCode: 0 },
    decoded,
  );

  assertStringIncludes(decoded.text, "429 Too Many Requests");
  assertEquals(failure, undefined);
});

Deno.test("codex adapter - JSON envelopes are never handed back as prose", () => {
  const envelopesOnly = [
    '{"type":"thread.started","thread_id":"t-9"}',
    '{"type":"turn.started"}',
  ].join("\n");

  const decoded = CODEX_OUTPUT_ADAPTER.decode(envelopesOnly);

  assertEquals(decoded.text, "");
  assertEquals(decoded.textSource, "none");
  assertEquals(decoded.status, "incomplete");
});

Deno.test("codex adapter - a subscription window carries its scope and reset", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(USAGE_LIMIT);
  const failure = CODEX_OUTPUT_ADAPTER.classify(
    { stdout: USAGE_LIMIT, stderr: "", exitCode: 1, nowMs: NOW_MS },
    decoded,
  );

  assertEquals(decoded.status, "failed");
  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.evidence, "structured");
  assertEquals(failure?.quota?.scope, "weekly");
  assertEquals(failure?.quota?.resetEpochMs, NOW_MS + 259_200_000);
  assertEquals(failure?.terminal, true);
});

Deno.test("codex adapter - a 429 is a transient rate limit with its retry-after, not an exhausted subscription", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(RATE_LIMIT);
  const failure = CODEX_OUTPUT_ADAPTER.classify(
    { stdout: RATE_LIMIT, stderr: "", exitCode: 1, nowMs: NOW_MS },
    decoded,
  );

  assertEquals(failure?.category, "rate-limit");
  assertEquals(failure?.httpStatus, 429);
  assertEquals(failure?.retryAfterSeconds, 30);
  assertEquals(failure?.terminal, false);
  assertEquals(failure?.quota, undefined);
});

Deno.test("codex adapter - a 401 is authentication, never model-unavailable", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(AUTH_401);
  const failure = CODEX_OUTPUT_ADAPTER.classify(
    { stdout: AUTH_401, stderr: "", exitCode: 1 },
    decoded,
  );

  assertEquals(failure?.category, "authentication");
  assertEquals(failure?.httpStatus, 401);
});

Deno.test("codex adapter - a stderr-only failure with no events at all still classifies", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode("");
  const failure = CODEX_OUTPUT_ADAPTER.classify(
    { stdout: "", stderr: NOT_LOGGED_IN_ERR, exitCode: 1 },
    decoded,
  );

  assertEquals(decoded.status, "unknown");
  assertEquals(failure?.category, "authentication");
  assertEquals(failure?.evidence, "prose");
  assertStringIncludes(failure?.message ?? "", "codex login");
});

Deno.test("codex adapter - a refused model is model-unavailable", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(MODEL_UNAVAILABLE);
  const failure = CODEX_OUTPUT_ADAPTER.classify(
    { stdout: MODEL_UNAVAILABLE, stderr: "", exitCode: 1 },
    decoded,
  );

  assertEquals(failure?.category, "model-unavailable");
  assertEquals(failure?.terminal, true);
});

Deno.test("codex adapter - malformed and truncated JSONL is skipped, never thrown on", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(MALFORMED);

  assertEquals(decoded.text, "Partial run: the branch is pushed.");
  assertEquals(decoded.textSource, "final");
  assert(decoded.malformedLines >= 2, "malformed lines were not counted");
  // The turn never completed, so the run is incomplete — not a success.
  assertEquals(decoded.status, "incomplete");
});

Deno.test("codex adapter - the legacy msg envelope decodes to the same contract", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(LEGACY);

  assertEquals(decoded.status, "completed");
  assertEquals(decoded.text, "Rebased onto the milestone branch and pushed.");
  assertEquals(decoded.sessionId, "0199a5b2-7f31-7c4a-9e08-2b6a4c1d5e7d");
  assertEquals(decoded.usage?.inputTokens, 9100);
  assertEquals(decoded.usage?.cacheReadTokens, 8000);
  assertEquals(decoded.usage?.outputTokens, 430);
  // A window that is merely 41.5% used is reported, not treated as exhausted.
  assertEquals(decoded.quota?.usedFraction, 0.415);
  assertEquals(decoded.quota?.scope, "five-hour");
});

Deno.test("codex adapter - a used-but-not-exhausted window is no failure at all", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(LEGACY);
  const failure = CODEX_OUTPUT_ADAPTER.classify(
    { stdout: LEGACY, stderr: "", exitCode: 0 },
    decoded,
  );

  assertEquals(failure, undefined);
});

Deno.test("codex adapter - the worker's own cancellation outranks the stream", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(USAGE_LIMIT);
  const failure = CODEX_OUTPUT_ADAPTER.classify(
    { stdout: USAGE_LIMIT, stderr: "", exitCode: 143, cancelled: true },
    decoded,
  );

  assertEquals(failure?.category, "cancelled");
  assertEquals(failure?.evidence, "process");
});

Deno.test("codex adapter - unknown structured error fields are preserved verbatim", () => {
  const decoded = CODEX_OUTPUT_ADAPTER.decode(USAGE_LIMIT);
  const error = decoded.errors.find((e) => e.code === "usage_limit_reached");

  assert(error, "the structured error was not captured");
  assertEquals(error?.raw.plan_type, "pro");
});
