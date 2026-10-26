import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { readHostEgressAllowlist } from "../lib/egress_host_allowlist.ts";

const INSTALLED = ["claude", "codex", "gemini", "deepseek"];

/** An environment lookup over a fixed map, so no test touches the process env. */
function envOf(vars: Record<string, string>): (name: string) => string | undefined {
  return (name) => vars[name];
}

/** Run `fn` with a fresh temp directory, removed afterwards. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "vibe_egress_allowlist_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Write `.config.json` with `content` (a string, or an object to stringify). */
async function writeConfig(
  dir: string,
  content: unknown,
): Promise<string> {
  const path = `${dir}/.config.json`;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  await Deno.writeTextFile(path, text);
  return path;
}

const GITHUB_HOSTS = [
  "github.com",
  "api.github.com",
  "uploads.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
];

const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "jsr.io",
  "deno.land",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "pypi.org",
  "files.pythonhosted.org",
  "static.rust-lang.org",
  "cdn.playwright.dev",
];

Deno.test("readHostEgressAllowlist - a default config gives GitHub, the registries and the Claude host (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    const configFile = await writeConfig(dir, {});
    const result = await readHostEgressAllowlist({
      configFile,
      installedProviders: INSTALLED,
      env: envOf({}),
    });
    for (const host of [...GITHUB_HOSTS, ...REGISTRY_HOSTS]) {
      assertEquals(result.allowlist.includes(host), true, `missing ${host}`);
    }
    assertEquals(result.allowlist.includes("api.anthropic.com"), true);
    assertEquals(result.allowlist.includes("api.openai.com"), false);
    assertEquals(result.probeHosts, {
      github: "api.github.com",
      registry: "registry.npmjs.org",
      providers: [{ provider: "claude", host: "api.anthropic.com" }],
    });
  });
});

Deno.test("readHostEgressAllowlist - the enabled provider set decides the provider hosts (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    // The active provider must be one of the enabled set, so both are codex.
    const configFile = await writeConfig(dir, {
      agent_provider: "codex",
      agent_providers: ["codex"],
    });
    const result = await readHostEgressAllowlist({
      configFile,
      installedProviders: INSTALLED,
      env: envOf({}),
    });
    assertEquals(result.allowlist.includes("api.openai.com"), true);
    assertEquals(result.allowlist.includes("api.anthropic.com"), false);
    assertEquals(result.probeHosts.providers, [
      { provider: "codex", host: "api.openai.com" },
    ]);
  });
});

Deno.test("readHostEgressAllowlist - egress_allow_hosts additions are appended last (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    const configFile = await writeConfig(dir, {
      egress_allow_hosts: ["Example.org", "*.corp.example.net"],
    });
    const result = await readHostEgressAllowlist({
      configFile,
      installedProviders: INSTALLED,
      env: envOf({}),
    });
    assertEquals(result.allowlist.slice(-2), [
      "example.org",
      "*.corp.example.net",
    ]);
    // A wildcard stays in the list but is never a probe host.
    assertEquals(result.probeHosts.github, "api.github.com");
    assertEquals(result.probeHosts.registry, "registry.npmjs.org");
    assertEquals(
      result.probeHosts.providers.some((p) => p.host.startsWith("*")),
      false,
    );
  });
});

Deno.test("readHostEgressAllowlist - an invalid egress_allow_hosts entry throws naming it (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    const configFile = await writeConfig(dir, {
      egress_allow_hosts: ["bad host"],
    });
    const error = await assertRejects(() =>
      readHostEgressAllowlist({
        configFile,
        installedProviders: INSTALLED,
        env: envOf({}),
      })
    );
    assertStringIncludes((error as Error).message, '"bad host"');
  });
});

