/**
 * Tests for the descriptor-declared billing capability (Issue #1923).
 *
 * The umbrella policy is fixed-price subscriptions only, so "is this
 * provider's credential a subscription or metered spend?" must be one
 * question every routing path can ask — not a Claude/Codex conditional
 * repeated per call site. These tests call the real classifier against the
 * real descriptors; no credential value is ever supplied or asserted on.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  classifyProviderBilling,
  isFixedPriceSubscription,
} from "../lib/provider_billing.ts";
import { agentProviderIds } from "../lib/agent_provider.ts";

/** An {@link EnvLookup} over a plain record — no process state is read. */
function envOf(
  values: Record<string, string>,
): (name: string) => undefined | string {
  return (name: string) => values[name];
}

Deno.test("classifyProviderBilling - every registered provider declares a billing capability (Issue #1923)", () => {
  // The generic contract: no provider may be silent about how it bills, or
  // the classifier degrades to "unknown" for a vendor that simply forgot to
  // declare. An unknown here is a missing declaration, not a missing
  // credential.
  for (const id of agentProviderIds()) {
    const evidence = classifyProviderBilling(id, {
      workDir: "/tmp/vibe-billing-test",
      env: envOf({}),
    });
    assertEquals(evidence.provider, id);
    assertEquals(evidence.billingMode, "unknown");
    assertEquals(evidence.reason, "subscription-credential-missing");
  }
});

Deno.test("classifyProviderBilling - a Claude OAuth token is a fixed-price subscription (Issue #1923)", () => {
  const evidence = classifyProviderBilling("claude", {
    workDir: "/tmp/vibe-billing-test",
    env: envOf({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-subscription" }),
  });
  assertEquals(evidence.billingMode, "fixed-subscription");
  assertEquals(evidence.reason, "CLAUDE_CODE_OAUTH_TOKEN");
  assertEquals(isFixedPriceSubscription(evidence), true);
});

Deno.test("classifyProviderBilling - ANTHROPIC_API_KEY is metered (Issue #1923)", () => {
  const evidence = classifyProviderBilling("claude", {
    workDir: "/tmp/vibe-billing-test",
    env: envOf({ ANTHROPIC_API_KEY: "sk-ant-metered" }),
  });
  assertEquals(evidence.billingMode, "metered");
  assertEquals(evidence.reason, "ANTHROPIC_API_KEY");
  assertEquals(isFixedPriceSubscription(evidence), false);
});

Deno.test("classifyProviderBilling - a subscription token beats a metered key on the same host (Issue #1923)", () => {
  // The child-environment guard withholds the metered key in this exact
  // case, so the classification must agree with what the child will hold.
  const evidence = classifyProviderBilling("claude", {
    workDir: "/tmp/vibe-billing-test",
    env: envOf({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-subscription",
      ANTHROPIC_API_KEY: "sk-ant-metered",
    }),
  });
  assertEquals(evidence.billingMode, "fixed-subscription");
});

Deno.test("classifyProviderBilling - a blank credential proves nothing (Issue #1923)", () => {
  // Read by value, not by key: an exported-but-empty variable is not a
  // credential, and must not be reported as one.
  const evidence = classifyProviderBilling("claude", {
    workDir: "/tmp/vibe-billing-test",
    env: envOf({ CLAUDE_CODE_OAUTH_TOKEN: "  ", ANTHROPIC_API_KEY: "" }),
  });
  assertEquals(evidence.billingMode, "unknown");
});

Deno.test("classifyProviderBilling - OPENAI_API_KEY makes Codex metered (Issue #1923)", () => {
  const evidence = classifyProviderBilling("codex", {
    workDir: "/tmp/vibe-billing-test",
    env: envOf({ OPENAI_API_KEY: "sk-openai-metered" }),
  });
  assertEquals(evidence.billingMode, "metered");
  assertEquals(isFixedPriceSubscription(evidence), false);
});

Deno.test("classifyProviderBilling - a persisted ChatGPT login is a fixed-price subscription (Issue #1923)", async () => {
  // Codex proves its subscription outside the environment, in the auth state
  // its CLI persists. The descriptor hook is what lets the shared classifier
  // see that without a `case "codex"` of its own.
  const home = await Deno.makeTempDir({ prefix: "vibe-codex-home-" });
  try {
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x" } }),
    );
    const evidence = classifyProviderBilling("codex", {
      workDir: "/tmp/vibe-billing-test",
      env: envOf({ CODEX_HOME: home }),
    });
    assertEquals(evidence.billingMode, "fixed-subscription");
    assertEquals(isFixedPriceSubscription(evidence), true);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("classifyProviderBilling - an API key beside a ChatGPT login still bills metered (Issue #1923)", async () => {
  // The Codex CLI gives the environment key precedence, so the classifier
  // must not report the subscription the run will not actually use.
  const home = await Deno.makeTempDir({ prefix: "vibe-codex-home-" });
  try {
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x" } }),
    );
    const evidence = classifyProviderBilling("codex", {
      workDir: "/tmp/vibe-billing-test",
      env: envOf({ CODEX_HOME: home, OPENAI_API_KEY: "sk-openai-metered" }),
    });
    assertEquals(evidence.billingMode, "metered");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("classifyProviderBilling - DeepSeek and Gemini API keys are metered (Issue #1923)", () => {
  // Neither vendor offers a fixed-price subscription VibeCoder can run
  // unattended, so neither may ever be reported as one.
  assertEquals(
    classifyProviderBilling("deepseek", {
      workDir: "/tmp/vibe-billing-test",
      env: envOf({ DEEPSEEK_API_KEY: "sk-deepseek" }),
    }).billingMode,
    "metered",
  );
  assertEquals(
    classifyProviderBilling("gemini", {
      workDir: "/tmp/vibe-billing-test",
      env: envOf({ GEMINI_API_KEY: "gem-key" }),
    }).billingMode,
    "metered",
  );
});

Deno.test("classifyProviderBilling - an unregistered provider is unknown, never a subscription (Issue #1923)", () => {
  const evidence = classifyProviderBilling("not-a-provider", {
    workDir: "/tmp/vibe-billing-test",
    env: envOf({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-subscription" }),
  });
  assertEquals(evidence.billingMode, "unknown");
  assertEquals(evidence.reason, "provider-not-registered");
  assertEquals(isFixedPriceSubscription(evidence), false);
});

Deno.test("classifyProviderBilling - the reason is a variable name, never a credential value (Issue #1923)", () => {
  // The evidence is logged by the fallback gate, so it must carry no secret.
  const secret = "sk-ant-oat-do-not-log-me";
  const evidence = classifyProviderBilling("claude", {
    workDir: "/tmp/vibe-billing-test",
    env: envOf({ CLAUDE_CODE_OAUTH_TOKEN: secret }),
  });
  assertEquals(JSON.stringify(evidence).includes(secret), false);
});
