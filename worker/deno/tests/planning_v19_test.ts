/**
 * Tests for planning v19 (Issue #3245).
 *
 * v19 adds a mandatory `## Failure Detection` section to the sub-issue body
 * template so every drafted sub-issue states how a regression in that work is
 * detected — preferring the earliest detection point (test / CI gate) and
 * excluding a console log alone. The pre-finish checklist requires a non-empty
 * failure-detection criterion on every sub-issue.
 *
 * v18 must remain immutable (Issue #235).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("planning v19 - loads via loadPrompt", async () => {
  const result = await loadPrompt("planning", "v19", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

// Issue #3795: v20 supersedes v19, so this asserts the floor rather than
// equality — matching every other planning version test.
Deno.test("planning v19 - is at or below the latest version", async () => {
  const result = await getLatestVersion("planning", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 19,
      true,
      `Expected planning >= v19, got ${result.value}`,
    );
  }
});

Deno.test("planning v19 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("planning", "v19", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("planning", result.value);
    assertEquals(v.ok, true);
  }
});

Deno.test("planning v19 - contains the Failure Detection template section", async () => {
  const result = await loadPrompt("planning", "v19", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // The canonical marker heading shared with the deterministic gate.
    assertStringIncludes(result.value, "## Failure Detection");
    // It must sit within the sub-issue body template, after Acceptance Criteria
    // and before Dependencies.
    const acIdx = result.value.indexOf("## Acceptance Criteria");
    const fdIdx = result.value.indexOf("## Failure Detection");
    const depIdx = result.value.indexOf("## Dependencies");
    assertEquals(
      acIdx < fdIdx,
      true,
      "Failure Detection must follow Acceptance Criteria",
    );
    assertEquals(
      fdIdx < depIdx,
      true,
      "Failure Detection must precede Dependencies",
    );
  }
});

Deno.test("planning v19 - excludes a console log alone", async () => {
  const result = await loadPrompt("planning", "v19", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "console log alone");
    // The N/A escape hatch for no-runtime-surface work.
    assertStringIncludes(result.value, "N/A —");
  }
});

Deno.test("planning v19 - pre-finish checklist requires failure detection", async () => {
  const result = await loadPrompt("planning", "v19", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(
      result.value,
      "a non-empty `## Failure Detection` section",
    );
  }
});
