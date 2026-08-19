/**
 * Tests for coding_guidelines v24 (Issue #2231).
 *
 * v24 strengthens the Playwright MCP block: pick one directory
 * (`docs/evidence/` is the convention) and reference the exact path
 * you saved to. Adds a one-line "Path invariant" reminder that
 * `![](path)` paths MUST exist in the committed tree. v23 stays
 * immutable.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("coding_guidelines v24 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v24", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v24 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 24,
      true,
      `Expected coding_guidelines >= v24, got ${result.value}`,
    );
  }
});

Deno.test("coding_guidelines v24 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v24", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});
