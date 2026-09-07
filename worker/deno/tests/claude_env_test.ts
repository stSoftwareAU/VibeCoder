/**
 * Tests for the claude child-environment allow-list (Issue #3203).
 *
 * The `claude` agent subprocess runs unrestricted bash, so it must not inherit
 * the GitHub App private-key material. `buildClaudeChildEnv` strips a denylist
 * of secret-carrying variables while preserving everything else the child
 * needs (notably `GH_TOKEN`).
 *
 * Following TDD: these tests define the expected behaviour first.
 */

import { assertEquals } from "@std/assert";
import { resolveAgentStateDir } from "../lib/agent_state_dir.ts";
import { buildClaudeChildEnv, CLAUDE_ENV_DENYLIST } from "../lib/claude_env.ts";

Deno.test("buildClaudeChildEnv - drops the GitHub App private key path", () => {
  const parent = {
    PATH: "/usr/bin",
    GH_TOKEN: "ghs_installationtoken",
    GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/app.pem",
  };
  const child = buildClaudeChildEnv(parent);
  assertEquals("GITHUB_APP_PRIVATE_KEY_PATH" in child, false);
});

Deno.test("buildClaudeChildEnv - drops the raw GitHub App private key", () => {
  const parent = {
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nabc\n...",
  };
  const child = buildClaudeChildEnv(parent);
  assertEquals("GITHUB_APP_PRIVATE_KEY" in child, false);
});

Deno.test("buildClaudeChildEnv - preserves GH_TOKEN and other non-secret vars", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/worker",
    GH_TOKEN: "ghs_installationtoken",
    GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/app.pem",
  };
  const child = buildClaudeChildEnv(parent);
  assertEquals(child.PATH, "/usr/bin");
  assertEquals(child.HOME, "/home/worker");
  assertEquals(child.GH_TOKEN, "ghs_installationtoken");
});

Deno.test("buildClaudeChildEnv - returns a new object, does not mutate input", () => {
  const parent = { GITHUB_APP_PRIVATE_KEY_PATH: "/secrets/app.pem", A: "1" };
  const child = buildClaudeChildEnv(parent);
  // Parent is untouched.
  assertEquals(parent.GITHUB_APP_PRIVATE_KEY_PATH, "/secrets/app.pem");
  // Child is a distinct object.
  assertEquals(child === (parent as unknown), false);
});

Deno.test("buildClaudeChildEnv - honours a custom denylist", () => {
  const parent = { KEEP: "yes", DROP_ME: "secret" };
  const child = buildClaudeChildEnv(parent, ["DROP_ME"]);
  assertEquals("DROP_ME" in child, false);
  assertEquals(child.KEEP, "yes");
});

Deno.test("buildClaudeChildEnv - empty environment yields empty result", () => {
  assertEquals(buildClaudeChildEnv({}), {});
});

Deno.test("CLAUDE_ENV_DENYLIST - includes the GitHub App private key variables", () => {
  assertEquals(
    CLAUDE_ENV_DENYLIST.includes("GITHUB_APP_PRIVATE_KEY_PATH"),
    true,
  );
  assertEquals(CLAUDE_ENV_DENYLIST.includes("GITHUB_APP_PRIVATE_KEY"), true);
});

Deno.test("buildClaudeChildEnv - strips DEEPSEEK_API_KEY (Issue #412)", () => {
  // DeepSeek runs on this same CLI pointed elsewhere, so the isolation has to
  // run both ways: the Anthropic child has no use for DeepSeek's credential.
  const parent = {
    PATH: "/usr/bin",
    GH_TOKEN: "gho_test",
    ANTHROPIC_API_KEY: "sk-ant",
    DEEPSEEK_API_KEY: "sk-deepseek",
  };
  const child = buildClaudeChildEnv(parent);
  assertEquals(child.DEEPSEEK_API_KEY, undefined);
  assertEquals(child.ANTHROPIC_API_KEY, "sk-ant");
  assertEquals(CLAUDE_ENV_DENYLIST.includes("DEEPSEEK_API_KEY"), true);
});

