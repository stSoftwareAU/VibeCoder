/**
 * Tests for the Opus 5 prompt re-tune (Issue #3562).
 *
 * Opus 5 self-verifies without being told, expands task scope, delegates to
 * subagents more readily than Opus 4.8, and writes longer responses/files.
 * The re-tune:
 *   - coding_guidelines v34 — adds an "Opus 5 Working Style" section carrying
 *     scope-discipline, delegation-cap, deliverable-length, and "trust your own
 *     verification" guidance (shared into every phase).
 *   - issue v29 — removes the now-redundant "Self-Verification Checkpoint"
 *     scaffolding that told Opus 5 to re-verify work it already checks itself.
 *
 * These tests pin the new wording, prove the deleted scaffolding is gone from
 * the latest versions, and confirm required placeholders survive the rewrite.
 * Prior versions stay immutable (Issue #235), so older suites still guard them.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- coding_guidelines v34 -------------------------------------------------

Deno.test("opus5 retune - coding_guidelines latest is v34 or later", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 34,
      true,
      `Expected coding_guidelines >= v34, got ${result.value}`,
    );
  }
});

Deno.test("opus5 retune - coding_guidelines v34 exists and loads", async () => {
  const result = await loadPrompt("coding_guidelines", "v34", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length > 0, true);
});

Deno.test("opus5 retune - coding_guidelines v34 pins scope/delegation/length guidance", async () => {
  const result = await loadPrompt("coding_guidelines", "v34", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Section header (Issue #3562).
    assertStringIncludes(result.value, "## Opus 5 Working Style (Issue #3562)");
    // Scope discipline — Opus 5 can expand task scope.
    assertStringIncludes(result.value, "**Stay in scope.**");
    // Delegation cap — Opus 5 delegates more readily than 4.8.
    assertStringIncludes(result.value, "**Cap delegation.**");
    assertStringIncludes(result.value, "subagent");
    // Deliverable-length / concision — Opus 5 writes longer responses/files.
    assertStringIncludes(result.value, "**Keep deliverables tight.**");
    // Frames the removed self-verify scaffolding as redundant.
    assertStringIncludes(result.value, "**Trust your own verification.**");
  }
});

Deno.test("opus5 retune - coding_guidelines v34 keeps core guidance intact", async () => {
  const result = await loadPrompt("coding_guidelines", "v34", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Regression guard: the additions must not drop existing policy.
    assertStringIncludes(result.value, "KISS");
    assertStringIncludes(result.value, "DRY");
    assertStringIncludes(result.value, "Australian English");
    assertStringIncludes(result.value, "Token Economy");
    assertStringIncludes(result.value, "### Playwright MCP");
  }
});

Deno.test("opus5 retune - coding_guidelines v34 validates as a coding_guidelines template", async () => {
  const result = await loadPrompt("coding_guidelines", "v34", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validation = validatePromptTemplate(
      "coding_guidelines",
      result.value,
    );
    assertEquals(validation.ok, true);
  }
});

// --- issue v29 -------------------------------------------------------------

Deno.test("opus5 retune - issue latest is v29 or later", async () => {
  const result = await getLatestVersion("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(num >= 29, true, `Expected issue >= v29, got ${result.value}`);
  }
});

Deno.test("opus5 retune - issue v29 exists and loads", async () => {
  const result = await loadPrompt("issue", "v29", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.length > 0, true);
});

Deno.test("opus5 retune - issue v29 drops the redundant self-verification scaffolding", async () => {
  const result = await loadPrompt("issue", "v29", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Opus 5 self-verifies without being told — the ritual re-check section
    // is deleted (not softened).
    assertEquals(
      result.value.includes("## Self-Verification Checkpoint"),
      false,
      "issue v29 must not reintroduce the Self-Verification Checkpoint",
    );
    assertEquals(
      result.value.includes("Before committing, verify each of the following"),
      false,
      "issue v29 must not reintroduce the verify-each-item scaffolding",
    );
  }
});

Deno.test("opus5 retune - issue v29 retains scope discipline and placeholders", async () => {
  const result = await loadPrompt("issue", "v29", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Scope-discipline guidance stays (the explicit Change Scope section).
    assertStringIncludes(result.value, "## Change Scope");
    // Required placeholders survive the rewrite.
    const validation = validatePromptTemplate("issue", result.value);
    assertEquals(validation.ok, true);
    assertStringIncludes(result.value, "{{ISSUE_NUMBER}}");
    assertStringIncludes(result.value, "{{QUALITY_INSTRUCTIONS}}");
    assertStringIncludes(result.value, "{{CODING_GUIDELINES}}");
    assertStringIncludes(result.value, "{{VERBOSITY_INSTRUCTIONS}}");
  }
});
