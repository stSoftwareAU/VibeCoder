/**
 * Tests for security_scan prompt v1 (Issue #1937).
 *
 * v1 is the first version of the MythOS-style four-phase security
 * audit prompt. Asserts that the prompt loads, is the latest version,
 * and satisfies the machine-readable placeholder contract.
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

Deno.test("security_scan prompt v1 - latest version is v1 or later", async () => {
  const result = await getLatestVersion("security_scan", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 1,
      true,
      `Expected security_scan prompt >= v1, got ${result.value}`,
    );
  }
});

Deno.test("security_scan prompt v1 - loads via loadPrompt", async () => {
  const result = await loadPrompt("security_scan", "v1", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("security_scan prompt v1 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("security_scan", "v1", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("security_scan", result.value);
    assertEquals(v.ok, true);
  }
});
