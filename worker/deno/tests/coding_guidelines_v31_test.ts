/**
 * Tests for coding_guidelines v31 (Issue #3239).
 *
 * v31 adds an explicit "repository isolation — no cross-repo coupling"
 * principle: quality gates and their fixes are per-repo, each repository
 * commits and owns its own gate script, and no shared cross-repo reusable
 * GitHub Action (or other cross-repo mechanism) may centralise a gate. The
 * idle-task audit only verifies presence and files a per-repo issue — it
 * never centralises the gate. v30 content (including the #3234 fail-loud
 * principle) is carried forward and stays immutable.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("coding_guidelines v31 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v31", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v31 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 31,
      true,
      `Expected coding_guidelines >= v31, got ${result.value}`,
    );
  }
});

Deno.test("coding_guidelines v31 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v31", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});

Deno.test("coding_guidelines v31 - states the repository-isolation principle", async () => {
  const result = await loadPrompt("coding_guidelines", "v31", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Collapse whitespace so assertions are robust to `deno fmt` line-wrapping.
    const body = result.value.replace(/\s+/g, " ");
    // The section heading naming the principle.
    assertStringIncludes(body, "Repository Isolation");
    // Core wording the principle must carry.
    assertStringIncludes(body, "absolutely isolated");
    assertStringIncludes(body, "per-repo");
    // No shared cross-repo reusable Action to centralise a gate.
    assertStringIncludes(body, "cross-repo");
    assertStringIncludes(body, "reusable GitHub Action");
    // The audit only verifies presence, never centralises the gate.
    assertStringIncludes(body, "verifies presence");
  }
});

Deno.test("coding_guidelines v31 - carries v30 content forward (incl. fail-loud)", async () => {
  const v30 = await loadPrompt("coding_guidelines", "v30", PROMPTS_DIR);
  const v31 = await loadPrompt("coding_guidelines", "v31", PROMPTS_DIR);
  assertEquals(v30.ok, true);
  assertEquals(v31.ok, true);
  if (v30.ok && v31.ok) {
    // Representative earlier sections must survive the carry-forward.
    assertStringIncludes(v31.value, "## Token Economy (Issue #1409)");
    assertStringIncludes(v31.value, "## General Coding Principles");
    assertStringIncludes(v31.value, "## Dependency Bumps and Supply Chain");
    // #3234's fail-loud principle is preserved.
    assertStringIncludes(v31.value, "## Never Fail Silently — Fail Loud");
  }
});
