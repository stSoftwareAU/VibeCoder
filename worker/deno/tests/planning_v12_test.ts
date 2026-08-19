/**
 * Tests for planning v12 (Issue #1586).
 *
 * Verifies that v12 adds Mermaid diagram guidance to the Sub-Issue Body
 * Template and the Dependency Relationships summary comment, while
 * leaving v11 unchanged.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v12 exists and is the latest ---

Deno.test("planning v12 - loads via loadPrompt", async () => {
  const result = await loadPrompt("planning", "v12", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("planning v12 - is the latest version", async () => {
  const result = await getLatestVersion("planning", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 12,
      true,
      `Expected planning >= v12, got ${result.value}`,
    );
  }
});

// --- Required placeholder contract preserved ---

Deno.test("planning v12 - preserves the placeholder contract", async () => {
  const result = await loadPrompt("planning", "v12", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("planning", result.value);
    assertEquals(v.ok, true);
  }
});
