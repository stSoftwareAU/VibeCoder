/**
 * Tests for agent_provider.ts — the coding-agent provider seam (Issue #4067,
 * parent #4060).
 *
 * The seam exists so a second provider (Codex is the intended next one) can be
 * added without redesigning containment: one module describes a provider as
 * data — id, binary, credential material, environment and invocation — and the
 * worker resolves all four through it.
 *
 * These tests call the real functions with real data. The invocation test
 * pins the exact argument list `runClaudeWithTimeout` built before the seam
 * existed, so routing through the descriptor cannot silently change what the
 * agent is launched with.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  AGENT_PROVIDER_ENV,
  agentProviderIds,
  assertImageInstalledProvider,
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  DEFAULT_AGENT_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
  IMAGE_AGENT_PROVIDERS_ENV,
  imageAgentProviderIds,
  PROVIDER_FRAGMENT_DIR,
  resolveAgentProvider,
  resolveAgentProviderId,
} from "../lib/agent_provider.ts";
import { buildClaudeEffortArgs } from "../lib/claude_executor.ts";
import { checkCredentialPreflight } from "../lib/credential_preflight.ts";
import { loadConfig } from "../lib/config.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const repoRoot = new URL("../../../", import.meta.url).pathname;

/** Read a repository file as text. */
async function readRepoFile(relative: string): Promise<string> {
  return await Deno.readTextFile(`${repoRoot}${relative}`);
}

// ---------------------------------------------------------------------------
// The descriptor is the single definition of the provider
// ---------------------------------------------------------------------------

Deno.test("agent provider - Claude descriptor defines id, binary, credentials, environment and invocation", () => {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  assertEquals(provider.id, "claude");
  assertEquals(provider.binary, "claude");
  assertEquals(provider.credentials.subdir, "claude");
  assertEquals(provider.credentials.file, "provider.env");
  assert(
    provider.credentials.envVars.includes("ANTHROPIC_API_KEY"),
    "the descriptor names the credential environment variables",
  );
  assert(
    provider.environment.secretAllowlist.includes("ANTHROPIC_API_KEY"),
    "credential variables reach the child through the descriptor's allowlist",
  );
  assertEquals(provider.install.fragment, `${PROVIDER_FRAGMENT_DIR}/claude.sh`);
  assertEquals(typeof provider.buildInvocation, "function");
});

Deno.test("agent provider - Claude descriptor produces the invocation the worker used before the seam", () => {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  const args = provider.buildInvocation({
    prompt: "PROMPT",
    systemPrompt: "SYSTEM",
    model: "claude-opus-4-1",
    effort: "high",
    disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
    sessionResumeState: { sessionId: "repo-42-7", phaseCount: 1 },
  });

  // The pre-change order in claude_runner.ts: model, effort, standard flags,
  // system prompt, session resume, then the prompt last.
  assertEquals(args, [
    "--model",
    "claude-opus-4-1",
    "--effort",
    "high",
    "--dangerously-skip-permissions",
    "--disallowed-tools",
    "EnterPlanMode,ExitPlanMode",
    "--verbose",
    "--output-format",
    "stream-json",
    "--system-prompt",
    "SYSTEM",
    "--session-id",
    "repo-42-7",
    "--resume",
    "-p",
    "PROMPT",
  ]);
});

Deno.test("agent provider - Claude invocation falls back to the phase model/effort routing", () => {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  const args = provider.buildInvocation({ prompt: "hello" });

  // No explicit model: the phase routing decides, exactly as before the seam.
  assertEquals(args.slice(-2), ["-p", "hello"]);
  assertEquals(
    args.slice(0, buildClaudeEffortArgs(undefined).length),
    buildClaudeEffortArgs(undefined),
    "with no model the effort args lead, as the pre-change builder produced",
  );
  assertEquals(args.includes("--dangerously-skip-permissions"), true);
  assertEquals(args.includes("--output-format"), true);
  // An empty disallowed-tools list emits no flag at all.
  assertEquals(args.includes("--disallowed-tools"), false);
});

