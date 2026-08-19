/**
 * Tests for coding_guidelines v13 (Issue #1625).
 *
 * Adds `top-priority` to the reserved-labels list so the agent does not
 * self-apply the new label introduced in Issue #1622. v12 must remain
 * immutable (Issue #235 prompt immutability rule).
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v13 exists and is the latest ---

Deno.test("coding_guidelines v13 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v13", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v13 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 13,
      true,
      `Expected coding_guidelines >= v13, got ${result.value}`,
    );
  }
});

// --- Placeholder contract ---

Deno.test("coding_guidelines v13 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v13", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});
