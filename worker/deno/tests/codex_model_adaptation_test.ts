/**
 * Tests for the Codex adaptation to a built-in default model a ChatGPT login
 * refuses (Issue #4221).
 *
 * A ChatGPT login refuses some built-in default models (for example
 * `gpt-6-luna` on the health and summarise phases). The worker now drops
 * `--model` for that phase, so the Codex CLI picks its own model, instead of
 * repeating the refusal. Only a built-in default is adapted: an explicit pin
 * (env, repo, or global config) is always sent. An api-key login is never
 * adapted.
 *
 * Every test calls the real resolvers, descriptor and runner. No test mutates
 * the process environment or PATH: the environment is passed as an object-backed
 * lookup, and the agent is a stub addressed by path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { selectAgentProvider } from "../lib/agent_provider.ts";
import { runClaudeWithRetry } from "../lib/claude_runner.ts";
import {
  buildCodexArgs,
  clearRefusedCodexModels,
  CODEX_CLI_DEFAULT_MODEL,
  markCodexModelRefused,
  resolveCodexModel,
  setActiveRepoCodexModelEffortOverrides,
  setCodexPhaseModelConfigOverrides,
} from "../lib/codex_executor.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";
import {
  resolveProviderFallbackPolicy,
  setConfiguredProviderFallbackPolicy,
} from "../lib/provider_fallback_policy.ts";
import type { Logger, RepoConfig } from "../types.ts";
import { withAgentStub } from "./support/agent_stub.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** The built-in default a ChatGPT login refuses in these tests. */
const REFUSED = "gpt-6-luna";

/** Basename of the file the stub records each invocation's argv in. */
const CALL_LOG = "calls.log";

/** The live refusal, as Codex writes it into its JSONL stream. */
const REFUSAL =
  "The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.";

/** A real successful Codex JSONL run, recorded from the CLI (0.147.0). */
const CODEX_SUCCESS_FIXTURE = new URL(
  "./fixtures/agent_output/codex-0.147.0-success.jsonl",
  import.meta.url,
).pathname;

const CHATGPT_AUTH = { auth_mode: "chatgpt", tokens: {} };
const APIKEY_AUTH = { auth_mode: "apikey", OPENAI_API_KEY: "sk-test" };

const FAST_RETRY = {
  maxRetries: 0,
  maxWaitSeconds: 1,
  initialWaitInterval: 0,
} as const;

/** Write a Codex home holding `auth.json`; the caller removes it. */
async function makeCodexHome(auth: Record<string, unknown>): Promise<string> {
  const home = await Deno.makeTempDir({ prefix: "codex_home_4221_" });
  await Deno.writeTextFile(`${home}/auth.json`, JSON.stringify(auth));
  return home;
}

/** Forget every refused model and clear every routing override. */
function resetCodexRoutingState(): void {
  clearRefusedCodexModels();
  setActiveRepoCodexModelEffortOverrides(undefined);
  setCodexPhaseModelConfigOverrides({});
}

/**
 * Mark a refused model with its console warning swallowed. The warning is
 * asserted in its own test; the other tests only need the mark.
 */
function markRefusedQuietly(model: string, phase?: string): void {
  const original = console.warn;
  console.warn = () => {};
  try {
    markCodexModelRefused(model, phase);
  } finally {
    console.warn = original;
  }
}

/** The argument following `--model`, or undefined when no `--model` is sent. */
function modelFlag(args: readonly string[]): string | undefined {
  const at = args.indexOf("--model");
  return at === -1 ? undefined : args[at + 1];
}

/** One recorded invocation line, split back into its argv tokens. */
function argvOf(line: string): string[] {
  return line.split(" ");
}

/** The entry at `index`, which must exist. */
function itemAt(list: readonly string[], index: number): string {
  const item = list[index];
  assert(item !== undefined, `no entry at index ${index}: ${list}`);
  return item;
}

