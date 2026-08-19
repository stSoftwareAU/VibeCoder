/**
 * Tests for pr_feedback prompt v13 (Issues #3812, #3838).
 *
 * v13 re-describes the Automated Review Comments section to match the tagged,
 * code-fenced shape `buildBotReviewCommentsSection()` emits (Issue #3812
 * Gap 5). The change was originally slated for v12, but a concurrent PR
 * (Issue #3813) landed its own `v12.md` first, so v12 and v11 both describe
 * the superseded untagged shape and serve as negative controls here.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadFeedback(version: string): Promise<string> {
  const result = await loadPrompt("pr_feedback", version, PROMPTS_DIR);
  assertEquals(result.ok, true, `pr_feedback ${version} failed to load`);
  if (!result.ok) throw new Error(`pr_feedback ${version} failed to load`);
  return result.value;
}

Deno.test("pr_feedback v13 - is the latest version", async () => {
  const result = await getLatestVersion("pr_feedback", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const num = parseInt(result.value.replace("v", ""), 10);
  assertEquals(
    num >= 13,
    true,
    `expected pr_feedback >= v13, got ${result.value}`,
  );
});

Deno.test("pr_feedback v13 - satisfies the placeholder contract", async () => {
  const body = await loadFeedback("v13");
  const v = validatePromptTemplate("pr_feedback", body);
  assertEquals(v.ok, true);
});

Deno.test("pr_feedback v13 - describes the tagged review-comment shape", async () => {
  const body = await loadFeedback("v13");
  assertStringIncludes(body, "<review_comment");
  assertStringIncludes(body, "<diff_hunk>");
  // The superseded untagged keys are gone.
  assertEquals(body.includes("`Diff hunk:`"), false);
  assertEquals(body.includes("`File: <path>:<line>`"), false);
});

Deno.test("pr_feedback v13 - keeps the v12 project-guidelines wording", async () => {
  const body = await loadFeedback("v13");
  assertStringIncludes(body, "## Project Guidelines");
  assertStringIncludes(body, "<coding_guidelines>");
});

Deno.test("pr_feedback v13 - v11 and v12 described the superseded untagged shape", async () => {
  for (const version of ["v11", "v12"]) {
    const body = await loadFeedback(version);
    assertStringIncludes(body, "`Diff hunk:`");
    assertEquals(body.includes("<review_comment"), false);
  }
});
