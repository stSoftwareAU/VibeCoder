/**
 * Tests for the `subscription_allocation_label` host config key (Issue #3718).
 *
 * The label names the subscription allocation a host's runs draw on, and is
 * recorded on each issue's lifecycle-ledger assignment event. It is a label
 * only: an account email, ID or fee is refused, and the refusal never echoes
 * the value back. Blank or absent records no label.
 */

import { assertEquals } from "@std/assert";
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

Deno.test("subscription_allocation_label - positive control: accepts team-a (Issue #3718)", () => {
  const result = validateConfigFileJson({
    subscription_allocation_label: "team-a",
  });
  assertEquals(result.ok, true);
});

Deno.test("subscription_allocation_label - accepts a blank value, which records no label (Issue #3718)", () => {
  for (const blank of ["", "   "]) {
    const result = validateConfigFileJson({
      subscription_allocation_label: blank,
    });
    assertEquals(result.ok, true, `expected blank "${blank}" to be accepted`);
  }
});

Deno.test("subscription_allocation_label - rejects an email, naming the key and never echoing it (Issue #3718)", () => {
  const email = "ops@example.com";
  const result = validateConfigFileJson({
    subscription_allocation_label: email,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "subscription_allocation_label");
    assertEquals(
      result.error.message.includes(email),
      false,
      "the refusal must not echo the raw value",
    );
  }
});

Deno.test("subscription_allocation_label - rejects a label with capitals and spaces (Issue #3718)", () => {
  const result = validateConfigFileJson({
    subscription_allocation_label: "Team A",
  });
  assertEquals(result.ok, false);
});

Deno.test("subscription_allocation_label - rejects a 65-character label (Issue #3718)", () => {
  const result = validateConfigFileJson({
    subscription_allocation_label: "a".repeat(65),
  });
  assertEquals(result.ok, false);
});

Deno.test("subscription_allocation_label - rejects a non-string value (Issue #3718)", () => {
  const result = validateConfigFileJson({
    subscription_allocation_label: 42,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.field, "subscription_allocation_label");
  }
});

// --- config loader ---

Deno.test("subscription_allocation_label - config loader maps the key to subscriptionAllocationLabel (Issue #3718)", async () => {
  await withTempConfig(
    { subscription_allocation_label: "team-a" } as ConfigFile,
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.subscriptionAllocationLabel, "team-a");
    },
  );
});

Deno.test("subscription_allocation_label - config loader trims the value (Issue #3718)", async () => {
  await withTempConfig(
    { subscription_allocation_label: "  team-a  " } as ConfigFile,
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.subscriptionAllocationLabel, "team-a");
    },
  );
});

Deno.test("subscription_allocation_label - config loader maps a blank value to undefined (Issue #3718)", async () => {
  await withTempConfig(
    { subscription_allocation_label: "   " } as ConfigFile,
    async (configPath) => {
      const config = await loadConfig(configPath);
      assertEquals(config.subscriptionAllocationLabel, undefined);
    },
  );
});

Deno.test("subscription_allocation_label - config loader leaves it undefined when absent (Issue #3718)", async () => {
  await withTempConfig({} as ConfigFile, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.subscriptionAllocationLabel, undefined);
  });
});

// --- unknown-keys check ---

Deno.test("subscription_allocation_label - is a known config key (Issue #3718)", () => {
  assertEquals(KNOWN_CONFIG_KEYS.has("subscription_allocation_label"), true);
});

Deno.test("subscription_allocation_label - detectUnknownConfigKeys does not flag it (Issue #3718)", () => {
  const unknown = detectUnknownConfigKeys({
    subscription_allocation_label: "team-a",
  });
  assertEquals(
    unknown.some((warning) =>
      warning.field === "subscription_allocation_label"
    ),
    false,
  );
});
