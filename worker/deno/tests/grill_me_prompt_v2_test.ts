/**
 * Tests for grill-me prompt v2 (Issue #1647).
 *
 * v2 changes the workflow so that:
 *  - Claude updates the issue body each round under a stable marker block.
 *  - Every round comment carries an explicit "Awaiting your reply" footer.
 *  - There is no fixed final-round forced finalisation; Claude decides when
 *    grilling has converged and posts a `## Grill-Me — Ready for Next Phase`
 *    comment with two lettered options (`planning` / `work-on`).
 *  - Claude is forbidden from adding `planning`, `work-on`, or any other
 *    operational label. Only the `grill-me` label may be removed, and only
 *    after the Ready comment is posted.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("grill-me prompt v2 - latest version is v2 or later", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 2,
      true,
      `Expected grill-me prompt >= v2, got ${result.value}`,
    );
  }
});

Deno.test("grill-me prompt v2 - loads via loadPrompt", async () => {
  const result = await loadPrompt("grill-me", "v2", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Required placeholders (acceptance criterion 1) ---
//
// The grill-me prompt template type is not registered with
// validatePromptTemplate, so the placeholder contract is enforced directly
// here. These tokens are a genuine machine-readable contract: buildGrillMePrompt
// in grill_me_processor.ts substitutes each {{NAME}} at render time, so renaming
// one is a behavioural break.

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
  Deno.test(`grill-me prompt v2 - contains {{${name}}} placeholder`, async () => {
    const result = await loadPrompt("grill-me", "v2", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertStringIncludes(result.value, `{{${name}}}`);
    }
  });
}
