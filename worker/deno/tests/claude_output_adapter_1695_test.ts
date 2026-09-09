/**
 * The Claude output adapter (Issue #1695, parent #1694).
 *
 * Every stdout fixture is a real recording from the pinned Claude Code
 * 2.1.261 CLI, or is derived from one of those recordings' envelope shapes —
 * `tests/fixtures/agent_output/README.md` states which is which and how the
 * recordings were made.
 *
 * The compatibility assertions matter as much as the new ones: the text the
 * adapter hands back must stay byte-identical to `extractStreamJsonText`, so
 * wiring the adapter into the runner changes no existing Claude result.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CLAUDE_OUTPUT_ADAPTER } from "../lib/claude_output_adapter.ts";
import { extractStreamJsonText } from "../lib/claude_executor.ts";

const FIXTURE_DIR = new URL("./fixtures/agent_output/", import.meta.url);

/** Read a fixture; a missing one fails loudly rather than testing nothing. */
function fixture(name: string): string {
  return Deno.readTextFileSync(new URL(name, FIXTURE_DIR));
}

const AUTH_FAILURE = fixture("claude-2.1.261-auth-failure.jsonl");
const INVALID_SESSION = fixture("claude-2.1.261-invalid-session.jsonl");
const INVALID_SESSION_ERR = fixture("claude-2.1.261-invalid-session.stderr");
const UNRECOGNISED_MODEL = fixture("claude-2.1.261-unrecognised-model.jsonl");
const UNRECOGNISED_MODEL_ERR = fixture(
  "claude-2.1.261-unrecognised-model.stderr",
);
const SUCCESS_QUOTED_LIMIT = fixture(
  "claude-2.1.261-success-quoted-rate-limit.jsonl",
);
const USAGE_LIMIT_ERR = fixture("claude-2.1.261-usage-limit.stderr");

Deno.test("claude adapter - a recorded is_error result is failed, not the envelope's subtype 'success'", () => {
  const decoded = CLAUDE_OUTPUT_ADAPTER.decode(AUTH_FAILURE);

  assertEquals(decoded.status, "failed");
  assertEquals(decoded.textSource, "final");
  assertEquals(decoded.text, "Not logged in · Please run /login");
  assertEquals(decoded.sessionId, "00000000-0000-4000-8000-000000000001");
  // The CLI's own structured verdict is preserved, unknown fields and all.
  assert(
    decoded.errors.some((e) => e.code === "authentication_failed"),
    "the assistant line's error code is not preserved",
  );
});

Deno.test("claude adapter - a recorded authentication failure classifies as authentication, on structured evidence", () => {
  const decoded = CLAUDE_OUTPUT_ADAPTER.decode(AUTH_FAILURE);
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    { stdout: AUTH_FAILURE, stderr: "", exitCode: 1 },
    decoded,
  );

  assertEquals(failure?.category, "authentication");
  assertEquals(failure?.evidence, "structured");
  assertEquals(failure?.terminal, true);
});

Deno.test("claude adapter - the CLI's recorded session-flag refusal classifies as invalid-session", () => {
  const decoded = CLAUDE_OUTPUT_ADAPTER.decode(INVALID_SESSION);
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    { stdout: INVALID_SESSION, stderr: INVALID_SESSION_ERR, exitCode: 1 },
    decoded,
  );

  assertEquals(failure?.category, "invalid-session");
  assertEquals(failure?.terminal, false);
});

Deno.test("claude adapter - a 401/403-shaped refusal is authentication, never model-unavailable", () => {
  const streams = {
    stdout: "",
    stderr: "API error: 403 Forbidden\nRequest was rejected.",
    exitCode: 1,
  };
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    streams,
    CLAUDE_OUTPUT_ADAPTER.decode(streams.stdout),
  );

  assertEquals(failure?.category, "authentication");
  assertEquals(failure?.httpStatus, 403);
});

Deno.test("claude adapter - a 403 that names the model IS model-unavailable", () => {
  const streams = {
    stdout: "",
    stderr:
      "API error: 403 Forbidden — your organisation does not have access to model claude-fable-5.",
    exitCode: 1,
  };
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    streams,
    CLAUDE_OUTPUT_ADAPTER.decode(streams.stdout),
  );

  assertEquals(failure?.category, "model-unavailable");
});

Deno.test("claude adapter - the recorded unrecognised-model run keeps both streams' evidence", () => {
  const decoded = CLAUDE_OUTPUT_ADAPTER.decode(UNRECOGNISED_MODEL);
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    {
      stdout: UNRECOGNISED_MODEL,
      stderr: UNRECOGNISED_MODEL_ERR,
      exitCode: 1,
    },
    decoded,
  );

  // The CLI's own structured verdict was "authentication_failed"; the stderr
  // line about the model is evidence, not a second verdict.
  assertEquals(failure?.category, "authentication");
  assertStringIncludes(failure?.message ?? "", "unrecognized_model");
});

Deno.test("claude adapter - success whose prose quotes a rate limit is a success, not a refusal", () => {
  const decoded = CLAUDE_OUTPUT_ADAPTER.decode(SUCCESS_QUOTED_LIMIT);
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    { stdout: SUCCESS_QUOTED_LIMIT, stderr: "", exitCode: 0 },
    decoded,
  );

  assertEquals(decoded.status, "completed");
  assertStringIncludes(decoded.text, "429 Too Many Requests");
  assertEquals(failure, undefined);
  assertEquals(decoded.usage?.inputTokens, 4210);
});

