/**
 * Tests for the DeepSeek coding-agent provider (Issue #414, parent #396).
 *
 * DeepSeek is the fourth provider registered through the seam
 * (`worker/deno/lib/agent_provider.ts`) and the first that ships no CLI of its
 * own: it is the Claude Code CLI pointed at DeepSeek's Anthropic-compatible
 * endpoint. That gives it two failure modes no other provider has, and both
 * are held here:
 *
 *   - **`--effort` must never reach the argv.** Codex and Gemini reject an
 *     unknown flag at their own CLI's argument layer; the Anthropic CLI accepts
 *     `--effort` as perfectly well-formed and forwards it to an endpoint that
 *     does not implement it.
 *   - **The binary must not be `claude`.** Both fragments install to
 *     `/usr/local/bin/<binary>`, so a shared command name in an
 *     `AGENT_PROVIDERS="claude,deepseek"` image means one provider silently
 *     overwriting the other.
 *
 * Everything else asserts the registration is the whole worker-side change:
 * selection, the image-stamp gate and the credential preflight all work off
 * the descriptor with no DeepSeek special case anywhere.
 *
 * Every test calls the real functions with real data.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  AGENT_PROVIDER_CONFIG_KEY,
  AGENT_PROVIDER_ENV,
  agentProviderIds,
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  ENABLED_AGENT_PROVIDERS_CONFIG_KEY,
  GEMINI_PROVIDER_ID,
  IMAGE_AGENT_PROVIDERS_ENV,
  PROVIDER_FRAGMENT_DIR,
  resolveAgentProvider,
  resolveAgentProviderId,
  resolveEnabledAgentProviderIds,
  selectAgentProvider,
} from "../lib/agent_provider.ts";
import {
  checkCredentialPreflight,
  classifyCredentialFailure,
  type CredentialFailure,
} from "../lib/credential_preflight.ts";
import {
  clearDeepSeekEffortWarnings,
  setActiveRepoDeepSeekModelOverrides,
  setDeepSeekPhaseModelConfigOverrides,
} from "../lib/deepseek_executor.ts";
import { DEEPSEEK_PHASE_MODEL_DEFAULTS } from "../lib/config_defaults.ts";

/** The DeepSeek descriptor under test. */
const deepseek = resolveAgentProvider(DEEPSEEK_PROVIDER_ID);

/** The Claude descriptor, whose CLI DeepSeek shares. */
const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);

/** Build an env lookup from a plain map (absent names return undefined). */
function envOf(map: Record<string, string> = {}) {
  return (name: string): string | undefined => map[name];
}

/** Drop any routing overrides a sibling test file left on the module. */
function clearDeepSeekRouting(): void {
  setDeepSeekPhaseModelConfigOverrides({});
  setActiveRepoDeepSeekModelOverrides(undefined);
  clearDeepSeekEffortWarnings();
}

/** Run `fn` with `console.warn` captured. */
function withCapturedWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Registration: the descriptor is the whole worker-side change
// ---------------------------------------------------------------------------

Deno.test("deepseek provider - it is registered alongside the other three", () => {
  assertEquals(agentProviderIds(), [
    CLAUDE_PROVIDER_ID,
    CODEX_PROVIDER_ID,
    GEMINI_PROVIDER_ID,
    DEEPSEEK_PROVIDER_ID,
  ]);
});

Deno.test("deepseek provider - the descriptor populates binary, credentials, environment and invocation", () => {
  assertEquals(deepseek.id, "deepseek");
  assert(deepseek.displayName.length > 0, "the descriptor names the provider");

  assertEquals(deepseek.credentials.subdir, "deepseek");
  assertEquals(deepseek.credentials.file, "provider.env");
  assertEquals(deepseek.credentials.envVars, ["DEEPSEEK_API_KEY"]);
  assertEquals(
    deepseek.credentials.provisionEnvVar,
    "VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY",
  );

  assert(deepseek.environment.secretAllowlist.includes("DEEPSEEK_API_KEY"));
  assert(deepseek.environment.denylist.includes("ANTHROPIC_API_KEY"));
  assertEquals(
    deepseek.install.fragment,
    `${PROVIDER_FRAGMENT_DIR}/deepseek.sh`,
  );
  // The same CLI as Claude, so a bare `-p` reads the prompt from stdin.
  assertEquals(deepseek.promptTransport, "stdin");
  assert(deepseek.buildInvocation({ prompt: "x" }).length > 0);
});

