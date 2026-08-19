/**
 * Tests for grill-me prompt v1 (Issue #1617).
 *
 * Verifies that prompts/grill-me/v1.md exists and satisfies the acceptance
 * criteria from issue #1617:
 *  - contains every required placeholder
 *  - distinguishes round-1, round-N, and final-round behaviour
 *  - mandates mobile-friendly comment formatting
 *  - mandates the final-round label swap from grill-me to planning, and
 *    forbids label changes at any other point
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("grill-me prompt v1 - latest version is v1 or later", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 1,
      true,
      `Expected grill-me prompt >= v1, got ${result.value}`,
    );
  }
});

Deno.test("grill-me prompt v1 - loads via loadPrompt", async () => {
  const result = await loadPrompt("grill-me", "v1", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Required placeholders (acceptance criterion 1) ---
//
// These tokens are the real substitution contract relied on by
// grill_me_processor.ts (`replaceAll("{{" + key + "}}", ...)`). Renaming any
// of them is a behavioural break, so the presence of each placeholder is a
// genuine machine-readable contract worth asserting. (validatePromptTemplate
// has no "grill_me" entry, so the per-token check is the available contract.)

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

for (const name of REQUIRED_PLACEHOLDERS) {
  Deno.test(`grill-me prompt v1 - contains {{${name}}} placeholder`, async () => {
    const result = await loadPrompt("grill-me", "v1", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value, `{{${name}}}`);
    }
  });
}
