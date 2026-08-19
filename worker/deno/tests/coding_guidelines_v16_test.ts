/**
 * Tests for coding_guidelines v16 (Issue #1759, part of #1751).
 *
 * Adds an explicit "never commit hidden files" rule to the Commit Safety
 * section, plus call-outs for `.env*`, credential stores, and the
 * defence-in-depth safeguards in #1757 and #1758. v15 (and earlier) must
 * remain immutable (Issue #235).
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v16 exists and is the latest ---

Deno.test("coding_guidelines v16 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v16", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v16 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 16,
      true,
      `Expected coding_guidelines >= v16, got ${result.value}`,
    );
  }
});

// --- Placeholder contract ---

Deno.test("coding_guidelines v16 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v16", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});
