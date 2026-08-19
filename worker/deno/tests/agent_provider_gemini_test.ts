/**
 * Tests for the Gemini coding-agent provider (Issue #4107, parent #4102).
 *
 * Gemini is the third provider registered through the seam
 * (`worker/deno/lib/agent_provider.ts`) and, in Quorum mode, the judge rather
 * than a planner — so these tests hold the line the judging role depends on:
 * the invocation asks for machine-readable output, no other vendor's
 * credential reaches the Gemini child, and a Gemini authentication failure is
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
  GEMINI_PROVIDER_ID,
  PROVIDER_FRAGMENT_DIR,
  resolveAgentProvider,
  resolveAgentProviderId,
} from "../lib/agent_provider.ts";
import {
  classifyCredentialFailure,
  type CredentialFailure,
} from "../lib/credential_preflight.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { CONTAINER_IMAGE_INPUTS } from "../lib/container_image_hash.ts";

const repoRoot = new URL("../../../", import.meta.url).pathname;

/** The Gemini descriptor under test. */
const gemini = resolveAgentProvider(GEMINI_PROVIDER_ID);

// ---------------------------------------------------------------------------
// The descriptor: all four facets populated
// ---------------------------------------------------------------------------

Deno.test("gemini provider - the descriptor populates binary, credentials, environment and invocation", () => {
  assertEquals(gemini.id, "gemini");
  assertEquals(gemini.binary, "gemini");
  assert(gemini.displayName.length > 0, "the descriptor names the provider");

  assertEquals(gemini.credentials.subdir, "gemini");
  assertEquals(gemini.credentials.file, "provider.env");
  assert(
    gemini.credentials.envVars.includes("GEMINI_API_KEY"),
    "the descriptor names the Gemini credential variable",
  );
  assert(
    gemini.credentials.envVars.includes("GOOGLE_API_KEY"),
    "the descriptor names the Google credential variable",
  );
  assert(
    gemini.credentials.provisionEnvVar.startsWith("VIBE_LAUNCHAGENT_"),
    "the descriptor names the setup.sh provisioning variable",
  );

  assert(gemini.environment.secretAllowlist.includes("GEMINI_API_KEY"));
  assert(gemini.environment.denylist.length > 0);
  assertEquals(gemini.install.fragment, `${PROVIDER_FRAGMENT_DIR}/gemini.sh`);
  assert(gemini.buildInvocation({ prompt: "x" }).length > 0);
});

Deno.test("gemini provider - it is selectable by id, alongside Claude and Codex", () => {
  assert(agentProviderIds().includes(GEMINI_PROVIDER_ID));
  assertEquals(
    resolveAgentProviderId({
      configured: GEMINI_PROVIDER_ID,
      env: () => undefined,
    }),
    GEMINI_PROVIDER_ID,
  );
});

// ---------------------------------------------------------------------------
// The invocation: one non-interactive prompt, machine-readable output
// ---------------------------------------------------------------------------

Deno.test("gemini provider - the invocation is a non-interactive single-prompt run with structured output", () => {
  const args = gemini.buildInvocation({
    prompt: "PROMPT",
    model: "gemini-3-pro",
  });

  assertEquals(args, [
    "--output-format",
    "stream-json",
    "--approval-mode",
    "yolo",
    "--skip-trust",
    "--model",
    "gemini-3-pro",
    "--prompt",
    "PROMPT",
  ]);
});

Deno.test("gemini provider - the judge's verdict is machine-readable, not scraped prose", () => {
  const args = gemini.buildInvocation({ prompt: "Pick the better plan" });
  const format = args[args.indexOf("--output-format") + 1] ?? "";

  assert(
    ["json", "stream-json"].includes(format),
    `the invocation must request a structured output mode, got "${format}"`,
  );
  // The prompt is the last argument, so the verdict text never has to be
  // recovered from an interactive terminal rendering.
  assertEquals(args.at(-2), "--prompt");
  assertEquals(args.at(-1), "Pick the better plan");
});

Deno.test("gemini provider - with no model the CLI keeps its configured default", () => {
  const args = gemini.buildInvocation({ prompt: "hello" });

  assertEquals(args, [
    "--output-format",
    "stream-json",
    "--approval-mode",
    "yolo",
    "--skip-trust",
    "--prompt",
    "hello",
  ]);
});

