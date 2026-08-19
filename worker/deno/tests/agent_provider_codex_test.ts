/**
 * Tests for the Codex coding-agent provider (Issue #4106, parent #4102).
 *
 * Codex is the second provider registered through the seam
 * (`worker/deno/lib/agent_provider.ts`), so these tests are as much a test of
 * the seam as of Codex: the descriptor's four facets are populated, the
 * invocation is the non-interactive single-prompt run Codex actually takes,
 * the Anthropic credential never reaches the Codex child (and the OpenAI one
 * never reaches the Claude child), and a Codex authentication failure is
 * classified as a provider-auth failure by the shared preflight.
 *
 * Every test calls the real functions with real data.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  agentProviderIds,
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  PROVIDER_FRAGMENT_DIR,
  resolveAgentProvider,
  resolveAgentProviderId,
} from "../lib/agent_provider.ts";
import {
  classifyCredentialFailure,
  type CredentialFailure,
} from "../lib/credential_preflight.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";

const repoRoot = new URL("../../../", import.meta.url).pathname;

/** The Codex descriptor under test. */
const codex = resolveAgentProvider(CODEX_PROVIDER_ID);

// ---------------------------------------------------------------------------
// The descriptor: all four facets populated
// ---------------------------------------------------------------------------

Deno.test("codex provider - the descriptor populates binary, credentials, environment and invocation", () => {
  assertEquals(codex.id, "codex");
  assertEquals(codex.binary, "codex");
  assert(codex.displayName.length > 0, "the descriptor names the provider");

  assertEquals(codex.credentials.subdir, "codex");
  assertEquals(codex.credentials.file, "provider.env");
  assert(
    codex.credentials.envVars.includes("OPENAI_API_KEY"),
    "the descriptor names the OpenAI credential variable",
  );
  assert(
    codex.credentials.envVars.includes("CODEX_API_KEY"),
    "the descriptor names the Codex-specific credential variable",
  );
  assert(
    codex.credentials.provisionEnvVar.startsWith("VIBE_LAUNCHAGENT_"),
    "the descriptor names the setup.sh provisioning variable",
  );

  assert(codex.environment.secretAllowlist.includes("OPENAI_API_KEY"));
  assert(codex.environment.denylist.length > 0);
  assertEquals(codex.install.fragment, `${PROVIDER_FRAGMENT_DIR}/codex.sh`);
  assert(codex.buildInvocation({ prompt: "x" }).length > 0);
});

Deno.test("codex provider - it is selectable by id, alongside Claude", () => {
  assert(agentProviderIds().includes(CODEX_PROVIDER_ID));
  assertEquals(
    resolveAgentProviderId({
      configured: CODEX_PROVIDER_ID,
      env: () => undefined,
    }),
    CODEX_PROVIDER_ID,
  );
});

// ---------------------------------------------------------------------------
// The invocation: one non-interactive prompt, machine-readable output
// ---------------------------------------------------------------------------

Deno.test("codex provider - the invocation is a non-interactive single-prompt run with JSON output", () => {
  const args = codex.buildInvocation({
    prompt: "PROMPT",
    model: "gpt-5-codex",
    effort: "high",
  });

  assertEquals(args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "gpt-5-codex",
    "-c",
    'model_reasoning_effort="high"',
    "PROMPT",
  ]);
});

Deno.test("codex provider - with no model or effort the CLI keeps its configured defaults", () => {
  const args = codex.buildInvocation({ prompt: "hello" });

  assertEquals(args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "hello",
  ]);
});

Deno.test("codex provider - the system prompt reaches Codex, which has no --system-prompt flag", () => {
  const guidance = "You run unattended inside a sandboxed container.";
  const args = codex.buildInvocation({
    prompt: "Fix issue #1",
    systemPrompt: guidance,
  });

  // The prompt is the last argument and carries the guidance: the seam must
  // not drop the static guidance (Issue #4070) just because Codex takes no
  // separate system-prompt argument.
  const prompt = args.at(-1)!;
  assertStringIncludes(prompt, guidance);
  assertStringIncludes(prompt, "Fix issue #1");
  assertEquals(
    args.includes("--system-prompt"),
    false,
    "Codex has no --system-prompt flag; passing one would fail the run",
  );
});

Deno.test("codex provider - a disallowed-tools list is carried into the prompt, not dropped", () => {
  const args = codex.buildInvocation({
    prompt: "Fix issue #1",
    disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
  });

  const prompt = args.at(-1)!;
  assertStringIncludes(prompt, "EnterPlanMode");
  assertStringIncludes(prompt, "ExitPlanMode");
});

Deno.test("codex provider - a later phase resumes the previous session", () => {
  const first = codex.buildInvocation({
    prompt: "phase one",
    sessionResumeState: { sessionId: "owner-repo-42-7", phaseCount: 0 },
  });
  assertEquals(first[0], "exec");
  assertEquals(
    first.includes("resume"),
    false,
    "the first phase starts a session rather than resuming one",
  );

  const later = codex.buildInvocation({
    prompt: "phase two",
    sessionResumeState: { sessionId: "owner-repo-42-7", phaseCount: 1 },
  });
  assertEquals(later.slice(0, 3), ["exec", "resume", "--last"]);
  assertEquals(later.at(-1), "phase two");
});

// ---------------------------------------------------------------------------
// Cross-vendor credentials never cross (the denylist enforces it)
// ---------------------------------------------------------------------------

