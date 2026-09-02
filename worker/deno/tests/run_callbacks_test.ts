/**
 * Unit tests for the post-run callback runner (Issue #806, parent #796).
 *
 * Ordering, the success/failure split, hook failure, timeout, spawn failure
 * and concurrent isolation are all exercised through the injected subprocess
 * seam, so no test depends on a real process. The end-to-end proof against
 * real executables lives in `run_callbacks_integration_test.ts`.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildCallbackContextDocument,
  buildCallbackEnv,
  CALLBACK_SCHEMA_VERSION,
  type CallbackInvocation,
  INHERITED_ENV_VARS,
  invokeRunCallbacks,
  type IssueRunCallbackContext,
  MAX_CAPTURED_OUTPUT_CHARS,
} from "../lib/run_callbacks.ts";
import type { CallbacksConfig } from "../lib/run_callbacks_config.ts";
import type { runWithTimeout } from "../lib/subprocess_timeout.ts";
import type { Result } from "../types.ts";

type Runner = typeof runWithTimeout;

/** A run that spawned and exited with `code`. */
function exits(code: number, stdout = "", stderr = ""): Awaited<
  ReturnType<Runner>
> {
  return {
    ok: true,
    value: { success: code === 0, code, stdout, stderr, timedOut: false },
  };
}

/** A run that exceeded its timeout. */
function timesOut(): Awaited<ReturnType<Runner>> {
  return {
    ok: true,
    value: {
      success: false,
      code: 124,
      stdout: "",
      stderr: "Timed out after 1000ms",
      timedOut: true,
    },
  };
}

interface Spawned {
  executable: string;
  args: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  clearEnv?: boolean;
}

/** Records every spawn and replies from a per-path script. */
function recordingRunner(
  reply: (executable: string) => Awaited<ReturnType<Runner>>,
): { runner: Runner; spawns: Spawned[] } {
  const spawns: Spawned[] = [];
  const runner: Runner = (executable, args, options) => {
    spawns.push({
      executable,
      args,
      ...(options?.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.clearEnv !== undefined
        ? { clearEnv: options.clearEnv }
        : {}),
    });
    return Promise.resolve(reply(executable));
  };
  return { runner, spawns };
}

function context(
  overrides: Partial<IssueRunCallbackContext> = {},
): IssueRunCallbackContext {
  return {
    runId: "vibe-abc-123456",
    result: "success",
    repository: "stSoftwareAU/VibeCoder",
    issueNumber: 806,
    host: "worker-1",
    startedAt: "2026-09-02T01:00:00.000Z",
    finishedAt: "2026-09-02T01:05:00.000Z",
    durationSeconds: 300,
    exitCode: 0,
    ...overrides,
  };
}

const HOOKS: CallbacksConfig = {
  success: "/hooks/success.sh",
  failure: "/hooks/failure.sh",
  always: "/hooks/always.sh",
  timeoutSeconds: 30,
};

interface Harness {
  invocations: CallbackInvocation[];
  spawns: Spawned[];
  logs: string[];
  errors: string[];
}

async function invoke(
  options: {
    callbacks?: CallbacksConfig;
    context?: IssueRunCallbackContext;
    reply?: (executable: string) => Awaited<ReturnType<Runner>>;
  } = {},
): Promise<Harness> {
  const { runner, spawns } = recordingRunner(
    options.reply ?? (() => exits(0)),
  );
  const logs: string[] = [];
  const errors: string[] = [];
  const invocations = await invokeRunCallbacks({
    callbacks: options.callbacks ?? HOOKS,
    context: options.context ?? context(),
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
    run: runner,
    readEnv: (name) => (name === "PATH" ? "/usr/bin" : undefined),
    now: (() => {
      let t = 1000;
      return () => (t += 500);
    })(),
    writeContextFile: (document) =>
      Promise.resolve({
        path: `/tmp/ctx-${document.event}.json`,
        cleanup: () => Promise.resolve(),
      }),
  });
  return { invocations, spawns, logs, errors };
}

// --- Ordering and the outcome split ----------------------------------------

Deno.test("run_callbacks - a successful run runs success then always", async () => {
  const { invocations } = await invoke();
  assertEquals(invocations.map((i) => i.event), ["success", "always"]);
  assertEquals(invocations.map((i) => i.path), [
    "/hooks/success.sh",
    "/hooks/always.sh",
  ]);
});

