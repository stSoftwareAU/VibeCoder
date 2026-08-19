/**
 * Tests for security_scan prompt v7 (Issue #2138).
 *
 * v7 fixes broken-English rendering when the `{{SUPPRESSED_IDS}}` and
 * `{{KNOWN_OPEN_FINDING_IDS}}` lists are empty. v6 inlined the
 * placeholders inside backticks ("appears in `{{SUPPRESSED_IDS}}` or
 * `{{KNOWN_OPEN_FINDING_IDS}}`") which rendered as "appears in `` or
 * ``" once the worker substituted the empty lists at wrapper-file time.
 *
 * v7 moves the lists to a dedicated "## Inputs" section at the top of
 * the prompt and reworks the inline references to read naturally
 * regardless of whether the lists are populated.
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

Deno.test("security_scan prompt v7 - latest version is v7 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assert(result.ok);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 7,
      true,
      `Expected security_scan prompt >= v7, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v7 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v7", PROMPTS_DIR);
    assert(result.ok);
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  },
);
