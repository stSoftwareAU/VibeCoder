/**
 * Tests for grill-me prompt v9 (Issue #2513).
 *
 * v9 brings the grill-me clarification prompt to parity with the
 * Issue #1343 prompt-injection defence used by every other
 * untrusted-content prompt. The untrusted inputs (issue title, issue
 * body, comment history) are wrapped by `buildGrillMePrompt` in
 * randomised `[UNTRUSTED]` delimiters and the template appends a
 * boundary-integrity instruction via the new
 * `{{BOUNDARY_INTEGRITY_INSTRUCTION}}` placeholder, replacing the bare
 * triple-backtick fences used by v8 and earlier.
 *
 * All other v8 behaviour is preserved.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("grill-me prompt v9 - latest version is v9 or later", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 9,
      true,
      `Expected grill-me prompt >= v9, got ${result.value}`,
    );
  }
});

Deno.test("grill-me prompt v9 - loads via loadPrompt", async () => {
  const result = await loadPrompt("grill-me", "v9", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Placeholder contract ---
//
// The grill-me template is not registered with `validatePromptTemplate`
// in prompt_manager.ts, so the validator cannot express its contract.
// These placeholder tokens are the real machine-readable contract: each
// one is substituted by the `replacements` map in
// `buildGrillMePrompt` (grill_me_processor.ts), so renaming any token
// silently breaks rendering. We assert the whole set in one test.

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
  // New in v9: boundary-integrity instruction injected by the builder.
  "BOUNDARY_INTEGRITY_INSTRUCTION",
];

Deno.test("grill-me prompt v9 - carries every required placeholder", async () => {
  const result = await loadPrompt("grill-me", "v9", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const name of REQUIRED_PLACEHOLDERS) {
      assertStringIncludes(result.value, `{{${name}}}`);
    }
  }
});
