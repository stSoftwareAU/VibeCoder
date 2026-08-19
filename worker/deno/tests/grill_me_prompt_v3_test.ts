/**
 * Tests for grill-me prompt v3 (Issue #1658).
 *
 * v3 keeps every v2 behaviour and adds one new requirement: each round
 * must examine the repository's other currently open issues so that the
 * converged understanding (and any subsequent plan) is consistent with
 * the work already queued or in flight. This stops grill-me from
 * agreeing to scope that conflicts with — or duplicates — concurrent
 * issues.
 */

import { assertEquals } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("grill-me prompt v3 - latest version is v3 or later", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 3,
      true,
      `Expected grill-me prompt >= v3, got ${result.value}`,
    );
  }
});

Deno.test("grill-me prompt v3 - loads via loadPrompt", async () => {
  const result = await loadPrompt("grill-me", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Placeholder substitution contract ---
//
// The grill-me processor (`grill_me_processor.ts`) substitutes this exact
// set of `{{...}}` tokens at render time, so their presence is a real
// machine-readable contract — renaming one is a behavioural break. The
// grill-me type is not registered with `validatePromptTemplate`, so this
// is asserted directly against the loaded template body.

const REQUIRED_PLACEHOLDERS = [
  "ROUND_NUMBER",
  "MAX_ROUNDS",
  "REPO",
  "ISSUE_NUMBER",
  "ISSUE_TITLE",
  "ISSUE_BODY",
  "COMMENT_HISTORY",
  "CODING_GUIDELINES",
  "VERBOSITY_INSTRUCTIONS",
];

Deno.test("grill-me prompt v3 - carries every required substitution placeholder", async () => {
  const result = await loadPrompt("grill-me", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const missing = REQUIRED_PLACEHOLDERS.filter(
      (name) => !result.value.includes(`{{${name}}}`),
    );
    assertEquals(missing, []);
  }
});
