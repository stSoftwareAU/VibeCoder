/**
 * Tests for the DeepSeek child-environment policy (Issue #412, parent #396).
 *
 * DeepSeek is carried on the **Claude** CLI pointed at DeepSeek's
 * Anthropic-compatible endpoint, so the default inheritance is exactly the
 * wrong one: the binary reads Anthropic's variables, but the host on the other
 * end is DeepSeek's. The leak this module exists to prevent — a live Anthropic
 * credential travelling to a third-party endpoint on every request — is a
 * failing assertion here, not a code review.
 *
 * Following TDD: these tests define the expected behaviour first.
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildDeepSeekChildEnv,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_ENV_DENYLIST,
  DEEPSEEK_ENV_SECRET_ALLOWLIST,
  isDeniedDeepSeekEnvVar,
} from "../lib/deepseek_env.ts";
import { buildClaudeChildEnv, CLAUDE_ENV_DENYLIST } from "../lib/claude_env.ts";
import { buildCodexChildEnv, CODEX_ENV_DENYLIST } from "../lib/codex_env.ts";
import { buildGeminiChildEnv, GEMINI_ENV_DENYLIST } from "../lib/gemini_env.ts";

/** A parent environment holding every vendor's credential at once. */
function everyVendorParent(): Record<string, string> {
  return {
    PATH: "/usr/bin",
    HOME: "/home/vibe",
    WORK_DIR: "/home/vibe/auto-issue-work",
    GH_TOKEN: "gho_test",
    DEEPSEEK_API_KEY: "sk-deepseek",
    ANTHROPIC_API_KEY: "sk-ant",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    OPENAI_API_KEY: "sk-openai",
    CODEX_API_KEY: "sk-codex",
    GEMINI_API_KEY: "sk-gemini",
    GOOGLE_API_KEY: "sk-google",
    GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
    JENKINS_TOKEN: "jenkins",
    SOME_SECRET: "nope",
  };
}

// ---------------------------------------------------------------------------
// Anthropic's credentials never reach DeepSeek's endpoint
// ---------------------------------------------------------------------------