Deno.test("deepseek provider - an unsupported id now names deepseek among the supported ids", () => {
  const error = assertThrows(
    () => resolveAgentProvider("aider"),
    Error,
    "aider",
  );
  assertStringIncludes(error.message, DEEPSEEK_PROVIDER_ID);
});

Deno.test("deepseek provider - it publishes no cheaper-model ladder", () => {
  // The optional method being ABSENT is the signal: the rate-limit fallback
  // reports `no-ladder-for-provider` rather than a silent no-op (Issue #365).
  assertEquals(deepseek.cheaperModel, undefined);
});

// ---------------------------------------------------------------------------
// The command name: a two-provider image must not have one clobber the other
// ---------------------------------------------------------------------------

Deno.test("deepseek provider - its binary is not Claude's, so one fragment cannot overwrite the other", () => {
  assertEquals(deepseek.binary, "deepseek");
  assert(
    deepseek.binary !== claude.binary,
    "both fragments install to /usr/local/bin/<binary>; a shared command " +
      'name in an AGENT_PROVIDERS="claude,deepseek" image means one ' +
      "provider silently overwriting the other",
  );

  // Stated as a registry-wide invariant, so a fifth provider carried on an
  // existing CLI cannot reintroduce the clash.
  const binaries = agentProviderIds().map((id) =>
    resolveAgentProvider(id).binary
  );
  assertEquals(
    new Set(binaries).size,
    binaries.length,
    `two providers share a command name: ${binaries.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// Selection: configuration, environment, and the enabled set
// ---------------------------------------------------------------------------

Deno.test(`deepseek provider - "${AGENT_PROVIDER_CONFIG_KEY}: deepseek" selects it`, () => {
  assertEquals(
    resolveAgentProviderId({
      configured: DEEPSEEK_PROVIDER_ID,
      env: envOf(),
    }),
    DEEPSEEK_PROVIDER_ID,
  );
});

Deno.test(`deepseek provider - ${AGENT_PROVIDER_ENV}=deepseek overrides configuration`, () => {
  assertEquals(
    resolveAgentProviderId({
      configured: CLAUDE_PROVIDER_ID,
      env: envOf({ [AGENT_PROVIDER_ENV]: DEEPSEEK_PROVIDER_ID }),
    }),
    DEEPSEEK_PROVIDER_ID,
  );
});

Deno.test(`deepseek provider - "${ENABLED_AGENT_PROVIDERS_CONFIG_KEY}" enables claude and deepseek together`, () => {
  assertEquals(
    resolveEnabledAgentProviderIds({
      configured: CLAUDE_PROVIDER_ID,
      configuredProviders: [CLAUDE_PROVIDER_ID, DEEPSEEK_PROVIDER_ID],
      env: envOf(),
    }),
    [CLAUDE_PROVIDER_ID, DEEPSEEK_PROVIDER_ID],
  );
});

Deno.test("deepseek provider - an image that did not install it fails loudly, naming the installed set", () => {
  const error = assertThrows(
    () =>
      selectAgentProvider(DEEPSEEK_PROVIDER_ID, {
        env: envOf({ [IMAGE_AGENT_PROVIDERS_ENV]: "claude,gemini" }),
      }),
    Error,
    DEEPSEEK_PROVIDER_ID,
  );
  assertStringIncludes(error.message, "claude, gemini");
  // No fall back to Claude: the wrong agent running silently is the failure
  // this gate exists to prevent (Issue #3234).
  assert(
    !error.message.includes("falling back"),
    `the gate must not offer a fallback: ${error.message}`,
  );

  const installed = selectAgentProvider(DEEPSEEK_PROVIDER_ID, {
    env: envOf({ [IMAGE_AGENT_PROVIDERS_ENV]: "claude,deepseek" }),
  });
  assertEquals(installed.id, DEEPSEEK_PROVIDER_ID);
});

Deno.test("deepseek provider - a Quorum trio resolves its providers per invocation", () => {
  const env = envOf({
    [IMAGE_AGENT_PROVIDERS_ENV]: "claude,deepseek,gemini",
  });

  const planners = [CLAUDE_PROVIDER_ID, DEEPSEEK_PROVIDER_ID].map((id) =>
    selectAgentProvider(id, { env })
  );
  const judge = selectAgentProvider(GEMINI_PROVIDER_ID, { env });

  assertEquals(planners.map((p) => p.id), [
    CLAUDE_PROVIDER_ID,
    DEEPSEEK_PROVIDER_ID,
  ]);
  assertEquals(judge.id, GEMINI_PROVIDER_ID);

  // Each member is a distinct executable, so the two planners genuinely run
  // different agents inside one image rather than the same one twice.
  assertEquals(new Set([...planners, judge].map((p) => p.binary)).size, 3);
});

// ---------------------------------------------------------------------------
// The invocation: Claude's argv shape, a DeepSeek model, and never --effort
// ---------------------------------------------------------------------------

Deno.test("deepseek provider - the invocation takes the Claude CLI's argument shape", () => {
  clearDeepSeekRouting();
  const args = deepseek.buildInvocation({
    prompt: "PROMPT",
    model: "deepseek-chat",
    systemPrompt: "GUIDANCE",
    disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
    mcpConfigPath: "/tmp/mcp.json",
  });

  assertEquals(args, [
    "--model",
    "deepseek-chat",
    "--dangerously-skip-permissions",
    "--disallowed-tools",
    "EnterPlanMode,ExitPlanMode",
    "--verbose",
    "--output-format",
    "stream-json",
    "--mcp-config",
    "/tmp/mcp.json",
    "--system-prompt",
    "GUIDANCE",
    "-p",
    "PROMPT",
  ]);
});

Deno.test("deepseek provider - a piped prompt leaves the text out of the argv", () => {
  clearDeepSeekRouting();
  const args = deepseek.buildInvocation({
    prompt: "a very long prompt",
    model: "deepseek-chat",
    promptViaStdin: true,
  });

  assertEquals(args.at(-1), "-p");
  assert(
    !args.includes("a very long prompt"),
    "the prompt is read from stdin, not carried in argv (Issue #4385)",
  );
});

Deno.test("deepseek provider - a later phase resumes the previous session", () => {
  clearDeepSeekRouting();
  const first = deepseek.buildInvocation({
    prompt: "phase one",
    sessionResumeState: { sessionId: "owner-repo-42-7", phaseCount: 0 },
  });
  assert(
    !first.includes("--resume"),
    "the first phase starts a session rather than resuming one",
  );

  const later = deepseek.buildInvocation({
    prompt: "phase two",
    sessionResumeState: { sessionId: "owner-repo-42-7", phaseCount: 1 },
  });
  assert(later.includes("--resume"), "a later phase resumes the session");
});

Deno.test("deepseek provider - every phase carries a DeepSeek model id and no --effort", () => {
  clearDeepSeekRouting();
  const phases = Object.keys(DEEPSEEK_PHASE_MODEL_DEFAULTS);
  const built = new Map<string, string[]>();
  // The phase efforts the worker designs are warned about, one line per phase;
  // captured here so the assertions below read the argv, not the noise.
  withCapturedWarnings(() => {
    for (const phase of phases) {
      built.set(phase, deepseek.buildInvocation({ prompt: "work", phase }));
    }
  });

  for (const phase of phases) {
    const args = built.get(phase) ?? [];
    const model = args[args.indexOf("--model") + 1] ?? "";
    assertEquals(
      model,
      DEEPSEEK_PHASE_MODEL_DEFAULTS[phase],
      `${phase}: the routed model must reach the CLI`,
    );
    assertStringIncludes(model, "deepseek");
    assert(
      !args.includes("--effort"),
      `${phase}: DeepSeek's endpoint implements no effort control, so the ` +
        `Anthropic CLI must never be handed one: ${args.join(" ")}`,
    );
  }
  clearDeepSeekEffortWarnings();
});

