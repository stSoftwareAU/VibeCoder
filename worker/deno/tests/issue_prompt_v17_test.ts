/**
 * Tests for issue prompt v17 (Issue #1625).
 *
 * Adds `top-priority` to the reserved-labels list so the worker does not
 * self-apply the new label introduced in Issue #1622. v16 must remain
 * immutable (Issue #235 prompt immutability rule).
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v17 exists and is the latest ---

Deno.test("issue prompt v17 - latest issue version is v17 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 17,
      true,
      `Expected issue prompt >= v17, got ${result.value}`,
    );
  }
});

Deno.test("issue prompt v17 - loads via loadPrompt", async () => {
  const result = await loadPrompt("issue", "v17", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

// --- Placeholder contract ---

Deno.test("issue prompt v17 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("issue", "v17", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("issue", result.value);
    assertEquals(v.ok, true);
  }
});
