/**
 * Tests for the `issue_sub_agent_tier` config key and its resolver
 * (Issue #3401).
 *
 * The key is registered host-wide with a per-repository override under
 * `repo_config`, defaults to `"sonnet"`, and an invalid value is warned
 * about rather than failing `loadConfig`. Australian English spelling used
 * throughout (behaviour, recognised).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  resolveHostIssueSubAgentTier,
  resolveIssueSubAgentTier,
} from "../lib/issue_sub_agent_tier.ts";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";
import { validateConfigFileJson } from "../lib/validation.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { loadConfig } from "../lib/config.ts";
import { getRepoConfig } from "../lib/repo_config.ts";
import type { ConfigFile, RepoConfig, WorkerConfig } from "../types.ts";

async function withTempConfig(
  config: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

/** The minimum a config file must carry to load at all. */
function minimalConfig(extra: ConfigFile = {}): ConfigFile {
  return {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    ...extra,
  };
}

Deno.test("issue_sub_agent_tier - unset everywhere resolves to sonnet without warning", () => {
  const warnings: string[] = [];
  const result = resolveIssueSubAgentTier(
    buildDefaultWorkerConfig(),
    undefined,
    (m) => warnings.push(m),
  );
  assertEquals(result, "sonnet");
  assertEquals(warnings.length, 0);
  assertEquals(buildDefaultWorkerConfig().issueSubAgentTier, "sonnet");
});

Deno.test("issue_sub_agent_tier - host haiku, repo unset or empty resolves to haiku", () => {
  const host: Pick<WorkerConfig, "issueSubAgentTier"> = {
    issueSubAgentTier: "haiku",
  };
  assertEquals(resolveIssueSubAgentTier(host, undefined), "haiku");
  assertEquals(resolveIssueSubAgentTier(host, {} as RepoConfig), "haiku");
});

Deno.test("issue_sub_agent_tier - a valid repo value beats the host-wide value", () => {
  assertEquals(
    resolveIssueSubAgentTier(
      { issueSubAgentTier: "haiku" },
      { issueSubAgentTier: "sonnet" } as RepoConfig,
    ),
    "sonnet",
  );
  assertEquals(
    resolveIssueSubAgentTier(
      { issueSubAgentTier: "sonnet" },
      { issueSubAgentTier: "haiku" } as RepoConfig,
    ),
    "haiku",
  );
});

Deno.test("issue_sub_agent_tier - an invalid repo value is refused loudly", () => {
  const warnings: string[] = [];
  const result = resolveIssueSubAgentTier(
    { issueSubAgentTier: "haiku" },
    { issueSubAgentTier: "opus" } as unknown as RepoConfig,
    (m) => warnings.push(m),
  );
  assertEquals(result, "haiku");
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "issue_sub_agent_tier");
  assertStringIncludes(warnings[0] ?? "", '"opus"');
});

Deno.test("issue_sub_agent_tier - a non-string repo value falls back to the host value", () => {
  const warnings: string[] = [];
  const result = resolveIssueSubAgentTier(
    { issueSubAgentTier: "haiku" },
    { issueSubAgentTier: 7 } as unknown as RepoConfig,
    (m) => warnings.push(m),
  );
  assertEquals(result, "haiku");
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0] ?? "", "7");
});

Deno.test("issue_sub_agent_tier - an invalid host value falls back to the default", () => {
  for (const badHost of ["opus", 7]) {
    const warnings: string[] = [];
    const result = resolveIssueSubAgentTier(
      { issueSubAgentTier: badHost } as unknown as Pick<
        WorkerConfig,
        "issueSubAgentTier"
      >,
      undefined,
      (m) => warnings.push(m),
    );
    assertEquals(result, "sonnet");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0] ?? "", "issue_sub_agent_tier");
    assertStringIncludes(warnings[0] ?? "", JSON.stringify(badHost));
  }
});

Deno.test("issue_sub_agent_tier - resolveHostIssueSubAgentTier: undefined resolves to sonnet without warning", () => {
  const warnings: string[] = [];
  assertEquals(
    resolveHostIssueSubAgentTier(undefined, (m) => warnings.push(m)),
    "sonnet",
  );
  assertEquals(warnings.length, 0);
});

Deno.test("issue_sub_agent_tier - resolveHostIssueSubAgentTier: haiku resolves to haiku", () => {
  assertEquals(resolveHostIssueSubAgentTier("haiku"), "haiku");
});

Deno.test("issue_sub_agent_tier - is a recognised config key", () => {
  assertEquals(KNOWN_CONFIG_KEYS.has("issue_sub_agent_tier"), true);
});

Deno.test("issue_sub_agent_tier - validateConfigFileJson accepts a bad value (never fails validation)", () => {
  for (const issue_sub_agent_tier of ["opus", 7]) {
    const result = validateConfigFileJson({ issue_sub_agent_tier });
    assertEquals(result.ok, true);
  }
});

Deno.test("issue_sub_agent_tier - loadConfig end-to-end resolves host and repo overrides", async () => {
  await withTempConfig(
    minimalConfig({
      issue_sub_agent_tier: "haiku",
      repo_config: {
        "org/repo1": {
          issue_sub_agent_tier: "sonnet",
        } as unknown as RepoConfig,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.issueSubAgentTier, "haiku");
      assertEquals(
        getRepoConfig(config.repoConfig, "org/repo1", "issueSubAgentTier"),
        "sonnet",
      );
      assertEquals(
        resolveIssueSubAgentTier(
          config,
          config.repoConfig?.["org/repo1"],
        ),
        "sonnet",
      );
    },
  );
});

Deno.test("issue_sub_agent_tier - loadConfig never throws on a bad host value", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
  try {
    await withTempConfig(
      minimalConfig({ issue_sub_agent_tier: 7 } as unknown as ConfigFile),
      async (configPath) => {
        const config = await loadConfig(configPath);
        assertEquals(config.issueSubAgentTier, "sonnet");
      },
    );
  } finally {
    console.warn = original;
  }
  assertEquals(warnings.length > 0, true);
});
