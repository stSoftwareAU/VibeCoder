/**
 * Tests for verbosity level definitions and config loading.
 *
 * Issue #1330: Define verbosity levels and add to RepoConfig type.
 * Part of #1329 (caveman mode — configurable verbosity).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  buildDefaultWorkerConfig,
  DEFAULT_VERBOSITY,
  VERBOSITY_LEVELS,
} from "../lib/config_defaults.ts";
import { loadConfig } from "../lib/config.ts";
import type { ConfigFile, VerbosityLevel } from "../types.ts";

// Test helper to create a temporary config file
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

// =============================================================================
// VerbosityLevel Type and Constants
// =============================================================================

Deno.test("verbosity - VERBOSITY_LEVELS contains all four levels", () => {
  assertEquals(VERBOSITY_LEVELS.minimal, "minimal");
  assertEquals(VERBOSITY_LEVELS.concise, "concise");
  assertEquals(VERBOSITY_LEVELS.standard, "standard");
  assertEquals(VERBOSITY_LEVELS.verbose, "verbose");
});

Deno.test("verbosity - VERBOSITY_LEVELS has exactly four entries", () => {
  assertEquals(Object.keys(VERBOSITY_LEVELS).length, 4);
});

Deno.test("verbosity - DEFAULT_VERBOSITY is standard", () => {
  assertEquals(DEFAULT_VERBOSITY, "standard");
});

// Issue #798: the per-phase default map that used to be pinned here is gone.
// It was dead configuration — no prompt builder but the `issue` phase was ever
// passed a resolved level — so verbosity now comes from the per-repo override
// or the global default only. `verbosity_test.ts` covers that two-tier chain
// and asserts the map is no longer exported.

// =============================================================================
// buildDefaultWorkerConfig includes verbosity
// =============================================================================

Deno.test("verbosity - buildDefaultWorkerConfig includes default verbosity", () => {
  const config = buildDefaultWorkerConfig();
  assertEquals(config.verbosity, DEFAULT_VERBOSITY);
});

Deno.test("verbosity - buildDefaultWorkerConfig allows verbosity override", () => {
  const config = buildDefaultWorkerConfig({ verbosity: "verbose" });
  assertEquals(config.verbosity, "verbose");
});

// =============================================================================
// RepoConfig supports verbosity field
// =============================================================================

Deno.test("verbosity - loadConfig accepts verbosity in repo_config", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    repo_config: {
      "org/repo1": {
        verbosity: "minimal",
      },
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    const repoConf = config.repoConfig?.["org/repo1"];
    assertEquals(repoConf?.verbosity, "minimal");
  });
});

Deno.test("verbosity - loadConfig defaults verbosity when not in repo_config", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    repo_config: {
      "org/repo1": {
        skipQualityCheck: true,
      },
    },
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    const repoConf = config.repoConfig?.["org/repo1"];
    assertEquals(repoConf?.verbosity, undefined);
  });
});

Deno.test("verbosity - loadConfig accepts verbosity at top level", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    verbosity: "verbose",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.verbosity, "verbose");
  });
});

Deno.test("verbosity - loadConfig defaults verbosity to standard at top level", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.verbosity, DEFAULT_VERBOSITY);
  });
});

// =============================================================================
// Type safety — VerbosityLevel type is usable
// =============================================================================

Deno.test("verbosity - VerbosityLevel type accepts valid values", () => {
  // This is a compile-time check that passes if the module compiles
  const level: VerbosityLevel = "minimal";
  assertNotEquals(level, undefined);

  const level2: VerbosityLevel = "concise";
  assertNotEquals(level2, undefined);

  const level3: VerbosityLevel = "standard";
  assertNotEquals(level3, undefined);

  const level4: VerbosityLevel = "verbose";
  assertNotEquals(level4, undefined);
});

// =============================================================================
// Backward compatibility — config loading without verbosity still works
// =============================================================================

Deno.test("verbosity - config without verbosity field loads without error", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    claude_timeout: 7200,
    shuffle_repos: false,
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    // Should load all existing fields correctly
    assertEquals(config.claudeTimeout, 7200);
    assertEquals(config.shuffleRepos, false);
    // Verbosity should default to standard
    assertEquals(config.verbosity, DEFAULT_VERBOSITY);
  });
});
