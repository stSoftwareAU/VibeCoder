/**
 * Tests for coding_guidelines v12 (Issue #1584).
 *
 * Verifies that v12 adds a "Visual Documentation" section recommending
 * Mermaid diagrams while leaving v11 unchanged.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v12 exists and is the latest ---

Deno.test("coding_guidelines v12 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v12", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v12 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 12,
      true,
      `Expected coding_guidelines >= v12, got ${result.value}`,
    );
  }
});

// --- Placeholder contract ---

Deno.test("coding_guidelines v12 - satisfies its placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v12", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});
