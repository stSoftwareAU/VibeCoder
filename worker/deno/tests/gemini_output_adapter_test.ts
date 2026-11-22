/**
 * The Gemini CLI output adapter (Issue #5340, parent #1695).
 *
 * Every expected value here is a literal read from the fixtures or written
 * out by hand; nothing is computed by calling the implementation. The
 * fixtures are derived to the Gemini CLI 0.68.0 `stream-json` shape (see
 * `fixtures/agent_output/README.md`). The last group runs the real runner
 * against a stub that replays a fixture, and asserts the outage window and
 * the provider status it leaves behind.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type AgentOutputAdapter,
  type AgentRunStreams,
} from "../lib/agent_output.ts";
import {
  agentProviderById,
  IMAGE_AGENT_PROVIDERS_ENV,
} from "../lib/agent_provider.ts";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import { resolveAutomaticProviderStatus } from "../lib/provider_auto_runtime.ts";
import {
  automaticProviderOutage,
  resetAutomaticProviderState,
  setAutomaticProviderRoutingActive,
} from "../lib/provider_auto_state.ts";
import {
  installProviderOutageAlerter,
  isProviderOutageAlertable,
  type ProviderRunOutcome,
} from "../lib/provider_outage_alert.ts";
import { envFrom } from "./support/env_lookup.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** A fixed clock for every reset calculation (2025-10-09T06:13:20Z). */
const NOW_MS = 1_760_000_000_000;

/** The session id every derived fixture carries. */
const SESSION_ID = "00000000-0000-4000-8000-000000000005";

/** A timestamp for the inline streams (the CLI writes one on every event). */
const TS = "2026-11-20T12:00:00.000Z";

/** The success fixture's final turn, concatenated from its two delta chunks. */
const FINAL_TEXT =
  `Done. The log quoted "You have exhausted your capacity on this model. Your quota will reset after 1h0m0s." and "429 Too Many Requests" and "Request had invalid authentication credentials" — none of it applies to this run.`;

