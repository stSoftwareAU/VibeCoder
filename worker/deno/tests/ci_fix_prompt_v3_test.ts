/**
 * Tests for prompts/ci_fix/v3.md (Issue #1433).
 *
 * v3 aligns the ci_fix prompt with the standard implementation-prompt
 * pattern used by issue/v11.md and pr_feedback/v5.md by adding three
 * missing sections:
 * - `## Error Recovery (Issue #228)` — adapted for CI fix scope.
 * - `## Proactive Validation` — requires `./quality.sh` to pass locally.
 * - `## Self-Verification Checkpoint` — tailored to CI fix work.
 */

import { assertEquals } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("ci_fix v3 - exists and loads", async () => {
  const result = await loadPrompt("ci_fix", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("ci_fix v3 - is the latest version", async () => {
  const result = await getLatestVersion("ci_fix", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const num = parseInt(result.value.replace("v", ""), 10);
    assertEquals(
      num >= 3,
      true,
      `Expected ci_fix >= v3, got ${result.value}`,
    );
  }
});

Deno.test("ci_fix v3 - retains required placeholders", async () => {
  const result = await loadPrompt("ci_fix", "v3", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    const validation = validatePromptTemplate("ci_fix", result.value);
    assertEquals(validation.ok, true);
  }
});
