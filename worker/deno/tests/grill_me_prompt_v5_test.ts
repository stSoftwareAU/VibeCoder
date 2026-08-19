/**
 * Tests for grill-me prompt v5 (Issue #1666).
 *
 * v5 keeps every v4 behaviour and replaces the lettered multi-choice
 * format (`a)`, `b)`, `c)`, `other)`) with GitHub-flavoured Markdown
 * task list checkboxes (`- [ ] choice text`) so users can tap a box on
 * the GitHub mobile app instead of typing letter shorthand. Claude must
 * read `[x]` checkbox state on prior round comments as the user's
 * answer.
 */

import { assertEquals } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("grill-me prompt v5 - latest version is v5 or later", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 5,
      true,
      `Expected grill-me prompt >= v5, got ${result.value}`,
    );
  }
});

Deno.test("grill-me prompt v5 - loads via loadPrompt", async () => {
  const result = await loadPrompt("grill-me", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Placeholder substitution contract ---
//
// grill-me is not registered with validatePromptTemplate, but the
// `buildGrillMePrompt` substitution code in grill_me_processor.ts depends
// on these exact `{{TOKEN}}` names. Renaming any of them is a behavioural
// break, so this single test asserts the machine-readable contract.

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

Deno.test("grill-me prompt v5 - contains every required placeholder token", async () => {
  const result = await loadPrompt("grill-me", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const missing = REQUIRED_PLACEHOLDERS.filter(
      (name) => !result.value.includes(`{{${name}}}`),
    );
    assertEquals(
      missing,
      [],
      `v5 is missing required placeholders: ${missing.join(", ")}`,
    );
  }
});