Deno.test("deepseek provider - an explicit effort is reported loudly rather than dropped or passed", () => {
  clearDeepSeekRouting();
  const warnings = withCapturedWarnings(() => {
    const args = deepseek.buildInvocation({
      prompt: "work",
      phase: "planning",
      effort: "max",
    });
    assert(
      !args.includes("--effort") && !args.includes("max"),
      `no effort may reach the argv: ${args.join(" ")}`,
    );
  });

  assertEquals(warnings.length, 1, warnings.join("|"));
  assertStringIncludes(warnings[0] ?? "", "deepseek");
  assertStringIncludes(warnings[0] ?? "", "max");
  clearDeepSeekEffortWarnings();
});

// ---------------------------------------------------------------------------
// Cross-vendor credentials never cross — least of all Anthropic's
// ---------------------------------------------------------------------------

Deno.test("deepseek provider - the child carries DeepSeek's key and no first-party Anthropic credential", () => {
  const env = deepseek.buildChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/worker",
    DEEPSEEK_API_KEY: "sk-deepseek",
    GH_TOKEN: "gho_test",
    ANTHROPIC_API_KEY: "sk-ant",
    // The shape a claude+deepseek run has: the preflight exports
    // claude/provider.env into the worker's own environment, so this value is
    // Anthropic's token and must not travel to api.deepseek.com (Issue #414).
    ANTHROPIC_AUTH_TOKEN: "sk-ant-auth",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    OPENAI_API_KEY: "sk-openai",
    GEMINI_API_KEY: "sk-gemini",
    SOME_SECRET: "nope",
  });

  assertEquals(env.PATH, "/usr/bin");
  assertEquals(env.DEEPSEEK_API_KEY, "sk-deepseek");
  assertEquals(env.GH_TOKEN, "gho_test");
  assertEquals(env.ANTHROPIC_API_KEY, undefined);
  assertEquals(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  // The CLI reads its credential from ANTHROPIC_AUTH_TOKEN, so the variable is
  // present — carrying DeepSeek's key, never the inherited Anthropic one.
  assertEquals(env.ANTHROPIC_AUTH_TOKEN, "sk-deepseek");
  assertEquals(env.OPENAI_API_KEY, undefined);
  assertEquals(env.GEMINI_API_KEY, undefined);
  assertEquals(env.SOME_SECRET, undefined);
});

