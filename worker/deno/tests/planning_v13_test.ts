/**
 * Tests for planning v13 (Issue #1625).
 *
 * Adds `top-priority` to the reserved-labels list in CRITICAL CONSTRAINTS
 * so the planner does not pre-apply the new label introduced in
 * Issue #1622 to sub-issues. v12 must remain immutable (Issue #235).
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v13 exists and is the latest ---

Deno.test("planning v13 - loads via loadPrompt", async () => {
  const result = await loadPrompt("planning", "v13", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("planning v13 - is the latest version", async () => {
  const result = await getLatestVersion("planning", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 13,
      true,
      `Expected planning >= v13, got ${result.value}`,
    );
  }
});

// --- Placeholder contract ---

Deno.test("planning v13 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("planning", "v13", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("planning", result.value);
    assertEquals(v.ok, true);
  }
});