Deno.test("gemini provider - a reasoning effort is not mapped to a flag the CLI does not have", () => {
  const withEffort = gemini.buildInvocation({
    prompt: "hello",
    effort: "high",
  });
  const withoutEffort = gemini.buildInvocation({ prompt: "hello" });

  // The Gemini CLI exposes no reasoning-effort option; inventing one would
  // fail the run outright, so the argument list is unchanged.
  assertEquals(withEffort, withoutEffort);
});

Deno.test("gemini provider - the system prompt reaches Gemini, which has no --system-prompt flag", () => {
  const guidance = "You run unattended inside a sandboxed container.";
  const args = gemini.buildInvocation({
    prompt: "Judge these two plans",
    systemPrompt: guidance,
  });

  // The sandboxed-environment guidance (Issue #4070) must reach this provider
  // too, so it is composed into the single prompt rather than dropped.
  const prompt = args.at(-1)!;
  assertStringIncludes(prompt, guidance);
  assertStringIncludes(prompt, "Judge these two plans");
  assertEquals(
    args.includes("--system-prompt"),
    false,
    "Gemini has no --system-prompt flag; passing one would fail the run",
  );
});

Deno.test("gemini provider - a disallowed-tools list is carried into the prompt, not dropped", () => {
  const args = gemini.buildInvocation({
    prompt: "Judge these two plans",
    disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
  });

  const prompt = args.at(-1)!;
  assertStringIncludes(prompt, "EnterPlanMode");
  assertStringIncludes(prompt, "ExitPlanMode");
});

Deno.test("gemini provider - a later phase resumes the previous session", () => {
  const first = gemini.buildInvocation({
    prompt: "phase one",
    sessionResumeState: { sessionId: "owner-repo-42-7", phaseCount: 0 },
  });
  assertEquals(
    first.includes("--resume"),
    false,
    "the first phase starts a session rather than resuming one",
  );

  const later = gemini.buildInvocation({
    prompt: "phase two",
    sessionResumeState: { sessionId: "owner-repo-42-7", phaseCount: 1 },
  });
  assertEquals(later.slice(-4), [
    "--resume",
    "latest",
    "--prompt",
    "phase two",
  ]);
});

// ---------------------------------------------------------------------------
// Cross-vendor credentials never cross (the denylist enforces it)
// ---------------------------------------------------------------------------

