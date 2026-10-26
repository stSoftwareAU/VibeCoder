/** The evaluator never falls back from a subscription into a paid API (#4368). */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CapabilityProviderDeps,
  invokeCapabilityModel,
} from "../lib/capability_security_eval_provider.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";
import { CLAUDE_NON_SUBSCRIPTION_CREDENTIAL_ENV_VARS } from "../lib/claude_env.ts";

const REQUEST = {
  model: "haiku",
  effort: "low",
  prompt: "Return a tiny function.",
  timeoutMs: 30_000,
};
const AUTH = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "max",
  email: "must-not-escape@example.invalid",
};
const USAGE = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
function transcript(
  options: {
    model?: string;
    usage?: unknown;
    failed?: boolean;
    error?: string;
    omitModel?: boolean;
    omitUsage?: boolean;
    text?: string;
  } = {},
): string {
  return [
    JSON.stringify({
      type: "assistant",
      message: {
        ...(options.omitModel
          ? {}
          : { model: options.model ?? "claude-haiku-4-5-20251001" }),
        content: [{
          type: "text",
          text: options.text ?? "export const answer = 42;",
        }],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: options.failed ? "error_during_execution" : "success",
      is_error: options.failed ?? false,
      result: options.error ?? options.text ?? "export const answer = 42;",
      ...(options.omitUsage ? {} : { usage: options.usage ?? USAGE }),
      ...(options.error ? { errors: [options.error] } : {}),
    }),
  ].join("\n");
}
function output(
  stdout: string,
  overrides: Partial<SubprocessResult> = {},
): SubprocessResult {
  return {
    success: true,
    code: 0,
    stdout,
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}
function rig(results: SubprocessResult[], auth: unknown = AUTH) {
  const calls: Array<
    { args: string[]; options: Parameters<CapabilityProviderDeps["run"]>[2] }
  > = [];
  const sleeps: number[] = [];
  const removed: string[] = [];
  let now = 0;
  const deps: CapabilityProviderDeps = {
    env: () => ({
      PATH: "/usr/bin",
      HOME: "/home/test",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-secret",
      ANTHROPIC_API_KEY: "metered-secret",
      ANTHROPIC_AUTH_TOKEN: "proxy-secret",
      ANTHROPIC_BASE_URL: "https://proxy.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      HTTP_PROXY: "http://proxy.invalid",
      GH_TOKEN: "github-secret",
      NODE_OPTIONS: "--require=/malicious.js",
      CLAUDE_CODE_SIMPLE: "1",
      VIBE_CLAUDE_MAX_TURNS: "999",
    }),
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    makeTempDir: () => Promise.resolve("/empty/eval"),
    removeTempDir: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
    run: (_binary, args, options) => {
      calls.push({ args, options });
      now += 25;
      if (args.includes("auth")) {
        return Promise.resolve({
          ok: true,
          value: output(JSON.stringify(auth)),
        });
      }
      const result = results.shift();
      assert(result, "unexpected extra generation attempt");
      return Promise.resolve({ ok: true, value: result });
    },
  };
  return { deps, calls, sleeps, removed };
}

Deno.test("capability provider - proves subscription and disables tools, customisation and API fallback", async () => {
  const test = rig([output(transcript())]);
  const result = await invokeCapabilityModel(REQUEST, test.deps);
  assertEquals(result.ok, true);
  assertEquals(result.text, "export const answer = 42;");
  assertEquals(test.calls.length, 2);
  const [auth, generation] = test.calls;
  assertEquals(auth!.options!.env, generation!.options!.env);
  for (const call of test.calls) {
    assertEquals(call.options!.cwd, "/empty/eval");
    assertEquals(call.options!.clearEnv, true);
    for (
      const name of [
        ...CLAUDE_NON_SUBSCRIPTION_CREDENTIAL_ENV_VARS,
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "HTTP_PROXY",
        "GH_TOKEN",
        "NODE_OPTIONS",
        "CLAUDE_CODE_SIMPLE",
      ]
    ) assertEquals(call.options!.env![name], undefined, name);
    assertEquals(
      call.options!.env!["CLAUDE_CODE_OAUTH_TOKEN"],
      "subscription-secret",
    );
    assert(call.args.includes("--safe-mode"));
    assertEquals(call.args.includes("--bare"), false);
  }
  const args = generation!.args;
  for (
    const flag of [
      "--strict-mcp-config",
      "--no-session-persistence",
      "--disable-slash-commands",
    ]
  ) assert(args.includes(flag));
  for (
    const [flag, value] of [
      ["--model", "haiku"],
      ["--effort", "low"],
      ["--max-turns", "1"],
      ["--tools", ""],
      ["--setting-sources", ""],
    ]
  ) assertEquals(args[args.indexOf(flag!) + 1], value);
  assertEquals(args.includes("--dangerously-skip-permissions"), false);
  assertEquals(args.includes("--fallback-model"), false);
  assertEquals(args.at(-1), REQUEST.prompt);
  assertEquals(result.attempts[0]!.servedModels, ["claude-haiku-4-5-20251001"]);
  assertEquals(result.attempts[0]!.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  assertEquals(result.attempts[0]!.costUsd, 0.0002);
  assertEquals(result.attempts[0]!.elapsedMs, 25);
  assertEquals(test.removed, ["/empty/eval"]);
  assertEquals(JSON.stringify(result).includes(AUTH.email), false);
});

Deno.test("capability provider - absent, API, proxy and non-subscription auth fail closed", async () => {
  for (
    const auth of [
      {},
      { ...AUTH, loggedIn: false },
      { ...AUTH, authMethod: "api_key" },
      { ...AUTH, apiProvider: "bedrock" },
      { ...AUTH, subscriptionType: null },
    ]
  ) {
    const test = rig([], auth);
    const result = await invokeCapabilityModel(REQUEST, test.deps);
    assertEquals(result.ok, false);
    assertEquals(result.attempts, []);
    assertEquals(test.calls.length, 1);
    assertStringIncludes(result.reason!, "subscription");
    assertEquals(test.removed, ["/empty/eval"]);
  }
});

Deno.test("capability provider - one transient retry retains both attempts and identical settings", async () => {
  const test = rig([
    output(
      transcript({ failed: true, error: "HTTP 503 Service unavailable" }),
      { success: false, code: 1 },
    ),
    output(transcript()),
  ]);
  const result = await invokeCapabilityModel(REQUEST, test.deps);
  assertEquals(result.ok, true);
  assertEquals(result.attempts.map((a) => a.ok), [false, true]);
  assertEquals(result.attempts.map((a) => a.costUsd), [0.0002, 0.0002]);
  assertEquals(result.attempts.map((a) => a.elapsedMs), [25, 25]);
  assertEquals(test.calls[1]!.args, test.calls[2]!.args);
  assertEquals(test.sleeps, [1000]);
  assert(test.calls[2]!.options!.timeoutMs < test.calls[1]!.options!.timeoutMs);
});

Deno.test("capability provider - quota, authentication, unsupported flags and permanent failures never retry", async () => {
  for (
    const error of [
      "Not logged in",
      "You've hit your usage limit",
      "unknown option '--safe-mode'",
      "invalid request",
    ]
  ) {
    const test = rig([output("", { success: false, code: 1, stderr: error })]);
    const result = await invokeCapabilityModel(REQUEST, test.deps);
    assertEquals(result.ok, false);
    assertEquals(result.attempts.length, 1);
    assertEquals(result.attempts[0]!.costUsd, null);
    assertEquals(test.sleeps, []);
    assertEquals(test.calls.length, 2);
  }
});

Deno.test("capability provider - missing model, usage, malformed counts and unknown prices remain unknown", async () => {
  for (
    const data of [{ omitModel: true }, { omitUsage: true }, { usage: {} }, {
      usage: { ...USAGE, output_tokens: -1 },
    }, { model: "unpriced-future-model" }]
  ) {
    const test = rig([output(transcript(data))]);
    const result = await invokeCapabilityModel(REQUEST, test.deps);
    assertEquals(result.ok, true);
    assertEquals(result.attempts[0]!.costUsd, null);
  }
});

Deno.test("capability provider - an error result at exit zero and partial text are not success", async () => {
  for (
    const stdout of [
      transcript({ failed: true, error: "Not logged in" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "partial" }] },
      }),
      transcript({ text: "" }),
    ]
  ) {
    const test = rig([output(stdout)]);
    const result = await invokeCapabilityModel(REQUEST, test.deps);
    assertEquals(result.ok, false);
    assertEquals(result.text, "");
    assertEquals(test.calls.length, 2);
  }
});

