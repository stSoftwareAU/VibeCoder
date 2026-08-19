/**
 * Tests for issue prompt v25 (Issue #2231).
 *
 * v25 strengthens the PR-body image path invariant: the path inside
 * `![Description](path)` MUST resolve at the same location in the
 * committed tree. A soft validation gate (#2229 + #2230) auto-corrects
 * unambiguous mismatches but the model must not rely on it. v24 stays
 * immutable.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("issue prompt v25 - latest issue version is v25 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 25,
      true,
      `Expected issue prompt >= v25, got ${result.value}`,
    );
  }
});

Deno.test("issue prompt v25 - loads via loadPrompt", async () => {
  const result = await loadPrompt("issue", "v25", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("issue prompt v25 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("issue", "v25", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("issue", result.value);
    assertEquals(v.ok, true);
  }
});