/** Read one derived fixture by name. */
function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./fixtures/agent_output/${name}`, import.meta.url),
  );
}

/** The Gemini adapter, through the descriptor the runner reaches it by. */
function geminiAdapter(): AgentOutputAdapter {
  const adapter = agentProviderById("gemini")?.output;
  assert(adapter !== undefined, "the Gemini descriptor names an adapter");
  return adapter;
}

/** One JSON object per line, as the CLI writes them. */
function streamOf(...events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/** The `init` event every stream opens with. */
function initEvent(): Record<string, unknown> {
  return {
    type: "init",
    timestamp: TS,
    session_id: SESSION_ID,
    model: "gemini-2.5-pro",
  };
}

/** A terminal `result` event carrying a fatal error. */
function errorResult(type: string, message: string): Record<string, unknown> {
  return {
    type: "result",
    timestamp: TS,
    status: "error",
    error: { type, message },
  };
}

/** Decode and classify one run, as the runner does. */
function classifyRun(
  stdout: string,
  exitCode: number,
  stderr = "",
  extra: Partial<AgentRunStreams> = {},
) {
  const adapter = geminiAdapter();
  const streams: AgentRunStreams = {
    stdout,
    stderr,
    exitCode,
    nowMs: NOW_MS,
    ...extra,
  };
  return adapter.classify(streams, adapter.decode(stdout));
}

Deno.test("gemini output adapter - the success fixture decodes to the final turn, session, usage and progress (Issue #5340)", () => {
  const adapter = geminiAdapter();
  assertEquals(adapter.providerId, "gemini");

  const decoded = adapter.decode(fixture("gemini-0.68.0-success.jsonl"));

  assertEquals(decoded.text, FINAL_TEXT);
  assertEquals(decoded.textSource, "final");
  assertEquals(decoded.status, "completed");
  assertEquals(decoded.sessionId, SESSION_ID);
  // input_tokens 1000 less cached 400; output 200; the cache read is 400.
  assertEquals(decoded.usage, {
    inputTokens: 600,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 400,
  });
  assert(
    !decoded.text.includes("Check logs/build.log"),
    "the echoed user prompt is never answer text",
  );
  // Assistant deltas (1), tool_use (2), tool_result (3), final deltas (4, 5).
  assertEquals(decoded.progress, { events: 5, last: "read_file" });
  assertEquals(decoded.malformedLines, 0);
  assertEquals(decoded.errors, []);
});

Deno.test("gemini output adapter - a success that quotes quota and login text is not a failure (Issue #5340)", () => {
  const decoded = geminiAdapter().decode(
    fixture("gemini-0.68.0-success.jsonl"),
  );
  assertEquals(
    geminiAdapter().classify(
      { stdout: "", stderr: "", exitCode: 0, nowMs: NOW_MS },
      decoded,
    ),
    undefined,
  );
});

Deno.test("gemini output adapter - a TerminalQuotaError with a stated reset is quota-exhausted, not a rate limit (Issue #5340)", () => {
  const stdout = fixture("gemini-0.68.0-quota-reset.jsonl");
  const failure = classifyRun(stdout, 173);

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.evidence, "structured");
  assertEquals(failure?.quota?.scope, "unknown");
  // "Your quota will reset after 2h30m15s." is 9 015 seconds from now.
  assertEquals(failure?.quota?.resetEpochMs, NOW_MS + 9_015_000);
  // Negative control: the preceding 429 retry warning is decoded, but the
  // terminal result is the verdict, so the warning supplies no status and
  // cannot make the run a transient rate limit.
  assertEquals(failure?.httpStatus, undefined);
  const decoded = geminiAdapter().decode(stdout);
  assert(
    decoded.errors.some((e) =>
      e.source === "error" && e.httpStatus === 429 &&
      e.message === "Attempt 1 failed with status 429. Retrying with backoff..."
    ),
    "the 429 warning is in the decoded errors",
  );
});

Deno.test("gemini output adapter - a TerminalQuotaError with no stated reset reports no reset (Issue #5340)", () => {
  const failure = classifyRun(
    fixture("gemini-0.68.0-quota-no-reset.jsonl"),
    173,
  );

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.evidence, "structured");
  assertEquals(failure?.quota, { scope: "unknown" });
  assertEquals(failure?.quota?.resetEpochMs, undefined);
});

Deno.test("gemini output adapter - an UnauthorizedError is authentication from structured evidence (Issue #5340)", () => {
  const failure = classifyRun(fixture("gemini-0.68.0-auth-rejected.jsonl"), 1);

  assertEquals(failure?.category, "authentication");
  assertEquals(failure?.evidence, "structured");
  assertEquals(failure?.httpStatus, undefined);
  assertEquals(failure?.terminal, true);
});

Deno.test("gemini output adapter - exit 41 with only stderr is authentication from the process (Issue #5340)", () => {
  const stderr =
    "Please set an Auth method in your /home/x/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA";
  const failure = classifyRun("", 41, stderr);

  assertEquals(failure?.category, "authentication");
  assertEquals(failure?.evidence, "process");
  assertEquals(failure?.errors, []);
});

Deno.test("gemini output adapter - a structured quota beats a prose warning that names GEMINI_API_KEY (Issue #5340)", () => {
  // Gemini's stderr names GEMINI_API_KEY in advisory warnings, which the
  // prose auth predicate reads as a credential failure. The structured quota
  // verdict on stdout must win over that.
  const stdout = fixture("gemini-0.68.0-quota-reset.jsonl");
  const stderr =
    "Warning: GEMINI_API_KEY and GOOGLE_API_KEY are both set; using GEMINI_API_KEY.\n";
  const failure = classifyRun(stdout, 1, stderr);

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.evidence, "structured");
  assertEquals(failure?.quota?.resetEpochMs, NOW_MS + 9_015_000);
});

Deno.test("gemini output adapter - a failed run's assistant text is never classified (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    {
      type: "message",
      timestamp: TS,
      role: "assistant",
      content:
        "You have exhausted your daily quota, and the log says invalid authentication credentials.",
      delta: true,
    },
    errorResult("Error", "[API Error: something broke]"),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "task-failure");
  assertEquals(
    failure?.message,
    "The Gemini CLI exited 1 — evidence: Error [API Error: something broke]",
  );
});

Deno.test("gemini output adapter - a RetryableQuotaError is a rate limit with its delay, not a quota (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult(
      "RetryableQuotaError",
      "[API Error: 429 Too Many Requests. Please retry in 30s.]",
    ),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "rate-limit");
  assertEquals(failure?.evidence, "structured");
  assertEquals(failure?.retryAfterSeconds, 30);
  assertEquals(failure?.quota, undefined);
});

Deno.test("gemini output adapter - a TerminalQuotaError that states a retry delay resets at that delay (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult(
      "TerminalQuotaError",
      "[API Error: You have exhausted your capacity on this model. Please retry in 3600s.]",
    ),
  );
  const failure = classifyRun(stdout, 173);

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.quota?.resetEpochMs, NOW_MS + 3_600_000);
});

Deno.test("gemini output adapter - a ModelNotFoundError is model-unavailable (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult(
      "ModelNotFoundError",
      "[API Error: models/gemini-9x-preview is not found.]",
    ),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "model-unavailable");
  assertEquals(failure?.evidence, "structured");
});

Deno.test("gemini output adapter - a FatalTurnLimitedError at exit 53 is turn-limit (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult("FatalTurnLimitedError", "[API Error: Maximum turns reached.]"),
  );
  const failure = classifyRun(stdout, 53);

  assertEquals(failure?.category, "turn-limit");
  assertEquals(failure?.evidence, "structured");
});

Deno.test("gemini output adapter - a terminal result carrying HTTP 503 is network, with httpStatus 503 (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult("Error", "[API Error: 503 Service Unavailable]"),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "network");
  assertEquals(failure?.httpStatus, 503);
});

Deno.test("gemini output adapter - the watchdog's timeout outranks what the stream says (Issue #5340)", () => {
  const failure = classifyRun(
    fixture("gemini-0.68.0-quota-reset.jsonl"),
    1,
    "",
    { timedOut: true },
  );

  assertEquals(failure?.category, "timeout");
  assertEquals(failure?.evidence, "process");
});

Deno.test("gemini output adapter - a stream with no result line is incomplete, with partial text (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    {
      type: "message",
      timestamp: TS,
      role: "assistant",
      content: "First I will look.",
      delta: true,
    },
    {
      type: "tool_use",
      timestamp: TS,
      tool_name: "read_file",
      tool_id: "read_file-1",
      parameters: { file_path: "a.txt" },
    },
    {
      type: "tool_result",
      timestamp: TS,
      tool_id: "read_file-1",
      status: "success",
      output: "a",
    },
    {
      type: "message",
      timestamp: TS,
      role: "assistant",
      content: "Half way there.",
      delta: true,
    },
  );
  const decoded = geminiAdapter().decode(stdout);

  assertEquals(decoded.status, "incomplete");
  assertEquals(decoded.textSource, "partial");
  assertEquals(decoded.text, "First I will look.\nHalf way there.");
});

Deno.test("gemini output adapter - empty stdout is unknown with no text (Issue #5340)", () => {
  const decoded = geminiAdapter().decode("");

  assertEquals(decoded.status, "unknown");
  assertEquals(decoded.textSource, "none");
  assertEquals(decoded.text, "");
  assertEquals(decoded.progress.events, 0);
});

Deno.test("gemini output adapter - non-JSON stdout is passed through as raw, never as an event stream (Issue #5340)", () => {
  const stdout = "The model answered in prose, without any events.\n";
  const decoded = geminiAdapter().decode(stdout);

  assertEquals(decoded.textSource, "raw");
  assertEquals(decoded.text, stdout);
  assertEquals(decoded.status, "unknown");
  assertEquals(decoded.malformedLines, 1);
});

Deno.test("gemini output adapter - a non-JSON line and an untyped object are counted as malformed (Issue #5340)", () => {
  const stdout = [
    JSON.stringify(initEvent()),
    "Loaded cached credentials.",
    JSON.stringify({ no_type_here: true }),
    JSON.stringify({ type: "result", timestamp: TS, status: "success" }),
  ].join("\n") + "\n";
  const decoded = geminiAdapter().decode(stdout);

  assertEquals(decoded.malformedLines, 2);
  assertEquals(decoded.status, "completed");
  assertEquals(decoded.sessionId, SESSION_ID);
});

Deno.test("gemini output adapter - a hostile reset phrase with a 50 000-digit run returns with no reset (Issue #5340)", () => {
  const hostile =
    `[API Error: You have exhausted your capacity on this model. Your quota will reset after ${
      "9".repeat(50_000)
    }x.]`;
  const failure = classifyRun(
    streamOf(initEvent(), errorResult("TerminalQuotaError", hostile)),
    173,
  );

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.quota?.resetEpochMs, undefined);
});

Deno.test("gemini output adapter - a hostile retry phrase with a 50 000-digit run returns with no reset (Issue #5340)", () => {
  const hostile =
    `[API Error: You have exhausted your capacity on this model. Please retry in ${
      "9".repeat(50_000)
    }x.]`;
  const failure = classifyRun(
    streamOf(initEvent(), errorResult("TerminalQuotaError", hostile)),
    173,
  );

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.quota?.resetEpochMs, undefined);
});

Deno.test("gemini output adapter - out-of-memory in stderr is out-of-memory, read before anything else (Issue #5340)", () => {
  const failure = classifyRun(
    "",
    134,
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
  );

  assertEquals(failure?.category, "out-of-memory");
  assertEquals(failure?.evidence, "prose");
});

Deno.test("gemini output adapter - a structured 401 status in the result is authentication (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult("Error", "[API Error: Request failed (Status: 401)]"),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "authentication");
  assertEquals(failure?.evidence, "structured");
  assertEquals(failure?.httpStatus, 401);
});

Deno.test("gemini output adapter - a terminal 402 Insufficient Balance is quota-exhausted (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult("Error", "[API Error: 402 Insufficient Balance]"),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.evidence, "structured");
  assertEquals(failure?.quota, { scope: "unknown" });
});

Deno.test("gemini output adapter - a quota stated only in stderr, with no stdout, is quota-exhausted from prose (Issue #5340)", () => {
  const failure = classifyRun(
    "",
    1,
    "You have exhausted your daily quota on this model.",
  );

  assertEquals(failure?.category, "quota-exhausted");
  assertEquals(failure?.evidence, "prose");
  assertEquals(failure?.quota, { scope: "unknown" });
});

Deno.test("gemini output adapter - an authentication refusal stated only in stderr is authentication from prose (Issue #5340)", () => {
  const failure = classifyRun(
    "",
    1,
    "Not logged in. Please log in to continue.",
  );

  assertEquals(failure?.category, "authentication");
  assertEquals(failure?.evidence, "prose");
});

Deno.test("gemini output adapter - a model refusal stated only in stderr is model-unavailable from prose (Issue #5340)", () => {
  const failure = classifyRun("", 1, "The model gemini-9x is not found.");

  assertEquals(failure?.category, "model-unavailable");
  assertEquals(failure?.evidence, "prose");
});

Deno.test("gemini output adapter - a dropped connection stated only in stderr is network from prose (Issue #5340)", () => {
  const failure = classifyRun("", 1, "request failed: ECONNRESET");

  assertEquals(failure?.category, "network");
  assertEquals(failure?.evidence, "prose");
});

Deno.test("gemini output adapter - a rate limit in stderr takes its delay from the retry-after fallback (Issue #5340)", () => {
  const failure = classifyRun("", 1, "Too Many Requests, retry-after: 20");

  assertEquals(failure?.category, "rate-limit");
  assertEquals(failure?.evidence, "prose");
  assertEquals(failure?.retryAfterSeconds, 20);
});

Deno.test("gemini output adapter - an unexplained exit with empty streams is task-failure from the process (Issue #5340)", () => {
  const failure = classifyRun("", 2);

  assertEquals(failure?.category, "task-failure");
  assertEquals(failure?.evidence, "process");
  assertEquals(failure?.message, "The Gemini CLI exited 2");
});

Deno.test("gemini output adapter - a retry delay in milliseconds is read as a fraction of a second (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult(
      "RetryableQuotaError",
      "[API Error: 429 Too Many Requests. Please retry in 500ms.]",
    ),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "rate-limit");
  assertEquals(failure?.retryAfterSeconds, 0.5);
});

Deno.test("gemini output adapter - a result whose status is neither success nor error stays incomplete (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    { type: "result", timestamp: TS, status: "interrupted" },
  );
  const decoded = geminiAdapter().decode(stdout);

  assertEquals(decoded.status, "incomplete");
  assertEquals(decoded.errors, []);
});

Deno.test("gemini output adapter - exit 53 alone, with empty stdout, is turn-limit from the process (Issue #5340)", () => {
  const failure = classifyRun("", 53);

  assertEquals(failure?.category, "turn-limit");
  assertEquals(failure?.evidence, "process");
});

Deno.test("gemini output adapter - a RetryableQuotaError quoting an exceeded quota is rate-limit with its 39s delay, never quota (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult(
      "RetryableQuotaError",
      "[API Error: You exceeded your current quota. Please retry in 39s.]",
    ),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "rate-limit");
  assertEquals(failure?.retryAfterSeconds, 39);
  assertEquals(failure?.quota, undefined);
});

Deno.test("gemini output adapter - a quota warning before an unrelated terminal error is task-failure (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    {
      type: "error",
      timestamp: TS,
      severity: "warning",
      message: "You have exhausted your daily quota on this model.",
    },
    errorResult("Error", "[API Error: something broke]"),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "task-failure");
  assertEquals(failure?.evidence, "structured");
});

Deno.test("gemini output adapter - a terminal 503 with a GEMINI_API_KEY warning on stderr is network (Issue #5340)", () => {
  const stdout = streamOf(
    initEvent(),
    errorResult("Error", "[API Error: Service Unavailable (Status: 503)]"),
  );
  const failure = classifyRun(
    stdout,
    1,
    "Warning: GEMINI_API_KEY is set; using it for this run.",
  );

  assertEquals(failure?.category, "network");
  assertEquals(failure?.httpStatus, 503);
});

Deno.test("gemini output adapter - a retry delay of 400 digits gives no finite delay on the rate-limit path (Issue #5340)", () => {
  const hostile = `[API Error: 429 Too Many Requests. Please retry in ${
    "9".repeat(400)
  }s.]`;
  const stdout = streamOf(
    initEvent(),
    errorResult("RetryableQuotaError", hostile),
  );
  const failure = classifyRun(stdout, 1);

  assertEquals(failure?.category, "rate-limit");
  assertEquals(failure?.retryAfterSeconds, undefined);
});

Deno.test("gemini output adapter - a model phrase followed by 50 000 spaces returns task-failure (Issue #5340)", () => {
  const failure = classifyRun("", 1, `model${" ".repeat(50_000)}x`);

  assertEquals(failure?.category, "task-failure");
});

/**
 * Run the real runner against a stub that replays one derived fixture.
 *
 * The fake clock does not advance during a stub run that exits at once, so
 * `observedAt` (read before the run) is the instant the runner records.
 */
async function replayGeminiRun(fixtureName: string, exitCode: number) {
  const raw = fixture(fixtureName);
  // The stub replays the recorded stream on stdout and exits like the CLI.
  const body =
    `cat <<'AGENT_FIXTURE_EOF'\n${raw}AGENT_FIXTURE_EOF\nexit ${exitCode}\n`;
  const clock = fakeClock();
  const observedAt = clock.now();
  const result = await withAgentStub(
    body,
    (stub) =>
      runClaudeWithRetry(
        {
          clock,
          prompt: "test",
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          agentProvider: "gemini",
          agentBinaryPath: stub.path,
          env: envFrom({ [IMAGE_AGENT_PROVIDERS_ENV]: "claude,gemini" }),
          enableProviderFallback: false,
        },
        { maxRetries: 0, maxWaitSeconds: 1, initialWaitInterval: 1 },
      ),
    { prefix: "gemini_output_adapter_5340_" },
  );
  return { result, observedAt };
}

Deno.test({
  name:
    "runClaudeWithRetry - a replayed Gemini quota reset is recorded as an outage that reopens at the stated reset (Issue #5340)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAutomaticProviderState();
    setAutomaticProviderRoutingActive(true);
    const workDir = await Deno.makeTempDir({ prefix: "gemini_5340_status_" });
    try {
      const { result, observedAt } = await replayGeminiRun(
        "gemini-0.68.0-quota-reset.jsonl",
        173,
      );

      assert(result.ok, "the runner returned an error");
      if (!result.ok) return;
      assertEquals(result.value.agentOutput?.sessionId, SESSION_ID);
      assertEquals(
        result.value.agentFailure?.category,
        "quota-exhausted",
      );
      const outage = automaticProviderOutage("gemini", observedAt);
      assertEquals(outage?.category, "quota-exhausted");
      assertEquals(outage?.retryAt, observedAt + 9_015_000);

      const status = await resolveAutomaticProviderStatus("gemini", {
        workDir,
        env: envFrom(),
        now: observedAt,
      });
      assertEquals(status.availability, "exhausted");
    } finally {
      installProviderOutageAlerter(undefined);
      resetAutomaticProviderState();
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a replayed Gemini quota with no stated reset waits the five-minute recheck (Issue #5340)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAutomaticProviderState();
    setAutomaticProviderRoutingActive(true);
    const workDir = await Deno.makeTempDir({ prefix: "gemini_5340_status_" });
    try {
      const { result, observedAt } = await replayGeminiRun(
        "gemini-0.68.0-quota-no-reset.jsonl",
        173,
      );

      assert(result.ok, "the runner returned an error");
      if (!result.ok) return;
      assertEquals(
        result.value.agentFailure?.category,
        "quota-exhausted",
      );
      const outage = automaticProviderOutage("gemini", observedAt);
      assertEquals(outage?.category, "quota-exhausted");
      assertEquals(outage?.retryAt, observedAt + 300_000);

      const status = await resolveAutomaticProviderStatus("gemini", {
        workDir,
        env: envFrom(),
        now: observedAt,
      });
      assertEquals(status.availability, "exhausted");
    } finally {
      installProviderOutageAlerter(undefined);
      resetAutomaticProviderState();
      await Deno.remove(workDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a replayed Gemini rejected credential is an authentication outage and one alert (Issue #5340)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    resetAutomaticProviderState();
    setAutomaticProviderRoutingActive(true);
    const calls: { provider: string; outcome: ProviderRunOutcome }[] = [];
    installProviderOutageAlerter({
      observe: async (provider, outcome) => {
        calls.push({ provider, outcome });
      },
    });
    const workDir = await Deno.makeTempDir({ prefix: "gemini_5340_status_" });
    try {
      const { result, observedAt } = await replayGeminiRun(
        "gemini-0.68.0-auth-rejected.jsonl",
        1,
      );

      assert(result.ok, "the runner returned an error");
      if (!result.ok) return;
      assertEquals(result.value.agentOutput?.sessionId, SESSION_ID);
      assertEquals(result.value.agentFailure?.category, "authentication");

      const status = await resolveAutomaticProviderStatus("gemini", {
        workDir,
        env: envFrom(),
        now: observedAt,
      });
      assertEquals(status.availability, "unavailable");
      assertEquals(status.reason, "observed-authentication-failure");

      assertEquals(calls.length, 1, "exactly one alert call");
      assertEquals(calls[0]?.provider, "gemini");
      const outcome = calls[0]?.outcome;
      assert(outcome !== undefined && !outcome.succeeded);
      assertEquals(outcome.failure?.category, "authentication");
      assert(isProviderOutageAlertable(outcome.failure));
    } finally {
      installProviderOutageAlerter(undefined);
      resetAutomaticProviderState();
      await Deno.remove(workDir, { recursive: true });
    }
  },
});