Deno.test("buildDeepSeekChildEnv - no Anthropic credential survives, whatever the parent holds", () => {
  const env = buildDeepSeekChildEnv(everyVendorParent());

  assertEquals(env.ANTHROPIC_API_KEY, undefined);
  assertEquals(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

Deno.test("buildDeepSeekChildEnv - no other vendor's credential survives either", () => {
  const env = buildDeepSeekChildEnv(everyVendorParent());

  assertEquals(env.OPENAI_API_KEY, undefined);
  assertEquals(env.CODEX_API_KEY, undefined);
  assertEquals(env.GEMINI_API_KEY, undefined);
  assertEquals(env.GOOGLE_API_KEY, undefined);
});

Deno.test("buildDeepSeekChildEnv - the worker-only secrets are absent", () => {
  const env = buildDeepSeekChildEnv(everyVendorParent());

  assertEquals(env.GITHUB_APP_PRIVATE_KEY_PATH, undefined);
  assertEquals(env.JENKINS_TOKEN, undefined);
  assertEquals(env.SOME_SECRET, undefined);
});

Deno.test("buildDeepSeekChildEnv - what the child legitimately needs is kept", () => {
  const env = buildDeepSeekChildEnv(everyVendorParent());

  assertEquals(env.PATH, "/usr/bin");
  assertEquals(env.GH_TOKEN, "gho_test");
  assertEquals(env.DEEPSEEK_API_KEY, "sk-deepseek");
});

Deno.test("DEEPSEEK_ENV_DENYLIST - names the other vendors' credentials rather than relying on shape", () => {
  for (
    const name of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GITHUB_APP_PRIVATE_KEY_PATH",
    ]
  ) {
    assert(
      DEEPSEEK_ENV_DENYLIST.includes(name),
      `${name} must be denied by name, not by convention`,
    );
  }
});

Deno.test("isDeniedDeepSeekEnvVar - denies Anthropic's key and allows DeepSeek's", () => {
  assertEquals(isDeniedDeepSeekEnvVar("ANTHROPIC_API_KEY"), true);
  assertEquals(isDeniedDeepSeekEnvVar("CLAUDE_CODE_OAUTH_TOKEN"), true);
  assertEquals(isDeniedDeepSeekEnvVar("DEEPSEEK_API_KEY"), false);
  // Issue #414: an INHERITED ANTHROPIC_AUTH_TOKEN is Anthropic's own — the
  // preflight exports claude/provider.env into the worker's environment in a
  // claude+deepseek run — so it is denied on the way in and set from
  // DEEPSEEK_API_KEY instead.
  assertEquals(isDeniedDeepSeekEnvVar("ANTHROPIC_AUTH_TOKEN"), true);
  assertEquals(isDeniedDeepSeekEnvVar("PATH"), false);
  // An unknown secret-shaped name is still dropped by the shape rule.
  assertEquals(isDeniedDeepSeekEnvVar("SOME_SECRET"), true);
});

Deno.test("DEEPSEEK_ENV_SECRET_ALLOWLIST - carries only the credentials this child needs", () => {
  assertEquals([...DEEPSEEK_ENV_SECRET_ALLOWLIST].sort(), [
    "DEEPSEEK_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);
});

// ---------------------------------------------------------------------------
// The endpoint is pinned, and an operator's own value wins
// ---------------------------------------------------------------------------

Deno.test("buildDeepSeekChildEnv - pins ANTHROPIC_BASE_URL at DeepSeek's endpoint", () => {
  const env = buildDeepSeekChildEnv(everyVendorParent());
  assertEquals(env.ANTHROPIC_BASE_URL, DEEPSEEK_ANTHROPIC_BASE_URL);
  assertEquals(
    DEEPSEEK_ANTHROPIC_BASE_URL,
    "https://api.deepseek.com/anthropic",
  );
});

Deno.test("buildDeepSeekChildEnv - an operator-set ANTHROPIC_BASE_URL is preserved", () => {
  const parent = everyVendorParent();
  parent.ANTHROPIC_BASE_URL = "https://proxy.internal/anthropic";
  const env = buildDeepSeekChildEnv(parent);
  assertEquals(env.ANTHROPIC_BASE_URL, "https://proxy.internal/anthropic");
});

Deno.test("buildDeepSeekChildEnv - an empty ANTHROPIC_BASE_URL is not an operator choice", () => {
  // An empty value would send DeepSeek's key to Anthropic's default host, so
  // it is treated as unset rather than honoured.
  const env = buildDeepSeekChildEnv({ ANTHROPIC_BASE_URL: "" });
  assertEquals(env.ANTHROPIC_BASE_URL, DEEPSEEK_ANTHROPIC_BASE_URL);
});

// ---------------------------------------------------------------------------
// The DeepSeek key reaches the CLI under the name the CLI reads
// ---------------------------------------------------------------------------

Deno.test("buildDeepSeekChildEnv - DEEPSEEK_API_KEY surfaces as ANTHROPIC_AUTH_TOKEN", () => {
  const env = buildDeepSeekChildEnv(everyVendorParent());
  assertEquals(env.ANTHROPIC_AUTH_TOKEN, "sk-deepseek");
});

Deno.test("buildDeepSeekChildEnv - an inherited ANTHROPIC_AUTH_TOKEN never reaches DeepSeek's endpoint", () => {
  // Issue #414: this test previously asserted an inherited value was left
  // alone. Registering the provider made the leak reachable — in a
  // claude+deepseek run the preflight exports claude/provider.env into the
  // worker's own environment, so the inherited value is *Anthropic's* token
  // and honouring it would send a live first-party credential to
  // api.deepseek.com. It is now denied on the way in and replaced by
  // DeepSeek's own key.
  const parent = everyVendorParent();
  parent.ANTHROPIC_AUTH_TOKEN = "sk-ant-inherited";
  const env = buildDeepSeekChildEnv(parent);
  assertEquals(env.ANTHROPIC_AUTH_TOKEN, "sk-deepseek");
});

Deno.test("buildDeepSeekChildEnv - with no DeepSeek key an inherited Anthropic token is simply dropped", () => {
  const env = buildDeepSeekChildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_AUTH_TOKEN: "sk-ant-inherited",
  });
  assertEquals(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

Deno.test("buildDeepSeekChildEnv - no DEEPSEEK_API_KEY means no invented auth token", () => {
  const env = buildDeepSeekChildEnv({ PATH: "/usr/bin" });
  assertEquals(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

// ---------------------------------------------------------------------------
// No cross-provider session bleed (the two share one binary)
// ---------------------------------------------------------------------------

Deno.test("buildDeepSeekChildEnv - the config dir differs from the Claude child's under the same work dir", () => {
  const parent = {
    HOME: "/home/vibe",
    WORK_DIR: "/home/vibe/auto-issue-work",
    VIBE_IMAGE_AGENT_PROVIDERS: "claude,deepseek",
  };
  const deepseek = buildDeepSeekChildEnv(parent);
  const claude = buildClaudeChildEnv(parent);

  assertEquals(
    deepseek.CLAUDE_CONFIG_DIR,
    "/home/vibe/auto-issue-work/.claude-config-deepseek",
  );
  assert(
    deepseek.CLAUDE_CONFIG_DIR !== claude.CLAUDE_CONFIG_DIR,
    "--resume must not replay a Claude session into a DeepSeek run",
  );
});

Deno.test("buildDeepSeekChildEnv - the config dir is separated on the host too, where Claude keeps the default", () => {
  // On the host the Claude child stays on the operator's ~/.claude, so an
  // unpinned DeepSeek child would land in the very same directory.
  const parent = { HOME: "/Users/operator" };
  const deepseek = buildDeepSeekChildEnv(parent);
  const claude = buildClaudeChildEnv(parent);

  assertEquals(claude.CLAUDE_CONFIG_DIR, undefined);
  assertEquals(
    deepseek.CLAUDE_CONFIG_DIR,
    "/Users/operator/.claude-config-deepseek",
  );
});

Deno.test("buildDeepSeekChildEnv - an explicit CLAUDE_CONFIG_DIR is never overridden", () => {
  const env = buildDeepSeekChildEnv({
    HOME: "/home/vibe",
    WORK_DIR: "/home/vibe/auto-issue-work",
    CLAUDE_CONFIG_DIR: "/custom/deepseek",
  });
  assertEquals(env.CLAUDE_CONFIG_DIR, "/custom/deepseek");
});

Deno.test("buildDeepSeekChildEnv - returns a new object, does not mutate the parent", () => {
  const parent = everyVendorParent();
  const env = buildDeepSeekChildEnv(parent);
  assertEquals(parent.ANTHROPIC_API_KEY, "sk-ant");
  assertEquals("ANTHROPIC_BASE_URL" in parent, false);
  assertEquals(env === (parent as unknown), false);
});

Deno.test("buildDeepSeekChildEnv - honours a custom denylist", () => {
  const env = buildDeepSeekChildEnv({ KEEP: "yes", DROP_ME: "value" }, [
    "DROP_ME",
  ]);
  assertEquals("DROP_ME" in env, false);
  assertEquals(env.KEEP, "yes");
});

// ---------------------------------------------------------------------------
// The reverse direction: DeepSeek's key reaches no other vendor's child
// ---------------------------------------------------------------------------

Deno.test("the Claude, Codex and Gemini children all strip DEEPSEEK_API_KEY", () => {
  const parent = everyVendorParent();
  for (
    const [name, build] of [
      ["claude", buildClaudeChildEnv],
      ["codex", buildCodexChildEnv],
      ["gemini", buildGeminiChildEnv],
    ] as const
  ) {
    const env = build(parent);
    assertEquals(
      env.DEEPSEEK_API_KEY,
      undefined,
      `the ${name} child must not inherit DeepSeek's credential`,
    );
  }
});

Deno.test("the other vendors' denylists name DEEPSEEK_API_KEY rather than relying on shape", () => {
  for (
    const [name, denylist] of [
      ["claude", CLAUDE_ENV_DENYLIST],
      ["codex", CODEX_ENV_DENYLIST],
      ["gemini", GEMINI_ENV_DENYLIST],
    ] as const
  ) {
    assert(
      denylist.includes("DEEPSEEK_API_KEY"),
      `the ${name} denylist must deny DeepSeek's credential by name`,
    );
  }
});
