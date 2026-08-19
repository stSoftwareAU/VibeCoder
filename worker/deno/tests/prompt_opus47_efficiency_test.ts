/**
 * Tests for Opus 4.7 token-efficiency adjustments to the coding guidelines
 * and minor prompts (Issue #1409).
 *
 * These tests verify that the latest prompt templates incorporate the
 * guidance recommended in the Opus 4.7 migration guide — token-budget
 * awareness, concrete simplicity heuristics, positive examples in place
 * of bare "Do NOT" patterns, and explicit scoping language on pr_feedback.
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- coding_guidelines v8 ---

Deno.test("opus47 efficiency - coding_guidelines latest version is v8 or later", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 8,
      true,
      `Expected coding_guidelines >= v8, got ${result.value}`,
    );
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 exists and loads", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 mentions token economy", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Opus 4.7 tokeniser awareness section should be present
    assertStringIncludes(result.value.toLowerCase(), "token");
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 retains Australian English guidance", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "Australian English");
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 retains core KISS/DRY principles", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "KISS");
    assertStringIncludes(result.value, "DRY");
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 adds a concrete simplicity heuristic", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // The issue specifies the heuristic: prefer fewer moving parts / less
    // indirection, even if a few more lines of code are needed.
    assertStringIncludes(result.value.toLowerCase(), "fewer moving parts");
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 retains secure coding section", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // The secure coding principles section must still be present —
    // Issue #478 requirements carry forward.
    assertStringIncludes(result.value, "Secure Coding");
    assertStringIncludes(result.value, "Validate and Sanitise Input");
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 retains gh CLI and Playwright MCP guidance", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Tool usage guidance must remain (Issue #308).
    assertStringIncludes(result.value, "gh issue view");
    // Playwright MCP heading is stripped dynamically in some prompts
    // (see stripPlaywrightSection) so the "### Playwright MCP" marker
    // must remain to support that filter.
    assertStringIncludes(result.value, "### Playwright MCP");
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 retains stdin redirect guidance", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // The /dev/null stdin redirect guidance is safety-critical and
    // must survive the rewrite.
    assertStringIncludes(result.value, "/dev/null");
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 retains Cypress video disable guidance", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Issue #574 — Cypress video=false guidance must remain.
    assertStringIncludes(result.value, "video=false");
  }
});

Deno.test("opus47 efficiency - coding_guidelines v8 validates as a coding_guidelines template", async () => {
  const result = await loadPrompt("coding_guidelines", "v8", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validation = validatePromptTemplate(
      "coding_guidelines",
      result.value,
    );
    assertEquals(validation.ok, true);
  }
});

// --- pr_feedback v4 ---

Deno.test("opus47 efficiency - pr_feedback latest version is v4 or later", async () => {
  const result = await getLatestVersion("pr_feedback", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 4,
      true,
      `Expected pr_feedback >= v4, got ${result.value}`,
    );
  }
});

Deno.test("opus47 efficiency - pr_feedback v4 exists and loads", async () => {
  const result = await loadPrompt("pr_feedback", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("opus47 efficiency - pr_feedback v4 retains required placeholders", async () => {
  const result = await loadPrompt("pr_feedback", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validation = validatePromptTemplate("pr_feedback", result.value);
    assertEquals(validation.ok, true);
    assertStringIncludes(result.value, "{{PR_NUMBER}}");
    assertStringIncludes(result.value, "{{QUALITY_INSTRUCTIONS}}");
    assertStringIncludes(result.value, "{{CODING_GUIDELINES}}");
  }
});

Deno.test("opus47 efficiency - pr_feedback v4 uses explicit scoping language", async () => {
  const result = await loadPrompt("pr_feedback", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // The rewrite replaces "Do NOT make unnecessary changes" with explicit
    // scoping that matches the issue prompt's "Change Scope" pattern.
    assertStringIncludes(result.value, "Change Scope");
  }
});

Deno.test("opus47 efficiency - pr_feedback v4 retains VERBOSITY_INSTRUCTIONS placeholder", async () => {
  const result = await loadPrompt("pr_feedback", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "{{VERBOSITY_INSTRUCTIONS}}");
  }
});

Deno.test("opus47 efficiency - pr_feedback v4 retains response message requirement", async () => {
  const result = await loadPrompt("pr_feedback", "v4", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // The reviewer-reply contract must not regress.
    assertStringIncludes(result.value, ".pr_response_message");
  }
});
