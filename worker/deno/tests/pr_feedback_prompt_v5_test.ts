/**
 * Tests for prompts/pr_feedback/v5.md (Issue #1432).
 *
 * v5 aligns the pr_feedback prompt with the issue prompt pattern:
 * - Removes the static `## Handling Untrusted Content` section (the
 *   dynamic boundary instruction is injected by prompt_builder).
 * - Adds a `## Proactive Validation` section matching issue/v11.md.
 * - Adds a `## Self-Verification Checkpoint` section tailored to
 *   feedback response.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("pr_feedback v5 - exists and loads", async () => {
  const result = await loadPrompt("pr_feedback", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("pr_feedback v5 - is the latest version", async () => {
  const result = await getLatestVersion("pr_feedback", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 5,
      true,
      `Expected pr_feedback >= v5, got ${result.value}`,
    );
  }
});

Deno.test("pr_feedback v5 - retains required placeholders", async () => {
  const result = await loadPrompt("pr_feedback", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // The required {{PLACEHOLDER}} tokens are a real substitution contract —
    // validate them via the manager rather than grepping the source text.
    const validation = validatePromptTemplate("pr_feedback", result.value);
    assertEquals(validation.ok, true);
  }
});
