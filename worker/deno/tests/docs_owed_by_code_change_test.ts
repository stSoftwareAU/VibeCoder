/**
 * Tests for Issue #3611 — a code change owes a docs change.
 *
 * Renames, changed defaults, and removed flags shipped without their owed docs
 * update, and were only caught weeks later by the idle-task documentation
 * scans. The PR-time fix is one mechanical step: grep the docs for the old name
 * before finishing. These tests pin that instruction in the latest
 * `coding_guidelines` prompt (shared into every phase) and in the human-facing
 * `CODING-STANDARDS.md` mirror.
 *
 * Australian English throughout (behaviour, surface).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadLatestGuidelines(): Promise<string> {
  const latest = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(latest.ok, true);
  if (!latest.ok) throw new Error("no coding_guidelines version found");
  const prompt = await loadPrompt(
    "coding_guidelines",
    latest.value,
    PROMPTS_DIR,
  );
  assertEquals(prompt.ok, true);
  if (!prompt.ok) throw new Error(`failed to load ${latest.value}`);
  return prompt.value;
}

Deno.test("docs-owed - coding_guidelines latest is v35 or later", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assert(
      num >= 35,
      `Expected coding_guidelines >= v35, got ${result.value}`,
    );
  }
});

Deno.test("docs-owed - coding_guidelines v35 pins the grep-the-docs rule", async () => {
  const result = await loadPrompt("coding_guidelines", "v35", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(
      result.value,
      "## A Code Change Owes a Docs Change (Issue #3611)",
    );
    // The triggers — not just "usage and new features".
    for (const trigger of ["rename", "signature", "default", "flag"]) {
      assertStringIncludes(result.value.toLowerCase(), trigger);
    }
    // The mechanical step that makes it reliable.
    assertStringIncludes(result.value, "grep the repo's docs for the old name");
    // Same change, before the commit — not a follow-up.
    assertStringIncludes(result.value, "in the same change");
  }
});

Deno.test("docs-owed - coding_guidelines v35 keeps core guidance intact", async () => {
  const result = await loadPrompt("coding_guidelines", "v35", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "Token Economy");
    assertStringIncludes(result.value, "## Opus 5 Working Style (Issue #3562)");
    assertStringIncludes(result.value, "## Visual Documentation");
    assertStringIncludes(result.value, "Australian English");
    assertStringIncludes(result.value, "## Commit Safety (Issue #1751)");
  }
});

Deno.test("docs-owed - coding_guidelines v35 validates as a template", async () => {
  const result = await loadPrompt("coding_guidelines", "v35", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validation = validatePromptTemplate(
      "coding_guidelines",
      result.value,
    );
    assertEquals(validation.ok, true);
  }
});

Deno.test("docs-owed - CODING-STANDARDS.md mirrors the rule", async () => {
  const text = await Deno.readTextFile(
    new URL("../../../CODING-STANDARDS.md", import.meta.url),
  );
  assertStringIncludes(text, "## A Code Change Owes a Docs Change");
  assertStringIncludes(text, "grep the repo's docs for the old name");
});

Deno.test("docs-owed - latest coding_guidelines carries the rule", async () => {
  const text = await loadLatestGuidelines();
  assertStringIncludes(text, "A Code Change Owes a Docs Change");
  assertStringIncludes(text, "grep the repo's docs for the old name");
});
