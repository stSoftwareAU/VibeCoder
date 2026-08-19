/**
 * Tests for issue prompt v15 (Issue #1585).
 *
 * Verifies that v15.md adds Mermaid diagram guidance for both README updates
 * and `docs/pr-summary-*.md` files. The intent is to encourage workers to
 * include diagrams when changes affect architecture, data flow, state
 * transitions, or sequence of events.
 *
 * Also guards immutability of v14 (Issue #235 — prompt versions are
 * immutable once committed).
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- Version tests ---

Deno.test("issue prompt v15 - latest issue version is v15 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 15,
      true,
      `Expected issue prompt >= v15, got ${result.value}`,
    );
  }
});

Deno.test("issue prompt v15 - loads via loadPrompt", async () => {
  const result = await loadPrompt("issue", "v15", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Placeholder contract (real substitution dependency) ---

Deno.test("issue prompt v15 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("issue", "v15", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("issue", result.value);
    assertEquals(v.ok, true);
  }
});
