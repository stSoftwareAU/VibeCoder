/**
 * Tests for coding_guidelines v15 (Issue #1681).
 *
 * Adds a "Streaming Reads — Never Use Unbounded `tail -f`" section warning
 * against the `tail -f … | head -N` foot-gun that wedged host-25 for 17h 45m.
 * v14 (and earlier) must remain immutable (Issue #235).
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v15 exists and is the latest ---

Deno.test("coding_guidelines v15 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v15", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v15 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 15,
      true,
      `Expected coding_guidelines >= v15, got ${result.value}`,
    );
  }
});

// --- Placeholder contract ---

Deno.test("coding_guidelines v15 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v15", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});
