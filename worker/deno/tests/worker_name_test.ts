/**
 * Tests for worker_name configuration option.
 *
 * Verifies that:
 * 1. DEFAULT_WORKER_NAME is exported as empty string
 * 2. WorkerConfig includes workerName field
 * 3. ConfigFile includes worker_name field
 * 4. loadConfig defaults workerName to empty string
 * 5. loadConfig loads worker_name from config file
 *
 * Issue #436: Add worker name to issue comments and PR descriptions.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals } from "@std/assert";
import { DEFAULT_WORKER_NAME } from "../lib/config_defaults.ts";
import { loadConfig } from "../lib/config.ts";
import type { ConfigFile } from "../types.ts";

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
// DEFAULT_WORKER_NAME constant
// =============================================================================

Deno.test("config_defaults - DEFAULT_WORKER_NAME is empty string", () => {
  assertEquals(DEFAULT_WORKER_NAME, "");
});

// =============================================================================
// loadConfig — worker_name loading
// =============================================================================

Deno.test("config_defaults - loadConfig defaults workerName to empty string", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.workerName, DEFAULT_WORKER_NAME);
    assertEquals(config.workerName, "");
  });
});

Deno.test("config_defaults - loadConfig loads worker_name from config", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    worker_name: "Vibe Coder Alpha",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.workerName, "Vibe Coder Alpha");
  });
});

Deno.test("config_defaults - loadConfig handles worker_name with spaces", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    worker_name: "worker macbook 1",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.workerName, "worker macbook 1");
  });
});

Deno.test("config_defaults - loadConfig handles empty worker_name", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    worker_name: "",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.workerName, "");
  });
});