Deno.test("gemini provider - the Gemini child environment carries no Anthropic or OpenAI credential", () => {
  const env = gemini.buildChildEnv({
    PATH: "/usr/bin",
    GEMINI_API_KEY: "sk-gemini",
    GOOGLE_API_KEY: "sk-google",
    GH_TOKEN: "gho_test",
    ANTHROPIC_API_KEY: "sk-ant",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-auth",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    OPENAI_API_KEY: "sk-openai",
    CODEX_API_KEY: "sk-codex",
    GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
    SOME_SECRET: "nope",
  });

  assertEquals(env.PATH, "/usr/bin");
  assertEquals(env.GEMINI_API_KEY, "sk-gemini");
  assertEquals(env.GOOGLE_API_KEY, "sk-google");
  assertEquals(env.GH_TOKEN, "gho_test");

  assertEquals(env.ANTHROPIC_API_KEY, undefined);
  assertEquals(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assertEquals(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assertEquals(env.OPENAI_API_KEY, undefined);
  assertEquals(env.CODEX_API_KEY, undefined);
  assertEquals(env.GITHUB_APP_PRIVATE_KEY_PATH, undefined);
  assertEquals(env.SOME_SECRET, undefined);
});

Deno.test("gemini provider - the denylist names the other vendors' credentials rather than relying on shape", () => {
  for (
    const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
    ]
  ) {
    assert(
      gemini.environment.denylist.includes(name),
      `${name} must be denied by name, not by convention`,
    );
  }
});

Deno.test("gemini provider - and neither the Claude nor the Codex child gets a Google credential", () => {
  const parent = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-openai",
    GEMINI_API_KEY: "sk-gemini",
    GOOGLE_API_KEY: "sk-google",
  };

  for (const id of [CLAUDE_PROVIDER_ID, CODEX_PROVIDER_ID]) {
    const provider = resolveAgentProvider(id);
    const env = provider.buildChildEnv(parent);
    assertEquals(env.GEMINI_API_KEY, undefined, `${id} child`);
    assertEquals(env.GOOGLE_API_KEY, undefined, `${id} child`);
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
      assert(
        provider.environment.denylist.includes(name),
        `${name} must be denied by name from the ${id} child`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Authentication failures are classified and actionable
// ---------------------------------------------------------------------------

Deno.test("gemini provider - Gemini authentication failures are recognised", () => {
  assertEquals(gemini.isAuthError("Error: 401 Unauthorized"), true);
  assertEquals(
    gemini.isAuthError("API key not valid. Please pass a valid API key."),
    true,
  );
  assertEquals(
    gemini.isAuthError("Please set GEMINI_API_KEY to authenticate"),
    true,
  );
  assertEquals(gemini.isAuthError("error: cargo build failed"), false);
});

Deno.test("gemini provider - the auth message names the credential to set", () => {
  const message = gemini.authActionableMessage();
  assertStringIncludes(message, "GEMINI_API_KEY");
  assertStringIncludes(message, "Gemini");
});

Deno.test("gemini provider - a missing Gemini credential is classified as a provider-auth failure", () => {
  const failure: CredentialFailure = {
    code: "provider-credentials-missing",
    path: "/creds/gemini/provider.env",
    message:
      "Coding-agent provider authentication required: /creds/gemini/provider.env " +
      "holds no Gemini CLI credential and none of GEMINI_API_KEY/GOOGLE_API_KEY is set.",
  };

  assertEquals(classifyCredentialFailure(failure, gemini), "provider-auth");
});

// ---------------------------------------------------------------------------
// The install fragment and its pin
// ---------------------------------------------------------------------------

Deno.test("gemini provider - the fragment is pinned in container/tools.json", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(`${repoRoot}container/tools.json`),
  );
  const pin = manifest.providers.find((p) => p.id === GEMINI_PROVIDER_ID);

  assert(pin, "container/tools.json pins the gemini provider");
  assertEquals(pin.binary, gemini.binary);
  assertEquals(pin.fragment, gemini.install.fragment);
  assert(
    /^\d+\.\d+\.\d+$/.test(pin.version),
    `the pin is an exact version, got "${pin.version}"`,
  );
  // The Gemini CLI ships as a pure-JavaScript bundle, so one checksum covers
  // every architecture — but it is pinned, and it is a real SHA-256.
  const digests = Object.values(pin.sha256);
  assert(digests.length > 0, "the pin carries at least one checksum");
  for (const digest of digests) {
    assert(/^[0-9a-f]{64}$/.test(digest), `not a SHA-256: ${digest}`);
  }
});

Deno.test("gemini provider - the fragment is an enumerated container-image input", () => {
  assert(
    CONTAINER_IMAGE_INPUTS.includes(`container/${gemini.install.fragment}`),
    "the fragment must change the image tag when it changes (Issue #4062)",
  );
});

Deno.test("gemini provider - the fragment verifies its download and reads its pins from the manifest", async () => {
  const fragment = await Deno.readTextFile(
    `${repoRoot}container/${gemini.install.fragment}`,
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

Deno.test("gemini provider - the fragment aborts when the manifest is missing", async () => {
  const result = await new Deno.Command("bash", {
    args: [`${repoRoot}container/${gemini.install.fragment}`],
    env: { AGENT_PROVIDER_MANIFEST: "/nonexistent/tools.json" },
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();

  assert(result.code !== 0, "a missing manifest must abort the build");
  assertStringIncludes(new TextDecoder().decode(result.stderr), "Manifest");
});

Deno.test("gemini provider - the fragment aborts when the provider is not pinned", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-gemini-pin-" });
  try {
    const manifest = `${dir}/tools.json`;
    await Deno.writeTextFile(
      manifest,
      JSON.stringify({ providers: [{ id: "claude", version: "1.0.0" }] }),
    );

    const result = await new Deno.Command("bash", {
      args: [`${repoRoot}container/${gemini.install.fragment}`],
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

Deno.test("gemini provider - the fragment aborts when the pin carries no checksum", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-gemini-sha-" });
  try {
    const manifest = `${dir}/tools.json`;
    await Deno.writeTextFile(
      manifest,
      JSON.stringify({
        providers: [{
          id: "gemini",
          binary: "gemini",
          fragment: "providers/gemini.sh",
          version: "0.0.1",
        }],
      }),
    );

    const result = await new Deno.Command("bash", {
      args: [`${repoRoot}container/${gemini.install.fragment}`],
      env: { AGENT_PROVIDER_MANIFEST: manifest },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();

    // Nothing is downloaded before the checksum is known, so an unverifiable
    // pin stops the build rather than installing unverified bytes.
    assert(result.code !== 0, "a pin with no checksum must abort the build");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
