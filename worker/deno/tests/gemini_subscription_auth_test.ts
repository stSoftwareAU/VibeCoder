/**
 * Gemini Google-account login billing guard (Issue #5339).
 *
 * A Google-account login under an explicit GEMINI_CLI_HOME proves a fixed-price
 * subscription; an API key alone is metered. Once a home is selected, API keys
 * must not reach the child, so a stale login fails rather than becoming
 * metered spend. Every path lives in a throwaway directory.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  agentProviderById,
  isSubscriptionCapable,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";
import {
  initialiseGeminiHome,
  resolveGeminiAuthMode,
} from "../lib/gemini_auth.ts";
import { classifyProviderBilling } from "../lib/provider_billing.ts";
import { checkWorkerCredentials } from "../lib/run_worker.ts";

const REFRESH = "test-refresh-token-value";

/** Run `body` with a throwaway root directory. */
async function withRoot(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "gemini-subscription-" });
  try {
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** Write `<home>/.gemini/<name>` and return the home. */
async function plant(
  home: string,
  name: string,
  content: string,
): Promise<string> {
  await Deno.mkdir(`${home}/.gemini`, { recursive: true });
  await Deno.writeTextFile(`${home}/.gemini/${name}`, content);
  return home;
}

function classify(env: Record<string, string>, workDir: string) {
  return classifyProviderBilling("gemini", {
    workDir,
    env: (name) => env[name],
  });
}

Deno.test("Gemini login - an explicit home with a refresh token is a fixed-price subscription", async () => {
  await withRoot(async (root) => {
    const home = await plant(
      `${root}/home`,
      "oauth_creds.json",
      JSON.stringify({ refresh_token: REFRESH }),
    );
    const evidence = classify({ GEMINI_CLI_HOME: home }, root);
    assertEquals(evidence.billingMode, "fixed-subscription");
    assertEquals(evidence.reason, "gemini-google-login");
    // An API key in the environment is withheld from the child.
    const withKey = classify(
      { GEMINI_CLI_HOME: home, GEMINI_API_KEY: "gem-key" },
      root,
    );
    assertEquals(withKey.billingMode, "fixed-subscription");
  });
});

Deno.test("Gemini login - free-tier and paid logins classify the same", async () => {
  await withRoot(async (root) => {
    const free = await plant(
      `${root}/free`,
      "oauth_creds.json",
      JSON.stringify({ refresh_token: REFRESH, scope: "openid email" }),
    );
    const paid = await plant(
      `${root}/paid`,
      "oauth_creds.json",
      JSON.stringify({
        refresh_token: REFRESH,
        scope: "openid email cloud-platform",
        expiry_date: 1,
        token_type: "Bearer",
      }),
    );
    for (const home of [free, paid]) {
      assertEquals(
        classify({ GEMINI_CLI_HOME: home }, root).billingMode,
        "fixed-subscription",
      );
    }
  });
});

Deno.test("Gemini login - an API key alone is metered and nothing is unknown", async () => {
  await withRoot(async (root) => {
    assertEquals(
      classify({ GEMINI_API_KEY: "k" }, root).billingMode,
      "metered",
    );
    assertEquals(
      classify({ GOOGLE_API_KEY: "k" }, root).billingMode,
      "metered",
    );
    assertEquals(classify({}, root).billingMode, "unknown");
  });
});

Deno.test("Gemini login - an unusable login is unknown and names the fault", async () => {
  await withRoot(async (root) => {
    const bad = await plant(`${root}/bad`, "oauth_creds.json", "{not json");
    const noRefresh = await plant(
      `${root}/norefresh`,
      "oauth_creds.json",
      JSON.stringify({ access_token: "a" }),
    );
    const badEvidence = classify({ GEMINI_CLI_HOME: bad }, root);
    assertEquals(badEvidence.billingMode, "unknown");
    assertEquals(
      badEvidence.reason.includes("gemini-login-unreadable") &&
        badEvidence.reason.includes("not valid JSON"),
      true,
    );
    const noRefreshEvidence = classify({ GEMINI_CLI_HOME: noRefresh }, root);
    assertEquals(noRefreshEvidence.billingMode, "unknown");
    assertEquals(
      noRefreshEvidence.reason.includes("gemini-login-unreadable") &&
        noRefreshEvidence.reason.includes("no refresh_token"),
      true,
    );
  });
});

Deno.test("Gemini login - settings selecting an API key is metered; an empty home proves nothing", async () => {
  await withRoot(async (root) => {
    const keyed = await plant(
      `${root}/keyed`,
      "settings.json",
      JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
      }),
    );
    const evidence = classify({ GEMINI_CLI_HOME: keyed }, root);
    assertEquals(evidence.billingMode, "metered");
    assertEquals(evidence.reason, "gemini-settings-api-key");

    const empty = `${root}/empty`;
    await Deno.mkdir(empty);
    const gemini = agentProviderById("gemini")!;
    assertEquals(
      gemini.billing.resolveStoredBilling!({
        workDir: root,
        env: (name) => name === "GEMINI_CLI_HOME" ? empty : undefined,
      }),
      undefined,
    );
    const none = classify({ GEMINI_CLI_HOME: empty }, root);
    assertEquals(none.billingMode, "unknown");
    assertEquals(none.reason, "subscription-credential-missing");
  });
});