Deno.test("deepseek provider - and no Claude child receives a DeepSeek key", () => {
  const env = claude.buildChildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant",
    DEEPSEEK_API_KEY: "sk-deepseek",
  });
  assertEquals(env.ANTHROPIC_API_KEY, "sk-ant");
  assertEquals(env.DEEPSEEK_API_KEY, undefined);
});

// ---------------------------------------------------------------------------
// Authentication failures are classified and actionable
// ---------------------------------------------------------------------------

Deno.test("deepseek provider - DeepSeek's own authentication failures are recognised", () => {
  assertEquals(
    deepseek.isAuthError(
      "Authentication Fails, Your api key: ****9dc2 is invalid",
    ),
    true,
  );
  assertEquals(deepseek.isAuthError("Error: 401 Unauthorized"), true);
  assertEquals(
    deepseek.isAuthError('{"error":{"type":"authentication_error"}}'),
    true,
  );
  assertEquals(
    deepseek.isAuthError("Please set DEEPSEEK_API_KEY to authenticate"),
    true,
  );
  assertEquals(deepseek.isAuthError("error: cargo build failed"), false);
  assertEquals(deepseek.isAuthError(""), false);
});

Deno.test("deepseek provider - the auth message names the DeepSeek credential, not claude login", () => {
  const message = deepseek.authActionableMessage();
  assertStringIncludes(message, "DEEPSEEK_API_KEY");
  assertStringIncludes(message, "deepseek/provider.env");
  assert(
    !/(^|\s)claude login(\s|$)/.test(message),
    `\`claude login\` cannot fix a DeepSeek credential: ${message}`,
  );
  // Its own message, not Claude's — the two must not converge by accident.
  assert(message !== claude.authActionableMessage());
});

