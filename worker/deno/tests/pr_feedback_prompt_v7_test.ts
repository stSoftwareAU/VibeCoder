/**
 * Tests for prompts/pr_feedback/v7.md (Issue #1859).
 *
 * v7 builds on v6 and adds explicit guidance for handling the new
 * "Automated Review Comments" context section introduced by #1858:
 * structured, line-anchored bot suggestions should be applied
 * confidently when concrete; disagreements must be explained in
 * `.pr_response_message` rather than silently skipped.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("pr_feedback v7 - exists and loads", async () => {
  const result = await loadPrompt("pr_feedback", "v7", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("pr_feedback - latest resolves to v7 (or newer)", async () => {
  const result = await getLatestVersion("pr_feedback", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 7,
      true,
      `Expected pr_feedback >= v7, got ${result.value}`,
    );
  }
});

Deno.test("pr_feedback v7 - retains required placeholders", async () => {
  const result = await loadPrompt("pr_feedback", "v7", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validation = validatePromptTemplate("pr_feedback", result.value);
    assertEquals(validation.ok, true);
  }
});
