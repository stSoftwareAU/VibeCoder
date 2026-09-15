/**
 * Unit tests for the host-side `callbacks.host_failure` hook (Issue #2107,
 * parent #2088).
 *
 * The targeted read, the document and environment shape, and the four
 * invocation outcomes are all exercised through injected seams, so no test
 * depends on a real process or a real host configuration.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildHostFailureDocument,
  buildHostFailureEnv,
  type HostFailureHookConfig,
  type HostFailurePayload,
  invokeHostFailureHook,
  readHostFailureHook,
} from "../lib/host_failure_hook.ts";
import {
  CALLBACK_SCHEMA_VERSION,
  INHERITED_ENV_VARS,
} from "../lib/run_callbacks.ts";
import type { runWithTimeout } from "../lib/subprocess_timeout.ts";

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

interface Spawned {
  executable: string;
  args: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  clearEnv?: boolean;
}

/** Records every spawn and replies with a fixed result. */
function recordingRunner(
  reply: Awaited<ReturnType<Runner>>,
): { runner: Runner; spawns: Spawned[] } {
  const spawns: Spawned[] = [];
  const runner: Runner = (executable, args, options) => {
    spawns.push({
      executable,
      args,
      timeoutMs: options?.timeoutMs,
      env: options?.env,
      clearEnv: options?.clearEnv,
    });
    return Promise.resolve(reply);
  };
  return { runner, spawns };
}

/** Seams that write the context file to a temp path and log into arrays. */
function seams(runner: Runner) {
  const logs: string[] = [];
  const errors: string[] = [];
  const written: Record<string, unknown>[] = [];
  return {
    logs,
    errors,
    written,
    options: {
      log: (message: string) => logs.push(message),
      logError: (message: string) => errors.push(message),
      run: runner,
      readEnv: (name: string) => (name === "PATH" ? "/usr/bin" : undefined),
      now: () => 0,
      writeContextFile: (document: Record<string, unknown>) => {
        written.push(document);
        return Promise.resolve({
          path: "/tmp/host-failure-context.json",
          cleanup: () => Promise.resolve(),
        });
      },
    },
  };
}

function payload(
  overrides: Partial<HostFailurePayload> = {},
): HostFailurePayload {
  return {
    host: "worker-1",
    condition: "launcher",
    phase: "container_start",
    consecutiveFailures: 3,
    streakStartedAt: "2026-09-15T01:00:00.000Z",
    delivery: { kind: "first", count: 1 },
    attempt: 3,
    ...overrides,
  };
}

