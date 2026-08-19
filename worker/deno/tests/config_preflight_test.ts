/**
 * Tests for pre-flight gate config loading (Issue #3577).
 *
 * A malformed pre-flight entry must fail loudly at config load, and the
 * kebab-case (`pre-flight`), snake_case (`pre_flight`), and camelCase
 * (`preFlight`) forms must all normalise to the same `preFlight` field.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import { getPreFlightCommands } from "../lib/repo_config.ts";

async function withTempConfig(
  raw: unknown,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(raw));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("loadConfig - accepts kebab-case pre-flight and normalises to preFlight", async () => {
  await withTempConfig(
    {
      repos: ["org/repo"],
      repo_config: {
        "org/repo": { "pre-flight": ["./pre-flight.sh"] },
      },
    },
    async (path) => {
      const config = await loadConfig(path);
      assertEquals(
        getPreFlightCommands(config.repoConfig, "org/repo"),
        ["./pre-flight.sh"],
      );
    },
  );
});

Deno.test("loadConfig - accepts snake_case and camelCase forms", async () => {
  await withTempConfig(
    {
      repo_config: {
        "org/snake": { pre_flight: ["./a.sh"] },
        "org/camel": { preFlight: ["./b.sh"] },
      },
    },
    async (path) => {
      const config = await loadConfig(path);
      assertEquals(getPreFlightCommands(config.repoConfig, "org/snake"), [
        "./a.sh",
      ]);
      assertEquals(getPreFlightCommands(config.repoConfig, "org/camel"), [
        "./b.sh",
      ]);
    },
  );
});

Deno.test("loadConfig - no pre-flight entry → empty (repo unaffected)", async () => {
  await withTempConfig(
    { repo_config: { "org/repo": { skipQualityCheck: true } } },
    async (path) => {
      const config = await loadConfig(path);
      assertEquals(getPreFlightCommands(config.repoConfig, "org/repo"), []);
    },
  );
});

Deno.test("loadConfig - malformed pre-flight rejects loudly at load", async () => {
  await withTempConfig(
    {
      repo_config: {
        "org/repo": { "pre-flight": [123] },
      },
    },
    async (path) => {
      await assertRejects(
        () => loadConfig(path),
        Error,
        "Invalid pre-flight for org/repo",
      );
    },
  );
});

Deno.test("loadConfig - pre-flight that is not an array rejects loudly", async () => {
  await withTempConfig(
    {
      repo_config: {
        "org/repo": { "pre-flight": "./pre-flight.sh" },
      },
    },
    async (path) => {
      await assertRejects(
        () => loadConfig(path),
        Error,
        "Invalid pre-flight for org/repo",
      );
    },
  );
});