Deno.test("codex provider - the Codex child environment contains no Anthropic credential", () => {
  const env = codex.buildChildEnv({
    PATH: "/usr/bin",
    OPENAI_API_KEY: "sk-openai",
    CODEX_API_KEY: "sk-codex",
    GH_TOKEN: "gho_test",
    ANTHROPIC_API_KEY: "sk-ant",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-auth",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
    SOME_SECRET: "nope",
  });

  assertEquals(env.PATH, "/usr/bin");
  assertEquals(env.OPENAI_API_KEY, "sk-openai");
  assertEquals(env.CODEX_API_KEY, "sk-codex");
  assertEquals(env.GH_TOKEN, "gho_test");

  assertEquals(env.ANTHROPIC_API_KEY, undefined);
  assertEquals(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assertEquals(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assertEquals(env.GITHUB_APP_PRIVATE_KEY_PATH, undefined);
  assertEquals(env.SOME_SECRET, undefined);
});

Deno.test("codex provider - the denylist names the Anthropic credentials rather than relying on shape", () => {
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    assert(
      codex.environment.denylist.includes(name),
      `${name} must be denied by name, not by convention`,
    );
  }
});

Deno.test("codex provider - and the Claude child gets no OpenAI credential either", () => {
  const claude = resolveAgentProvider(CLAUDE_PROVIDER_ID);
  const env = claude.buildChildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-openai",
    CODEX_API_KEY: "sk-codex",
  });

  assertEquals(env.ANTHROPIC_API_KEY, "sk-ant");
  assertEquals(env.OPENAI_API_KEY, undefined);
  assertEquals(env.CODEX_API_KEY, undefined);
  for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY"]) {
    assert(
      claude.environment.denylist.includes(name),
      `${name} must be denied by name from the Claude child`,
    );
  }
});

// ---------------------------------------------------------------------------
// Authentication failures are classified and actionable
// ---------------------------------------------------------------------------

Deno.test("codex provider - Codex authentication failures are recognised", () => {
  assertEquals(
    codex.isAuthError("stream error: 401 Unauthorized"),
    true,
  );
  assertEquals(
    codex.isAuthError("Missing OPENAI_API_KEY — run `codex login`"),
    true,
  );
  assertEquals(codex.isAuthError("error: cargo build failed"), false);
});

Deno.test("codex provider - the auth message names the credential to set", () => {
  const message = codex.authActionableMessage();
  assertStringIncludes(message, "OPENAI_API_KEY");
  assertStringIncludes(message, "Codex");
});

Deno.test("codex provider - a missing Codex credential is classified as a provider-auth failure", () => {
  const failure: CredentialFailure = {
    code: "provider-credentials-missing",
    path: "/creds/codex/provider.env",
    message:
      "Coding-agent provider authentication required: /creds/codex/provider.env " +
      "holds no Codex CLI credential and none of OPENAI_API_KEY/CODEX_API_KEY is set.",
  };

  assertEquals(classifyCredentialFailure(failure, codex), "provider-auth");
});

// ---------------------------------------------------------------------------
// The install fragment and its pin
// ---------------------------------------------------------------------------

Deno.test("codex provider - the fragment is pinned in container/tools.json", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(`${repoRoot}container/tools.json`),
  );
  const pin = manifest.providers.find((p) => p.id === CODEX_PROVIDER_ID);

  assert(pin, "container/tools.json pins the codex provider");
  assertEquals(pin.binary, codex.binary);
  assertEquals(pin.fragment, codex.install.fragment);
  assert(
    /^\d+\.\d+\.\d+$/.test(pin.version),
    `the pin is an exact version, got "${pin.version}"`,
  );
  for (const arch of ["amd64", "arm64"]) {
    assert(
      /^[0-9a-f]{64}$/.test(pin.sha256[arch] ?? ""),
      `the pin carries a ${arch} SHA-256`,
    );
  }
});

Deno.test("codex provider - the fragment verifies its download and reads its pins from the manifest", async () => {
  const fragment = await Deno.readTextFile(
    `${repoRoot}container/${codex.install.fragment}`,
  );

  assertStringIncludes(fragment, "sha256sum -c");
  assertStringIncludes(fragment, "jq -er");
  assertEquals(
    /curl[^\n]*\|\s*(ba)?sh/.test(fragment),
    false,
    "nothing is piped into a shell",
  );
  assertEquals(
    /\$\{?version\}?/.test(fragment),
    true,
    "the download URL is built from the manifest's pinned version",
  );
  assertEquals(
    /https:[^\n"']*latest/.test(fragment),
    false,
    "no floating 'latest' URL is resolved",
  );
});

Deno.test("codex provider - the fragment aborts when the manifest is missing", async () => {
  const result = await new Deno.Command("bash", {
    args: [`${repoRoot}container/${codex.install.fragment}`],
    env: { AGENT_PROVIDER_MANIFEST: "/nonexistent/tools.json" },
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();

  assert(result.code !== 0, "a missing manifest must abort the build");
  assertStringIncludes(new TextDecoder().decode(result.stderr), "Manifest");
});

Deno.test("codex provider - the fragment aborts when the provider is not pinned", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-codex-pin-" });
  try {
    const manifest = `${dir}/tools.json`;
    await Deno.writeTextFile(
      manifest,
      JSON.stringify({ providers: [{ id: "claude", version: "1.0.0" }] }),
    );

    const result = await new Deno.Command("bash", {
      args: [`${repoRoot}container/${codex.install.fragment}`],
      env: { AGENT_PROVIDER_MANIFEST: manifest },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    assert(result.code !== 0, "an unpinned provider must abort the build");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
