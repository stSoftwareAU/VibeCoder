/**
 * Codex subscription-authentication billing guard (Issue #1924).
 *
 * A persisted ChatGPT login is represented by CODEX_HOME. Once that state is
 * selected, API-key variables must not reach the child: if subscription auth
 * expires or is revoked the run must fail closed rather than incur metered
 * API charges. The pre-existing explicit API-key path remains intact when no
 * CODEX_HOME is selected.
 */

import { assertEquals } from "@std/assert";
import { buildIsolatedCodexChildEnv } from "../lib/codex_env.ts";

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
