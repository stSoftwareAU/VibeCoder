/**
 * Dedicated tests for config_mapping.ts — snake_case to camelCase conversion (Issue #690).
 *
 * Tests the mapSnakeToCamel utility function with a comprehensive set of inputs
 * including standard config keys, edge cases, and bijection verification.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { mapSnakeToCamel } from "../lib/config_mapping.ts";

// =============================================================================
// Standard snake_case to camelCase conversions
// =============================================================================

Deno.test("config_mapping - converts two-part snake_case key", () => {
  assertEquals(mapSnakeToCamel("allowed_author"), "allowedAuthor");
});

Deno.test("config_mapping - converts three-part snake_case key", () => {
  assertEquals(
    mapSnakeToCamel("max_clarification_rounds"),
    "maxClarificationRounds",
  );
});

Deno.test("config_mapping - converts issue_labels key", () => {
  assertEquals(mapSnakeToCamel("issue_labels"), "issueLabels");
});

Deno.test("config_mapping - converts claude_timeout key", () => {
  assertEquals(mapSnakeToCamel("claude_timeout"), "claudeTimeout");
});

Deno.test("config_mapping - converts shuffle_repos key", () => {
  assertEquals(mapSnakeToCamel("shuffle_repos"), "shuffleRepos");
});

Deno.test("config_mapping - converts worker_name key", () => {
  assertEquals(mapSnakeToCamel("worker_name"), "workerName");
});

Deno.test("config_mapping - converts authorized_commenters key", () => {
  assertEquals(
    mapSnakeToCamel("authorized_commenters"),
    "authorizedCommenters",
  );
});

// =============================================================================
// Single-word inputs (no underscores)
// =============================================================================

Deno.test("config_mapping - single word passes through unchanged", () => {
  assertEquals(mapSnakeToCamel("repos"), "repos");
});

Deno.test("config_mapping - single uppercase word is preserved as-is", () => {
  // The function does not lowercase the first word
  assertEquals(mapSnakeToCamel("Repos"), "Repos");
});

// =============================================================================
// Edge cases — empty and whitespace
// =============================================================================

Deno.test("config_mapping - empty string returns empty string", () => {
  assertEquals(mapSnakeToCamel(""), "");
});

// =============================================================================
// Edge cases — unusual underscore placement
// =============================================================================

Deno.test("config_mapping - leading underscore is stripped", () => {
  // Leading underscore creates an empty first part that is filtered out
  assertEquals(mapSnakeToCamel("_private_field"), "privateField");
});

Deno.test("config_mapping - trailing underscore is stripped", () => {
  assertEquals(mapSnakeToCamel("field_"), "field");
});

Deno.test("config_mapping - consecutive underscores are treated as separate splits", () => {
  assertEquals(mapSnakeToCamel("double__underscore"), "doubleUnderscore");
});

Deno.test("config_mapping - only underscores returns empty string", () => {
  // All parts are empty strings, filtered out
  assertEquals(mapSnakeToCamel("___"), "");
});

// =============================================================================
// Edge cases — longer multi-part keys
// =============================================================================

Deno.test("config_mapping - four-part key is converted correctly", () => {
  assertEquals(
    mapSnakeToCamel("very_long_config_key"),
    "veryLongConfigKey",
  );
});

Deno.test("config_mapping - five-part key is converted correctly", () => {
  assertEquals(
    mapSnakeToCamel("a_b_c_d_e"),
    "aBCDE",
  );
});

// =============================================================================
// Bijection — distinct snake_case keys produce distinct camelCase keys
// =============================================================================

Deno.test("config_mapping - distinct inputs produce distinct outputs (bijection check)", () => {
  const inputs = [
    "allowed_author",
    "allowed_authors",
    "repos",
    "issue_labels",
    "claude_timeout",
    "shuffle_repos",
    "worker_name",
    "authorized_commenters",
    "max_clarification_rounds",
    "max_retries",
  ];

  const outputs = inputs.map(mapSnakeToCamel);
  const uniqueOutputs = new Set(outputs);

  // Every input should map to a unique output
  assertEquals(uniqueOutputs.size, inputs.length);
});

Deno.test("config_mapping - similar keys produce different outputs", () => {
  // These look similar but must produce distinct camelCase results
  assertNotEquals(
    mapSnakeToCamel("allowed_author"),
    mapSnakeToCamel("allowed_authors"),
  );
});
