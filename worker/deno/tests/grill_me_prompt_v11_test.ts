/**
 * Tests for grill-me prompt v11 (Issue #3008).
 *
 * v11 changes the Step 5b hand-off from a flat "exactly two next-phase
 * options" choice to an adaptive scope/viability recommendation. The
 * Vibe Coder now judges whether the issue is viable as a single PR and
 * presents one of three shapes:
 *
 *   1. One viable phase  → state it; drop the non-viable option entirely.
 *   2. Two viable, one preferred → recommend with a one-line rationale
 *      and pre-tick the recommended box.
 *   3. Two genuinely balanced → present both, no preference, tick nothing.
 *
 * The tie-break leans `planning` when the call is genuinely uncertain.
 * The advisory "you still toggle the actual label via the GitHub UI"
 * note is preserved. All other v10 behaviour (placeholders, label
 * policy, untrusted-input handling) is unchanged.
 *
 * These assertions inspect the prompt template content because the
 * template IS the deliverable the worker feeds to Claude — the same
 * pattern the v9 placeholder-contract test uses.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("grill-me prompt v11 - latest version is v11 or later", async () => {
  const result = await getLatestVersion("grill-me", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 11,
      true,
      `Expected grill-me prompt >= v11, got ${result.value}`,
    );
  }
});

Deno.test("grill-me prompt v11 - loads via loadPrompt", async () => {
  const result = await loadPrompt("grill-me", "v11", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Placeholder contract (unchanged from v9/v10) ---

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
  "BOUNDARY_INTEGRITY_INSTRUCTION",
];

Deno.test("grill-me prompt v11 - carries every required placeholder", async () => {
  const result = await loadPrompt("grill-me", "v11", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    for (const name of REQUIRED_PLACEHOLDERS) {
      assertStringIncludes(result.value, `{{${name}}}`);
    }
  }
});

// --- v11 adaptive-recommendation contract (Issue #3008) ---

Deno.test("grill-me prompt v11 - Step 5b no longer mandates exactly two options", async () => {
  const result = await loadPrompt("grill-me", "v11", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // The flat "exactly two task list options" / "exactly the two
    // next-phase options" rule must be gone — that is the rule the
    // issue asks to relax in both Step 5b and the confirm checklist.
    assertEquals(
      result.value.includes("exactly two task list options"),
      false,
      "v11 must drop the 'exactly two task list options' rule",
    );
    assertEquals(
      result.value.includes("exactly the two next-phase options"),
      false,
      "v11 must drop the 'exactly the two next-phase options' confirm rule",
    );
  }
});

Deno.test("grill-me prompt v11 - Step 5b describes the three adaptive cases", async () => {
  const result = await loadPrompt("grill-me", "v11", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const body = result.value;
    // The three hand-off shapes the issue accepts.
    assertStringIncludes(body, "recommendation");
    assertStringIncludes(body, "rationale");
    // Tie-break leans planning when genuinely uncertain.
    assertStringIncludes(body, "lean");
    assertStringIncludes(body, "planning");
    // Advisory note preserved: the human toggles the real label.
    assertStringIncludes(body, "GitHub");
  }
});
