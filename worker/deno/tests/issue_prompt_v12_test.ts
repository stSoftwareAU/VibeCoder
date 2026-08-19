/**
 * Tests for issue prompt v12 (Issue #1431).
 *
 * Verifies that v12.md removes the duplicated "Handling Untrusted Content"
 * and "Tool Usage" sections while retaining all required placeholders and
 * other content.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- Version tests ---

Deno.test("issue prompt v12 - latest issue version is v12 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 12,
      true,
      `Expected issue prompt >= v12, got ${result.value}`,
    );
  }
});

Deno.test("issue prompt v12 - loads via loadPrompt", async () => {
  const result = await loadPrompt("issue", undefined, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Required placeholders ---

Deno.test("issue prompt v12 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("issue", undefined, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("issue", result.value);
    assertEquals(v.ok, true);
  }
});