Deno.test("claude adapter - a stderr-only usage limit carries the scope and the parsed reset", () => {
  const streams = { stdout: "", stderr: USAGE_LIMIT_ERR, exitCode: 1 };
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    streams,
    CLAUDE_OUTPUT_ADAPTER.decode(streams.stdout),
  );

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.quota?.resetEpochMs, 1788875400000);
  // No scope was stated, so none is invented.
  assertEquals(failure?.quota?.scope, "unknown");
});

Deno.test("claude adapter - a stated weekly window is carried as its scope", () => {
  const streams = {
    stdout: "",
    stderr:
      "Claude AI usage limit reached — weekly limit, resets Aug 25, 1am (UTC)",
    exitCode: 1,
  };
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    streams,
    CLAUDE_OUTPUT_ADAPTER.decode(streams.stdout),
  );

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.quota?.scope, "weekly");
});

Deno.test("claude adapter - a transient 429 is a rate limit, not an exhausted subscription", () => {
  const streams = {
    stdout: "",
    stderr: "API error: 429 Too Many Requests (retry-after: 45)",
    exitCode: 1,
  };
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    streams,
    CLAUDE_OUTPUT_ADAPTER.decode(streams.stdout),
  );

  assertEquals(failure?.category, "rate-limit");
  assertEquals(failure?.retryAfterSeconds, 45);
  assertEquals(failure?.terminal, false);
});

Deno.test("claude adapter - overload and connection failures are network, not rate limits", () => {
  for (
    const stderr of [
      "API error: 529 overloaded_error",
      "fetch failed: ECONNRESET while connecting to api.anthropic.com",
    ]
  ) {
    const failure = CLAUDE_OUTPUT_ADAPTER.classify(
      { stdout: "", stderr, exitCode: 1 },
      CLAUDE_OUTPUT_ADAPTER.decode(""),
    );
    assertEquals(failure?.category, "network", stderr);
  }
});

Deno.test("claude adapter - the worker's own process facts win over any output", () => {
  const cancelled = CLAUDE_OUTPUT_ADAPTER.classify(
    {
      stdout: "",
      stderr: "429 Too Many Requests",
      exitCode: 143,
      cancelled: true,
    },
    CLAUDE_OUTPUT_ADAPTER.decode(""),
  );
  assertEquals(cancelled?.category, "cancelled");
  assertEquals(cancelled?.evidence, "process");

  const timedOut = CLAUDE_OUTPUT_ADAPTER.classify(
    {
      stdout: "",
      stderr: "429 Too Many Requests",
      exitCode: 124,
      timedOut: true,
    },
    CLAUDE_OUTPUT_ADAPTER.decode(""),
  );
  assertEquals(timedOut?.category, "timeout");

  const oom = CLAUDE_OUTPUT_ADAPTER.classify(
    {
      stdout: "",
      stderr:
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      exitCode: 137,
    },
    CLAUDE_OUTPUT_ADAPTER.decode(""),
  );
  assertEquals(oom?.category, "out-of-memory");
});

Deno.test("claude adapter - an unexplained non-zero exit is an ordinary task failure", () => {
  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    {
      stdout: "",
      stderr: "the quality gate reported 2 failing tests",
      exitCode: 1,
    },
    CLAUDE_OUTPUT_ADAPTER.decode(""),
  );

  assertEquals(failure?.category, "task-failure");
  assertEquals(failure?.evidence, "process");
});

Deno.test("claude adapter - the decoded text stays byte-identical to extractStreamJsonText", () => {
  for (
    const raw of [
      AUTH_FAILURE,
      INVALID_SESSION,
      UNRECOGNISED_MODEL,
      SUCCESS_QUOTED_LIMIT,
      "plain CLI output with no JSON at all\n",
      "",
    ]
  ) {
    assertEquals(
      CLAUDE_OUTPUT_ADAPTER.decode(raw).text,
      extractStreamJsonText(raw),
    );
  }
});

Deno.test("claude adapter - non-JSON output is reported as raw, never as a final answer", () => {
  const decoded = CLAUDE_OUTPUT_ADAPTER.decode("plain CLI output\n");

  assertEquals(decoded.textSource, "raw");
  assertEquals(decoded.status, "unknown");
});

Deno.test("claude adapter - a failed run's quoted limit is not a refusal when the CLI said otherwise", () => {
  // The agent's answer quotes a usage limit; the CLI's own error says the
  // quality gate failed. The quotation must not become the verdict.
  const stdout = [
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "00000000-0000-4000-8000-000000000009",
      result:
        "The gate output quoted `Claude AI usage limit reached|1788875400` and a 429 Too Many Requests.",
    }),
  ].join("\n");
  const streams = {
    stdout,
    stderr: "the quality gate reported 2 failing tests",
    exitCode: 1,
  };

  const failure = CLAUDE_OUTPUT_ADAPTER.classify(
    streams,
    CLAUDE_OUTPUT_ADAPTER.decode(stdout),
  );

  assertEquals(failure?.category, "task-failure");
});

Deno.test("claude adapter - an envelope-only stream is never reported as the agent's prose", () => {
  const decoded = CLAUDE_OUTPUT_ADAPTER.decode(INVALID_SESSION);

  // The raw stream is still passed through for compatibility, but the source
  // says plainly that it is not an answer.
  assertEquals(decoded.textSource, "none");
  assertEquals(decoded.status, "failed");
  assert(decoded.text.includes('"type":"result"'), "the raw stream is kept");
});