/** The stub's recorded invocations, one line per call. */
async function readCalls(log: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(log)).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function recordingLogger(lines: string[]): Logger {
  const push = (message: string) => lines.push(message);
  return {
    info: push,
    warn: push,
    error: push,
    debug: () => {},
  } as unknown as Logger;
}

/**
 * Stub body for the Codex agent (Issue #4221).
 *
 * Every invocation's argv goes on one line of {@link CALL_LOG}. A Codex call
 * (`$1 = exec`) is refused with the live JSONL refusal. With
 * `refuseOnlyWithModel`, a Codex call without `--model` succeeds instead, on
 * the recorded Codex success fixture. Any other provider succeeds.
 */
function buildCodexStubBody(refuseOnlyWithModel: boolean): string {
  const failed = JSON.stringify({
    type: "turn.failed",
    error: { type: "invalid_request_error", message: REFUSAL },
  });
  const succeedWithoutModel = refuseOnlyWithModel
    ? [
      `  case " $* " in`,
      `    *" --model "*) ;;`,
      `    *) cat "${CODEX_SUCCESS_FIXTURE}"; exit 0 ;;`,
      `  esac`,
    ]
    : [];
  const log = `"$(dirname "$0")/${CALL_LOG}"`;
  return [
    `printf '%s' "$*" | tr '\\n' ' ' >> ${log}`,
    `printf '\\n' >> ${log}`,
    `if [ "$1" = "exec" ]; then`,
    ...succeedWithoutModel,
    `  printf '%s\\n' '${failed}'`,
    `  exit 1`,
    `fi`,
    `printf '%s\\n' '{"type":"result","result":"Done."}'`,
    `exit 0`,
  ].join("\n");
}

interface RetryRun {
  exitCode: number;
  calls: string[];
  log: string[];
}

/**
 * Run a `summarise` phase on Codex through `runClaudeWithRetry`, with the
 * #4034 fallback policy (Codex, then Claude) configured.
 */
async function runSummariseOnCodex(
  stubBody: string,
  env: EnvLookup,
): Promise<RetryRun> {
  setConfiguredProviderFallbackPolicy(
    resolveProviderFallbackPolicy({
      preferred: "codex",
      enabled: ["codex", "claude"],
      fallback: ["claude"],
    }),
  );
  const log: string[] = [];
  try {
    return await withAgentStub(
      stubBody,
      async (stub) => {
        const result = await runClaudeWithRetry(
          {
            clock: fakeClock(),
            prompt: "test",
            phase: "summarise",
            agentProvider: "codex",
            agentBinaryPath: stub.path,
            env,
            enableModelFallback: true,
            timeoutSeconds: 30,
            killAfterSeconds: 2,
            logger: recordingLogger(log),
          },
          FAST_RETRY,
        );
        assert(result.ok, `run errored: ${!result.ok && result.error}`);
        return {
          exitCode: result.value.exitCode,
          calls: await readCalls(`${stub.dir}/${CALL_LOG}`),
          log,
        };
      },
      { prefix: "codex_adaptation_4221_" },
    );
  } finally {
    setConfiguredProviderFallbackPolicy(undefined);
  }
}

// ---------------------------------------------------------------------------
// Routing and the descriptor
// ---------------------------------------------------------------------------