Deno.test("readHostEgressAllowlist - a missing config throws naming the file, never an empty list (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    const configFile = `${dir}/absent.json`;
    const error = await assertRejects(() =>
      readHostEgressAllowlist({
        configFile,
        installedProviders: INSTALLED,
        env: envOf({}),
      })
    );
    assertStringIncludes((error as Error).message, configFile);
  });
});

Deno.test("readHostEgressAllowlist - a garbage config throws naming the file (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    const configFile = await writeConfig(dir, "{ not json");
    const error = await assertRejects(() =>
      readHostEgressAllowlist({
        configFile,
        installedProviders: INSTALLED,
        env: envOf({}),
      })
    );
    assertStringIncludes((error as Error).message, configFile);
  });
});

Deno.test("readHostEgressAllowlist - a config that is not a JSON object throws naming the file (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    for (const content of ["[]", '"text"', "null"]) {
      const configFile = await writeConfig(dir, content);
      const error = await assertRejects(() =>
        readHostEgressAllowlist({
          configFile,
          installedProviders: INSTALLED,
          env: envOf({}),
        })
      );
      assertStringIncludes((error as Error).message, configFile);
    }
  });
});

Deno.test("readHostEgressAllowlist - a non-string imgbb_api_key throws naming the file (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    const configFile = await writeConfig(dir, { imgbb_api_key: 42 });
    const error = await assertRejects(() =>
      readHostEgressAllowlist({
        configFile,
        installedProviders: INSTALLED,
        env: envOf({}),
      })
    );
    assertStringIncludes((error as Error).message, configFile);
    assertStringIncludes((error as Error).message, "imgbb_api_key");
  });
});

Deno.test("readHostEgressAllowlist - ANTHROPIC_BASE_URL adds its host (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    const configFile = await writeConfig(dir, {});
    const result = await readHostEgressAllowlist({
      configFile,
      installedProviders: INSTALLED,
      env: envOf({ ANTHROPIC_BASE_URL: "https://llm.example.net/v1" }),
    });
    assertEquals(result.allowlist.includes("llm.example.net"), true);
  });
});

Deno.test("readHostEgressAllowlist - VIBE_IMGBB_API_KEY adds the imgbb host (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    const configFile = await writeConfig(dir, {});
    const without = await readHostEgressAllowlist({
      configFile,
      installedProviders: INSTALLED,
      env: envOf({}),
    });
    assertEquals(without.allowlist.includes("api.imgbb.com"), false);

    const withKey = await readHostEgressAllowlist({
      configFile,
      installedProviders: INSTALLED,
      env: envOf({ VIBE_IMGBB_API_KEY: "key" }),
    });
    assertEquals(withKey.allowlist.includes("api.imgbb.com"), true);
  });
});

Deno.test("readHostEgressAllowlist - a comma in an egress_allow_hosts entry is refused by name (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    const configFile = await writeConfig(dir, {
      egress_allow_hosts: ["a.example.com,b.example.org"],
    });
    const error = await assertRejects(() =>
      readHostEgressAllowlist({
        configFile,
        installedProviders: INSTALLED,
        env: envOf({}),
      })
    );
    assertStringIncludes(
      (error as Error).message,
      '"a.example.com,b.example.org"',
    );
  });
});

Deno.test("readHostEgressAllowlist - a comma in ANTHROPIC_BASE_URL's host is refused by name (Issue #4051)", async () => {
  await withTempDir(async (dir) => {
    // ANTHROPIC_BASE_URL is not validated by validateEgressHost, and the URL
    // parser keeps a comma in the hostname, so this is the case the reader's
    // own check must catch.
    const configFile = await writeConfig(dir, {});
    const error = await assertRejects(() =>
      readHostEgressAllowlist({
        configFile,
        installedProviders: INSTALLED,
        env: envOf({
          ANTHROPIC_BASE_URL: "https://api.example.com,evil.example.org/v1",
        }),
      })
    );
    assertStringIncludes(
      (error as Error).message,
      '"api.example.com,evil.example.org"',
    );
  });
});
