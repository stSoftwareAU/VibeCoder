/**
 * Tests for the `subscription_allocation_label` host config key (Issue #3718).
 *
 * The label names the subscription allocation a host's runs draw on, and is
 * recorded on each issue's lifecycle-ledger assignment event. It is a label
 * only: an account email, ID or fee is refused, and the refusal never echoes
 * the value back. Blank or absent records no label.
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

/** The label rule's own message, so a refusal is known to come from that rule. */
const LABEL_RULE_MESSAGE = "Expected an operator label";

/** Validate a config holding only this key set to `value`. */
function validateLabel(value: unknown) {
  return validateConfigFileJson({ subscription_allocation_label: value });
}

/**
 * Assert the label rule refuses `value`: the field names the key, and the
 * message is the label-rule message. Each refused input is paired with a
 * control that differs only in the probed value, so the refusal is shown to
 * come from that value alone.
 */
function assertRefusedByLabelRule(value: unknown, what: string): void {
  const result = validateLabel(value);
  assertEquals(result.ok, false, `${what} must be refused`);
  if (result.ok) return;
  assertEquals(result.error.field, "subscription_allocation_label");
  assertStringIncludes(result.error.message, LABEL_RULE_MESSAGE);
}

/** Assert the key accepts `value`. */
function assertAccepted(value: unknown, what: string): void {
  const result = validateLabel(value);
  assertEquals(result.ok, true, `${what} must be accepted`);
}

Deno.test("subscription_allocation_label - positive control: accepts team-a (Issue #3718)", () => {
  assertAccepted("team-a", "team-a");
});

Deno.test("subscription_allocation_label - accepts a blank value, which records no label (Issue #3718)", () => {
  for (const blank of ["", "   "]) {
    assertAccepted(blank, `blank "${blank}"`);
  }
});

Deno.test("subscription_allocation_label - refuses an email, naming the key and never echoing it (Issue #3718)", () => {
  const email = "ops@example.com";
  assertRefusedByLabelRule(email, "an email");
  const result = validateLabel(email);
  if (!result.ok) {
    assertEquals(
      result.error.message.includes(email),
      false,
      "the refusal must not echo the raw value",
    );
  }
  // Control: the same shape with only the '@' made legal is accepted.
  assertAccepted("ops-example.com", "ops-example.com (email with '@' removed)");
});

Deno.test("subscription_allocation_label - refuses a label with capitals and a space (Issue #3718)", () => {
  assertRefusedByLabelRule("Team A", "'Team A'");
  // Control: the same label made legal (lowercase, hyphen for the space).
  assertAccepted("team-a", "'team-a'");
});

Deno.test("subscription_allocation_label - refuses a 65-character label (Issue #3718)", () => {
  assertRefusedByLabelRule("a".repeat(65), "a 65-character label");
  // Control: the same label at the 64-character limit is accepted.
  assertAccepted("a".repeat(64), "a 64-character label");
});

Deno.test("subscription_allocation_label - refuses a non-string value (Issue #3718)", () => {
  assertRefusedByLabelRule(42, "the number 42");
  // Control: the same value as a legal string is accepted.
  assertAccepted("42", "the string '42'");
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
