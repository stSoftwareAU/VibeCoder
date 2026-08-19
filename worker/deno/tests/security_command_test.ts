/**
 * Tests for the security command.
 *
 * CLI-specific tests only — unit tests for pattern detection, commenter
 * authorisation, and bot detection logic live in security_test.ts.
 * Deduplicated as part of Issue #1307.
 *
 * Issue #903: Migrate security.sh to Deno TypeScript.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { securityCommand } from "../commands/security.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function createMockConfig(
  overrides: Record<string, unknown> = {},
): WorkerConfig {
  return buildDefaultWorkerConfig(overrides);
}

// ---------------------------------------------------------------------------
// CLI-specific: command metadata
// ---------------------------------------------------------------------------

Deno.test("security command - has correct name", () => {
  assertEquals(securityCommand.name, "security");
});

Deno.test("security command - has description", () => {
  assertEquals(typeof securityCommand.description, "string");
  assertEquals(securityCommand.description.length > 0, true);
});

// ---------------------------------------------------------------------------
// CLI-specific: command output format validation
// ---------------------------------------------------------------------------

Deno.test("security command - validate-input with clean input", async () => {
  const result = await securityCommand.execute(
    { operation: "validate-input", title: "Fix bug", body: "A simple bug fix" },
    createMockConfig(),
  );
  assertEquals(result.success, true);
  assertStringIncludes(result.message, "title=");
  assertStringIncludes(result.message, "body=");
});

// ---------------------------------------------------------------------------
// CLI-specific: detect-bots derives the primary author from allowedAuthors
// (Issue #3206 — no longer reads the deprecated allowedAuthor scalar).
// ---------------------------------------------------------------------------

Deno.test("security command - detect-bots skips primary author from allowedAuthors", async () => {
  // The primary author is a bot-pattern name; because detect-bots derives it
  // from allowedAuthors[0], it must be skipped and not counted as a bot.
  const config = createMockConfig({
    allowedAuthors: ["dependabot", "human-user"],
    authorisedCommenters: ["dependabot", "renovate[bot]"],
  });
  const result = await securityCommand.execute(
    { operation: "detect-bots" },
    config,
  );
  assertEquals(result.success, true);
  const data = result.data as { botCount: number; botNames: string[] };
  // dependabot is the primary author → skipped; only renovate[bot] counts.
  assertEquals(data.botCount, 1);
  assertEquals(data.botNames, ["renovate[bot]"]);
});

// ---------------------------------------------------------------------------
// CLI-specific: unknown operation error handling
// ---------------------------------------------------------------------------

Deno.test("security command - unknown operation returns failure", async () => {
  const result = await securityCommand.execute(
    { operation: "unknown-op" },
    createMockConfig(),
  );
  assertEquals(result.success, false);
});

// ---------------------------------------------------------------------------
// Issue #3206: detect-bots skips the primary author sourced from the
// `allowedAuthors` array, not the deprecated `allowedAuthor` scalar.
// ---------------------------------------------------------------------------

Deno.test("security command - detect-bots skips primary author from allowedAuthors array", async () => {
  // Deprecated scalar deliberately left empty so this test only passes when
  // detect-bots reads the primary author from `allowedAuthors[0]`.
  const config = createMockConfig({
    allowedAuthors: ["dependabot[bot]"],
    allowedAuthor: "",
    authorisedCommenters: ["dependabot[bot]"],
  });

  const result = await securityCommand.execute(
    { operation: "detect-bots" },
    config,
  );

  assertEquals(result.success, true);
  assertEquals((result.data as { botCount: number }).botCount, 0);
  assertStringIncludes(result.message, "No bot accounts detected");
});
