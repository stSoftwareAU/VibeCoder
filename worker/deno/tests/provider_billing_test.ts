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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyProviderBilling,
  isFixedPriceSubscription,
} from "../lib/provider_billing.ts";
import { agentProviderById, agentProviderIds } from "../lib/agent_provider.ts";
import { resolveCodexHome } from "../lib/codex_auth_mode.ts";

/**
 * Run `body` with a work directory this test owns.
 *
 * The Codex probe resolves `<workDir>-agent-state/codex/auth.json`, so a
 * hard-coded path would make the result depend on whatever happens to exist on
 * the host. A fresh directory makes "nothing is logged in" a fact of the test.
 */
async function withTempWorkDir(
  body: (workDir: string) => void | Promise<void>,
): Promise<void> {
  const workDir = await Deno.makeTempDir({ prefix: "vibe-billing-work-" });
  try {
    await body(workDir);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

/**
 * A work directory for cases that never reach the filesystem — a Claude
 * classification, or a Codex one settled by the environment before the probe
 * opens anything.
 */
const UNUSED_WORK_DIR = "/nonexistent/vibe-billing";

/** An {@link EnvLookup} over a plain record — no process state is read. */
function envOf(
  values: Record<string, string>,
): (name: string) => undefined | string {
  return (name: string) => values[name];
}

Deno.test("classifyProviderBilling - no registered provider is fixed-price without a credential (Issue #1923)", async () => {
  // Fail-closed across the whole registry: with nothing provisioned, every
  // vendor must answer "unknown". A provider that reported a subscription
  // here would be eligible for auto routing with no credential at all.
  await withTempWorkDir((workDir) => {
    for (const id of agentProviderIds()) {
      const evidence = classifyProviderBilling(id, {
        workDir,
        env: envOf({}),
      });
      assertEquals(evidence.provider, id);
      assertEquals(evidence.billingMode, "unknown");
      assertEquals(evidence.reason, "subscription-credential-missing");
      assertEquals(isFixedPriceSubscription(evidence), false);
    }
  });
});

Deno.test("classifyProviderBilling - a Claude OAuth token is a fixed-price subscription (Issue #1923)", () => {
  const evidence = classifyProviderBilling("claude", {
    workDir: UNUSED_WORK_DIR,
    env: envOf({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-subscription" }),
  });
  assertEquals(evidence.billingMode, "fixed-subscription");
  assertEquals(evidence.reason, "CLAUDE_CODE_OAUTH_TOKEN");
  assertEquals(isFixedPriceSubscription(evidence), true);
});

Deno.test("classifyProviderBilling - ANTHROPIC_API_KEY is metered (Issue #1923)", () => {
  const evidence = classifyProviderBilling("claude", {
    workDir: UNUSED_WORK_DIR,
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
    workDir: UNUSED_WORK_DIR,
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
    workDir: UNUSED_WORK_DIR,
    env: envOf({ CLAUDE_CODE_OAUTH_TOKEN: "  ", ANTHROPIC_API_KEY: "" }),
  });
  assertEquals(evidence.billingMode, "unknown");
});

Deno.test("classifyProviderBilling - OPENAI_API_KEY makes Codex metered (Issue #1923)", () => {
  const evidence = classifyProviderBilling("codex", {
    workDir: UNUSED_WORK_DIR,
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
      workDir: UNUSED_WORK_DIR,
      env: envOf({ CODEX_HOME: home }),
    });
    assertEquals(evidence.billingMode, "fixed-subscription");
    assertEquals(isFixedPriceSubscription(evidence), true);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("classifyProviderBilling - an explicit CODEX_HOME withholds the metered key, so the login is what bills (Issue #1923)", async () => {
  // The classification must match the child environment the descriptor
  // actually builds. `buildIsolatedCodexChildEnv` hands an explicit
  // CODEX_HOME to the child and strips OPENAI_API_KEY / CODEX_API_KEY, so
  // this run spends the ChatGPT subscription — reporting it as metered would
  // raise a false billing alarm on every such fallback.
  const home = await Deno.makeTempDir({ prefix: "vibe-codex-home-" });
  try {
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x" } }),
    );
    const evidence = classifyProviderBilling("codex", {
      workDir: UNUSED_WORK_DIR,
      env: envOf({ CODEX_HOME: home, OPENAI_API_KEY: "sk-openai-metered" }),
    });
    assertEquals(evidence.billingMode, "fixed-subscription");
    assertEquals(evidence.reason, "codex-chatgpt-login");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("classifyProviderBilling - without an explicit CODEX_HOME the environment key reaches the child and bills (Issue #1923)", async () => {
  // The other half of the same rule: no explicit CODEX_HOME means the child
  // keeps OPENAI_API_KEY, so a login sitting on the state volume is not what
  // the run will spend and must not be reported as a subscription.
  await withTempWorkDir(async (workDir) => {
    const stateHome = `${workDir}-agent-state/codex`;
    await Deno.mkdir(stateHome, { recursive: true });
    try {
      await Deno.writeTextFile(
        `${stateHome}/auth.json`,
        JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "x" } }),
      );
      const evidence = classifyProviderBilling("codex", {
        workDir,
        env: envOf({ OPENAI_API_KEY: "sk-openai-metered" }),
      });
      assertEquals(evidence.billingMode, "metered");
      assertEquals(evidence.reason, "OPENAI_API_KEY");
    } finally {
      await Deno.remove(`${workDir}-agent-state`, { recursive: true });
    }
  });
});

Deno.test("classifyProviderBilling - an unreadable Codex login is a named fault, not a silent 'never configured' (Issue #1923)", async () => {
  // Fail loud: a corrupt auth.json must not reach an unattended operator as
  // the same label a host that simply never logged in produces.
  const home = await Deno.makeTempDir({ prefix: "vibe-codex-home-" });
  try {
    await Deno.writeTextFile(`${home}/auth.json`, "{ this is not json");
    const evidence = classifyProviderBilling("codex", {
      workDir: UNUSED_WORK_DIR,
      env: envOf({ CODEX_HOME: home }),
    });
    assertEquals(evidence.billingMode, "unknown");
    assertEquals(isFixedPriceSubscription(evidence), false);
    assertStringIncludes(evidence.reason, "codex-auth-json-unreadable");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("classifyProviderBilling - an unreadable login does not hide a metered key that will be spent (Issue #1923)", async () => {
  // An `unknown` probe settles nothing, so the declared metered variables are
  // still consulted. Short-circuiting on the fault would report `unknown` for
  // a run that is about to spend a key.
  //
  // An explicit CODEX_HOME is what makes the probe ignore the environment and
  // reach the read-error branch; the classifier then falls through to the
  // declared metered variables on its own.
  const home = await Deno.makeTempDir({ prefix: "vibe-codex-home-" });
  try {
    await Deno.writeTextFile(`${home}/auth.json`, "{ this is not json");
    const evidence = classifyProviderBilling("codex", {
      workDir: UNUSED_WORK_DIR,
      env: envOf({ CODEX_HOME: home, CODEX_API_KEY: "sk-codex-metered" }),
    });
    assertEquals(evidence.billingMode, "metered");
    assertEquals(evidence.reason, "CODEX_API_KEY");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("classifyProviderBilling - DeepSeek and Gemini API keys are metered (Issue #1923)", () => {
  // Neither vendor offers a fixed-price subscription VibeCoder can run
  // unattended, so neither may ever be reported as one.
  assertEquals(
    classifyProviderBilling("deepseek", {
      workDir: UNUSED_WORK_DIR,
      env: envOf({ DEEPSEEK_API_KEY: "sk-deepseek" }),
    }).billingMode,
    "metered",
  );
  assertEquals(
    classifyProviderBilling("gemini", {
      workDir: UNUSED_WORK_DIR,
      env: envOf({ GEMINI_API_KEY: "gem-key" }),
    }).billingMode,
    "metered",
  );
});

Deno.test("classifyProviderBilling - an unregistered provider is unknown, never a subscription (Issue #1923)", () => {
  const evidence = classifyProviderBilling("not-a-provider", {
    workDir: UNUSED_WORK_DIR,
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
    workDir: UNUSED_WORK_DIR,
    env: envOf({ CLAUDE_CODE_OAUTH_TOKEN: secret }),
  });
  assertEquals(JSON.stringify(evidence).includes(secret), false);
});

Deno.test("classifyProviderBilling - a Codex key in CODEX_API_KEY is named, not reported as OPENAI_API_KEY (Issue #1923)", () => {
  // The reason is what an unattended operator reads to know which credential
  // to change, so it must name the variable actually in play.
  const evidence = classifyProviderBilling("codex", {
    workDir: UNUSED_WORK_DIR,
    env: envOf({ CODEX_API_KEY: "sk-codex-metered" }),
  });
  assertEquals(evidence.billingMode, "metered");
  assertEquals(evidence.reason, "CODEX_API_KEY");
});

Deno.test("classifyProviderBilling - an API key held in auth.json names no variable (Issue #1923)", async () => {
  // No environment variable carries this credential, so reporting one would
  // send the operator to a variable that is not set.
  const home = await Deno.makeTempDir({ prefix: "vibe-codex-home-" });
  try {
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({ OPENAI_API_KEY: "sk-on-disk" }),
    );
    const evidence = classifyProviderBilling("codex", {
      workDir: UNUSED_WORK_DIR,
      env: envOf({ CODEX_HOME: home }),
    });
    assertEquals(evidence.billingMode, "metered");
    assertEquals(evidence.reason, "codex-auth-json-api-key");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("classifyProviderBilling - a proxied ANTHROPIC_AUTH_TOKEN proves neither mode (Issue #1923)", () => {
  // A bearer for a proxied endpoint bills whatever the proxy bills, so
  // claiming it is metered would over-state what can be proved. Unknown is
  // still ineligible for auto routing, which is the property that matters.
  const evidence = classifyProviderBilling("claude", {
    workDir: UNUSED_WORK_DIR,
    env: envOf({ ANTHROPIC_AUTH_TOKEN: "bearer-for-a-proxy" }),
  });
  assertEquals(evidence.billingMode, "unknown");
  assertEquals(isFixedPriceSubscription(evidence), false);
});

// ---------------------------------------------------------------------------
// The lookups the classifier is built on (Issue #1923)
// ---------------------------------------------------------------------------

Deno.test("agentProviderById - answers for a registered id and returns undefined otherwise (Issue #1923)", () => {
  assertEquals(agentProviderById("claude")?.id, "claude");
  // Trimmed before lookup, so a stray newline from a config file still binds.
  assertEquals(agentProviderById("  codex \n")?.id, "codex");
  // Unknown is an answer here, not an exception — the classifier asks about
  // ids it did not choose.
  assertEquals(agentProviderById("not-a-provider"), undefined);
  assertEquals(agentProviderById(""), undefined);
});

Deno.test("resolveCodexHome - an explicit CODEX_HOME wins over the state volume (Issue #1923)", () => {
  assertEquals(
    resolveCodexHome("/work", envOf({ CODEX_HOME: "/explicit/codex" })),
    "/explicit/codex",
  );
});

Deno.test("resolveCodexHome - falls back to the durable agent-state volume (Issue #1923)", () => {
  // The login must outlive the roughly hourly container refresh, so the
  // default sits beside the work directory rather than inside it.
  assertEquals(
    resolveCodexHome("/work", envOf({})),
    "/work-agent-state/codex",
  );
  // A trailing slash names the same directory.
  assertEquals(
    resolveCodexHome("/work/", envOf({})),
    "/work-agent-state/codex",
  );
});

Deno.test("resolveCodexHome - a blank CODEX_HOME is no selection at all (Issue #1923)", () => {
  assertEquals(
    resolveCodexHome("/work", envOf({ CODEX_HOME: "   " })),
    "/work-agent-state/codex",
  );
});

Deno.test("resolveCodexHome - an unusable work directory names nothing (Issue #1923)", () => {
  // The documented "" sentinel: no directory can be named, so the caller must
  // not invent a relative path. Codex then proves no subscription.
  assertEquals(resolveCodexHome("", envOf({})), "");
  assertEquals(resolveCodexHome("   ", envOf({})), "");
  assertEquals(resolveCodexHome("/", envOf({})), "");
});
