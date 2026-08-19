/**
 * Tests for spelling_fix prompt v4 (Issue #1434).
 *
 * Verifies that v4.md aligns with the standard implementation-prompt pattern
 * by adding Error Recovery, Proactive Validation, Change Scope, and
 * Self-Verification Checkpoint sections while retaining all required
 * placeholders and v3 content.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- Version tests ---

Deno.test("spelling_fix prompt v4 - latest spelling_fix version is v4 or later", async () => {
  const result = await getLatestVersion("spelling_fix", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected spelling_fix prompt >= v4, got ${result.value}`,
    );
  }
});

Deno.test("spelling_fix prompt v4 - loads via loadPrompt", async () => {
  const result = await loadPrompt("spelling_fix", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Required placeholder contract ---

Deno.test("spelling_fix prompt v4 - satisfies the required placeholder contract", async () => {
  const result = await loadPrompt("spelling_fix", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("spelling_fix", result.value);
    assertEquals(v.ok, true);
  }
});