Deno.test("run_callbacks - a failed run runs failure then always", async () => {
  const { invocations } = await invoke({
    context: context({ result: "failure", exitCode: 1 }),
  });
  assertEquals(invocations.map((i) => i.event), ["failure", "always"]);
  assertEquals(invocations.map((i) => i.path), [
    "/hooks/failure.sh",
    "/hooks/always.sh",
  ]);
});

Deno.test("run_callbacks - the failure hook never runs after a success", async () => {
  const { spawns } = await invoke();
  assert(!spawns.some((s) => s.executable === "/hooks/failure.sh"));
});

Deno.test("run_callbacks - the success hook never runs after a failure", async () => {
  const { spawns } = await invoke({
    context: context({ result: "failure", exitCode: 1 }),
  });
  assert(!spawns.some((s) => s.executable === "/hooks/success.sh"));
});

// --- Missing hooks are no-ops ----------------------------------------------

Deno.test("run_callbacks - no configured hooks spawns nothing", async () => {
  const { invocations, spawns } = await invoke({
    callbacks: { timeoutSeconds: 30 },
  });
  assertEquals(invocations, []);
  assertEquals(spawns, []);
});

Deno.test("run_callbacks - a missing outcome hook still runs always", async () => {
  const { invocations } = await invoke({
    callbacks: { always: "/hooks/always.sh", timeoutSeconds: 30 },
  });
  assertEquals(invocations.map((i) => i.event), ["always"]);
});

Deno.test("run_callbacks - a missing always hook leaves the outcome hook alone", async () => {
  const { invocations } = await invoke({
    callbacks: { success: "/hooks/success.sh", timeoutSeconds: 30 },
  });
  assertEquals(invocations.map((i) => i.event), ["success"]);
});

// --- Hook failure, timeout and spawn failure -------------------------------

Deno.test("run_callbacks - always still runs when the outcome hook exits non-zero", async () => {
  const { invocations, errors } = await invoke({
    reply: (exe) =>
      exe === "/hooks/success.sh" ? exits(3, "", "boom") : exits(0),
  });
  assertEquals(invocations.map((i) => i.event), ["success", "always"]);
  assertEquals(invocations[0]?.status, "failed");
  assertEquals(invocations[0]?.exitCode, 3);
  assertEquals(invocations[1]?.status, "ok");
  assert(errors.some((e) => e.includes("boom")), errors.join("\n"));
});

Deno.test("run_callbacks - always still runs when the outcome hook times out", async () => {
  const { invocations } = await invoke({
    reply: (exe) => (exe === "/hooks/success.sh" ? timesOut() : exits(0)),
  });
  assertEquals(invocations.map((i) => i.status), ["timed_out", "ok"]);
  assertEquals(invocations[0]?.exitCode, 124);
});

Deno.test("run_callbacks - always still runs when the outcome hook cannot be spawned", async () => {
  const { invocations } = await invoke({
    reply: (exe) =>
      exe === "/hooks/success.sh"
        ? ({
          ok: false,
          error: new Error("No such file or directory (os error 2)"),
        } as Result<never>)
        : exits(0),
  });
  assertEquals(invocations.map((i) => i.status), ["spawn_failed", "ok"]);
  assertEquals(invocations[0]?.exitCode, -1);
  assert(invocations[0]?.stderr.includes("No such file"));
});

Deno.test("run_callbacks - a failing always hook is reported, not thrown", async () => {
  const { invocations, errors } = await invoke({
    reply: (exe) => (exe === "/hooks/always.sh" ? exits(9) : exits(0)),
  });
  assertEquals(invocations[1]?.status, "failed");
  assert(errors.some((e) => e.includes("unchanged")), errors.join("\n"));
});

Deno.test("run_callbacks - a context-file fault is reported as a spawn failure", async () => {
  const invocations = await invokeRunCallbacks({
    callbacks: { success: "/hooks/success.sh", timeoutSeconds: 30 },
    context: context(),
    log: () => {},
    logError: () => {},
    run: () => Promise.resolve(exits(0)),
    writeContextFile: () => Promise.reject(new Error("read-only file system")),
  });
  assertEquals(invocations[0]?.status, "spawn_failed");
  assert(invocations[0]?.stderr.includes("read-only file system"));
});

// --- Invocation shape: no shell, bounded, isolated environment -------------

Deno.test("run_callbacks - the executable is spawned directly with no arguments", async () => {
  const { spawns } = await invoke();
  for (const spawn of spawns) {
    assertEquals(spawn.args, []);
    assert(!spawn.executable.includes("sh -c"));
  }
});

