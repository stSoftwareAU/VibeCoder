/**
 * Tests for coding_guidelines v14 (Issue #1614).
 *
 * Adds a "Dependency Bumps and Supply Chain" section describing the
 * default-to-latest, internal-vs-external classification pattern. v13
 * (and earlier) must remain immutable (Issue #235).
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v14 exists and is the latest ---

Deno.test("coding_guidelines v14 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v14", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v14 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 14,
      true,
      `Expected coding_guidelines >= v14, got ${result.value}`,
    );
  }
});

// --- Placeholder contract ---

Deno.test("coding_guidelines v14 - satisfies placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v14", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});