Deno.test("Codex refused built-in default - a refused id drops --model only for its own phase (Issue #4221)", async () => {
  const home = await makeCodexHome(CHATGPT_AUTH);
  const env = envFrom({ CODEX_HOME: home });
  resetCodexRoutingState();
  try {
    const codex = selectAgentProvider("codex", { env });

    // Positive control: before the refusal, the built-in default is sent.
    assertEquals(resolveCodexModel("health", env), REFUSED);
    assertEquals(
      modelFlag(codex.buildInvocation({ prompt: "x", phase: "health", env })),
      REFUSED,
    );

    markRefusedQuietly(REFUSED, "health");

    assertEquals(resolveCodexModel("health", env), undefined);
    assertEquals(
      modelFlag(codex.buildInvocation({ prompt: "x", phase: "health", env })),
      undefined,
      "the refused phase sends no --model",
    );

    // A phase on another tier keeps its own built-in default.
    assertEquals(resolveCodexModel("issue", env), "gpt-6.1-sol");
    assertEquals(
      modelFlag(codex.buildInvocation({ prompt: "x", phase: "issue", env })),
      "gpt-6.1-sol",
    );
  } finally {
    resetCodexRoutingState();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("Codex refused built-in default - explicit pins still send a refused id (Issue #4221)", async () => {
  const home = await makeCodexHome(CHATGPT_AUTH);
  const chatgptEnv = envFrom({ CODEX_HOME: home });
  const cases: {
    label: string;
    phase: string;
    env: EnvLookup;
    arrange: () => void;
  }[] = [
    {
      label: "CODEX_MODEL_HEALTH env pin",
      phase: "health",
      env: envFrom({ CODEX_HOME: home, CODEX_MODEL_HEALTH: REFUSED }),
      arrange: () => {},
    },
    {
      label: "global codex_phase_model_overrides pin",
      phase: "health",
      env: chatgptEnv,
      arrange: () => setCodexPhaseModelConfigOverrides({ health: REFUSED }),
    },
    {
      label: "repo codex_phase_model_overrides pin",
      phase: "health",
      env: chatgptEnv,
      arrange: () =>
        setActiveRepoCodexModelEffortOverrides({
          codexPhaseModelOverrides: { health: REFUSED },
        } as RepoConfig),
    },
    {
      label: "repo codex_model base tier",
      phase: "health",
      env: chatgptEnv,
      arrange: () =>
        setActiveRepoCodexModelEffortOverrides({
          codexModel: REFUSED,
        } as RepoConfig),
    },
    {
      label: "CODEX_MODEL on a phase with no built-in default",
      phase: "totally_unknown_phase",
      env: envFrom({ CODEX_HOME: home, CODEX_MODEL: REFUSED }),
      arrange: () => {},
    },
  ];
  try {
    for (const pin of cases) {
      resetCodexRoutingState();
      pin.arrange();
      markRefusedQuietly(REFUSED, pin.phase);

      assertEquals(
        resolveCodexModel(pin.phase, pin.env),
        REFUSED,
        `${pin.label} still resolves`,
      );
      const codex = selectAgentProvider("codex", { env: pin.env });
      assertEquals(
        modelFlag(
          codex.buildInvocation({
            prompt: "x",
            phase: pin.phase,
            env: pin.env,
          }),
        ),
        REFUSED,
        `${pin.label} is still sent`,
      );
    }
  } finally {
    resetCodexRoutingState();
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("Codex refused built-in default - an api-key login never adapts (Issue #4221)", async () => {
  const apiHome = await makeCodexHome(APIKEY_AUTH);
  const chatgptHome = await makeCodexHome(CHATGPT_AUTH);
  const chatgptEnv = envFrom({ CODEX_HOME: chatgptHome });
  const apiEnvs: [string, EnvLookup][] = [
    ["api-key auth.json", envFrom({ CODEX_HOME: apiHome })],
    ["no CODEX_HOME", emptyEnv],
  ];
  try {
    for (const [label, env] of apiEnvs) {
      resetCodexRoutingState();
      try {
        const codex = selectAgentProvider("codex", { env });

        // Nothing marked yet: no alternative is offered and no retry is made.
        assertEquals(
          codex.alternativeModels?.(REFUSED, "health", env),
          [],
          label,
        );
        assertEquals(
          codex.adaptAfterModelRefusal?.(REFUSED, "health", env),
          false,
          label,
        );
        // Nothing was marked, so the id still routes under a ChatGPT login.
        assertEquals(resolveCodexModel("health", chatgptEnv), REFUSED, label);

        // A marked id still resolves to its pin under an api-key login.
        markRefusedQuietly(REFUSED, "health");
        assertEquals(resolveCodexModel("health", env), REFUSED, label);
        assertEquals(
          codex.alternativeModels?.(REFUSED, "health", env),
          [],
          label,
        );
        assertEquals(
          codex.adaptAfterModelRefusal?.(REFUSED, "health", env),
          false,
          label,
        );
        assertEquals(resolveCodexModel("health", env), REFUSED, label);
      } finally {
        resetCodexRoutingState();
      }
    }

    // A ChatGPT login is offered the CLI default for the built-in default...
    resetCodexRoutingState();
    try {
      const codex = selectAgentProvider("codex", { env: chatgptEnv });
      assertEquals(
        codex.alternativeModels?.(REFUSED, "health", chatgptEnv),
        [CODEX_CLI_DEFAULT_MODEL],
      );
      // ...but not for a health model the operator pinned explicitly.
      const pinnedEnv = envFrom({
        CODEX_HOME: chatgptHome,
        CODEX_MODEL_HEALTH: REFUSED,
      });
      assertEquals(
        codex.alternativeModels?.(REFUSED, "health", pinnedEnv),
        [],
      );
    } finally {
      resetCodexRoutingState();
    }
  } finally {
    await Deno.remove(apiHome, { recursive: true });
    await Deno.remove(chatgptHome, { recursive: true });
  }
});

Deno.test("buildCodexArgs - the CLI default sentinel emits no --model (Issue #4221)", () => {
  const sentinelArgs = buildCodexArgs({
    prompt: "x",
    model: CODEX_CLI_DEFAULT_MODEL,
  });
  // The sentinel means "send no --model": identical to having no model at all.
  assertEquals(sentinelArgs, buildCodexArgs({ prompt: "x" }));
  assertEquals(modelFlag(sentinelArgs), undefined);

  // A real model id is still sent.
  assertEquals(
    modelFlag(buildCodexArgs({ prompt: "x", model: REFUSED })),
    REFUSED,
  );
});

Deno.test("Codex refused built-in default - the health-gate adaptation routes the phase to the CLI default (Issue #4221)", async () => {
  const home = await makeCodexHome(CHATGPT_AUTH);
  const env = envFrom({ CODEX_HOME: home });
  resetCodexRoutingState();
  try {
    // Descriptor-level equivalent of `tryModelAdaptation` (Issue #2059): the
    // production method probes with the module-level health check, which
    // cannot be replaced from a test, so the probe result is taken as given.
    const codex = selectAgentProvider("codex", { env });
    const failedModel = codex.resolveModel("health", env);
    assertEquals(failedModel, REFUSED);

    const alternatives = codex.alternativeModels?.(
      REFUSED,
      "health",
      env,
    ) ?? [];
    assertEquals(alternatives, [CODEX_CLI_DEFAULT_MODEL]);
    // Offering the alternative alone adapts nothing: the id still routes.
    // This is the state an unhealthy re-probe leaves behind.
    assertEquals(resolveCodexModel("health", env), REFUSED);

    // A healthy re-probe applies the alternative for this run.
    codex.applyModelAdaptation?.(REFUSED, itemAt(alternatives, 0), "health");
    assertEquals(resolveCodexModel("health", env), undefined);
  } finally {
    resetCodexRoutingState();
    await Deno.remove(home, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The in-run retry in runClaudeWithRetry
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runClaudeWithRetry - a refused built-in default is retried once without --model (Issue #4221)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const home = await makeCodexHome(CHATGPT_AUTH);
    resetCodexRoutingState();
    try {
      const { exitCode, calls, log } = await runSummariseOnCodex(
        buildCodexStubBody(true),
        envFrom({ CODEX_HOME: home }),
      );

      assertEquals(exitCode, 0, `the retry must succeed: ${log}`);
      assertEquals(calls.length, 2, `exactly one retry: ${calls}`);
      assert(
        calls.every((line) => argvOf(line)[0] === "exec"),
        `every call stays on Codex: ${calls}`,
      );
      assertEquals(
        modelFlag(argvOf(itemAt(calls, 0))),
        REFUSED,
        "the first attempt names the built-in default",
      );
      assertEquals(
        modelFlag(argvOf(itemAt(calls, 1))),
        undefined,
        "the retry omits --model",
      );
      assert(
        log.some((line) => line.includes("[codex-adaptation]")),
        `the adaptation is logged: ${log}`,
      );
      assert(
        !log.some((line) => line.includes("[provider-fallback]")),
        `no provider switch is logged: ${log}`,
      );
    } finally {
      resetCodexRoutingState();
      await Deno.remove(home, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - a second refusal falls through to the provider switch (Issue #4221)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const home = await makeCodexHome(CHATGPT_AUTH);
    resetCodexRoutingState();
    try {
      // Refuses every Codex call, even the retry without --model.
      const { exitCode, calls, log } = await runSummariseOnCodex(
        buildCodexStubBody(false),
        envFrom({ CODEX_HOME: home }),
      );

      assertEquals(exitCode, 0, `the fallback run must succeed: ${log}`);
      assertEquals(calls.length, 3, `one retry, then one switch: ${calls}`);
      assertEquals(
        argvOf(itemAt(calls, 0))[0],
        "exec",
        "first attempt is Codex",
      );
      assertEquals(
        modelFlag(argvOf(itemAt(calls, 0))),
        REFUSED,
        "first attempt names the built-in default",
      );
      assertEquals(argvOf(itemAt(calls, 1))[0], "exec", "the retry is Codex");
      assertEquals(
        modelFlag(argvOf(itemAt(calls, 1))),
        undefined,
        "the retry omits --model",
      );
      assert(
        argvOf(itemAt(calls, 2))[0] !== "exec",
        `the switch leaves Codex after the retry: ${calls}`,
      );
    } finally {
      resetCodexRoutingState();
      await Deno.remove(home, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runClaudeWithRetry - an api-key login is not adapted and switches provider (Issue #4221)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    const home = await makeCodexHome(APIKEY_AUTH);
    resetCodexRoutingState();
    try {
      const { exitCode, calls, log } = await runSummariseOnCodex(
        buildCodexStubBody(false),
        envFrom({ CODEX_HOME: home }),
      );

      assertEquals(exitCode, 0, `the fallback run must succeed: ${log}`);
      assertEquals(calls.length, 2, `no retry, one switch: ${calls}`);
      assertEquals(
        argvOf(itemAt(calls, 0))[0],
        "exec",
        "first attempt is Codex",
      );
      assertEquals(
        modelFlag(argvOf(itemAt(calls, 0))),
        REFUSED,
        "the refused built-in default was sent",
      );
      assert(
        argvOf(itemAt(calls, 1))[0] !== "exec",
        `the switch leaves Codex straight away: ${calls}`,
      );
      assert(
        !log.some((line) => line.includes("[codex-adaptation]")),
        `no adaptation is logged for an api-key login: ${log}`,
      );
    } finally {
      resetCodexRoutingState();
      await Deno.remove(home, { recursive: true });
    }
  },
});

// ---------------------------------------------------------------------------
// The refusal warning
// ---------------------------------------------------------------------------

Deno.test("Codex refused built-in default - the refusal warning is printed once per model (Issue #4221)", () => {
  resetCodexRoutingState();
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    markCodexModelRefused(REFUSED, "health");
    markCodexModelRefused(REFUSED, "summarise");
    markCodexModelRefused(REFUSED, "health");

    const forRefused = warnings.filter((line) => line.includes(REFUSED));
    assertEquals(forRefused.length, 1, `one warning per model: ${warnings}`);
    assertStringIncludes(itemAt(forRefused, 0), REFUSED);
    assertStringIncludes(itemAt(forRefused, 0), `phase "health"`);
    assertStringIncludes(itemAt(forRefused, 0), "codex_phase_model_overrides");
    assertStringIncludes(itemAt(forRefused, 0), "provider_model_tiers.codex");

    markCodexModelRefused("gpt-6.1-sol", "issue");
    assertEquals(warnings.length, 2, `a second model warns again: ${warnings}`);
    assertStringIncludes(itemAt(warnings, 1), "gpt-6.1-sol");
  } finally {
    console.warn = original;
    resetCodexRoutingState();
  }
});