Deno.test("run_callbacks - every hook is bounded by the configured timeout", async () => {
  const { spawns } = await invoke({
    callbacks: { ...HOOKS, timeoutSeconds: 7 },
  });
  assertEquals(spawns.map((s) => s.timeoutMs), [7000, 7000]);
});

Deno.test("run_callbacks - the child environment is cleared before it is populated", async () => {
  const { spawns } = await invoke();
  for (const spawn of spawns) assertEquals(spawn.clearEnv, true);
});

Deno.test("run_callbacks - captured output is redacted and bounded", async () => {
  const { invocations } = await invoke({
    reply: () => exits(0, "x".repeat(MAX_CAPTURED_OUTPUT_CHARS + 500), ""),
  });
  assert(
    invocations[0]!.stdout.length <= MAX_CAPTURED_OUTPUT_CHARS + 20,
    `stdout was ${invocations[0]!.stdout.length} chars`,
  );
  assert(invocations[0]!.stdout.endsWith("[truncated]"));
});

// Synthetic PAT-shaped fixture, assembled at runtime so no high-entropy
// token literal ever exists in the source for a secret scanner to flag.
const FAKE_PAT = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz";

Deno.test("run_callbacks - a secret in hook output is redacted before logging", async () => {
  const { invocations, errors } = await invoke({
    reply: () => exits(1, "", `token ${FAKE_PAT}`),
  });
  assert(
    !invocations[0]!.stderr.includes(FAKE_PAT),
    invocations[0]!.stderr,
  );
  assert(!errors.join("\n").includes(FAKE_PAT.slice(0, 30)));
});

// --- Context document ------------------------------------------------------

Deno.test("run_callbacks - the context document is versioned and stamped per event", () => {
  const document = buildCallbackContextDocument(context(), "always");
  assertEquals(document.schemaVersion, CALLBACK_SCHEMA_VERSION);
  assertEquals(document.event, "always");
  assertEquals(document.result, "success");
  assertEquals(document.repository, "stSoftwareAU/VibeCoder");
  assertEquals(document.issueNumber, 806);
  assertEquals(document.runId, "vibe-abc-123456");
  assertEquals(document.host, "worker-1");
  assertEquals(document.durationSeconds, 300);
  assertEquals(document.exitCode, 0);
});

Deno.test("run_callbacks - absent optional facts are omitted, not emitted empty", () => {
  const document = buildCallbackContextDocument(context(), "success");
  assert(!("provider" in document));
  assert(!("sessionId" in document));
  assert(!("sessionLogPath" in document));
  assert(!("telemetry" in document));
});

Deno.test("run_callbacks - provider, session, transcript and telemetry are carried when known", () => {
  const document = buildCallbackContextDocument(
    context({
      provider: "claude",
      sessionId: "sess-42",
      sessionLogPath: "/home/vibe/logs/agent-806.log",
      workerName: "fleet-a",
      telemetry: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.25 },
    }),
    "success",
  );
  assertEquals(document.provider, "claude");
  assertEquals(document.sessionId, "sess-42");
  assertEquals(document.sessionLogPath, "/home/vibe/logs/agent-806.log");
  assertEquals(document.workerName, "fleet-a");
  assertEquals(document.telemetry, {
    inputTokens: 10,
    outputTokens: 5,
    estimatedCostUsd: 0.25,
  });
});

// --- Environment contract --------------------------------------------------

