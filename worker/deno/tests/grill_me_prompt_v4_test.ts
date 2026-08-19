/**
 * Tests for grill-me prompt v4 (Issue #1695).
 *
 * v4 keeps every v3 behaviour and adds one new requirement: each round
 * must also refine the issue *title* so a `work-on` or `top-priority`
 * reader (who only sees title + body, never comment history) gets the
 * worker's current understanding from both fields. v3 already keeps
 * the body in sync — v4 closes the gap on the title.
 *
 * Behavioural / contract assertions only (Issue #2551): the prose-grep
 * tests were removed. The `{{PLACEHOLDER}}` tokens are the genuine
 * substitution contract consumed by `buildGrillMePrompt`, so the
 * placeholder check is retained. The grill-me template is not registered
 * in `prompt_manager`'s REQUIRED_PLACEHOLDERS, so `validatePromptTemplate`
 * cannot be used here — the per-token check is the available contract.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("grill-me prompt v4 - latest version is v4 or later", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected grill-me prompt >= v4, got ${result.value}`,
    );
  }
});

Deno.test("grill-me prompt v4 - loads via loadPrompt", async () => {
  const result = await loadPrompt("grill-me", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Required placeholders are the real substitution contract ---

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
  Deno.test(`grill-me prompt v4 - contains {{${name}}} placeholder`, async () => {
    const result = await loadPrompt("grill-me", "v4", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value, `{{${name}}}`);
    }
  });
}
