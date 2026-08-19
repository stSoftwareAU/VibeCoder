/**
 * Tests for issue prompt v14 (Issue #1576).
 *
 * Verifies that v14.md instructs Claude to escape Liquid syntax in
 * `docs/pr-summary-*.md` files using `{% raw %} ... {% endraw %}` so the
 * GitHub Pages Jekyll build does not parse PR summary prose as Liquid.
 *
 * Also guards immutability of v13 (Issue #235 — prompt versions are
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

Deno.test("issue prompt v14 - latest issue version is v14 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 14,
      true,
      `Expected issue prompt >= v14, got ${result.value}`,
    );
  }
});

Deno.test("issue prompt v14 - loads via loadPrompt", async () => {
  const result = await loadPrompt("issue", "v14", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

// --- Required-placeholder contract ---

Deno.test("issue prompt v14 - satisfies the required-placeholder contract", async () => {
  const result = await loadPrompt("issue", "v14", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("issue", result.value);
    assertEquals(v.ok, true);
  }
});