Deno.test("agent provider - descriptor classifies provider auth failures", () => {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  assertEquals(provider.isAuthError("Error: not logged in"), true);
  assertEquals(provider.isAuthError("compilation failed"), false);
  assert(
    provider.authActionableMessage().length > 0,
    "an auth failure carries an actionable operator message",
  );
});

Deno.test("agent provider - descriptor builds the child environment without worker secrets", () => {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);

  const env = provider.buildChildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-test",
    GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
    SOME_SECRET: "nope",
  });

  assertEquals(env.PATH, "/usr/bin");
  assertEquals(env.ANTHROPIC_API_KEY, "sk-test");
  assertEquals(env.GITHUB_APP_PRIVATE_KEY_PATH, undefined);
  assertEquals(env.SOME_SECRET, undefined);
});

// ---------------------------------------------------------------------------
// Unknown provider ids fail loudly (Issue #3234)
// ---------------------------------------------------------------------------

// "aider" stands in for an unregistered id: Codex (Issue #4106) and Gemini
// (Issue #4107) are both registered now, so neither can play that role here.
Deno.test("agent provider - an unknown provider id fails loudly naming the supported providers", () => {
  const error = assertThrows(
    () => resolveAgentProvider("aider"),
    Error,
    "aider",
  );
  for (const id of agentProviderIds()) {
    assert(
      error.message.includes(id),
      `the failure names the supported provider "${id}"`,
    );
  }
});

Deno.test("agent provider - a blank provider id fails loudly rather than defaulting", () => {
  assertThrows(() => resolveAgentProvider("  "), Error, "supported");
});

// ---------------------------------------------------------------------------
// Selection: configuration first, environment override, Claude by default
// ---------------------------------------------------------------------------

Deno.test("agent provider - selection defaults to Claude", () => {
  assertEquals(
    resolveAgentProviderId({ env: () => undefined }),
    DEFAULT_AGENT_PROVIDER_ID,
  );
  assertEquals(DEFAULT_AGENT_PROVIDER_ID, CLAUDE_PROVIDER_ID);
});

Deno.test("agent provider - configuration selects the provider and the environment overrides it", () => {
  assertEquals(
    resolveAgentProviderId({ configured: "claude", env: () => undefined }),
    "claude",
  );
  assertEquals(
    resolveAgentProviderId({
      configured: "claude",
      env: (name) => name === AGENT_PROVIDER_ENV ? "claude" : undefined,
    }),
    "claude",
  );
});

Deno.test("agent provider - an unsupported configured or environment id fails loudly", () => {
  assertThrows(
    () => resolveAgentProviderId({ configured: "aider", env: () => undefined }),
    Error,
    "aider",
  );
  assertThrows(
    () =>
      resolveAgentProviderId({
        env: (name) => name === AGENT_PROVIDER_ENV ? "gpt" : undefined,
      }),
    Error,
    AGENT_PROVIDER_ENV,
  );
});

// ---------------------------------------------------------------------------
// Which providers the running image installed (Issue #4105)
// ---------------------------------------------------------------------------

/** An environment lookup returning the given image provider stamp. */
function stamped(
  value: string | undefined,
): (name: string) => string | undefined {
  return (name) => name === IMAGE_AGENT_PROVIDERS_ENV ? value : undefined;
}

Deno.test("agent provider - the image stamp reports the installed provider set", () => {
  assertEquals(
    imageAgentProviderIds({ env: stamped("claude,codex,gemini") }),
    ["claude", "codex", "gemini"],
  );
  assertEquals(
    imageAgentProviderIds({ env: stamped(" claude , codex ") }),
    ["claude", "codex"],
  );
});

Deno.test("agent provider - no image stamp means no image set to check against", () => {
  assertEquals(imageAgentProviderIds({ env: stamped(undefined) }), undefined);
  assertEquals(imageAgentProviderIds({ env: stamped("  ") }), undefined);
  // An uncontained worker installs its agent on the host, so the assertion
  // passes rather than blocking every provider.
  assertImageInstalledProvider("codex", { env: stamped(undefined) });
});

