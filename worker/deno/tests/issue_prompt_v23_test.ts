/**
 * Tests for issue prompt v23 (Issue #2173).
 *
 * v23 moves the canonical PR summary write path from `docs/pr-summary-N.md`
 * to `docs/archive/pr-summaries/pr-summary-N.md`, keeping the loose `docs/`
 * root free of auto-generated noise. v22 stays immutable.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("issue prompt v23 - latest issue version is v23 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 23,
      true,
      `Expected issue prompt >= v23, got ${result.value}`,
    );
  }
});

Deno.test("issue prompt v23 - loads via loadPrompt", async () => {
  const result = await loadPrompt("issue", "v23", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("issue prompt v23 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("issue", "v23", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("issue", result.value);
    assertEquals(v.ok, true);
  }
});
