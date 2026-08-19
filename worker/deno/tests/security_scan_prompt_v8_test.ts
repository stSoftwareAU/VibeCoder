/**
 * Tests for security_scan prompt v8 (Issue #2159).
 *
 * v8 moves language detection out of the worker's raise-time substitution
 * and into the scanner agent's Phase 1 inventory. The `{{LANGUAGE_HINTS}}`
 * placeholder is removed entirely, along with the
 * "Dominant languages in this codebase" bullet in the `## Inputs`
 * section. Phase 1 still requires the agent to list **Languages** as
 * part of the codebase inventory — that is where language detection
 * now lives.
 *
 * Existing wrappers raised against v7 carried `Dominant languages in
 * this codebase: unknown` (the worker had no language data to inject).
 * v8 simply removes that line so the agent does the detection itself.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("security_scan prompt v8 - latest version is v8 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 8,
      true,
      `Expected security_scan prompt >= v8, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v8 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v8", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);