Deno.test("agent provider - a malformed image stamp fails loudly", () => {
  assertThrows(
    () => imageAgentProviderIds({ env: stamped("claude,Codex") }),
    Error,
    IMAGE_AGENT_PROVIDERS_ENV,
  );
  assertThrows(
    () => imageAgentProviderIds({ env: stamped("claude,claude") }),
    Error,
    "twice",
  );
});

Deno.test("agent provider - asking for a provider the image lacks fails loudly", () => {
  assertImageInstalledProvider("claude", { env: stamped("claude,codex") });

  assertThrows(
    () => assertImageInstalledProvider("gemini", { env: stamped("claude") }),
    Error,
    "did not install",
  );
  // The message names what the image does carry, so the operator can act.
  assertThrows(
    () => assertImageInstalledProvider("gemini", { env: stamped("claude") }),
    Error,
    "Installed: claude",
  );
});

Deno.test("agent provider - resolving a provider the image lacks fails at resolution", () => {
  // Claude is registered but this image did not install it.
  assertThrows(
    () =>
      resolveAgentProviderId({
        configured: CLAUDE_PROVIDER_ID,
        env: stamped("codex"),
      }),
    Error,
    "did not install",
  );
  assertEquals(
    resolveAgentProviderId({
      configured: CLAUDE_PROVIDER_ID,
      env: stamped("claude,codex"),
    }),
    CLAUDE_PROVIDER_ID,
  );
});

// ---------------------------------------------------------------------------
// The credential material the descriptor declares is what the preflight reads
// ---------------------------------------------------------------------------

Deno.test("agent provider - the preflight passes on the credential layout the descriptor declares", async () => {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const root = await Deno.makeTempDir();
  const dir = `${root}/credentials`;
  try {
    await Deno.mkdir(`${dir}/gh`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/gh/hosts.yml`,
      "github.com:\n  oauth_token: gho_test\n",
    );
    await Deno.chmod(`${dir}/gh/hosts.yml`, 0o600);

    await Deno.mkdir(`${dir}/${provider.credentials.subdir}`, {
      recursive: true,
    });
    const credentialPath =
      `${dir}/${provider.credentials.subdir}/${provider.credentials.file}`;
    await Deno.writeTextFile(
      credentialPath,
      `${provider.credentials.envVars[0]}=sk-test\n`,
    );
    await Deno.chmod(credentialPath, 0o600);

    const result = await checkCredentialPreflight({
      dir,
      env: () => undefined,
      providers: [provider],
    });
    assertEquals(result.ok, true, JSON.stringify(result.failures));
    assertEquals(result.providerSource, "directory");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Provider installation is a per-provider container fragment
// ---------------------------------------------------------------------------

Deno.test("agent provider - every registered provider ships an installation fragment", async () => {
  for (const id of agentProviderIds()) {
    const provider = resolveAgentProvider(id);
    const fragment = await readRepoFile(
      `container/${provider.install.fragment}`,
    );
    assert(
      fragment.includes("sha256sum -c"),
      `${provider.install.fragment} verifies its download against a checksum`,
    );
    assert(
      !/curl[^\n]*\|\s*(ba)?sh/.test(fragment),
      `${provider.install.fragment} never pipes a downloaded script into a shell`,
    );
  }
});

Deno.test("agent provider - the base Containerfile selects the fragment set by build argument", async () => {
  const containerfile = await readRepoFile("container/Containerfile");

  const defaultArg = /^ARG\s+AGENT_PROVIDERS="?([a-z0-9,-]+)"?\s*$/m.exec(
    containerfile,
  );
  assert(defaultArg, "the installed provider set is a build argument");
  assert(
    defaultArg[1]!.split(",").includes(DEFAULT_AGENT_PROVIDER_ID),
    `the image installs the worker's default provider ` +
      `(${DEFAULT_AGENT_PROVIDER_ID}), got "${defaultArg[1]}"`,
  );
  assert(
    containerfile.includes(`${PROVIDER_FRAGMENT_DIR}/`),
    "the build runs the per-provider fragment directory",
  );
  assert(
    containerfile.includes(`ENV ${IMAGE_AGENT_PROVIDERS_ENV}=`),
    "the image stamps the set it installed, so the worker can check it",
  );
});

// ---------------------------------------------------------------------------
// No provider-specific string survives on the generic worker path
// ---------------------------------------------------------------------------

Deno.test("agent provider - the generic worker path names no specific provider", async () => {
  /** Modules that must work for any provider the seam registers. */
  const genericPath = [
    "worker/deno/lib/container_launch.ts",
    "worker/deno/lib/credential_preflight.ts",
    "worker/deno/commands/container_launch_plan.ts",
    "container/Containerfile",
    "container/entrypoint.sh",
    // The set installer runs whichever fragments the build asks for, so it
    // must name no provider either (Issue #4105).
    "container/install-providers.sh",
  ];

  const providerWords = /\b(claude|anthropic|codex|openai|gemini)\b/i;
  // The only permitted mention: the Containerfile's default provider set
  // build argument, which selects fragments rather than installing inline.
  const permitted = /^ARG\s+AGENT_PROVIDERS=/;
  for (const path of genericPath) {
    const source = await readRepoFile(path);
    const offenders = source.split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) =>
        providerWords.test(line) && !permitted.test(line.trim())
      );
    assertEquals(
      offenders.map((o) => `${path}:${o.number}: ${o.line.trim()}`),
      [],
      `${path} must resolve provider specifics through agent_provider.ts`,
    );
  }
});