Deno.test("run_callbacks - the environment carries the documented scalars", () => {
  const env = buildCallbackEnv(
    context({
      provider: "codex",
      sessionId: "sess-7",
      sessionLogPath: "/logs/a.log",
      workerName: "fleet-b",
      telemetry: {
        inputTokens: 11,
        outputTokens: 22,
        cacheCreationTokens: 33,
        cacheReadTokens: 44,
        estimatedCostUsd: 1.5,
      },
    }),
    "failure",
    "/tmp/ctx.json",
    () => undefined,
  );
  assertEquals(env.VIBECODER_CALLBACK_SCHEMA_VERSION, "1");
  assertEquals(env.VIBECODER_CALLBACK_EVENT, "failure");
  assertEquals(env.VIBECODER_CALLBACK_CONTEXT, "/tmp/ctx.json");
  assertEquals(env.VIBECODER_RUN_ID, "vibe-abc-123456");
  assertEquals(env.VIBECODER_RESULT, "success");
  assertEquals(env.VIBECODER_REPOSITORY, "stSoftwareAU/VibeCoder");
  assertEquals(env.VIBECODER_ISSUE_NUMBER, "806");
  assertEquals(env.VIBECODER_HOST, "worker-1");
  assertEquals(env.VIBECODER_WORKER_NAME, "fleet-b");
  assertEquals(env.VIBECODER_PROVIDER, "codex");
  assertEquals(env.VIBECODER_SESSION_ID, "sess-7");
  assertEquals(env.VIBECODER_SESSION_LOG_PATH, "/logs/a.log");
  assertEquals(env.VIBECODER_STARTED_AT, "2026-09-02T01:00:00.000Z");
  assertEquals(env.VIBECODER_FINISHED_AT, "2026-09-02T01:05:00.000Z");
  assertEquals(env.VIBECODER_DURATION_SECONDS, "300");
  assertEquals(env.VIBECODER_EXIT_CODE, "0");
  assertEquals(env.VIBECODER_INPUT_TOKENS, "11");
  assertEquals(env.VIBECODER_OUTPUT_TOKENS, "22");
  assertEquals(env.VIBECODER_CACHE_CREATION_TOKENS, "33");
  assertEquals(env.VIBECODER_CACHE_READ_TOKENS, "44");
  assertEquals(env.VIBECODER_ESTIMATED_COST_USD, "1.5");
});

Deno.test("run_callbacks - unknown facts export no variable at all", () => {
  const env = buildCallbackEnv(
    context(),
    "success",
    "/tmp/c.json",
    () => undefined,
  );
  assert(!("VIBECODER_PROVIDER" in env));
  assert(!("VIBECODER_SESSION_ID" in env));
  assert(!("VIBECODER_SESSION_LOG_PATH" in env));
  assert(!("VIBECODER_INPUT_TOKENS" in env));
});

Deno.test("run_callbacks - only the inherited allowlist crosses from the worker", () => {
  const worker: Record<string, string> = {
    PATH: "/usr/bin",
    HOME: "/home/vibe",
    GH_TOKEN: "ghp_secret_value_that_must_not_leak",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
  };
  const env = buildCallbackEnv(
    context(),
    "success",
    "/tmp/c.json",
    (name) => worker[name],
  );
  for (const name of Object.keys(env)) {
    assert(
      name.startsWith("VIBECODER_") || INHERITED_ENV_VARS.includes(name),
      `${name} must not be exported to a callback`,
    );
  }
  assert(!("GH_TOKEN" in env));
  assert(!("ANTHROPIC_API_KEY" in env));
  assert(!("AWS_SECRET_ACCESS_KEY" in env));
});

Deno.test("run_callbacks - transcript contents are never exported, only its path", () => {
  const env = buildCallbackEnv(
    context({ sessionLogPath: "/logs/a.log" }),
    "always",
    "/tmp/c.json",
    () => undefined,
  );
  assertEquals(env.VIBECODER_SESSION_LOG_PATH, "/logs/a.log");
  for (const value of Object.values(env)) {
    assert(value.length < 512, "no environment value carries bulk content");
  }
});

// --- Concurrency -----------------------------------------------------------

Deno.test("run_callbacks - concurrent runs receive isolated contexts", async () => {
  const seen: Record<string, string[]> = {};
  const runner: Runner = (executable, _args, options) => {
    const issue = options?.env?.VIBECODER_ISSUE_NUMBER ?? "?";
    (seen[executable] ??= []).push(issue);
    return Promise.resolve(exits(0));
  };
  const dispatch = (issueNumber: number, result: "success" | "failure") =>
    invokeRunCallbacks({
      callbacks: HOOKS,
      context: context({
        issueNumber,
        result,
        exitCode: result === "success" ? 0 : 1,
      }),
      log: () => {},
      logError: () => {},
      run: runner,
      readEnv: () => undefined,
      writeContextFile: (document) =>
        Promise.resolve({
          path: `/tmp/ctx-${document.issueNumber}-${document.event}.json`,
          cleanup: () => Promise.resolve(),
        }),
    });

  const [first, second] = await Promise.all([
    dispatch(101, "success"),
    dispatch(202, "failure"),
  ]);

  assertEquals(first.map((i) => `${i.event}`), ["success", "always"]);
  assertEquals(second.map((i) => `${i.event}`), ["failure", "always"]);
  assertEquals(seen["/hooks/success.sh"], ["101"]);
  assertEquals(seen["/hooks/failure.sh"], ["202"]);
  assertEquals(new Set(seen["/hooks/always.sh"]), new Set(["101", "202"]));
});
