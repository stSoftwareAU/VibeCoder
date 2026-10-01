/**
 * Tests for the `fleet_run_archive` host config key (Issue #2930).
 *
 * `fleet_run_archive` names an operator's read-only fleet run archive repo
 * (an `owner/repo` slug) that measurement issues read so their verdict is
 * fleet-wide instead of single-host. Unset leaves the feature off.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { validateConfigFileJson } from "../lib/validation.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
} from "../lib/config_unknown_keys.ts";
import { loadConfig } from "../lib/config.ts";
import type { ConfigFile } from "../types.ts";

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

// --- validateConfigFileJson ---

Deno.test("fleet_run_archive - accepts a valid owner/repo slug", () => {
  const result = validateConfigFileJson({ fleet_run_archive: "owner/repo" });
  assertEquals(result.ok, true);
});

Deno.test("fleet_run_archive - rejects a non-string value", () => {
  const result = validateConfigFileJson({ fleet_run_archive: 42 });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "fleet_run_archive");
  }
});

Deno.test("fleet_run_archive - rejects path-traversal slugs", () => {
  for (const bad of ["../x", "owner/..", "not a slug", "a/b/c"]) {
    const result = validateConfigFileJson({ fleet_run_archive: bad });
    assertEquals(result.ok, false, `expected "${bad}" to be rejected`);
  }
});

Deno.test("fleet_run_archive - error message never echoes a hostile value raw", () => {
  const hostile = "o/r`rm -rf`";
  const result = validateConfigFileJson({ fleet_run_archive: hostile });
  assertEquals(result.ok, false);
  if (!result.ok) {
    // Metacharacters must not survive into the reported message.
    assertEquals(result.error.message.includes("`rm -rf`"), false);
    assertStringIncludes(result.error.message, "owner/repo");
  }
});

// --- config loader ---

Deno.test("fleet_run_archive - config loader maps the key to fleetRunArchive", async () => {
  await withTempConfig(
    { fleet_run_archive: "owner/repo" } as ConfigFile,
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.fleetRunArchive, "owner/repo");
    },
  );
});

Deno.test("fleet_run_archive - config loader leaves it undefined when absent", async () => {
  await withTempConfig({} as ConfigFile, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.fleetRunArchive, undefined);
  });
});

// --- unknown-keys check ---

Deno.test("fleet_run_archive - is a known config key", () => {
  assertEquals(KNOWN_CONFIG_KEYS.has("fleet_run_archive"), true);
});

Deno.test("fleet_run_archive - detectUnknownConfigKeys does not flag it", () => {
  const unknown = detectUnknownConfigKeys({ fleet_run_archive: "owner/repo" });
  assertEquals(
    unknown.some((warning) => warning.field === "fleet_run_archive"),
    false,
  );
});
