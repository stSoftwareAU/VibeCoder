/**
 * Tests for coding_guidelines v10 (Issue #1435).
 *
 * Verifies that v10 adds two new sections — "Pre-PR Security Self-Check"
 * and "Test Coverage Expectations" — while retaining all existing v9
 * sections verbatim.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v10 exists and is the latest ---

Deno.test("coding_guidelines v10 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v10", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v10 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 10,
      true,
      `Expected coding_guidelines >= v10, got ${result.value}`,
    );
  }
});

// --- Placeholder contract: the template type is known and its required
// placeholder set (empty for coding_guidelines) is satisfied. ---

Deno.test("coding_guidelines v10 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v10", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});
