/**
 * Tests for coding_guidelines v30 (Issue #3234).
 *
 * v30 adds an explicit "never fail silently — fail loud" principle:
 * generated code must surface failures (non-zero exit, throw with context,
 * or a clear failure marker) rather than swallowing them into a green
 * result. It must not treat "no explicit success marker" as success, nor an
 * unhandled non-zero exit as benign, nor use a silent fallback that masks a
 * fault. Prefer loud, early failure over degraded/partial continuation.
 * v29 content is carried forward and stays immutable.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("coding_guidelines v30 - loads via loadPrompt", async () => {
  const result = await loadPrompt("coding_guidelines", "v30", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("coding_guidelines v30 - is the latest version", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 30,
      true,
      `Expected coding_guidelines >= v30, got ${result.value}`,
    );
  }
});

Deno.test("coding_guidelines v30 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("coding_guidelines", "v30", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("coding_guidelines", result.value);
    assertEquals(v.ok, true);
  }
});

Deno.test("coding_guidelines v30 - states the fail-loud principle", async () => {
  const result = await loadPrompt("coding_guidelines", "v30", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Collapse whitespace so assertions are robust to `deno fmt` line-wrapping.
    const body = result.value.replace(/\s+/g, " ");
    // The section heading naming the principle.
    assertStringIncludes(body, "Never Fail Silently");
    // Core requirements the principle must cover.
    assertStringIncludes(body, "fail loud");
    assertStringIncludes(body, "non-zero");
    // No "absence of failure marker = success".
    assertStringIncludes(body, "success marker");
    // No silent fallback masking a fault.
    assertStringIncludes(body, "silent fallback");
    // Prefer early loud failure.
    assertStringIncludes(body, "early");
  }
});

Deno.test("coding_guidelines v30 - carries v29 content forward", async () => {
  const v29 = await loadPrompt("coding_guidelines", "v29", PROMPTS_DIR);
  const v30 = await loadPrompt("coding_guidelines", "v30", PROMPTS_DIR);
  assertEquals(v29.ok, true);
  assertEquals(v30.ok, true);
  if (v29.ok && v30.ok) {
    // A representative earlier section must survive the carry-forward.
    assertStringIncludes(v30.value, "## Token Economy (Issue #1409)");
    assertStringIncludes(v30.value, "## General Coding Principles");
    assertStringIncludes(v30.value, "## Dependency Bumps and Supply Chain");
  }
});
