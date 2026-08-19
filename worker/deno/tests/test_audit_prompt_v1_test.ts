/**
 * Tests for test_audit prompt v1 (Issue #2250, parent #2214).
 *
 * The test-audit prompt is the language-agnostic orchestrating prompt
 * for the WHAT-vs-HOW test-quality scan. It mirrors the structure of
 * `prompts/best_practices/v2.md` and `prompts/security_scan/v9.md`:
 * four-phase, read-only, outcome-only, files at most six findings per
 * run.
 *
 * Behavioural assertions only — these tests exercise the real
 * `loadPrompt` / `validatePromptTemplate` paths in `prompt_manager.ts`
 * rather than grepping the template by path.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  getLatestVersion,
  getRequiredPlaceholders,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("test_audit prompt - latest version resolves to v1 or later", async () => {
  const result = await getLatestVersion("test_audit", PROMPTS_DIR);
  assert(
    result.ok,
    `latest version lookup failed: ${result.ok ? "" : result.error.message}`,
  );
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 1,
      true,
      `Expected test_audit prompt >= v1, got ${result.value}`,
    );
  }
});

Deno.test("test_audit prompt - loadPrompt('test_audit') resolves v1.md", async () => {
  const result = await loadPrompt("test_audit", "v1", PROMPTS_DIR);
  assert(
    result.ok,
    `loadPrompt failed: ${result.ok ? "" : result.error.message}`,
  );
});

Deno.test("test_audit prompt - REQUIRED_PLACEHOLDERS registers SUPPRESSED_IDS and KNOWN_OPEN_FINDING_IDS", () => {
  const result = getRequiredPlaceholders("test_audit");
  assert(
    result.ok,
    `getRequiredPlaceholders failed: ${result.ok ? "" : result.error.message}`,
  );
  if (result.ok) {
    assertEquals(
      [...result.value].sort(),
      ["KNOWN_OPEN_FINDING_IDS", "SUPPRESSED_IDS"],
    );
  }
});

Deno.test(
  "test_audit prompt v1 - validatePromptTemplate passes for v1 (required placeholders present)",
  async () => {
    const load = await loadPrompt("test_audit", "v1", PROMPTS_DIR);
    assert(load.ok);
    if (!load.ok) return;
    const validate = validatePromptTemplate("test_audit", load.value);
    assertEquals(validate.ok, true);
  },
);
