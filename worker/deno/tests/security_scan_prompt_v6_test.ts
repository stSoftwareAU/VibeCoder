/**
 * Tests for security_scan prompt v6 (Issue #2135).
 *
 * v6 expands the Phase 2 taxonomy to cover the CWE Top 25 + OWASP Top
 * 10 weakness classes missing from v5 (CSRF, XSS, XXE, mass assignment,
 * broader authentication/authorisation, SSTI) inline as plain taxonomy
 * bullets — no CWE catalogue identifiers in the prompt — and retires
 * the `{{REPO_FULL_NAME}}` placeholder. The executor's cwd is the
 * cloned repo, so Claude derives the target repo from the working
 * directory and `gh issue create` operates on the right one without
 * explicit substitution.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("security_scan prompt v6 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v6", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("security_scan prompt v6 - latest version is v6 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 6,
      true,
      `Expected security_scan prompt >= v6, got ${result.value}`,
    );
  }
});

Deno.test(
  "security_scan prompt v6 - satisfies the placeholder contract",
  async () => {
    const result = await loadPrompt("security_scan", "v6", PROMPTS_DIR);
    assertEquals(result.ok, true);
    if (result.ok) {
      const v = validatePromptTemplate("security_scan", result.value);
      assertEquals(v.ok, true);
    }
  },
);