// ---------------------------------------------------------------------------
// Configuration selects the provider and fails loudly at startup
// ---------------------------------------------------------------------------

Deno.test("agent provider - .config.json selects the provider at load time", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/.config.json`;
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        allowed_authors: ["operator"],
        repos: ["owner/repo"],
        agent_provider: CLAUDE_PROVIDER_ID,
      }),
    );

    const config = await loadConfig(path);
    assertEquals(config.agentProvider, CLAUDE_PROVIDER_ID);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agent provider - an unsupported .config.json provider fails loudly at load time", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/.config.json`;
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        allowed_authors: ["operator"],
        repos: ["owner/repo"],
        agent_provider: "aider",
      }),
    );

    const error = await loadConfig(path).then(
      () => null,
      (e: Error) => e,
    );
    assert(error, "an unsupported provider must not load silently");
    assert(
      error.message.includes("aider") && error.message.includes("claude"),
      `the failure names the rejected and the supported ids: ${error.message}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("agent provider - the default configuration selects Claude", () => {
  assertEquals(buildDefaultWorkerConfig().agentProvider, CLAUDE_PROVIDER_ID);
});

// ---------------------------------------------------------------------------
// Issue #4385 — the prompt travels on stdin, never as one argv element
// ---------------------------------------------------------------------------

Deno.test("agent provider - Claude declares the stdin prompt transport; Codex and Gemini keep argv (Issue #4385)", () => {
  assertEquals(
    resolveAgentProvider(CLAUDE_PROVIDER_ID).promptTransport,
    "stdin",
  );
  assertEquals(resolveAgentProvider(CODEX_PROVIDER_ID).promptTransport, "argv");
  assertEquals(
    resolveAgentProvider(GEMINI_PROVIDER_ID).promptTransport,
    "argv",
  );
});

Deno.test("agent provider - Claude invocation with promptViaStdin ends in a bare -p and carries no prompt text (Issue #4385)", () => {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const prompt = "x".repeat(200_000); // over Linux's 128 KiB MAX_ARG_STRLEN
  const args = provider.buildInvocation({
    prompt,
    systemPrompt: "SYSTEM",
    model: "claude-opus-4-1",
    promptViaStdin: true,
  });
  assertEquals(args.at(-1), "-p");
  assert(
    args.every((a) => a.length < 131_072),
    "no argv element may reach MAX_ARG_STRLEN",
  );
  assert(!args.includes(prompt), "the prompt is not in argv");
  // The system prompt still travels on argv (small, cacheable).
  assertEquals(args.includes("SYSTEM"), true);
});

Deno.test("agent provider - Claude invocation without promptViaStdin is unchanged (Issue #4385)", () => {
  const provider = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const args = provider.buildInvocation({ prompt: "hello" });
  assertEquals(args.slice(-2), ["-p", "hello"]);
});
