/**
 * Tests for the escape-hatch prompt sections.
 *
 * Verifies that:
 *   - coding_guidelines/v17 contains the escape-hatch rule.
 *   - pr_feedback/v6, ci_fix/v5, and issue/v18 each reference it.
 *   - The new versions are the latest (so the worker actually loads them).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("coding_guidelines v17 - contains the escape-hatch rule", async () => {
  const result = await loadPrompt("coding_guidelines", "v17", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertStringIncludes(result.value, "Escape Hatch");
  assertStringIncludes(result.value, "escape hatch");
  assertStringIncludes(result.value, "follow-up");
  assertStringIncludes(result.value, "out of scope");
  assertStringIncludes(result.value, "needs-human");
});

Deno.test("coding_guidelines v17 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(num >= 17, true, `expected >= v17, got ${result.value}`);
});

Deno.test("pr_feedback v6 - references the escape-hatch rule", async () => {
  const result = await loadPrompt("pr_feedback", "v6", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertStringIncludes(result.value, "Escape Hatch");
  assertStringIncludes(result.value, "escape hatch");
  assertStringIncludes(result.value, ".pr_response_message");
});

Deno.test("pr_feedback v6 - is the latest version", async () => {
  const result = await getLatestVersion("pr_feedback", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(num >= 6, true, `expected >= v6, got ${result.value}`);
});

Deno.test("ci_fix v5 - references the escape-hatch rule", async () => {
  const result = await loadPrompt("ci_fix", "v5", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertStringIncludes(result.value, "Escape Hatch");
  assertStringIncludes(result.value, "escape hatch");
});

Deno.test("ci_fix v5 - is the latest version", async () => {
  const result = await getLatestVersion("ci_fix", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(num >= 5, true, `expected >= v5, got ${result.value}`);
});

Deno.test("issue v18 - references the escape-hatch rule", async () => {
  const result = await loadPrompt("issue", "v18", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertStringIncludes(result.value, "Escape Hatch");
  assertStringIncludes(result.value, "escape hatch");
  assertStringIncludes(result.value, "follow-up issue");
});

Deno.test("issue v18 - is the latest version", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(num >= 18, true, `expected >= v18, got ${result.value}`);
});