Deno.test("deepseek provider - a missing DeepSeek credential is classified as a provider-auth failure", () => {
  const failure: CredentialFailure = {
    code: "provider-credentials-missing",
    path: "/creds/deepseek/provider.env",
    provider: DEEPSEEK_PROVIDER_ID,
    message:
      "Coding-agent provider authentication required for DeepSeek (deepseek): " +
      "/creds/deepseek/provider.env holds no credential and none of " +
      "DEEPSEEK_API_KEY is set.",
  };

  assertEquals(classifyCredentialFailure(failure), "provider-auth");
});

// ---------------------------------------------------------------------------
// The preflight picks the provider up from the descriptor, with no edit
// ---------------------------------------------------------------------------

Deno.test("deepseek provider - the credential preflight checks deepseek/provider.env", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-deepseek-preflight-" });
  const dir = `${root}/credentials`;
  try {
    await Deno.mkdir(`${dir}/gh`, { recursive: true });
    await Deno.mkdir(`${dir}/claude`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/gh/hosts.yml`,
      "github.com:\n    oauth_token: gho_worker\n",
    );
    await Deno.writeTextFile(
      `${dir}/claude/provider.env`,
      "ANTHROPIC_API_KEY=sk-ant-test\n",
    );
    if (Deno.build.os !== "windows") {
      await Deno.chmod(`${dir}/gh/hosts.yml`, 0o600);
      await Deno.chmod(`${dir}/claude/provider.env`, 0o600);
    }

    const providers = [claude, deepseek];
    const missing = await checkCredentialPreflight({
      dir,
      env: envOf(),
      providers,
    });
    assertEquals(missing.ok, false);
    const failure = missing.failures.find(
      (f) => f.code === "provider-credentials-missing",
    );
    assert(failure, "the preflight reports the missing DeepSeek credential");
    assertEquals(failure.provider, DEEPSEEK_PROVIDER_ID);
    assertEquals(failure.path, `${dir}/deepseek/provider.env`);
    assertStringIncludes(failure.message, "DEEPSEEK_API_KEY");
    assertStringIncludes(
      failure.message,
      "VIBE_LAUNCHAGENT_DEEPSEEK_API_KEY",
    );

    // Provisioning the file the descriptor names is the whole fix — the
    // deepseek sub-directory is permitted material, not unexpected material.
    await Deno.mkdir(`${dir}/deepseek`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deepseek/provider.env`,
      "DEEPSEEK_API_KEY=sk-deepseek-test\n",
    );
    if (Deno.build.os !== "windows") {
      await Deno.chmod(`${dir}/deepseek/provider.env`, 0o600);
    }

    const passing = await checkCredentialPreflight({
      dir,
      env: envOf(),
      providers,
    });
    assertEquals(passing.ok, true, JSON.stringify(passing.failures));
    assertEquals(
      passing.providers.map((p) => `${p.id}=${p.source}`),
      ["claude=directory", "deepseek=directory"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