Deno.test("Gemini login - gemini is subscription capable", () => {
  assertEquals(isSubscriptionCapable("gemini"), true);
});

Deno.test("Gemini login - a selected home withholds every API key from the child", () => {
  const gemini = resolveAgentProvider("gemini");
  const child = gemini.buildChildEnv({
    PATH: "/usr/bin",
    GH_TOKEN: "gh-test",
    GEMINI_API_KEY: "gem",
    GOOGLE_API_KEY: "goog",
    GEMINI_CLI_HOME: "/some/home",
    ANTHROPIC_API_KEY: "ant",
  });
  assertEquals(child.GEMINI_API_KEY, undefined);
  assertEquals(child.GOOGLE_API_KEY, undefined);
  assertEquals(child.ANTHROPIC_API_KEY, undefined);
  assertEquals(child.GEMINI_CLI_HOME, "/some/home");
  assertEquals(child.GOOGLE_GENAI_USE_GCA, "true");
  assertEquals(child.PATH, "/usr/bin");
  assertEquals(child.GH_TOKEN, "gh-test");

  for (const home of [undefined, "   "]) {
    const keyed = gemini.buildChildEnv({
      PATH: "/usr/bin",
      GEMINI_API_KEY: "gem",
      GOOGLE_API_KEY: "goog",
      ...(home === undefined ? {} : { GEMINI_CLI_HOME: home }),
    });
    assertEquals(keyed.GEMINI_API_KEY, "gem");
    assertEquals(keyed.GOOGLE_API_KEY, "goog");
    assertEquals(keyed.GOOGLE_GENAI_USE_GCA, undefined);
  }
});

Deno.test("Gemini login - startup seeds a persistent home and preserves a refreshed login", async () => {
  await withRoot(async (root) => {
    const dir = `${root}/credentials`;
    const home = `${root}/home`;
    const env: Record<string, string> = { GH_TOKEN: "test-github" };
    await Deno.mkdir(`${dir}/gemini`, { recursive: true, mode: 0o700 });
    await Deno.chmod(dir, 0o700);
    await Deno.writeTextFile(
      `${dir}/gemini/provider.env`,
      `GEMINI_CLI_HOME=${home}\n`,
      { mode: 0o600 },
    );
    const seed = JSON.stringify({ refresh_token: REFRESH });
    await Deno.writeTextFile(`${dir}/gemini/oauth_creds.json`, seed, {
      mode: 0o600,
    });
    const options = {
      dir,
      providers: [resolveAgentProvider("gemini")],
      env: (name: string) => env[name],
      setEnv: (name: string, value: string) => {
        env[name] = value;
      },
    };
    assertEquals(await checkWorkerCredentials(options), null);
    assertEquals(
      await Deno.readTextFile(`${home}/.gemini/oauth_creds.json`),
      seed,
    );
    const refreshed = JSON.stringify({ refresh_token: "refreshed-value" });
    await Deno.writeTextFile(`${home}/.gemini/oauth_creds.json`, refreshed);
    assertEquals(await checkWorkerCredentials(options), null);
    assertEquals(
      await Deno.readTextFile(`${home}/.gemini/oauth_creds.json`),
      refreshed,
    );
  });
});

