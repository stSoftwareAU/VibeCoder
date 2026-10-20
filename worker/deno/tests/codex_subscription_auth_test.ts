/**
 * Codex subscription-authentication billing guard (Issue #1924).
 *
 * A persisted ChatGPT login is represented by CODEX_HOME. Once that state is
 * selected, API-key variables must not reach the child: if subscription auth
 * expires or is revoked the run must fail closed rather than incur metered
 * API charges. The pre-existing explicit API-key path remains intact when no
 * CODEX_HOME is selected.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { resolveAgentProvider } from "../lib/agent_provider.ts";
import {
  initialiseCodexHome,
  resolveCodexAuthMode,
} from "../lib/codex_auth_mode.ts";
import { buildIsolatedCodexChildEnv } from "../lib/codex_env.ts";
import { checkWorkerCredentials } from "../lib/run_worker.ts";

Deno.test("Codex subscription auth - CODEX_HOME is separate from provisioned API credentials", () => {
  const codex = resolveAgentProvider("codex");
  assertEquals(codex.credentials.envVars, ["OPENAI_API_KEY", "CODEX_API_KEY"]);
});

Deno.test("Codex subscription auth - CODEX_HOME is not misclassified as an API key", async () => {
  const home = await Deno.makeTempDir({ prefix: "codex-subscription-auth-" });
  try {
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "test-access", refresh_token: "test-refresh" },
      }),
    );
    const result = resolveCodexAuthMode(
      home,
      (name) => name === "CODEX_HOME" ? home : undefined,
    );
    assertEquals(result.mode, "chatgpt");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("Codex subscription auth - CODEX_HOME suppresses every API-key fallback", () => {
  const parent = {
    PATH: "/usr/bin",
    GH_TOKEN: "github-token",
    OPENAI_API_KEY: "parent-openai-key",
    CODEX_API_KEY: "parent-codex-key",
    CODEX_HOME: "/wrong/home",
    ANTHROPIC_API_KEY: "claude-secret",
  };

  const child = buildIsolatedCodexChildEnv(parent, {
    codexHome: "/state/codex",
    openaiApiKey: "selected-openai-key",
    codexApiKey: "selected-codex-key",
  });

  assertEquals(child.CODEX_HOME, "/state/codex");
  assertEquals(child.OPENAI_API_KEY, undefined);
  assertEquals(child.CODEX_API_KEY, undefined);
  assertEquals(child.ANTHROPIC_API_KEY, undefined);
  assertEquals(child.PATH, "/usr/bin");
  assertEquals(child.GH_TOKEN, "github-token");
});

Deno.test("Codex subscription auth - blank CODEX_HOME does not mask an explicit legacy API key", () => {
  const child = buildIsolatedCodexChildEnv(
    { PATH: "/usr/bin" },
    {
      codexHome: "   ",
      openaiApiKey: "explicit-api-key",
    },
  );

  assertEquals(child.CODEX_HOME, undefined);
  assertEquals(child.OPENAI_API_KEY, "explicit-api-key");
  assertEquals(child.PATH, "/usr/bin");
});

Deno.test("Codex subscription auth - persisted state survives a fresh child environment", () => {
  const selected = { codexHome: "/persistent/agent-state/codex" };

  const first = buildIsolatedCodexChildEnv(
    { PATH: "/usr/bin", OPENAI_API_KEY: "must-not-leak" },
    selected,
  );
  const afterRestart = buildIsolatedCodexChildEnv(
    { PATH: "/usr/bin", CODEX_API_KEY: "must-not-leak-either" },
    selected,
  );

  assertEquals(first.CODEX_HOME, selected.codexHome);
  assertEquals(afterRestart.CODEX_HOME, selected.codexHome);
  assertEquals(first.OPENAI_API_KEY, undefined);
  assertEquals(afterRestart.CODEX_API_KEY, undefined);
});

Deno.test("Codex subscription auth - startup seeds a persistent home and preserves refreshed state", async () => {
  const root = await Deno.makeTempDir({ prefix: "codex-startup-" });
  const dir = `${root}/credentials`;
  const home = `${root}/home`;
  const env: Record<string, string> = { GH_TOKEN: "test-github" };
  try {
    await Deno.mkdir(`${dir}/codex`, { recursive: true, mode: 0o700 });
    await Deno.chmod(dir, 0o700);
    await Deno.writeTextFile(
      `${dir}/codex/provider.env`,
      `CODEX_HOME=${home}\n`,
      { mode: 0o600 },
    );
    const seed = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "test-seed" },
    });
    await Deno.writeTextFile(`${dir}/codex/auth.json`, seed, { mode: 0o600 });
    const options = {
      dir,
      providers: [resolveAgentProvider("codex")],
      env: (name: string) => env[name],
      setEnv: (name: string, value: string) => {
        env[name] = value;
      },
    };
    assertEquals(await checkWorkerCredentials(options), null);
    const child = resolveAgentProvider("codex").buildChildEnv(env);
    assertEquals(child.CODEX_HOME, home);
    assertEquals(child.OPENAI_API_KEY, undefined);
    assertEquals(child.CODEX_API_KEY, undefined);
    assertEquals(await Deno.readTextFile(`${home}/auth.json`), seed);
    const refreshed = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "test-refreshed" },
    });
    await Deno.writeTextFile(`${home}/auth.json`, refreshed);
    assertEquals(await checkWorkerCredentials(options), null);
    assertEquals(await Deno.readTextFile(`${home}/auth.json`), refreshed);
    for (const provider of ["claude", "gemini", "deepseek"]) {
      assertEquals(
        resolveAgentProvider(provider).buildChildEnv(env).CODEX_HOME,
        undefined,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Codex subscription auth - a missing, metered or public seed cannot initialise a subscription", async () => {
  const root = await Deno.makeTempDir({ prefix: "codex-bad-seed-" });
  const env = (name: string) =>
    name === "CODEX_HOME" ? `${root}/home` : undefined;
  try {
    await assertRejects(
      () => initialiseCodexHome(root, env),
      Error,
      "subscription login missing",
    );
    await Deno.writeTextFile(
      `${root}/auth.json`,
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "test-key" }),
      { mode: 0o600 },
    );
    await assertRejects(
      () => initialiseCodexHome(root, env),
      Error,
      "subscription login missing",
    );
    await Deno.writeTextFile(
      `${root}/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt", tokens: {} }),
    );
    if (Deno.build.os !== "windows") {
      await Deno.chmod(`${root}/auth.json`, 0o644);
      await assertRejects(
        () => initialiseCodexHome(root, env),
        Error,
        "owner-only",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