// ---------------------------------------------------------------------------
// Durable transcripts inside the container (Issue #4170)
// ---------------------------------------------------------------------------

Deno.test("buildClaudeChildEnv - container child gets a durable CLAUDE_CONFIG_DIR on the agent-state volume", () => {
  // Claude's session transcripts (what --resume replays) live under
  // CLAUDE_CONFIG_DIR/projects. Left at the default ~/.claude they die with
  // the ephemeral VM — observed live: 70 minutes of execute-phase work on
  // #4162 unrecoverable after a kill. Pointing the child at the host-mounted
  // work dir makes transcripts durable across container restarts.
  const env = buildClaudeChildEnv({
    HOME: "/home/vibe",
    PATH: "/usr/local/bin",
    WORK_DIR: "/home/vibe/auto-issue-work",
    VIBE_IMAGE_AGENT_PROVIDERS: "claude",
  });
  // Issue #1407: on the agent-state volume, a sibling of the work dir, so
  // tightening the work volume can never lock the agent out of its own
  // configuration. Built through the resolver rather than a second copy of
  // the path, so the two cannot drift.
  assertEquals(
    env["CLAUDE_CONFIG_DIR"],
    `${resolveAgentStateDir("/home/vibe/auto-issue-work")}/claude-config`,
  );
});

Deno.test("buildClaudeChildEnv - an explicit CLAUDE_CONFIG_DIR is never overridden", () => {
  const env = buildClaudeChildEnv({
    HOME: "/home/vibe",
    WORK_DIR: "/home/vibe/auto-issue-work",
    VIBE_IMAGE_AGENT_PROVIDERS: "claude",
    CLAUDE_CONFIG_DIR: "/custom/claude",
  });
  assertEquals(env["CLAUDE_CONFIG_DIR"], "/custom/claude");
});

Deno.test("buildClaudeChildEnv - host children keep the default config dir", () => {
  // On the host ~/.claude is already durable and holds the operator's own
  // login state — redirecting it would break native-mode workers.
  const env = buildClaudeChildEnv({
    HOME: "/Users/operator",
    WORK_DIR: "/Users/operator/auto-issue-work",
  });
  assertEquals(env["CLAUDE_CONFIG_DIR"], undefined);
});

// ---------------------------------------------------------------------------
// A blank container stamp is a HOST run (Issue #1493, follow-up to #1262)
// ---------------------------------------------------------------------------

Deno.test("buildClaudeChildEnv - a blank container stamp leaves CLAUDE_CONFIG_DIR alone (Issue #1493)", () => {
  // The redirect was keyed on the PRESENCE of the image stamp, so
  // `VIBE_IMAGE_AGENT_PROVIDERS=` pointed a HOST run's claude at
  // <work dir>/.claude-config — away from the operator's own ~/.claude and
  // the login state it holds. Blank reads as absent: the default stands.
  for (const blank of ["", "   "]) {
    const env = buildClaudeChildEnv({
      HOME: "/Users/operator",
      PATH: "/usr/local/bin",
      WORK_DIR: "/Users/operator/auto-issue-work",
      VIBE_IMAGE_AGENT_PROVIDERS: blank,
    });
    assertEquals(
      env["CLAUDE_CONFIG_DIR"],
      undefined,
      `a stamp of ${JSON.stringify(blank)} must not redirect a host run`,
    );
  }
});

Deno.test("buildClaudeChildEnv - a real container stamp still redirects (Issue #1493)", () => {
  // The other direction: #4170's durable transcripts must survive the
  // narrowed predicate, whitespace padding included.
  const env = buildClaudeChildEnv({
    HOME: "/home/vibe",
    PATH: "/usr/local/bin",
    WORK_DIR: "/home/vibe/auto-issue-work",
    VIBE_IMAGE_AGENT_PROVIDERS: " claude ",
  });
  // Issue #1407: the redirect target is the agent-state volume beside the
  // work dir, not a directory inside it.
  assertEquals(
    env["CLAUDE_CONFIG_DIR"],
    `${resolveAgentStateDir("/home/vibe/auto-issue-work")}/claude-config`,
  );
});
