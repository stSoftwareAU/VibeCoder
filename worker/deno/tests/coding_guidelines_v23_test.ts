/**
 * Tests for coding_guidelines v23 (Issue #2222, part of #2204).
 *
 * Adds a "Don't regress Deno repos to Node.js" section that instructs Claude
 * never to introduce Node tooling, dependencies, or configuration into a Deno
 * repo (detected via `deno.json`, `deno.jsonc`, or `deno.lock`). v22 and
 * earlier must remain immutable (Issue #235).
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- v23 exists and is the latest ---

Deno.test("coding_guidelines v23 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v23", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v23 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 23,
      true,
      `Expected coding_guidelines >= v23, got ${result.value}`,
    );
  }
});

// --- Placeholder contract: the substitution code's required placeholders ---

Deno.test("coding_guidelines v23 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v23", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});
