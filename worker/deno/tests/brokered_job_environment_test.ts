import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { prepareBrokeredJobEnvironment } from "../lib/brokered_job_environment.ts";

const capability = "synthetic-local-job-capability-0123456789abcdef";
function gateways(fail?: string) {
  const opened: string[] = [];
  const closed: string[] = [];
  const open = (name: string) => {
    if (fail === name) throw new Error("Synthetic gateway failure");
    opened.push(name);
    return {
      baseUrl: "http://127.0.0.1:12432",
      close: () => {
        closed.push(name);
        return Promise.resolve();
      },
    };
  };
  return {
    opened,
    closed,
    factories: {
      github: () => open("github"),
      git: () => open("git"),
      claude: () => open("claude"),
      codex: () => open("codex"),
      gemini: () => open("gemini"),
    },
  };
}

Deno.test("isolated repository job builds fresh Git and gh state with only local capability", async () => {
  const observed = gateways();
  const profile = await prepareBrokeredJobEnvironment({
    version: 1,
    capability,
  }, observed.factories);
  const home = profile.env.HOME!;
  try {
    assertEquals(observed.opened, ["github", "git"]);
    assertEquals(profile.env.GH_TOKEN, capability);
    assertEquals(profile.env.GIT_CONFIG_NOSYSTEM, "1");
    assertEquals(profile.env.DENO_DIR, `${home}/cache/deno`);
    assertEquals(profile.env.XDG_CONFIG_HOME, `${home}/config`);
    assertEquals(profile.env.ANTHROPIC_API_KEY, undefined);
    assertEquals(profile.env.OPENAI_API_KEY, undefined);
    assertEquals(profile.env.HTTPS_PROXY, undefined);
    assertEquals(profile.env.CONFIG_PATH, undefined);
    assertStringIncludes(
      await Deno.readTextFile(`${profile.env.GH_CONFIG_DIR}/config.yml`),
      "http_unix_socket:",
    );
    const config = await Deno.readTextFile(profile.env.GIT_CONFIG_GLOBAL!);
    assertStringIncludes(config, "insteadOf = https://github.com/");
    assertEquals(config.includes(capability), false);
  } finally {
    await profile.close();
  }
  assertEquals(observed.closed, ["git", "github"]);
  await assertRejects(() => Deno.stat(home), Deno.errors.NotFound);
  await profile.close();
  assertEquals(observed.closed, ["git", "github"]);
});

Deno.test("isolated model jobs keep explicit provider and billing modes in native configuration", async () => {
  for (
    const [provider, authentication, key] of [
      ["claude", "api-key", "ANTHROPIC_API_KEY"],
      ["claude", "subscription", "CLAUDE_CODE_OAUTH_TOKEN"],
      ["deepseek", "bearer", "ANTHROPIC_AUTH_TOKEN"],
      ["codex", "api-key", "CODEX_BROKER_CAPABILITY"],
      ["codex", "chatgpt", "CODEX_BROKER_CAPABILITY"],
      ["gemini", "api-key", "GEMINI_API_KEY"],
    ]
  ) {
    const observed = gateways();
    const profile = await prepareBrokeredJobEnvironment({
      version: 1,
      capability,
      agent: { provider, authentication },
    }, observed.factories);
    try {
      assertEquals(profile.env[key!], capability);
      assertEquals(profile.env.GH_TOKEN, capability);
      assertEquals(observed.opened, [
        "github",
        "git",
        provider === "deepseek" ? "claude" : provider,
      ]);
      if (provider === "codex") {
        const config = await Deno.readTextFile(
          `${profile.env.CODEX_HOME}/config.toml`,
        );
        assertStringIncludes(
          config,
          authentication === "chatgpt"
            ? "vibe_broker_chatgpt"
            : "vibe_broker_api_key",
        );
        assertStringIncludes(config, "requires_openai_auth = false");
        await assertRejects(
          () => Deno.stat(`${profile.env.CODEX_HOME}/auth.json`),
          Deno.errors.NotFound,
        );
      }
    } finally {
      await profile.close();
    }
    assertEquals(observed.closed, [...observed.opened].reverse());
  }
});

Deno.test("isolated job refuses unknown authority and unwinds partially started gateways", async () => {
  for (
    const metadata of [
      { version: 1, capability, credentials: { github: "private" } },
      {
        version: 1,
        capability,
        agent: { provider: "gemini", authentication: "oauth" },
      },
      {
        version: 1,
        capability,
        agent: {
          provider: "codex",
          authentication: "chatgpt",
          accountId: "private",
        },
      },
      { version: 1, capability: "short" },
      { version: 2, capability },
    ]
  ) {
    const observed = gateways();
    await assertRejects(() =>
      prepareBrokeredJobEnvironment(metadata, observed.factories)
    );
    assertEquals(observed.opened, []);
  }
  const observed = gateways("claude");
  await assertRejects(() =>
    prepareBrokeredJobEnvironment({
      version: 1,
      capability,
      agent: { provider: "claude", authentication: "subscription" },
    }, observed.factories)
  );
  assertEquals(observed.closed, ["git", "github"]);
});

Deno.test("isolated job cleanup attempts every gateway and removes local state after a close failure", async () => {
  const observed = gateways();
  const factories = {
    ...observed.factories,
    git: () => ({
      baseUrl: "http://127.0.0.1:12432",
      close: () => Promise.reject(new Error("Synthetic shutdown failure")),
    }),
  };
  const profile = await prepareBrokeredJobEnvironment({
    version: 1,
    capability,
  }, factories);
  await assertRejects(
    () => profile.close(),
    Error,
    "Isolated job profile cleanup failed",
  );
  assertEquals(observed.closed, ["github"]);
  await assertRejects(() => Deno.stat(profile.env.HOME!), Deno.errors.NotFound);
});