Deno.test("Gemini login - a missing, token-less or public seed cannot initialise a login", async () => {
  await withRoot(async (root) => {
    const env = (name: string) =>
      name === "GEMINI_CLI_HOME" ? `${root}/home` : undefined;
    await assertRejects(
      () => initialiseGeminiHome(root, env),
      Error,
      "Google-account login missing",
    );
    await Deno.writeTextFile(`${root}/oauth_creds.json`, "{}", { mode: 0o600 });
    await assertRejects(
      () => initialiseGeminiHome(root, env),
      Error,
      "Google-account login missing",
    );
    await Deno.writeTextFile(
      `${root}/oauth_creds.json`,
      JSON.stringify({ refresh_token: REFRESH }),
    );
    await Deno.chmod(`${root}/oauth_creds.json`, 0o644);
    await assertRejects(
      () => initialiseGeminiHome(root, env),
      Error,
      "must be owner-only (0600)",
    );
  });
});

Deno.test("resolveGeminiAuthMode - outcomes, never leaking the refresh token", async () => {
  await withRoot(async (root) => {
    const login = await plant(
      `${root}/login`,
      "oauth_creds.json",
      JSON.stringify({ refresh_token: REFRESH }),
    );
    const apiKey = await plant(
      `${root}/key`,
      "settings.json",
      JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
      }),
    );
    const absent = `${root}/absent`;
    await Deno.mkdir(absent);
    const vertex = await plant(
      `${root}/vertex`,
      "settings.json",
      JSON.stringify({ security: { auth: { selectedType: "vertex-ai" } } }),
    );
    const broken = await plant(`${root}/broken`, "settings.json", "{oops");
    assertEquals(resolveGeminiAuthMode(login).mode, "login");
    assertEquals(resolveGeminiAuthMode(`${login}/`).mode, "login");
    assertEquals(resolveGeminiAuthMode(apiKey).mode, "api-key");
    assertEquals(resolveGeminiAuthMode(absent).mode, "unknown");
    assertEquals(resolveGeminiAuthMode(vertex).mode, "unknown");
    assertEquals(resolveGeminiAuthMode(broken).mode, "read-error");
    for (const home of [login, apiKey, absent, vertex, broken]) {
      assertEquals(
        JSON.stringify(resolveGeminiAuthMode(home)).includes(REFRESH),
        false,
      );
    }
  });
});

Deno.test("resolveGeminiAuthMode - oauth-personal selection needs a login; malformed shapes are read errors", async () => {
  await withRoot(async (root) => {
    const settings = JSON.stringify({
      security: { auth: { selectedType: "oauth-personal" } },
    });
    const withLogin = await plant(`${root}/a`, "settings.json", settings);
    await plant(
      withLogin,
      "oauth_creds.json",
      JSON.stringify({ refresh_token: REFRESH }),
    );
    assertEquals(resolveGeminiAuthMode(withLogin).mode, "login");
    assertEquals(
      classify({ GEMINI_CLI_HOME: withLogin }, root).billingMode,
      "fixed-subscription",
    );

    const noLogin = await plant(`${root}/b`, "settings.json", settings);
    assertEquals(resolveGeminiAuthMode(noLogin).mode, "unknown");

    const arraySettings = await plant(`${root}/c`, "settings.json", "[]");
    assertEquals(resolveGeminiAuthMode(arraySettings), {
      mode: "read-error",
      detail: "settings.json is not an object",
    });

    const arrayCreds = await plant(`${root}/d`, "oauth_creds.json", "[]");
    assertEquals(resolveGeminiAuthMode(arrayCreds), {
      mode: "read-error",
      detail: "oauth_creds.json is not an object",
    });
  });
});

Deno.test("Gemini login - the actionable message names the login path and the API key", () => {
  const message = resolveAgentProvider("gemini").authActionableMessage();
  assertStringIncludes(message, "GEMINI_CLI_HOME");
  assertStringIncludes(message, "oauth_creds.json");
  assertStringIncludes(message, "GEMINI_API_KEY");
});