Deno.test("capability provider - invalid requests never spawn", async () => {
  for (
    const request of [
      { ...REQUEST, model: "" },
      { ...REQUEST, effort: "unknown" },
      { ...REQUEST, timeoutMs: 0 },
      { ...REQUEST, prompt: "x".repeat(128 * 1024) },
    ]
  ) {
    const test = rig([]);
    assertEquals((await invokeCapabilityModel(request, test.deps)).ok, false);
    assertEquals(test.calls, []);
  }
});

Deno.test("capability provider - a timeout preserves partial usage and is never billed as free", async () => {
  const test = rig([output(transcript(), {
    success: false,
    code: 124,
    timedOut: true,
    stderr: "Timed out",
  })]);
  const result = await invokeCapabilityModel(REQUEST, test.deps);
  assertEquals(result.ok, false);
  assertEquals(result.attempts.length, 1);
  assertEquals(result.attempts[0]!.costUsd, 0.0002);
  assertEquals(result.attempts[0]!.elapsedMs, 25);
  assertEquals(result.attempts[0]!.usage!.outputTokens, 20);
  assertEquals(test.calls[1]!.options!.captureOutputOnTimeout, true);
  assertEquals(test.sleeps, []);
});

Deno.test("capability provider - a repeated transient failure stops after two attempts", async () => {
  const failed = output(
    transcript({ failed: true, error: "HTTP 503 Service unavailable" }),
    { success: false, code: 1 },
  );
  const test = rig([failed, failed]);
  const result = await invokeCapabilityModel(REQUEST, test.deps);
  assertEquals(result.ok, false);
  assertEquals(result.attempts.map((attempt) => attempt.ok), [false, false]);
  assertEquals(result.attempts.map((attempt) => attempt.costUsd), [
    0.0002,
    0.0002,
  ]);
  assertEquals(test.calls.length, 3);
  assertEquals(test.sleeps, [1000]);
});

Deno.test("capability provider - retry waits cannot exceed the original budget", async () => {
  const test = rig([
    output(
      transcript({ failed: true, error: "HTTP 503 Service unavailable" }),
      { success: false, code: 1 },
    ),
  ]);
  const result = await invokeCapabilityModel(
    { ...REQUEST, timeoutMs: 1000 },
    test.deps,
  );
  assertEquals(result.ok, false);
  assertEquals(result.attempts.length, 1);
  assertEquals(test.sleeps, []);
  assertEquals(test.calls[0]!.options!.timeoutMs, 1000);
  assertEquals(test.calls[1]!.options!.timeoutMs, 975);
});
