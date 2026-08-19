/**
 * Tests for the pr_feedback v12 → v13 lineage (Issues #3812, #3813, #3849).
 *
 * Two milestone PRs each created `prompts/pr_feedback/v12.md`; the surviving
 * v12 carries #3813's substitution/verbosity wording but describes the
 * superseded untagged review-comment shape (Issue #3849). Prompt versions are
 * immutable, so v13 carries both changes and is where the tagged,
 * code-fenced shape `buildBotReviewCommentsSection()` emits is described.
 * v11 and v12 stay immutable and are the negative controls.
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

Deno.test("pr_feedback v12 - satisfies the placeholder contract", async () => {
  const body = await loadFeedback("v12");
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

Deno.test("pr_feedback v13 - keeps v12's substitution and verbosity wording", async () => {
  const body = await loadFeedback("v13");
  // Issue #3813: the verbosity placeholder leads, and every remaining
  // substitution sits on its own line or inside a tagged block.
  assertStringIncludes(body, "{{VERBOSITY_INSTRUCTIONS}}\n");
  assertStringIncludes(
    body,
    "<quality_instructions>\n{{QUALITY_INSTRUCTIONS}}",
  );
  assertStringIncludes(
    body,
    "**Fix the general case, not the flagged line's inputs.**",
  );
});

Deno.test("pr_feedback v12 - stays frozen on the untagged shape", async () => {
  const body = await loadFeedback("v12");
  assertStringIncludes(body, "`Diff hunk:`");
  assertStringIncludes(body, "`File: <path>:<line>`");
  assertEquals(
    body.includes("<review_comment"),
    false,
    "v12 is immutable and must not gain the tagged shape v13 describes",
  );
});

Deno.test("pr_feedback v12 - v11 described the superseded untagged shape", async () => {
  const body = await loadFeedback("v11");
  assertStringIncludes(body, "`Diff hunk:`");
  assertEquals(body.includes("<review_comment"), false);
});