/** Read a `.config.json` written into a temp directory, then remove it. */
async function readConfig(
  contents: string,
): Promise<HostFailureHookConfig> {
  const dir = await Deno.makeTempDir({ prefix: "vibecoder-host-failure-" });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(path, contents);
    return await readHostFailureHook(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("host_failure_hook - a missing config file configures no hook", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibecoder-host-failure-" });
  try {
    const hook = await readHostFailureHook(`${dir}/.config.json`);
    assertEquals(hook, { kind: "none" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("host_failure_hook - a config with no callbacks block configures no hook", async () => {
  const hook = await readConfig(JSON.stringify({ repos: ["owner/repo"] }));
  assertEquals(hook, { kind: "none" });
});

Deno.test("host_failure_hook - a callbacks block without host_failure configures no hook", async () => {
  const hook = await readConfig(
    JSON.stringify({ callbacks: { success: "/opt/hooks/s.sh" } }),
  );
  assertEquals(hook, { kind: "none" });
});

Deno.test("host_failure_hook - a valid host_failure path is returned with its timeout", async () => {
  const hook = await readConfig(
    JSON.stringify({
      callbacks: {
        success: "/opt/hooks/s.sh",
        host_failure: "  /opt/hooks/host-failure.sh  ",
        timeout_seconds: 120,
      },
    }),
  );
  assertEquals(hook, {
    kind: "hook",
    path: "/opt/hooks/host-failure.sh",
    timeoutSeconds: 120,
  });
});

Deno.test("host_failure_hook - the read ignores container-only keys it does not use", async () => {
  // `success` is invalid, but the host never spawns it; failing the host read
  // on it would silence the host hook over a fault that is not its own.
  const hook = await readConfig(
    JSON.stringify({
      callbacks: { success: 42, host_failure: "/opt/hooks/host-failure.sh" },
    }),
  );
  assertEquals(hook, {
    kind: "hook",
    path: "/opt/hooks/host-failure.sh",
    timeoutSeconds: 60,
  });
});

Deno.test("host_failure_hook - invalid JSON is reported, not treated as absent", async () => {
  const hook = await readConfig("{ not json");
  assertEquals(hook.kind, "invalid");
  assert(hook.kind === "invalid" && hook.error.includes("not valid JSON"));
});

Deno.test("host_failure_hook - a non-object config file is reported", async () => {
  const hook = await readConfig(JSON.stringify(["callbacks"]));
  assertEquals(hook.kind, "invalid");
  assert(hook.kind === "invalid" && hook.error.includes("JSON object"));
});

Deno.test("host_failure_hook - an array callbacks block is reported", async () => {
  const hook = await readConfig(JSON.stringify({ callbacks: ["/opt/h.sh"] }));
  assertEquals(hook.kind, "invalid");
  assert(
    hook.kind === "invalid" &&
      hook.error.includes("callbacks must be an object"),
    hook.kind === "invalid" ? hook.error : "",
  );
});

Deno.test("host_failure_hook - a relative host_failure path is reported", async () => {
  const hook = await readConfig(
    JSON.stringify({ callbacks: { host_failure: "hooks/host-failure.sh" } }),
  );
  assertEquals(hook.kind, "invalid");
  assert(hook.kind === "invalid" && hook.error.includes("absolute"));
  assert(
    hook.kind === "invalid" && hook.error.includes("callbacks.host_failure"),
  );
});

Deno.test("host_failure_hook - a timeout_seconds out of range is reported", async () => {
  const hook = await readConfig(
    JSON.stringify({
      callbacks: { host_failure: "/opt/hooks/h.sh", timeout_seconds: 99999 },
    }),
  );
  assertEquals(hook.kind, "invalid");
  assert(hook.kind === "invalid" && hook.error.includes("timeout_seconds"));
});

Deno.test("host_failure_hook - an unreadable config file is reported, never thrown", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibecoder-host-failure-" });
  try {
    // A directory where a file is expected: readable path, unreadable content.
    const hook = await readHostFailureHook(dir);
    assertEquals(hook.kind, "invalid");
    assert(hook.kind === "invalid" && hook.error.includes("could not be read"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("host_failure_hook - the document carries every supplied fact", () => {
  const document = buildHostFailureDocument(payload({
    condition: "checkout_update",
    lastExitStatus: 128,
    backoffSeconds: 300,
    delivery: { kind: "repeat", count: 4 },
    logTail: "fatal: unable to access\nremote hung up",
    detail: "origin unreachable",
    checkout: { branch: "main", dirtyFiles: 2 },
  }));
  assertEquals(document.schemaVersion, CALLBACK_SCHEMA_VERSION);
  assertEquals(document.event, "host_failure");
  assertEquals(document.host, "worker-1");
  assertEquals(document.condition, "checkout_update");
  assertEquals(document.phase, "container_start");
  assertEquals(document.consecutiveFailures, 3);
  assertEquals(document.lastExitStatus, 128);
  assertEquals(document.backoffSeconds, 300);
  assertEquals(document.streakStartedAt, "2026-09-15T01:00:00.000Z");
  assertEquals(document.delivery, { kind: "repeat", count: 4 });
  assertEquals(document.attempt, 3);
  assertEquals(document.logTail, "fatal: unable to access\nremote hung up");
  assertEquals(document.detail, "origin unreachable");
  assertEquals(document.checkout, { branch: "main", dirtyFiles: 2 });
});

Deno.test("host_failure_hook - absent optionals are omitted from the document", () => {
  const document = buildHostFailureDocument(payload());
  for (
    const field of [
      "lastExitStatus",
      "backoffSeconds",
      "logTail",
      "detail",
      "checkout",
    ]
  ) {
    assert(!(field in document), `${field} should be omitted`);
  }
});

Deno.test("host_failure_hook - the environment exports the scalar facts", () => {
  const env = buildHostFailureEnv(
    payload({ lastExitStatus: 1, backoffSeconds: 60 }),
    "/tmp/ctx.json",
    (name) => (name === "PATH" ? "/usr/bin" : undefined),
  );
  assertEquals(
    env.VIBECODER_CALLBACK_SCHEMA_VERSION,
    String(CALLBACK_SCHEMA_VERSION),
  );
  assertEquals(env.VIBECODER_CALLBACK_EVENT, "host_failure");
  assertEquals(env.VIBECODER_CALLBACK_CONTEXT, "/tmp/ctx.json");
  assertEquals(env.VIBECODER_HOST, "worker-1");
  assertEquals(env.VIBECODER_HOST_FAILURE_CONDITION, "launcher");
  assertEquals(env.VIBECODER_HOST_FAILURE_PHASE, "container_start");
  assertEquals(env.VIBECODER_CONSECUTIVE_FAILURES, "3");
  assertEquals(env.VIBECODER_LAST_EXIT_STATUS, "1");
  assertEquals(env.VIBECODER_BACKOFF_SECONDS, "60");
  assertEquals(env.VIBECODER_STREAK_STARTED_AT, "2026-09-15T01:00:00.000Z");
  assertEquals(env.VIBECODER_DELIVERY_KIND, "first");
  assertEquals(env.VIBECODER_DELIVERY_COUNT, "1");
  assertEquals(env.VIBECODER_ATTEMPT, "3");
  assertEquals(env.PATH, "/usr/bin");
});

Deno.test("host_failure_hook - absent optionals are omitted from the environment", () => {
  const env = buildHostFailureEnv(payload(), "/tmp/ctx.json", () => undefined);
  assert(!("VIBECODER_LAST_EXIT_STATUS" in env));
  assert(!("VIBECODER_BACKOFF_SECONDS" in env));
});

Deno.test("host_failure_hook - multi-line facts stay out of the environment", () => {
  const env = buildHostFailureEnv(
    payload({ logTail: "line one\nline two", detail: "origin unreachable" }),
    "/tmp/ctx.json",
    () => undefined,
  );
  for (const value of Object.values(env)) {
    assert(!value.includes("\n"), `environment value is multi-line: ${value}`);
  }
  assert(!("VIBECODER_LOG_TAIL" in env));
  assert(!("VIBECODER_DETAIL" in env));
});

Deno.test("host_failure_hook - a successful hook is recorded ok", async () => {
  const { runner, spawns } = recordingRunner(exits(0, "sent", ""));
  const harness = seams(runner);
  const invocation = await invokeHostFailureHook(
    payload(),
    { path: "/opt/hooks/host-failure.sh", timeoutSeconds: 30 },
    harness.options,
  );
  assertEquals(invocation.event, "host_failure");
  assertEquals(invocation.path, "/opt/hooks/host-failure.sh");
  assertEquals(invocation.status, "ok");
  assertEquals(invocation.exitCode, 0);
  assertEquals(invocation.stdout, "sent");
  assertEquals(spawns.length, 1);
  assertEquals(spawns[0]!.executable, "/opt/hooks/host-failure.sh");
  assertEquals(spawns[0]!.args, []);
  assertEquals(spawns[0]!.timeoutMs, 30_000);
  assertEquals(spawns[0]!.clearEnv, true);
  assertEquals(
    spawns[0]!.env?.VIBECODER_CALLBACK_CONTEXT,
    "/tmp/host-failure-context.json",
  );
  assertEquals(harness.written.length, 1);
  assertEquals(harness.written[0]!.event, "host_failure");
});

Deno.test("host_failure_hook - a non-zero hook is recorded failed", async () => {
  const { runner } = recordingRunner(exits(2, "", "no channel configured"));
  const invocation = await invokeHostFailureHook(
    payload(),
    { path: "/opt/hooks/host-failure.sh", timeoutSeconds: 30 },
    seams(runner).options,
  );
  assertEquals(invocation.status, "failed");
  assertEquals(invocation.exitCode, 2);
  assertEquals(invocation.stderr, "no channel configured");
});

Deno.test("host_failure_hook - a hook that exceeds its budget is recorded timed_out", async () => {
  const { runner } = recordingRunner({
    ok: true,
    value: {
      success: false,
      code: 124,
      stdout: "",
      stderr: "Timed out after 30000ms",
      timedOut: true,
    },
  });
  const invocation = await invokeHostFailureHook(
    payload(),
    { path: "/opt/hooks/host-failure.sh", timeoutSeconds: 30 },
    seams(runner).options,
  );
  assertEquals(invocation.status, "timed_out");
  assertEquals(invocation.exitCode, 124);
});

Deno.test("host_failure_hook - an un-spawnable hook is recorded spawn_failed", async () => {
  const { runner } = recordingRunner({
    ok: false,
    error: new Error("No such file or directory (os error 2)"),
  });
  const invocation = await invokeHostFailureHook(
    payload(),
    { path: "/opt/hooks/missing.sh", timeoutSeconds: 30 },
    seams(runner).options,
  );
  assertEquals(invocation.status, "spawn_failed");
  assertEquals(invocation.exitCode, -1);
  assert(invocation.stderr.includes("No such file"));
});

Deno.test("host_failure_hook - the child environment carries nothing beyond the contract", async () => {
  const { runner, spawns } = recordingRunner(exits(0));
  await invokeHostFailureHook(
    payload({ lastExitStatus: 1, backoffSeconds: 60 }),
    { path: "/opt/hooks/host-failure.sh", timeoutSeconds: 30 },
    seams(runner).options,
  );
  const env = spawns[0]!.env ?? {};
  for (const name of Object.keys(env)) {
    assert(
      name.startsWith("VIBECODER_") || INHERITED_ENV_VARS.includes(name),
      `unexpected variable in the child environment: ${name}`,
    );
  }
});
