/**
 * Tests for planning v16 (Issue #2465).
 *
 * v16 instructs Claude to close the planning issue inline as the final
 * step of the planning prompt, fixing the multi-minute gap that produced
 * the FLEET-marketdata#59 incident where the worker's session-end close
 * fired nine minutes after the "planning complete" comment.
 *
 * v15 must remain immutable (Issue #235).
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("planning v16 - loads via loadPrompt", async () => {
  const result = await loadPrompt("planning", "v16", PROMPTS_DIR);
  assertEquals(result.ok, true);
});

Deno.test("planning v16 - is the latest version", async () => {
  const result = await getLatestVersion("planning", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 16,
      true,
      `Expected planning >= v16, got ${result.value}`,
    );
  }
});

Deno.test("planning v16 - satisfies the placeholder contract", async () => {
  const result = await loadPrompt("planning", "v16", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const v = validatePromptTemplate("planning", result.value);
    assertEquals(v.ok, true);
  }
});
