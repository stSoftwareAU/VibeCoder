/**
 * Tests for config merging edge cases (Issue #630).
 *
 * Verifies that loadConfig correctly handles edge cases in config merging:
 * - Empty arrays vs missing arrays
 * - Falsy defaults (0, false, empty string)
 * - Config validation at load time
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertRejects } from "@std/assert";
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
// Config merging edge cases
// =============================================================================

Deno.test("config_merge - issueLabels is hardwired and ignores config (Issue #1834)", async () => {
  // The discovery label set is hardwired in lib/config_defaults.ts —
  // .config.json cannot override it.
  await withTempConfig(
    { allowed_authors: ["user"], repos: ["org/repo"] },
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.issueLabels, ["top-priority"]);
    },
  );
});

Deno.test("config_merge - empty authorized_commenters array overrides default", async () => {
  await withTempConfig(
    {
      allowed_authors: ["user"],
      repos: ["org/repo"],
      authorized_commenters: [],
    },
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.authorisedCommenters, []);
    },
  );
});

Deno.test("config_merge - zero claude_timeout is preserved (not replaced by default)", async () => {
  // A falsy value (0) should be used, not replaced by the default
  await withTempConfig(
    { allowed_authors: ["user"], repos: ["org/repo"], claude_timeout: 0 },
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.claudeTimeout, 0);
    },
  );
});

Deno.test("config_merge - false shuffle_repos is preserved (not replaced by default true)", async () => {
  await withTempConfig(
    { allowed_authors: ["user"], repos: ["org/repo"], shuffle_repos: false },
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.shuffleRepos, false);
    },
  );
});

Deno.test("config_merge - empty string worker_name is preserved", async () => {
  await withTempConfig(
    { allowed_authors: ["user"], repos: ["org/repo"], worker_name: "" },
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.workerName, "");
    },
  );
});

Deno.test("config_merge - empty allowed_authors array results in empty authors", async () => {
  await withTempConfig(
    { allowed_authors: [], repos: ["org/repo"] },
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.allowedAuthors, []);
    },
  );
});

Deno.test("config_merge - loadConfig with validate option rejects missing repos", async () => {
  await withTempConfig(
    { allowed_authors: ["user"] },
    async (configPath) => {
      await assertRejects(
        () => loadConfig(configPath, { validate: true }),
        Error,
        "repos",
      );
    },
  );
});

Deno.test("config_merge - loadConfig with validate option rejects missing allowed_authors", async () => {
  await withTempConfig(
    { repos: ["org/repo"] },
    async (configPath) => {
      await assertRejects(
        () => loadConfig(configPath, { validate: true }),
        Error,
        "allowed_authors",
      );
    },
  );
});

Deno.test("config_merge - loadConfig with validate option passes for valid config", async () => {
  await withTempConfig(
    { allowed_authors: ["user"], repos: ["org/repo"] },
    async (configPath) => {
      // Should not throw
      const config = await loadConfig(configPath, { validate: true });
      assertEquals(config.repos, ["org/repo"]);
    },
  );
});

// NOTE: mapSnakeToCamel tests live in config_mapping_test.ts (Issue #1308).
